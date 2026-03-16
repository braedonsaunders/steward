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
  phases: DiscoveryPhaseTelemetry[];
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
