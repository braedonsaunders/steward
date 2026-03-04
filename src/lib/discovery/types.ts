import type { DeviceType, ServiceFingerprint } from "@/lib/state/types";

export interface DiscoveryCandidate {
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  os?: string;
  typeHint?: DeviceType;
  services: ServiceFingerprint[];
  source: "passive" | "active";
  metadata: Record<string, unknown>;
}

export interface DiscoverySnapshot {
  discoveredAt: string;
  passive: DiscoveryCandidate[];
  active: DiscoveryCandidate[];
  merged: DiscoveryCandidate[];
}
