import { computeDeviceStateHash, executeOperationWithGates } from "@/lib/adapters/execution-kernel";
import { stateStore } from "@/lib/state/store";
import { getMissingCredentialProtocolsForPlaybook } from "@/lib/adoption/playbook-credentials";
import type { Device, PlaybookRun, PlaybookStep, SafetyGateResult } from "@/lib/state/types";

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

function toRunningStep(step: PlaybookStep): PlaybookStep {
  return {
    ...step,
    status: "running",
    startedAt: new Date().toISOString(),
    gateResults: [],
  };
}

function toTerminalStep(step: PlaybookStep, status: PlaybookStep["status"], output: string, gates: SafetyGateResult[]): PlaybookStep {
  return {
    ...step,
    status,
    completedAt: new Date().toISOString(),
    output,
    gateResults: gates,
  };
}

async function executeStep(
  step: PlaybookStep,
  run: PlaybookRun,
  device: Device,
  expectedStateHash: string,
  params: Record<string, string>,
  idempotencySeed: string,
  approved: boolean,
): Promise<PlaybookStep> {
  const runtime = stateStore.getRuntimeSettings();
  const failures = recentFailureCount(device.id, run.family, runtime.quarantineThresholdWindowMs);

  const execution = await executeOperationWithGates(step.operation, device, {
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

  return toTerminalStep(
    step,
    execution.ok ? "passed" : "failed",
    `${execution.output}\n[gates] ${summarizeGateResults(execution.gateResults)}`.trim(),
    execution.gateResults,
  );
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
        logs: [
          ...run.evidence.logs,
          `Execution blocked: missing validated credentials for ${missingCredentials.join(", ")}`,
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
  const approved = run.status === "approved" || run.policyEvaluation.decision === "ALLOW_AUTO";

  const current: PlaybookRun = {
    ...run,
    status: "preflight",
    startedAt: now,
    evidence: {
      ...run.evidence,
      preSnapshot: {
        ...(run.evidence.preSnapshot ?? {}),
        stateHash: expectedStateHash,
        deviceId: device.id,
        deviceIp: device.ip,
        capturedAt: now,
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

  current.evidence.logs.push(`Preflight started for ${current.name} on ${device.name} (${device.ip})`);

  const existingFailures = recentFailureCount(device.id, current.family, runtime.quarantineThresholdWindowMs);
  if (existingFailures >= runtime.quarantineThresholdCount) {
    current.status = "quarantined";
    current.completedAt = new Date().toISOString();
    current.evidence.logs.push(
      `Quarantined: ${existingFailures} recent failures in ${Math.round(runtime.quarantineThresholdWindowMs / 1000)}s window`,
    );
    return current;
  }

  current.status = "executing";
  let executionPassed = true;

  for (let i = 0; i < current.steps.length; i++) {
    const step = toRunningStep(current.steps[i]);
    current.steps[i] = step;

    const result = await executeStep(
      step,
      current,
      device,
      expectedStateHash,
      params,
      `${current.id}:exec:${step.id}`,
      approved,
    );

    current.steps[i] = result;
    current.evidence.logs.push(`Step "${result.label}": ${result.status}`);

    if (result.gateResults) {
      current.evidence.gateResults?.push(...result.gateResults);
    }

    current.evidence.auditBundle?.operations.push({
      stepId: result.id,
      operationId: result.operation?.id ?? "unknown-operation",
      adapterId: result.operation?.adapterId ?? "unknown-adapter",
      mode: result.operation?.mode ?? "read",
      input: {
        deviceId: device.id,
        operation: result.operation ?? null,
      },
      output: result.output ?? "",
      ok: result.status === "passed",
      startedAt: result.startedAt ?? new Date().toISOString(),
      completedAt: result.completedAt ?? new Date().toISOString(),
      idempotencyKey: `${current.id}:${result.id}:${expectedStateHash}`,
    });

    if (result.status === "failed") {
      executionPassed = false;
      for (let j = i + 1; j < current.steps.length; j++) {
        current.steps[j] = { ...current.steps[j], status: "skipped" };
      }
      break;
    }
  }

  let verificationPassed = executionPassed;
  if (executionPassed) {
    current.status = "verifying";

    for (let i = 0; i < current.verificationSteps.length; i++) {
      const step = toRunningStep(current.verificationSteps[i]);
      current.verificationSteps[i] = step;

      const result = await executeStep(
        step,
        current,
        device,
        expectedStateHash,
        params,
        `${current.id}:verify:${step.id}`,
        approved,
      );

      current.verificationSteps[i] = result;
      current.evidence.logs.push(`Verification "${result.label}": ${result.status}`);

      if (result.gateResults) {
        current.evidence.gateResults?.push(...result.gateResults);
      }

      if (result.status === "failed") {
        verificationPassed = false;
        break;
      }
    }
  }

  if (verificationPassed) {
    current.status = "completed";
    current.completedAt = new Date().toISOString();
    current.evidence.postSnapshot = {
      ...(current.evidence.postSnapshot ?? {}),
      stateHash: computeDeviceStateHash(device),
      capturedAt: new Date().toISOString(),
    };
    current.evidence.logs.push("Postflight verification passed");
    return current;
  }

  if (current.rollbackSteps.length > 0) {
    current.status = "rolling_back";
    current.evidence.logs.push("Initiating rollback sequence");

    for (let i = 0; i < current.rollbackSteps.length; i++) {
      const step = toRunningStep(current.rollbackSteps[i]);
      current.rollbackSteps[i] = step;

      const result = await executeStep(
        step,
        {
          ...current,
          policyEvaluation: {
            ...current.policyEvaluation,
            decision: "ALLOW_AUTO",
            reason: "Rollback override",
          },
        },
        device,
        expectedStateHash,
        params,
        `${current.id}:rollback:${step.id}`,
        true,
      );

      current.rollbackSteps[i] = { ...result, status: result.status === "passed" ? "rolled_back" : "failed" };
      current.evidence.logs.push(`Rollback "${result.label}": ${result.status}`);

      if (result.gateResults) {
        current.evidence.gateResults?.push(...result.gateResults);
      }
    }
  }

  const failuresAfterRun = recentFailureCount(device.id, current.family, runtime.quarantineThresholdWindowMs) + 1;
  current.failureCount += 1;
  current.completedAt = new Date().toISOString();

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
