import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMissionLabScenario, type MissionLabScenario } from "@/lib/missions/lab";

const scenarioState = vi.hoisted(() => ({
  current: null as MissionLabScenario | null,
  investigations: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/subagents/service", () => ({
  recordMissionRunMemory: vi.fn(),
  standingOrderInstructionsForMission: vi.fn(() => []),
}));

vi.mock("@/lib/missions/service", () => ({
  buildMissionPromptContext: vi.fn(() => ""),
  syncMissionCoordination: vi.fn(),
}));

vi.mock("@/lib/investigations/service", () => ({
  ensureChildInvestigation: vi.fn(),
}));

vi.mock("@/lib/autonomy/gateway", () => ({
  sendGatewayMessage: vi.fn(),
}));

vi.mock("@/lib/autonomy/store", () => ({
  autonomyStore: {
    getMissionById: vi.fn((missionId: string) => {
      const scenario = scenarioState.current;
      if (!scenario || scenario.mission.id !== missionId) {
        return undefined;
      }
      return {
        id: scenario.mission.id,
        slug: scenario.mission.id,
        title: scenario.mission.title,
        summary: scenario.mission.summary,
        kind: scenario.mission.kind,
        status: "active",
        priority: scenario.mission.priority,
        objective: scenario.mission.objective,
        subagentId: scenario.mission.subagentId,
        packId: undefined,
        cadenceMinutes: scenario.mission.cadenceMinutes,
        autoRun: true,
        autoApprove: false,
        shadowMode: scenario.mission.shadowMode,
        targetJson: scenario.mission.targetJson,
        stateJson: {},
        createdBy: "steward",
        createdAt: "2026-03-17T12:00:00.000Z",
        updatedAt: "2026-03-17T12:00:00.000Z",
      };
    }),
    upsertMissionRun: vi.fn(),
    upsertMission: vi.fn(),
    findOpenInvestigationBySource: vi.fn((input: { missionId?: string; sourceType: string; sourceId: string; deviceId?: string }) =>
      scenarioState.investigations.find((investigation) =>
        investigation.missionId === input.missionId
        && investigation.sourceType === input.sourceType
        && investigation.sourceId === input.sourceId
        && (input.deviceId ? investigation.deviceId === input.deviceId : true)
        && (investigation.status === "open" || investigation.status === "monitoring"),
      ),
    ),
    upsertInvestigation: vi.fn((investigation: Record<string, unknown>) => {
      const existingIndex = scenarioState.investigations.findIndex((entry) => entry.id === investigation.id);
      if (existingIndex >= 0) {
        scenarioState.investigations[existingIndex] = investigation;
      } else {
        scenarioState.investigations.push(investigation);
      }
      return investigation;
    }),
    linkMissionResource: vi.fn(),
    appendInvestigationStep: vi.fn(),
    listInvestigations: vi.fn((filter?: { missionId?: string; status?: string[] | string }) => {
      const statuses = Array.isArray(filter?.status)
        ? filter?.status
        : typeof filter?.status === "string"
          ? [filter.status]
          : undefined;
      return scenarioState.investigations.filter((investigation) =>
        (!filter?.missionId || investigation.missionId === filter.missionId)
        && (!statuses || statuses.includes(String(investigation.status))),
      );
    }),
    getSubagentById: vi.fn((id: string) => ({
      id,
      name: id.replace("subagent.", "").replace(/-/g, " "),
    })),
    listBriefings: vi.fn(() => []),
    markBriefingDelivered: vi.fn(),
  },
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getState: vi.fn(async () => ({
      devices: scenarioState.current?.state.devices ?? [],
      incidents: scenarioState.current?.state.incidents ?? [],
      recommendations: scenarioState.current?.state.recommendations ?? [],
    })),
    getDeviceFindings: vi.fn((deviceId: string) => scenarioState.current?.state.findingsByDevice?.[deviceId] ?? []),
    getWorkloads: vi.fn((deviceId: string) => scenarioState.current?.state.workloadsByDevice?.[deviceId] ?? []),
    getAssurances: vi.fn((deviceId: string) => scenarioState.current?.state.assurancesByDevice?.[deviceId] ?? []),
    addAction: vi.fn(async () => undefined),
    enqueueDurableJob: vi.fn(),
  },
}));

import { runMissionJobNow } from "@/lib/autonomy/runtime";

describe("mission lab replay fixtures", () => {
  beforeEach(() => {
    scenarioState.current = null;
    scenarioState.investigations = [];
  });

  const fixtureFiles = [
    "wan-guardian.json",
    "backup-guardian.json",
    "certificate-guardian.json",
  ];

  for (const fixtureFile of fixtureFiles) {
    it(`replays ${fixtureFile}`, async () => {
      const scenario = loadMissionLabScenario(path.join(process.cwd(), "tests", "fixtures", "lab", fixtureFile));
      scenarioState.current = scenario;

      const result = await runMissionJobNow(scenario.mission.id);

      expect(result.summary).toContain(scenario.expectations.summaryIncludes ?? "");
      expect(scenarioState.investigations).toHaveLength(scenario.expectations.openInvestigations ?? 0);
    });
  }
});
