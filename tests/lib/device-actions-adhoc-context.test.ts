import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Device, PlaybookDefinition, PlaybookRun } from "@/lib/state/types";

const mocks = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  generateTextMock: vi.fn(),
  buildLanguageModelMock: vi.fn(),
  getRecentActionsMock: vi.fn(),
  getPolicyRulesMock: vi.fn(),
  getMaintenanceWindowsMock: vi.fn(),
  addActionMock: vi.fn(),
  upsertDeviceFindingByDedupeMock: vi.fn(),
  evaluatePolicyMock: vi.fn(),
  createApprovalMock: vi.fn(),
  buildPlaybookRunMock: vi.fn(),
  queuePlaybookExecutionMock: vi.fn(),
  getMissingCredentialProtocolsForPlaybookMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateObject: mocks.generateObjectMock,
    generateText: mocks.generateTextMock,
  };
});

vi.mock("@/lib/llm/providers", () => ({
  buildLanguageModel: mocks.buildLanguageModelMock,
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getRecentActions: mocks.getRecentActionsMock,
    getPolicyRules: mocks.getPolicyRulesMock,
    getMaintenanceWindows: mocks.getMaintenanceWindowsMock,
    getPlaybookRunById: vi.fn(() => null),
    addAction: mocks.addActionMock,
    upsertDeviceFindingByDedupe: mocks.upsertDeviceFindingByDedupeMock,
    upsertPlaybookRun: vi.fn(),
  },
}));

vi.mock("@/lib/policy/engine", () => ({
  evaluatePolicy: mocks.evaluatePolicyMock,
}));

vi.mock("@/lib/approvals/queue", () => ({
  approveAction: vi.fn(),
  createApproval: mocks.createApprovalMock,
  denyAction: vi.fn(),
}));

vi.mock("@/lib/playbooks/factory", () => ({
  buildPlaybookRun: mocks.buildPlaybookRunMock,
  countRecentFamilyFailures: vi.fn(() => 0),
  isFamilyQuarantined: vi.fn(() => false),
}));

vi.mock("@/lib/playbooks/orchestrator", () => ({
  queuePlaybookExecution: mocks.queuePlaybookExecutionMock,
}));

vi.mock("@/lib/adoption/playbook-credentials", () => ({
  getMissingCredentialProtocolsForPlaybook: mocks.getMissingCredentialProtocolsForPlaybookMock,
}));

vi.mock("@/lib/monitoring/contracts", () => ({
  buildCustomMonitorContractFromPrompt: vi.fn(),
  getRequiredProtocolsForServiceContract: vi.fn(() => []),
}));

import { tryHandleDeviceChatAction } from "@/lib/assistant/device-actions";

function buildDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: "device-1",
    name: "GitLab Server",
    ip: "10.0.0.64",
    type: "container-host",
    status: "online",
    autonomyTier: 1,
    environmentLabel: "lab",
    tags: [],
    protocols: ["ssh", "http-api"],
    services: [],
    firstSeenAt: "2026-03-19T09:00:00.000Z",
    lastSeenAt: "2026-03-19T09:00:00.000Z",
    lastChangedAt: "2026-03-19T09:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function userMessage(content: string): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId: "session-1",
    role: "user",
    content,
    error: false,
    createdAt: "2026-03-19T09:41:00.000Z",
  };
}

function assistantMessage(content: string): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId: "session-1",
    role: "assistant",
    content,
    provider: "anthropic",
    error: false,
    createdAt: "2026-03-19T09:42:00.000Z",
  };
}

describe("device chat adhoc task context resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildLanguageModelMock.mockResolvedValue({} as never);
    mocks.generateTextMock.mockReset();
    mocks.getRecentActionsMock.mockReturnValue([]);
    mocks.getPolicyRulesMock.mockReturnValue([]);
    mocks.getMaintenanceWindowsMock.mockReturnValue([]);
    mocks.addActionMock.mockResolvedValue(undefined);
    mocks.getMissingCredentialProtocolsForPlaybookMock.mockReturnValue([]);
    mocks.evaluatePolicyMock.mockReturnValue({
      decision: "REQUIRE_APPROVAL",
      ruleId: "default:tier1-gate",
      reason: 'Matched rule "Tier 1 - Gate all mutations" (priority 11)',
      riskScore: 0.84,
      riskFactors: ["class-c-config-change"],
      evaluatedAt: "2026-03-19T14:24:22.946Z",
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
    });
    mocks.buildPlaybookRunMock.mockImplementation((playbook: PlaybookDefinition) => ({
      id: "run-1",
      playbookId: playbook.id,
      family: playbook.family,
      name: playbook.name,
      deviceId: "device-1",
      actionClass: playbook.actionClass,
      status: "pending_approval",
      policyEvaluation: mocks.evaluatePolicyMock.mock.results[0]?.value,
      steps: playbook.steps.map((step) => ({ ...step, status: "pending", gateResults: [] })),
      verificationSteps: playbook.verificationSteps.map((step) => ({ ...step, status: "pending", gateResults: [] })),
      rollbackSteps: playbook.rollbackSteps.map((step) => ({ ...step, status: "pending", gateResults: [] })),
      evidence: {
        logs: [],
        gateResults: [],
        auditBundle: {
          actor: "steward",
          lane: "A",
          rationale: 'Matched rule "Tier 1 - Gate all mutations" (priority 11)',
          operations: [],
        },
      },
      createdAt: "2026-03-19T14:24:22.947Z",
      updatedAt: "2026-03-19T14:24:22.947Z",
      failureCount: 0,
    } satisfies PlaybookRun));
    mocks.createApprovalMock.mockImplementation((run: PlaybookRun) => run);
  });

  it("resolves shorthand retries against prior conversation context before planning", async () => {
    const normalizedRequest = "Upgrade GitLab Community Edition on this host from 16.11.10 to the latest supported version, including required intermediary upgrade stops, backups, background migration waits, and post-upgrade verification.";

    mocks.generateObjectMock
      .mockResolvedValueOnce({
        object: {
          intent: "adhoc_task",
          rationale: "The user is asking Steward to execute a governed device job now.",
          approvalDecision: null,
          deviceSettings: {
            renameRequested: false,
            categoryRequested: false,
            suggestedName: null,
            suggestedType: null,
          },
        },
      })
      .mockResolvedValueOnce({
        object: {
          normalizedRequest,
          source: "conversation_context",
          rationale: "The latest message is a retry of the previously requested GitLab upgrade job.",
        },
      })
      .mockResolvedValueOnce({
        object: {
          family: "gitlab-upgrade",
          rationale: "Upgrade GitLab through the required version stops and verify health at the end.",
          actionClass: "C",
          criticality: "medium",
          blastRadius: "single-device",
          requiredProtocol: "ssh",
          mutateSteps: [
            {
              label: "Back up GitLab",
              commandTemplate: "ssh {{host}} 'sudo gitlab-backup create'",
              mode: "mutate",
            },
          ],
          verifySteps: [
            {
              label: "Verify GitLab health",
              commandTemplate: "ssh {{host}} 'sudo gitlab-rake gitlab:check'",
              mode: "read",
            },
          ],
          rollbackSteps: [],
        },
      });

    const result = await tryHandleDeviceChatAction({
      input: "try again",
      provider: "anthropic",
      attachedDevice: buildDevice(),
      history: [
        userMessage("create a job to do the complete update"),
        assistantMessage("I drafted the task but policy denied it: Matched rule \"Tier 1 - Gate all mutations\" (priority 11)"),
      ],
      sessionId: "session-1",
    });

    expect(result.handled).toBe(true);
    expect(result.metadata?.normalizedRequest).toBe(normalizedRequest);
    expect(String(mocks.generateObjectMock.mock.calls[2]?.[0]?.prompt ?? "")).toContain(normalizedRequest);
    expect(String(mocks.generateObjectMock.mock.calls[2]?.[0]?.prompt ?? "")).toContain("create a job to do the complete update");

    const approvedRun = mocks.createApprovalMock.mock.calls[0]?.[0] as PlaybookRun | undefined;
    expect(approvedRun?.evidence.preSnapshot).toMatchObject({
      sourceRequest: "try again",
      normalizedRequest,
      requestResolutionSource: "conversation_context",
    });
  });

  it("builds a GitLab upgrade run from the researched thread context", async () => {
    const normalizedRequest = "Create and execute a GitLab upgrade job on the container host (10.0.0.64) to upgrade GitLab from version 16.11.10 to current (18.7) following the upgrade path: 16.11.10 -> 17.0.z -> 17.11.z -> 18.0.z -> 18.7.z, including database migrations at each major version stop, with appropriate downtime planning and post-upgrade verification.";

    mocks.generateObjectMock
      .mockResolvedValueOnce({
        object: {
          intent: "none",
          rationale: "The phrase could refer to several kinds of work.",
          approvalDecision: null,
          deviceSettings: {
            renameRequested: false,
            categoryRequested: false,
            suggestedName: null,
            suggestedType: null,
          },
        },
      })
      .mockResolvedValueOnce({
        object: {
          intent: "adhoc_task",
          rationale: "The user is delegating the previously discussed GitLab upgrade as a governed job.",
          approvalDecision: null,
          deviceSettings: {
            renameRequested: false,
            categoryRequested: false,
            suggestedName: null,
            suggestedType: null,
          },
        },
      })
      .mockResolvedValueOnce({
        object: {
          normalizedRequest: null,
          source: "ambiguous",
          rationale: "The request is missing maintenance-window confirmation and backup confirmation.",
        },
      })
      .mockResolvedValueOnce({
        object: {
          normalizedRequest,
          source: "conversation_context",
          rationale: "The latest message clearly refers back to the researched GitLab upgrade thread, and missing scheduling details can be handled later by approval and policy.",
        },
      })
      .mockResolvedValueOnce({
        object: {
          family: "gitlab-upgrade",
          rationale: "Upgrade GitLab through each required stop, waiting for migrations and verifying health at the end.",
          actionClass: "C",
          criticality: "medium",
          blastRadius: "single-device",
          requiredProtocol: "ssh",
          mutateSteps: [
            {
              label: "Create GitLab backup",
              commandTemplate: "ssh {{host}} 'sudo gitlab-backup create'",
              mode: "mutate",
            },
            {
              label: "Upgrade to 17.0 latest patch",
              commandTemplate: "ssh {{host}} 'sudo apt-get update && sudo apt-get install -y gitlab-ce=17.0.8-ce.0'",
              mode: "mutate",
            },
            {
              label: "Wait for GitLab background migrations after 17.0",
              commandTemplate: "ssh {{host}} 'sudo gitlab-rake gitlab:background_migrations:status'",
              mode: "read",
              waitForCondition: true,
              pollIntervalMs: 60000,
              maxWaitMs: 14400000,
              successRegex: "finished|no pending",
            },
          ],
          verifySteps: [
            {
              label: "Verify GitLab health",
              commandTemplate: "ssh {{host}} 'sudo gitlab-rake gitlab:check'",
              mode: "read",
            },
          ],
          rollbackSteps: [],
        },
      });

    mocks.getRecentActionsMock.mockReturnValue([
      {
        id: "action-1",
        at: "2026-03-19T15:25:35.355Z",
        actor: "steward",
        kind: "playbook",
        message: "Failed to build ad-hoc task plan on GitLab Server (10.0.0.64)",
        context: {
          sessionId: "session-2",
          deviceId: "device-1",
          sourceRequest: "create a job to get this done",
          normalizedRequest,
          requestResolution: {
            normalizedRequest,
            source: "conversation_context",
            rationale: "The concrete task is the GitLab upgrade previously discussed in the thread.",
          },
        },
      },
    ]);

    const result = await tryHandleDeviceChatAction({
      input: "create a job to get this done",
      provider: "anthropic",
      attachedDevice: buildDevice(),
      history: [
        userMessage("what version of gitlab are we running and whats the complete upgrade path to current?"),
        assistantMessage("GitLab 16.11.10 is installed and the upgrade path to current (18.7) is 16.11.10 -> 17.0.z -> 17.11.z -> 18.0.z -> 18.7.z."),
      ],
      sessionId: "session-2",
    });

    expect(result.handled).toBe(true);
    expect(result.metadata?.normalizedRequest).toBe(normalizedRequest);
    expect(String(mocks.generateObjectMock.mock.calls[0]?.[0]?.prompt ?? "")).toContain("Recent task signals:");
    expect(String(mocks.generateObjectMock.mock.calls[1]?.[0]?.prompt ?? "")).toContain("Previous classification:");
    expect(String(mocks.generateObjectMock.mock.calls[3]?.[0]?.prompt ?? "")).toContain("Previous resolution:");
    expect(String(mocks.generateObjectMock.mock.calls[4]?.[0]?.prompt ?? "")).toContain("16.11.10 -> 17.0.z -> 17.11.z -> 18.0.z -> 18.7.z");

    const run = mocks.createApprovalMock.mock.calls[0]?.[0] as PlaybookRun | undefined;
    expect(run?.steps[0]?.label).toBe("Create GitLab backup");
    expect(run?.steps[1]?.label).toBe("Upgrade to 17.0 latest patch");
  });

  it("enforces step-count limits locally instead of relying on provider array caps", async () => {
    const normalizedRequest = "Upgrade GitLab from 16.11.10 to 18.9 using the required intermediary stops, backups, waits, and verification.";
    const oversizedMutateSteps = Array.from({ length: 20 }, (_, index) => ({
      label: `Mutate step ${index + 1}`,
      commandTemplate: `ssh {{host}} 'echo mutate-${index + 1}'`,
      mode: "mutate" as const,
    }));
    const oversizedVerifySteps = Array.from({ length: 18 }, (_, index) => ({
      label: `Verify step ${index + 1}`,
      commandTemplate: `ssh {{host}} 'echo verify-${index + 1}'`,
      mode: "read" as const,
    }));
    const oversizedRollbackSteps = Array.from({ length: 19 }, (_, index) => ({
      label: `Rollback step ${index + 1}`,
      commandTemplate: `ssh {{host}} 'echo rollback-${index + 1}'`,
      mode: "mutate" as const,
    }));

    mocks.generateObjectMock
      .mockResolvedValueOnce({
        object: {
          intent: "adhoc_task",
          rationale: "The user is delegating the GitLab upgrade now.",
          approvalDecision: null,
          deviceSettings: {
            renameRequested: false,
            categoryRequested: false,
            suggestedName: null,
            suggestedType: null,
          },
        },
      })
      .mockResolvedValueOnce({
        object: {
          normalizedRequest,
          source: "conversation_context",
          rationale: "The request is the GitLab upgrade already established in the thread.",
        },
      })
      .mockResolvedValueOnce({
        object: {
          family: "gitlab-upgrade",
          rationale: "Upgrade GitLab through the required stops.",
          actionClass: "C",
          criticality: "medium",
          blastRadius: "single-device",
          requiredProtocol: "ssh",
          mutateSteps: oversizedMutateSteps,
          verifySteps: oversizedVerifySteps,
          rollbackSteps: oversizedRollbackSteps,
        },
      });

    const result = await tryHandleDeviceChatAction({
      input: "create a job to get this done immediately. i want to get to the latest version",
      provider: "anthropic",
      attachedDevice: buildDevice(),
      history: [
        userMessage("what version of gitlab is currently running"),
        assistantMessage("GitLab 16.11.10 is currently installed."),
        userMessage("i want to upgrade this to the latest, what is the required path"),
        assistantMessage("The required path is 16.11.10 -> 17.0.x -> 17.11.x -> 18.0.x -> 18.9."),
      ],
      sessionId: "session-3",
    });

    expect(result.handled).toBe(true);
    expect(result.metadata?.normalizedRequest).toBe(normalizedRequest);

    const run = mocks.createApprovalMock.mock.calls[0]?.[0] as PlaybookRun | undefined;
    expect(run?.steps).toHaveLength(16);
    expect(run?.verificationSteps).toHaveLength(16);
    expect(run?.rollbackSteps).toHaveLength(16);
    expect(run?.steps[15]?.label).toBe("Mutate step 16");
    expect(run?.verificationSteps[15]?.label).toBe("Verify step 16");
    expect(run?.rollbackSteps[15]?.label).toBe("Rollback step 16");
  });

  it("clamps wait-step polling bounds locally instead of relying on provider integer constraints", async () => {
    const normalizedRequest = "Upgrade GitLab from 16.11.10 to 18.9 with background migration waits and health checks.";

    mocks.generateObjectMock
      .mockResolvedValueOnce({
        object: {
          intent: "adhoc_task",
          rationale: "The user is delegating the GitLab upgrade now.",
          approvalDecision: null,
          deviceSettings: {
            renameRequested: false,
            categoryRequested: false,
            suggestedName: null,
            suggestedType: null,
          },
        },
      })
      .mockResolvedValueOnce({
        object: {
          normalizedRequest,
          source: "conversation_context",
          rationale: "The request is the GitLab upgrade already established in the thread.",
        },
      })
      .mockResolvedValueOnce({
        object: {
          family: "gitlab-upgrade",
          rationale: "Upgrade GitLab through the required stops.",
          actionClass: "C",
          criticality: "medium",
          blastRadius: "single-device",
          requiredProtocol: "ssh",
          mutateSteps: [
            {
              label: "Upgrade to 17.0 latest patch",
              commandTemplate: "ssh {{host}} 'sudo apt-get install -y gitlab-ce=17.0.8-ce.0'",
              mode: "mutate",
            },
          ],
          verifySteps: [
            {
              label: "Wait for GitLab background migrations",
              commandTemplate: "ssh {{host}} 'sudo gitlab-rake gitlab:background_migrations:status'",
              mode: "read",
              waitForCondition: true,
              pollIntervalMs: 1000,
              maxWaitMs: 999999999,
              successRegex: "finished|no pending",
            },
          ],
          rollbackSteps: [],
        },
      });

    const result = await tryHandleDeviceChatAction({
      input: "create a job to get this done immediately. i want to get to the latest version",
      provider: "anthropic",
      attachedDevice: buildDevice(),
      history: [
        userMessage("what version of gitlab is currently running"),
        assistantMessage("GitLab 16.11.10 is currently installed."),
        userMessage("i want to upgrade this to the latest, what is the required path"),
        assistantMessage("The required path is 16.11.10 -> 17.0.x -> 17.11.x -> 18.0.x -> 18.9."),
      ],
      sessionId: "session-4",
    });

    expect(result.handled).toBe(true);

    const run = mocks.createApprovalMock.mock.calls[0]?.[0] as PlaybookRun | undefined;
    const waitStep = run?.verificationSteps[0];
    expect(waitStep?.operation.args).toMatchObject({
      waitForCondition: true,
      pollIntervalMs: 5000,
      maxWaitMs: 259200000,
      successRegex: "finished|no pending",
    });
  });

  it("repairs malformed planner text into a valid GitLab upgrade run", async () => {
    const { NoObjectGeneratedError } = await import("ai");
    const normalizedRequest = "Upgrade GitLab from 16.11.10 to 18.9 using the required intermediary stops, backups, waits, and verification.";

    mocks.generateObjectMock
      .mockResolvedValueOnce({
        object: {
          intent: "adhoc_task",
          rationale: "The user is delegating the GitLab upgrade now.",
          approvalDecision: null,
          deviceSettings: {
            renameRequested: false,
            categoryRequested: false,
            suggestedName: null,
            suggestedType: null,
          },
        },
      })
      .mockResolvedValueOnce({
        object: {
          normalizedRequest,
          source: "conversation_context",
          rationale: "The request is the GitLab upgrade already established in the thread.",
        },
      })
      .mockRejectedValueOnce(new NoObjectGeneratedError({
        message: "No object generated: could not parse the response.",
        text: "family: gitlab-upgrade\nsteps: backup, upgrade, verify",
        response: {} as never,
        usage: {} as never,
        finishReason: "stop",
      }));

    mocks.generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        family: "gitlab-upgrade",
        rationale: "Upgrade GitLab through each required stop and verify health.",
        actionClass: "C",
        criticality: "medium",
        blastRadius: "single-device",
        requiredProtocol: "ssh",
        mutateSteps: [
          {
            label: "Create GitLab backup",
            commandTemplate: "ssh {{host}} 'sudo gitlab-backup create'",
            mode: "mutate",
          },
        ],
        verifySteps: [
          {
            label: "Verify GitLab health",
            commandTemplate: "ssh {{host}} 'sudo gitlab-rake gitlab:check'",
            mode: "read",
          },
        ],
        rollbackSteps: [],
      }),
    });

    const result = await tryHandleDeviceChatAction({
      input: "try again",
      provider: "anthropic",
      attachedDevice: buildDevice(),
      history: [
        userMessage("create a job to get this done immediately. i want to get to the latest version"),
        assistantMessage("The required path is 16.11.10 -> 17.0.x -> 17.11.x -> 18.0.x -> 18.9."),
      ],
      sessionId: "session-5",
    });

    expect(result.handled).toBe(true);
    expect(mocks.generateTextMock).toHaveBeenCalledTimes(1);

    const run = mocks.createApprovalMock.mock.calls[0]?.[0] as PlaybookRun | undefined;
    expect(run?.steps[0]?.label).toBe("Create GitLab backup");
    expect(run?.verificationSteps[0]?.label).toBe("Verify GitLab health");
  });
});
