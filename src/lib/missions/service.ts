import { randomUUID } from "node:crypto";
import { autonomyStore } from "@/lib/autonomy/store";
import type { MissionRecord, MissionWithDetails } from "@/lib/autonomy/types";
import { missionRepository } from "@/lib/missions/repository";
import { missionSelectorDeviceIds } from "@/lib/missions/scope";
import { stateStore } from "@/lib/state/store";

function nowIso(): string {
  return new Date().toISOString();
}

function keywordMatch(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function delegationTargetsForMission(mission: MissionRecord, evidenceText: string): string[] {
  const next = new Set<string>();
  const normalized = `${mission.kind} ${mission.title} ${mission.summary} ${evidenceText}`;

  if (mission.kind !== "wan-guardian" && keywordMatch(normalized, [/wan|network|latency|uplink|packet|firewall|router/i])) {
    next.add("subagent.network-operator");
  }
  if (mission.kind !== "certificate-guardian" && keywordMatch(normalized, [/tls|ssl|certificate|acme|expiry|renew/i])) {
    next.add("subagent.certificate-operator");
  }
  if (mission.kind !== "backup-guardian" && keywordMatch(normalized, [/backup|restore|snapshot|replication/i])) {
    next.add("subagent.backup-operator");
  }
  if (mission.kind !== "storage-guardian" && keywordMatch(normalized, [/disk|storage|raid|volume|capacity|smart/i])) {
    next.add("subagent.storage-operator");
  }
  if (mission.kind !== "availability-guardian" && keywordMatch(normalized, [/offline|unreachable|outage|availability|health/i])) {
    next.add("subagent.availability-operator");
  }

  if (mission.subagentId) {
    next.delete(mission.subagentId);
  }

  return Array.from(next);
}

export function buildMissionPromptContext(missionId?: string): string {
  if (!missionId) {
    return "";
  }
  const mission = missionRepository.getWithDetails(missionId);
  if (!mission) {
    return "";
  }

  const primaryDeviceId = missionRepository.getPrimaryDeviceId(missionId);
  const device = primaryDeviceId ? stateStore.getDeviceById(primaryDeviceId) : null;
  const plan = mission.plan;
  const openInvestigations = mission.openInvestigations.slice(0, 4).map((investigation) =>
    `- ${investigation.title}: ${investigation.stage}, ${investigation.status}, ${investigation.summary}`,
  );
  const delegationLines = mission.delegations
    .filter((delegation) => delegation.status === "open" || delegation.status === "accepted")
    .slice(0, 4)
    .map((delegation) =>
      `- ${autonomyStore.getSubagentById(delegation.toSubagentId)?.name ?? delegation.toSubagentId}: ${delegation.title}`,
    );

  return [
    "Mission thread context:",
    `- Mission: ${mission.title} (${mission.kind})`,
    `- Objective: ${mission.objective || mission.summary || "Own this responsibility over time."}`,
    `- Priority: ${mission.priority}; status: ${mission.status}; last status: ${mission.lastStatus ?? "idle"}`,
    device ? `- Primary device: ${device.name} (${device.ip}) id=${device.id} type=${device.type}` : undefined,
    plan?.summary ? `- Current plan: ${plan.summary}` : undefined,
    plan?.checkpointsJson?.length ? `- Plan checkpoints: ${plan.checkpointsJson.join(" | ")}` : undefined,
    openInvestigations.length > 0 ? "Open investigations:\n" + openInvestigations.join("\n") : undefined,
    delegationLines.length > 0 ? "Cross-mission delegations:\n" + delegationLines.join("\n") : undefined,
    "Keep this mission's ownership and thread history in mind when the user is ambiguous.",
  ].filter(Boolean).join("\n");
}

export function syncMissionDeviceScopeLinks(mission: MissionRecord): void {
  const desiredDeviceIds = new Set(missionSelectorDeviceIds(mission));
  const currentLinks = (autonomyStore.listMissionLinks?.(mission.id) ?? []).filter((link) => link.resourceType === "device");
  const currentDeviceIds = new Set(currentLinks.map((link) => link.resourceId));

  for (const deviceId of desiredDeviceIds) {
    if (!currentDeviceIds.has(deviceId)) {
      autonomyStore.linkMissionResource({
        missionId: mission.id,
        resourceType: "device",
        resourceId: deviceId,
        metadataJson: {
          source: "mission-selector",
        },
      });
    }
  }

  for (const link of currentLinks) {
    if (!desiredDeviceIds.has(link.resourceId) && link.metadataJson.source === "mission-selector") {
      autonomyStore.unlinkMissionResource(mission.id, "device", link.resourceId);
    }
  }
}

export function syncMissionCoordination(args: {
  mission: MissionRecord;
  outcomeSummary: string;
  outcomeJson: Record<string, unknown>;
}): void {
  const mission: MissionWithDetails = missionRepository.getWithDetails(args.mission.id) ?? {
    ...args.mission,
    links: [],
    delegations: [],
    openInvestigations: [],
    plan: undefined,
  };
  const now = nowIso();
  const evidenceText = JSON.stringify(args.outcomeJson);
  const targetSubagentIds = delegationTargetsForMission(args.mission, `${args.outcomeSummary} ${evidenceText}`);
  const delegationIds: string[] = [];

  for (const subagentId of targetSubagentIds) {
    const subagent = autonomyStore.getSubagentById(subagentId);
    if (!subagent) {
      continue;
    }
    const delegation = missionRepository.upsertDelegation({
      missionId: args.mission.id,
      fromSubagentId: args.mission.subagentId,
      toSubagentId: subagentId,
      title: `Review ${args.mission.title}`,
      status: "open",
      reason: `Mission evidence suggests ${subagent.name.toLowerCase()} follow-up is warranted.`,
      payloadJson: {
        missionKind: args.mission.kind,
        missionSummary: args.outcomeSummary,
      },
    });
    delegationIds.push(delegation.id);
  }

  const checkpoints = [
    args.outcomeSummary,
    ...mission.openInvestigations.slice(0, 3).map((investigation) =>
      `${investigation.title}: ${investigation.stage}`,
    ),
    ...mission.delegations
      .filter((delegation) => delegation.status === "open" || delegation.status === "accepted")
      .slice(0, 3)
      .map((delegation) => `${delegation.title} -> ${delegation.toSubagentId}`),
  ].filter((value, index, items) => value.length > 0 && items.indexOf(value) === index);

  missionRepository.upsertPlan({
    id: mission.plan?.id ?? `mission-plan:${args.mission.id}`,
    missionId: args.mission.id,
    summary: args.outcomeSummary,
    status: delegationIds.length > 0 ? "blocked" : mission.openInvestigations.length > 0 ? "active" : "completed",
    checkpointsJson: checkpoints,
    delegationIdsJson: delegationIds.length > 0 ? delegationIds : mission.plan?.delegationIdsJson ?? [],
    createdAt: mission.plan?.createdAt ?? now,
    updatedAt: now,
  });
}

export function createMissionThreadChatSession(input: {
  title: string;
  missionId?: string;
  subagentId?: string;
  gatewayThreadId?: string;
  provider?: string;
  model?: string;
}): string {
  const now = nowIso();
  const missionId = input.missionId;
  const subagentId = input.subagentId ?? (missionId ? missionRepository.getById(missionId)?.subagentId : undefined);
  const deviceId = missionId ? missionRepository.getPrimaryDeviceId(missionId) : undefined;
  const id = randomUUID();
  stateStore.createChatSession({
    id,
    title: input.title,
    deviceId,
    missionId,
    subagentId,
    gatewayThreadId: input.gatewayThreadId,
    provider: input.provider,
    model: input.model,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
