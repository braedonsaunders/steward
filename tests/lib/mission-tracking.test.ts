import { describe, expect, it } from "vitest";
import {
  countMissionTrackedSignals,
  listTrackedMissionInvestigations,
} from "@/lib/missions/tracking";

describe("mission tracking presentation", () => {
  it("prefers mission state counts over broken open investigation rows", () => {
    expect(countMissionTrackedSignals({
      id: "mission.availability-overwatch",
      kind: "availability-guardian",
      stateJson: {
        offlineDeviceIds: ["device-1", "device-2", "device-3"],
      },
      openInvestigations: [{ id: "stale-1" }],
    })).toBe(3);

    expect(countMissionTrackedSignals({
      id: "mission.daily-briefing",
      kind: "daily-briefing",
      stateJson: {},
      openInvestigations: [{ id: "investigation-1" }, { id: "investigation-2" }],
    })).toBe(2);
  });

  it("filters tracked investigations to current top-level mission signals", () => {
    const missions = [
      {
        id: "mission.availability-overwatch",
        kind: "availability-guardian",
        status: "active",
        subagentId: "subagent.availability-operator",
        stateJson: {
          offlineDeviceIds: ["device-1", "device-2"],
        },
      },
      {
        id: "mission.certificate-watch",
        kind: "certificate-guardian",
        status: "active",
        subagentId: "subagent.certificate-operator",
        stateJson: {
          findingKeys: ["finding-1"],
        },
      },
    ] as const;

    const investigations = [
      {
        id: "availability-current",
        subagentId: "subagent.availability-operator",
        sourceType: "device",
        sourceId: "device-1",
        status: "open",
        stage: "detect",
        severity: "warning",
        title: "Investigate device-1",
        updatedAt: "2026-03-20T14:53:12.442Z",
      },
      {
        id: "availability-duplicate",
        subagentId: "subagent.availability-operator",
        sourceType: "device",
        sourceId: "device-1",
        status: "monitoring",
        stage: "probe",
        severity: "warning",
        title: "Investigate device-1 again",
        updatedAt: "2026-03-20T14:40:00.000Z",
      },
      {
        id: "availability-followup",
        subagentId: "subagent.availability-operator",
        parentInvestigationId: "availability-current",
        sourceType: "device.followup",
        sourceId: "device-1",
        status: "open",
        stage: "detect",
        severity: "warning",
        title: "Escalate device-1",
        updatedAt: "2026-03-20T14:54:00.000Z",
      },
      {
        id: "availability-stale",
        subagentId: "subagent.availability-operator",
        sourceType: "device",
        sourceId: "device-9",
        status: "open",
        stage: "detect",
        severity: "warning",
        title: "Investigate device-9",
        updatedAt: "2026-03-20T14:30:00.000Z",
      },
      {
        id: "certificate-current",
        subagentId: "subagent.certificate-operator",
        sourceType: "finding",
        sourceId: "finding-1",
        status: "open",
        stage: "detect",
        severity: "warning",
        title: "Investigate finding-1",
        updatedAt: "2026-03-20T14:55:00.000Z",
      },
    ] as const;

    expect(listTrackedMissionInvestigations(missions, investigations)).toEqual([
      expect.objectContaining({
        id: "certificate-current",
        missionId: "mission.certificate-watch",
      }),
      expect.objectContaining({
        id: "availability-current",
        missionId: "mission.availability-overwatch",
      }),
    ]);
  });
});
