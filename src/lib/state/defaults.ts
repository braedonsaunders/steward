import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PROVIDER_REGISTRY } from "@/lib/llm/registry";
import { defaultRuntimeSettings } from "@/lib/state/runtime-defaults";
import type {
  ActionLog,
  AuthSettings,
  LLMProvider,
  PolicyRule,
  ProviderConfig,
  SystemSettings,
  StewardState,
} from "@/lib/state/types";

export const STEWARD_STATE_VERSION = 1;

export const defaultProviderConfigs = (): ProviderConfig[] => {
  return PROVIDER_REGISTRY.map((meta) => {
    const base: ProviderConfig = {
      provider: meta.id,
      enabled: meta.id === "openai",
      // Model names must come from the live provider API, not static defaults.
      model: "",
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

function resolvedLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/Toronto";
  } catch {
    return "America/Toronto";
  }
}

export const defaultSystemSettings = (): SystemSettings => ({
  nodeIdentity: "steward-local",
  timezone: resolvedLocalTimezone(),
  digestScheduleEnabled: true,
  digestHourLocal: 9,
  digestMinuteLocal: 0,
  upgradeChannel: "stable",
});

export const defaultAuthSettings = (): AuthSettings => ({
  apiTokenEnabled: false,
  mode: "hybrid",
  sessionTtlHours: 12,
  oidc: {
    enabled: false,
    issuer: "",
    clientId: "",
    scopes: "openid profile email",
    autoProvision: true,
    defaultRole: "Operator",
    clientSecretConfigured: false,
  },
  ldap: {
    enabled: false,
    url: "",
    baseDn: "",
    bindDn: "",
    userFilter: "(&(objectClass=person)(uid={{username}}))",
    uidAttribute: "uid",
    autoProvision: true,
    defaultRole: "Operator",
    bindPasswordConfigured: false,
  },
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
  systemSettings: defaultSystemSettings(),
  authSettings: defaultAuthSettings(),
  policyRules: defaultPolicyRules(),
  maintenanceWindows: [],
  playbookRuns: [],
  dailyDigests: [],
  localTools: [],
  localToolApprovals: [],
  protocolSessions: [],
  protocolSessionLeases: [],
  dashboardWidgetPages: [],
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
    ensureMeta.run("runtime.enableAdvancedNmapFingerprint", String(runtimeDefaults.enableAdvancedNmapFingerprint));
    ensureMeta.run("runtime.nmapFingerprintTimeoutMs", String(runtimeDefaults.nmapFingerprintTimeoutMs));
    ensureMeta.run("runtime.incrementalNmapTargets", String(runtimeDefaults.incrementalNmapTargets));
    ensureMeta.run("runtime.deepNmapTargets", String(runtimeDefaults.deepNmapTargets));
    ensureMeta.run("runtime.enablePacketIntel", String(runtimeDefaults.enablePacketIntel));
    ensureMeta.run("runtime.packetIntelDurationSec", String(runtimeDefaults.packetIntelDurationSec));
    ensureMeta.run("runtime.packetIntelMaxPackets", String(runtimeDefaults.packetIntelMaxPackets));
    ensureMeta.run("runtime.packetIntelTopTalkers", String(runtimeDefaults.packetIntelTopTalkers));
    ensureMeta.run("runtime.enableBrowserObservation", String(runtimeDefaults.enableBrowserObservation));
    ensureMeta.run("runtime.browserObservationTimeoutMs", String(runtimeDefaults.browserObservationTimeoutMs));
    ensureMeta.run("runtime.incrementalBrowserObservationTargets", String(runtimeDefaults.incrementalBrowserObservationTargets));
    ensureMeta.run("runtime.deepBrowserObservationTargets", String(runtimeDefaults.deepBrowserObservationTargets));
    ensureMeta.run("runtime.browserObservationCaptureScreenshots", String(runtimeDefaults.browserObservationCaptureScreenshots));
    ensureMeta.run("runtime.enableWebResearch", String(runtimeDefaults.enableWebResearch));
    ensureMeta.run("runtime.webResearchProvider", String(runtimeDefaults.webResearchProvider));
    ensureMeta.run("runtime.webResearchFallbackStrategy", String(runtimeDefaults.webResearchFallbackStrategy));
    ensureMeta.run("runtime.webResearchTimeoutMs", String(runtimeDefaults.webResearchTimeoutMs));
    ensureMeta.run("runtime.webResearchMaxResults", String(runtimeDefaults.webResearchMaxResults));
    ensureMeta.run("runtime.webResearchDeepReadPages", String(runtimeDefaults.webResearchDeepReadPages));
    ensureMeta.run("runtime.enableDhcpLeaseIntel", String(runtimeDefaults.enableDhcpLeaseIntel));
    ensureMeta.run("runtime.dhcpLeaseCommandTimeoutMs", String(runtimeDefaults.dhcpLeaseCommandTimeoutMs));
    ensureMeta.run("runtime.ouiUpdateIntervalMs", String(runtimeDefaults.ouiUpdateIntervalMs));
    ensureMeta.run("runtime.laneBEnabled", String(runtimeDefaults.laneBEnabled));
    ensureMeta.run("runtime.laneBAllowedEnvironments", JSON.stringify(runtimeDefaults.laneBAllowedEnvironments));
    ensureMeta.run("runtime.laneBAllowedFamilies", JSON.stringify(runtimeDefaults.laneBAllowedFamilies));
    ensureMeta.run("runtime.laneCMutationsInLab", String(runtimeDefaults.laneCMutationsInLab));
    ensureMeta.run("runtime.laneCMutationsInProd", String(runtimeDefaults.laneCMutationsInProd));
    ensureMeta.run("runtime.mutationRequireDryRunWhenSupported", String(runtimeDefaults.mutationRequireDryRunWhenSupported));
    ensureMeta.run("runtime.approvalTtlClassBMs", String(runtimeDefaults.approvalTtlClassBMs));
    ensureMeta.run("runtime.approvalTtlClassCMs", String(runtimeDefaults.approvalTtlClassCMs));
    ensureMeta.run("runtime.approvalTtlClassDMs", String(runtimeDefaults.approvalTtlClassDMs));
    ensureMeta.run("runtime.quarantineThresholdCount", String(runtimeDefaults.quarantineThresholdCount));
    ensureMeta.run("runtime.quarantineThresholdWindowMs", String(runtimeDefaults.quarantineThresholdWindowMs));
    ensureMeta.run("runtime.availabilityScannerAlertsEnabled", String(runtimeDefaults.availabilityScannerAlertsEnabled));
    ensureMeta.run("runtime.securityScannerAlertsEnabled", String(runtimeDefaults.securityScannerAlertsEnabled));
    ensureMeta.run("runtime.serviceContractScannerAlertsEnabled", String(runtimeDefaults.serviceContractScannerAlertsEnabled));
    ensureMeta.run("runtime.ignoredIncidentTypes", JSON.stringify(runtimeDefaults.ignoredIncidentTypes));
    ensureMeta.run("runtime.localToolInstallPolicy", runtimeDefaults.localToolInstallPolicy);
    ensureMeta.run("runtime.localToolExecutionPolicy", runtimeDefaults.localToolExecutionPolicy);
    ensureMeta.run("runtime.localToolApprovalTtlMs", String(runtimeDefaults.localToolApprovalTtlMs));
    ensureMeta.run("runtime.localToolHealthCheckIntervalMs", String(runtimeDefaults.localToolHealthCheckIntervalMs));
    ensureMeta.run("runtime.localToolAutoInstallBuiltins", String(runtimeDefaults.localToolAutoInstallBuiltins));
    ensureMeta.run("runtime.protocolSessionSweepIntervalMs", String(runtimeDefaults.protocolSessionSweepIntervalMs));
    ensureMeta.run("runtime.protocolSessionDefaultLeaseTtlMs", String(runtimeDefaults.protocolSessionDefaultLeaseTtlMs));
    ensureMeta.run("runtime.protocolSessionMaxLeaseTtlMs", String(runtimeDefaults.protocolSessionMaxLeaseTtlMs));
    ensureMeta.run("runtime.protocolSessionMessageRetentionLimit", String(runtimeDefaults.protocolSessionMessageRetentionLimit));
    ensureMeta.run("runtime.protocolSessionReconnectBaseMs", String(runtimeDefaults.protocolSessionReconnectBaseMs));
    ensureMeta.run("runtime.protocolSessionReconnectMaxMs", String(runtimeDefaults.protocolSessionReconnectMaxMs));

    // System settings domain
    const systemDefaults = defaultSystemSettings();
    ensureMeta.run("system.nodeIdentity", systemDefaults.nodeIdentity);
    ensureMeta.run("system.timezone", systemDefaults.timezone);
    ensureMeta.run("system.digestScheduleEnabled", String(systemDefaults.digestScheduleEnabled));
    ensureMeta.run("system.digestHourLocal", String(systemDefaults.digestHourLocal));
    ensureMeta.run("system.digestMinuteLocal", String(systemDefaults.digestMinuteLocal));
    ensureMeta.run("system.upgradeChannel", systemDefaults.upgradeChannel);

    // Auth settings domain
    const authDefaults = defaultAuthSettings();
    ensureMeta.run("auth.apiTokenEnabled", String(authDefaults.apiTokenEnabled));
    ensureMeta.run("auth.mode", authDefaults.mode);
    ensureMeta.run("auth.sessionTtlHours", String(authDefaults.sessionTtlHours));
    ensureMeta.run("auth.oidc.enabled", String(authDefaults.oidc.enabled));
    ensureMeta.run("auth.oidc.issuer", authDefaults.oidc.issuer);
    ensureMeta.run("auth.oidc.clientId", authDefaults.oidc.clientId);
    ensureMeta.run("auth.oidc.scopes", authDefaults.oidc.scopes);
    ensureMeta.run("auth.oidc.autoProvision", String(authDefaults.oidc.autoProvision));
    ensureMeta.run("auth.oidc.defaultRole", authDefaults.oidc.defaultRole);
    ensureMeta.run("auth.oidc.clientSecretConfigured", String(authDefaults.oidc.clientSecretConfigured));
    ensureMeta.run("auth.ldap.enabled", String(authDefaults.ldap.enabled));
    ensureMeta.run("auth.ldap.url", authDefaults.ldap.url);
    ensureMeta.run("auth.ldap.baseDn", authDefaults.ldap.baseDn);
    ensureMeta.run("auth.ldap.bindDn", authDefaults.ldap.bindDn);
    ensureMeta.run("auth.ldap.userFilter", authDefaults.ldap.userFilter);
    ensureMeta.run("auth.ldap.uidAttribute", authDefaults.ldap.uidAttribute);
    ensureMeta.run("auth.ldap.autoProvision", String(authDefaults.ldap.autoProvision));
    ensureMeta.run("auth.ldap.defaultRole", authDefaults.ldap.defaultRole);
    ensureMeta.run("auth.ldap.bindPasswordConfigured", String(authDefaults.ldap.bindPasswordConfigured));

    // Settings history seed per domain (versioned + effective_from)
    const historyCountStmt = db.prepare(
      "SELECT COUNT(*) as cnt FROM settings_history WHERE domain = ?",
    );
    const insertHistoryStmt = db.prepare(`
      INSERT INTO settings_history (id, domain, version, effectiveFrom, payload, actor, createdAt)
      VALUES (@id, @domain, @version, @effectiveFrom, @payload, @actor, @createdAt)
    `);
    const historyCreatedAt = new Date().toISOString();
    const seedDomain = (domain: "runtime" | "system" | "auth", payload: Record<string, unknown>) => {
      const existing = historyCountStmt.get(domain) as { cnt: number } | undefined;
      if ((existing?.cnt ?? 0) > 0) {
        return;
      }
      insertHistoryStmt.run({
        id: randomUUID(),
        domain,
        version: 1,
        effectiveFrom: historyCreatedAt,
        payload: JSON.stringify(payload),
        actor: "steward",
        createdAt: historyCreatedAt,
      });
    };
    seedDomain("runtime", runtimeDefaults as unknown as Record<string, unknown>);
    seedDomain("system", systemDefaults as unknown as Record<string, unknown>);
    seedDomain("auth", authDefaults as unknown as Record<string, unknown>);

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
