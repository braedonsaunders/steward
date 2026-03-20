import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybookRun } from "@/lib/state/types";

const mocks = vi.hoisted(() => ({
  enqueueDurableJobMock: vi.fn(),
  requestRuntimeJobProcessingMock: vi.fn(),
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    enqueueDurableJob: mocks.enqueueDurableJobMock,
  },
}));

vi.mock("@/lib/agent/loop", () => ({
  requestRuntimeJobProcessing: mocks.requestRuntimeJobProcessingMock,
}));

vi.mock("@/lib/playbooks/runtime", () => ({
  executePlaybook: vi.fn(),
}));

import { queuePlaybookExecution } from "@/lib/playbooks/orchestrator";

function buildRun(overrides: Partial<PlaybookRun> = {}): PlaybookRun {
  return {
    id: "run-1",
    playbookId: "playbook-1",
    family: "gitlab-upgrade",
    name: "GitLab upgrade",
    deviceId: "device-1",
    actionClass: "C",
    status: "approved",
    policyEvaluation: {
      decision: "REQUIRE_APPROVAL",
      ruleId: "default:tier1-gate",
      reason: "Approval required",
      riskScore: 0.8,
      riskFactors: [],
      evaluatedAt: "2026-03-19T14:24:37.302Z",
      inputs: {
        actionClass: "C",
        autonomyTier: 1,
        environmentLabel: "lab",
        inMaintenanceWindow: false,
        deviceId: "device-1",
        blastRadius: "single-device",
        criticality: "medium",
        lane: "A",
        recentFailures: 0,
        quarantineActive: false,
      },
    },
    steps: [],
    verificationSteps: [],
    rollbackSteps: [],
    evidence: {
      logs: [],
      gateResults: [],
      auditBundle: {
        actor: "steward",
        lane: "A",
        rationale: "Approval required",
        operations: [],
      },
    },
    createdAt: "2026-03-19T14:24:22.947Z",
    updatedAt: "2026-03-19T14:24:37.302Z",
    approvedAt: "2026-03-19T14:24:37.302Z",
    failureCount: 0,
    ...overrides,
  };
}

describe("playbook orchestrator queueing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kicks runtime job processing as soon as a playbook execution job is enqueued", async () => {
    queuePlaybookExecution(buildRun(), "approval");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.enqueueDurableJobMock).toHaveBeenCalledWith(
      "playbook.execute",
      expect.objectContaining({
        playbookRunId: "run-1",
        deviceId: "device-1",
        reason: "approval",
      }),
      expect.stringContaining("playbook.execute:run-1"),
      undefined,
    );
    expect(mocks.requestRuntimeJobProcessingMock).toHaveBeenCalledTimes(1);
  });
});
