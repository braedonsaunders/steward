import type {
  DeviceType,
  DiscoveryObservationInput,
  ServiceFingerprint,
} from "@/lib/state/types";

export interface DiscoveryCandidate {
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  os?: string;
  typeHint?: DeviceType;
  services: ServiceFingerprint[];
  source: "passive" | "active" | "mdns" | "ssdp";
  confidence?: number;
  observations: DiscoveryObservationInput[];
  metadata: Record<string, unknown>;
}

export type DiscoveryPhaseStatus = "completed" | "timed_out" | "skipped" | "failed";

export interface DiscoveryPhaseTelemetry {
  key: string;
  label: string;
  status: DiscoveryPhaseStatus;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  budgetMs?: number;
  desiredBudgetMs?: number;
  targetCount?: number;
  dueTargetCount?: number;
  deferredTargetCount?: number;
  note?: string;
}

export interface DiscoveryDiagnostics {
  scanMode: "incremental" | "deep";
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  budgetMs?: number;
  phaseCount: number;
  constrainedPhaseCount: number;
  timedOutPhaseCount: number;
  skippedPhaseCount: number;
  failedPhaseCount: number;
  deferredPhaseCount: number;
  phases: DiscoveryPhaseTelemetry[];
}

export type DiscoveryEnrichmentPhase = "fingerprint" | "nmapDeep" | "browserObservation" | "hostname";

export interface DiscoveryEnrichmentPhaseSummary {
  phase: DiscoveryEnrichmentPhase;
  targetCount: number;
  dueTargetCount: number;
  deferredTargetCount: number;
  queued: boolean;
  queueBusy: boolean;
}

export interface DiscoveryEnrichmentSummary {
  queuedJobs: number;
  queuedTargets: number;
  dueTargets: number;
  deferredTargets: number;
  phasesWithBacklog: number;
  phases: DiscoveryEnrichmentPhaseSummary[];
}

export interface DiscoverySnapshot {
  discoveredAt: string;
  scanMode: "incremental" | "deep";
  activeTargets: number;
  passive: DiscoveryCandidate[];
  active: DiscoveryCandidate[];
  merged: DiscoveryCandidate[];
  diagnostics?: DiscoveryDiagnostics;
}
