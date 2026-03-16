import type {
  DiscoveryDiagnostics,
  DiscoveryEnrichmentPhase,
  DiscoveryEnrichmentPhaseSummary,
  DiscoveryEnrichmentSummary,
  DiscoveryPhaseStatus,
  DiscoveryPhaseTelemetry,
} from "@/lib/discovery/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const isPhaseStatus = (value: unknown): value is DiscoveryPhaseStatus =>
  value === "completed" || value === "timed_out" || value === "skipped" || value === "failed";

const isDiscoveryEnrichmentPhase = (value: unknown): value is DiscoveryEnrichmentPhase =>
  value === "fingerprint"
  || value === "nmapDeep"
  || value === "browserObservation"
  || value === "hostname";

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
    dueTargetCount: asFiniteNumber(value.dueTargetCount),
    deferredTargetCount: asFiniteNumber(value.deferredTargetCount),
    note: asString(value.note),
  };
};

const parseDiscoveryEnrichmentPhaseSummary = (value: unknown): DiscoveryEnrichmentPhaseSummary | null => {
  if (!isRecord(value)) {
    return null;
  }

  const phase = value.phase;
  const targetCount = asFiniteNumber(value.targetCount);
  const dueTargetCount = asFiniteNumber(value.dueTargetCount);
  const deferredTargetCount = asFiniteNumber(value.deferredTargetCount);
  if (
    !isDiscoveryEnrichmentPhase(phase)
    || targetCount === undefined
    || dueTargetCount === undefined
    || deferredTargetCount === undefined
  ) {
    return null;
  }

  return {
    phase,
    targetCount,
    dueTargetCount,
    deferredTargetCount,
    queued: value.queued === true,
    queueBusy: value.queueBusy === true,
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
  const deferredPhaseCount = phases.filter((phase) => (phase.deferredTargetCount ?? 0) > 0).length;
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
    deferredPhaseCount: asFiniteNumber(raw.deferredPhaseCount) ?? deferredPhaseCount,
    phases,
  };
};

export const parseDiscoveryEnrichmentSummary = (
  details: Record<string, unknown>,
): DiscoveryEnrichmentSummary | null => {
  const raw = details.discoveryEnrichment;
  if (!isRecord(raw)) {
    return null;
  }

  const phases = Array.isArray(raw.phases)
    ? raw.phases
      .map(parseDiscoveryEnrichmentPhaseSummary)
      .filter((phase): phase is DiscoveryEnrichmentPhaseSummary => phase !== null)
    : [];

  return {
    queuedJobs: asFiniteNumber(raw.queuedJobs) ?? phases.filter((phase) => phase.queued).length,
    queuedTargets: asFiniteNumber(raw.queuedTargets) ?? phases.reduce((total, phase) => total + (phase.queued ? phase.targetCount : 0), 0),
    dueTargets: asFiniteNumber(raw.dueTargets) ?? phases.reduce((total, phase) => total + phase.dueTargetCount, 0),
    deferredTargets: asFiniteNumber(raw.deferredTargets) ?? phases.reduce((total, phase) => total + phase.deferredTargetCount, 0),
    phasesWithBacklog: asFiniteNumber(raw.phasesWithBacklog) ?? phases.filter((phase) => phase.deferredTargetCount > 0).length,
    phases,
  };
};

export const constrainedDiscoveryPhases = (
  diagnostics: DiscoveryDiagnostics | null | undefined,
): DiscoveryPhaseTelemetry[] =>
  diagnostics?.phases.filter((phase) => phase.status === "timed_out" || phase.status === "skipped") ?? [];

export const deferredDiscoveryPhases = (
  diagnostics: DiscoveryDiagnostics | null | undefined,
): DiscoveryPhaseTelemetry[] =>
  diagnostics?.phases.filter((phase) => (phase.deferredTargetCount ?? 0) > 0) ?? [];

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

export const discoveryEnrichmentPhaseLabel = (phase: DiscoveryEnrichmentPhase): string => {
  if (phase === "fingerprint") {
    return "Service fingerprinting";
  }
  if (phase === "nmapDeep") {
    return "Deep nmap fingerprinting";
  }
  if (phase === "browserObservation") {
    return "Browser observation";
  }
  return "Hostname enrichment";
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
