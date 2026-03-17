import { randomUUID } from "node:crypto";
import { autonomyStore } from "@/lib/autonomy/store";
import type { InvestigationRecord } from "@/lib/autonomy/types";

class InvestigationRepository {
  list(filter?: Parameters<typeof autonomyStore.listInvestigations>[0]): InvestigationRecord[] {
    return autonomyStore.listInvestigations(filter);
  }

  getById(id: string): InvestigationRecord | undefined {
    return autonomyStore.getInvestigationById(id);
  }

  listSteps(investigationId: string) {
    return autonomyStore.listInvestigationSteps(investigationId);
  }

  upsert(investigation: InvestigationRecord): InvestigationRecord {
    return autonomyStore.upsertInvestigation(investigation);
  }

  spawnChild(input: Omit<InvestigationRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): InvestigationRecord {
    const now = new Date().toISOString();
    const next: InvestigationRecord = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    return autonomyStore.upsertInvestigation(next);
  }
}

export const investigationRepository = new InvestigationRepository();
