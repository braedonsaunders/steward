export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { autonomyStore } from "@/lib/autonomy/store";
import { missionRepository } from "@/lib/missions/repository";
import { missionMatchesDeviceSelector } from "@/lib/missions/scope";
import { stateStore } from "@/lib/state/store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const workloads = stateStore.getWorkloads(id);
  const assurances = stateStore.getAssurances(id);
  const deviceLinks = autonomyStore.listMissionLinksForResource("device", id);

  const workloadMissionIdsByWorkloadId: Record<string, string[]> = {};
  for (const workload of workloads) {
    workloadMissionIdsByWorkloadId[workload.id] = autonomyStore
      .listMissionLinksForResource("workload", workload.id)
      .map((link) => link.missionId);
  }

  const assuranceMissionIdsByAssuranceId: Record<string, string[]> = {};
  for (const assurance of assurances) {
    assuranceMissionIdsByAssuranceId[assurance.id] = autonomyStore
      .listMissionLinksForResource("assurance", assurance.id)
      .map((link) => link.missionId);
  }

  const matchedMissionIds = autonomyStore.listMissions()
    .filter((mission) => missionMatchesDeviceSelector(mission, device, {
      linkedDeviceIds: autonomyStore.listMissionLinks(mission.id)
        .filter((link) => link.resourceType === "device")
        .map((link) => link.resourceId),
      workloads,
      assurances,
    }))
    .map((mission) => mission.id);

  const missionIds = new Set<string>([
    ...deviceLinks.map((link) => link.missionId),
    ...Object.values(workloadMissionIdsByWorkloadId).flat(),
    ...Object.values(assuranceMissionIdsByAssuranceId).flat(),
    ...matchedMissionIds,
  ]);

  return NextResponse.json({
    deviceId: id,
    deviceMissionIds: Array.from(new Set(deviceLinks.map((link) => link.missionId))),
    matchedMissionIds: Array.from(new Set(matchedMissionIds)),
    workloadMissionIdsByWorkloadId,
    assuranceMissionIdsByAssuranceId,
    missions: Array.from(missionIds)
      .map((missionId) => missionRepository.getWithDetails(missionId))
      .filter(Boolean),
  });
}
