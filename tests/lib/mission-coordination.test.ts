import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWithDetails: vi.fn(),
  upsertDelegation: vi.fn(),
  upsertPlan: vi.fn(),
  getById: vi.fn(),
  getPrimaryDeviceId: vi.fn(),
  getSubagentById: vi.fn(),
}));

vi.mock("@/lib/missions/repository", () => ({
  missionRepository: {
    getWithDetails: mocks.getWithDetails,
    upsertDelegation: mocks.upsertDelegation,
    upsertPlan: mocks.upsertPlan,
    getById: mocks.getById,
    getPrimaryDeviceId: mocks.getPrimaryDeviceId,
  },
}));

vi.mock("@/lib/autonomy/store", () => ({
  autonomyStore: {
    getSubagentById: mocks.getSubagentById,
  },
}));

import { syncMissionCoordination } from "@/lib/missions/service";

describe("mission coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWithDetails.mockReturnValue({
      id: "mission-1",
      title: "Availability Overwatch",
      kind: "availability-guardian",
      priority: "high",
      openInvestigations: [],
      delegations: [],
      plan: undefined,
    });
    mocks.getSubagentById.mockImplementation((id: string) => ({
      id,
      name: id.replace("subagent.", "").replace(/-/g, " "),
    }));
    mocks.upsertDelegation.mockImplementation((input: Record<string, unknown>) => ({
      id: `delegation:${String(input.toSubagentId)}`,
      ...input,
    }));
  });

  it("creates cross-mission delegations and a plan from mission evidence", () => {
    syncMissionCoordination({
      mission: {
        id: "mission-1",
        slug: "availability-overwatch",
        title: "Availability Overwatch",
        summary: "Own reachability.",
        kind: "availability-guardian",
        status: "active",
        priority: "high",
        objective: "Own online/offline visibility.",
        subagentId: "subagent.availability-operator",
        cadenceMinutes: 10,
        autoRun: true,
        autoApprove: false,
        shadowMode: false,
        targetJson: {},
        stateJson: {},
        createdBy: "steward",
        createdAt: "2026-03-17T12:00:00.000Z",
        updatedAt: "2026-03-17T12:00:00.000Z",
      },
      outcomeSummary: "Observed WAN latency and certificate expiry drift on the edge router.",
      outcomeJson: {
        recommendationIds: ["rec-1"],
      },
    });

    expect(mocks.upsertDelegation).toHaveBeenCalledWith(expect.objectContaining({
      toSubagentId: "subagent.network-operator",
    }));
    expect(mocks.upsertDelegation).toHaveBeenCalledWith(expect.objectContaining({
      toSubagentId: "subagent.certificate-operator",
    }));
    expect(mocks.upsertPlan).toHaveBeenCalledWith(expect.objectContaining({
      missionId: "mission-1",
      status: "blocked",
    }));
  });
});
