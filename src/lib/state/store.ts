import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  getDb,
  getDataDir as dbGetDataDir,
  getDbPath,
  recoverCorruptDatabase,
} from "@/lib/state/db";
import { ensureDefaults } from "@/lib/state/defaults";
import type {
  ActionLog,
  AgentRunRecord,
  Device,
  DeviceBaseline,
  GraphEdge,
  GraphNode,
  Incident,
  OAuthState,
  ProviderConfig,
  Recommendation,
  StewardState,
} from "@/lib/state/types";

/* ---------- Row <-> Domain helpers ---------- */

function deviceFromRow(row: Record<string, unknown>): Device {
  return {
    id: row.id as string,
    name: row.name as string,
    ip: row.ip as string,
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

      // Devices
      db.prepare("DELETE FROM devices").run();
      const insertDevice = db.prepare(`
        INSERT INTO devices (id, name, ip, mac, hostname, vendor, os, role, type, status, autonomyTier, tags, protocols, services, firstSeenAt, lastSeenAt, lastChangedAt, metadata)
        VALUES (@id, @name, @ip, @mac, @hostname, @vendor, @os, @role, @type, @status, @autonomyTier, @tags, @protocols, @services, @firstSeenAt, @lastSeenAt, @lastChangedAt, @metadata)
      `);
      for (const d of state.devices) {
        insertDevice.run({
          id: d.id, name: d.name, ip: d.ip, mac: d.mac ?? null, hostname: d.hostname ?? null,
          vendor: d.vendor ?? null, os: d.os ?? null, role: d.role ?? null, type: d.type,
          status: d.status, autonomyTier: d.autonomyTier, tags: JSON.stringify(d.tags),
          protocols: JSON.stringify(d.protocols), services: JSON.stringify(d.services),
          firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt, lastChangedAt: d.lastChangedAt,
          metadata: JSON.stringify(d.metadata),
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
        INSERT OR REPLACE INTO devices (id, name, ip, mac, hostname, vendor, os, role, type, status, autonomyTier, tags, protocols, services, firstSeenAt, lastSeenAt, lastChangedAt, metadata)
        VALUES (@id, @name, @ip, @mac, @hostname, @vendor, @os, @role, @type, @status, @autonomyTier, @tags, @protocols, @services, @firstSeenAt, @lastSeenAt, @lastChangedAt, @metadata)
      `).run({
        id: device.id, name: device.name, ip: device.ip,
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

  getDataDir(): string {
    return dbGetDataDir();
  }

  getStateFile(): string {
    return getDbPath();
  }
}

export const stateStore = new StateStore();
