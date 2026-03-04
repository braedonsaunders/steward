import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  getDb,
  getDataDir as dbGetDataDir,
  getDbPath,
  recoverCorruptDatabase,
} from "@/lib/state/db";
import { defaultRuntimeSettings, ensureDefaults } from "@/lib/state/defaults";
import type {
  ActionLog,
  AgentRunRecord,
  ChatMessage,
  ChatSession,
  DailyDigest,
  Device,
  DeviceBaseline,
  GraphEdge,
  GraphNode,
  Incident,
  MaintenanceWindow,
  OAuthState,
  PlaybookRun,
  PolicyRule,
  ProviderConfig,
  Recommendation,
  RuntimeSettings,
  StewardState,
} from "@/lib/state/types";

/* ---------- Row <-> Domain helpers ---------- */

function deviceFromRow(row: Record<string, unknown>): Device {
  const secondaryIps = row.secondaryIps ? JSON.parse(row.secondaryIps as string) as string[] : [];
  return {
    id: row.id as string,
    name: row.name as string,
    ip: row.ip as string,
    secondaryIps: secondaryIps.length > 0 ? secondaryIps : undefined,
    mac: (row.mac as string) ?? undefined,
    hostname: (row.hostname as string) ?? undefined,
    vendor: (row.vendor as string) ?? undefined,
    os: (row.os as string) ?? undefined,
    role: (row.role as string) ?? undefined,
    type: row.type as Device["type"],
    status: row.status as Device["status"],
    autonomyTier: row.autonomyTier as Device["autonomyTier"],
    tags: JSON.parse(row.tags as string) as string[],
    protocols: JSON.parse(row.protocols as string) as string[],
    services: JSON.parse(row.services as string) as Device["services"],
    firstSeenAt: row.firstSeenAt as string,
    lastSeenAt: row.lastSeenAt as string,
    lastChangedAt: row.lastChangedAt as string,
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
  };
}

function baselineFromRow(row: Record<string, unknown>): DeviceBaseline {
  return {
    deviceId: row.deviceId as string,
    avgLatencyMs: row.avgLatencyMs as number,
    maxLatencyMs: row.maxLatencyMs as number,
    minLatencyMs: row.minLatencyMs as number,
    samples: row.samples as number,
    lastUpdatedAt: row.lastUpdatedAt as string,
  };
}

function incidentFromRow(row: Record<string, unknown>): Incident {
  return {
    id: row.id as string,
    title: row.title as string,
    summary: row.summary as string,
    severity: row.severity as Incident["severity"],
    deviceIds: JSON.parse(row.deviceIds as string) as string[],
    status: row.status as Incident["status"],
    detectedAt: row.detectedAt as string,
    updatedAt: row.updatedAt as string,
    timeline: JSON.parse(row.timeline as string) as Incident["timeline"],
    diagnosis: (row.diagnosis as string) ?? undefined,
    remediationPlan: (row.remediationPlan as string) ?? undefined,
    autoRemediated: Boolean(row.autoRemediated),
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
  };
}

function recommendationFromRow(row: Record<string, unknown>): Recommendation {
  return {
    id: row.id as string,
    title: row.title as string,
    rationale: row.rationale as string,
    impact: row.impact as string,
    priority: row.priority as Recommendation["priority"],
    relatedDeviceIds: JSON.parse(row.relatedDeviceIds as string) as string[],
    createdAt: row.createdAt as string,
    dismissed: Boolean(row.dismissed),
  };
}

function actionFromRow(row: Record<string, unknown>): ActionLog {
  return {
    id: row.id as string,
    at: row.at as string,
    actor: row.actor as ActionLog["actor"],
    kind: row.kind as ActionLog["kind"],
    message: row.message as string,
    context: JSON.parse(row.context as string) as Record<string, unknown>,
  };
}

function graphNodeFromRow(row: Record<string, unknown>): GraphNode {
  return {
    id: row.id as string,
    type: row.type as GraphNode["type"],
    label: row.label as string,
    properties: JSON.parse(row.properties as string) as Record<string, unknown>,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function graphEdgeFromRow(row: Record<string, unknown>): GraphEdge {
  return {
    id: row.id as string,
    from: row.from as string,
    to: row.to as string,
    type: row.type as string,
    properties: JSON.parse(row.properties as string) as Record<string, unknown>,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function providerConfigFromRow(row: Record<string, unknown>): ProviderConfig {
  const config: ProviderConfig = {
    provider: row.provider as ProviderConfig["provider"],
    enabled: Boolean(row.enabled),
    model: row.model as string,
  };
  if (row.apiKeyEnvVar) config.apiKeyEnvVar = row.apiKeyEnvVar as string;
  if (row.oauthTokenSecret) config.oauthTokenSecret = row.oauthTokenSecret as string;
  if (row.oauthClientIdEnvVar) config.oauthClientIdEnvVar = row.oauthClientIdEnvVar as string;
  if (row.oauthClientSecretEnvVar) config.oauthClientSecretEnvVar = row.oauthClientSecretEnvVar as string;
  if (row.oauthAuthUrl) config.oauthAuthUrl = row.oauthAuthUrl as string;
  if (row.oauthTokenUrl) config.oauthTokenUrl = row.oauthTokenUrl as string;
  if (row.oauthScopes) config.oauthScopes = JSON.parse(row.oauthScopes as string) as string[];
  if (row.baseUrl) config.baseUrl = row.baseUrl as string;
  if (row.extraHeaders) config.extraHeaders = JSON.parse(row.extraHeaders as string) as Record<string, string>;
  return config;
}

function oauthStateFromRow(row: Record<string, unknown>): OAuthState {
  return {
    id: row.id as string,
    provider: row.provider as OAuthState["provider"],
    redirectUri: row.redirectUri as string,
    codeVerifier: row.codeVerifier as string,
    createdAt: row.createdAt as string,
    expiresAt: row.expiresAt as string,
  };
}

function agentRunFromRow(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: row.id as string,
    startedAt: row.startedAt as string,
    completedAt: (row.completedAt as string) ?? undefined,
    outcome: row.outcome as AgentRunRecord["outcome"],
    summary: row.summary as string,
    details: JSON.parse(row.details as string) as Record<string, unknown>,
  };
}

function policyRuleFromRow(row: Record<string, unknown>): PolicyRule {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    actionClasses: JSON.parse(row.actionClasses as string) as PolicyRule["actionClasses"],
    autonomyTiers: JSON.parse(row.autonomyTiers as string) as PolicyRule["autonomyTiers"],
    environmentLabels: JSON.parse(row.environmentLabels as string) as PolicyRule["environmentLabels"],
    deviceTypes: JSON.parse(row.deviceTypes as string) as PolicyRule["deviceTypes"],
    decision: row.decision as PolicyRule["decision"],
    priority: row.priority as number,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function maintenanceWindowFromRow(row: Record<string, unknown>): MaintenanceWindow {
  return {
    id: row.id as string,
    name: row.name as string,
    deviceIds: JSON.parse(row.deviceIds as string) as string[],
    cronStart: row.cronStart as string,
    durationMinutes: row.durationMinutes as number,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt as string,
  };
}

function playbookRunFromRow(row: Record<string, unknown>): PlaybookRun {
  return {
    id: row.id as string,
    playbookId: row.playbookId as string,
    family: row.family as PlaybookRun["family"],
    name: row.name as string,
    deviceId: row.deviceId as string,
    incidentId: (row.incidentId as string) ?? undefined,
    actionClass: row.actionClass as PlaybookRun["actionClass"],
    status: row.status as PlaybookRun["status"],
    policyEvaluation: JSON.parse(row.policyEvaluation as string) as PlaybookRun["policyEvaluation"],
    steps: JSON.parse(row.steps as string) as PlaybookRun["steps"],
    verificationSteps: JSON.parse(row.verificationSteps as string) as PlaybookRun["verificationSteps"],
    rollbackSteps: JSON.parse(row.rollbackSteps as string) as PlaybookRun["rollbackSteps"],
    evidence: JSON.parse(row.evidence as string) as PlaybookRun["evidence"],
    createdAt: row.createdAt as string,
    startedAt: (row.startedAt as string) ?? undefined,
    completedAt: (row.completedAt as string) ?? undefined,
    approvedBy: (row.approvedBy as string) ?? undefined,
    approvedAt: (row.approvedAt as string) ?? undefined,
    deniedBy: (row.deniedBy as string) ?? undefined,
    deniedAt: (row.deniedAt as string) ?? undefined,
    denialReason: (row.denialReason as string) ?? undefined,
    expiresAt: (row.expiresAt as string) ?? undefined,
    failureCount: row.failureCount as number,
  };
}

function dailyDigestFromRow(row: Record<string, unknown>): DailyDigest {
  const content = JSON.parse(row.content as string) as Omit<DailyDigest, "id" | "generatedAt" | "periodStart" | "periodEnd">;
  return {
    id: row.id as string,
    generatedAt: row.generatedAt as string,
    periodStart: row.periodStart as string,
    periodEnd: row.periodEnd as string,
    ...content,
  };
}

/* ---------- StateStore ---------- */

class StateStore {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    const db = getDb();
    ensureDefaults(db);
    this.initialized = true;
  }

  private withDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
    const run = () => {
      this.ensureInit();
      return operation(getDb());
    };

    try {
      return run();
    } catch (error) {
      if (!recoverCorruptDatabase(error, context)) {
        throw error;
      }

      this.initialized = false;
      return run();
    }
  }

  private getVersion(db: Database.Database): number {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 1;
  }

  private getInitializedAt(db: Database.Database): string {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'initializedAt'").get() as { value: string } | undefined;
    return row?.value ?? new Date().toISOString();
  }

  private readRuntimeSettings(db: Database.Database): RuntimeSettings {
    const defaults = defaultRuntimeSettings();
    const rows = db.prepare("SELECT key, value FROM metadata WHERE key LIKE 'runtime.%'").all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((row) => [row.key, row.value]));

    const parseNum = (key: string, fallback: number): number => {
      const value = Number(map.get(key));
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    };

    const parseBool = (key: string, fallback: boolean): boolean => {
      const raw = map.get(key);
      if (raw === undefined) return fallback;
      return raw === "true" || raw === "1";
    };

    return {
      agentIntervalMs: parseNum("runtime.agentIntervalMs", defaults.agentIntervalMs),
      deepScanIntervalMs: parseNum("runtime.deepScanIntervalMs", defaults.deepScanIntervalMs),
      incrementalActiveTargets: parseNum("runtime.incrementalActiveTargets", defaults.incrementalActiveTargets),
      deepActiveTargets: parseNum("runtime.deepActiveTargets", defaults.deepActiveTargets),
      incrementalPortScanHosts: parseNum("runtime.incrementalPortScanHosts", defaults.incrementalPortScanHosts),
      deepPortScanHosts: parseNum("runtime.deepPortScanHosts", defaults.deepPortScanHosts),
      llmDiscoveryLimit: parseNum("runtime.llmDiscoveryLimit", defaults.llmDiscoveryLimit),
      incrementalFingerprintTargets: parseNum("runtime.incrementalFingerprintTargets", defaults.incrementalFingerprintTargets),
      deepFingerprintTargets: parseNum("runtime.deepFingerprintTargets", defaults.deepFingerprintTargets),
      enableMdnsDiscovery: parseBool("runtime.enableMdnsDiscovery", defaults.enableMdnsDiscovery),
      enableSsdpDiscovery: parseBool("runtime.enableSsdpDiscovery", defaults.enableSsdpDiscovery),
      enableSnmpProbe: parseBool("runtime.enableSnmpProbe", defaults.enableSnmpProbe),
      ouiUpdateIntervalMs: parseNum("runtime.ouiUpdateIntervalMs", defaults.ouiUpdateIntervalMs),
    };
  }

  getState(): Promise<StewardState> {
    const state = this.withDbRecovery("StateStore.getState", (db) => {
      const devices = (db.prepare("SELECT * FROM devices").all() as Record<string, unknown>[]).map(deviceFromRow);
      const baselines = (db.prepare("SELECT * FROM device_baselines").all() as Record<string, unknown>[]).map(baselineFromRow);
      const incidents = (db.prepare("SELECT * FROM incidents").all() as Record<string, unknown>[]).map(incidentFromRow);
      const recommendations = (db.prepare("SELECT * FROM recommendations").all() as Record<string, unknown>[]).map(recommendationFromRow);
      const actions = (db.prepare("SELECT * FROM actions ORDER BY at DESC").all() as Record<string, unknown>[]).map(actionFromRow);
      const graphNodes = (db.prepare("SELECT * FROM graph_nodes").all() as Record<string, unknown>[]).map(graphNodeFromRow);
      const graphEdges = (db.prepare('SELECT id, "from", "to", type, properties, createdAt, updatedAt FROM graph_edges').all() as Record<string, unknown>[]).map(graphEdgeFromRow);
      const providerConfigs = (db.prepare("SELECT * FROM provider_configs").all() as Record<string, unknown>[]).map(providerConfigFromRow);
      const oauthStates = (db.prepare("SELECT * FROM oauth_states").all() as Record<string, unknown>[]).map(oauthStateFromRow);
      const agentRuns = (db.prepare("SELECT * FROM agent_runs ORDER BY startedAt DESC").all() as Record<string, unknown>[]).map(agentRunFromRow);
      const runtimeSettings = this.readRuntimeSettings(db);
      const policyRules = (db.prepare("SELECT * FROM policy_rules ORDER BY priority ASC").all() as Record<string, unknown>[]).map(policyRuleFromRow);
      const maintenanceWindows = (db.prepare("SELECT * FROM maintenance_windows").all() as Record<string, unknown>[]).map(maintenanceWindowFromRow);
      const playbookRuns = (db.prepare("SELECT * FROM playbook_runs ORDER BY createdAt DESC").all() as Record<string, unknown>[]).map(playbookRunFromRow);
      const dailyDigests = (db.prepare("SELECT * FROM daily_digests ORDER BY generatedAt DESC").all() as Record<string, unknown>[]).map(dailyDigestFromRow);

      return {
        version: this.getVersion(db),
        initializedAt: this.getInitializedAt(db),
        devices,
        baselines,
        incidents,
        recommendations,
        actions,
        graph: { nodes: graphNodes, edges: graphEdges },
        providerConfigs,
        oauthStates,
        agentRuns,
        runtimeSettings,
        policyRules,
        maintenanceWindows,
        playbookRuns,
        dailyDigests,
      };
    });

    return Promise.resolve(state);
  }

  async updateState(
    updater: (state: StewardState) => StewardState | Promise<StewardState>,
  ): Promise<StewardState> {
    const current = await this.getState();
    const next = await updater(current);
    this.writeFullState(next);
    return next;
  }

  private writeFullState(state: StewardState): void {
    this.withDbRecovery("StateStore.writeFullState", (db) => {
      const writeTx = db.transaction(() => {
      // Metadata
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('version', ?)").run(String(state.version));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('initializedAt', ?)").run(state.initializedAt);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.agentIntervalMs', ?)").run(String(state.runtimeSettings.agentIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepScanIntervalMs', ?)").run(String(state.runtimeSettings.deepScanIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalActiveTargets', ?)").run(String(state.runtimeSettings.incrementalActiveTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepActiveTargets', ?)").run(String(state.runtimeSettings.deepActiveTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalPortScanHosts', ?)").run(String(state.runtimeSettings.incrementalPortScanHosts));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepPortScanHosts', ?)").run(String(state.runtimeSettings.deepPortScanHosts));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.llmDiscoveryLimit', ?)").run(String(state.runtimeSettings.llmDiscoveryLimit));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalFingerprintTargets', ?)").run(String(state.runtimeSettings.incrementalFingerprintTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepFingerprintTargets', ?)").run(String(state.runtimeSettings.deepFingerprintTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableMdnsDiscovery', ?)").run(state.runtimeSettings.enableMdnsDiscovery ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableSsdpDiscovery', ?)").run(state.runtimeSettings.enableSsdpDiscovery ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableSnmpProbe', ?)").run(state.runtimeSettings.enableSnmpProbe ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.ouiUpdateIntervalMs', ?)").run(String(state.runtimeSettings.ouiUpdateIntervalMs));

      // Devices
      db.prepare("DELETE FROM devices").run();
      const insertDevice = db.prepare(`
        INSERT INTO devices (id, name, ip, mac, hostname, vendor, os, role, type, status, autonomyTier, tags, protocols, services, firstSeenAt, lastSeenAt, lastChangedAt, metadata, secondaryIps)
        VALUES (@id, @name, @ip, @mac, @hostname, @vendor, @os, @role, @type, @status, @autonomyTier, @tags, @protocols, @services, @firstSeenAt, @lastSeenAt, @lastChangedAt, @metadata, @secondaryIps)
      `);
      for (const d of state.devices) {
        insertDevice.run({
          id: d.id, name: d.name, ip: d.ip, mac: d.mac ?? null, hostname: d.hostname ?? null,
          vendor: d.vendor ?? null, os: d.os ?? null, role: d.role ?? null, type: d.type,
          status: d.status, autonomyTier: d.autonomyTier, tags: JSON.stringify(d.tags),
          protocols: JSON.stringify(d.protocols), services: JSON.stringify(d.services),
          firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt, lastChangedAt: d.lastChangedAt,
          metadata: JSON.stringify(d.metadata), secondaryIps: JSON.stringify(d.secondaryIps ?? []),
        });
      }

      // Baselines
      db.prepare("DELETE FROM device_baselines").run();
      const insertBaseline = db.prepare(`
        INSERT INTO device_baselines (deviceId, avgLatencyMs, maxLatencyMs, minLatencyMs, samples, lastUpdatedAt)
        VALUES (@deviceId, @avgLatencyMs, @maxLatencyMs, @minLatencyMs, @samples, @lastUpdatedAt)
      `);
      for (const b of state.baselines) {
        insertBaseline.run(b);
      }

      // Incidents
      db.prepare("DELETE FROM incidents").run();
      const insertIncident = db.prepare(`
        INSERT INTO incidents (id, title, summary, severity, deviceIds, status, detectedAt, updatedAt, timeline, diagnosis, remediationPlan, autoRemediated, metadata)
        VALUES (@id, @title, @summary, @severity, @deviceIds, @status, @detectedAt, @updatedAt, @timeline, @diagnosis, @remediationPlan, @autoRemediated, @metadata)
      `);
      for (const inc of state.incidents) {
        insertIncident.run({
          id: inc.id, title: inc.title, summary: inc.summary, severity: inc.severity,
          deviceIds: JSON.stringify(inc.deviceIds), status: inc.status,
          detectedAt: inc.detectedAt, updatedAt: inc.updatedAt,
          timeline: JSON.stringify(inc.timeline), diagnosis: inc.diagnosis ?? null,
          remediationPlan: inc.remediationPlan ?? null,
          autoRemediated: inc.autoRemediated ? 1 : 0,
          metadata: JSON.stringify(inc.metadata),
        });
      }

      // Recommendations
      db.prepare("DELETE FROM recommendations").run();
      const insertRec = db.prepare(`
        INSERT INTO recommendations (id, title, rationale, impact, priority, relatedDeviceIds, createdAt, dismissed)
        VALUES (@id, @title, @rationale, @impact, @priority, @relatedDeviceIds, @createdAt, @dismissed)
      `);
      for (const r of state.recommendations) {
        insertRec.run({
          id: r.id, title: r.title, rationale: r.rationale, impact: r.impact,
          priority: r.priority, relatedDeviceIds: JSON.stringify(r.relatedDeviceIds),
          createdAt: r.createdAt, dismissed: r.dismissed ? 1 : 0,
        });
      }

      // Actions
      db.prepare("DELETE FROM actions").run();
      const insertAction = db.prepare(`
        INSERT INTO actions (id, at, actor, kind, message, context)
        VALUES (@id, @at, @actor, @kind, @message, @context)
      `);
      for (const a of state.actions) {
        insertAction.run({
          id: a.id, at: a.at, actor: a.actor, kind: a.kind,
          message: a.message, context: JSON.stringify(a.context),
        });
      }

      // Graph nodes
      db.prepare("DELETE FROM graph_nodes").run();
      const insertNode = db.prepare(`
        INSERT INTO graph_nodes (id, type, label, properties, createdAt, updatedAt)
        VALUES (@id, @type, @label, @properties, @createdAt, @updatedAt)
      `);
      for (const n of state.graph.nodes) {
        insertNode.run({
          id: n.id, type: n.type, label: n.label,
          properties: JSON.stringify(n.properties),
          createdAt: n.createdAt, updatedAt: n.updatedAt,
        });
      }

      // Graph edges
      db.prepare("DELETE FROM graph_edges").run();
      const insertEdge = db.prepare(`
        INSERT INTO graph_edges (id, "from", "to", type, properties, createdAt, updatedAt)
        VALUES (@id, @from, @to, @type, @properties, @createdAt, @updatedAt)
      `);
      for (const e of state.graph.edges) {
        insertEdge.run({
          id: e.id, from: e.from, to: e.to, type: e.type,
          properties: JSON.stringify(e.properties),
          createdAt: e.createdAt, updatedAt: e.updatedAt,
        });
      }

      // Provider configs
      db.prepare("DELETE FROM provider_configs").run();
      const insertProvider = db.prepare(`
        INSERT INTO provider_configs (provider, enabled, model, apiKeyEnvVar, oauthTokenSecret, oauthClientIdEnvVar, oauthClientSecretEnvVar, oauthAuthUrl, oauthTokenUrl, oauthScopes, baseUrl, extraHeaders)
        VALUES (@provider, @enabled, @model, @apiKeyEnvVar, @oauthTokenSecret, @oauthClientIdEnvVar, @oauthClientSecretEnvVar, @oauthAuthUrl, @oauthTokenUrl, @oauthScopes, @baseUrl, @extraHeaders)
      `);
      for (const p of state.providerConfigs) {
        insertProvider.run({
          provider: p.provider, enabled: p.enabled ? 1 : 0, model: p.model,
          apiKeyEnvVar: p.apiKeyEnvVar ?? null, oauthTokenSecret: p.oauthTokenSecret ?? null,
          oauthClientIdEnvVar: p.oauthClientIdEnvVar ?? null,
          oauthClientSecretEnvVar: p.oauthClientSecretEnvVar ?? null,
          oauthAuthUrl: p.oauthAuthUrl ?? null, oauthTokenUrl: p.oauthTokenUrl ?? null,
          oauthScopes: p.oauthScopes ? JSON.stringify(p.oauthScopes) : null,
          baseUrl: p.baseUrl ?? null,
          extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders) : null,
        });
      }

      // OAuth states
      db.prepare("DELETE FROM oauth_states").run();
      const insertOAuth = db.prepare(`
        INSERT INTO oauth_states (id, provider, redirectUri, codeVerifier, createdAt, expiresAt)
        VALUES (@id, @provider, @redirectUri, @codeVerifier, @createdAt, @expiresAt)
      `);
      for (const o of state.oauthStates) {
        insertOAuth.run(o);
      }

      // Agent runs
      db.prepare("DELETE FROM agent_runs").run();
      const insertRun = db.prepare(`
        INSERT INTO agent_runs (id, startedAt, completedAt, outcome, summary, details)
        VALUES (@id, @startedAt, @completedAt, @outcome, @summary, @details)
      `);
      for (const r of state.agentRuns) {
        insertRun.run({
          id: r.id, startedAt: r.startedAt, completedAt: r.completedAt ?? null,
          outcome: r.outcome, summary: r.summary, details: JSON.stringify(r.details),
        });
      }

      // Policy rules
      db.prepare("DELETE FROM policy_rules").run();
      const insertPolicyRule = db.prepare(`
        INSERT INTO policy_rules (id, name, description, actionClasses, autonomyTiers, environmentLabels, deviceTypes, decision, priority, enabled, createdAt, updatedAt)
        VALUES (@id, @name, @description, @actionClasses, @autonomyTiers, @environmentLabels, @deviceTypes, @decision, @priority, @enabled, @createdAt, @updatedAt)
      `);
      for (const rule of state.policyRules) {
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

      // Maintenance windows
      db.prepare("DELETE FROM maintenance_windows").run();
      const insertWindow = db.prepare(`
        INSERT INTO maintenance_windows (id, name, deviceIds, cronStart, durationMinutes, enabled, createdAt)
        VALUES (@id, @name, @deviceIds, @cronStart, @durationMinutes, @enabled, @createdAt)
      `);
      for (const w of state.maintenanceWindows) {
        insertWindow.run({
          id: w.id, name: w.name, deviceIds: JSON.stringify(w.deviceIds),
          cronStart: w.cronStart, durationMinutes: w.durationMinutes,
          enabled: w.enabled ? 1 : 0, createdAt: w.createdAt,
        });
      }

      // Playbook runs
      db.prepare("DELETE FROM playbook_runs").run();
      const insertPlaybookRun = db.prepare(`
        INSERT INTO playbook_runs (id, playbookId, family, name, deviceId, incidentId, actionClass, status, policyEvaluation, steps, verificationSteps, rollbackSteps, evidence, createdAt, startedAt, completedAt, approvedBy, approvedAt, deniedBy, deniedAt, denialReason, expiresAt, failureCount)
        VALUES (@id, @playbookId, @family, @name, @deviceId, @incidentId, @actionClass, @status, @policyEvaluation, @steps, @verificationSteps, @rollbackSteps, @evidence, @createdAt, @startedAt, @completedAt, @approvedBy, @approvedAt, @deniedBy, @deniedAt, @denialReason, @expiresAt, @failureCount)
      `);
      for (const pr of state.playbookRuns) {
        insertPlaybookRun.run({
          id: pr.id, playbookId: pr.playbookId, family: pr.family, name: pr.name,
          deviceId: pr.deviceId, incidentId: pr.incidentId ?? null,
          actionClass: pr.actionClass, status: pr.status,
          policyEvaluation: JSON.stringify(pr.policyEvaluation),
          steps: JSON.stringify(pr.steps),
          verificationSteps: JSON.stringify(pr.verificationSteps),
          rollbackSteps: JSON.stringify(pr.rollbackSteps),
          evidence: JSON.stringify(pr.evidence),
          createdAt: pr.createdAt, startedAt: pr.startedAt ?? null,
          completedAt: pr.completedAt ?? null, approvedBy: pr.approvedBy ?? null,
          approvedAt: pr.approvedAt ?? null, deniedBy: pr.deniedBy ?? null,
          deniedAt: pr.deniedAt ?? null, denialReason: pr.denialReason ?? null,
          expiresAt: pr.expiresAt ?? null, failureCount: pr.failureCount,
        });
      }

      // Daily digests
      db.prepare("DELETE FROM daily_digests").run();
      const insertDigest = db.prepare(`
        INSERT INTO daily_digests (id, generatedAt, periodStart, periodEnd, content)
        VALUES (@id, @generatedAt, @periodStart, @periodEnd, @content)
      `);
      for (const d of state.dailyDigests) {
        const { id, generatedAt, periodStart, periodEnd, ...content } = d;
        insertDigest.run({
          id, generatedAt, periodStart, periodEnd,
          content: JSON.stringify(content),
        });
      }
      });

      writeTx();
    });
  }

  async addAction(log: Omit<ActionLog, "id" | "at">): Promise<void> {
    this.withDbRecovery("StateStore.addAction", (db) => {
      const entry: ActionLog = {
        id: randomUUID(),
        at: new Date().toISOString(),
        ...log,
      };

      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO actions (id, at, actor, kind, message, context)
          VALUES (@id, @at, @actor, @kind, @message, @context)
        `).run({
          id: entry.id, at: entry.at, actor: entry.actor, kind: entry.kind,
          message: entry.message, context: JSON.stringify(entry.context),
        });

        // Keep max 2000 rows (delete oldest beyond limit)
        db.prepare(`
          DELETE FROM actions WHERE id NOT IN (
            SELECT id FROM actions ORDER BY at DESC LIMIT 2000
          )
        `).run();
      });

      tx();
    });
  }

  async upsertDevice(device: Device): Promise<Device> {
    this.withDbRecovery("StateStore.upsertDevice", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO devices (id, name, ip, secondaryIps, mac, hostname, vendor, os, role, type, status, autonomyTier, tags, protocols, services, firstSeenAt, lastSeenAt, lastChangedAt, metadata)
        VALUES (@id, @name, @ip, @secondaryIps, @mac, @hostname, @vendor, @os, @role, @type, @status, @autonomyTier, @tags, @protocols, @services, @firstSeenAt, @lastSeenAt, @lastChangedAt, @metadata)
      `).run({
        id: device.id, name: device.name, ip: device.ip,
        secondaryIps: JSON.stringify(device.secondaryIps ?? []),
        mac: device.mac ?? null, hostname: device.hostname ?? null,
        vendor: device.vendor ?? null, os: device.os ?? null, role: device.role ?? null,
        type: device.type, status: device.status, autonomyTier: device.autonomyTier,
        tags: JSON.stringify(device.tags), protocols: JSON.stringify(device.protocols),
        services: JSON.stringify(device.services), firstSeenAt: device.firstSeenAt,
        lastSeenAt: device.lastSeenAt, lastChangedAt: device.lastChangedAt,
        metadata: JSON.stringify(device.metadata),
      });
    });

    return device;
  }

  async setIncidents(incidents: Incident[]): Promise<void> {
    this.withDbRecovery("StateStore.setIncidents", (db) => {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM incidents").run();
        const insert = db.prepare(`
          INSERT INTO incidents (id, title, summary, severity, deviceIds, status, detectedAt, updatedAt, timeline, diagnosis, remediationPlan, autoRemediated, metadata)
          VALUES (@id, @title, @summary, @severity, @deviceIds, @status, @detectedAt, @updatedAt, @timeline, @diagnosis, @remediationPlan, @autoRemediated, @metadata)
        `);
        for (const inc of incidents) {
          insert.run({
            id: inc.id, title: inc.title, summary: inc.summary, severity: inc.severity,
            deviceIds: JSON.stringify(inc.deviceIds), status: inc.status,
            detectedAt: inc.detectedAt, updatedAt: inc.updatedAt,
            timeline: JSON.stringify(inc.timeline), diagnosis: inc.diagnosis ?? null,
            remediationPlan: inc.remediationPlan ?? null,
            autoRemediated: inc.autoRemediated ? 1 : 0,
            metadata: JSON.stringify(inc.metadata),
          });
        }
      });

      tx();
    });
  }

  async setRecommendations(recommendations: Recommendation[]): Promise<void> {
    this.withDbRecovery("StateStore.setRecommendations", (db) => {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM recommendations").run();
        const insert = db.prepare(`
          INSERT INTO recommendations (id, title, rationale, impact, priority, relatedDeviceIds, createdAt, dismissed)
          VALUES (@id, @title, @rationale, @impact, @priority, @relatedDeviceIds, @createdAt, @dismissed)
        `);
        for (const r of recommendations) {
          insert.run({
            id: r.id, title: r.title, rationale: r.rationale, impact: r.impact,
            priority: r.priority, relatedDeviceIds: JSON.stringify(r.relatedDeviceIds),
            createdAt: r.createdAt, dismissed: r.dismissed ? 1 : 0,
          });
        }
      });

      tx();
    });
  }

  async setProviderConfig(config: ProviderConfig): Promise<void> {
    this.withDbRecovery("StateStore.setProviderConfig", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO provider_configs (provider, enabled, model, apiKeyEnvVar, oauthTokenSecret, oauthClientIdEnvVar, oauthClientSecretEnvVar, oauthAuthUrl, oauthTokenUrl, oauthScopes, baseUrl, extraHeaders)
        VALUES (@provider, @enabled, @model, @apiKeyEnvVar, @oauthTokenSecret, @oauthClientIdEnvVar, @oauthClientSecretEnvVar, @oauthAuthUrl, @oauthTokenUrl, @oauthScopes, @baseUrl, @extraHeaders)
      `).run({
        provider: config.provider, enabled: config.enabled ? 1 : 0, model: config.model,
        apiKeyEnvVar: config.apiKeyEnvVar ?? null, oauthTokenSecret: config.oauthTokenSecret ?? null,
        oauthClientIdEnvVar: config.oauthClientIdEnvVar ?? null,
        oauthClientSecretEnvVar: config.oauthClientSecretEnvVar ?? null,
        oauthAuthUrl: config.oauthAuthUrl ?? null, oauthTokenUrl: config.oauthTokenUrl ?? null,
        oauthScopes: config.oauthScopes ? JSON.stringify(config.oauthScopes) : null,
        baseUrl: config.baseUrl ?? null,
        extraHeaders: config.extraHeaders ? JSON.stringify(config.extraHeaders) : null,
      });
    });
  }

  async createOAuthState(stateItem: Omit<OAuthState, "id" | "createdAt">): Promise<OAuthState> {
    return this.withDbRecovery("StateStore.createOAuthState", (db) => {
      const created: OAuthState = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...stateItem,
      };

      const tx = db.transaction(() => {
        // Clean expired states first
        db.prepare("DELETE FROM oauth_states WHERE expiresAt < ?").run(new Date().toISOString());

        // Limit to 100 entries
        db.prepare(`
          DELETE FROM oauth_states WHERE id NOT IN (
            SELECT id FROM oauth_states ORDER BY createdAt DESC LIMIT 99
          )
        `).run();

        db.prepare(`
          INSERT INTO oauth_states (id, provider, redirectUri, codeVerifier, createdAt, expiresAt)
          VALUES (@id, @provider, @redirectUri, @codeVerifier, @createdAt, @expiresAt)
        `).run(created);
      });

      tx();
      return created;
    });
  }

  async consumeOAuthState(id: string): Promise<OAuthState | undefined> {
    return this.withDbRecovery("StateStore.consumeOAuthState", (db) => {
      let result: OAuthState | undefined;

      const tx = db.transaction(() => {
        const row = db.prepare("SELECT * FROM oauth_states WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (row) {
          result = oauthStateFromRow(row);
        }
        db.prepare("DELETE FROM oauth_states WHERE id = ?").run(id);
      });

      tx();

      if (!result) return undefined;
      if (new Date(result.expiresAt).getTime() < Date.now()) return undefined;

      return result;
    });
  }

  async addAgentRun(run: AgentRunRecord): Promise<void> {
    this.withDbRecovery("StateStore.addAgentRun", (db) => {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO agent_runs (id, startedAt, completedAt, outcome, summary, details)
          VALUES (@id, @startedAt, @completedAt, @outcome, @summary, @details)
        `).run({
          id: run.id, startedAt: run.startedAt, completedAt: run.completedAt ?? null,
          outcome: run.outcome, summary: run.summary, details: JSON.stringify(run.details),
        });

        // Keep max 200 rows (delete oldest beyond limit)
        db.prepare(`
          DELETE FROM agent_runs WHERE id NOT IN (
            SELECT id FROM agent_runs ORDER BY startedAt DESC LIMIT 200
          )
        `).run();
      });

      tx();
    });
  }

  getRuntimeSettings(): RuntimeSettings {
    return this.withDbRecovery("StateStore.getRuntimeSettings", (db) => this.readRuntimeSettings(db));
  }

  setRuntimeSettings(settings: RuntimeSettings): void {
    this.withDbRecovery("StateStore.setRuntimeSettings", (db) => {
      const write = db.transaction(() => {
        const put = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
        put.run("runtime.agentIntervalMs", String(settings.agentIntervalMs));
        put.run("runtime.deepScanIntervalMs", String(settings.deepScanIntervalMs));
        put.run("runtime.incrementalActiveTargets", String(settings.incrementalActiveTargets));
        put.run("runtime.deepActiveTargets", String(settings.deepActiveTargets));
        put.run("runtime.incrementalPortScanHosts", String(settings.incrementalPortScanHosts));
        put.run("runtime.deepPortScanHosts", String(settings.deepPortScanHosts));
        put.run("runtime.llmDiscoveryLimit", String(settings.llmDiscoveryLimit));
        put.run("runtime.incrementalFingerprintTargets", String(settings.incrementalFingerprintTargets));
        put.run("runtime.deepFingerprintTargets", String(settings.deepFingerprintTargets));
        put.run("runtime.enableMdnsDiscovery", String(settings.enableMdnsDiscovery));
        put.run("runtime.enableSsdpDiscovery", String(settings.enableSsdpDiscovery));
        put.run("runtime.enableSnmpProbe", String(settings.enableSnmpProbe));
        put.run("runtime.ouiUpdateIntervalMs", String(settings.ouiUpdateIntervalMs));
      });
      write();
    });
  }

  getAuditEventsPage(options?: {
    limit?: number;
    cursor?: { at: string; id: string };
    actor?: ActionLog["actor"];
    kind?: ActionLog["kind"];
    sinceAt?: string;
    untilAt?: string;
  }): { events: ActionLog[]; nextCursor: { at: string; id: string } | null } {
    return this.withDbRecovery("StateStore.getAuditEventsPage", (db) => {
      const limit = Math.max(1, Math.min(500, options?.limit ?? 100));
      const params: Record<string, unknown> = { limit: limit + 1 };
      const conditions: string[] = [];

      if (options?.actor) {
        conditions.push("actor = @actor");
        params.actor = options.actor;
      }
      if (options?.kind) {
        conditions.push("kind = @kind");
        params.kind = options.kind;
      }
      if (options?.sinceAt) {
        conditions.push("at >= @sinceAt");
        params.sinceAt = options.sinceAt;
      }
      if (options?.untilAt) {
        conditions.push("at <= @untilAt");
        params.untilAt = options.untilAt;
      }
      if (options?.cursor) {
        conditions.push("(at < @cursorAt OR (at = @cursorAt AND id < @cursorId))");
        params.cursorAt = options.cursor.at;
        params.cursorId = options.cursor.id;
      }

      let query = "SELECT id, at, actor, kind, message, context FROM actions";
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY at DESC, id DESC LIMIT @limit";

      const rows = db.prepare(query).all(params) as Record<string, unknown>[];
      const hasMore = rows.length > limit;
      const visibleRows = hasMore ? rows.slice(0, limit) : rows;
      const events = visibleRows.map(actionFromRow);

      if (!hasMore || events.length === 0) {
        return { events, nextCursor: null };
      }

      const tail = events[events.length - 1];
      return {
        events,
        nextCursor: { at: tail.at, id: tail.id },
      };
    });
  }

  /* ---------- Policy Rules ---------- */

  getPolicyRules(): PolicyRule[] {
    return this.withDbRecovery("StateStore.getPolicyRules", (db) => {
      return (db.prepare("SELECT * FROM policy_rules ORDER BY priority ASC").all() as Record<string, unknown>[]).map(policyRuleFromRow);
    });
  }

  upsertPolicyRule(rule: PolicyRule): void {
    this.withDbRecovery("StateStore.upsertPolicyRule", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO policy_rules (id, name, description, actionClasses, autonomyTiers, environmentLabels, deviceTypes, decision, priority, enabled, createdAt, updatedAt)
        VALUES (@id, @name, @description, @actionClasses, @autonomyTiers, @environmentLabels, @deviceTypes, @decision, @priority, @enabled, @createdAt, @updatedAt)
      `).run({
        id: rule.id, name: rule.name, description: rule.description,
        actionClasses: JSON.stringify(rule.actionClasses ?? []),
        autonomyTiers: JSON.stringify(rule.autonomyTiers ?? []),
        environmentLabels: JSON.stringify(rule.environmentLabels ?? []),
        deviceTypes: JSON.stringify(rule.deviceTypes ?? []),
        decision: rule.decision, priority: rule.priority,
        enabled: rule.enabled ? 1 : 0, createdAt: rule.createdAt, updatedAt: rule.updatedAt,
      });
    });
  }

  deletePolicyRule(id: string): void {
    this.withDbRecovery("StateStore.deletePolicyRule", (db) => {
      db.prepare("DELETE FROM policy_rules WHERE id = ?").run(id);
    });
  }

  /* ---------- Maintenance Windows ---------- */

  getMaintenanceWindows(): MaintenanceWindow[] {
    return this.withDbRecovery("StateStore.getMaintenanceWindows", (db) => {
      return (db.prepare("SELECT * FROM maintenance_windows").all() as Record<string, unknown>[]).map(maintenanceWindowFromRow);
    });
  }

  upsertMaintenanceWindow(window: MaintenanceWindow): void {
    this.withDbRecovery("StateStore.upsertMaintenanceWindow", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO maintenance_windows (id, name, deviceIds, cronStart, durationMinutes, enabled, createdAt)
        VALUES (@id, @name, @deviceIds, @cronStart, @durationMinutes, @enabled, @createdAt)
      `).run({
        id: window.id, name: window.name, deviceIds: JSON.stringify(window.deviceIds),
        cronStart: window.cronStart, durationMinutes: window.durationMinutes,
        enabled: window.enabled ? 1 : 0, createdAt: window.createdAt,
      });
    });
  }

  deleteMaintenanceWindow(id: string): void {
    this.withDbRecovery("StateStore.deleteMaintenanceWindow", (db) => {
      db.prepare("DELETE FROM maintenance_windows WHERE id = ?").run(id);
    });
  }

  /* ---------- Playbook Runs ---------- */

  getPlaybookRuns(filter?: { status?: string; deviceId?: string }): PlaybookRun[] {
    return this.withDbRecovery("StateStore.getPlaybookRuns", (db) => {
      let query = "SELECT * FROM playbook_runs";
      const conditions: string[] = [];
      const params: Record<string, string> = {};

      if (filter?.status) {
        conditions.push("status = @status");
        params.status = filter.status;
      }
      if (filter?.deviceId) {
        conditions.push("deviceId = @deviceId");
        params.deviceId = filter.deviceId;
      }

      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY createdAt DESC LIMIT 500";

      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(playbookRunFromRow);
    });
  }

  getPlaybookRunById(id: string): PlaybookRun | undefined {
    return this.withDbRecovery("StateStore.getPlaybookRunById", (db) => {
      const row = db.prepare("SELECT * FROM playbook_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? playbookRunFromRow(row) : undefined;
    });
  }

  upsertPlaybookRun(run: PlaybookRun): void {
    this.withDbRecovery("StateStore.upsertPlaybookRun", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO playbook_runs (id, playbookId, family, name, deviceId, incidentId, actionClass, status, policyEvaluation, steps, verificationSteps, rollbackSteps, evidence, createdAt, startedAt, completedAt, approvedBy, approvedAt, deniedBy, deniedAt, denialReason, expiresAt, failureCount)
        VALUES (@id, @playbookId, @family, @name, @deviceId, @incidentId, @actionClass, @status, @policyEvaluation, @steps, @verificationSteps, @rollbackSteps, @evidence, @createdAt, @startedAt, @completedAt, @approvedBy, @approvedAt, @deniedBy, @deniedAt, @denialReason, @expiresAt, @failureCount)
      `).run({
        id: run.id, playbookId: run.playbookId, family: run.family, name: run.name,
        deviceId: run.deviceId, incidentId: run.incidentId ?? null,
        actionClass: run.actionClass, status: run.status,
        policyEvaluation: JSON.stringify(run.policyEvaluation),
        steps: JSON.stringify(run.steps),
        verificationSteps: JSON.stringify(run.verificationSteps),
        rollbackSteps: JSON.stringify(run.rollbackSteps),
        evidence: JSON.stringify(run.evidence),
        createdAt: run.createdAt, startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null, approvedBy: run.approvedBy ?? null,
        approvedAt: run.approvedAt ?? null, deniedBy: run.deniedBy ?? null,
        deniedAt: run.deniedAt ?? null, denialReason: run.denialReason ?? null,
        expiresAt: run.expiresAt ?? null, failureCount: run.failureCount,
      });
    });
  }

  getPendingApprovals(): PlaybookRun[] {
    return this.withDbRecovery("StateStore.getPendingApprovals", (db) => {
      const now = new Date().toISOString();
      return (db.prepare(
        "SELECT * FROM playbook_runs WHERE status = 'pending_approval' AND (expiresAt IS NULL OR expiresAt > ?) ORDER BY createdAt ASC",
      ).all(now) as Record<string, unknown>[]).map(playbookRunFromRow);
    });
  }

  /* ---------- Daily Digests ---------- */

  addDigest(digest: DailyDigest): void {
    this.withDbRecovery("StateStore.addDigest", (db) => {
      const { id, generatedAt, periodStart, periodEnd, ...content } = digest;
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO daily_digests (id, generatedAt, periodStart, periodEnd, content)
          VALUES (@id, @generatedAt, @periodStart, @periodEnd, @content)
        `).run({
          id, generatedAt, periodStart, periodEnd,
          content: JSON.stringify(content),
        });

        // Keep max 90 digests
        db.prepare(`
          DELETE FROM daily_digests WHERE id NOT IN (
            SELECT id FROM daily_digests ORDER BY generatedAt DESC LIMIT 90
          )
        `).run();
      });
      tx();
    });
  }

  getLatestDigest(): DailyDigest | null {
    return this.withDbRecovery("StateStore.getLatestDigest", (db) => {
      const row = db.prepare("SELECT * FROM daily_digests ORDER BY generatedAt DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      return row ? dailyDigestFromRow(row) : null;
    });
  }

  getDigestById(id: string): DailyDigest | null {
    return this.withDbRecovery("StateStore.getDigestById", (db) => {
      const row = db.prepare("SELECT * FROM daily_digests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? dailyDigestFromRow(row) : null;
    });
  }

  /* ---------- Chat Sessions & Messages ---------- */

  getChatSessions(): ChatSession[] {
    return this.withDbRecovery("StateStore.getChatSessions", (db) => {
      return (db.prepare("SELECT * FROM chat_sessions ORDER BY updatedAt DESC").all() as Record<string, unknown>[]).map(
        (row) => ({
          id: row.id as string,
          title: row.title as string,
          deviceId: (row.deviceId as string) ?? undefined,
          provider: (row.provider as string) ?? undefined,
          model: (row.model as string) ?? undefined,
          createdAt: row.createdAt as string,
          updatedAt: row.updatedAt as string,
        }),
      );
    });
  }

  getChatSessionById(id: string): ChatSession | null {
    return this.withDbRecovery("StateStore.getChatSessionById", (db) => {
      const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        title: row.title as string,
        deviceId: (row.deviceId as string) ?? undefined,
        provider: (row.provider as string) ?? undefined,
        model: (row.model as string) ?? undefined,
        createdAt: row.createdAt as string,
        updatedAt: row.updatedAt as string,
      };
    });
  }

  getChatMessages(sessionId: string): ChatMessage[] {
    return this.withDbRecovery("StateStore.getChatMessages", (db) => {
      return (db.prepare("SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY createdAt ASC").all(sessionId) as Record<string, unknown>[]).map(
        (row) => ({
          id: row.id as string,
          sessionId: row.sessionId as string,
          role: row.role as ChatMessage["role"],
          content: row.content as string,
          provider: (row.provider as string) ?? undefined,
          error: Boolean(row.error),
          createdAt: row.createdAt as string,
        }),
      );
    });
  }

  createChatSession(session: ChatSession): void {
    this.withDbRecovery("StateStore.createChatSession", (db) => {
      db.prepare(`
        INSERT INTO chat_sessions (id, title, deviceId, provider, model, createdAt, updatedAt)
        VALUES (@id, @title, @deviceId, @provider, @model, @createdAt, @updatedAt)
      `).run({
        id: session.id,
        title: session.title,
        deviceId: session.deviceId ?? null,
        provider: session.provider ?? null,
        model: session.model ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    });
  }

  addChatMessage(message: ChatMessage): void {
    this.withDbRecovery("StateStore.addChatMessage", (db) => {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO chat_messages (id, sessionId, role, content, provider, error, createdAt)
          VALUES (@id, @sessionId, @role, @content, @provider, @error, @createdAt)
        `).run({
          id: message.id,
          sessionId: message.sessionId,
          role: message.role,
          content: message.content,
          provider: message.provider ?? null,
          error: message.error ? 1 : 0,
          createdAt: message.createdAt,
        });

        // Touch the session's updatedAt
        db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(
          message.createdAt,
          message.sessionId,
        );
      });
      tx();
    });
  }

  updateChatSessionTitle(id: string, title: string): void {
    this.withDbRecovery("StateStore.updateChatSessionTitle", (db) => {
      db.prepare("UPDATE chat_sessions SET title = ?, updatedAt = ? WHERE id = ?").run(
        title,
        new Date().toISOString(),
        id,
      );
    });
  }

  updateChatSessionDevice(id: string, deviceId?: string): void {
    this.withDbRecovery("StateStore.updateChatSessionDevice", (db) => {
      db.prepare("UPDATE chat_sessions SET deviceId = ?, updatedAt = ? WHERE id = ?").run(
        deviceId ?? null,
        new Date().toISOString(),
        id,
      );
    });
  }

  deleteChatSession(id: string): void {
    this.withDbRecovery("StateStore.deleteChatSession", (db) => {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM chat_messages WHERE sessionId = ?").run(id);
        db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
      });
      tx();
    });
  }

  getDeviceById(id: string): Device | null {
    return this.withDbRecovery("StateStore.getDeviceById", (db) => {
      const row = db.prepare("SELECT * FROM devices WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? deviceFromRow(row) : null;
    });
  }

  getDataDir(): string {
    return dbGetDataDir();
  }

  getStateFile(): string {
    return getDbPath();
  }
}

export const stateStore = new StateStore();
