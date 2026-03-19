import { describe, expect, it } from "vitest";
import {
  bucketPlaybookRuns,
  countOpenJobs,
  countRunningPlaybookRuns,
  jobsTabForStatus,
} from "@/lib/jobs";
import type { PlaybookRun } from "@/lib/state/types";

function buildRun(overrides: Partial<PlaybookRun>): PlaybookRun {
  return {
    id: overrides.id ?? "run-1",
    playbookId: overrides.playbookId ?? "playbook-1",
    family: overrides.family ?? "config-backup",
    name: overrides.name ?? "Run",
    deviceId: overrides.deviceId ?? "device-1",
    actionClass: overrides.actionClass ?? "C",
    status: overrides.status ?? "approved",
    policyEvaluation: overrides.policyEvaluation ?? {
      outcome: "ALLOW_AUTO",
      reason: "ok",
      actionClass: "C",
      riskScore: 0.4,
    },
    steps: overrides.steps ?? [],
    verificationSteps: overrides.verificationSteps ?? [],
    rollbackSteps: overrides.rollbackSteps ?? [],
    evidence: overrides.evidence ?? { logs: [] },
    createdAt: overrides.createdAt ?? "2026-03-18T10:00:00.000Z",
    failureCount: overrides.failureCount ?? 0,
    updatedAt: overrides.updatedAt,
  };
}

describe("jobs helpers", () => {
  it("counts active and waiting runs as running", () => {
    const runs: PlaybookRun[] = [
      buildRun({ id: "approved", status: "approved" }),
      buildRun({ id: "waiting", status: "waiting" }),
      buildRun({ id: "verifying", status: "verifying" }),
      buildRun({ id: "pending", status: "pending_approval" }),
      buildRun({ id: "completed", status: "completed" }),
    ];

    expect(countRunningPlaybookRuns(runs)).toBe(3);
  });

  it("keeps open-job counts on pending approval and failures, but not history", () => {
    const runs: PlaybookRun[] = [
      buildRun({ id: "pending", status: "pending_approval" }),
      buildRun({ id: "failed", status: "failed" }),
      buildRun({ id: "completed", status: "completed" }),
      buildRun({ id: "denied", status: "denied" }),
    ];

    expect(countOpenJobs(runs)).toBe(2);
  });

  it("buckets runs into stable jobs views sorted by newest update", () => {
    const runs: PlaybookRun[] = [
      buildRun({ id: "active-old", status: "executing", updatedAt: "2026-03-18T10:00:00.000Z" }),
      buildRun({ id: "active-new", status: "preflight", updatedAt: "2026-03-18T12:00:00.000Z" }),
      buildRun({ id: "waiting", status: "waiting", updatedAt: "2026-03-18T11:00:00.000Z" }),
      buildRun({ id: "pending", status: "pending_approval", updatedAt: "2026-03-18T09:00:00.000Z" }),
      buildRun({ id: "attention", status: "quarantined", updatedAt: "2026-03-18T08:00:00.000Z" }),
      buildRun({ id: "history", status: "completed", updatedAt: "2026-03-18T07:00:00.000Z" }),
    ];

    const buckets = bucketPlaybookRuns(runs);

    expect(buckets.active.map((run) => run.id)).toEqual(["active-new", "active-old"]);
    expect(buckets.waiting.map((run) => run.id)).toEqual(["waiting"]);
    expect(buckets.pending.map((run) => run.id)).toEqual(["pending"]);
    expect(buckets.attention.map((run) => run.id)).toEqual(["attention"]);
    expect(buckets.history.map((run) => run.id)).toEqual(["history"]);
  });

  it("maps playbook statuses to the correct jobs tab", () => {
    expect(jobsTabForStatus("pending_approval")).toBe("pending");
    expect(jobsTabForStatus("waiting")).toBe("waiting");
    expect(jobsTabForStatus("failed")).toBe("attention");
    expect(jobsTabForStatus("denied")).toBe("history");
    expect(jobsTabForStatus("executing")).toBe("active");
  });
});
