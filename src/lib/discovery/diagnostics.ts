import type { DiscoveryDiagnostics, DiscoveryPhaseStatus, DiscoveryPhaseTelemetry } from "@/lib/discovery/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const isPhaseStatus = (value: unknown): value is DiscoveryPhaseStatus =>
  value === "completed" || value === "timed_out" || value === "skipped" || value === "failed";

const parsePhaseTelemetry = (value: unknown): DiscoveryPhaseTelemetry | null => {
  if (!isRecord(value)) {
    return null;
  }

  const key = asString(value.key);
  const label = asString(value.label);
  const status = value.status;
  const startedAt = asString(value.startedAt);
  const completedAt = asString(value.completedAt);
  const elapsedMs = asFiniteNumber(value.elapsedMs);
  if (!key || !label || !isPhaseStatus(status) || !startedAt || !completedAt || elapsedMs === undefined) {
    return null;
  }

  return {
    key,
    label,
    status,
    startedAt,
    completedAt,
    elapsedMs,
    budgetMs: asFiniteNumber(value.budgetMs),
    desiredBudgetMs: asFiniteNumber(value.desiredBudgetMs),
    targetCount: asFiniteNumber(value.targetCount),
    note: asString(value.note),
  };
};

export const parseDiscoveryDiagnostics = (details: Record<string, unknown>): DiscoveryDiagnostics | null => {
  const raw = details.discovery;
  if (!isRecord(raw)) {
    return null;
  }

  const phases = Array.isArray(raw.phases)
    ? raw.phases.map(parsePhaseTelemetry).filter((phase): phase is DiscoveryPhaseTelemetry => phase !== null)
    : [];
  const timedOutPhaseCount = phases.filter((phase) => phase.status === "timed_out").length;
  const skippedPhaseCount = phases.filter((phase) => phase.status === "skipped").length;
  const failedPhaseCount = phases.filter((phase) => phase.status === "failed").length;
  const startedAt = asString(raw.startedAt);
  const completedAt = asString(raw.completedAt);
  const elapsedMs = asFiniteNumber(raw.elapsedMs);
  const scanMode = raw.scanMode === "deep" ? "deep" : raw.scanMode === "incremental" ? "incremental" : undefined;

  if (!startedAt || !completedAt || elapsedMs === undefined || !scanMode) {
    return null;
  }

  return {
    scanMode,
    startedAt,
    completedAt,
    elapsedMs,
    budgetMs: asFiniteNumber(raw.budgetMs),
    phaseCount: asFiniteNumber(raw.phaseCount) ?? phases.length,
    constrainedPhaseCount: asFiniteNumber(raw.constrainedPhaseCount) ?? timedOutPhaseCount + skippedPhaseCount,
    timedOutPhaseCount: asFiniteNumber(raw.timedOutPhaseCount) ?? timedOutPhaseCount,
    skippedPhaseCount: asFiniteNumber(raw.skippedPhaseCount) ?? skippedPhaseCount,
    failedPhaseCount: asFiniteNumber(raw.failedPhaseCount) ?? failedPhaseCount,
    phases,
  };
};

export const constrainedDiscoveryPhases = (
  diagnostics: DiscoveryDiagnostics | null | undefined,
): DiscoveryPhaseTelemetry[] =>
  diagnostics?.phases.filter((phase) => phase.status === "timed_out" || phase.status === "skipped") ?? [];

export const slowestDiscoveryPhase = (
  diagnostics: DiscoveryDiagnostics | null | undefined,
): DiscoveryPhaseTelemetry | null => {
  if (!diagnostics || diagnostics.phases.length === 0) {
    return null;
  }

  return diagnostics.phases.reduce((slowest, phase) =>
    phase.elapsedMs > slowest.elapsedMs ? phase : slowest,
  );
};

export const formatDurationMs = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (value < 1_000) {
    return `${Math.max(0, Math.round(value))}ms`;
  }
  if (value < 60_000) {
    const seconds = value / 1_000;
    return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }

  const totalSeconds = Math.round(value / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
};

export const phaseStatusLabel = (status: DiscoveryPhaseStatus): string => {
  if (status === "timed_out") {
    return "budget limited";
  }
  if (status === "skipped") {
    return "skipped";
  }
  if (status === "failed") {
    return "failed";
  }
  return "completed";
};
