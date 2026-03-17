import { executePlaybook } from "@/lib/playbooks/runtime";
import { stateStore } from "@/lib/state/store";
import type { Device, PlaybookRun } from "@/lib/state/types";

export const PLAYBOOK_EXECUTE_JOB_KIND = "playbook.execute";

function executionStamp(run: PlaybookRun): string {
  return run.approvedAt ?? run.createdAt;
}

function terminalStatus(status: PlaybookRun["status"]): boolean {
  return ["completed", "failed", "denied", "quarantined"].includes(status);
}

function runWithTimestamp(run: PlaybookRun): PlaybookRun {
  const now = new Date().toISOString();
  return {
    ...run,
    updatedAt: now,
  };
}

export function queuePlaybookExecution(
  run: PlaybookRun,
  reason: "auto" | "approval" | "reconcile" = "reconcile",
): void {
  stateStore.enqueueDurableJob(
    PLAYBOOK_EXECUTE_JOB_KIND,
    {
      playbookRunId: run.id,
      deviceId: run.deviceId,
      reason,
      requestedAt: new Date().toISOString(),
    },
    `${PLAYBOOK_EXECUTE_JOB_KIND}:${run.id}:${executionStamp(run)}`,
  );
}

export function queueApprovedPlaybookRuns(): number {
  const runs = stateStore.getPlaybookRuns({ status: "approved" });
  for (const run of runs) {
    queuePlaybookExecution(run, "reconcile");
  }
  return runs.length;
}

export async function executeQueuedPlaybookRun(payload: Record<string, unknown>): Promise<{
  status: PlaybookRun["status"] | "skipped";
  summary: string;
  run?: PlaybookRun;
  device?: Device;
}> {
  const runId = typeof payload.playbookRunId === "string" ? payload.playbookRunId : "";
  if (!runId) {
    return {
      status: "skipped",
      summary: "Playbook execution job missing playbookRunId.",
    };
  }

  const run = stateStore.getPlaybookRunById(runId);
  if (!run) {
    return {
      status: "skipped",
      summary: `Playbook run ${runId} no longer exists.`,
    };
  }

  if (terminalStatus(run.status)) {
    return {
      status: "skipped",
      summary: `Playbook run ${run.id} is already ${run.status}.`,
      run,
    };
  }

  if (run.status !== "approved") {
    return {
      status: "skipped",
      summary: `Playbook run ${run.id} is ${run.status}, not executable.`,
      run,
    };
  }

  const device = stateStore.getDeviceById(run.deviceId);
  if (!device) {
    const failed = runWithTimestamp({
      ...run,
      status: "failed",
      completedAt: new Date().toISOString(),
      failureCount: run.failureCount + 1,
      evidence: {
        ...run.evidence,
        logs: [...run.evidence.logs, "Execution failed: target device no longer exists."],
      },
    });
    stateStore.upsertPlaybookRun(failed);
    return {
      status: failed.status,
      summary: `Playbook ${run.name} failed because device ${run.deviceId} no longer exists.`,
      run: failed,
    };
  }

  const executing = runWithTimestamp(run);
  stateStore.upsertPlaybookRun(executing);

  const result = runWithTimestamp(await executePlaybook(executing, device));
  stateStore.upsertPlaybookRun(result);
  await stateStore.addAction({
    actor: "steward",
    kind: "playbook",
    message: `Playbook "${result.name}" on ${device.name}: ${result.status}`,
    context: {
      playbookRunId: result.id,
      deviceId: device.id,
      status: result.status,
    },
  });

  return {
    status: result.status,
    summary: `Playbook "${result.name}" on ${device.name}: ${result.status}`,
    run: result,
    device,
  };
}
