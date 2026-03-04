import { stateStore } from "@/lib/state/store";
import type { Device, PlaybookRun } from "@/lib/state/types";

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Create a pending approval for a playbook run.
 */
export function createApproval(run: PlaybookRun, _device: Device): PlaybookRun {
  const updated: PlaybookRun = {
    ...run,
    status: "pending_approval",
    expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
  };

  stateStore.upsertPlaybookRun(updated);

  void stateStore.addAction({
    actor: "steward",
    kind: "approval",
    message: `Approval requested: "${run.name}" on device ${run.deviceId}`,
    context: { playbookRunId: run.id, actionClass: run.actionClass },
  });

  return updated;
}

/**
 * Approve a pending playbook run.
 */
export function approveAction(id: string, approvedBy: string = "user"): PlaybookRun | undefined {
  const run = stateStore.getPlaybookRunById(id);
  if (!run || run.status !== "pending_approval") return undefined;

  const updated: PlaybookRun = {
    ...run,
    status: "approved",
    approvedBy,
    approvedAt: new Date().toISOString(),
  };

  stateStore.upsertPlaybookRun(updated);

  void stateStore.addAction({
    actor: "user",
    kind: "approval",
    message: `Approved: "${run.name}" on device ${run.deviceId}`,
    context: { playbookRunId: run.id, approvedBy },
  });

  return updated;
}

/**
 * Deny a pending playbook run.
 */
export function denyAction(
  id: string,
  deniedBy: string = "user",
  reason: string = "",
): PlaybookRun | undefined {
  const run = stateStore.getPlaybookRunById(id);
  if (!run || run.status !== "pending_approval") return undefined;

  const updated: PlaybookRun = {
    ...run,
    status: "denied",
    deniedBy,
    deniedAt: new Date().toISOString(),
    denialReason: reason,
  };

  stateStore.upsertPlaybookRun(updated);

  void stateStore.addAction({
    actor: "user",
    kind: "approval",
    message: `Denied: "${run.name}" on device ${run.deviceId}${reason ? ` — ${reason}` : ""}`,
    context: { playbookRunId: run.id, deniedBy, reason },
  });

  return updated;
}

/**
 * Expire stale pending approvals past their TTL.
 */
export function expireStale(): number {
  const pending = stateStore.getPendingApprovals();
  const now = Date.now();
  let expired = 0;

  for (const run of pending) {
    if (run.expiresAt && new Date(run.expiresAt).getTime() < now) {
      const updated: PlaybookRun = {
        ...run,
        status: "denied",
        denialReason: "Approval TTL expired",
        deniedAt: new Date().toISOString(),
        deniedBy: "system",
      };

      stateStore.upsertPlaybookRun(updated);

      void stateStore.addAction({
        actor: "steward",
        kind: "approval",
        message: `Approval expired: "${run.name}" on device ${run.deviceId}`,
        context: { playbookRunId: run.id },
      });

      expired++;
    }
  }

  return expired;
}
