import { candidateToDevice } from "@/lib/discovery/classify";
import {
  annotateDiscoveryPhaseTargets,
  applyProbeResults,
  DISCOVERY_BROWSER_OBSERVATION_BUDGET_MS,
  DISCOVERY_FINGERPRINT_BUDGET_MS,
  DISCOVERY_HOSTNAME_BUDGET_MS,
  DISCOVERY_NMAP_DEEP_BUDGET_MS,
  enrichHostnames,
  estimateFingerprintTargetMs,
  estimateHostnameLookupMs,
  getDiscoveryPhaseState,
  planBrowserObservationTargets,
  planNmapTargets,
  ScheduledDiscoveryPhaseKey,
  selectFingerprintTargets,
  takeTargetsByEstimatedWork,
  timeSinceIsoMs,
  withDiscoveryPhaseState,
} from "@/lib/discovery/engine";
import { observeBrowserSurfaces } from "@/lib/discovery/browser-observer";
import { applyFingerprintResults, fingerprintBatch } from "@/lib/discovery/fingerprint";
import { runNmapDeepFingerprint } from "@/lib/discovery/nmap-deep";
import { mergeProtectedDeviceMetadata } from "@/lib/devices/protected-metadata";
import { graphStore } from "@/lib/state/graph";
import { stateStore } from "@/lib/state/store";
import type {
  DiscoveryCandidate,
  DiscoveryEnrichmentSummary,
} from "@/lib/discovery/types";
import type { Device, RuntimeSettings } from "@/lib/state/types";

export const DISCOVERY_ENRICHMENT_FINGERPRINT_JOB_KIND = "discovery.enrichment.fingerprint";
export const DISCOVERY_ENRICHMENT_NMAP_JOB_KIND = "discovery.enrichment.nmap";
export const DISCOVERY_ENRICHMENT_BROWSER_JOB_KIND = "discovery.enrichment.browser";
export const DISCOVERY_ENRICHMENT_HOSTNAME_JOB_KIND = "discovery.enrichment.hostname";

export const DISCOVERY_ENRICHMENT_JOB_KINDS = [
  DISCOVERY_ENRICHMENT_FINGERPRINT_JOB_KIND,
  DISCOVERY_ENRICHMENT_NMAP_JOB_KIND,
  DISCOVERY_ENRICHMENT_BROWSER_JOB_KIND,
  DISCOVERY_ENRICHMENT_HOSTNAME_JOB_KIND,
] as const;

export type DiscoveryEnrichmentJobKind = (typeof DISCOVERY_ENRICHMENT_JOB_KINDS)[number];
export type DiscoveryEnrichmentPhase = "fingerprint" | "nmapDeep" | "browserObservation" | "hostname";

export interface DiscoveryEnrichmentJobPayload {
  phase: DiscoveryEnrichmentPhase;
  deviceIds: string[];
  scanMode: "incremental" | "deep";
  requestedAt: string;
  dueTargetCount: number;
  deferredTargetCount: number;
  schedulerSource: "scanner-cycle" | "control-plane";
}

export interface DiscoveryEnrichmentPlan {
  phase: DiscoveryEnrichmentPhase;
  kind: DiscoveryEnrichmentJobKind;
  scanMode: "incremental" | "deep";
  deviceIds: string[];
  targetCount: number;
  dueTargetCount: number;
  deferredTargetCount: number;
}

export type DiscoveryEnrichmentQueueSummary = DiscoveryEnrichmentSummary;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const phaseToJobKind = (phase: DiscoveryEnrichmentPhase): DiscoveryEnrichmentJobKind => {
  if (phase === "fingerprint") {
    return DISCOVERY_ENRICHMENT_FINGERPRINT_JOB_KIND;
  }
  if (phase === "nmapDeep") {
    return DISCOVERY_ENRICHMENT_NMAP_JOB_KIND;
  }
  if (phase === "browserObservation") {
    return DISCOVERY_ENRICHMENT_BROWSER_JOB_KIND;
  }
  return DISCOVERY_ENRICHMENT_HOSTNAME_JOB_KIND;
};

const phaseToMetadataKey = (phase: DiscoveryEnrichmentPhase): ScheduledDiscoveryPhaseKey =>
  phase === "hostname" ? "hostname" : phase;

const deviceToDiscoveryCandidate = (device: Device): DiscoveryCandidate => {
  const source = typeof device.metadata.source === "string" ? device.metadata.source : "";
  const candidateSource: DiscoveryCandidate["source"] =
    source === "passive" || source === "active" || source === "mdns" || source === "ssdp"
      ? source
      : "active";

  return {
    ip: device.ip,
    mac: device.mac,
    hostname: device.hostname,
    vendor: device.vendor,
    os: device.os,
    typeHint: device.type,
    services: Array.isArray(device.services) ? device.services.map((service) => ({ ...service })) : [],
    source: candidateSource,
    observations: [],
    metadata: {
      ...device.metadata,
      deviceId: device.id,
      secondaryIps: device.secondaryIps ?? [],
    },
  };
};

const normalizeEnrichedDevice = (previous: Device, candidate: DiscoveryCandidate): Device => {
  const next = candidateToDevice(candidate, previous);
  return {
    ...next,
    firstSeenAt: previous.firstSeenAt,
    lastSeenAt: previous.lastSeenAt,
    status: previous.status,
  };
};

const eligibleDevicesForEnrichment = (devices: Device[]): Device[] => {
  const nowMs = Date.now();
  return devices.filter((device) => {
    if (!device.ip || device.status === "offline") {
      return false;
    }
    const lastSeenAtMs = Date.parse(device.lastSeenAt);
    if (!Number.isFinite(lastSeenAtMs)) {
      return true;
    }
    return nowMs - lastSeenAtMs <= 24 * 60 * 60_000;
  });
};

const selectHostnameTargets = (
  candidates: DiscoveryCandidate[],
  options: {
    deepScan: boolean;
    maxTargets: number;
    stepBudgetMs: number;
    maxConcurrency: number;
  },
): { dueTargets: DiscoveryCandidate[]; selectedTargets: DiscoveryCandidate[] } => {
  const nowMs = Date.now();
  const attemptCooldownMs = options.deepScan ? 10 * 60_000 : 30 * 60_000;

  const dueTargets = candidates
    .filter((candidate) => !candidate.hostname)
    .filter((candidate) => {
      const phaseState = getDiscoveryPhaseState(candidate, "hostname");
      return timeSinceIsoMs(phaseState.lastAttemptedAt, nowMs) >= attemptCooldownMs;
    })
    .sort((a, b) => {
      const aAttemptAge = timeSinceIsoMs(getDiscoveryPhaseState(a, "hostname").lastAttemptedAt, nowMs);
      const bAttemptAge = timeSinceIsoMs(getDiscoveryPhaseState(b, "hostname").lastAttemptedAt, nowMs);
      if (aAttemptAge !== bAttemptAge) {
        return bAttemptAge - aAttemptAge;
      }

      const aEvidence = Number((isRecord(a.metadata.discoveryEvidence) ? a.metadata.discoveryEvidence.confidence : 0) ?? 0);
      const bEvidence = Number((isRecord(b.metadata.discoveryEvidence) ? b.metadata.discoveryEvidence.confidence : 0) ?? 0);
      if (aEvidence !== bEvidence) {
        return bEvidence - aEvidence;
      }

      return a.ip.localeCompare(b.ip);
    });

  return {
    dueTargets,
    selectedTargets: takeTargetsByEstimatedWork(dueTargets, {
      maxTargets: options.maxTargets,
      stepBudgetMs: options.stepBudgetMs,
      maxConcurrency: options.maxConcurrency,
      estimateTargetMs: () => estimateHostnameLookupMs(),
      budgetUtilizationRatio: process.platform === "win32" ? 0.5 : 0.6,
    }),
  };
};

export const planDiscoveryEnrichmentJobs = (
  devices: Device[],
  runtimeSettings: RuntimeSettings,
  scanMode: "incremental" | "deep",
): DiscoveryEnrichmentPlan[] => {
  const deepScan = scanMode === "deep";
  const candidates = eligibleDevicesForEnrichment(devices).map(deviceToDiscoveryCandidate);
  const plans: DiscoveryEnrichmentPlan[] = [];

  const fingerprintDue = selectFingerprintTargets(
    candidates,
    deepScan,
    Number.MAX_SAFE_INTEGER,
    false,
  );
  const fingerprintTargets = takeTargetsByEstimatedWork(fingerprintDue, {
    maxTargets: deepScan ? runtimeSettings.deepFingerprintTargets : runtimeSettings.incrementalFingerprintTargets,
    stepBudgetMs: DISCOVERY_FINGERPRINT_BUDGET_MS,
    maxConcurrency: deepScan ? 8 : 3,
    estimateTargetMs: (candidate) => estimateFingerprintTargetMs(candidate, deepScan),
    budgetUtilizationRatio: deepScan ? 0.55 : 0.6,
  });
  if (fingerprintTargets.length > 0) {
    plans.push({
      phase: "fingerprint",
      kind: phaseToJobKind("fingerprint"),
      scanMode,
      deviceIds: fingerprintTargets.map((candidate) => String(candidate.metadata.deviceId ?? candidate.ip)),
      targetCount: fingerprintTargets.length,
      dueTargetCount: fingerprintDue.length,
      deferredTargetCount: Math.max(0, fingerprintDue.length - fingerprintTargets.length),
    });
  }

  if (runtimeSettings.enableAdvancedNmapFingerprint) {
    const plannedTimeoutMs = Math.max(5_000, runtimeSettings.nmapFingerprintTimeoutMs);
    const nmapPlan = planNmapTargets(candidates, {
      deepScan,
      maxTargets: deepScan ? runtimeSettings.deepNmapTargets : runtimeSettings.incrementalNmapTargets,
      stepBudgetMs: DISCOVERY_NMAP_DEEP_BUDGET_MS,
      maxConcurrency: deepScan ? 4 : 2,
      timeoutMs: plannedTimeoutMs,
      budgetUtilizationRatio: deepScan ? 0.65 : 0.7,
    });
    if (nmapPlan.selectedTargets.length > 0) {
      plans.push({
        phase: "nmapDeep",
        kind: phaseToJobKind("nmapDeep"),
        scanMode,
        deviceIds: nmapPlan.selectedTargets.map((candidate) => String(candidate.metadata.deviceId ?? candidate.ip)),
        targetCount: nmapPlan.selectedTargets.length,
        dueTargetCount: nmapPlan.dueTargets.length,
        deferredTargetCount: Math.max(0, nmapPlan.dueTargets.length - nmapPlan.selectedTargets.length),
      });
    }
  }

  if (runtimeSettings.enableBrowserObservation) {
    const browserPlan = planBrowserObservationTargets(candidates, {
      deepScan,
      maxTargets: deepScan
        ? runtimeSettings.deepBrowserObservationTargets
        : runtimeSettings.incrementalBrowserObservationTargets,
      stepBudgetMs: DISCOVERY_BROWSER_OBSERVATION_BUDGET_MS,
      maxConcurrency: deepScan ? 3 : 2,
      timeoutMs: Math.max(2_000, runtimeSettings.browserObservationTimeoutMs),
      budgetUtilizationRatio: deepScan ? 0.6 : 0.65,
    });
    if (browserPlan.selectedTargets.length > 0) {
      plans.push({
        phase: "browserObservation",
        kind: phaseToJobKind("browserObservation"),
        scanMode,
        deviceIds: browserPlan.selectedTargets.map((candidate) => String(candidate.metadata.deviceId ?? candidate.ip)),
        targetCount: browserPlan.selectedTargets.length,
        dueTargetCount: browserPlan.dueTargets.length,
        deferredTargetCount: Math.max(0, browserPlan.dueTargets.length - browserPlan.selectedTargets.length),
      });
    }
  }

  const hostnamePlan = selectHostnameTargets(candidates, {
    deepScan,
    maxTargets: deepScan ? 768 : 192,
    stepBudgetMs: DISCOVERY_HOSTNAME_BUDGET_MS,
    maxConcurrency: deepScan ? 48 : 16,
  });
  if (hostnamePlan.selectedTargets.length > 0) {
    plans.push({
      phase: "hostname",
      kind: phaseToJobKind("hostname"),
      scanMode,
      deviceIds: hostnamePlan.selectedTargets.map((candidate) => String(candidate.metadata.deviceId ?? candidate.ip)),
      targetCount: hostnamePlan.selectedTargets.length,
      dueTargetCount: hostnamePlan.dueTargets.length,
      deferredTargetCount: Math.max(0, hostnamePlan.dueTargets.length - hostnamePlan.selectedTargets.length),
    });
  }

  return plans;
};

const persistCandidateBatch = async (
  previousDevices: Device[],
  candidates: DiscoveryCandidate[],
): Promise<number> => {
  const previousByIp = new Map(previousDevices.map((device) => [device.ip, device]));
  let updatedCount = 0;
  const observations = candidates.flatMap((candidate) => candidate.observations ?? []);

  if (observations.length > 0) {
    stateStore.addDiscoveryObservations(observations);
    stateStore.pruneExpiredDiscoveryObservations();
  }

  for (const candidate of candidates) {
    const previous = previousByIp.get(candidate.ip);
    if (!previous) {
      continue;
    }

    const next = normalizeEnrichedDevice(previous, candidate);
    const merged = mergeProtectedDeviceMetadata(next);
    await stateStore.upsertDevice(merged);
    stateStore.attachRecentObservationsToDevice(merged.ip, merged.id);
    await graphStore.attachDevice(merged);
    updatedCount += 1;
  }

  return updatedCount;
};

const applyPhaseCompletion = (
  candidates: DiscoveryCandidate[],
  phase: DiscoveryEnrichmentPhase,
  scanMode: "incremental" | "deep",
  budgetMs: number,
): DiscoveryCandidate[] => {
  const completedAt = new Date().toISOString();
  return annotateDiscoveryPhaseTargets(candidates, candidates, phaseToMetadataKey(phase), {
    lastAttemptedAt: completedAt,
    lastCompletedAt: completedAt,
    lastStatus: "completed",
    lastBudgetMs: budgetMs,
    lastTargetCount: candidates.length,
    lastScanMode: scanMode,
  });
};

const markPhaseAttempt = (
  candidates: DiscoveryCandidate[],
  phase: DiscoveryEnrichmentPhase,
  scanMode: "incremental" | "deep",
): DiscoveryCandidate[] => annotateDiscoveryPhaseTargets(candidates, candidates, phaseToMetadataKey(phase), {
  lastAttemptedAt: new Date().toISOString(),
  lastScanMode: scanMode,
});

const runHostnameEnrichment = async (
  candidates: DiscoveryCandidate[],
  scanMode: "incremental" | "deep",
): Promise<DiscoveryCandidate[]> => {
  const attempted = markPhaseAttempt(candidates, "hostname", scanMode);
  const enriched = await enrichHostnames(
    attempted,
    attempted,
    scanMode === "deep" ? 48 : 16,
  );
  return applyPhaseCompletion(
    enriched.map((candidate) =>
      candidate.hostname
        ? candidate
        : withDiscoveryPhaseState(candidate, "hostname", {
          lastAttemptedAt: new Date().toISOString(),
        })),
    "hostname",
    scanMode,
    DISCOVERY_HOSTNAME_BUDGET_MS,
  );
};

const runFingerprintEnrichment = async (
  candidates: DiscoveryCandidate[],
  runtimeSettings: RuntimeSettings,
  scanMode: "incremental" | "deep",
): Promise<DiscoveryCandidate[]> => {
  const attempted = markPhaseAttempt(candidates, "fingerprint", scanMode);
  const deepScan = scanMode === "deep";
  const results = await fingerprintBatch(attempted, {
    maxConcurrency: deepScan ? 8 : 3,
    timeoutMs: 3_000,
    enableSnmp: runtimeSettings.enableSnmpProbe,
    aggressive: deepScan,
  });
  const enriched = applyFingerprintResults(attempted, results);
  return applyPhaseCompletion(enriched, "fingerprint", scanMode, DISCOVERY_FINGERPRINT_BUDGET_MS);
};

const runNmapEnrichment = async (
  candidates: DiscoveryCandidate[],
  runtimeSettings: RuntimeSettings,
  scanMode: "incremental" | "deep",
): Promise<DiscoveryCandidate[]> => {
  const attempted = markPhaseAttempt(candidates, "nmapDeep", scanMode);
  const results = await runNmapDeepFingerprint(attempted, {
    timeoutMs: Math.max(5_000, runtimeSettings.nmapFingerprintTimeoutMs),
    maxConcurrency: scanMode === "deep" ? 4 : 2,
  });
  const enriched = applyProbeResults(attempted, results, "nmapDeep");
  return applyPhaseCompletion(enriched, "nmapDeep", scanMode, DISCOVERY_NMAP_DEEP_BUDGET_MS);
};

const runBrowserEnrichment = async (
  candidates: DiscoveryCandidate[],
  runtimeSettings: RuntimeSettings,
  scanMode: "incremental" | "deep",
): Promise<DiscoveryCandidate[]> => {
  const attempted = markPhaseAttempt(candidates, "browserObservation", scanMode);
  const results = await observeBrowserSurfaces(attempted, {
    timeoutMs: Math.max(2_000, runtimeSettings.browserObservationTimeoutMs),
    maxTargets: attempted.length,
    captureScreenshots: runtimeSettings.browserObservationCaptureScreenshots,
    maxConcurrency: scanMode === "deep" ? 3 : 2,
  });
  const enriched = applyProbeResults(attempted, results, "browserObservation");
  return applyPhaseCompletion(enriched, "browserObservation", scanMode, DISCOVERY_BROWSER_OBSERVATION_BUDGET_MS);
};

export const executeDiscoveryEnrichmentJob = async (
  payload: DiscoveryEnrichmentJobPayload,
  runtimeSettings: RuntimeSettings,
): Promise<{ summary: string; updatedDevices: number; phase: DiscoveryEnrichmentPhase }> => {
  const requestedIds = Array.from(new Set(payload.deviceIds.filter((id) => typeof id === "string" && id.trim().length > 0)));
  if (requestedIds.length === 0) {
    return {
      summary: `Discovery enrichment ${payload.phase} skipped: no target devices.`,
      updatedDevices: 0,
      phase: payload.phase,
    };
  }

  const previousDevices = requestedIds
    .map((deviceId) => stateStore.getDeviceById(deviceId))
    .filter((device): device is Device => Boolean(device));
  if (previousDevices.length === 0) {
    return {
      summary: `Discovery enrichment ${payload.phase} skipped: target devices no longer exist.`,
      updatedDevices: 0,
      phase: payload.phase,
    };
  }

  const baseCandidates = previousDevices.map((device) =>
    deviceToDiscoveryCandidate({
      ...device,
      metadata: {
        ...device.metadata,
        deviceId: device.id,
      },
    }));

  let enrichedCandidates: DiscoveryCandidate[];
  if (payload.phase === "fingerprint") {
    enrichedCandidates = await runFingerprintEnrichment(baseCandidates, runtimeSettings, payload.scanMode);
  } else if (payload.phase === "nmapDeep") {
    enrichedCandidates = await runNmapEnrichment(baseCandidates, runtimeSettings, payload.scanMode);
  } else if (payload.phase === "browserObservation") {
    enrichedCandidates = await runBrowserEnrichment(baseCandidates, runtimeSettings, payload.scanMode);
  } else {
    enrichedCandidates = await runHostnameEnrichment(baseCandidates, payload.scanMode);
  }

  const updatedDevices = await persistCandidateBatch(previousDevices, enrichedCandidates);
  const summary = `Discovery enrichment ${payload.phase} processed ${previousDevices.length} device(s), updated ${updatedDevices}.`;
  await stateStore.addAction({
    actor: "steward",
    kind: "discover",
    message: summary,
    context: {
      phase: payload.phase,
      jobKind: phaseToJobKind(payload.phase),
      deviceIds: requestedIds,
      scanMode: payload.scanMode,
      dueTargetCount: payload.dueTargetCount,
      deferredTargetCount: payload.deferredTargetCount,
    },
  });

  return {
    summary,
    updatedDevices,
    phase: payload.phase,
  };
};

export const emptyDiscoveryEnrichmentQueueSummary = (): DiscoveryEnrichmentQueueSummary => ({
  queuedJobs: 0,
  queuedTargets: 0,
  dueTargets: 0,
  deferredTargets: 0,
  phasesWithBacklog: 0,
  phases: [],
});
