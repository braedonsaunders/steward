import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PROVIDER_REGISTRY } from "@/lib/llm/registry";
import type {
  ActionLog,
  LLMProvider,
  PolicyRule,
  ProviderConfig,
  RuntimeSettings,
  StewardState,
} from "@/lib/state/types";

export const STEWARD_STATE_VERSION = 1;

export const defaultProviderConfigs = (): ProviderConfig[] => {
  return PROVIDER_REGISTRY.map((meta) => {
    const base: ProviderConfig = {
      provider: meta.id,
      enabled: meta.id === "openai",
      model: meta.defaultModel,
      baseUrl: meta.defaultBaseUrl,
    };

    // OpenAI OAuth (localhost:1455 callback server, Codex CLI public client)
    if (meta.id === "openai") {
      base.oauthTokenSecret = "llm.oauth.openai.access_token";
    }

    // Google OAuth 2.0 (standard PKCE flow)
    // Client ID and secret are stored in the vault (not env vars)
    if (meta.id === "google") {
      base.oauthAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
      base.oauthTokenUrl = "https://oauth2.googleapis.com/token";
      base.oauthScopes = [
        "https://www.googleapis.com/auth/generative-language.retriever",
        "https://www.googleapis.com/auth/cloud-platform",
      ];
      base.oauthTokenSecret = "llm.oauth.google.access_token";
    }

    // OpenRouter custom PKCE auth (returns API key, no standard OAuth)
    if (meta.id === "openrouter") {
      base.extraHeaders = {
        "HTTP-Referer": "http://localhost:3000",
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

export const defaultPolicyRules = (): PolicyRule[] => {
  const now = new Date().toISOString();
  return [
    {
      id: "default:tier1-readonly",
      name: "Tier 1 – Allow read-only",
      description: "Observe-only devices allow Class A (read-only) actions automatically.",
      actionClasses: ["A"],
      autonomyTiers: [1],
      decision: "ALLOW_AUTO",
      priority: 10,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "default:tier1-gate",
      name: "Tier 1 – Gate all mutations",
      description: "Observe-only devices require approval for any action beyond read-only.",
      actionClasses: ["B", "C", "D"],
      autonomyTiers: [1],
      decision: "REQUIRE_APPROVAL",
      priority: 11,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "default:tier2-safe",
      name: "Tier 2 – Auto low-risk",
      description: "Safe auto-remediation devices allow Class A/B automatically.",
      actionClasses: ["A", "B"],
      autonomyTiers: [2],
      decision: "ALLOW_AUTO",
      priority: 20,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "default:tier2-gate",
      name: "Tier 2 – Gate medium/high risk",
      description: "Safe auto-remediation devices require approval for Class C/D.",
      actionClasses: ["C", "D"],
      autonomyTiers: [2],
      decision: "REQUIRE_APPROVAL",
      priority: 21,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "default:tier3-auto",
      name: "Tier 3 – Auto up to medium",
      description: "Full autonomy devices allow Class A/B/C automatically.",
      actionClasses: ["A", "B", "C"],
      autonomyTiers: [3],
      decision: "ALLOW_AUTO",
      priority: 30,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "default:tier3-gate-high",
      name: "Tier 3 – Gate high risk",
      description: "Full autonomy devices still require approval for Class D (high-risk).",
      actionClasses: ["D"],
      autonomyTiers: [3],
      decision: "REQUIRE_APPROVAL",
      priority: 31,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "default:prod-deny-high",
      name: "Production – Deny high risk outside windows",
      description: "Production devices deny Class D actions unless during a maintenance window.",
      actionClasses: ["D"],
      environmentLabels: ["prod"],
      decision: "DENY",
      priority: 5,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
};

export const defaultRuntimeSettings = (): RuntimeSettings => ({
  agentIntervalMs: 120_000,
  deepScanIntervalMs: 30 * 60 * 1000,
  incrementalActiveTargets: 32,
  deepActiveTargets: 256,
  incrementalPortScanHosts: 16,
  deepPortScanHosts: 96,
  llmDiscoveryLimit: 10,
  incrementalFingerprintTargets: 6,
  deepFingerprintTargets: 24,
  enableMdnsDiscovery: true,
  enableSsdpDiscovery: true,
  enableSnmpProbe: true,
  ouiUpdateIntervalMs: 7 * 24 * 60 * 60 * 1000,
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
          locale: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/Toronto",
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
  runtimeSettings: defaultRuntimeSettings(),
  policyRules: defaultPolicyRules(),
  maintenanceWindows: [],
  playbookRuns: [],
  dailyDigests: [],
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

  const providerOrder = Array.from(
    new Set<LLMProvider>([
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
        apiKeyEnvVar: null,
        oauthTokenSecret: p.oauthTokenSecret ?? null,
        oauthClientIdEnvVar: null,
        oauthClientSecretEnvVar: null,
        oauthAuthUrl: p.oauthAuthUrl ?? null,
        oauthTokenUrl: p.oauthTokenUrl ?? null,
        oauthScopes: p.oauthScopes ? JSON.stringify(p.oauthScopes) : null,
        baseUrl: p.baseUrl ?? null,
        extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders) : null,
      });
    }

    // Exactly one provider should be enabled at all times.
    normalizeEnabledProviders(db);

    // Runtime settings in metadata (DB-backed, no env tunables)
    const runtimeDefaults = defaultRuntimeSettings();
    const ensureMeta = db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)");
    ensureMeta.run("runtime.agentIntervalMs", String(runtimeDefaults.agentIntervalMs));
    ensureMeta.run("runtime.deepScanIntervalMs", String(runtimeDefaults.deepScanIntervalMs));
    ensureMeta.run("runtime.incrementalActiveTargets", String(runtimeDefaults.incrementalActiveTargets));
    ensureMeta.run("runtime.deepActiveTargets", String(runtimeDefaults.deepActiveTargets));
    ensureMeta.run("runtime.incrementalPortScanHosts", String(runtimeDefaults.incrementalPortScanHosts));
    ensureMeta.run("runtime.deepPortScanHosts", String(runtimeDefaults.deepPortScanHosts));
    ensureMeta.run("runtime.llmDiscoveryLimit", String(runtimeDefaults.llmDiscoveryLimit));
    ensureMeta.run("runtime.incrementalFingerprintTargets", String(runtimeDefaults.incrementalFingerprintTargets));
    ensureMeta.run("runtime.deepFingerprintTargets", String(runtimeDefaults.deepFingerprintTargets));
    ensureMeta.run("runtime.enableMdnsDiscovery", String(runtimeDefaults.enableMdnsDiscovery));
    ensureMeta.run("runtime.enableSsdpDiscovery", String(runtimeDefaults.enableSsdpDiscovery));
    ensureMeta.run("runtime.enableSnmpProbe", String(runtimeDefaults.enableSnmpProbe));
    ensureMeta.run("runtime.ouiUpdateIntervalMs", String(runtimeDefaults.ouiUpdateIntervalMs));

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
          locale: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/Toronto",
        }),
        createdAt: now,
        updatedAt: now,
      });
    }

    // Default policy rules (only insert rules that don't exist yet)
    const insertPolicyRule = db.prepare(`
      INSERT OR IGNORE INTO policy_rules (id, name, description, actionClasses, autonomyTiers, environmentLabels, deviceTypes, decision, priority, enabled, createdAt, updatedAt)
      VALUES (@id, @name, @description, @actionClasses, @autonomyTiers, @environmentLabels, @deviceTypes, @decision, @priority, @enabled, @createdAt, @updatedAt)
    `);
    for (const rule of defaultPolicyRules()) {
      insertPolicyRule.run({
        id: rule.id, name: rule.name, description: rule.description,
        actionClasses: JSON.stringify(rule.actionClasses ?? []),
        autonomyTiers: JSON.stringify(rule.autonomyTiers ?? []),
        environmentLabels: JSON.stringify(rule.environmentLabels ?? []),
        deviceTypes: JSON.stringify(rule.deviceTypes ?? []),
        decision: rule.decision, priority: rule.priority,
        enabled: rule.enabled ? 1 : 0, createdAt: rule.createdAt, updatedAt: rule.updatedAt,
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
