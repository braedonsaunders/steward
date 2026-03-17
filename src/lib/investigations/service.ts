import { investigationRepository } from "@/lib/investigations/repository";

export function ensureChildInvestigation(input: {
  parentInvestigationId: string;
  title: string;
  summary: string;
  missionId?: string;
  subagentId?: string;
  deviceId?: string;
  sourceType?: string;
  sourceId?: string;
  recommendedActionsJson?: string[];
}): string {
  const existing = investigationRepository.list({
    missionId: input.missionId,
    deviceId: input.deviceId,
    status: ["open", "monitoring"],
  }).find((investigation) =>
    investigation.parentInvestigationId === input.parentInvestigationId
    && investigation.title === input.title,
  );
  if (existing) {
    return existing.id;
  }

  return investigationRepository.spawnChild({
    missionId: input.missionId,
    subagentId: input.subagentId,
    parentInvestigationId: input.parentInvestigationId,
    title: input.title,
    status: "open",
    severity: "warning",
    stage: "detect",
    objective: input.summary,
    summary: input.summary,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    deviceId: input.deviceId,
    evidenceJson: {},
    recommendedActionsJson: input.recommendedActionsJson ?? [],
    unresolvedQuestionsJson: [],
    resolution: undefined,
    nextRunAt: new Date().toISOString(),
    lastRunAt: undefined,
    hypothesis: undefined,
  }).id;
}
