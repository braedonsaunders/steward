import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Device, PlaybookRun } from "@/lib/state/types";

vi.mock("@/lib/adapters/execution-kernel", () => ({
  computeDeviceStateHash: vi.fn(() => "state-hash"),
  executeOperationWithGates: vi.fn(),
}));

vi.mock("@/lib/adoption/playbook-credentials", () => ({
  getMissingCredentialProtocolsForPlaybook: vi.fn(() => []),
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getRuntimeSettings: vi.fn(() => ({
      quarantineThresholdWindowMs: 60_000,
      quarantineThresholdCount: 3,
    })),
    getPlaybookRuns: vi.fn(() => []),
  },
}));

import { executeOperationWithGates } from "@/lib/adapters/execution-kernel";
import { executePlaybook } from "@/lib/playbooks/runtime";

const now = "2026-03-18T19:00:00.000Z";

function buildRun(): PlaybookRun {
  return {
    id: "run-1",
    playbookId: "playbook-1",
    family: "gitlab-upgrade",
    name: "GitLab upgrade",
    deviceId: "device-1",
    actionClass: "D",
    status: "approved",
    policyEvaluation: {
      decision: "ALLOW_AUTO",
      ruleId: null,
      reason: "Allowed for test",
      riskScore: 0.1,
      riskFactors: [],
      evaluatedAt: now,
      inputs: {
        actionClass: "D",
        autonomyTier: 2,
        environmentLabel: "prod",
        inMaintenanceWindow: true,
        deviceId: "device-1",
        blastRadius: "single-device",
        criticality: "high",
        lane: "A",
        recentFailures: 0,
        quarantineActive: false,
      },
    },
    steps: [
      {
        id: "step-wait",
        label: "Wait for GitLab background migrations",
        status: "pending",
        gateResults: [],
        operation: {
          id: "op-wait",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 60_000,
          commandTemplate: "ssh {{host}} 'sudo gitlab-rake gitlab:background_migrations:status'",
          args: {
            waitForCondition: true,
            pollIntervalMs: 60_000,
            maxWaitMs: 3_600_000,
            successRegex: "finished|no pending",
          },
          expectedSemanticTarget: "chat-adhoc-task",
          safety: {
            dryRunSupported: false,
            requiresConfirmedRevert: false,
            criticality: "low",
          },
        },
      },
    ],
    verificationSteps: [],
    rollbackSteps: [],
    evidence: {
      logs: [],
      gateResults: [],
      auditBundle: {
        actor: "steward",
        lane: "A",
        rationale: "Allowed for test",
        operations: [],
      },
    },
    createdAt: now,
    updatedAt: now,
    failureCount: 0,
  };
}

const device = {
  id: "device-1",
  name: "GitLab Server",
  ip: "10.0.0.64",
} as Device;

describe("executePlaybook wait checkpoints", () => {
  beforeEach(() => {
    vi.mocked(executeOperationWithGates).mockReset();
  });

  it("persists a waiting state and resumes to completion", async () => {
    vi.mocked(executeOperationWithGates)
      .mockResolvedValueOnce({
        ok: true,
        status: "succeeded",
        phase: "executed",
        proof: "response",
        summary: "Condition probe completed",
        output: "still running",
        details: {},
        gateResults: [],
        idempotencyKey: "k1",
        startedAt: now,
        completedAt: now,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: "succeeded",
        phase: "executed",
        proof: "response",
        summary: "Condition probe completed",
        output: "finished",
        details: {},
        gateResults: [],
        idempotencyKey: "k2",
        startedAt: now,
        completedAt: now,
      });

    const waitingRun = await executePlaybook(buildRun(), device);
    expect(waitingRun.status).toBe("waiting");
    expect(waitingRun.evidence.waiting?.label).toBe("Wait for GitLab background migrations");
    expect(waitingRun.steps[0]?.status).toBe("waiting");
    expect(waitingRun.steps[0]?.nextAttemptAt).toBeTruthy();

    const completedRun = await executePlaybook(waitingRun, device);
    expect(completedRun.status).toBe("completed");
    expect(completedRun.evidence.waiting).toBeUndefined();
    expect(completedRun.steps[0]?.status).toBe("passed");
  });
});
