import type { PlaybookRun } from "@/lib/state/types";

const parseApprovalExpiryMs = (run: PlaybookRun): number | null => {
  if (!run.expiresAt) {
    return null;
  }

  const expiresAtMs = Date.parse(run.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return 0;
  }

  return expiresAtMs;
};

export const isPlaybookApprovalExpired = (
  run: PlaybookRun,
  nowMs: number = Date.now(),
): boolean => {
  if (run.status !== "pending_approval") {
    return false;
  }

  const expiresAtMs = parseApprovalExpiryMs(run);
  if (expiresAtMs === null) {
    return false;
  }

  return expiresAtMs <= nowMs;
};

export const filterActivePlaybookApprovals = (
  runs: PlaybookRun[],
  nowMs: number = Date.now(),
): PlaybookRun[] => runs.filter((run) =>
  run.status === "pending_approval" && !isPlaybookApprovalExpired(run, nowMs)
);
