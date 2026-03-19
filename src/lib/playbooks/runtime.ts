import { computeDeviceStateHash, executeOperationWithGates } from "@/lib/adapters/execution-kernel";
import { getMissingCredentialProtocolsForPlaybook } from "@/lib/adoption/playbook-credentials";
import { stateStore } from "@/lib/state/store";
import type {
  Device,
  PlaybookRun,
  PlaybookStep,
  PlaybookWaitPhase,
  SafetyGateResult,
} from "@/lib/state/types";

interface WaitConditionConfig {
  pollIntervalMs: number;
  maxWaitMs: number;
  successRegex?: RegExp;
  failureRegex?: RegExp;
}

interface WaitConditionState {
  nextWakeAt: string;
  reason: string;
}

type StepOutcomeState = "passed" | "failed" | "waiting";

interface StepOutcome {
  state: StepOutcomeState;
  step: PlaybookStep;
  wait?: WaitConditionState;
}

type SequenceOutcomeState = "passed" | "failed" | "waiting";

function summarizeGateResults(results: SafetyGateResult[]): string {
  if (results.length === 0) return "no-gates";
  return results.map((item) => `${item.gate}:${item.passed ? "pass" : "fail"}`).join(",");
}

function recentFailureCount(deviceId: string, family: string, windowMs: number): number {
  const recent = stateStore.getPlaybookRuns({ deviceId });
  const cutoff = Date.now() - windowMs;

  return recent.filter((run) => {
    const completedAt = run.completedAt ? new Date(run.completedAt).getTime() : new Date(run.createdAt).getTime();
    return run.family === family && (run.status === "failed" || run.status === "quarantined") && completedAt >= cutoff;
  }).length;
}

function parseRegex(pattern: string | undefined): RegExp | undefined {
  if (!pattern) {
    return undefined;
  }
  try {
    return new RegExp(pattern, "i");
  } catch {
    return undefined;
  }
}

function waitConditionForStep(step: PlaybookStep): WaitConditionConfig | null {
  const args = step.operation.args ?? {};
  if (args.waitForCondition !== true) {
    return null;
  }

  const pollIntervalMs = typeof args.pollIntervalMs === "number" ? args.pollIntervalMs : Number(args.pollIntervalMs);
  const maxWaitMs = typeof args.maxWaitMs === "number" ? args.maxWaitMs : Number(args.maxWaitMs);
  if (!Number.isFinite(pollIntervalMs) || !Number.isFinite(maxWaitMs)) {
    return null;
  }

  return {
    pollIntervalMs: Math.max(5_000, Math.floor(pollIntervalMs)),
    maxWaitMs: Math.max(30_000, Math.floor(maxWaitMs)),
    ...(typeof args.successRegex === "string" ? { successRegex: parseRegex(args.successRegex) } : {}),
    ...(typeof args.failureRegex === "string" ? { failureRegex: parseRegex(args.failureRegex) } : {}),
  };
}

function toRunningStep(step: PlaybookStep): PlaybookStep {
  return {
    ...step,
    status: "running",
    startedAt: step.startedAt ?? new Date().toISOString(),
    completedAt: undefined,
    nextAttemptAt: undefined,
    gateResults: [],
  };
}

function toTerminalStep(
  step: PlaybookStep,
  status: PlaybookStep["status"],
  output: string,
  gates: SafetyGateResult[],
): PlaybookStep {
  return {
    ...step,
    status,
    completedAt: new Date().toISOString(),
    nextAttemptAt: undefined,
    output,
    gateResults: gates,
  };
}

function markWaitingStep(
  step: PlaybookStep,
  output: string,
  gates: SafetyGateResult[],
  nextWakeAt: string,
): PlaybookStep {
  return {
    ...step,
    status: "waiting",
    completedAt: undefined,
    nextAttemptAt: nextWakeAt,
    attempts: (step.attempts ?? 0) + 1,
    output,
    gateResults: gates,
  };
}

function recordOperation(run: PlaybookRun, device: Device, step: PlaybookStep, ok: boolean, expectedStateHash: string): void {
  run.evidence.auditBundle?.operations.push({
    stepId: step.id,
    operationId: step.operation?.id ?? "unknown-operation",
    adapterId: step.operation?.adapterId ?? "unknown-adapter",
    mode: step.operation?.mode ?? "read",
    input: {
      deviceId: device.id,
      operation: step.operation ?? null,
    },
    output: step.output ?? "",
    ok,
    startedAt: step.startedAt ?? new Date().toISOString(),
    completedAt: step.completedAt ?? new Date().toISOString(),
    idempotencyKey: `${run.id}:${step.id}:${expectedStateHash}`,
  });
}

function setWaitingState(
  run: PlaybookRun,
  phase: PlaybookWaitPhase,
  step: PlaybookStep,
  wait: WaitConditionState,
): void {
  run.status = "waiting";
  run.completedAt = undefined;
  run.evidence.waiting = {
    phase,
    stepId: step.id,
    label: step.label,
    nextWakeAt: wait.nextWakeAt,
    reason: wait.reason,
  };
  run.evidence.logs.push(`${phase} waiting on "${step.label}" until ${wait.nextWakeAt}: ${wait.reason}`);
}

function clearWaitingState(run: PlaybookRun): void {
  if (run.evidence.waiting) {
    delete run.evidence.waiting;
  }
}

async function executeStep(
  step: PlaybookStep,
  run: PlaybookRun,
  device: Device,
  expectedStateHash: string,
  params: Record<string, string>,
  idempotencySeed: string,
  approved: boolean,
): Promise<StepOutcome> {
  const runtime = stateStore.getRuntimeSettings();
  const failures = recentFailureCount(device.id, run.family, runtime.quarantineThresholdWindowMs);
  const activeStep = toRunningStep(step);

  const execution = await executeOperationWithGates(activeStep.operation, device, {
    actor: "steward",
    lane: run.policyEvaluation.inputs.lane ?? "A",
    actionClass: run.actionClass,
    blastRadius: run.policyEvaluation.inputs.blastRadius,
    policyDecision: run.policyEvaluation.decision,
    policyReason: run.policyEvaluation.reason,
    approved,
    expectedStateHash,
    runtimeSettings: runtime,
    recentFailures: failures,
    quarantineActive: run.status === "quarantined",
    idempotencySeed,
    playbookRunId: run.id,
    params,
  });

  const output = `${execution.output}\n[gates] ${summarizeGateResults(execution.gateResults)}`.trim();
  const waitCondition = waitConditionForStep(activeStep);
  if (!waitCondition) {
    return {
      state: execution.ok ? "passed" : "failed",
      step: toTerminalStep(activeStep, execution.ok ? "passed" : "failed", output, execution.gateResults),
    };
  }

  if (waitCondition.failureRegex?.test(output)) {
    return {
      state: "failed",
      step: toTerminalStep(activeStep, "failed", `${output}\nWait condition matched failure regex.`, execution.gateResults),
    };
  }

  const successMatched = execution.ok && (!waitCondition.successRegex || waitCondition.successRegex.test(output));
  if (successMatched) {
    return {
      state: "passed",
      step: toTerminalStep(activeStep, "passed", output, execution.gateResults),
    };
  }

  const startedAtMs = new Date(activeStep.startedAt ?? new Date().toISOString()).getTime();
  const elapsedMs = Date.now() - startedAtMs;
  if (elapsedMs >= waitCondition.maxWaitMs) {
    return {
      state: "failed",
      step: toTerminalStep(
        activeStep,
        "failed",
        `${output}\nWait condition timed out after ${Math.round(elapsedMs / 1000)}s.`,
        execution.gateResults,
      ),
    };
  }

  const nextWakeAt = new Date(Date.now() + waitCondition.pollIntervalMs).toISOString();
  return {
    state: "waiting",
    step: markWaitingStep(activeStep, output, execution.gateResults, nextWakeAt),
    wait: {
      nextWakeAt,
      reason: execution.ok
        ? "Condition probe completed but success criteria are not met yet."
        : "Condition probe did not succeed yet.",
    },
  };
}

async function executeSequence(args: {
  run: PlaybookRun;
  device: Device;
  steps: PlaybookStep[];
  phase: PlaybookWaitPhase;
  expectedStateHash: string;
  params: Record<string, string>;
  idempotencyPrefix: string;
  approved: boolean;
  rollbackOverride?: boolean;
}): Promise<SequenceOutcomeState> {
  const { run, device, steps, phase, expectedStateHash, params, idempotencyPrefix, approved, rollbackOverride } = args;
  run.status = phase === "execution"
    ? "executing"
    : phase === "verification"
      ? "verifying"
      : "rolling_back";

  for (let index = 0; index < steps.length; index += 1) {
    const existing = steps[index];
    if (existing.status === "passed" || existing.status === "rolled_back" || existing.status === "skipped") {
      continue;
    }

    const effectiveRun: PlaybookRun = rollbackOverride
      ? {
        ...run,
        policyEvaluation: {
          ...run.policyEvaluation,
          decision: "ALLOW_AUTO" as const,
          reason: "Rollback override",
        },
      }
      : run;
    const outcome = await executeStep(
      existing,
      effectiveRun,
      device,
      expectedStateHash,
      params,
      `${run.id}:${idempotencyPrefix}:${existing.id}`,
      rollbackOverride ? true : approved,
    );

    steps[index] = rollbackOverride && outcome.state === "passed"
      ? { ...outcome.step, status: "rolled_back" }
      : outcome.step;
    run.evidence.logs.push(`${phase === "verification" ? "Verification" : phase === "rollback" ? "Rollback" : "Step"} "${existing.label}": ${outcome.state}`);

    if (outcome.step.gateResults) {
      run.evidence.gateResults?.push(...outcome.step.gateResults);
    }

    recordOperation(run, device, steps[index], outcome.state === "passed", expectedStateHash);

    if (outcome.state === "waiting" && outcome.wait) {
      setWaitingState(run, phase, steps[index], outcome.wait);
      return "waiting";
    }

    if (outcome.state === "failed") {
      if (phase === "execution") {
        for (let next = index + 1; next < steps.length; next += 1) {
          steps[next] = { ...steps[next], status: "skipped" };
        }
      }
      clearWaitingState(run);
      return "failed";
    }
  }

  clearWaitingState(run);
  return "passed";
}

/**
 * Execute a playbook run through the mandatory lifecycle:
 * preflight -> execute -> verify -> rollback/quarantine
 */
export async function executePlaybook(
  run: PlaybookRun,
  device: Device,
  params: Record<string, string> = {},
): Promise<PlaybookRun> {
  const requiredProtocols = Array.from(
    new Set(
      run.steps
        .concat(run.verificationSteps)
        .concat(run.rollbackSteps)
        .map((step) => step.operation.adapterId)
        .filter((value) => typeof value === "string" && value.trim().length > 0),
    ),
  );
  const missingCredentials = getMissingCredentialProtocolsForPlaybook(device, {
    preconditions: { requiredProtocols },
  });
  if (missingCredentials.length > 0) {
    return {
      ...run,
      status: "failed",
      completedAt: new Date().toISOString(),
      evidence: {
        ...run.evidence,
        waiting: undefined,
        logs: [
          ...run.evidence.logs,
          `Execution blocked: missing stored credentials for ${missingCredentials.join(", ")}`,
        ],
      },
      failureCount: run.failureCount + 1,
    };
  }

  const runtime = stateStore.getRuntimeSettings();
  const now = new Date().toISOString();
  const lane = run.policyEvaluation.inputs.lane ?? "A";
  const expectedStateHash = run.evidence.preSnapshot?.stateHash
    ? String(run.evidence.preSnapshot.stateHash)
    : computeDeviceStateHash(device);
  const approved = run.policyEvaluation.decision === "ALLOW_AUTO"
    || run.status === "approved"
    || Boolean(run.approvedAt);

  const current: PlaybookRun = {
    ...run,
    status: run.status === "waiting" ? "waiting" : "preflight",
    startedAt: run.startedAt ?? now,
    evidence: {
      ...run.evidence,
      preSnapshot: {
        ...(run.evidence.preSnapshot ?? {}),
        stateHash: expectedStateHash,
        deviceId: device.id,
        deviceIp: device.ip,
        capturedAt: run.evidence.preSnapshot?.capturedAt ?? now,
      },
      logs: [...run.evidence.logs],
      gateResults: [...(run.evidence.gateResults ?? [])],
      auditBundle: {
        actor: "steward",
        lane,
        rationale: run.policyEvaluation.reason,
        operations: [...(run.evidence.auditBundle?.operations ?? [])],
      },
    },
  };

  if (run.evidence.logs.length === 0) {
    current.evidence.logs.push(`Preflight started for ${current.name} on ${device.name} (${device.ip})`);
  }

  const existingFailures = recentFailureCount(device.id, current.family, runtime.quarantineThresholdWindowMs);
  if (existingFailures >= runtime.quarantineThresholdCount) {
    current.status = "quarantined";
    current.completedAt = new Date().toISOString();
    clearWaitingState(current);
    current.evidence.logs.push(
      `Quarantined: ${existingFailures} recent failures in ${Math.round(runtime.quarantineThresholdWindowMs / 1000)}s window`,
    );
    return current;
  }

  const executionOutcome = await executeSequence({
    run: current,
    device,
    steps: current.steps,
    phase: "execution",
    expectedStateHash,
    params,
    idempotencyPrefix: "exec",
    approved,
  });
  if (executionOutcome === "waiting") {
    return current;
  }

  let verificationPassed = executionOutcome === "passed";
  if (verificationPassed) {
    const verificationOutcome = await executeSequence({
      run: current,
      device,
      steps: current.verificationSteps,
      phase: "verification",
      expectedStateHash,
      params,
      idempotencyPrefix: "verify",
      approved,
    });
    if (verificationOutcome === "waiting") {
      return current;
    }
    verificationPassed = verificationOutcome === "passed";
  }

  if (verificationPassed) {
    current.status = "completed";
    current.completedAt = new Date().toISOString();
    clearWaitingState(current);
    current.evidence.postSnapshot = {
      ...(current.evidence.postSnapshot ?? {}),
      stateHash: computeDeviceStateHash(device),
      capturedAt: new Date().toISOString(),
    };
    current.evidence.logs.push("Postflight verification passed");
    return current;
  }

  if (current.rollbackSteps.length > 0) {
    current.evidence.logs.push("Initiating rollback sequence");
    const rollbackOutcome = await executeSequence({
      run: current,
      device,
      steps: current.rollbackSteps,
      phase: "rollback",
      expectedStateHash,
      params,
      idempotencyPrefix: "rollback",
      approved: true,
      rollbackOverride: true,
    });
    if (rollbackOutcome === "waiting") {
      return current;
    }
  }

  const failuresAfterRun = recentFailureCount(device.id, current.family, runtime.quarantineThresholdWindowMs) + 1;
  current.failureCount += 1;
  current.completedAt = new Date().toISOString();
  clearWaitingState(current);

  if (failuresAfterRun >= runtime.quarantineThresholdCount) {
    current.status = "quarantined";
    current.evidence.logs.push(
      `Quarantine threshold reached (${failuresAfterRun}/${runtime.quarantineThresholdCount})`,
    );
  } else {
    current.status = "failed";
    current.evidence.logs.push(`Playbook failed (failure count: ${current.failureCount})`);
  }

  current.evidence.postSnapshot = {
    ...(current.evidence.postSnapshot ?? {}),
    stateHash: computeDeviceStateHash(device),
    capturedAt: new Date().toISOString(),
  };

  return current;
}
