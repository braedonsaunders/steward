import type { DeviceStatus, DiscoveryObservation, DiscoveryObservationInput } from "@/lib/state/types";

const MIN_CONFIDENCE = 0.05;

const BASE_EVIDENCE_WEIGHT: Record<DiscoveryObservation["evidenceType"], number> = {
  arp_resolved: 0.85,
  icmp_reply: 0.8,
  tcp_open: 0.9,
  nmap_host_up: 0.85,
  mdns_announcement: 0.9,
  ssdp_response: 0.85,
  dns_ptr: 0.25,
  dns_service: 0.75,
  snmp_sysdescr: 0.9,
  http_banner: 0.7,
  tls_cert: 0.65,
  ssh_banner: 0.9,
  smb_negotiate: 0.85,
  winrm_endpoint: 0.85,
  mqtt_connack: 0.85,
  netbios_name: 0.65,
  protocol_hint: 0.7,
};

const DEFAULT_TTL_BY_EVIDENCE: Record<DiscoveryObservation["evidenceType"], number> = {
  arp_resolved: 20 * 60_000,
  icmp_reply: 15 * 60_000,
  tcp_open: 30 * 60_000,
  nmap_host_up: 20 * 60_000,
  mdns_announcement: 20 * 60_000,
  ssdp_response: 20 * 60_000,
  dns_ptr: 12 * 60 * 60_000,
  dns_service: 30 * 60_000,
  snmp_sysdescr: 6 * 60 * 60_000,
  http_banner: 90 * 60_000,
  tls_cert: 24 * 60 * 60_000,
  ssh_banner: 90 * 60_000,
  smb_negotiate: 90 * 60_000,
  winrm_endpoint: 90 * 60_000,
  mqtt_connack: 90 * 60_000,
  netbios_name: 6 * 60 * 60_000,
  protocol_hint: 60 * 60_000,
};

const STRONG_EVIDENCE_TYPES = new Set<DiscoveryObservation["evidenceType"]>([
  "arp_resolved",
  "icmp_reply",
  "tcp_open",
  "nmap_host_up",
  "mdns_announcement",
  "ssdp_response",
  "snmp_sysdescr",
  "ssh_banner",
  "smb_negotiate",
  "winrm_endpoint",
  "mqtt_connack",
]);

export interface DiscoveryFusionResult {
  confidence: number;
  status: DeviceStatus;
  hasPositiveEvidence: boolean;
  hasStrongEvidence: boolean;
  evidenceTypes: DiscoveryObservation["evidenceType"][];
  sourceCounts: Record<string, number>;
  observationCount: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const parseTime = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeObservation = (observation: DiscoveryObservationInput): DiscoveryObservationInput => {
  const observedAt = observation.observedAt || new Date().toISOString();
  const ttlMs = observation.ttlMs ?? DEFAULT_TTL_BY_EVIDENCE[observation.evidenceType];
  const observedAtMs = parseTime(observedAt) ?? Date.now();
  const expiresAt = observation.expiresAt ?? new Date(observedAtMs + Math.max(1, ttlMs)).toISOString();
  const confidence = clamp(observation.confidence, 0, 1);

  return {
    ...observation,
    observedAt,
    expiresAt,
    confidence,
    details: observation.details ?? {},
  };
};

export const buildObservation = (observation: DiscoveryObservationInput): DiscoveryObservationInput =>
  normalizeObservation(observation);

export const dedupeObservations = (observations: DiscoveryObservationInput[]): DiscoveryObservationInput[] => {
  const byKey = new Map<string, DiscoveryObservationInput>();

  for (const raw of observations) {
    const observation = normalizeObservation(raw);
    const detailSig = JSON.stringify(observation.details ?? {});
    const key = `${observation.ip}|${observation.source}|${observation.evidenceType}|${detailSig}`;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, observation);
      continue;
    }

    const existingObservedMs = parseTime(existing.observedAt) ?? 0;
    const nextObservedMs = parseTime(observation.observedAt) ?? 0;
    if (nextObservedMs > existingObservedMs || observation.confidence > existing.confidence) {
      byKey.set(key, observation);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const at = parseTime(a.observedAt) ?? 0;
    const bt = parseTime(b.observedAt) ?? 0;
    return bt - at;
  });
};

export const evaluateDiscoveryEvidence = (
  observations: DiscoveryObservationInput[],
  nowMs = Date.now(),
): DiscoveryFusionResult => {
  const normalized = dedupeObservations(observations);
  const active = normalized.filter((item) => {
    const expiresAt = parseTime(item.expiresAt);
    return expiresAt === undefined || expiresAt >= nowMs;
  });

  if (active.length === 0) {
    return {
      confidence: 0,
      status: "unknown",
      hasPositiveEvidence: false,
      hasStrongEvidence: false,
      evidenceTypes: [],
      sourceCounts: {},
      observationCount: 0,
    };
  }

  let confidenceProduct = 1;
  let hasStrongEvidence = false;
  const evidenceTypes = new Set<DiscoveryObservation["evidenceType"]>();
  const sourceCounts = new Map<string, number>();

  for (const observation of active) {
    const weight = BASE_EVIDENCE_WEIGHT[observation.evidenceType] ?? 0.2;
    const weightedConfidence = clamp(weight * observation.confidence, 0, 0.98);
    confidenceProduct *= 1 - weightedConfidence;
    evidenceTypes.add(observation.evidenceType);
    sourceCounts.set(observation.source, (sourceCounts.get(observation.source) ?? 0) + 1);

    if (STRONG_EVIDENCE_TYPES.has(observation.evidenceType) && observation.confidence >= 0.5) {
      hasStrongEvidence = true;
    }
  }

  const confidence = clamp(1 - confidenceProduct, 0, 1);
  const hasPositiveEvidence = hasStrongEvidence || confidence >= MIN_CONFIDENCE;

  let status: DeviceStatus = "unknown";
  if (hasStrongEvidence || confidence >= 0.7) {
    status = "online";
  } else if (confidence >= 0.35) {
    status = "degraded";
  } else if (confidence > 0) {
    status = "unknown";
  }

  return {
    confidence,
    status,
    hasPositiveEvidence,
    hasStrongEvidence,
    evidenceTypes: Array.from(evidenceTypes.values()).sort(),
    sourceCounts: Object.fromEntries(Array.from(sourceCounts.entries())),
    observationCount: active.length,
  };
};

