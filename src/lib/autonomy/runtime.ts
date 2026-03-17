import { randomUUID } from "node:crypto";
import { buildGlobalBriefing } from "@/lib/autonomy/briefings";
import { sendGatewayMessage } from "@/lib/autonomy/gateway";
import { autonomyStore } from "@/lib/autonomy/store";
import type { InvestigationRecord, MissionRecord } from "@/lib/autonomy/types";
import { gatewayRepository } from "@/lib/gateway/repository";
import { ensureChildInvestigation } from "@/lib/investigations/service";
import { missionMatchesDeviceSelector } from "@/lib/missions/scope";
import { syncMissionCoordination } from "@/lib/missions/service";
import { stateStore } from "@/lib/state/store";
import type { Device, DeviceFinding, Incident, Recommendation, Workload } from "@/lib/state/types";
import { recordMissionRunMemory, standingOrderInstructionsForMission } from "@/lib/subagents/service";

export const MISSION_JOB_KIND = "mission.tick";
export const INVESTIGATION_JOB_KIND = "investigation.step";
export const BRIEFING_JOB_KIND = "briefing.compile";
export const APPROVAL_FOLLOWUP_JOB_KIND = "approval.followup";
export const CHANNEL_DELIVERY_JOB_KIND = "channel.delivery";
export const AUTONOMY_JOB_KINDS = [MISSION_JOB_KIND, INVESTIGATION_JOB_KIND, BRIEFING_JOB_KIND, APPROVAL_FOLLOWUP_JOB_KIND, CHANNEL_DELIVERY_JOB_KIND] as const;

const AVAILABILITY_OFFLINE_INCIDENT_TYPE = "availability.offline";

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutes(baseIso: string, minutes: number): string {
  return new Date(new Date(baseIso).getTime() + minutes * 60_000).toISOString();
}

function incidentType(incident: Incident): string | undefined {
  return typeof incident.metadata.incidentType === "string"
    ? incident.metadata.incidentType
    : undefined;
}

function dedupeKeyForMissionRun(mission: MissionRecord, runAt: string): string {
  return `${MISSION_JOB_KIND}:${mission.id}:${runAt.slice(0, 16)}`;
}

function dedupeKeyForInvestigation(investigationId: string, runAt: string): string {
  return `${INVESTIGATION_JOB_KIND}:${investigationId}:${runAt.slice(0, 16)}`;
}

function dedupeKeyForBriefing(input: {
  missionId?: string;
  subagentId?: string;
  bindingId?: string;
  requestedAt: string;
}): string {
  return `${BRIEFING_JOB_KIND}:${input.missionId ?? "global"}:${input.subagentId ?? "all"}:${input.bindingId ?? "all"}:${input.requestedAt.slice(0, 16)}`;
}

function dedupeKeyForChannelDelivery(input: {
  bindingId: string;
  threadKey: string;
  briefingId?: string;
  requestedAt: string;
}): string {
  return `${CHANNEL_DELIVERY_JOB_KIND}:${input.bindingId}:${input.threadKey}:${input.briefingId ?? "message"}:${input.requestedAt.slice(0, 16)}`;
}

function dedupeKeyForApprovalFollowup(input: {
  bindingId?: string;
  requestedAt: string;
}): string {
  return `${APPROVAL_FOLLOWUP_JOB_KIND}:${input.bindingId ?? "all"}:${input.requestedAt.slice(0, 13)}`;
}

function briefingRecordId(input: {
  missionId?: string;
  subagentId?: string;
  bindingId?: string;
  requestedAt: string;
}): string {
  return `briefing:${input.missionId ?? "global"}:${input.subagentId ?? "all"}:${input.bindingId ?? "all"}:${input.requestedAt.replace(/[:.]/g, "-")}`;
}

function matchesDeviceSelector(mission: MissionRecord, device: Device): boolean {
  const linkedDeviceIds = (autonomyStore.listMissionLinks?.(mission.id) ?? [])
    .filter((link) => link.resourceType === "device")
    .map((link) => link.resourceId);
  const workloads = stateStore.getWorkloads(device.id);
  const assurances = stateStore.getAssurances(device.id);
  return missionMatchesDeviceSelector(mission, device, {
    linkedDeviceIds,
    workloads,
    assurances,
  });
}

function matchesWorkloadSelector(mission: MissionRecord, workload: Workload): boolean {
  const selector = mission.targetJson.selector;
  if (!selector) {
    return true;
  }
  if (selector.workloadCategory && workload.category !== selector.workloadCategory) {
    return false;
  }
  if (selector.workloadNamePattern) {
    const pattern = new RegExp(selector.workloadNamePattern, "i");
    if (!pattern.test(`${workload.displayName} ${workload.workloadKey}`)) {
      return false;
    }
  }
  return true;
}

function matchesAssuranceSelector(mission: MissionRecord, assuranceMonitorType?: string): boolean {
  const selector = mission.targetJson.selector;
  if (!selector?.assuranceMonitorTypes?.length) {
    return true;
  }
  return selector.assuranceMonitorTypes.includes(assuranceMonitorType ?? "");
}

function matchRelatedRecommendations(
  mission: MissionRecord,
  deviceId: string,
  recommendations: Recommendation[],
): Recommendation[] {
  const pattern = mission.targetJson.recommendationPattern
    ? new RegExp(mission.targetJson.recommendationPattern, "i")
    : null;

  return recommendations.filter((recommendation) => {
    if (recommendation.dismissed || !recommendation.relatedDeviceIds.includes(deviceId)) {
      return false;
    }
    if (!pattern) {
      return true;
    }
    return pattern.test(`${recommendation.title} ${recommendation.rationale} ${recommendation.impact}`);
  });
}

function openFindingsForMission(devices: Device[], mission: MissionRecord): DeviceFinding[] {
  const findingTypes = new Set(mission.targetJson.findingTypes ?? []);
  const next: DeviceFinding[] = [];

  for (const device of devices) {
    if (!matchesDeviceSelector(mission, device)) {
      continue;
    }
    const findings = stateStore.getDeviceFindings(device.id, "open");
    for (const finding of findings) {
      if (findingTypes.size > 0 && !findingTypes.has(finding.findingType)) {
        continue;
      }
      next.push(finding);
    }
  }

  return next;
}

async function ensureInvestigationForSignal(input: {
  mission: MissionRecord;
  sourceType: string;
  sourceId: string;
  deviceId?: string;
  title: string;
  severity: InvestigationRecord["severity"];
  objective: string;
  summary: string;
  hypothesis?: string;
  evidenceJson: Record<string, unknown>;
  recommendedActionsJson?: string[];
  unresolvedQuestionsJson?: string[];
}): Promise<InvestigationRecord> {
  const now = nowIso();
  const existing = autonomyStore.findOpenInvestigationBySource({
    missionId: input.mission.id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    deviceId: input.deviceId,
  });

  const next: InvestigationRecord = existing
    ? {
        ...existing,
        title: input.title,
        status: "monitoring",
        severity: input.severity,
        stage: "correlate",
        objective: input.objective,
        hypothesis: input.hypothesis,
        summary: input.summary,
        evidenceJson: input.evidenceJson,
        recommendedActionsJson: input.recommendedActionsJson ?? existing.recommendedActionsJson,
        unresolvedQuestionsJson: input.unresolvedQuestionsJson ?? existing.unresolvedQuestionsJson,
        lastRunAt: now,
        nextRunAt: addMinutes(now, Math.max(10, input.mission.cadenceMinutes)),
        updatedAt: now,
      }
    : {
        id: randomUUID(),
        missionId: input.mission.id,
        subagentId: input.mission.subagentId,
        title: input.title,
        status: "open",
        severity: input.severity,
        stage: "detect",
        objective: input.objective,
        hypothesis: input.hypothesis,
        summary: input.summary,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        deviceId: input.deviceId,
        evidenceJson: input.evidenceJson,
        recommendedActionsJson: input.recommendedActionsJson ?? [],
        unresolvedQuestionsJson: input.unresolvedQuestionsJson ?? [],
        lastRunAt: now,
        nextRunAt: addMinutes(now, Math.max(10, input.mission.cadenceMinutes)),
        createdAt: now,
        updatedAt: now,
      };

  autonomyStore.upsertInvestigation(next);
  autonomyStore.linkMissionResource({
    missionId: input.mission.id,
    resourceType: "investigation",
    resourceId: next.id,
    metadataJson: {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    },
  });
  if (input.deviceId) {
    autonomyStore.linkMissionResource({
      missionId: input.mission.id,
      resourceType: "device",
      resourceId: input.deviceId,
      metadataJson: {},
    });
  }

  const shouldAppendStep = !existing
    || existing.summary !== next.summary
    || existing.status !== next.status
    || existing.hypothesis !== next.hypothesis;
  if (shouldAppendStep) {
    autonomyStore.appendInvestigationStep({
      investigationId: next.id,
      kind: existing ? "correlate" : "detect",
      status: "completed",
      title: existing ? "Investigation updated" : "Investigation opened",
      detail: next.summary,
      evidenceJson: next.evidenceJson,
    });
  }

  enqueueInvestigationJob(next.id, now);
  return next;
}

async function resolveInvestigationForSignal(input: {
  missionId: string;
  sourceType: string;
  sourceId: string;
  deviceId?: string;
  resolution: string;
}): Promise<void> {
  const existing = autonomyStore.findOpenInvestigationBySource({
    missionId: input.missionId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    deviceId: input.deviceId,
  });
  if (!existing) {
    return;
  }

  const now = nowIso();
  autonomyStore.upsertInvestigation({
    ...existing,
    status: "resolved",
    stage: "explain",
    summary: input.resolution,
    resolution: input.resolution,
    nextRunAt: undefined,
    lastRunAt: now,
    updatedAt: now,
  });
  autonomyStore.appendInvestigationStep({
    investigationId: existing.id,
    kind: "explain",
    status: "completed",
    title: "Resolved",
    detail: input.resolution,
    evidenceJson: {},
  });
}

async function evaluateAvailabilityMission(
  mission: MissionRecord,
): Promise<{ summary: string; outcomeJson: Record<string, unknown> }> {
  const state = await stateStore.getState();
  const activeIncidents = state.incidents.filter((incident) => incident.status !== "resolved");
  const offlineDevices = state.devices.filter((device) => device.status === "offline" && matchesDeviceSelector(mission, device));
  const offlineIds = new Set(offlineDevices.map((device) => device.id));

  for (const device of offlineDevices) {
    const matchingIncident = activeIncidents.find((incident) =>
      incident.deviceIds.includes(device.id) && incidentType(incident) === AVAILABILITY_OFFLINE_INCIDENT_TYPE,
    );
    const investigation = await ensureInvestigationForSignal({
      mission: mission,
      sourceType: "device",
      sourceId: device.id,
      deviceId: device.id,
      title: `Investigate availability drift on ${device.name}`,
      severity: matchingIncident?.severity ?? "warning",
      objective: mission.objective,
      summary: matchingIncident?.summary ?? `${device.name} (${device.ip}) is offline and needs continued follow-up.`,
      hypothesis: `Network reachability or device health drift is keeping ${device.name} offline.`,
      evidenceJson: {
        deviceId: device.id,
        deviceName: device.name,
        ip: device.ip,
        incidentId: matchingIncident?.id,
        incidentType: matchingIncident ? incidentType(matchingIncident) : undefined,
      },
    });
    if (matchingIncident) {
      autonomyStore.linkMissionResource({
        missionId: mission.id,
        resourceType: "incident",
        resourceId: matchingIncident.id,
        metadataJson: {
          investigationId: investigation.id,
        },
      });
    }
  }

  const staleInvestigations = autonomyStore.listInvestigations({
    missionId: mission.id,
    status: ["open", "monitoring"],
  }).filter((investigation) => investigation.sourceType === "device" && !offlineIds.has(investigation.sourceId ?? ""));

  for (const investigation of staleInvestigations) {
    await resolveInvestigationForSignal({
      missionId: mission.id,
      sourceType: "device",
      sourceId: investigation.sourceId ?? investigation.id,
      deviceId: investigation.deviceId,
      resolution: investigation.deviceId
        ? `${stateStore.getDeviceById(investigation.deviceId)?.name ?? "Device"} is reachable again.`
        : "Availability issue is no longer present.",
    });
  }

  return {
    summary: offlineDevices.length > 0
      ? `Availability watch is tracking ${offlineDevices.length} offline device(s).`
      : "Availability watch sees all scoped devices online.",
    outcomeJson: {
      offlineDeviceIds: offlineDevices.map((device) => device.id),
      openIncidentIds: activeIncidents
        .filter((incident) => incidentType(incident) === AVAILABILITY_OFFLINE_INCIDENT_TYPE)
        .map((incident) => incident.id),
    },
  };
}

async function evaluateWanMission(
  mission: MissionRecord,
): Promise<{ summary: string; outcomeJson: Record<string, unknown> }> {
  const state = await stateStore.getState();
  const scopedDevices = state.devices.filter((device) => matchesDeviceSelector(mission, device));
  const activeIncidents = state.incidents.filter((incident) => incident.status !== "resolved");
  const signalDeviceIds = new Set<string>();
  const linkedRecommendationIds = new Set<string>();

  for (const device of scopedDevices) {
    const deviceIncidents = activeIncidents.filter((incident) => incident.deviceIds.includes(device.id));
    const deviceFindings = stateStore.getDeviceFindings(device.id, "open").filter((finding) =>
      /wan|network|latency|packet|internet|uplink|link/i.test(`${finding.title} ${finding.summary} ${finding.findingType}`),
    );
    const recommendations = matchRelatedRecommendations(mission, device.id, state.recommendations);
    if (deviceIncidents.length === 0 && deviceFindings.length === 0 && recommendations.length === 0) {
      continue;
    }

    signalDeviceIds.add(device.id);
    const primaryIncident = deviceIncidents[0];
    const primaryFinding = deviceFindings[0];
    const primaryRecommendation = recommendations[0];

    const investigation = await ensureInvestigationForSignal({
      mission,
      sourceType: "device",
      sourceId: device.id,
      deviceId: device.id,
      title: `Investigate WAN and edge drift on ${device.name}`,
      severity: primaryIncident?.severity ?? primaryFinding?.severity ?? "warning",
      objective: mission.objective,
      summary: primaryIncident?.summary
        ?? primaryFinding?.summary
        ?? primaryRecommendation?.rationale
        ?? `${device.name} has network-edge signals that need follow-up.`,
      hypothesis: `WAN or network-edge degradation is affecting ${device.name}.`,
      evidenceJson: {
        deviceId: device.id,
        deviceName: device.name,
        incidentIds: deviceIncidents.map((incident) => incident.id),
        findingKeys: deviceFindings.map((finding) => finding.dedupeKey),
        recommendationIds: recommendations.map((recommendation) => recommendation.id),
      },
      recommendedActionsJson: recommendations.map((recommendation) => recommendation.title),
      unresolvedQuestionsJson: [
        `Is ${device.name} experiencing persistent WAN or uplink degradation?`,
      ],
    });

    for (const incident of deviceIncidents) {
      autonomyStore.linkMissionResource({
        missionId: mission.id,
        resourceType: "incident",
        resourceId: incident.id,
        metadataJson: {
          investigationId: investigation.id,
        },
      });
    }

    const workloads = stateStore.getWorkloads(device.id).filter((workload) => matchesWorkloadSelector(mission, workload));
    for (const workload of workloads) {
      autonomyStore.linkMissionResource({
        missionId: mission.id,
        resourceType: "workload",
        resourceId: workload.id,
        metadataJson: {
          investigationId: investigation.id,
          workloadKey: workload.workloadKey,
        },
      });
    }

    const assurances = stateStore.getAssurances(device.id).filter((assurance) =>
      matchesAssuranceSelector(mission, assurance.monitorType)
      && (!assurance.workloadId || workloads.some((workload) => workload.id === assurance.workloadId)),
    );
    for (const assurance of assurances) {
      autonomyStore.linkMissionResource({
        missionId: mission.id,
        resourceType: "assurance",
        resourceId: assurance.id,
        metadataJson: {
          investigationId: investigation.id,
          assuranceKey: assurance.assuranceKey,
          monitorType: assurance.monitorType,
        },
      });
    }

    for (const recommendation of recommendations) {
      linkedRecommendationIds.add(recommendation.id);
      autonomyStore.linkMissionResource({
        missionId: mission.id,
        resourceType: "recommendation",
        resourceId: recommendation.id,
        metadataJson: {
          investigationId: investigation.id,
        },
      });
    }
  }

  const staleInvestigations = autonomyStore.listInvestigations({
    missionId: mission.id,
    status: ["open", "monitoring"],
  }).filter((investigation) => investigation.sourceType === "device" && !signalDeviceIds.has(investigation.sourceId ?? ""));

  for (const investigation of staleInvestigations) {
    await resolveInvestigationForSignal({
      missionId: mission.id,
      sourceType: "device",
      sourceId: investigation.sourceId ?? investigation.id,
      deviceId: investigation.deviceId,
      resolution: "The triggering WAN or network-edge signal is no longer active.",
    });
  }

  return {
    summary: signalDeviceIds.size > 0
      ? `WAN Guardian is tracking ${signalDeviceIds.size} network device(s) with active edge signals.`
      : "WAN Guardian sees no active WAN or network-edge drift in scope.",
    outcomeJson: {
      deviceIds: Array.from(signalDeviceIds),
      recommendationIds: Array.from(linkedRecommendationIds),
    },
  };
}

async function evaluateFindingMission(
  mission: MissionRecord,
  options: {
    titlePrefix: string;
    hypothesisPrefix: string;
    recommendationHints?: string[];
  },
): Promise<{ summary: string; outcomeJson: Record<string, unknown> }> {
  const state = await stateStore.getState();
  const deviceMap = new Map(state.devices.map((device) => [device.id, device]));
  const findings = openFindingsForMission(state.devices, mission);
  const findingKeys = new Set(findings.map((finding) => finding.dedupeKey));

  for (const finding of findings) {
    const device = deviceMap.get(finding.deviceId);
    if (!device) {
      continue;
    }

    const investigation = await ensureInvestigationForSignal({
      mission,
      sourceType: "finding",
      sourceId: finding.dedupeKey,
      deviceId: device.id,
      title: `${options.titlePrefix}: ${finding.title}`,
      severity: finding.severity,
      objective: mission.objective,
      summary: finding.summary,
      hypothesis: `${options.hypothesisPrefix} on ${device.name}.`,
      evidenceJson: {
        ...finding.evidenceJson,
        dedupeKey: finding.dedupeKey,
        findingType: finding.findingType,
        deviceId: device.id,
        deviceName: device.name,
      },
      recommendedActionsJson: options.recommendationHints,
      unresolvedQuestionsJson: [
        `Is ${device.name} still showing the same finding after the next scheduled probe?`,
      ],
    });

    const workloads = stateStore.getWorkloads(device.id).filter((workload) => matchesWorkloadSelector(mission, workload));
    for (const workload of workloads) {
      autonomyStore.linkMissionResource({
        missionId: mission.id,
        resourceType: "workload",
        resourceId: workload.id,
        metadataJson: {
          investigationId: investigation.id,
          workloadKey: workload.workloadKey,
        },
      });
    }

    const assurances = stateStore.getAssurances(device.id).filter((assurance) =>
      matchesAssuranceSelector(mission, assurance.monitorType)
      && (!assurance.workloadId || workloads.some((workload) => workload.id === assurance.workloadId)),
    );
    for (const assurance of assurances) {
      autonomyStore.linkMissionResource({
        missionId: mission.id,
        resourceType: "assurance",
        resourceId: assurance.id,
        metadataJson: {
          investigationId: investigation.id,
          assuranceKey: assurance.assuranceKey,
          monitorType: assurance.monitorType,
        },
      });
    }

    const recommendations = matchRelatedRecommendations(mission, device.id, state.recommendations);
    for (const recommendation of recommendations) {
      autonomyStore.linkMissionResource({
        missionId: mission.id,
        resourceType: "recommendation",
        resourceId: recommendation.id,
        metadataJson: {
          investigationId: investigation.id,
        },
      });
    }
  }

  const staleInvestigations = autonomyStore.listInvestigations({
    missionId: mission.id,
    status: ["open", "monitoring"],
  }).filter((investigation) => investigation.sourceType === "finding" && !findingKeys.has(investigation.sourceId ?? ""));

  for (const investigation of staleInvestigations) {
    await resolveInvestigationForSignal({
      missionId: mission.id,
      sourceType: "finding",
      sourceId: investigation.sourceId ?? investigation.id,
      deviceId: investigation.deviceId,
      resolution: "The triggering finding is no longer open.",
    });
  }

  return {
    summary: findings.length > 0
      ? `${mission.title} is tracking ${findings.length} open finding(s).`
      : `${mission.title} sees no open findings in scope.`,
      outcomeJson: {
        findingKeys: findings.map((finding) => finding.dedupeKey),
        deviceIds: Array.from(new Set(findings.map((finding) => finding.deviceId))),
        assuranceIds: Array.from(new Set(findings.flatMap((finding) =>
          stateStore.getAssurances(finding.deviceId).filter((assurance) => matchesAssuranceSelector(mission, assurance.monitorType)).map((assurance) => assurance.id),
        ))),
      },
    };
}

async function evaluateMission(
  mission: MissionRecord,
): Promise<{ summary: string; outcomeJson: Record<string, unknown> }> {
  if (mission.kind === "availability-guardian") {
    return evaluateAvailabilityMission(mission);
  }
  if (mission.kind === "certificate-guardian") {
    return evaluateFindingMission(mission, {
      titlePrefix: "Investigate certificate lifecycle risk",
      hypothesisPrefix: "TLS lifecycle drift is active",
      recommendationHints: ["Review certificate renewal path and expiry lead time."],
    });
  }
  if (mission.kind === "backup-guardian") {
    return evaluateFindingMission(mission, {
      titlePrefix: "Investigate backup hygiene drift",
      hypothesisPrefix: "Backup freshness or execution drift remains unresolved",
      recommendationHints: ["Verify backup freshness, rerun the failed job, and confirm restore readiness."],
    });
  }
  if (mission.kind === "storage-guardian") {
    return evaluateFindingMission(mission, {
      titlePrefix: "Investigate storage health drift",
      hypothesisPrefix: "Storage pressure or disk health drift is active",
      recommendationHints: ["Validate capacity headroom and confirm disk health before risk turns into outage."],
    });
  }
  if (mission.kind === "wan-guardian") {
    return evaluateWanMission(mission);
  }
  if (mission.kind === "daily-briefing") {
    enqueueBriefingCompilationJob({
      missionId: mission.id,
      subagentId: mission.subagentId,
      shadowMode: mission.shadowMode,
      requestedAt: nowIso(),
      reason: "mission",
    });
    return {
      summary: "Queued daily briefing compilation.",
      outcomeJson: {
        queued: true,
      },
    };
  }

  return {
    summary: `${mission.title} does not have a custom runtime yet.`,
    outcomeJson: {},
  };
}

async function runMissionJob(missionId: string): Promise<{ summary: string; outcomeJson: Record<string, unknown> }> {
  const mission = autonomyStore.getMissionById(missionId);
  if (!mission) {
    return {
      summary: "Mission no longer exists.",
      outcomeJson: {},
    };
  }

  const startedAt = nowIso();
  const runRecordId = randomUUID();
  autonomyStore.upsertMissionRun({
    id: runRecordId,
    missionId: mission.id,
    subagentId: mission.subagentId,
    status: "running",
    summary: `Running ${mission.title}.`,
    outcomeJson: {},
    startedAt,
    createdAt: startedAt,
  });

  try {
    const result = await evaluateMission(mission);
    const completedAt = nowIso();
    const standingOrders = standingOrderInstructionsForMission(mission.id);
    const coordinatedOutcome = standingOrders.length > 0
      ? {
          ...result.outcomeJson,
          standingOrders,
        }
      : result.outcomeJson;
    const summary = mission.shadowMode
      ? `[shadow] ${result.summary}`
      : result.summary;
    autonomyStore.upsertMissionRun({
      id: runRecordId,
      missionId: mission.id,
      subagentId: mission.subagentId,
      status: "succeeded",
      summary,
      outcomeJson: coordinatedOutcome,
      startedAt,
      completedAt,
      createdAt: startedAt,
    });

    autonomyStore.upsertMission({
      ...mission,
      stateJson: {
        ...(mission.stateJson ?? {}),
        ...coordinatedOutcome,
      },
      lastRunAt: completedAt,
      nextRunAt: addMinutes(completedAt, mission.cadenceMinutes),
      lastStatus: "succeeded",
      lastSummary: summary,
      updatedAt: completedAt,
    });

    await stateStore.addAction({
      actor: "steward",
      kind: "mission",
      message: summary,
      context: {
        missionId: mission.id,
        missionRunId: runRecordId,
        kind: mission.kind,
        shadowMode: mission.shadowMode,
      },
    });
    recordMissionRunMemory({
      mission,
      summary,
      outcomeJson: coordinatedOutcome,
    });
    syncMissionCoordination({
      mission,
      outcomeSummary: summary,
      outcomeJson: coordinatedOutcome,
    });

    return {
      ...result,
      outcomeJson: coordinatedOutcome,
      summary,
    };
  } catch (error) {
    const completedAt = nowIso();
    const summary = error instanceof Error ? error.message : String(error);
    const failureOutcome = {
      error: summary,
      standingOrders: standingOrderInstructionsForMission(mission.id),
    };

    autonomyStore.upsertMissionRun({
      id: runRecordId,
      missionId: mission.id,
      subagentId: mission.subagentId,
      status: "failed",
      summary,
      outcomeJson: failureOutcome,
      startedAt,
      completedAt,
      createdAt: startedAt,
    });

    autonomyStore.upsertMission({
      ...mission,
      lastRunAt: completedAt,
      nextRunAt: addMinutes(completedAt, Math.max(15, mission.cadenceMinutes)),
      lastStatus: "failed",
      lastSummary: summary,
      updatedAt: completedAt,
    });
    recordMissionRunMemory({
      mission,
      summary,
      outcomeJson: failureOutcome,
    });
    syncMissionCoordination({
      mission,
      outcomeSummary: summary,
      outcomeJson: failureOutcome,
    });

    throw error;
  }
}

export async function runMissionJobNow(missionId: string): Promise<{ summary: string; outcomeJson: Record<string, unknown> }> {
  return runMissionJob(missionId);
}

async function runInvestigationJob(investigationId: string): Promise<{ summary: string }> {
  const investigation = autonomyStore.getInvestigationById(investigationId);
  if (!investigation) {
    return { summary: "Investigation no longer exists." };
  }
  if (investigation.status === "resolved" || investigation.status === "closed") {
    return { summary: "Investigation already completed." };
  }

  const now = nowIso();
  if (investigation.sourceType === "device" && investigation.deviceId) {
    const device = stateStore.getDeviceById(investigation.deviceId);
    if (!device || device.status === "online") {
      autonomyStore.upsertInvestigation({
        ...investigation,
        status: "resolved",
        stage: "verify",
        summary: `${device?.name ?? "Device"} is reachable again.`,
        resolution: `${device?.name ?? "Device"} is reachable again.`,
        lastRunAt: now,
        nextRunAt: undefined,
        updatedAt: now,
      });
      autonomyStore.appendInvestigationStep({
        investigationId: investigation.id,
        kind: "verify",
        status: "completed",
        title: "Resolved",
        detail: `${device?.name ?? "Device"} is reachable again.`,
        evidenceJson: {
          deviceId: investigation.deviceId,
        },
      });
      return {
        summary: `${device?.name ?? "Device"} recovered.`,
      };
    }

    autonomyStore.upsertInvestigation({
      ...investigation,
      status: "monitoring",
      stage: "probe",
      summary: `${device.name} remains offline.`,
      lastRunAt: now,
      nextRunAt: addMinutes(now, 15),
      updatedAt: now,
    });
    autonomyStore.appendInvestigationStep({
      investigationId: investigation.id,
      kind: "probe",
      status: "completed",
      title: "Availability re-check",
      detail: `${device.name} remains offline.`,
      evidenceJson: {
        deviceId: device.id,
        deviceStatus: device.status,
      },
    });
    ensureChildInvestigation({
      parentInvestigationId: investigation.id,
      missionId: investigation.missionId,
      subagentId: investigation.subagentId,
      deviceId: device.id,
      sourceType: "device.followup",
      sourceId: device.id,
      title: `Escalate repeated reachability drift on ${device.name}`,
      summary: `${device.name} still needs root-cause follow-up beyond reachability checks.`,
      recommendedActionsJson: investigation.recommendedActionsJson,
    });
    return {
      summary: `${device.name} remains offline.`,
    };
  }

  if (investigation.sourceType === "finding" && investigation.deviceId && investigation.sourceId) {
    const finding = stateStore.getDeviceFindings(investigation.deviceId, "open").find(
      (candidate) => candidate.dedupeKey === investigation.sourceId,
    );
    if (!finding) {
    autonomyStore.upsertInvestigation({
      ...investigation,
      status: "resolved",
      stage: "explain",
      summary: "The triggering finding is no longer open.",
      resolution: "The triggering finding is no longer open.",
      lastRunAt: now,
        nextRunAt: undefined,
        updatedAt: now,
      });
      autonomyStore.appendInvestigationStep({
        investigationId: investigation.id,
        kind: "explain",
        status: "completed",
        title: "Resolved",
        detail: "The triggering finding is no longer open.",
        evidenceJson: {},
      });
      return {
        summary: "Finding resolved.",
      };
    }

    autonomyStore.upsertInvestigation({
      ...investigation,
      status: "monitoring",
      stage: "hypothesize",
      summary: finding.summary,
      evidenceJson: {
        ...investigation.evidenceJson,
        ...finding.evidenceJson,
      },
      lastRunAt: now,
      nextRunAt: addMinutes(now, 30),
      updatedAt: now,
    });
    autonomyStore.appendInvestigationStep({
      investigationId: investigation.id,
      kind: "correlate",
      status: "completed",
      title: "Finding still active",
      detail: finding.summary,
      evidenceJson: finding.evidenceJson,
    });
    ensureChildInvestigation({
      parentInvestigationId: investigation.id,
      missionId: investigation.missionId,
      subagentId: investigation.subagentId,
      deviceId: investigation.deviceId,
      sourceType: "finding.followup",
      sourceId: investigation.sourceId,
      title: `Probe remediation path for ${finding.title}`,
      summary: `Steward needs a deeper remediation branch for ${finding.title}.`,
      recommendedActionsJson: investigation.recommendedActionsJson,
    });
    return {
      summary: finding.summary,
    };
  }

    autonomyStore.upsertInvestigation({
      ...investigation,
      status: "monitoring",
      stage: "probe",
      lastRunAt: now,
      nextRunAt: addMinutes(now, 60),
      updatedAt: now,
  });
  return {
    summary: `${investigation.title} remains open.`,
  };
}

export async function runInvestigationJobNow(investigationId: string): Promise<{ summary: string }> {
  return runInvestigationJob(investigationId);
}

async function runBriefingJob(payload: Record<string, unknown>): Promise<{ summary: string }> {
  const requestedAt = typeof payload.requestedAt === "string" ? payload.requestedAt : nowIso();
  const missionId = typeof payload.missionId === "string" ? payload.missionId : undefined;
  const subagentId = typeof payload.subagentId === "string" ? payload.subagentId : undefined;
  const bindingId = typeof payload.bindingId === "string" ? payload.bindingId : undefined;
  const shadowMode = payload.shadowMode === true;

  const briefing = await buildGlobalBriefing({ missionId, subagentId });
  const bindings = bindingId
    ? (autonomyStore.getGatewayBindingById(bindingId) ? [autonomyStore.getGatewayBindingById(bindingId)!] : [])
    : autonomyStore.listGatewayBindings().filter((binding) => binding.enabled);

  if (bindings.length === 0) {
    autonomyStore.createBriefing({
      id: briefingRecordId({ missionId, subagentId, requestedAt }),
      scope: missionId ? "mission" : subagentId ? "subagent" : "global",
      missionId,
      subagentId,
      title: briefing.title,
      body: briefing.body,
      format: "markdown",
      delivered: false,
      metadataJson: {
        ...briefing.metadata,
        shadowMode,
      },
      createdAt: requestedAt,
    });
    return {
      summary: shadowMode
        ? "Compiled briefing in shadow mode."
        : "Compiled briefing with no delivery bindings configured.",
    };
  }

  let queuedDeliveries = 0;
  for (const binding of bindings) {
    const recordId = briefingRecordId({ missionId, subagentId, bindingId: binding.id, requestedAt });
    autonomyStore.createBriefing({
      id: recordId,
      scope: missionId ? "mission" : subagentId ? "subagent" : "global",
      missionId,
      subagentId,
      bindingId: binding.id,
      title: briefing.title,
      body: briefing.body,
      format: "markdown",
      delivered: false,
      metadataJson: {
        ...briefing.metadata,
        shadowMode,
      },
      createdAt: requestedAt,
    });

    if (shadowMode || !binding.target) {
      continue;
    }

    enqueueGatewayDeliveryJob({
      bindingId: binding.id,
      threadKey: binding.target,
      briefingId: recordId,
      missionId,
      requestedAt,
      text: `${briefing.title}\n\n${briefing.body}`,
    });
    queuedDeliveries += 1;
  }

  await stateStore.addAction({
    actor: "steward",
    kind: "gateway",
    message: shadowMode
      ? "Compiled briefing in shadow mode."
      : `Compiled briefing and queued ${queuedDeliveries} delivery job(s).`,
    context: {
      missionId,
      subagentId,
      bindingId,
      requestedAt,
      queuedDeliveries,
      shadowMode,
    },
  });

  return {
    summary: shadowMode
      ? "Compiled briefing in shadow mode."
      : queuedDeliveries > 0
        ? `Queued ${queuedDeliveries} briefing delivery job(s).`
        : "Compiled briefing but no gateway binding had a delivery target.",
  };
}

async function runGatewayDeliveryJob(payload: Record<string, unknown>): Promise<{ summary: string }> {
  const bindingId = typeof payload.bindingId === "string" ? payload.bindingId : "";
  const threadKey = typeof payload.threadKey === "string" ? payload.threadKey : "";
  const text = typeof payload.text === "string" ? payload.text : "";
  const briefingId = typeof payload.briefingId === "string" ? payload.briefingId : undefined;
  const deliveryId = typeof payload.deliveryId === "string" ? payload.deliveryId : undefined;
  if (!bindingId || !threadKey || !text) {
    return {
      summary: "Gateway delivery payload is incomplete.",
    };
  }

  try {
    await sendGatewayMessage(bindingId, text, { threadKey });
    const deliveredAt = nowIso();
    if (briefingId) {
      autonomyStore.markBriefingDelivered(briefingId, deliveredAt);
    }
    if (deliveryId) {
      gatewayRepository.recordDelivery({
        id: deliveryId,
        bindingId,
        threadId: gatewayRepository.getThreadByExternalKey(bindingId, threadKey)?.id,
        missionId: briefingId ? autonomyStore.listBriefings().find((briefing) => briefing.id === briefingId)?.missionId : undefined,
        briefingId,
        status: "delivered",
        textPreview: text.slice(0, 240),
        requestedAt: typeof payload.requestedAt === "string" ? payload.requestedAt : deliveredAt,
        deliveredAt,
      });
    }
  } catch (error) {
    if (deliveryId) {
      gatewayRepository.recordDelivery({
        id: deliveryId,
        bindingId,
        threadId: gatewayRepository.getThreadByExternalKey(bindingId, threadKey)?.id,
        missionId: briefingId ? autonomyStore.listBriefings().find((briefing) => briefing.id === briefingId)?.missionId : undefined,
        briefingId,
        status: "failed",
        textPreview: text.slice(0, 240),
        requestedAt: typeof payload.requestedAt === "string" ? payload.requestedAt : nowIso(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }

  return {
    summary: briefingId
      ? `Delivered briefing ${briefingId}.`
      : `Delivered gateway message via ${bindingId}.`,
  };
}

async function runApprovalFollowupJob(payload: Record<string, unknown>): Promise<{ summary: string }> {
  const bindingId = typeof payload.bindingId === "string" ? payload.bindingId : undefined;
  const requestedAt = typeof payload.requestedAt === "string" ? payload.requestedAt : nowIso();
  const pendingApprovals = stateStore.getPendingApprovals();
  if (pendingApprovals.length === 0) {
    return {
      summary: "No pending approvals require follow-up.",
    };
  }

  const bindings = bindingId
    ? (autonomyStore.getGatewayBindingById(bindingId) ? [autonomyStore.getGatewayBindingById(bindingId)!] : [])
    : autonomyStore.listGatewayBindings().filter((binding) => binding.enabled && Boolean(binding.target));
  if (bindings.length === 0) {
    return {
      summary: "Pending approvals exist but no gateway bindings are ready for follow-up delivery.",
    };
  }

  const body = [
    "Pending approvals",
    ...pendingApprovals.slice(0, 5).map((approval) =>
      `- ${approval.name} on ${approval.deviceId} expires ${approval.expiresAt}`,
    ),
  ].join("\n");

  for (const binding of bindings) {
    if (!binding.target) {
      continue;
    }
    enqueueGatewayDeliveryJob({
      bindingId: binding.id,
      threadKey: binding.target,
      missionId: undefined,
      text: body,
      requestedAt,
    });
  }

  return {
    summary: `Queued approval follow-up for ${pendingApprovals.length} pending approval(s).`,
  };
}

export function ensureAutonomyBootstrap(): void {
  autonomyStore.ensureBootstrap();
}

export function enqueueMissionJob(missionId: string, requestedAt = nowIso()): void {
  const mission = autonomyStore.getMissionById(missionId);
  if (!mission) {
    return;
  }
  stateStore.enqueueDurableJob(
    MISSION_JOB_KIND,
    {
      missionId,
      requestedAt,
    },
    dedupeKeyForMissionRun(mission, requestedAt),
  );
}

export function enqueueInvestigationJob(investigationId: string, requestedAt = nowIso()): void {
  stateStore.enqueueDurableJob(
    INVESTIGATION_JOB_KIND,
    {
      investigationId,
      requestedAt,
    },
    dedupeKeyForInvestigation(investigationId, requestedAt),
  );
}

export function enqueueBriefingCompilationJob(input: {
  missionId?: string;
  subagentId?: string;
  bindingId?: string;
  shadowMode?: boolean;
  reason?: string;
  requestedAt?: string;
}): void {
  const requestedAt = input.requestedAt ?? nowIso();
  stateStore.enqueueDurableJob(
    BRIEFING_JOB_KIND,
    {
      missionId: input.missionId,
      subagentId: input.subagentId,
      bindingId: input.bindingId,
      shadowMode: input.shadowMode ?? false,
      reason: input.reason ?? "manual",
      requestedAt,
    },
    dedupeKeyForBriefing({
      missionId: input.missionId,
      subagentId: input.subagentId,
      bindingId: input.bindingId,
      requestedAt,
    }),
  );
}

export function enqueueGatewayDeliveryJob(input: {
  bindingId: string;
  threadKey: string;
  text: string;
  briefingId?: string;
  missionId?: string;
  requestedAt?: string;
}): void {
  const requestedAt = input.requestedAt ?? nowIso();
  const thread = gatewayRepository.getThreadByExternalKey(input.bindingId, input.threadKey);
  const delivery = gatewayRepository.recordDelivery({
    bindingId: input.bindingId,
    threadId: thread?.id,
    missionId: input.missionId ?? thread?.missionId,
    briefingId: input.briefingId,
    status: "queued",
    textPreview: input.text.slice(0, 240),
    requestedAt,
  });
  stateStore.enqueueDurableJob(
    CHANNEL_DELIVERY_JOB_KIND,
    {
      bindingId: input.bindingId,
      threadKey: input.threadKey,
      text: input.text,
      briefingId: input.briefingId,
      missionId: input.missionId ?? thread?.missionId,
      deliveryId: delivery.id,
      requestedAt,
    },
    dedupeKeyForChannelDelivery({
      bindingId: input.bindingId,
      threadKey: input.threadKey,
      briefingId: input.briefingId,
      requestedAt,
    }),
  );
}

export function enqueueApprovalFollowupJob(input?: {
  bindingId?: string;
  requestedAt?: string;
}): void {
  const requestedAt = input?.requestedAt ?? nowIso();
  stateStore.enqueueDurableJob(
    APPROVAL_FOLLOWUP_JOB_KIND,
    {
      bindingId: input?.bindingId,
      requestedAt,
    },
    dedupeKeyForApprovalFollowup({
      bindingId: input?.bindingId,
      requestedAt,
    }),
  );
}

export async function queueDueAutonomyJobs(referenceIso = nowIso()): Promise<void> {
  ensureAutonomyBootstrap();
  const dueMissions = autonomyStore.getDueMissions(referenceIso);
  for (const mission of dueMissions) {
    enqueueMissionJob(mission.id, referenceIso);
  }

  const dueInvestigations = autonomyStore.getDueInvestigations(referenceIso);
  for (const investigation of dueInvestigations) {
    enqueueInvestigationJob(investigation.id, referenceIso);
  }

  if (stateStore.getPendingApprovals().length > 0) {
    enqueueApprovalFollowupJob({
      requestedAt: referenceIso,
    });
  }
}

export async function processAutonomyJobs(limit = 25): Promise<void> {
  const jobs = stateStore.claimDurableJobs(limit, {
    kinds: Array.from(AUTONOMY_JOB_KINDS),
  });

  for (const job of jobs) {
    try {
      if (job.kind === MISSION_JOB_KIND) {
        const missionId = typeof job.payload.missionId === "string" ? job.payload.missionId : "";
        await runMissionJob(missionId);
      } else if (job.kind === INVESTIGATION_JOB_KIND) {
        const investigationId = typeof job.payload.investigationId === "string" ? job.payload.investigationId : "";
        await runInvestigationJob(investigationId);
      } else if (job.kind === BRIEFING_JOB_KIND) {
        await runBriefingJob(job.payload);
      } else if (job.kind === APPROVAL_FOLLOWUP_JOB_KIND) {
        await runApprovalFollowupJob(job.payload);
      } else if (job.kind === CHANNEL_DELIVERY_JOB_KIND) {
        await runGatewayDeliveryJob(job.payload);
      }

      stateStore.completeDurableJob(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stateStore.failDurableJob(
        job.id,
        message,
        Math.min(30 * 60_000, 60_000 * Math.max(1, job.attempts + 1)),
      );
    }
  }
}
