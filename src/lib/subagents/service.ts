import type { MissionRecord } from "@/lib/autonomy/types";
import { missionRepository } from "@/lib/missions/repository";
import { subagentRepository } from "@/lib/subagents/repository";

export function recordMissionRunMemory(args: {
  mission: MissionRecord;
  summary: string;
  outcomeJson: Record<string, unknown>;
}): void {
  if (!args.mission.subagentId) {
    return;
  }
  subagentRepository.recordMemory({
    subagentId: args.mission.subagentId,
    missionId: args.mission.id,
    deviceId: missionRepository.getPrimaryDeviceId(args.mission.id),
    kind: "mission-run",
    summary: `${args.mission.title}: ${args.summary}`,
    detail: JSON.stringify(args.outcomeJson),
    importance: args.mission.priority === "high" ? "high" : args.mission.priority === "low" ? "low" : "medium",
    evidenceJson: args.outcomeJson,
    lastUsedAt: new Date().toISOString(),
  });
}

export function standingOrderInstructionsForMission(missionId: string): string[] {
  const mission = missionRepository.getById(missionId);
  if (!mission?.subagentId) {
    return [];
  }
  const orders = subagentRepository.listStandingOrders(mission.subagentId)
    .filter((order) => order.enabled);
  if (orders.length === 0) {
    return [];
  }

  return orders.flatMap((order) => order.instructions.map((instruction) => `${order.title}: ${instruction}`));
}
