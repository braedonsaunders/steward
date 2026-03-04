import type { DeviceType, ServiceFingerprint } from "@/lib/state/types";

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
  metadata: Record<string, unknown>;
}

export interface DiscoverySnapshot {
  discoveredAt: string;
  scanMode: "incremental" | "deep";
  activeTargets: number;
  passive: DiscoveryCandidate[];
  active: DiscoveryCandidate[];
  merged: DiscoveryCandidate[];
}
