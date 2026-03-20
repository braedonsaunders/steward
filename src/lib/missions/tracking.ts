type MissionLike = {
  id: string;
  kind: string;
  status?: string;
  subagentId?: string;
  stateJson?: Record<string, unknown>;
  openInvestigations?: Array<unknown>;
};

type InvestigationLike = {
  id: string;
  missionId?: string;
  subagentId?: string;
  parentInvestigationId?: string;
  sourceType?: string;
  sourceId?: string;
  deviceId?: string;
  updatedAt: string;
};

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function signalKey(sourceType: string, sourceId: string): string {
  return `${sourceType}|${sourceId}`;
}

function missionSignalKeys(mission: MissionLike): Set<string> {
  const state = mission.stateJson ?? {};

  if (mission.kind === "availability-guardian" || mission.kind === "wan-guardian") {
    return new Set(readStringArray(state.deviceIds ?? state.offlineDeviceIds).map((deviceId) => signalKey("device", deviceId)));
  }

  if (
    mission.kind === "certificate-guardian"
    || mission.kind === "backup-guardian"
    || mission.kind === "storage-guardian"
  ) {
    return new Set(readStringArray(state.findingKeys).map((findingKey) => signalKey("finding", findingKey)));
  }

  return new Set();
}

function investigationSignalKey(investigation: InvestigationLike): string | undefined {
  if (investigation.sourceType === "device" || investigation.sourceType === "device.followup") {
    const deviceKey = investigation.sourceId ?? investigation.deviceId;
    return deviceKey ? signalKey("device", deviceKey) : undefined;
  }

  if (investigation.sourceType === "finding" || investigation.sourceType === "finding.followup") {
    return investigation.sourceId ? signalKey("finding", investigation.sourceId) : undefined;
  }

  if (investigation.sourceType && investigation.sourceId) {
    return signalKey(investigation.sourceType, investigation.sourceId);
  }

  return undefined;
}

export function countMissionTrackedSignals(mission: MissionLike): number {
  const state = mission.stateJson ?? {};

  if (mission.kind === "availability-guardian") {
    const offlineDeviceIds = readStringArray(state.offlineDeviceIds);
    if (offlineDeviceIds.length > 0) {
      return offlineDeviceIds.length;
    }
  }

  if (mission.kind === "wan-guardian") {
    const deviceIds = readStringArray(state.deviceIds);
    if (deviceIds.length > 0) {
      return deviceIds.length;
    }
  }

  if (
    mission.kind === "certificate-guardian"
    || mission.kind === "backup-guardian"
    || mission.kind === "storage-guardian"
  ) {
    const findingKeys = readStringArray(state.findingKeys);
    if (findingKeys.length > 0) {
      return findingKeys.length;
    }
  }

  return mission.openInvestigations?.length ?? 0;
}

export function listTrackedMissionInvestigations<T extends InvestigationLike>(
  missions: MissionLike[],
  investigations: T[],
): T[] {
  const activeMissions = missions.filter((mission) => mission.status === undefined || mission.status === "active");
  const missionsById = new Map(activeMissions.map((mission) => [mission.id, mission]));
  const uniqueMissionBySubagent = new Map<string, MissionLike | null>();

  for (const mission of activeMissions) {
    if (!mission.subagentId) {
      continue;
    }

    if (!uniqueMissionBySubagent.has(mission.subagentId)) {
      uniqueMissionBySubagent.set(mission.subagentId, mission);
      continue;
    }

    uniqueMissionBySubagent.set(mission.subagentId, null);
  }

  const signalKeysByMission = new Map(activeMissions.map((mission) => [mission.id, missionSignalKeys(mission)]));
  const dedupeKeys = new Set<string>();
  const tracked: T[] = [];

  for (const investigation of investigations) {
    if (investigation.parentInvestigationId || investigation.sourceType?.endsWith(".followup")) {
      continue;
    }

    const mission = investigation.missionId
      ? missionsById.get(investigation.missionId)
      : investigation.subagentId
        ? uniqueMissionBySubagent.get(investigation.subagentId) ?? undefined
        : undefined;

    if (!mission) {
      continue;
    }

    const investigationKey = investigationSignalKey(investigation);
    const missionKeys = signalKeysByMission.get(mission.id);
    if (missionKeys && missionKeys.size > 0) {
      if (!investigationKey || !missionKeys.has(investigationKey)) {
        continue;
      }
    }

    const dedupeKey = `${mission.id}|${investigationKey ?? investigation.id}`;
    if (dedupeKeys.has(dedupeKey)) {
      continue;
    }

    dedupeKeys.add(dedupeKey);
    tracked.push(
      investigation.missionId === mission.id
        ? investigation
        : {
            ...investigation,
            missionId: mission.id,
          },
    );
  }

  return tracked.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}
