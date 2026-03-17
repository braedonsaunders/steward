import type Database from "better-sqlite3";
import type {
  AutonomyLatencySummary,
  AutonomyMetricsSnapshot,
} from "@/lib/autonomy/types";
import { getAuditDb, getDb, recoverCorruptAuditDatabase, recoverCorruptDatabase } from "@/lib/state/db";
import { stateStore } from "@/lib/state/store";

function nowIso(): string {
  return new Date().toISOString();
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function summarizeLatency(values: number[]): AutonomyLatencySummary {
  if (values.length === 0) {
    return {
      sampleCount: 0,
      averageMs: 0,
      p95Ms: 0,
    };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    sampleCount: values.length,
    averageMs: Math.round(total / values.length),
    p95Ms: Math.round(percentile(values, 0.95)),
  };
}

function withStateDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
  const run = () => operation(getDb());
  try {
    return run();
  } catch (error) {
    if (!recoverCorruptDatabase(error, context)) {
      throw error;
    }
    return run();
  }
}

function withAuditDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
  const run = () => operation(getAuditDb());
  try {
    return run();
  } catch (error) {
    if (!recoverCorruptAuditDatabase(error, context)) {
      throw error;
    }
    return run();
  }
}

export function getAutonomyMetricsSnapshot(referenceIso = nowIso()): AutonomyMetricsSnapshot {
  const sinceIso = new Date(new Date(referenceIso).getTime() - (24 * 60 * 60 * 1000)).toISOString();
  const controlPlaneHealth = stateStore.getControlPlaneHealth();
  const leaderLease = controlPlaneHealth.leases.find((lease) => lease.name === "control-plane.leader");
  const leaderActive = Boolean(leaderLease && Date.parse(leaderLease.expiresAt) > Date.now());
  const pendingJobs = controlPlaneHealth.summary.pending;
  const processingJobs = controlPlaneHealth.summary.processing;
  const staleProcessingJobs = controlPlaneHealth.summary.longRunningProcessing;

  const queueLagMs = withAuditDbRecovery("autonomy.metrics.queueLag", (auditDb) => {
    const row = auditDb.prepare(`
      SELECT runAfter
      FROM durable_jobs
      WHERE status = 'pending'
        AND kind IN ('mission.tick', 'investigation.step', 'briefing.compile', 'approval.followup', 'channel.delivery')
      ORDER BY runAfter ASC
      LIMIT 1
    `).get() as { runAfter?: string } | undefined;
    const oldest = row?.runAfter ? Date.parse(row.runAfter) : Number.NaN;
    if (!Number.isFinite(oldest)) {
      return 0;
    }
    return Math.max(0, Date.now() - oldest);
  });

  const missionLatencies = withStateDbRecovery("autonomy.metrics.missionLatency", (db) => (
    db.prepare(`
      SELECT startedAt, completedAt
      FROM mission_runs
      WHERE completedAt IS NOT NULL
        AND createdAt >= ?
      ORDER BY createdAt DESC
      LIMIT 500
    `).all(sinceIso) as Array<{ startedAt?: string; completedAt?: string }>
  )).map((row) => {
    const started = row.startedAt ? Date.parse(row.startedAt) : Number.NaN;
    const completed = row.completedAt ? Date.parse(row.completedAt) : Number.NaN;
    return Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : 0;
  }).filter((value) => value > 0);

  const briefingLatencies = withStateDbRecovery("autonomy.metrics.briefingLatency", (db) => (
    db.prepare(`
      SELECT createdAt, deliveredAt
      FROM briefings
      WHERE deliveredAt IS NOT NULL
        AND createdAt >= ?
      ORDER BY createdAt DESC
      LIMIT 500
    `).all(sinceIso) as Array<{ createdAt?: string; deliveredAt?: string }>
  )).map((row) => {
    const created = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
    const delivered = row.deliveredAt ? Date.parse(row.deliveredAt) : Number.NaN;
    return Number.isFinite(created) && Number.isFinite(delivered) ? Math.max(0, delivered - created) : 0;
  }).filter((value) => value > 0);

  const channelLatencies = withStateDbRecovery("autonomy.metrics.channelLatency", (db) => (
    db.prepare(`
      SELECT requestedAt, deliveredAt
      FROM channel_delivery_events
      WHERE deliveredAt IS NOT NULL
        AND createdAt >= ?
      ORDER BY createdAt DESC
      LIMIT 500
    `).all(sinceIso) as Array<{ requestedAt?: string; deliveredAt?: string }>
  )).map((row) => {
    const requested = row.requestedAt ? Date.parse(row.requestedAt) : Number.NaN;
    const delivered = row.deliveredAt ? Date.parse(row.deliveredAt) : Number.NaN;
    return Number.isFinite(requested) && Number.isFinite(delivered) ? Math.max(0, delivered - requested) : 0;
  }).filter((value) => value > 0);

  const status = !leaderActive
    ? "offline"
    : staleProcessingJobs > 0 || queueLagMs > 5 * 60_000
      ? "degraded"
      : "healthy";

  return {
    generatedAt: referenceIso,
    workerHealth: {
      status,
      controlPlaneLeaderActive: leaderActive,
      pendingJobs,
      processingJobs,
      staleProcessingJobs,
      queueLagMs,
    },
    missionLatency: summarizeLatency(missionLatencies),
    briefingLatency: summarizeLatency(briefingLatencies),
    channelDeliveryLatency: summarizeLatency(channelLatencies),
  };
}
