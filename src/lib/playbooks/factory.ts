import { randomUUID } from "node:crypto";
import { stateStore } from "@/lib/state/store";
import type {
  ActionClass,
  PlaybookDefinition,
  PlaybookRun,
  PlaybookStep,
  PolicyEvaluation,
} from "@/lib/state/types";

export function criticalityForActionClass(actionClass: ActionClass): "low" | "medium" | "high" {
  if (actionClass === "A") return "low";
  if (actionClass === "B") return "medium";
  return "high";
}

export function countRecentFamilyFailures(deviceId: string, family: string): number {
  const runtime = stateStore.getRuntimeSettings();
  const cutoff = Date.now() - runtime.quarantineThresholdWindowMs;
  return stateStore.getPlaybookRuns({ deviceId }).filter((run) => {
    const at = run.completedAt ? new Date(run.completedAt).getTime() : new Date(run.createdAt).getTime();
    return run.family === family && (run.status === "failed" || run.status === "quarantined") && at >= cutoff;
  }).length;
}

export function isFamilyQuarantined(deviceId: string, family: string): boolean {
  const runtime = stateStore.getRuntimeSettings();
  const failures = countRecentFamilyFailures(deviceId, family);
  return failures >= runtime.quarantineThresholdCount;
}

export function buildPlaybookRun(
  playbook: PlaybookDefinition,
  options: {
    deviceId: string;
    incidentId?: string;
    policyEvaluation: PolicyEvaluation;
    initialStatus: PlaybookRun["status"];
    lane: "A" | "B" | "C";
  },
): PlaybookRun {
  const createdAt = new Date().toISOString();
  const toRunStep = (step: Omit<PlaybookStep, "status" | "output" | "startedAt" | "completedAt" | "gateResults">): PlaybookStep => ({
    ...step,
    status: "pending",
    gateResults: [],
  });

  return {
    id: randomUUID(),
    playbookId: playbook.id,
    family: playbook.family,
    name: playbook.name,
    deviceId: options.deviceId,
    incidentId: options.incidentId,
    actionClass: playbook.actionClass,
    status: options.initialStatus,
    policyEvaluation: {
      ...options.policyEvaluation,
      inputs: {
        ...options.policyEvaluation.inputs,
        lane: options.lane,
      },
    },
    steps: playbook.steps.map(toRunStep),
    verificationSteps: playbook.verificationSteps.map(toRunStep),
    rollbackSteps: playbook.rollbackSteps.map(toRunStep),
    evidence: {
      logs: [],
      gateResults: [],
      auditBundle: {
        actor: "steward",
        lane: options.lane,
        rationale: options.policyEvaluation.reason,
        operations: [],
      },
    },
    createdAt,
    updatedAt: createdAt,
    failureCount: 0,
  };
}
