import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PROVIDER_REGISTRY } from "@/lib/llm/registry";
import type {
  ActionLog,
  LLMProvider,
  ProviderConfig,
  StewardState,
} from "@/lib/state/types";

export const STEWARD_STATE_VERSION = 1;

export const defaultProviderConfigs = (): ProviderConfig[] => {
  return PROVIDER_REGISTRY.map((meta) => {
    const base: ProviderConfig = {
      provider: meta.id,
      enabled: meta.id === "openai",
      model: meta.defaultModel,
      apiKeyEnvVar: meta.apiKeyEnvVar,
      baseUrl: meta.defaultBaseUrl,
    };

    // Google OAuth 2.0 (standard PKCE flow)
    if (meta.id === "google") {
      base.oauthAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
      base.oauthTokenUrl = "https://oauth2.googleapis.com/token";
      base.oauthClientIdEnvVar = "GOOGLE_OAUTH_CLIENT_ID";
      base.oauthClientSecretEnvVar = "GOOGLE_OAUTH_CLIENT_SECRET";
      base.oauthScopes = [
        "https://www.googleapis.com/auth/generative-language.retriever",
        "https://www.googleapis.com/auth/cloud-platform",
      ];
      base.oauthTokenSecret = "llm.oauth.google.access_token";
    }

    // OpenRouter custom PKCE auth (returns API key, no standard OAuth)
    if (meta.id === "openrouter") {
      base.extraHeaders = {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-Title": "Steward",
      };
    }

    return base;
  });
};

const initAction = (): ActionLog => ({
  id: randomUUID(),
  at: new Date().toISOString(),
  actor: "steward",
  kind: "config",
  message: "Steward state initialized",
  context: {},
});

export const defaultState = (): StewardState => ({
  version: STEWARD_STATE_VERSION,
  initializedAt: new Date().toISOString(),
  devices: [],
  baselines: [],
  incidents: [],
  recommendations: [],
  actions: [initAction()],
  graph: {
    nodes: [
      {
        id: "site:default",
        type: "site",
        label: "Local Site",
        properties: {
          name: "default",
          locale: process.env.TZ ?? "America/Toronto",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    edges: [],
  },
  providerConfigs: defaultProviderConfigs(),
  oauthStates: [],
  agentRuns: [],
});

export const providerPriority: LLMProvider[] = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "mistral",
  "xai",
  "deepseek",
  "openrouter",
  "ollama",
  "lmstudio",
];

function normalizeEnabledProviders(db: Database.Database): void {
  const rows = db.prepare("SELECT provider, enabled FROM provider_configs").all() as Array<{
    provider: LLMProvider;
    enabled: number;
  }>;

  if (rows.length === 0) {
    return;
  }

  const configuredDefault = process.env.STEWARD_DEFAULT_PROVIDER as LLMProvider | undefined;
  const providerOrder = Array.from(
    new Set<LLMProvider>([
      ...(configuredDefault ? [configuredDefault] : []),
      "openai",
      ...providerPriority,
      ...rows.map((row) => row.provider),
    ]),
  );

  const enabledProviders = rows
    .filter((row) => Boolean(row.enabled))
    .map((row) => row.provider);

  const candidates = enabledProviders.length > 0
    ? enabledProviders
    : rows.map((row) => row.provider);

  const activeProvider = providerOrder.find((provider) => candidates.includes(provider)) ?? candidates[0];
  if (!activeProvider) {
    return;
  }

  db.prepare("UPDATE provider_configs SET enabled = CASE WHEN provider = ? THEN 1 ELSE 0 END").run(activeProvider);
}

/**
 * Seed the database with default metadata, provider configs, the default
 * site graph node, and the initial action log entry -- but only if those
 * rows do not already exist. Safe to call on every startup.
 */
export function ensureDefaults(db: Database.Database): void {
  const tx = db.transaction(() => {
    // Metadata: version + initializedAt
    const existingVersion = db.prepare("SELECT value FROM metadata WHERE key = 'version'").get();
    if (!existingVersion) {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO metadata (key, value) VALUES ('version', ?)").run(
        String(STEWARD_STATE_VERSION),
      );
      db.prepare("INSERT INTO metadata (key, value) VALUES ('initializedAt', ?)").run(now);
    }

    // Default provider configs (only insert providers that don't exist yet)
    const insertProvider = db.prepare(`
      INSERT OR IGNORE INTO provider_configs (provider, enabled, model, apiKeyEnvVar, oauthTokenSecret, oauthClientIdEnvVar, oauthClientSecretEnvVar, oauthAuthUrl, oauthTokenUrl, oauthScopes, baseUrl, extraHeaders)
      VALUES (@provider, @enabled, @model, @apiKeyEnvVar, @oauthTokenSecret, @oauthClientIdEnvVar, @oauthClientSecretEnvVar, @oauthAuthUrl, @oauthTokenUrl, @oauthScopes, @baseUrl, @extraHeaders)
    `);

    for (const p of defaultProviderConfigs()) {
      insertProvider.run({
        provider: p.provider,
        enabled: p.enabled ? 1 : 0,
        model: p.model,
        apiKeyEnvVar: p.apiKeyEnvVar ?? null,
        oauthTokenSecret: p.oauthTokenSecret ?? null,
        oauthClientIdEnvVar: p.oauthClientIdEnvVar ?? null,
        oauthClientSecretEnvVar: p.oauthClientSecretEnvVar ?? null,
        oauthAuthUrl: p.oauthAuthUrl ?? null,
        oauthTokenUrl: p.oauthTokenUrl ?? null,
        oauthScopes: p.oauthScopes ? JSON.stringify(p.oauthScopes) : null,
        baseUrl: p.baseUrl ?? null,
        extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders) : null,
      });
    }

    // Exactly one provider should be enabled at all times.
    normalizeEnabledProviders(db);

    // Default site graph node
    const existingSiteNode = db
      .prepare("SELECT id FROM graph_nodes WHERE id = 'site:default'")
      .get();

    if (!existingSiteNode) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO graph_nodes (id, type, label, properties, createdAt, updatedAt)
        VALUES (@id, @type, @label, @properties, @createdAt, @updatedAt)
      `).run({
        id: "site:default",
        type: "site",
        label: "Local Site",
        properties: JSON.stringify({
          name: "default",
          locale: process.env.TZ ?? "America/Toronto",
        }),
        createdAt: now,
        updatedAt: now,
      });
    }

    // Default init action (only if no actions exist yet)
    const actionCount = db.prepare("SELECT COUNT(*) as cnt FROM actions").get() as { cnt: number };
    if (actionCount.cnt === 0) {
      const action = initAction();
      db.prepare(`
        INSERT INTO actions (id, at, actor, kind, message, context)
        VALUES (@id, @at, @actor, @kind, @message, @context)
      `).run({
        id: action.id,
        at: action.at,
        actor: action.actor,
        kind: action.kind,
        message: action.message,
        context: JSON.stringify(action.context),
      });
    }
  });

  tx();
}
