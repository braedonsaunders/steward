import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { builtinMissions, builtinPacks, builtinSubagents } from "@/lib/autonomy/builtin";
import type {
  BriefingRecord,
  GatewayBindingRecord,
  GatewayInboundEventRecord,
  GatewayThreadRecord,
  InvestigationRecord,
  InvestigationStepRecord,
  MissionLinkRecord,
  MissionRecord,
  MissionRunRecord,
  MissionWithDetails,
  PackRecord,
  PackResourceRecord,
  PackSummary,
  PackVersionRecord,
  SubagentRecord,
  SubagentWithMetrics,
} from "@/lib/autonomy/types";
import { getDb, recoverCorruptDatabase } from "@/lib/state/db";
import { stateStore } from "@/lib/state/store";

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: unknown): string[] {
  return parseJsonArray(value).filter((item): item is string => typeof item === "string");
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseBool(value: unknown): boolean {
  return Boolean(value);
}

function packFromRow(row: Record<string, unknown>): PackRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    version: String(row.version),
    description: String(row.description ?? ""),
    kind: row.kind === "managed" ? "managed" : "builtin",
    enabled: parseBool(row.enabled),
    builtin: parseBool(row.builtin),
    trustMode: row.trustMode === "builtin" || row.trustMode === "verified" ? row.trustMode : "unsigned",
    signerId: parseOptionalString(row.signerId),
    signature: parseOptionalString(row.signature),
    signatureAlgorithm: parseOptionalString(row.signatureAlgorithm),
    verificationStatus: row.verificationStatus === "builtin"
      || row.verificationStatus === "verified"
      || row.verificationStatus === "failed"
      ? row.verificationStatus
      : "unsigned",
    verifiedAt: parseOptionalString(row.verifiedAt),
    manifestJson: parseJsonRecord(row.manifestJson) as unknown as PackRecord["manifestJson"],
    installedAt: String(row.installedAt),
    updatedAt: String(row.updatedAt),
  };
}

function subagentFromRow(row: Record<string, unknown>): SubagentRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description ?? ""),
    status: row.status === "paused" || row.status === "disabled" ? row.status : "active",
    scopeJson: parseJsonRecord(row.scopeJson) as unknown as SubagentRecord["scopeJson"],
    autonomyJson: parseJsonRecord(row.autonomyJson) as unknown as SubagentRecord["autonomyJson"],
    packId: parseOptionalString(row.packId),
    channelBindingId: parseOptionalString(row.channelBindingId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function missionFromRow(row: Record<string, unknown>): MissionRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    kind: String(row.kind) as MissionRecord["kind"],
    status: row.status === "paused" || row.status === "completed" || row.status === "archived" ? row.status : "active",
    priority: row.priority === "low" || row.priority === "high" ? row.priority : "medium",
    objective: String(row.objective ?? ""),
    subagentId: parseOptionalString(row.subagentId),
    packId: parseOptionalString(row.packId),
    cadenceMinutes: Math.max(1, Number(row.cadenceMinutes ?? 60)),
    autoRun: parseBool(row.autoRun),
    autoApprove: parseBool(row.autoApprove),
    shadowMode: parseBool(row.shadowMode),
    targetJson: parseJsonRecord(row.targetJson) as MissionRecord["targetJson"],
    stateJson: parseJsonRecord(row.stateJson),
    lastRunAt: parseOptionalString(row.lastRunAt),
    nextRunAt: parseOptionalString(row.nextRunAt),
    lastStatus: parseOptionalString(row.lastStatus) as MissionRecord["lastStatus"],
    lastSummary: parseOptionalString(row.lastSummary),
    createdBy: row.createdBy === "user" ? "user" : "steward",
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function missionLinkFromRow(row: Record<string, unknown>): MissionLinkRecord {
  return {
    id: String(row.id),
    missionId: String(row.missionId),
    resourceType: String(row.resourceType) as MissionLinkRecord["resourceType"],
    resourceId: String(row.resourceId),
    metadataJson: parseJsonRecord(row.metadataJson),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function missionRunFromRow(row: Record<string, unknown>): MissionRunRecord {
  return {
    id: String(row.id),
    missionId: String(row.missionId),
    subagentId: parseOptionalString(row.subagentId),
    status: String(row.status) as MissionRunRecord["status"],
    summary: String(row.summary),
    outcomeJson: parseJsonRecord(row.outcomeJson),
    startedAt: String(row.startedAt),
    completedAt: parseOptionalString(row.completedAt),
    createdAt: String(row.createdAt),
  };
}

function investigationFromRow(row: Record<string, unknown>): InvestigationRecord {
  return {
    id: String(row.id),
    missionId: parseOptionalString(row.missionId),
    subagentId: parseOptionalString(row.subagentId),
    parentInvestigationId: parseOptionalString(row.parentInvestigationId),
    title: String(row.title),
    status: String(row.status) as InvestigationRecord["status"],
    severity: String(row.severity) as InvestigationRecord["severity"],
    stage: String(row.stage) as InvestigationRecord["stage"],
    objective: String(row.objective ?? ""),
    hypothesis: parseOptionalString(row.hypothesis),
    summary: String(row.summary ?? ""),
    sourceType: parseOptionalString(row.sourceType),
    sourceId: parseOptionalString(row.sourceId),
    deviceId: parseOptionalString(row.deviceId),
    evidenceJson: parseJsonRecord(row.evidenceJson),
    recommendedActionsJson: parseStringArray(row.recommendedActionsJson),
    unresolvedQuestionsJson: parseStringArray(row.unresolvedQuestionsJson),
    nextRunAt: parseOptionalString(row.nextRunAt),
    lastRunAt: parseOptionalString(row.lastRunAt),
    resolution: parseOptionalString(row.resolution),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function investigationStepFromRow(row: Record<string, unknown>): InvestigationStepRecord {
  return {
    id: String(row.id),
    investigationId: String(row.investigationId),
    kind: String(row.kind) as InvestigationStepRecord["kind"],
    status: row.status === "pending" ? "pending" : "completed",
    title: String(row.title),
    detail: String(row.detail ?? ""),
    evidenceJson: parseJsonRecord(row.evidenceJson),
    createdAt: String(row.createdAt),
  };
}

function gatewayBindingFromRow(row: Record<string, unknown>): GatewayBindingRecord {
  return {
    id: String(row.id),
    kind: "telegram",
    name: String(row.name),
    enabled: parseBool(row.enabled),
    target: String(row.target ?? ""),
    vaultSecretRef: parseOptionalString(row.vaultSecretRef),
    webhookSecret: parseOptionalString(row.webhookSecret),
    defaultThreadTitle: parseOptionalString(row.defaultThreadTitle),
    configJson: parseJsonRecord(row.configJson),
    lastInboundAt: parseOptionalString(row.lastInboundAt),
    lastOutboundAt: parseOptionalString(row.lastOutboundAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function gatewayThreadFromRow(row: Record<string, unknown>): GatewayThreadRecord {
  return {
    id: String(row.id),
    bindingId: String(row.bindingId),
    externalThreadKey: String(row.externalThreadKey),
    title: String(row.title),
    missionId: parseOptionalString(row.missionId),
    subagentId: parseOptionalString(row.subagentId),
    chatSessionId: parseOptionalString(row.chatSessionId),
    lastInboundAt: parseOptionalString(row.lastInboundAt),
    lastOutboundAt: parseOptionalString(row.lastOutboundAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function gatewayInboundEventFromRow(row: Record<string, unknown>): GatewayInboundEventRecord {
  return {
    id: String(row.id),
    bindingId: String(row.bindingId),
    externalUpdateId: String(row.externalUpdateId),
    threadId: parseOptionalString(row.threadId),
    receivedAt: String(row.receivedAt),
  };
}

function briefingFromRow(row: Record<string, unknown>): BriefingRecord {
  return {
    id: String(row.id),
    scope: String(row.scope) as BriefingRecord["scope"],
    subagentId: parseOptionalString(row.subagentId),
    missionId: parseOptionalString(row.missionId),
    bindingId: parseOptionalString(row.bindingId),
    title: String(row.title),
    body: String(row.body),
    format: row.format === "plain" ? "plain" : "markdown",
    delivered: parseBool(row.delivered),
    deliveredAt: parseOptionalString(row.deliveredAt),
    metadataJson: parseJsonRecord(row.metadataJson),
    createdAt: String(row.createdAt),
  };
}

function packResourceFromRow(row: Record<string, unknown>): PackResourceRecord {
  return {
    id: String(row.id),
    packId: String(row.packId),
    type: String(row.type) as PackResourceRecord["type"],
    resourceKey: String(row.resourceKey),
    title: String(row.title),
    description: parseOptionalString(row.description),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function packVersionFromRow(row: Record<string, unknown>): PackVersionRecord {
  return {
    id: String(row.id),
    packId: String(row.packId),
    version: String(row.version),
    action: String(row.action) as PackVersionRecord["action"],
    manifestJson: parseJsonRecord(row.manifestJson) as unknown as PackVersionRecord["manifestJson"],
    createdAt: String(row.createdAt),
  };
}

class AutonomyStore {
  private withDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
    const run = () => {
      stateStore.getRuntimeSettings();
      return operation(getDb());
    };

    try {
      return run();
    } catch (error) {
      if (!recoverCorruptDatabase(error, context)) {
        throw error;
      }
      return run();
    }
  }

  private upsertPackInstall(db: Database.Database, pack: PackRecord): void {
    db.prepare(`
      INSERT INTO pack_installs (id, packId, enabled, installedAt, updatedAt)
      VALUES (@id, @packId, @enabled, @installedAt, @updatedAt)
      ON CONFLICT(packId) DO UPDATE SET
        enabled = excluded.enabled,
        updatedAt = excluded.updatedAt
    `).run({
      id: `install:${pack.id}`,
      packId: pack.id,
      enabled: pack.enabled ? 1 : 0,
      installedAt: pack.installedAt,
      updatedAt: pack.updatedAt,
    });
  }

  private replacePackResources(db: Database.Database, pack: PackRecord): void {
    db.prepare("DELETE FROM pack_resources WHERE packId = ?").run(pack.id);
    const insert = db.prepare(`
      INSERT INTO pack_resources (id, packId, type, resourceKey, title, description, createdAt, updatedAt)
      VALUES (@id, @packId, @type, @resourceKey, @title, @description, @createdAt, @updatedAt)
    `);
    const now = pack.updatedAt;
    for (const resource of pack.manifestJson.resources ?? []) {
      insert.run({
        id: `${pack.id}:${resource.type}:${resource.key}`,
        packId: pack.id,
        type: resource.type,
        resourceKey: resource.key,
        title: resource.title,
        description: resource.description ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private recordPackVersion(db: Database.Database, pack: PackRecord, action: PackVersionRecord["action"]): void {
    db.prepare(`
      INSERT INTO pack_versions (id, packId, version, action, manifestJson, createdAt)
      VALUES (@id, @packId, @version, @action, @manifestJson, @createdAt)
    `).run({
      id: randomUUID(),
      packId: pack.id,
      version: pack.version,
      action,
      manifestJson: JSON.stringify(pack.manifestJson),
      createdAt: pack.updatedAt,
    });
  }

  private writePack(
    db: Database.Database,
    pack: PackRecord,
    options?: {
      action?: PackVersionRecord["action"];
    },
  ): PackRecord {
    const existing = db.prepare("SELECT * FROM packs WHERE id = ? LIMIT 1").get(pack.id) as Record<string, unknown> | undefined;
    db.prepare(`
      INSERT INTO packs (
        id, slug, name, version, description, kind, enabled, builtin, trustMode, signerId, signature, signatureAlgorithm,
        verificationStatus, verifiedAt, manifestJson, installedAt, updatedAt
      )
      VALUES (
        @id, @slug, @name, @version, @description, @kind, @enabled, @builtin, @trustMode, @signerId, @signature, @signatureAlgorithm,
        @verificationStatus, @verifiedAt, @manifestJson, @installedAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        name = excluded.name,
        version = excluded.version,
        description = excluded.description,
        kind = excluded.kind,
        enabled = excluded.enabled,
        builtin = excluded.builtin,
        trustMode = excluded.trustMode,
        signerId = excluded.signerId,
        signature = excluded.signature,
        signatureAlgorithm = excluded.signatureAlgorithm,
        verificationStatus = excluded.verificationStatus,
        verifiedAt = excluded.verifiedAt,
        manifestJson = excluded.manifestJson,
        updatedAt = excluded.updatedAt
    `).run({
      ...pack,
      enabled: pack.enabled ? 1 : 0,
      builtin: pack.builtin ? 1 : 0,
      signerId: pack.signerId ?? null,
      signature: pack.signature ?? null,
      signatureAlgorithm: pack.signatureAlgorithm ?? null,
      verificationStatus: pack.verificationStatus ?? (pack.builtin ? "builtin" : pack.trustMode === "verified" ? "verified" : "unsigned"),
      verifiedAt: pack.verifiedAt ?? null,
      manifestJson: JSON.stringify(pack.manifestJson),
    });
    this.upsertPackInstall(db, pack);
    this.replacePackResources(db, pack);

    const previous = existing ? packFromRow(existing) : undefined;
    const action = options?.action
      ?? (!previous ? "installed" : previous.version !== pack.version ? "upgraded" : undefined);
    if (action) {
      this.recordPackVersion(db, pack, action);
    }

    return pack;
  }

  ensureBootstrap(): void {
    this.withDbRecovery("AutonomyStore.ensureBootstrap", (db) => {
      const tx = db.transaction(() => {
        for (const pack of builtinPacks()) {
          this.writePack(db, pack);
        }

        for (const subagent of builtinSubagents()) {
          db.prepare(`
            INSERT INTO subagents (id, slug, name, description, status, scopeJson, autonomyJson, packId, channelBindingId, createdAt, updatedAt)
            VALUES (@id, @slug, @name, @description, @status, @scopeJson, @autonomyJson, @packId, @channelBindingId, @createdAt, @updatedAt)
            ON CONFLICT(id) DO UPDATE SET
              slug = excluded.slug,
              name = excluded.name,
              description = excluded.description,
              scopeJson = excluded.scopeJson,
              autonomyJson = excluded.autonomyJson,
              packId = excluded.packId,
              updatedAt = excluded.updatedAt
          `).run({
            ...subagent,
            scopeJson: JSON.stringify(subagent.scopeJson),
            autonomyJson: JSON.stringify(subagent.autonomyJson),
            channelBindingId: subagent.channelBindingId ?? null,
            packId: subagent.packId ?? null,
          });
        }

        for (const mission of builtinMissions()) {
          db.prepare(`
            INSERT INTO missions (
              id, slug, title, summary, kind, status, priority, objective, subagentId, packId, cadenceMinutes,
              autoRun, autoApprove, shadowMode, targetJson, stateJson, lastRunAt, nextRunAt, lastStatus, lastSummary,
              createdBy, createdAt, updatedAt
            )
            VALUES (
              @id, @slug, @title, @summary, @kind, @status, @priority, @objective, @subagentId, @packId, @cadenceMinutes,
              @autoRun, @autoApprove, @shadowMode, @targetJson, @stateJson, @lastRunAt, @nextRunAt, @lastStatus, @lastSummary,
              @createdBy, @createdAt, @updatedAt
            )
            ON CONFLICT(id) DO UPDATE SET
              slug = excluded.slug,
              title = excluded.title,
              summary = excluded.summary,
              kind = excluded.kind,
              priority = excluded.priority,
              objective = excluded.objective,
              subagentId = excluded.subagentId,
              packId = excluded.packId,
              cadenceMinutes = excluded.cadenceMinutes,
              autoRun = excluded.autoRun,
              autoApprove = excluded.autoApprove,
              shadowMode = excluded.shadowMode,
              targetJson = excluded.targetJson,
              updatedAt = excluded.updatedAt
          `).run({
            ...mission,
            subagentId: mission.subagentId ?? null,
            packId: mission.packId ?? null,
            autoRun: mission.autoRun ? 1 : 0,
            autoApprove: mission.autoApprove ? 1 : 0,
            shadowMode: mission.shadowMode ? 1 : 0,
            targetJson: JSON.stringify(mission.targetJson),
            stateJson: JSON.stringify(mission.stateJson),
            lastRunAt: mission.lastRunAt ?? null,
            nextRunAt: mission.nextRunAt ?? null,
            lastStatus: mission.lastStatus ?? null,
            lastSummary: mission.lastSummary ?? null,
          });
        }
      });
      tx();
    });
  }

  listPacks(): PackRecord[] {
    this.ensureBootstrap();
    return this.withDbRecovery("AutonomyStore.listPacks", (db) =>
      (db.prepare("SELECT * FROM packs ORDER BY builtin DESC, slug ASC").all() as Record<string, unknown>[]).map(packFromRow),
    );
  }

  getPackById(id: string): PackRecord | undefined {
    this.ensureBootstrap();
    return this.withDbRecovery("AutonomyStore.getPackById", (db) => {
      const row = db.prepare("SELECT * FROM packs WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? packFromRow(row) : undefined;
    });
  }

  upsertPack(pack: PackRecord): PackRecord {
    return this.withDbRecovery("AutonomyStore.upsertPack", (db) => {
      return this.writePack(db, pack);
    });
  }

  listPackSummaries(): PackSummary[] {
    const packs = this.listPacks();
    return packs.map((pack) => ({
      ...pack,
      subagentCount: (pack.manifestJson.resources ?? []).filter((resource) => resource.type === "subagent").length,
      missionTemplateCount: (pack.manifestJson.resources ?? []).filter((resource) => resource.type === "mission-template").length,
      resourceCount: (pack.manifestJson.resources ?? []).length,
    }));
  }

  listSubagents(): SubagentRecord[] {
    this.ensureBootstrap();
    return this.withDbRecovery("AutonomyStore.listSubagents", (db) =>
      (db.prepare("SELECT * FROM subagents ORDER BY slug ASC").all() as Record<string, unknown>[]).map(subagentFromRow),
    );
  }

  listSubagentsWithMetrics(): SubagentWithMetrics[] {
    const subagents = this.listSubagents();
    return this.withDbRecovery("AutonomyStore.listSubagentsWithMetrics", (db) =>
      subagents.map((subagent) => {
        const missionCountRow = db.prepare("SELECT COUNT(*) AS total FROM missions WHERE subagentId = ?").get(subagent.id) as { total?: number } | undefined;
        const activeMissionCountRow = db.prepare("SELECT COUNT(*) AS total FROM missions WHERE subagentId = ? AND status = 'active'").get(subagent.id) as { total?: number } | undefined;
        const openInvestigationCountRow = db.prepare("SELECT COUNT(*) AS total FROM investigations WHERE subagentId = ? AND status IN ('open', 'monitoring')").get(subagent.id) as { total?: number } | undefined;
        const memoryCountRow = db.prepare("SELECT COUNT(*) AS total FROM subagent_memories WHERE subagentId = ?").get(subagent.id) as { total?: number } | undefined;
        const standingOrderCountRow = db.prepare("SELECT COUNT(*) AS total FROM standing_orders WHERE subagentId = ? AND enabled = 1").get(subagent.id) as { total?: number } | undefined;
        const delegationCountRow = db.prepare("SELECT COUNT(*) AS total FROM mission_delegations WHERE toSubagentId = ? AND status IN ('open', 'accepted')").get(subagent.id) as { total?: number } | undefined;
        return {
          ...subagent,
          missionCount: Number(missionCountRow?.total ?? 0),
          activeMissionCount: Number(activeMissionCountRow?.total ?? 0),
          openInvestigationCount: Number(openInvestigationCountRow?.total ?? 0),
          memoryCount: Number(memoryCountRow?.total ?? 0),
          standingOrderCount: Number(standingOrderCountRow?.total ?? 0),
          delegationCount: Number(delegationCountRow?.total ?? 0),
        };
      }),
    );
  }

  getSubagentById(id: string): SubagentRecord | undefined {
    this.ensureBootstrap();
    return this.withDbRecovery("AutonomyStore.getSubagentById", (db) => {
      const row = db.prepare("SELECT * FROM subagents WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? subagentFromRow(row) : undefined;
    });
  }

  upsertSubagent(subagent: SubagentRecord): SubagentRecord {
    return this.withDbRecovery("AutonomyStore.upsertSubagent", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO subagents (
          id, slug, name, description, status, scopeJson, autonomyJson, packId, channelBindingId, createdAt, updatedAt
        )
        VALUES (
          @id, @slug, @name, @description, @status, @scopeJson, @autonomyJson, @packId, @channelBindingId, @createdAt, @updatedAt
        )
      `).run({
        ...subagent,
        scopeJson: JSON.stringify(subagent.scopeJson),
        autonomyJson: JSON.stringify(subagent.autonomyJson),
        packId: subagent.packId ?? null,
        channelBindingId: subagent.channelBindingId ?? null,
      });
      return subagent;
    });
  }

  setPackEnabled(id: string, enabled: boolean): PackRecord | undefined {
    return this.withDbRecovery("AutonomyStore.setPackEnabled", (db) => {
      const updatedAt = nowIso();
      db.prepare("UPDATE packs SET enabled = ?, updatedAt = ? WHERE id = ?").run(enabled ? 1 : 0, updatedAt, id);
      db.prepare("UPDATE pack_installs SET enabled = ?, updatedAt = ? WHERE packId = ?").run(enabled ? 1 : 0, updatedAt, id);
      const row = db.prepare("SELECT * FROM packs WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? packFromRow(row) : undefined;
    });
  }

  uninstallPack(id: string): PackRecord | undefined {
    return this.withDbRecovery("AutonomyStore.uninstallPack", (db) => {
      const row = db.prepare("SELECT * FROM packs WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      if (!row) {
        return undefined;
      }
      const pack = packFromRow(row);
      const next: PackRecord = {
        ...pack,
        enabled: false,
        updatedAt: nowIso(),
      };
      this.writePack(db, next, {
        action: "removed",
      });
      return next;
    });
  }

  listPackResources(packId: string): PackResourceRecord[] {
    return this.withDbRecovery("AutonomyStore.listPackResources", (db) =>
      (db.prepare(`
        SELECT * FROM pack_resources
        WHERE packId = ?
        ORDER BY type ASC, resourceKey ASC
      `).all(packId) as Record<string, unknown>[]).map(packResourceFromRow),
    );
  }

  listPackVersions(packId: string, limit = 25): PackVersionRecord[] {
    return this.withDbRecovery("AutonomyStore.listPackVersions", (db) =>
      (db.prepare(`
        SELECT * FROM pack_versions
        WHERE packId = ?
        ORDER BY createdAt DESC
        LIMIT ?
      `).all(packId, Math.max(1, Math.min(100, limit))) as Record<string, unknown>[]).map(packVersionFromRow),
    );
  }

  setSubagentStatus(id: string, status: SubagentRecord["status"]): SubagentRecord | undefined {
    return this.withDbRecovery("AutonomyStore.setSubagentStatus", (db) => {
      db.prepare("UPDATE subagents SET status = ?, updatedAt = ? WHERE id = ?").run(
        status,
        nowIso(),
        id,
      );
      const row = db.prepare("SELECT * FROM subagents WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? subagentFromRow(row) : undefined;
    });
  }

  listMissions(filter?: {
    status?: MissionRecord["status"];
    subagentId?: string;
    dueBefore?: string;
    autoRun?: boolean;
  }): MissionRecord[] {
    this.ensureBootstrap();
    return this.withDbRecovery("AutonomyStore.listMissions", (db) => {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter?.status) {
        conditions.push("status = @status");
        params.status = filter.status;
      }
      if (filter?.subagentId) {
        conditions.push("subagentId = @subagentId");
        params.subagentId = filter.subagentId;
      }
      if (filter?.dueBefore) {
        conditions.push("(nextRunAt IS NOT NULL AND nextRunAt <= @dueBefore)");
        params.dueBefore = filter.dueBefore;
      }
      if (typeof filter?.autoRun === "boolean") {
        conditions.push("autoRun = @autoRun");
        params.autoRun = filter.autoRun ? 1 : 0;
      }

      let query = "SELECT * FROM missions";
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY priority DESC, updatedAt DESC, slug ASC";

      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(missionFromRow);
    });
  }

  getDueMissions(referenceIso = nowIso()): MissionRecord[] {
    return this.listMissions({
      status: "active",
      autoRun: true,
      dueBefore: referenceIso,
    });
  }

  getMissionById(id: string): MissionRecord | undefined {
    this.ensureBootstrap();
    return this.withDbRecovery("AutonomyStore.getMissionById", (db) => {
      const row = db.prepare("SELECT * FROM missions WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? missionFromRow(row) : undefined;
    });
  }

  getMissionBySlug(slug: string): MissionRecord | undefined {
    this.ensureBootstrap();
    return this.withDbRecovery("AutonomyStore.getMissionBySlug", (db) => {
      const row = db.prepare("SELECT * FROM missions WHERE slug = ? LIMIT 1").get(slug) as Record<string, unknown> | undefined;
      return row ? missionFromRow(row) : undefined;
    });
  }

  upsertMission(mission: MissionRecord): MissionRecord {
    return this.withDbRecovery("AutonomyStore.upsertMission", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO missions (
          id, slug, title, summary, kind, status, priority, objective, subagentId, packId, cadenceMinutes,
          autoRun, autoApprove, shadowMode, targetJson, stateJson, lastRunAt, nextRunAt, lastStatus, lastSummary,
          createdBy, createdAt, updatedAt
        )
        VALUES (
          @id, @slug, @title, @summary, @kind, @status, @priority, @objective, @subagentId, @packId, @cadenceMinutes,
          @autoRun, @autoApprove, @shadowMode, @targetJson, @stateJson, @lastRunAt, @nextRunAt, @lastStatus, @lastSummary,
          @createdBy, @createdAt, @updatedAt
        )
      `).run({
        ...mission,
        subagentId: mission.subagentId ?? null,
        packId: mission.packId ?? null,
        autoRun: mission.autoRun ? 1 : 0,
        autoApprove: mission.autoApprove ? 1 : 0,
        shadowMode: mission.shadowMode ? 1 : 0,
        targetJson: JSON.stringify(mission.targetJson ?? {}),
        stateJson: JSON.stringify(mission.stateJson ?? {}),
        lastRunAt: mission.lastRunAt ?? null,
        nextRunAt: mission.nextRunAt ?? null,
        lastStatus: mission.lastStatus ?? null,
        lastSummary: mission.lastSummary ?? null,
      });
      return mission;
    });
  }

  setMissionStatus(id: string, status: MissionRecord["status"]): MissionRecord | undefined {
    return this.withDbRecovery("AutonomyStore.setMissionStatus", (db) => {
      db.prepare("UPDATE missions SET status = ?, updatedAt = ? WHERE id = ?").run(status, nowIso(), id);
      const row = db.prepare("SELECT * FROM missions WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? missionFromRow(row) : undefined;
    });
  }

  listMissionLinks(missionId: string): MissionLinkRecord[] {
    return this.withDbRecovery("AutonomyStore.listMissionLinks", (db) =>
      (db.prepare(`
        SELECT * FROM mission_links
        WHERE missionId = ?
        ORDER BY resourceType ASC, updatedAt DESC
      `).all(missionId) as Record<string, unknown>[]).map(missionLinkFromRow),
    );
  }

  listMissionLinksForResource(resourceType: MissionLinkRecord["resourceType"], resourceId: string): MissionLinkRecord[] {
    return this.withDbRecovery("AutonomyStore.listMissionLinksForResource", (db) =>
      (db.prepare(`
        SELECT * FROM mission_links
        WHERE resourceType = ? AND resourceId = ?
        ORDER BY updatedAt DESC
      `).all(resourceType, resourceId) as Record<string, unknown>[]).map(missionLinkFromRow),
    );
  }

  linkMissionResource(input: Omit<MissionLinkRecord, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
  }): MissionLinkRecord {
    return this.withDbRecovery("AutonomyStore.linkMissionResource", (db) => {
      const now = nowIso();
      const existing = db.prepare(`
        SELECT * FROM mission_links
        WHERE missionId = ? AND resourceType = ? AND resourceId = ?
        LIMIT 1
      `).get(input.missionId, input.resourceType, input.resourceId) as Record<string, unknown> | undefined;

      const next: MissionLinkRecord = {
        id: existing?.id ? String(existing.id) : (input.id ?? randomUUID()),
        missionId: input.missionId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadataJson: input.metadataJson ?? {},
        createdAt: existing?.createdAt ? String(existing.createdAt) : now,
        updatedAt: now,
      };

      db.prepare(`
        INSERT OR REPLACE INTO mission_links (id, missionId, resourceType, resourceId, metadataJson, createdAt, updatedAt)
        VALUES (@id, @missionId, @resourceType, @resourceId, @metadataJson, @createdAt, @updatedAt)
      `).run({
        ...next,
        metadataJson: JSON.stringify(next.metadataJson ?? {}),
      });

      return next;
    });
  }

  unlinkMissionResource(missionId: string, resourceType: MissionLinkRecord["resourceType"], resourceId: string): void {
    this.withDbRecovery("AutonomyStore.unlinkMissionResource", (db) => {
      db.prepare(`
        DELETE FROM mission_links
        WHERE missionId = ? AND resourceType = ? AND resourceId = ?
      `).run(missionId, resourceType, resourceId);
    });
  }

  listMissionRuns(missionId: string, limit = 25): MissionRunRecord[] {
    return this.withDbRecovery("AutonomyStore.listMissionRuns", (db) =>
      (db.prepare(`
        SELECT * FROM mission_runs
        WHERE missionId = ?
        ORDER BY createdAt DESC
        LIMIT ?
      `).all(missionId, Math.max(1, Math.min(250, limit))) as Record<string, unknown>[]).map(missionRunFromRow),
    );
  }

  getMissionRunById(id: string): MissionRunRecord | undefined {
    return this.withDbRecovery("AutonomyStore.getMissionRunById", (db) => {
      const row = db.prepare("SELECT * FROM mission_runs WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? missionRunFromRow(row) : undefined;
    });
  }

  getLatestMissionRun(missionId: string): MissionRunRecord | undefined {
    return this.withDbRecovery("AutonomyStore.getLatestMissionRun", (db) => {
      const row = db.prepare(`
        SELECT * FROM mission_runs
        WHERE missionId = ?
        ORDER BY createdAt DESC
        LIMIT 1
      `).get(missionId) as Record<string, unknown> | undefined;
      return row ? missionRunFromRow(row) : undefined;
    });
  }

  upsertMissionRun(run: MissionRunRecord): MissionRunRecord {
    return this.withDbRecovery("AutonomyStore.upsertMissionRun", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO mission_runs (
          id, missionId, subagentId, status, summary, outcomeJson, startedAt, completedAt, createdAt
        )
        VALUES (
          @id, @missionId, @subagentId, @status, @summary, @outcomeJson, @startedAt, @completedAt, @createdAt
        )
      `).run({
        ...run,
        subagentId: run.subagentId ?? null,
        outcomeJson: JSON.stringify(run.outcomeJson ?? {}),
        completedAt: run.completedAt ?? null,
      });
      return run;
    });
  }

  listInvestigations(filter?: {
    status?: InvestigationRecord["status"] | InvestigationRecord["status"][];
    missionId?: string;
    subagentId?: string;
    sourceType?: string;
    sourceId?: string;
    deviceId?: string;
  }): InvestigationRecord[] {
    return this.withDbRecovery("AutonomyStore.listInvestigations", (db) => {
      const params: Record<string, unknown> = {};
      const conditions: string[] = [];

      if (filter?.missionId) {
        conditions.push("missionId = @missionId");
        params.missionId = filter.missionId;
      }
      if (filter?.subagentId) {
        conditions.push("subagentId = @subagentId");
        params.subagentId = filter.subagentId;
      }
      if (filter?.sourceType) {
        conditions.push("sourceType = @sourceType");
        params.sourceType = filter.sourceType;
      }
      if (filter?.sourceId) {
        conditions.push("sourceId = @sourceId");
        params.sourceId = filter.sourceId;
      }
      if (filter?.deviceId) {
        conditions.push("deviceId = @deviceId");
        params.deviceId = filter.deviceId;
      }
      if (filter?.status) {
        const values = Array.isArray(filter.status) ? filter.status : [filter.status];
        const placeholders = values.map((_, index) => `@status${index}`);
        for (const [index, value] of values.entries()) {
          params[`status${index}`] = value;
        }
        conditions.push(`status IN (${placeholders.join(", ")})`);
      }

      let query = "SELECT * FROM investigations";
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY updatedAt DESC, createdAt DESC";

      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(investigationFromRow);
    });
  }

  getDueInvestigations(referenceIso = nowIso()): InvestigationRecord[] {
    return this.listInvestigations({
      status: ["open", "monitoring"],
    }).filter((investigation) =>
      !investigation.nextRunAt || investigation.nextRunAt <= referenceIso,
    );
  }

  getInvestigationById(id: string): InvestigationRecord | undefined {
    return this.withDbRecovery("AutonomyStore.getInvestigationById", (db) => {
      const row = db.prepare("SELECT * FROM investigations WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? investigationFromRow(row) : undefined;
    });
  }

  findOpenInvestigationBySource(input: {
    missionId?: string;
    sourceType: string;
    sourceId: string;
    deviceId?: string;
  }): InvestigationRecord | undefined {
    return this.withDbRecovery("AutonomyStore.findOpenInvestigationBySource", (db) => {
      const row = db.prepare(`
        SELECT * FROM investigations
        WHERE sourceType = @sourceType
          AND sourceId = @sourceId
          AND status IN ('open', 'monitoring')
          AND (@missionId IS NULL OR missionId = @missionId)
          AND (@deviceId IS NULL OR deviceId = @deviceId)
        ORDER BY updatedAt DESC
        LIMIT 1
      `).get({
        missionId: input.missionId ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        deviceId: input.deviceId ?? null,
      }) as Record<string, unknown> | undefined;
      return row ? investigationFromRow(row) : undefined;
    });
  }

  upsertInvestigation(investigation: InvestigationRecord): InvestigationRecord {
    return this.withDbRecovery("AutonomyStore.upsertInvestigation", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO investigations (
          id, missionId, subagentId, parentInvestigationId, title, status, severity, stage, objective, hypothesis, summary,
          sourceType, sourceId, deviceId, evidenceJson, recommendedActionsJson, unresolvedQuestionsJson,
          nextRunAt, lastRunAt, resolution, createdAt, updatedAt
        )
        VALUES (
          @id, @missionId, @subagentId, @parentInvestigationId, @title, @status, @severity, @stage, @objective, @hypothesis, @summary,
          @sourceType, @sourceId, @deviceId, @evidenceJson, @recommendedActionsJson, @unresolvedQuestionsJson,
          @nextRunAt, @lastRunAt, @resolution, @createdAt, @updatedAt
        )
      `).run({
        ...investigation,
        missionId: investigation.missionId ?? null,
        subagentId: investigation.subagentId ?? null,
        parentInvestigationId: investigation.parentInvestigationId ?? null,
        hypothesis: investigation.hypothesis ?? null,
        sourceType: investigation.sourceType ?? null,
        sourceId: investigation.sourceId ?? null,
        deviceId: investigation.deviceId ?? null,
        evidenceJson: JSON.stringify(investigation.evidenceJson ?? {}),
        recommendedActionsJson: JSON.stringify(investigation.recommendedActionsJson ?? []),
        unresolvedQuestionsJson: JSON.stringify(investigation.unresolvedQuestionsJson ?? []),
        nextRunAt: investigation.nextRunAt ?? null,
        lastRunAt: investigation.lastRunAt ?? null,
        resolution: investigation.resolution ?? null,
      });
      return investigation;
    });
  }

  listInvestigationSteps(investigationId: string): InvestigationStepRecord[] {
    return this.withDbRecovery("AutonomyStore.listInvestigationSteps", (db) =>
      (db.prepare(`
        SELECT * FROM investigation_steps
        WHERE investigationId = ?
        ORDER BY createdAt ASC
      `).all(investigationId) as Record<string, unknown>[]).map(investigationStepFromRow),
    );
  }

  appendInvestigationStep(step: Omit<InvestigationStepRecord, "id" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  }): InvestigationStepRecord {
    return this.withDbRecovery("AutonomyStore.appendInvestigationStep", (db) => {
      const next: InvestigationStepRecord = {
        id: step.id ?? randomUUID(),
        investigationId: step.investigationId,
        kind: step.kind,
        status: step.status,
        title: step.title,
        detail: step.detail,
        evidenceJson: step.evidenceJson ?? {},
        createdAt: step.createdAt ?? nowIso(),
      };

      db.prepare(`
        INSERT INTO investigation_steps (id, investigationId, kind, status, title, detail, evidenceJson, createdAt)
        VALUES (@id, @investigationId, @kind, @status, @title, @detail, @evidenceJson, @createdAt)
      `).run({
        ...next,
        evidenceJson: JSON.stringify(next.evidenceJson ?? {}),
      });

      return next;
    });
  }

  listGatewayBindings(): GatewayBindingRecord[] {
    return this.withDbRecovery("AutonomyStore.listGatewayBindings", (db) =>
      (db.prepare("SELECT * FROM gateway_bindings ORDER BY enabled DESC, kind ASC, name ASC").all() as Record<string, unknown>[]).map(gatewayBindingFromRow),
    );
  }

  getGatewayBindingById(id: string): GatewayBindingRecord | undefined {
    return this.withDbRecovery("AutonomyStore.getGatewayBindingById", (db) => {
      const row = db.prepare("SELECT * FROM gateway_bindings WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? gatewayBindingFromRow(row) : undefined;
    });
  }

  upsertGatewayBinding(binding: GatewayBindingRecord): GatewayBindingRecord {
    return this.withDbRecovery("AutonomyStore.upsertGatewayBinding", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO gateway_bindings (
          id, kind, name, enabled, target, vaultSecretRef, webhookSecret, defaultThreadTitle, configJson,
          lastInboundAt, lastOutboundAt, createdAt, updatedAt
        )
        VALUES (
          @id, @kind, @name, @enabled, @target, @vaultSecretRef, @webhookSecret, @defaultThreadTitle, @configJson,
          @lastInboundAt, @lastOutboundAt, @createdAt, @updatedAt
        )
      `).run({
        ...binding,
        enabled: binding.enabled ? 1 : 0,
        vaultSecretRef: binding.vaultSecretRef ?? null,
        webhookSecret: binding.webhookSecret ?? null,
        defaultThreadTitle: binding.defaultThreadTitle ?? null,
        configJson: JSON.stringify(binding.configJson ?? {}),
        lastInboundAt: binding.lastInboundAt ?? null,
        lastOutboundAt: binding.lastOutboundAt ?? null,
      });
      return binding;
    });
  }

  deleteGatewayBinding(id: string): void {
    this.withDbRecovery("AutonomyStore.deleteGatewayBinding", (db) => {
      db.prepare("DELETE FROM gateway_bindings WHERE id = ?").run(id);
    });
  }

  touchGatewayBindingActivity(id: string, direction: "inbound" | "outbound", at = nowIso()): void {
    this.withDbRecovery("AutonomyStore.touchGatewayBindingActivity", (db) => {
      if (direction === "inbound") {
        db.prepare("UPDATE gateway_bindings SET lastInboundAt = ?, updatedAt = ? WHERE id = ?").run(at, at, id);
        return;
      }
      db.prepare("UPDATE gateway_bindings SET lastOutboundAt = ?, updatedAt = ? WHERE id = ?").run(at, at, id);
    });
  }

  listGatewayThreads(bindingId?: string): GatewayThreadRecord[] {
    return this.withDbRecovery("AutonomyStore.listGatewayThreads", (db) => {
      if (bindingId) {
        return (db.prepare(`
          SELECT * FROM gateway_threads
          WHERE bindingId = ?
          ORDER BY updatedAt DESC
        `).all(bindingId) as Record<string, unknown>[]).map(gatewayThreadFromRow);
      }
      return (db.prepare("SELECT * FROM gateway_threads ORDER BY updatedAt DESC").all() as Record<string, unknown>[]).map(gatewayThreadFromRow);
    });
  }

  getGatewayThreadByExternalKey(bindingId: string, externalThreadKey: string): GatewayThreadRecord | undefined {
    return this.withDbRecovery("AutonomyStore.getGatewayThreadByExternalKey", (db) => {
      const row = db.prepare(`
        SELECT * FROM gateway_threads
        WHERE bindingId = ? AND externalThreadKey = ?
        LIMIT 1
      `).get(bindingId, externalThreadKey) as Record<string, unknown> | undefined;
      return row ? gatewayThreadFromRow(row) : undefined;
    });
  }

  getOrCreateGatewayThread(input: Omit<GatewayThreadRecord, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
  }): GatewayThreadRecord {
    return this.withDbRecovery("AutonomyStore.getOrCreateGatewayThread", (db) => {
      const existing = db.prepare(`
        SELECT * FROM gateway_threads
        WHERE bindingId = ? AND externalThreadKey = ?
        LIMIT 1
      `).get(input.bindingId, input.externalThreadKey) as Record<string, unknown> | undefined;

      const now = nowIso();
      const next: GatewayThreadRecord = existing
        ? {
            ...gatewayThreadFromRow(existing),
            title: input.title,
            missionId: input.missionId,
            subagentId: input.subagentId,
            chatSessionId: input.chatSessionId,
            lastInboundAt: input.lastInboundAt ?? gatewayThreadFromRow(existing).lastInboundAt,
            lastOutboundAt: input.lastOutboundAt ?? gatewayThreadFromRow(existing).lastOutboundAt,
            updatedAt: now,
          }
        : {
            id: input.id ?? randomUUID(),
            bindingId: input.bindingId,
            externalThreadKey: input.externalThreadKey,
            title: input.title,
            missionId: input.missionId,
            subagentId: input.subagentId,
            chatSessionId: input.chatSessionId,
            lastInboundAt: input.lastInboundAt,
            lastOutboundAt: input.lastOutboundAt,
            createdAt: now,
            updatedAt: now,
          };

      db.prepare(`
        INSERT OR REPLACE INTO gateway_threads (
          id, bindingId, externalThreadKey, title, missionId, subagentId, chatSessionId,
          lastInboundAt, lastOutboundAt, createdAt, updatedAt
        )
        VALUES (
          @id, @bindingId, @externalThreadKey, @title, @missionId, @subagentId, @chatSessionId,
          @lastInboundAt, @lastOutboundAt, @createdAt, @updatedAt
        )
      `).run({
        ...next,
        missionId: next.missionId ?? null,
        subagentId: next.subagentId ?? null,
        chatSessionId: next.chatSessionId ?? null,
        lastInboundAt: next.lastInboundAt ?? null,
        lastOutboundAt: next.lastOutboundAt ?? null,
      });

      return next;
    });
  }

  getGatewayInboundEvent(bindingId: string, externalUpdateId: string): GatewayInboundEventRecord | undefined {
    return this.withDbRecovery("AutonomyStore.getGatewayInboundEvent", (db) => {
      const row = db.prepare(`
        SELECT * FROM gateway_inbound_events
        WHERE bindingId = ? AND externalUpdateId = ?
        LIMIT 1
      `).get(bindingId, externalUpdateId) as Record<string, unknown> | undefined;
      return row ? gatewayInboundEventFromRow(row) : undefined;
    });
  }

  recordGatewayInboundEvent(input: Omit<GatewayInboundEventRecord, "id"> & { id?: string }): GatewayInboundEventRecord {
    return this.withDbRecovery("AutonomyStore.recordGatewayInboundEvent", (db) => {
      const existing = db.prepare(`
        SELECT * FROM gateway_inbound_events
        WHERE bindingId = ? AND externalUpdateId = ?
        LIMIT 1
      `).get(input.bindingId, input.externalUpdateId) as Record<string, unknown> | undefined;
      const next: GatewayInboundEventRecord = existing
        ? gatewayInboundEventFromRow(existing)
        : {
            id: input.id ?? randomUUID(),
            bindingId: input.bindingId,
            externalUpdateId: input.externalUpdateId,
            threadId: input.threadId,
            receivedAt: input.receivedAt,
          };
      db.prepare(`
        INSERT OR IGNORE INTO gateway_inbound_events (id, bindingId, externalUpdateId, threadId, receivedAt)
        VALUES (@id, @bindingId, @externalUpdateId, @threadId, @receivedAt)
      `).run({
        ...next,
        threadId: next.threadId ?? null,
      });
      return existing ? gatewayInboundEventFromRow(existing) : next;
    });
  }

  touchGatewayThreadActivity(id: string, direction: "inbound" | "outbound", at = nowIso()): GatewayThreadRecord | undefined {
    return this.withDbRecovery("AutonomyStore.touchGatewayThreadActivity", (db) => {
      if (direction === "inbound") {
        db.prepare("UPDATE gateway_threads SET lastInboundAt = ?, updatedAt = ? WHERE id = ?").run(at, at, id);
      } else {
        db.prepare("UPDATE gateway_threads SET lastOutboundAt = ?, updatedAt = ? WHERE id = ?").run(at, at, id);
      }
      const row = db.prepare("SELECT * FROM gateway_threads WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? gatewayThreadFromRow(row) : undefined;
    });
  }

  listBriefings(filter?: {
    delivered?: boolean;
    bindingId?: string;
    missionId?: string;
    subagentId?: string;
  }): BriefingRecord[] {
    return this.withDbRecovery("AutonomyStore.listBriefings", (db) => {
      const params: Record<string, unknown> = {};
      const conditions: string[] = [];

      if (typeof filter?.delivered === "boolean") {
        conditions.push("delivered = @delivered");
        params.delivered = filter.delivered ? 1 : 0;
      }
      if (filter?.bindingId) {
        conditions.push("bindingId = @bindingId");
        params.bindingId = filter.bindingId;
      }
      if (filter?.missionId) {
        conditions.push("missionId = @missionId");
        params.missionId = filter.missionId;
      }
      if (filter?.subagentId) {
        conditions.push("subagentId = @subagentId");
        params.subagentId = filter.subagentId;
      }

      let query = "SELECT * FROM briefings";
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY createdAt DESC";

      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(briefingFromRow);
    });
  }

  getBriefingById(id: string): BriefingRecord | undefined {
    return this.withDbRecovery("AutonomyStore.getBriefingById", (db) => {
      const row = db.prepare("SELECT * FROM briefings WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? briefingFromRow(row) : undefined;
    });
  }

  createBriefing(briefing: BriefingRecord): BriefingRecord {
    return this.withDbRecovery("AutonomyStore.createBriefing", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO briefings (
          id, scope, subagentId, missionId, bindingId, title, body, format, delivered, deliveredAt, metadataJson, createdAt
        )
        VALUES (
          @id, @scope, @subagentId, @missionId, @bindingId, @title, @body, @format, @delivered, @deliveredAt, @metadataJson, @createdAt
        )
      `).run({
        ...briefing,
        subagentId: briefing.subagentId ?? null,
        missionId: briefing.missionId ?? null,
        bindingId: briefing.bindingId ?? null,
        delivered: briefing.delivered ? 1 : 0,
        deliveredAt: briefing.deliveredAt ?? null,
        metadataJson: JSON.stringify(briefing.metadataJson ?? {}),
      });
      return briefing;
    });
  }

  markBriefingDelivered(id: string, deliveredAt = nowIso()): BriefingRecord | undefined {
    return this.withDbRecovery("AutonomyStore.markBriefingDelivered", (db) => {
      db.prepare(`
        UPDATE briefings
        SET delivered = 1, deliveredAt = ?
        WHERE id = ?
      `).run(deliveredAt, id);
      const row = db.prepare("SELECT * FROM briefings WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? briefingFromRow(row) : undefined;
    });
  }

  getMissionWithDetails(id: string): MissionWithDetails | undefined {
    const mission = this.getMissionById(id);
    if (!mission) {
      return undefined;
    }

    const subagent = mission.subagentId ? this.getSubagentById(mission.subagentId) : undefined;
    const links = this.listMissionLinks(mission.id);
    const latestRun = this.getLatestMissionRun(mission.id);
    const openInvestigations = this.listInvestigations({
      missionId: mission.id,
      status: ["open", "monitoring"],
    });

    return {
      ...mission,
      subagent,
      links,
      latestRun,
      openInvestigations,
      plan: undefined,
      delegations: [],
    };
  }
}

export const autonomyStore = new AutonomyStore();
