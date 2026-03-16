import { collectActiveCandidates } from "@/lib/discovery/active";
import { mergeDiscoveryCandidates } from "@/lib/discovery/classify";
import { buildObservation, dedupeObservations } from "@/lib/discovery/evidence";
import { collectPacketIntelSnapshot } from "@/lib/discovery/packet-intel";
import { collectPassiveCandidates } from "@/lib/discovery/passive";
import {
  CURRENT_FINGERPRINT_VERSION,
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
import type { Device, ServiceFingerprint } from "@/lib/state/types";

interface DiscoveryRunOptions {
  forceDeepScan?: boolean;
  budgetMs?: number;
}

const normalizeCandidate = (candidate: DiscoveryCandidate): DiscoveryCandidate => ({
  ...candidate,
  observations: Array.isArray(candidate.observations) ? candidate.observations : [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
let fingerprintCursor = 0;
let lastOuiUpdateAt = 0;

const DISCOVERY_PHASE_STATE_METADATA_KEY = "discoveryPhases";
export type ScheduledDiscoveryPhaseKey = "fingerprint" | "nmapDeep" | "browserObservation" | "hostname";

const HTTP_PORTS = new Set([80, 443, 8080, 8443, 8000, 9000, 5000, 5001, 7443, 9443]);
const SSH_PORTS = new Set([22, 2222]);
const SNMP_PORTS = new Set([161]);
const DNS_PORTS = new Set([53]);
const WINRM_PORTS = new Set([5985, 5986]);
const MQTT_PORTS = new Set([1883, 8883]);
const SMB_PORTS = new Set([445]);
const NETBIOS_PORTS = new Set([137, 139]);
const UNKNOWN_SERVICE_NAMES = new Set(["", "unknown", "tcpwrapped", "generic"]);
const DISCOVERY_FINGERPRINT_ATTEMPT_COOLDOWN_MS = 15 * 60_000;
const DISCOVERY_DEEP_FINGERPRINT_ATTEMPT_COOLDOWN_MS = 5 * 60_000;
const DISCOVERY_NMAP_REFRESH_MS = 8 * 60 * 60_000;
const DISCOVERY_DEEP_NMAP_REFRESH_MS = 2 * 60 * 60_000;
const DISCOVERY_NMAP_ATTEMPT_COOLDOWN_MS = 90 * 60_000;
const DISCOVERY_DEEP_NMAP_ATTEMPT_COOLDOWN_MS = 30 * 60_000;
const DISCOVERY_BROWSER_REFRESH_MS = 6 * 60 * 60_000;
const DISCOVERY_DEEP_BROWSER_REFRESH_MS = 2 * 60 * 60_000;
const DISCOVERY_BROWSER_ATTEMPT_COOLDOWN_MS = 90 * 60_000;
const DISCOVERY_DEEP_BROWSER_ATTEMPT_COOLDOWN_MS = 30 * 60_000;

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

export const parseIsoMs = (value: unknown): number | null => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const timeSinceIsoMs = (value: unknown, nowMs: number): number => {
  const parsed = parseIsoMs(value);
  return parsed === null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - parsed);
};

const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  count === 1 ? singular : plural;

const joinPhaseNotes = (...notes: Array<string | undefined>): string | undefined => {
  const parts = notes
    .map((note) => (typeof note === "string" ? note.trim() : ""))
    .filter((note) => note.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
};

const deferredTargetNote = (options: {
  targetCount?: number;
  dueTargetCount?: number;
  deferredTargetCount?: number;
  skipped?: boolean;
}): string | undefined => {
  const dueTargetCount = typeof options.dueTargetCount === "number"
    ? Math.max(0, Math.floor(options.dueTargetCount))
    : undefined;
  if (dueTargetCount === undefined || dueTargetCount === 0) {
    return undefined;
  }

  const selectedTargetCount = typeof options.targetCount === "number"
    ? Math.max(0, Math.floor(options.targetCount))
    : undefined;
  const deferredTargetCount = typeof options.deferredTargetCount === "number"
    ? Math.max(0, Math.floor(options.deferredTargetCount))
    : Math.max(0, dueTargetCount - (selectedTargetCount ?? dueTargetCount));

  if (deferredTargetCount <= 0) {
    return undefined;
  }

  if (options.skipped) {
    return `${deferredTargetCount} due ${pluralize(deferredTargetCount, "target")} deferred to later cycles.`;
  }

  const processedTargetCount = selectedTargetCount ?? Math.max(0, dueTargetCount - deferredTargetCount);
  return `Scheduled ${processedTargetCount} of ${dueTargetCount} due ${pluralize(dueTargetCount, "target")}; ${deferredTargetCount} deferred to later cycles.`;
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
export const DISCOVERY_FINGERPRINT_BUDGET_MS = 25_000;
export const DISCOVERY_NMAP_DEEP_BUDGET_MS = 25_000;
export const DISCOVERY_BROWSER_OBSERVATION_BUDGET_MS = 30_000;
const DISCOVERY_PACKET_INTEL_BUDGET_MS = 12_000;
export const DISCOVERY_HOSTNAME_BUDGET_MS = 10_000;
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
    dueTargetCount?: number;
    deferredTargetCount?: number;
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
      dueTargetCount: options.dueTargetCount,
      deferredTargetCount: options.deferredTargetCount,
      note: joinPhaseNotes(
        options.note ?? "No discovery budget remained for this phase.",
        deferredTargetNote({ ...options, skipped: true }),
      ),
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
      dueTargetCount: options.dueTargetCount,
      deferredTargetCount: options.deferredTargetCount,
      note: joinPhaseNotes(
        result.timedOut
          ? options.note ?? "Phase exceeded its budget and returned partial results."
          : options.note,
        deferredTargetNote(options),
      ),
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
      dueTargetCount: options.dueTargetCount,
      deferredTargetCount: options.deferredTargetCount,
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

export const enrichHostnames = async (
  candidates: DiscoverySnapshot["merged"],
  selected: DiscoveryCandidate[],
  maxConcurrency: number,
): Promise<DiscoverySnapshot["merged"]> => {
  if (selected.length === 0) {
    return candidates;
  }

  const resolved: Array<{ ip: string; hostname: string | undefined }> = [];
  for (let idx = 0; idx < selected.length; idx += maxConcurrency) {
    const batch = selected.slice(idx, idx + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(async (candidate) => ({
        ip: candidate.ip,
        hostname: await reverseHostname(candidate.ip),
      })),
    );
    resolved.push(...batchResults);
  }
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

export const selectFingerprintTargets = (
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
    const phaseState = getDiscoveryPhaseState(c, "fingerprint");
    const lastAttemptAgeMs = timeSinceIsoMs(phaseState.lastAttemptedAt, nowMs);
    const attemptCooldownMs = forceRefresh
      ? 0
      : deepScan
        ? DISCOVERY_DEEP_FINGERPRINT_ATTEMPT_COOLDOWN_MS
        : DISCOVERY_FINGERPRINT_ATTEMPT_COOLDOWN_MS;

    if (c.services.length === 0) {
      if (!forceRefresh) {
        return false;
      }
      return lastAttemptAgeMs >= attemptCooldownMs;
    }

    const fp = c.metadata.fingerprint as Record<string, unknown> | undefined;
    const missingCoverage = hasCoverageGaps(c);
    if (forceRefresh || missingCoverage) {
      if (lastAttemptAgeMs < attemptCooldownMs) {
        return false;
      }
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

    if (lastAttemptAgeMs < attemptCooldownMs) {
      return false;
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

export const mergeServiceSets = (
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

export const getDiscoveryPhaseState = (
  candidate: DiscoveryCandidate,
  phaseKey: ScheduledDiscoveryPhaseKey,
): Record<string, unknown> => {
  const root = candidate.metadata[DISCOVERY_PHASE_STATE_METADATA_KEY];
  if (!isRecord(root)) {
    return {};
  }

  const phase = root[phaseKey];
  return isRecord(phase) ? phase : {};
};

export const withDiscoveryPhaseState = (
  candidate: DiscoveryCandidate,
  phaseKey: ScheduledDiscoveryPhaseKey,
  patch: Record<string, unknown>,
): DiscoveryCandidate => {
  const root = isRecord(candidate.metadata[DISCOVERY_PHASE_STATE_METADATA_KEY])
    ? candidate.metadata[DISCOVERY_PHASE_STATE_METADATA_KEY] as Record<string, unknown>
    : {};
  const current = isRecord(root[phaseKey]) ? root[phaseKey] as Record<string, unknown> : {};

  return {
    ...candidate,
    metadata: {
      ...candidate.metadata,
      [DISCOVERY_PHASE_STATE_METADATA_KEY]: {
        ...root,
        [phaseKey]: {
          ...current,
          ...patch,
        },
      },
    },
  };
};

export const annotateDiscoveryPhaseTargets = (
  candidates: DiscoveryCandidate[],
  targets: DiscoveryCandidate[],
  phaseKey: ScheduledDiscoveryPhaseKey,
  patch: Record<string, unknown>,
): DiscoveryCandidate[] => {
  if (targets.length === 0) {
    return candidates;
  }

  const targetIps = new Set(targets.map((candidate) => candidate.ip));
  return candidates.map((candidate) =>
    targetIps.has(candidate.ip)
      ? withDiscoveryPhaseState(candidate, phaseKey, patch)
      : candidate,
  );
};

export const takeTargetsByEstimatedWork = (
  candidates: DiscoveryCandidate[],
  options: {
    maxTargets: number;
    stepBudgetMs: number;
    maxConcurrency: number;
    estimateTargetMs: (candidate: DiscoveryCandidate) => number;
    budgetUtilizationRatio?: number;
  },
): DiscoveryCandidate[] => {
  const maxTargets = Math.max(0, Math.floor(options.maxTargets));
  if (maxTargets === 0 || candidates.length === 0) {
    return [];
  }

  const budgetUtilizationRatio = Math.min(0.95, Math.max(0.25, options.budgetUtilizationRatio ?? 0.65));
  const workBudgetMs = Math.max(
    1_000,
    Math.floor(options.stepBudgetMs * Math.max(1, options.maxConcurrency) * budgetUtilizationRatio),
  );
  const selected: DiscoveryCandidate[] = [];
  let totalEstimatedMs = 0;

  for (const candidate of candidates) {
    if (selected.length >= maxTargets) {
      break;
    }

    const estimateMs = Math.max(500, Math.floor(options.estimateTargetMs(candidate)));
    if (selected.length > 0 && totalEstimatedMs + estimateMs > workBudgetMs) {
      break;
    }

    selected.push(candidate);
    totalEstimatedMs += estimateMs;
  }

  if (selected.length > 0) {
    return selected;
  }

  return candidates.slice(0, Math.min(1, maxTargets));
};

const countBrowserEndpoints = (candidate: DiscoveryCandidate): number => {
  const uniquePorts = new Set<number>();
  for (const service of candidate.services) {
    if (service.transport !== "tcp") {
      continue;
    }
    if (HTTP_PORTS.has(service.port) || /http/i.test(service.name)) {
      uniquePorts.add(service.port);
    }
  }
  return Math.max(1, Math.min(3, uniquePorts.size || 2));
};

export const estimateFingerprintTargetMs = (
  candidate: DiscoveryCandidate,
  deepScan: boolean,
): number => {
  const ports = new Set(candidate.services.map((service) => service.port));
  const aggressive = deepScan;
  const tlsTargets = [...ports].filter((port) => [443, 8443, 7443, 9443, 5001].includes(port)).slice(0, aggressive ? 3 : 2).length;
  const webTargets = [
    ...[...ports].filter((port) => [443, 8443, 7443, 9443, 5001].includes(port)),
    ...[...ports].filter((port) => [80, 8080, 8000, 9000].includes(port)),
  ].slice(0, aggressive ? 4 : 2).length;
  const bannerTargets = [...ports].filter((port) => [21, 23, 25, 110, 143].includes(port)).length;
  const unknownTargets = candidate.services
    .filter((service) => isUnknownServiceName(service.name))
    .slice(0, aggressive ? 10 : 4)
    .length;

  let estimatedMs = 750;
  if ([...SSH_PORTS].some((port) => ports.has(port))) {
    estimatedMs += 1_800;
  }
  estimatedMs += tlsTargets * 2_400;
  estimatedMs += webTargets * 1_900;
  if (ports.has(161) || aggressive) {
    estimatedMs += 1_800;
  }
  estimatedMs += bannerTargets * 900;
  if ([...DNS_PORTS].some((port) => ports.has(port)) || aggressive) {
    estimatedMs += 1_400;
  }
  if ([...WINRM_PORTS].some((port) => ports.has(port))) {
    estimatedMs += 1_700;
  }
  if ([...MQTT_PORTS].some((port) => ports.has(port))) {
    estimatedMs += 1_300;
  }
  if ([...SMB_PORTS].some((port) => ports.has(port))) {
    estimatedMs += 1_400;
  }
  if ([...NETBIOS_PORTS].some((port) => ports.has(port)) || aggressive) {
    estimatedMs += 1_300;
  }
  estimatedMs += unknownTargets * 3_800;
  estimatedMs += Math.max(0, candidate.services.length - 4) * 350;

  if (aggressive && candidate.services.length === 0) {
    estimatedMs += 7_000;
  }

  return Math.min(36_000, estimatedMs);
};

export const estimateNmapDeepTargetMs = (
  configuredTimeoutMs: number,
): number => Math.max(8_000, Math.min(45_000, configuredTimeoutMs + 4_000));

export const estimateBrowserObservationTargetMs = (
  candidate: DiscoveryCandidate,
  configuredTimeoutMs: number,
): number => 2_000 + countBrowserEndpoints(candidate) * Math.min(configuredTimeoutMs, 7_000);

export const estimateHostnameLookupMs = (): number =>
  process.platform === "win32" ? 3_500 : 2_200;

export const hydrateCandidatesFromDevices = (
  candidates: DiscoveryCandidate[],
  devices: Device[],
): DiscoveryCandidate[] => {
  const devicesByIp = new Map<string, Device>();
  const devicesByMac = new Map<string, Device>();

  for (const device of devices) {
    devicesByIp.set(device.ip, device);
    for (const ip of device.secondaryIps ?? []) {
      if (!devicesByIp.has(ip)) {
        devicesByIp.set(ip, device);
      }
    }

    if (device.mac) {
      devicesByMac.set(device.mac.toLowerCase(), device);
    }
  }

  return candidates.map((candidate) => {
    const previous = devicesByIp.get(candidate.ip)
      ?? (candidate.mac ? devicesByMac.get(candidate.mac.toLowerCase()) : undefined);
    if (!previous) {
      return candidate;
    }

    return {
      ...candidate,
      hostname: candidate.hostname ?? previous.hostname,
      vendor: candidate.vendor ?? previous.vendor,
      os: candidate.os ?? previous.os,
      services: mergeServiceSets(candidate.services, previous.services ?? []),
      metadata: {
        ...previous.metadata,
        ...candidate.metadata,
      },
    };
  });
};

export const planNmapTargets = (
  candidates: DiscoveryCandidate[],
  options: {
    deepScan: boolean;
    maxTargets: number;
    stepBudgetMs: number;
    maxConcurrency: number;
    timeoutMs: number;
    budgetUtilizationRatio?: number;
  },
): { dueTargets: DiscoveryCandidate[]; selectedTargets: DiscoveryCandidate[] } => {
  const nowMs = Date.now();
  const refreshMs = options.deepScan ? DISCOVERY_DEEP_NMAP_REFRESH_MS : DISCOVERY_NMAP_REFRESH_MS;
  const attemptCooldownMs = options.deepScan
    ? DISCOVERY_DEEP_NMAP_ATTEMPT_COOLDOWN_MS
    : DISCOVERY_NMAP_ATTEMPT_COOLDOWN_MS;

  const ordered = candidates
    .filter((candidate) => candidate.services.length > 0)
    .filter((candidate) => {
      const nmapMetadata = isRecord(candidate.metadata.nmapDeep) ? candidate.metadata.nmapDeep : {};
      const collectedAtMs = parseIsoMs(nmapMetadata.collectedAt);
      const phaseState = getDiscoveryPhaseState(candidate, "nmapDeep");
      const lastAttemptAgeMs = timeSinceIsoMs(phaseState.lastAttemptedAt, nowMs);
      if (lastAttemptAgeMs < attemptCooldownMs) {
        return false;
      }

      const neverCollected = collectedAtMs === null;
      const stale = collectedAtMs !== null && nowMs - collectedAtMs >= refreshMs;
      const needsRetry = phaseState.lastStatus === "timed_out" || phaseState.lastStatus === "failed";
      return neverCollected || stale || needsRetry;
    })
    .sort((a, b) => {
      const aNeverCollected = parseIsoMs(isRecord(a.metadata.nmapDeep) ? a.metadata.nmapDeep.collectedAt : undefined) === null ? 1 : 0;
      const bNeverCollected = parseIsoMs(isRecord(b.metadata.nmapDeep) ? b.metadata.nmapDeep.collectedAt : undefined) === null ? 1 : 0;
      if (aNeverCollected !== bNeverCollected) {
        return bNeverCollected - aNeverCollected;
      }

      const aUnknown = !a.typeHint || a.typeHint === "unknown" ? 1 : 0;
      const bUnknown = !b.typeHint || b.typeHint === "unknown" ? 1 : 0;
      if (aUnknown !== bUnknown) {
        return bUnknown - aUnknown;
      }

      const aAttemptAge = timeSinceIsoMs(getDiscoveryPhaseState(a, "nmapDeep").lastAttemptedAt, nowMs);
      const bAttemptAge = timeSinceIsoMs(getDiscoveryPhaseState(b, "nmapDeep").lastAttemptedAt, nowMs);
      if (aAttemptAge !== bAttemptAge) {
        return bAttemptAge - aAttemptAge;
      }

      const serviceDiff = b.services.length - a.services.length;
      if (serviceDiff !== 0) {
        return serviceDiff;
      }

      return a.ip.localeCompare(b.ip);
    });

  return {
    dueTargets: ordered,
    selectedTargets: takeTargetsByEstimatedWork(ordered, {
      maxTargets: options.maxTargets,
      stepBudgetMs: options.stepBudgetMs,
      maxConcurrency: options.maxConcurrency,
      estimateTargetMs: () => estimateNmapDeepTargetMs(options.timeoutMs),
      budgetUtilizationRatio: options.budgetUtilizationRatio,
    }),
  };
};

export const planBrowserObservationTargets = (
  candidates: DiscoveryCandidate[],
  options: {
    deepScan: boolean;
    maxTargets: number;
    stepBudgetMs: number;
    maxConcurrency: number;
    timeoutMs: number;
    budgetUtilizationRatio?: number;
  },
): { dueTargets: DiscoveryCandidate[]; selectedTargets: DiscoveryCandidate[] } => {
  const nowMs = Date.now();
  const refreshMs = options.deepScan ? DISCOVERY_DEEP_BROWSER_REFRESH_MS : DISCOVERY_BROWSER_REFRESH_MS;
  const attemptCooldownMs = options.deepScan
    ? DISCOVERY_DEEP_BROWSER_ATTEMPT_COOLDOWN_MS
    : DISCOVERY_BROWSER_ATTEMPT_COOLDOWN_MS;

  const ordered = candidates
    .filter((candidate) => candidate.services.some((service) =>
      HTTP_PORTS.has(service.port)
      || service.name.toLowerCase().includes("http")
    ))
    .filter((candidate) => {
      const browserMetadata = isRecord(candidate.metadata.browserObservation)
        ? candidate.metadata.browserObservation
        : {};
      const collectedAtMs = parseIsoMs(browserMetadata.collectedAt);
      const phaseState = getDiscoveryPhaseState(candidate, "browserObservation");
      const lastAttemptAgeMs = timeSinceIsoMs(phaseState.lastAttemptedAt, nowMs);
      if (lastAttemptAgeMs < attemptCooldownMs) {
        return false;
      }

      const neverCollected = collectedAtMs === null;
      const stale = collectedAtMs !== null && nowMs - collectedAtMs >= refreshMs;
      const needsRetry = phaseState.lastStatus === "timed_out" || phaseState.lastStatus === "failed";
      return neverCollected || stale || needsRetry;
    })
    .sort((a, b) => {
      const aNeverCollected = parseIsoMs(isRecord(a.metadata.browserObservation) ? a.metadata.browserObservation.collectedAt : undefined) === null ? 1 : 0;
      const bNeverCollected = parseIsoMs(isRecord(b.metadata.browserObservation) ? b.metadata.browserObservation.collectedAt : undefined) === null ? 1 : 0;
      if (aNeverCollected !== bNeverCollected) {
        return bNeverCollected - aNeverCollected;
      }

      const aUnknown = !a.typeHint || a.typeHint === "unknown" ? 1 : 0;
      const bUnknown = !b.typeHint || b.typeHint === "unknown" ? 1 : 0;
      if (aUnknown !== bUnknown) {
        return bUnknown - aUnknown;
      }

      const aAttemptAge = timeSinceIsoMs(getDiscoveryPhaseState(a, "browserObservation").lastAttemptedAt, nowMs);
      const bAttemptAge = timeSinceIsoMs(getDiscoveryPhaseState(b, "browserObservation").lastAttemptedAt, nowMs);
      if (aAttemptAge !== bAttemptAge) {
        return bAttemptAge - aAttemptAge;
      }

      const endpointDiff = countBrowserEndpoints(b) - countBrowserEndpoints(a);
      if (endpointDiff !== 0) {
        return endpointDiff;
      }

      return a.ip.localeCompare(b.ip);
    });

  return {
    dueTargets: ordered,
    selectedTargets: takeTargetsByEstimatedWork(ordered, {
      maxTargets: options.maxTargets,
      stepBudgetMs: options.stepBudgetMs,
      maxConcurrency: options.maxConcurrency,
      estimateTargetMs: (candidate) => estimateBrowserObservationTargetMs(candidate, options.timeoutMs),
      budgetUtilizationRatio: options.budgetUtilizationRatio,
    }),
  };
};

export const applyProbeResults = <
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
  const deepScan =
    options.forceDeepScan === true ||
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
      async (stepBudgetMs) => discoverMulticast(Math.max(1_000, stepBudgetMs - 250), {
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
      nmapSubnetSweepTimeoutMs: Math.max(15_000, Math.min(120_000, Math.max(15_000, stepBudgetMs - 1_000))),
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
  const state = await stateStore.getState();
  let merged = hydrateCandidatesFromDevices(mergeDiscoveryCandidates(allCandidates), state.devices);

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
        timeoutMs: Math.max(3_000, Math.min((settings.packetIntelDurationSec + 4) * 1_000, Math.max(3_000, stepBudgetMs - 500))),
      }),
    );
    if (packetSnapshot) {
      merged = applyPacketIntelSnapshot(merged, packetSnapshot, {
        includeDhcpLeaseEvidence: settings.enableDhcpLeaseIntel,
      });
    }
  }

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
  const deferredPhaseCount = phaseTelemetry.filter((phase) => (phase.deferredTargetCount ?? 0) > 0).length;
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
    deferredPhaseCount,
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
