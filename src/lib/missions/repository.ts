import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { autonomyStore } from "@/lib/autonomy/store";
import type {
  MissionDelegationRecord,
  MissionPlanRecord,
  MissionRecord,
  MissionWithDetails,
} from "@/lib/autonomy/types";
import { getDb, recoverCorruptDatabase } from "@/lib/state/db";

function nowIso(): string {
  return new Date().toISOString();
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function missionDelegationFromRow(row: Record<string, unknown>): MissionDelegationRecord {
  return {
    id: String(row.id),
    missionId: String(row.missionId),
    fromSubagentId: parseOptionalString(row.fromSubagentId),
    toSubagentId: String(row.toSubagentId),
    title: String(row.title),
    status: String(row.status) as MissionDelegationRecord["status"],
    reason: String(row.reason ?? ""),
    payloadJson: parseJsonRecord(row.payloadJson),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function missionPlanFromRow(row: Record<string, unknown>): MissionPlanRecord {
  return {
    id: String(row.id),
    missionId: String(row.missionId),
    summary: String(row.summary ?? ""),
    status: String(row.status) as MissionPlanRecord["status"],
    checkpointsJson: parseStringArray(row.checkpointsJson),
    delegationIdsJson: parseStringArray(row.delegationIdsJson),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

class MissionRepository {
  private withDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
    const run = () => operation(getDb());

    try {
      return run();
    } catch (error) {
      if (!recoverCorruptDatabase(error, context)) {
        throw error;
      }
      return run();
    }
  }

  list(): MissionRecord[] {
    return autonomyStore.listMissions();
  }

  listDue(referenceIso: string): MissionRecord[] {
    return autonomyStore.getDueMissions(referenceIso);
  }

  getById(id: string): MissionRecord | undefined {
    return autonomyStore.getMissionById(id);
  }

  upsert(mission: MissionRecord): MissionRecord {
    return autonomyStore.upsertMission(mission);
  }

  listDelegations(missionId: string): MissionDelegationRecord[] {
    return this.withDbRecovery("MissionRepository.listDelegations", (db) =>
      (db.prepare(`
        SELECT * FROM mission_delegations
        WHERE missionId = ?
        ORDER BY updatedAt DESC
      `).all(missionId) as Record<string, unknown>[]).map(missionDelegationFromRow),
    );
  }

  listDelegationsForSubagent(subagentId: string): MissionDelegationRecord[] {
    return this.withDbRecovery("MissionRepository.listDelegationsForSubagent", (db) =>
      (db.prepare(`
        SELECT * FROM mission_delegations
        WHERE toSubagentId = ?
        ORDER BY updatedAt DESC
      `).all(subagentId) as Record<string, unknown>[]).map(missionDelegationFromRow),
    );
  }

  getPlanByMissionId(missionId: string): MissionPlanRecord | undefined {
    return this.withDbRecovery("MissionRepository.getPlanByMissionId", (db) => {
      const row = db.prepare(`
        SELECT * FROM mission_plans
        WHERE missionId = ?
        LIMIT 1
      `).get(missionId) as Record<string, unknown> | undefined;
      return row ? missionPlanFromRow(row) : undefined;
    });
  }

  upsertPlan(plan: MissionPlanRecord): MissionPlanRecord {
    return this.withDbRecovery("MissionRepository.upsertPlan", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO mission_plans (
          id, missionId, summary, status, checkpointsJson, delegationIdsJson, createdAt, updatedAt
        )
        VALUES (
          @id, @missionId, @summary, @status, @checkpointsJson, @delegationIdsJson, @createdAt, @updatedAt
        )
      `).run({
        ...plan,
        checkpointsJson: JSON.stringify(plan.checkpointsJson ?? []),
        delegationIdsJson: JSON.stringify(plan.delegationIdsJson ?? []),
      });
      return plan;
    });
  }

  upsertDelegation(
    input: Omit<MissionDelegationRecord, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): MissionDelegationRecord {
    return this.withDbRecovery("MissionRepository.upsertDelegation", (db) => {
      const existing = db.prepare(`
        SELECT * FROM mission_delegations
        WHERE missionId = ? AND toSubagentId = ? AND title = ?
        LIMIT 1
      `).get(input.missionId, input.toSubagentId, input.title) as Record<string, unknown> | undefined;
      const now = nowIso();
      const next: MissionDelegationRecord = existing
        ? {
            ...missionDelegationFromRow(existing),
            fromSubagentId: input.fromSubagentId,
            status: input.status,
            reason: input.reason,
            payloadJson: input.payloadJson,
            updatedAt: now,
          }
        : {
            id: input.id ?? randomUUID(),
            missionId: input.missionId,
            fromSubagentId: input.fromSubagentId,
            toSubagentId: input.toSubagentId,
            title: input.title,
            status: input.status,
            reason: input.reason,
            payloadJson: input.payloadJson,
            createdAt: now,
            updatedAt: now,
          };
      db.prepare(`
        INSERT OR REPLACE INTO mission_delegations (
          id, missionId, fromSubagentId, toSubagentId, title, status, reason, payloadJson, createdAt, updatedAt
        )
        VALUES (
          @id, @missionId, @fromSubagentId, @toSubagentId, @title, @status, @reason, @payloadJson, @createdAt, @updatedAt
        )
      `).run({
        ...next,
        fromSubagentId: next.fromSubagentId ?? null,
        payloadJson: JSON.stringify(next.payloadJson ?? {}),
      });
      return next;
    });
  }

  getPrimaryDeviceId(missionId: string): string | undefined {
    const deviceLink = autonomyStore.listMissionLinks(missionId).find((link) => link.resourceType === "device");
    if (deviceLink) {
      return deviceLink.resourceId;
    }

    const investigationDevice = autonomyStore.listInvestigations({
      missionId,
      status: ["open", "monitoring"],
    }).find((investigation) => investigation.deviceId)?.deviceId;
    return investigationDevice;
  }

  getWithDetails(id: string): MissionWithDetails | undefined {
    const mission = autonomyStore.getMissionWithDetails(id);
    if (!mission) {
      return undefined;
    }
    return {
      ...mission,
      plan: this.getPlanByMissionId(id),
      delegations: this.listDelegations(id),
    };
  }
}

export const missionRepository = new MissionRepository();
