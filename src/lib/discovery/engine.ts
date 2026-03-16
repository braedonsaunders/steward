import { collectActiveCandidates } from "@/lib/discovery/active";
import { observeBrowserSurfaces } from "@/lib/discovery/browser-observer";
import { mergeDiscoveryCandidates } from "@/lib/discovery/classify";
import { buildObservation, dedupeObservations } from "@/lib/discovery/evidence";
import { runNmapDeepFingerprint } from "@/lib/discovery/nmap-deep";
import { collectPacketIntelSnapshot } from "@/lib/discovery/packet-intel";
import { collectPassiveCandidates } from "@/lib/discovery/passive";
import {
  CURRENT_FINGERPRINT_VERSION,
  applyFingerprintResults,
  fingerprintBatch,
} from "@/lib/discovery/fingerprint";
import { discoverMulticast } from "@/lib/discovery/multicast";
import { getLocalInterfaceIdentity } from "@/lib/discovery/local";
import { updateOuiDatabase } from "@/lib/discovery/oui";
import dns from "node:dns/promises";
import { adapterRegistry } from "@/lib/adapters/registry";
import { stateStore } from "@/lib/state/store";
import { runShell } from "@/lib/utils/shell";
import type {
  DiscoveryCandidate,
  DiscoveryDiagnostics,
  DiscoveryPhaseTelemetry,
  DiscoverySnapshot,
} from "@/lib/discovery/types";
import type { ServiceFingerprint } from "@/lib/state/types";

interface DiscoveryRunOptions {
  forceDeepScan?: boolean;
  budgetMs?: number;
}

const normalizeCandidate = (candidate: DiscoveryCandidate): DiscoveryCandidate => ({
  ...candidate,
  observations: Array.isArray(candidate.observations) ? candidate.observations : [],
});

const isEligibleManagedIp = (ip: string): boolean => {
  const octets = ip.split(".").map((value) => Number(value));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }

  const [a, b, , d] = octets;
  if (a === 0 || a === 127 || a >= 224 || d === 255) {
    return false;
  }

  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

let lastDeepScanAt = 0;
let activeTargetCursor = 0;
let hostnameCursor = 0;
let fingerprintCursor = 0;
let lastOuiUpdateAt = 0;

const HTTP_PORTS = new Set([80, 443, 8080, 8443, 8000, 9000, 5000, 5001, 7443, 9443]);
const SSH_PORTS = new Set([22, 2222]);
const SNMP_PORTS = new Set([161]);
const DNS_PORTS = new Set([53]);
const WINRM_PORTS = new Set([5985, 5986]);
const MQTT_PORTS = new Set([1883, 8883]);
const SMB_PORTS = new Set([445]);
const NETBIOS_PORTS = new Set([137, 139]);
const UNKNOWN_SERVICE_NAMES = new Set(["", "unknown", "tcpwrapped", "generic"]);

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const withTimeoutResult = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<{ value: T; timedOut: boolean }> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ value, timedOut: false as const })),
      new Promise<{ value: T; timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ value: fallback, timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const DISCOVERY_MIN_STEP_BUDGET_MS = 2_000;
const DISCOVERY_MIN_CORE_STEP_BUDGET_MS = 5_000;
const DISCOVERY_ACTIVE_SCAN_BUDGET_MS = 90_000;
const DISCOVERY_ADAPTER_DISCOVERY_BUDGET_MS = 15_000;
const DISCOVERY_FINGERPRINT_BUDGET_MS = 25_000;
const DISCOVERY_NMAP_DEEP_BUDGET_MS = 25_000;
const DISCOVERY_BROWSER_OBSERVATION_BUDGET_MS = 30_000;
const DISCOVERY_PACKET_INTEL_BUDGET_MS = 12_000;
const DISCOVERY_HOSTNAME_BUDGET_MS = 10_000;
const DISCOVERY_ADAPTER_ENRICH_BUDGET_MS = 20_000;

const remainingBudgetMs = (deadlineAt: number): number =>
  Number.isFinite(deadlineAt)
    ? Math.max(0, Math.floor(deadlineAt - Date.now()))
    : Number.POSITIVE_INFINITY;

const computeStepBudgetMs = (
  deadlineAt: number,
  desiredMs: number,
  reserveMs: number,
  minimumMs: number,
): number | null => {
  if (!Number.isFinite(deadlineAt)) {
    return Math.max(minimumMs, Math.floor(desiredMs));
  }

  const availableMs = remainingBudgetMs(deadlineAt) - Math.max(0, reserveMs);
  if (availableMs < minimumMs) {
    return null;
  }
  return Math.max(minimumMs, Math.min(Math.floor(desiredMs), availableMs));
};

const budgetedTargetLimit = (
  configuredMaxTargets: number,
  timeoutPerTargetMs: number,
  maxConcurrency: number,
  stepBudgetMs: number,
): number => {
  if (!Number.isFinite(stepBudgetMs) || configuredMaxTargets <= 0) {
    return configuredMaxTargets;
  }

  const safeTimeoutMs = Math.max(1_000, Math.floor(timeoutPerTargetMs));
  const safeConcurrency = Math.max(1, Math.floor(maxConcurrency));
  const batches = Math.max(1, Math.floor(stepBudgetMs / safeTimeoutMs));
  return Math.max(0, Math.min(configuredMaxTargets, batches * safeConcurrency));
};

const runBudgetedStep = async <T>(
  label: string,
  fallback: T,
  options: {
    key: string;
    deadlineAt: number;
    desiredMs: number;
    reserveMs: number;
    minimumMs?: number;
    telemetry?: DiscoveryPhaseTelemetry[];
    targetCount?: number;
    note?: string;
  },
  run: (stepBudgetMs: number) => Promise<T>,
): Promise<T> => {
  const stepStartedAtMs = Date.now();
  const stepBudgetMs = computeStepBudgetMs(
    options.deadlineAt,
    options.desiredMs,
    options.reserveMs,
    options.minimumMs ?? DISCOVERY_MIN_STEP_BUDGET_MS,
  );
  if (stepBudgetMs === null) {
    options.telemetry?.push({
      key: options.key,
      label,
      status: "skipped",
      startedAt: new Date(stepStartedAtMs).toISOString(),
      completedAt: new Date(stepStartedAtMs).toISOString(),
      elapsedMs: 0,
      desiredBudgetMs: Math.max(0, Math.floor(options.desiredMs)),
      targetCount: options.targetCount,
      note: options.note ?? "No discovery budget remained for this phase.",
    });
    console.warn(`[discovery] Skipping ${label}; no budget remains in this discovery cycle.`);
    return fallback;
  }

  try {
    const result = await withTimeoutResult(run(stepBudgetMs), stepBudgetMs, fallback);
    const completedAtMs = Date.now();
    options.telemetry?.push({
      key: options.key,
      label,
      status: result.timedOut ? "timed_out" : "completed",
      startedAt: new Date(stepStartedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      elapsedMs: Math.max(0, completedAtMs - stepStartedAtMs),
      budgetMs: stepBudgetMs,
      desiredBudgetMs: Math.max(0, Math.floor(options.desiredMs)),
      targetCount: options.targetCount,
      note: result.timedOut
        ? options.note ?? "Phase exceeded its budget and returned partial results."
        : options.note,
    });
    if (result.timedOut) {
      console.warn(`[discovery] ${label} exceeded its ${stepBudgetMs}ms budget; continuing with partial results.`);
    }
    return result.value;
  } catch (error) {
    const completedAtMs = Date.now();
    options.telemetry?.push({
      key: options.key,
      label,
      status: "failed",
      startedAt: new Date(stepStartedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      elapsedMs: Math.max(0, completedAtMs - stepStartedAtMs),
      budgetMs: stepBudgetMs,
      desiredBudgetMs: Math.max(0, Math.floor(options.desiredMs)),
      targetCount: options.targetCount,
      note: error instanceof Error ? error.message : String(error),
    });
    console.error(`[discovery] ${label} failed:`, error);
    return fallback;
  }
};

const reverseHostname = async (ip: string): Promise<string | undefined> => {
  try {
    const names = await withTimeout(dns.reverse(ip), 1_500, [] as string[]);
    const resolved = names.find((value) => value.trim().length > 0);
    if (resolved) {
      return resolved;
    }
  } catch {
    // best-effort fallback below
  }

  if (process.platform === "win32") {
    const nbt = await runShell(`nbtstat -A ${ip}`, 2_000);
    if (nbt.stdout) {
      const nbtMatch = nbt.stdout.match(/^\s*([^\s<]+)\s+<00>\s+UNIQUE\s+Registered/im);
      if (nbtMatch?.[1]) {
        return nbtMatch[1].trim();
      }
    }
  }

  const nslookup = await runShell(`nslookup ${ip}`, 2_000);
  if (nslookup.stdout) {
    const directMatch = nslookup.stdout.match(/name\s*=\s*([^\s]+)/i);
    if (directMatch?.[1]) {
      return directMatch[1].trim();
    }
  }

  return undefined;
};

const enrichHostnames = async (
  candidates: DiscoverySnapshot["merged"],
  deepScan: boolean,
): Promise<DiscoverySnapshot["merged"]> => {
  const unresolved = candidates.filter((candidate) => !candidate.hostname).sort((a, b) => a.ip.localeCompare(b.ip));
  const maxChecks = deepScan ? 768 : 192;

  if (unresolved.length === 0) {
    return candidates;
  }

  const offset = hostnameCursor % unresolved.length;
  const selected = unresolved.slice(offset, offset + maxChecks);
  if (selected.length < maxChecks) {
    selected.push(...unresolved.slice(0, maxChecks - selected.length));
  }
  hostnameCursor = (hostnameCursor + maxChecks) % Math.max(1, unresolved.length);

  const resolved = await Promise.all(
    selected.map(async (candidate) => ({
      ip: candidate.ip,
      hostname: await reverseHostname(candidate.ip),
    })),
  );
  const byIp = new Map(resolved.filter((item) => item.hostname).map((item) => [item.ip, item.hostname as string]));

  return candidates.map((candidate) => {
    if (candidate.hostname) {
      return candidate;
    }
    const hostname = byIp.get(candidate.ip);
    if (!hostname) {
      return candidate;
    }
    return {
      ...candidate,
      hostname,
      observations: [
        ...candidate.observations,
        buildObservation({
          ip: candidate.ip,
          source: "active",
          evidenceType: "dns_ptr",
          confidence: 0.4,
          observedAt: new Date().toISOString(),
          ttlMs: 12 * 60 * 60_000,
          details: {
            hostname,
            via: "reverse-dns",
          },
        }),
      ],
      metadata: {
        ...candidate.metadata,
        hostnameSource: "reverse-dns",
      },
    };
  });
};

/* ---------- Fingerprint Target Selection ---------- */

const selectFingerprintTargets = (
  candidates: DiscoveryCandidate[],
  deepScan: boolean,
  maxTargets: number,
  forceRefresh = false,
): DiscoveryCandidate[] => {
  const nowMs = Date.now();

  const hasCoverageGaps = (candidate: DiscoveryCandidate): boolean => {
    const fp = candidate.metadata.fingerprint as Record<string, unknown> | undefined;
    const version = Number(fp?.fingerprintVersion ?? 0);
    if (!Number.isFinite(version) || version < CURRENT_FINGERPRINT_VERSION) {
      return true;
    }

    const ports = new Set(candidate.services.map((service) => service.port));
    if ([...SSH_PORTS].some((port) => ports.has(port)) && !fp?.sshBanner) return true;
    if ([...SNMP_PORTS].some((port) => ports.has(port)) && !fp?.snmpSysDescr) return true;
    if ([...DNS_PORTS].some((port) => ports.has(port)) && !fp?.dnsService) return true;
    if ([...WINRM_PORTS].some((port) => ports.has(port)) && !fp?.winrm) return true;
    if ([...MQTT_PORTS].some((port) => ports.has(port)) && !fp?.mqtt) return true;
    if ([...SMB_PORTS].some((port) => ports.has(port)) && !fp?.smbDialect) return true;
    if ([...NETBIOS_PORTS].some((port) => ports.has(port)) && !fp?.netbiosName) return true;

    if ([...HTTP_PORTS].some((port) => ports.has(port))) {
      const hasRichWebEvidence = candidate.services.some((service) =>
        HTTP_PORTS.has(service.port) && (service.httpInfo || service.tlsCert || service.banner));
      if (!hasRichWebEvidence) return true;
    }

    return false;
  };

  // Only fingerprint candidates with at least one open service port
  const eligible = candidates.filter((c) => {
    if (c.services.length === 0) {
      if (!forceRefresh) {
        return false;
      }
      return true;
    }

    const fp = c.metadata.fingerprint as Record<string, unknown> | undefined;
    const missingCoverage = hasCoverageGaps(c);
    if (forceRefresh || missingCoverage) {
      if (!fp?.lastFingerprintedAt) return true;
      const ageMs = nowMs - new Date(String(fp.lastFingerprintedAt)).getTime();
      const refreshCooldown = forceRefresh ? 0 : 5 * 60_000;
      return !Number.isFinite(ageMs) || ageMs >= refreshCooldown;
    }

    // Check cooldown: skip if recently fingerprinted
    if (fp?.lastFingerprintedAt) {
      const ageMs = nowMs - new Date(String(fp.lastFingerprintedAt)).getTime();
      // Shorter cooldown for unknown/low-confidence devices
      const isUnknown = !c.typeHint || c.typeHint === "unknown";
      const cooldown = isUnknown ? 10 * 60_000 : 60 * 60_000;
      if (Number.isFinite(ageMs) && ageMs < cooldown) return false;
    }

    return true;
  });

  // Prioritize: unknown-type devices first, then by number of services (more = more interesting)
  eligible.sort((a, b) => {
    const aUnknown = !a.typeHint || a.typeHint === "unknown" ? 0 : 1;
    const bUnknown = !b.typeHint || b.typeHint === "unknown" ? 0 : 1;
    if (aUnknown !== bUnknown) return aUnknown - bUnknown;
    return b.services.length - a.services.length;
  });

  if (eligible.length <= maxTargets) return eligible;

  const offset = fingerprintCursor % eligible.length;
  const selected = eligible.slice(offset, offset + maxTargets);
  if (selected.length < maxTargets) {
    selected.push(...eligible.slice(0, maxTargets - selected.length));
  }
  fingerprintCursor = (fingerprintCursor + maxTargets) % Math.max(1, eligible.length);

  return selected;
};

const isUnknownServiceName = (name: string | undefined): boolean =>
  !name || UNKNOWN_SERVICE_NAMES.has(name.trim().toLowerCase());

const mergeServiceSets = (
  current: ServiceFingerprint[],
  patches: ServiceFingerprint[],
): ServiceFingerprint[] => {
  const byKey = new Map<string, ServiceFingerprint>();
  for (const service of current) {
    byKey.set(`${service.transport}:${service.port}`, service);
  }

  for (const patch of patches) {
    const key = `${patch.transport}:${patch.port}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, patch);
      continue;
    }
    byKey.set(key, {
      ...existing,
      ...patch,
      id: existing.id,
      name: !isUnknownServiceName(patch.name) ? patch.name : existing.name,
      secure: existing.secure || patch.secure,
      product: patch.product ?? existing.product,
      version: patch.version ?? existing.version,
      banner: patch.banner ?? existing.banner,
      httpInfo: patch.httpInfo ?? existing.httpInfo,
      tlsCert: patch.tlsCert ?? existing.tlsCert,
      lastSeenAt: patch.lastSeenAt ?? existing.lastSeenAt,
    });
  }

  return Array.from(byKey.values()).sort((a, b) => a.port - b.port);
};

const applyProbeResults = <
  T extends {
    ip: string;
    services: ServiceFingerprint[];
    observations: DiscoveryCandidate["observations"];
    metadata: Record<string, unknown>;
  },
>(
  candidates: DiscoveryCandidate[],
  results: T[],
  metadataKey: string,
): DiscoveryCandidate[] => {
  if (results.length === 0) {
    return candidates;
  }
  const byIp = new Map(results.map((result) => [result.ip, result]));
  return candidates.map((candidate) => {
    const match = byIp.get(candidate.ip);
    if (!match) {
      return candidate;
    }
    return {
      ...candidate,
      services: mergeServiceSets(candidate.services, match.services),
      observations: dedupeObservations([...(candidate.observations ?? []), ...(match.observations ?? [])]),
      metadata: {
        ...candidate.metadata,
        [metadataKey]: match.metadata,
      },
    };
  });
};

const applyPacketIntelSnapshot = (
  candidates: DiscoveryCandidate[],
  snapshot: Awaited<ReturnType<typeof collectPacketIntelSnapshot>>,
  options: { includeDhcpLeaseEvidence: boolean },
): DiscoveryCandidate[] => {
  if (!snapshot) {
    return candidates;
  }

  const existingByIp = new Map(candidates.map((candidate) => [candidate.ip, candidate]));
  const next = [...candidates];

  for (const host of snapshot.hosts) {
    const hostObservations = options.includeDhcpLeaseEvidence
      ? host.observations
      : host.observations.filter((observation) => observation.evidenceType !== "dhcp_lease");
    if (hostObservations.length === 0) {
      continue;
    }

    const existing = existingByIp.get(host.ip);
    if (existing) {
      const merged: DiscoveryCandidate = {
        ...existing,
        hostname: existing.hostname ?? host.hostnameHint,
        observations: dedupeObservations([...(existing.observations ?? []), ...hostObservations]),
        metadata: {
          ...existing.metadata,
          packetIntel: {
            ...host.metadata,
            collectedAt: snapshot.collectedAt,
            collector: snapshot.collector,
          },
        },
      };
      const idx = next.findIndex((candidate) => candidate.ip === host.ip);
      if (idx !== -1) {
        next[idx] = merged;
      }
      continue;
    }

    if (!isEligibleManagedIp(host.ip)) {
      continue;
    }

    const created: DiscoveryCandidate = {
      ip: host.ip,
      hostname: host.hostnameHint,
      services: [],
      source: "passive",
      observations: hostObservations,
      metadata: {
        packetIntel: {
          ...host.metadata,
          collectedAt: snapshot.collectedAt,
          collector: snapshot.collector,
        },
      },
    };
    next.push(created);
    existingByIp.set(host.ip, created);
  }

  return next;
};

/* ---------- Main Discovery Pipeline ---------- */

export const runDiscovery = async (options: DiscoveryRunOptions = {}): Promise<DiscoverySnapshot> => {
  const settings = stateStore.getRuntimeSettings();
  const localIps = getLocalInterfaceIdentity().ipSet;
  const isManagedCandidate = (candidate: DiscoveryCandidate): boolean =>
    isEligibleManagedIp(candidate.ip) && !localIps.has(candidate.ip);

  const now = Date.now();
  const manualScan = options.forceDeepScan === true;
  const deepScan =
    manualScan ||
    lastDeepScanAt === 0 ||
    now - lastDeepScanAt >= settings.deepScanIntervalMs;
  const discoveryBudgetMs =
    typeof options.budgetMs === "number" && Number.isFinite(options.budgetMs)
      ? Math.max(30_000, Math.floor(options.budgetMs))
      : Number.POSITIVE_INFINITY;
  const deadlineAt = Number.isFinite(discoveryBudgetMs)
    ? now + discoveryBudgetMs
    : Number.POSITIVE_INFINITY;
  const phaseTelemetry: DiscoveryPhaseTelemetry[] = [];

  // Background OUI database update during deep scans
  if (deepScan && (lastOuiUpdateAt === 0 || now - lastOuiUpdateAt >= settings.ouiUpdateIntervalMs)) {
    lastOuiUpdateAt = now;
    updateOuiDatabase().catch((err) => console.error("[discovery] OUI update failed:", err));
  }

  /* ── Phase 1: Network Presence ────────────────────────────────────── */

  const passiveRaw = await runBudgetedStep(
    "passive discovery",
    [] as DiscoveryCandidate[],
    {
      key: "passive-discovery",
      deadlineAt,
      desiredMs: 12_000,
      reserveMs: 80_000,
      minimumMs: DISCOVERY_MIN_CORE_STEP_BUDGET_MS,
      telemetry: phaseTelemetry,
    },
    async () => collectPassiveCandidates(),
  );
  const passive = passiveRaw
    .map(normalizeCandidate)
    .filter(isManagedCandidate);

  // Multicast discovery (mDNS + SSDP)
  let multicastCandidates: DiscoveryCandidate[] = [];
  if (settings.enableMdnsDiscovery || settings.enableSsdpDiscovery) {
    const multicastRaw = await runBudgetedStep(
      "multicast discovery",
      [] as DiscoveryCandidate[],
      {
        key: "multicast-discovery",
        deadlineAt,
        desiredMs: deepScan ? 8_000 : 3_000,
        reserveMs: 72_000,
        telemetry: phaseTelemetry,
      },
      async (stepBudgetMs) => discoverMulticast(Math.max(1_000, stepBudgetMs), {
        enableMdns: settings.enableMdnsDiscovery,
        enableSsdp: settings.enableSsdpDiscovery,
      }),
    );
    multicastCandidates = multicastRaw
      .map(normalizeCandidate)
      .filter(isManagedCandidate);
  }

  /* ── Phase 2: Port Scan ───────────────────────────────────────────── */

  const seedIps = [...passive, ...multicastCandidates].map((c) => c.ip);
  const activeRaw = await runBudgetedStep(
    "active discovery",
    [] as DiscoveryCandidate[],
    {
      key: "active-discovery",
      deadlineAt,
      desiredMs: DISCOVERY_ACTIVE_SCAN_BUDGET_MS,
      reserveMs: 55_000,
      minimumMs: DISCOVERY_MIN_CORE_STEP_BUDGET_MS,
      telemetry: phaseTelemetry,
      targetCount: deepScan ? settings.deepActiveTargets : settings.incrementalActiveTargets,
    },
    async (stepBudgetMs) => collectActiveCandidates(seedIps, {
      deepScan,
      targetOffset: activeTargetCursor,
      maxTargets: deepScan ? settings.deepActiveTargets : settings.incrementalActiveTargets,
      maxPortScanHosts: deepScan ? settings.deepPortScanHosts : settings.incrementalPortScanHosts,
      nmapSubnetSweepTimeoutMs: Math.max(15_000, Math.min(120_000, stepBudgetMs)),
    }),
  );
  const active = activeRaw
    .map(normalizeCandidate)
    .filter(isManagedCandidate);

  if (deepScan) {
    lastDeepScanAt = now;
  }

  const span = Math.max(1, deepScan ? settings.deepActiveTargets : settings.incrementalActiveTargets);
  activeTargetCursor = (activeTargetCursor + span) % 1024;

  // Adapter discovery sources
  const knownIps = [...new Set([...passive.map((c) => c.ip), ...multicastCandidates.map((c) => c.ip), ...active.map((c) => c.ip)])];
  const adapterCandidatesRaw = await runBudgetedStep(
    "adapter discovery",
    [] as DiscoveryCandidate[],
    {
      key: "adapter-discovery",
      deadlineAt,
      desiredMs: DISCOVERY_ADAPTER_DISCOVERY_BUDGET_MS,
      reserveMs: 42_000,
      telemetry: phaseTelemetry,
      targetCount: knownIps.length,
    },
    async () => adapterRegistry.runAdapterDiscovery(knownIps),
  );
  const adapterCandidates = adapterCandidatesRaw
    .map(normalizeCandidate)
    .filter(isManagedCandidate);

  /* ── Phase 3+4: Merge, Fingerprint, Enrich ────────────────────────── */

  const allCandidates = [...passive, ...multicastCandidates, ...active, ...adapterCandidates];
  let merged = mergeDiscoveryCandidates(allCandidates);

  // Service fingerprinting (incremental batch)
  const configuredMax = deepScan ? settings.deepFingerprintTargets : settings.incrementalFingerprintTargets;
  const maxFpTargets = manualScan ? Math.max(configuredMax, merged.length) : configuredMax;
  const fingerprintConcurrency = deepScan ? 8 : 3;
  const fingerprintPlanningBudgetMs = computeStepBudgetMs(
    deadlineAt,
    DISCOVERY_FINGERPRINT_BUDGET_MS,
    35_000,
    DISCOVERY_MIN_CORE_STEP_BUDGET_MS,
  );
  const fpTargets = fingerprintPlanningBudgetMs === null
    ? []
    : selectFingerprintTargets(
      merged,
      deepScan,
      budgetedTargetLimit(
        maxFpTargets,
        Math.max(1_000, Math.min(3_000, fingerprintPlanningBudgetMs)),
        fingerprintConcurrency,
        fingerprintPlanningBudgetMs,
      ),
      manualScan,
    );
  if (fpTargets.length > 0) {
    const fpResults = await runBudgetedStep(
      "service fingerprinting",
      [] as Awaited<ReturnType<typeof fingerprintBatch>>,
      {
        key: "service-fingerprinting",
        deadlineAt,
        desiredMs: DISCOVERY_FINGERPRINT_BUDGET_MS,
        reserveMs: 35_000,
        minimumMs: DISCOVERY_MIN_CORE_STEP_BUDGET_MS,
        telemetry: phaseTelemetry,
        targetCount: fpTargets.length,
      },
      async (stepBudgetMs) => fingerprintBatch(fpTargets, {
        maxConcurrency: fingerprintConcurrency,
        timeoutMs: Math.max(1_000, Math.min(3_000, stepBudgetMs)),
        enableSnmp: settings.enableSnmpProbe,
        aggressive: deepScan,
      }),
    );
    if (fpResults.length > 0) {
      merged = applyFingerprintResults(merged, fpResults);
    }
  }

  // Deep nmap service/version + NSE script fingerprinting
  if (settings.enableAdvancedNmapFingerprint) {
    const maxNmapTargets = deepScan ? settings.deepNmapTargets : settings.incrementalNmapTargets;
    const nmapConcurrency = deepScan ? 4 : 2;
    const nmapPlanningBudgetMs = computeStepBudgetMs(
      deadlineAt,
      DISCOVERY_NMAP_DEEP_BUDGET_MS,
      25_000,
      DISCOVERY_MIN_CORE_STEP_BUDGET_MS,
    );
    const nmapCandidates = (nmapPlanningBudgetMs === null ? [] : fpTargets)
      .filter((candidate) => candidate.services.length > 0)
      .slice(0, nmapPlanningBudgetMs === null
        ? 0
        : budgetedTargetLimit(
          maxNmapTargets,
          Math.max(5_000, Math.min(settings.nmapFingerprintTimeoutMs, nmapPlanningBudgetMs)),
          nmapConcurrency,
          nmapPlanningBudgetMs,
        ));
    if (nmapCandidates.length > 0) {
      const nmapResults = await runBudgetedStep(
        "deep nmap fingerprinting",
        [] as Awaited<ReturnType<typeof runNmapDeepFingerprint>>,
        {
          key: "deep-nmap-fingerprinting",
          deadlineAt,
          desiredMs: DISCOVERY_NMAP_DEEP_BUDGET_MS,
          reserveMs: 25_000,
          minimumMs: DISCOVERY_MIN_CORE_STEP_BUDGET_MS,
          telemetry: phaseTelemetry,
          targetCount: nmapCandidates.length,
        },
        async (stepBudgetMs) => runNmapDeepFingerprint(nmapCandidates, {
          timeoutMs: Math.max(5_000, Math.min(settings.nmapFingerprintTimeoutMs, stepBudgetMs)),
          maxConcurrency: nmapConcurrency,
        }),
      );
      if (nmapResults.length > 0) {
        merged = applyProbeResults(merged, nmapResults, "nmapDeep");
      }
    }
  }

  // Browser-aware HTTP console observation (Playwright when available)
  if (settings.enableBrowserObservation) {
    const configuredBrowserTargets = deepScan
      ? settings.deepBrowserObservationTargets
      : settings.incrementalBrowserObservationTargets;
    const browserConcurrency = deepScan ? 3 : 2;
    const browserPlanningBudgetMs = computeStepBudgetMs(
      deadlineAt,
      DISCOVERY_BROWSER_OBSERVATION_BUDGET_MS,
      15_000,
      DISCOVERY_MIN_CORE_STEP_BUDGET_MS,
    );
    const maxBrowserTargets = browserPlanningBudgetMs === null
      ? 0
      : budgetedTargetLimit(
        configuredBrowserTargets,
        Math.max(2_000, Math.min(settings.browserObservationTimeoutMs, browserPlanningBudgetMs)),
        browserConcurrency,
        browserPlanningBudgetMs,
      );
    const browserCandidates = merged
      .filter((candidate) => candidate.services.some((service) => HTTP_PORTS.has(service.port)))
      .sort((a, b) => {
        const aUnknown = !a.typeHint || a.typeHint === "unknown" ? 0 : 1;
        const bUnknown = !b.typeHint || b.typeHint === "unknown" ? 0 : 1;
        if (aUnknown !== bUnknown) {
          return aUnknown - bUnknown;
        }
        return b.services.length - a.services.length;
      })
      .slice(0, Math.max(0, maxBrowserTargets));
    if (browserCandidates.length > 0) {
      const browserResults = await runBudgetedStep(
        "browser observation",
        [] as Awaited<ReturnType<typeof observeBrowserSurfaces>>,
        {
          key: "browser-observation",
          deadlineAt,
          desiredMs: DISCOVERY_BROWSER_OBSERVATION_BUDGET_MS,
          reserveMs: 15_000,
          minimumMs: DISCOVERY_MIN_CORE_STEP_BUDGET_MS,
          telemetry: phaseTelemetry,
          targetCount: browserCandidates.length,
        },
        async (stepBudgetMs) => observeBrowserSurfaces(browserCandidates, {
          timeoutMs: Math.max(2_000, Math.min(settings.browserObservationTimeoutMs, stepBudgetMs)),
          maxTargets: maxBrowserTargets,
          captureScreenshots: settings.browserObservationCaptureScreenshots,
          maxConcurrency: browserConcurrency,
        }),
      );
      if (browserResults.length > 0) {
        merged = applyProbeResults(merged, browserResults, "browserObservation");
      }
    }
  }

  // Passive packet intelligence (Wireshark-style metadata via tshark)
  if (settings.enablePacketIntel) {
    const packetSnapshot = await runBudgetedStep(
      "packet intelligence",
      null as Awaited<ReturnType<typeof collectPacketIntelSnapshot>>,
      {
        key: "packet-intelligence",
        deadlineAt,
        desiredMs: DISCOVERY_PACKET_INTEL_BUDGET_MS,
        reserveMs: 10_000,
        telemetry: phaseTelemetry,
      },
      async (stepBudgetMs) => collectPacketIntelSnapshot({
        durationSec: Math.min(60, settings.packetIntelDurationSec + (deepScan ? 2 : 0)),
        maxPackets: deepScan ? settings.packetIntelMaxPackets * 2 : settings.packetIntelMaxPackets,
        topTalkers: settings.packetIntelTopTalkers,
        timeoutMs: Math.max(3_000, Math.min((settings.packetIntelDurationSec + 4) * 1_000, stepBudgetMs)),
      }),
    );
    if (packetSnapshot) {
      merged = applyPacketIntelSnapshot(merged, packetSnapshot, {
        includeDhcpLeaseEvidence: settings.enableDhcpLeaseIntel,
      });
    }
  }

  // Hostname enrichment
  const unresolvedHostnames = merged.filter((candidate) => !candidate.hostname).length;
  merged = await runBudgetedStep(
    "hostname enrichment",
    merged,
    {
      key: "hostname-enrichment",
      deadlineAt,
      desiredMs: DISCOVERY_HOSTNAME_BUDGET_MS,
      reserveMs: 5_000,
      telemetry: phaseTelemetry,
      targetCount: unresolvedHostnames,
    },
    async () => enrichHostnames(merged, deepScan),
  );

  // Adapter enrichment
  merged = await runBudgetedStep(
    "adapter enrichment",
    merged,
    {
      key: "adapter-enrichment",
      deadlineAt,
      desiredMs: DISCOVERY_ADAPTER_ENRICH_BUDGET_MS,
      reserveMs: 0,
      telemetry: phaseTelemetry,
      targetCount: merged.length,
    },
    async () => {
      const next: DiscoveryCandidate[] = [];
      const maxConcurrency = deepScan ? 8 : 4;

      for (let idx = 0; idx < merged.length; idx += maxConcurrency) {
        if (remainingBudgetMs(deadlineAt) <= DISCOVERY_MIN_STEP_BUDGET_MS) {
          console.warn(`[discovery] Adapter enrichment stopped early after ${next.length} candidates to preserve scanner cadence.`);
          next.push(...merged.slice(idx));
          break;
        }

        const batch = merged.slice(idx, idx + maxConcurrency);
        const batchResults = await Promise.all(
          batch.map(async (candidate) => normalizeCandidate(await adapterRegistry.enrichCandidate(candidate))),
        );
        next.push(...batchResults);
      }

      return next;
    },
  );
  merged = merged.filter(isManagedCandidate);

  /* ── Phase 5: Classification (happens in candidateToDevice, called by loop.ts) ── */

  const discoveredAt = new Date().toISOString();
  const timedOutPhaseCount = phaseTelemetry.filter((phase) => phase.status === "timed_out").length;
  const skippedPhaseCount = phaseTelemetry.filter((phase) => phase.status === "skipped").length;
  const failedPhaseCount = phaseTelemetry.filter((phase) => phase.status === "failed").length;
  const diagnostics: DiscoveryDiagnostics = {
    scanMode: deepScan ? "deep" : "incremental",
    startedAt: new Date(now).toISOString(),
    completedAt: discoveredAt,
    elapsedMs: Math.max(0, Date.now() - now),
    budgetMs: Number.isFinite(discoveryBudgetMs) ? discoveryBudgetMs : undefined,
    phaseCount: phaseTelemetry.length,
    constrainedPhaseCount: timedOutPhaseCount + skippedPhaseCount,
    timedOutPhaseCount,
    skippedPhaseCount,
    failedPhaseCount,
    phases: phaseTelemetry,
  };

  return {
    discoveredAt,
    scanMode: deepScan ? "deep" : "incremental",
    activeTargets: active.length,
    passive,
    active,
    merged,
    diagnostics,
  };
};
