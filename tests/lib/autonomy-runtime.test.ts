import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBootstrap: vi.fn(),
  getDueMissions: vi.fn(),
  getMissionById: vi.fn(),
  getDueInvestigations: vi.fn(),
  getPendingApprovals: vi.fn(),
  countDurableJobsInFlight: vi.fn(),
  enqueueDurableJob: vi.fn(),
}));

vi.mock("@/lib/autonomy/store", () => ({
  autonomyStore: {
    ensureBootstrap: mocks.ensureBootstrap,
    getDueMissions: mocks.getDueMissions,
    getMissionById: mocks.getMissionById,
    getDueInvestigations: mocks.getDueInvestigations,
  },
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getPendingApprovals: mocks.getPendingApprovals,
    countDurableJobsInFlight: mocks.countDurableJobsInFlight,
    enqueueDurableJob: mocks.enqueueDurableJob,
  },
}));

vi.mock("@/lib/autonomy/briefings", () => ({
  buildGlobalBriefing: vi.fn(),
  buildOperatorStatusText: vi.fn(),
}));

vi.mock("@/lib/autonomy/gateway", () => ({
  sendGatewayMessage: vi.fn(),
}));

import {
  enqueueBriefingCompilationJob,
  queueDueAutonomyJobs,
} from "@/lib/autonomy/runtime";

describe("autonomy runtime job queueing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues due missions and investigations", async () => {
    mocks.getDueMissions.mockReturnValue([
      { id: "mission-1" },
      { id: "mission-2" },
    ]);
    mocks.getMissionById.mockImplementation((id: string) => ({
      id,
    }));
    mocks.getDueInvestigations.mockReturnValue([
      { id: "investigation-1" },
    ]);
    mocks.getPendingApprovals.mockReturnValue([
      {
        id: "approval-1",
        name: "Restart service",
        deviceId: "device-1",
        expiresAt: "2026-03-17T13:00:00.000Z",
      },
    ]);
    mocks.countDurableJobsInFlight.mockReturnValue(0);

    await queueDueAutonomyJobs("2026-03-17T12:00:00.000Z");

    expect(mocks.ensureBootstrap).toHaveBeenCalled();
    expect(mocks.countDurableJobsInFlight).toHaveBeenCalledWith(["investigation.step"], 200);
    expect(mocks.getDueInvestigations).toHaveBeenCalledWith("2026-03-17T12:00:00.000Z", 200);
    expect(mocks.enqueueDurableJob).toHaveBeenCalledTimes(4);
    expect(mocks.enqueueDurableJob).toHaveBeenCalledWith(
      "mission.tick",
      expect.objectContaining({ missionId: "mission-1" }),
      expect.stringContaining("mission.tick:mission-1"),
    );
    expect(mocks.enqueueDurableJob).toHaveBeenCalledWith(
      "investigation.step",
      expect.objectContaining({ investigationId: "investigation-1" }),
      "investigation.step:investigation-1",
    );
    expect(mocks.enqueueDurableJob).toHaveBeenCalledWith(
      "approval.followup",
      expect.objectContaining({ requestedAt: "2026-03-17T12:00:00.000Z" }),
      "approval.followup:all:2026-03-17T12",
    );
  });

  it("caps queued due investigations to the remaining queue budget", async () => {
    mocks.getDueMissions.mockReturnValue([]);
    mocks.getPendingApprovals.mockReturnValue([]);
    mocks.countDurableJobsInFlight.mockReturnValue(199);
    mocks.getDueInvestigations.mockReturnValue([
      { id: "investigation-1" },
    ]);

    await queueDueAutonomyJobs("2026-03-17T12:00:00.000Z");

    expect(mocks.getDueInvestigations).toHaveBeenCalledWith("2026-03-17T12:00:00.000Z", 1);
    expect(mocks.enqueueDurableJob).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueDurableJob).toHaveBeenCalledWith(
      "investigation.step",
      expect.objectContaining({ investigationId: "investigation-1" }),
      "investigation.step:investigation-1",
    );
  });

  it("queues briefing compilation jobs with a stable dedupe key", () => {
    enqueueBriefingCompilationJob({
      missionId: "mission-briefing",
      bindingId: "binding-1",
      requestedAt: "2026-03-17T12:05:00.000Z",
      reason: "manual",
    });

    expect(mocks.enqueueDurableJob).toHaveBeenCalledWith(
      "briefing.compile",
      expect.objectContaining({
        missionId: "mission-briefing",
        bindingId: "binding-1",
        reason: "manual",
      }),
      "briefing.compile:mission-briefing:all:binding-1:2026-03-17T12:05",
    );
  });
});
