import type { PlaybookRun, PlaybookRunStatus } from "@/lib/state/types";

export type JobsTabValue = "active" | "waiting" | "pending" | "attention" | "history";

export const ACTIVE_JOB_STATUSES: PlaybookRunStatus[] = [
  "approved",
  "preflight",
  "executing",
  "verifying",
  "rolling_back",
];

export const WAITING_JOB_STATUSES: PlaybookRunStatus[] = ["waiting"];

export const ATTENTION_JOB_STATUSES: PlaybookRunStatus[] = ["failed", "quarantined"];

export const HISTORY_JOB_STATUSES: PlaybookRunStatus[] = ["completed", "denied"];

function timestampValue(iso: string | undefined): number {
  if (!iso) {
    return 0;
  }

  const parsed = new Date(iso).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortPlaybookRunsByNewest<T extends PlaybookRun>(runs: readonly T[]): T[] {
  return [...runs].sort((a, b) => (
    timestampValue(b.updatedAt)
    || timestampValue(b.completedAt)
    || timestampValue(b.startedAt)
    || timestampValue(b.createdAt)
  ) - (
    timestampValue(a.updatedAt)
    || timestampValue(a.completedAt)
    || timestampValue(a.startedAt)
    || timestampValue(a.createdAt)
  ));
}

export function isRunningPlaybookRunStatus(status: PlaybookRunStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status) || WAITING_JOB_STATUSES.includes(status);
}

export function isAttentionPlaybookRunStatus(status: PlaybookRunStatus): boolean {
  return ATTENTION_JOB_STATUSES.includes(status);
}

export function countRunningPlaybookRuns(runs: readonly PlaybookRun[]): number {
  return runs.filter((run) => isRunningPlaybookRunStatus(run.status)).length;
}

export function countOpenJobs(runs: readonly PlaybookRun[]): number {
  return runs.filter((run) => !HISTORY_JOB_STATUSES.includes(run.status)).length;
}

export function jobsTabForStatus(status: PlaybookRunStatus): JobsTabValue {
  if (status === "pending_approval") {
    return "pending";
  }
  if (WAITING_JOB_STATUSES.includes(status)) {
    return "waiting";
  }
  if (ATTENTION_JOB_STATUSES.includes(status)) {
    return "attention";
  }
  if (HISTORY_JOB_STATUSES.includes(status)) {
    return "history";
  }
  return "active";
}

export function bucketPlaybookRuns(runs: readonly PlaybookRun[]) {
  const sorted = sortPlaybookRunsByNewest(runs);
  return {
    pending: sorted.filter((run) => run.status === "pending_approval"),
    active: sorted.filter((run) => ACTIVE_JOB_STATUSES.includes(run.status)),
    waiting: sorted.filter((run) => WAITING_JOB_STATUSES.includes(run.status)),
    attention: sorted.filter((run) => ATTENTION_JOB_STATUSES.includes(run.status)),
    history: sorted.filter((run) => HISTORY_JOB_STATUSES.includes(run.status)),
  };
}
