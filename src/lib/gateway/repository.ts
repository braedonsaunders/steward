import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { autonomyStore } from "@/lib/autonomy/store";
import type {
  ChannelDeliveryRecord,
  GatewayBindingRecord,
  GatewayThreadRecord,
} from "@/lib/autonomy/types";
import { getDb, recoverCorruptDatabase } from "@/lib/state/db";

function nowIso(): string {
  return new Date().toISOString();
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function channelDeliveryFromRow(row: Record<string, unknown>): ChannelDeliveryRecord {
  return {
    id: String(row.id),
    bindingId: String(row.bindingId),
    threadId: parseOptionalString(row.threadId),
    missionId: parseOptionalString(row.missionId),
    briefingId: parseOptionalString(row.briefingId),
    status: String(row.status) as ChannelDeliveryRecord["status"],
    textPreview: String(row.textPreview ?? ""),
    requestedAt: String(row.requestedAt),
    deliveredAt: parseOptionalString(row.deliveredAt),
    error: parseOptionalString(row.error),
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

class GatewayRepository {
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

  listBindings(): GatewayBindingRecord[] {
    return autonomyStore.listGatewayBindings();
  }

  getBindingById(id: string): GatewayBindingRecord | undefined {
    return autonomyStore.getGatewayBindingById(id);
  }

  upsertBinding(binding: GatewayBindingRecord): GatewayBindingRecord {
    return autonomyStore.upsertGatewayBinding(binding);
  }

  listThreads(bindingId?: string): GatewayThreadRecord[] {
    return autonomyStore.listGatewayThreads(bindingId);
  }

  getThreadById(id: string): GatewayThreadRecord | undefined {
    return this.withDbRecovery("GatewayRepository.getThreadById", (db) => {
      const row = db.prepare("SELECT * FROM gateway_threads WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? gatewayThreadFromRow(row) : undefined;
    });
  }

  getThreadByExternalKey(bindingId: string, externalThreadKey: string): GatewayThreadRecord | undefined {
    return autonomyStore.getGatewayThreadByExternalKey(bindingId, externalThreadKey);
  }

  upsertThread(thread: GatewayThreadRecord): GatewayThreadRecord {
    return this.withDbRecovery("GatewayRepository.upsertThread", (db) => {
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
        ...thread,
        missionId: thread.missionId ?? null,
        subagentId: thread.subagentId ?? null,
        chatSessionId: thread.chatSessionId ?? null,
        lastInboundAt: thread.lastInboundAt ?? null,
        lastOutboundAt: thread.lastOutboundAt ?? null,
      });
      return thread;
    });
  }

  recordDelivery(
    input: Omit<ChannelDeliveryRecord, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): ChannelDeliveryRecord {
    return this.withDbRecovery("GatewayRepository.recordDelivery", (db) => {
      const now = nowIso();
      const existing = input.id
        ? db.prepare("SELECT * FROM channel_delivery_events WHERE id = ? LIMIT 1").get(input.id) as Record<string, unknown> | undefined
        : undefined;
      const next: ChannelDeliveryRecord = existing
        ? {
            ...channelDeliveryFromRow(existing),
            status: input.status,
            textPreview: input.textPreview,
            deliveredAt: input.deliveredAt,
            error: input.error,
            updatedAt: now,
          }
        : {
            id: input.id ?? randomUUID(),
            bindingId: input.bindingId,
            threadId: input.threadId,
            missionId: input.missionId,
            briefingId: input.briefingId,
            status: input.status,
            textPreview: input.textPreview,
            requestedAt: input.requestedAt,
            deliveredAt: input.deliveredAt,
            error: input.error,
            createdAt: now,
            updatedAt: now,
          };
      db.prepare(`
        INSERT OR REPLACE INTO channel_delivery_events (
          id, bindingId, threadId, missionId, briefingId, status, textPreview, requestedAt,
          deliveredAt, error, createdAt, updatedAt
        )
        VALUES (
          @id, @bindingId, @threadId, @missionId, @briefingId, @status, @textPreview, @requestedAt,
          @deliveredAt, @error, @createdAt, @updatedAt
        )
      `).run({
        ...next,
        threadId: next.threadId ?? null,
        missionId: next.missionId ?? null,
        briefingId: next.briefingId ?? null,
        deliveredAt: next.deliveredAt ?? null,
        error: next.error ?? null,
      });
      return next;
    });
  }

  listDeliveries(filter?: {
    bindingId?: string;
    missionId?: string;
    status?: ChannelDeliveryRecord["status"];
  }): ChannelDeliveryRecord[] {
    return this.withDbRecovery("GatewayRepository.listDeliveries", (db) => {
      const params: Record<string, unknown> = {};
      const conditions: string[] = [];
      if (filter?.bindingId) {
        conditions.push("bindingId = @bindingId");
        params.bindingId = filter.bindingId;
      }
      if (filter?.missionId) {
        conditions.push("missionId = @missionId");
        params.missionId = filter.missionId;
      }
      if (filter?.status) {
        conditions.push("status = @status");
        params.status = filter.status;
      }
      let query = "SELECT * FROM channel_delivery_events";
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY requestedAt DESC LIMIT 100";
      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(channelDeliveryFromRow);
    });
  }
}

export const gatewayRepository = new GatewayRepository();
