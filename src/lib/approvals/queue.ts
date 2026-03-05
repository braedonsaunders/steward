import { stateStore } from "@/lib/state/store";
import type { Device, PlaybookRun } from "@/lib/state/types";

function ttlForRun(run: PlaybookRun): number {
  const runtime = stateStore.getRuntimeSettings();
  switch (run.actionClass) {
    case "B":
      return runtime.approvalTtlClassBMs;
    case "C":
      return runtime.approvalTtlClassCMs;
    case "D":
      return runtime.approvalTtlClassDMs;
    default:
      return runtime.approvalTtlClassBMs;
  }
}

/**
 * Create a pending approval for a playbook run.
 */
export function createApproval(run: PlaybookRun, device: Device): PlaybookRun {
  const ttlMs = ttlForRun(run);
  const updated: PlaybookRun = {
    ...run,
    status: "pending_approval",
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };

  stateStore.upsertPlaybookRun(updated);

  void stateStore.addAction({
    actor: "steward",
    kind: "approval",
    message: `Approval requested: "${run.name}" on device ${run.deviceId}`,
    context: {
      playbookRunId: run.id,
      actionClass: run.actionClass,
      deviceName: device.name,
      ttlMs,
    },
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
      const escalationAlreadySent = Boolean(
        run.evidence.preSnapshot
        && typeof run.evidence.preSnapshot.approvalEscalatedAt === "string",
      );

      if (!escalationAlreadySent) {
        const escalationTtlMs = Math.min(30 * 60 * 1000, Math.max(5 * 60 * 1000, ttlForRun(run) / 2));
        const escalated: PlaybookRun = {
          ...run,
          expiresAt: new Date(now + escalationTtlMs).toISOString(),
          evidence: {
            ...run.evidence,
            preSnapshot: {
              ...(run.evidence.preSnapshot ?? {}),
              approvalEscalatedAt: new Date().toISOString(),
            },
            logs: [
              ...run.evidence.logs,
              `Approval escalated with additional TTL ${Math.round(escalationTtlMs / 1000)}s`,
            ],
          },
        };

        stateStore.upsertPlaybookRun(escalated);

        void stateStore.addAction({
          actor: "steward",
          kind: "approval",
          message: `Approval escalated: "${run.name}" on device ${run.deviceId}`,
          context: { playbookRunId: run.id, escalationTtlMs },
        });
        continue;
      }

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
