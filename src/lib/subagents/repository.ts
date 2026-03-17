import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { autonomyStore } from "@/lib/autonomy/store";
import type {
  StandingOrderRecord,
  SubagentMemoryRecord,
  SubagentRecord,
  SubagentWithMetrics,
} from "@/lib/autonomy/types";
import { missionRepository } from "@/lib/missions/repository";
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

function subagentMemoryFromRow(row: Record<string, unknown>): SubagentMemoryRecord {
  return {
    id: String(row.id),
    subagentId: String(row.subagentId),
    missionId: parseOptionalString(row.missionId),
    deviceId: parseOptionalString(row.deviceId),
    kind: String(row.kind) as SubagentMemoryRecord["kind"],
    summary: String(row.summary),
    detail: String(row.detail ?? ""),
    importance: String(row.importance) as SubagentMemoryRecord["importance"],
    evidenceJson: parseJsonRecord(row.evidenceJson),
    lastUsedAt: parseOptionalString(row.lastUsedAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function standingOrderFromRow(row: Record<string, unknown>): StandingOrderRecord {
  return {
    id: String(row.id),
    subagentId: String(row.subagentId),
    title: String(row.title),
    objective: String(row.objective ?? ""),
    instructions: parseStringArray(row.instructionsJson),
    enabled: Boolean(row.enabled),
    scopeJson: parseJsonRecord(row.scopeJson),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

class SubagentRepository {
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

  list(): SubagentRecord[] {
    return autonomyStore.listSubagents();
  }

  getById(id: string): SubagentRecord | undefined {
    return autonomyStore.getSubagentById(id);
  }

  upsert(subagent: SubagentRecord): SubagentRecord {
    return autonomyStore.upsertSubagent(subagent);
  }

  listWithMetrics(): SubagentWithMetrics[] {
    const base = autonomyStore.listSubagentsWithMetrics();
    return base.map((subagent) => ({
      ...subagent,
      memoryCount: this.listMemories(subagent.id, 250).length,
      standingOrderCount: this.listStandingOrders(subagent.id).length,
      delegationCount: missionRepository.listDelegationsForSubagent(subagent.id)
        .filter((delegation) => delegation.status === "open" || delegation.status === "accepted").length,
    }));
  }

  listMemories(subagentId: string, limit = 50): SubagentMemoryRecord[] {
    return this.withDbRecovery("SubagentRepository.listMemories", (db) =>
      (db.prepare(`
        SELECT * FROM subagent_memories
        WHERE subagentId = ?
        ORDER BY COALESCE(lastUsedAt, updatedAt) DESC
        LIMIT ?
      `).all(subagentId, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[]).map(subagentMemoryFromRow),
    );
  }

  recordMemory(
    input: Omit<SubagentMemoryRecord, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): SubagentMemoryRecord {
    return this.withDbRecovery("SubagentRepository.recordMemory", (db) => {
      const now = nowIso();
      const existing = db.prepare(`
        SELECT * FROM subagent_memories
        WHERE subagentId = ? AND kind = ? AND summary = ? AND COALESCE(missionId, '') = COALESCE(?, '')
        LIMIT 1
      `).get(input.subagentId, input.kind, input.summary, input.missionId ?? null) as Record<string, unknown> | undefined;
      const next: SubagentMemoryRecord = existing
        ? {
            ...subagentMemoryFromRow(existing),
            detail: input.detail,
            importance: input.importance,
            deviceId: input.deviceId,
            evidenceJson: input.evidenceJson,
            lastUsedAt: input.lastUsedAt ?? now,
            updatedAt: now,
          }
        : {
            id: input.id ?? randomUUID(),
            subagentId: input.subagentId,
            missionId: input.missionId,
            deviceId: input.deviceId,
            kind: input.kind,
            summary: input.summary,
            detail: input.detail,
            importance: input.importance,
            evidenceJson: input.evidenceJson,
            lastUsedAt: input.lastUsedAt,
            createdAt: now,
            updatedAt: now,
          };
      db.prepare(`
        INSERT OR REPLACE INTO subagent_memories (
          id, subagentId, missionId, deviceId, kind, summary, detail, importance, evidenceJson, lastUsedAt, createdAt, updatedAt
        )
        VALUES (
          @id, @subagentId, @missionId, @deviceId, @kind, @summary, @detail, @importance, @evidenceJson, @lastUsedAt, @createdAt, @updatedAt
        )
      `).run({
        ...next,
        missionId: next.missionId ?? null,
        deviceId: next.deviceId ?? null,
        evidenceJson: JSON.stringify(next.evidenceJson ?? {}),
        lastUsedAt: next.lastUsedAt ?? null,
      });
      return next;
    });
  }

  listStandingOrders(subagentId: string): StandingOrderRecord[] {
    return this.withDbRecovery("SubagentRepository.listStandingOrders", (db) =>
      (db.prepare(`
        SELECT * FROM standing_orders
        WHERE subagentId = ?
        ORDER BY enabled DESC, updatedAt DESC
      `).all(subagentId) as Record<string, unknown>[]).map(standingOrderFromRow),
    );
  }

  upsertStandingOrder(
    input: Omit<StandingOrderRecord, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): StandingOrderRecord {
    return this.withDbRecovery("SubagentRepository.upsertStandingOrder", (db) => {
      const now = nowIso();
      const existing = input.id
        ? db.prepare("SELECT * FROM standing_orders WHERE id = ? LIMIT 1").get(input.id) as Record<string, unknown> | undefined
        : undefined;
      const next: StandingOrderRecord = existing
        ? {
            ...standingOrderFromRow(existing),
            title: input.title,
            objective: input.objective,
            instructions: input.instructions,
            enabled: input.enabled,
            scopeJson: input.scopeJson,
            updatedAt: now,
          }
        : {
            id: input.id ?? randomUUID(),
            subagentId: input.subagentId,
            title: input.title,
            objective: input.objective,
            instructions: input.instructions,
            enabled: input.enabled,
            scopeJson: input.scopeJson,
            createdAt: now,
            updatedAt: now,
          };
      db.prepare(`
        INSERT OR REPLACE INTO standing_orders (
          id, subagentId, title, objective, instructionsJson, enabled, scopeJson, createdAt, updatedAt
        )
        VALUES (
          @id, @subagentId, @title, @objective, @instructionsJson, @enabled, @scopeJson, @createdAt, @updatedAt
        )
      `).run({
        ...next,
        instructionsJson: JSON.stringify(next.instructions ?? []),
        enabled: next.enabled ? 1 : 0,
        scopeJson: JSON.stringify(next.scopeJson ?? {}),
      });
      return next;
    });
  }

  deleteStandingOrder(id: string): boolean {
    return this.withDbRecovery("SubagentRepository.deleteStandingOrder", (db) => {
      const result = db.prepare("DELETE FROM standing_orders WHERE id = ?").run(id);
      return Number(result.changes ?? 0) > 0;
    });
  }
}

export const subagentRepository = new SubagentRepository();
