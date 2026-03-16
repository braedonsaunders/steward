import { randomUUID } from "node:crypto";
import { runDiscovery } from "@/lib/discovery/engine";
import { candidateToDevice } from "@/lib/discovery/classify";
import { dedupeObservations, evaluateDiscoveryEvidence } from "@/lib/discovery/evidence";
import { generateDiscoveryAdvice } from "@/lib/discovery/advisor";
import type { DiscoveryDiagnostics } from "@/lib/discovery/types";
import { buildManagementSurface } from "@/lib/protocols/negotiator";
import { evaluatePolicy } from "@/lib/policy/engine";
import { matchPlaybooksForIncident } from "@/lib/playbooks/registry";
import { executePlaybook } from "@/lib/playbooks/runtime";
import { getMissingCredentialProtocolsForPlaybook } from "@/lib/adoption/playbook-credentials";
import {
  buildPlaybookRun,
  countRecentFamilyFailures,
  criticalityForActionClass,
  isFamilyQuarantined,
} from "@/lib/playbooks/factory";
import { createApproval, expireStale } from "@/lib/approvals/queue";
import { adapterRegistry } from "@/lib/adapters/registry";
import { ensureDigestScheduler, stopDigestScheduler } from "@/lib/digest/scheduler";
import { routeFinding } from "@/lib/findings/router";
import { localToolRuntime } from "@/lib/local-tools/runtime";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { processNotificationJobs } from "@/lib/notifications/manager";
import {
  evaluateServiceContract,
  getMonitorType,
  getRequiredProtocolsForServiceContract,
  isServiceContractDue,
} from "@/lib/monitoring/contracts";
import { protocolSessionManager } from "@/lib/protocol-sessions/manager";
import { webSessionManager } from "@/lib/web-sessions/manager";
import { graphStore } from "@/lib/state/graph";
import { stateStore } from "@/lib/state/store";
import { runShell } from "@/lib/utils/shell";
import { ensureDeviceAutomationScheduler, stopDeviceAutomationScheduler } from "@/lib/widgets/automations";
import type {
  AgentRunRecord,
  Device,
  DeviceBaseline,
  Incident,
  PlaybookRun,
  Recommendation,
  RuntimeSettings,
  ScannerRunRecord,
  ServiceContract,
} from "@/lib/state/types";

interface StewardCycleSummary {
  discovered: number;
  updatedDevices: number;
  incidentsOpened: number;
  recommendationsAdded: number;
  playbooksTriggered: number;
  playbooksCompleted: number;
  approvalsCreated: number;
}

interface AssuranceSweepSummary {
  dueAssurances: number;
  evaluatedAssurances: number;
  failingAssurances: number;
  pendingAssurances: number;
}

const AVAILABILITY_OFFLINE_INCIDENT_TYPE = "availability.offline";
const SECURITY_TELNET_INCIDENT_TYPE = "security.telnet-exposure";
const ASSURANCE_FAILURE_INCIDENT_TYPE = "assurance.failure";
const LEGACY_SERVICE_CONTRACT_FAILURE_INCIDENT_TYPE = "service-contract.failure";
const TLS_CERT_WARNING_WINDOW_DAYS = 30;
const TLS_CERT_CRITICAL_WINDOW_DAYS = 7;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const daysUntilIso = (value: string): number | null => {
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) {
    return null;
  }
  return Math.ceil((at - Date.now()) / (24 * 60 * 60 * 1000));
};

const tlsServiceLabel = (device: Device, service: Device["services"][number]): string => {
  const base = service.httpInfo?.title?.trim() || service.product?.trim() || service.name;
  return `${base} on ${device.name}:${service.port}`;
};

const mergeProtectedDeviceMetadata = (device: Device): Device => {
  const latest = stateStore.getDeviceById(device.id);
  if (!latest) {
    return device;
  }

  const latestAdoption = getAdoptionRecord(latest);
  const incomingAdoption = isRecord(device.metadata.adoption) ? device.metadata.adoption : {};
  const latestStatus = getDeviceAdoptionStatus(latest);
  const incomingStatus = typeof incomingAdoption.status === "string" ? incomingAdoption.status : undefined;
  const preserveStickyStatus = (latestStatus === "adopted" || latestStatus === "ignored")
    && (incomingStatus === undefined || incomingStatus === "discovered");

  return {
    ...device,
    metadata: {
      ...latest.metadata,
      ...device.metadata,
      adoption: {
        ...latestAdoption,
        ...incomingAdoption,
        ...(preserveStickyStatus ? { status: latestStatus } : {}),
      },
    },
  };
};

const latencyFromPingOutput = (stdout: string): number | undefined => {
  const match = stdout.match(/time[=<]([\d.]+)\s*ms/i);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
};

const measureLatency = async (ip: string): Promise<number | undefined> => {
  const command = process.platform === "win32"
    ? `ping -n 1 -w 1000 ${ip}`
    : `ping -c 1 -W 1 ${ip}`;
  const ping = await runShell(command, 3_500);
  if (!ping.ok) {
    return undefined;
  }

  return latencyFromPingOutput(ping.stdout);
};

const buildBaseline = (
  previous: DeviceBaseline | undefined,
  latencyMs: number,
): DeviceBaseline => {
  if (!previous) {
    return {
      deviceId: "",
      avgLatencyMs: latencyMs,
      maxLatencyMs: latencyMs,
      minLatencyMs: latencyMs,
      samples: 1,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  const samples = previous.samples + 1;
  const avgLatencyMs = (previous.avgLatencyMs * previous.samples + latencyMs) / samples;

  return {
    ...previous,
    avgLatencyMs,
    maxLatencyMs: Math.max(previous.maxLatencyMs, latencyMs),
    minLatencyMs: Math.min(previous.minLatencyMs, latencyMs),
    samples,
    lastUpdatedAt: new Date().toISOString(),
  };
};

const recommendationKey = (recommendation: Recommendation): string =>
  `${recommendation.priority}:${recommendation.title}:${recommendation.relatedDeviceIds.join(",")}`;

const ADOPTION_RECOMMENDATION_TITLE = /^Adopt .+ for active management$/;

const semanticRecommendationKey = (recommendation: Recommendation): string => {
  if (
    !recommendation.dismissed &&
    ADOPTION_RECOMMENDATION_TITLE.test(recommendation.title) &&
    recommendation.relatedDeviceIds.length === 1
  ) {
    return `adopt:${recommendation.relatedDeviceIds[0]}`;
  }

  return recommendationKey(recommendation);
};

const dedupeRecommendations = (recommendations: Recommendation[]): Recommendation[] => {
  const seen = new Set<string>();
  const next: Recommendation[] = [];

  for (const recommendation of recommendations) {
    const key = semanticRecommendationKey(recommendation);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    next.push(recommendation);
  }

  return next;
};

const ensureRecommendation = (
  recommendations: Recommendation[],
  incoming: Omit<Recommendation, "id" | "createdAt" | "dismissed">,
  options?: {
    matchesExisting?: (item: Recommendation) => boolean;
  },
): { next: Recommendation[]; added: boolean } => {
  const key = `${incoming.priority}:${incoming.title}:${incoming.relatedDeviceIds.join(",")}`;
  const existingIndex = recommendations.findIndex((item) => {
    if (item.dismissed) {
      return false;
    }

    if (options?.matchesExisting) {
      return options.matchesExisting(item);
    }

    return recommendationKey(item) === key;
  });

  if (existingIndex !== -1) {
    const existing = recommendations[existingIndex];
    const unchanged =
      existing.title === incoming.title &&
      existing.rationale === incoming.rationale &&
      existing.impact === incoming.impact &&
      existing.priority === incoming.priority &&
      existing.relatedDeviceIds.join(",") === incoming.relatedDeviceIds.join(",");

    if (unchanged) {
      return { next: recommendations, added: false };
    }

    const updated: Recommendation = {
      ...existing,
      ...incoming,
    };
    const next = [...recommendations];
    next[existingIndex] = updated;
    return { next, added: false };
  }

  const created: Recommendation = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    dismissed: false,
    ...incoming,
  };

  return {
    next: [created, ...recommendations],
    added: true,
  };
};

const criticalityToIncidentSeverity = (
  criticality: "low" | "medium" | "high",
): Incident["severity"] => {
  if (criticality === "high") return "critical";
  if (criticality === "medium") return "warning";
  return "info";
};

const criticalityToRecommendationPriority = (
  criticality: "low" | "medium" | "high",
): Recommendation["priority"] => {
  if (criticality === "high") return "high";
  if (criticality === "medium") return "medium";
  return "low";
};

const normalizedIgnoredIncidentTypes = (settings: RuntimeSettings): Set<string> =>
  new Set(
    (settings.ignoredIncidentTypes ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

const evaluateAssurancesForDevice = async (
  device: Device,
  incidents: Incident[],
  recommendations: Recommendation[],
  runtimeSettings: RuntimeSettings,
  options?: {
    assurances?: ServiceContract[];
    includeStateArtifacts?: boolean;
    ignoreDueWindow?: boolean;
  },
): Promise<{
  incidents: Incident[];
  recommendations: Recommendation[];
  incidentsOpened: number;
  recommendationsAdded: number;
}> => {
  let nextIncidents = incidents;
  let nextRecommendations = recommendations;
  let incidentsOpened = 0;
  let recommendationsAdded = 0;

  const assurances = options?.assurances ?? stateStore.getAssurances(device.id);
  if (assurances.length === 0) {
    return {
      incidents: nextIncidents,
      recommendations: nextRecommendations,
      incidentsOpened,
      recommendationsAdded,
    };
  }

  const nowMs = Date.now();
  const available = new Set(
    stateStore.getUsableCredentialProtocols(device.id).map((protocol) => protocol.toLowerCase()),
  );
  const ignoredTypes = normalizedIgnoredIncidentTypes(runtimeSettings);
  const includeStateArtifacts = options?.includeStateArtifacts !== false;
  const assuranceAlertsEnabled = runtimeSettings.serviceContractScannerAlertsEnabled
    && !ignoredTypes.has(ASSURANCE_FAILURE_INCIDENT_TYPE)
    && !ignoredTypes.has(LEGACY_SERVICE_CONTRACT_FAILURE_INCIDENT_TYPE);

  for (const contract of assurances) {
    if (!options?.ignoreDueWindow && !isServiceContractDue(contract, nowMs)) {
      continue;
    }

    const requiredProtocols = getRequiredProtocolsForServiceContract(contract);
    const missingProtocols = requiredProtocols.filter((protocol) => !available.has(protocol.toLowerCase()));
    const findingKey = `service-contract:${contract.id}`;

    if (missingProtocols.length > 0) {
      stateStore.upsertDeviceFindingByDedupe({
        deviceId: device.id,
        dedupeKey: findingKey,
        findingType: "missing_credentials",
        severity: "warning",
        title: `${contract.displayName} waiting for credentials`,
        summary: `Assurance "${contract.displayName}" cannot run until credentials are provided for: ${missingProtocols.join(", ")}.`,
        evidenceJson: {
          assuranceId: contract.id,
          serviceContractId: contract.id,
          requiredProtocols,
          missingProtocols,
        },
        status: "open",
      });

      if (includeStateArtifacts) {
        const credentialRecommendation = ensureRecommendation(nextRecommendations, {
          title: `Provide ${missingProtocols.join(", ")} credentials for ${device.name}`,
          rationale: `Assurance "${contract.displayName}" is blocked by missing credentials.`,
          impact: "Enables monitor execution and automated incident detection.",
          priority: "high",
          relatedDeviceIds: [device.id],
        });
        nextRecommendations = credentialRecommendation.next;
        recommendationsAdded += credentialRecommendation.added ? 1 : 0;
      }

      const pendingCredentialsContract = stateStore.upsertAssurance({
        ...contract,
        policyJson: {
          ...contract.policyJson,
          lastEvaluatedAt: new Date().toISOString(),
          lastStatus: "pending_credentials",
          missingProtocols,
        },
        updatedAt: new Date().toISOString(),
      });
      stateStore.appendAssuranceRun({
        assuranceId: pendingCredentialsContract.id,
        deviceId: device.id,
        workloadId: pendingCredentialsContract.workloadId,
        status: "pending",
        summary: `Awaiting credentials for ${contract.displayName}.`,
        evidenceJson: {
          requiredProtocols,
          missingProtocols,
        },
        evaluatedAt: new Date().toISOString(),
      });
      continue;
    }

    const evaluation = await evaluateServiceContract(device, contract);
    const persistedContract = stateStore.upsertAssurance({
      ...contract,
      policyJson: evaluation.updatedPolicyJson,
      updatedAt: new Date().toISOString(),
    });
    stateStore.appendAssuranceRun({
      assuranceId: persistedContract.id,
      deviceId: device.id,
      workloadId: persistedContract.workloadId,
      status: evaluation.status,
      summary: evaluation.summary,
      evidenceJson: evaluation.evidenceJson,
      evaluatedAt: new Date().toISOString(),
    });

    if (evaluation.status === "pass") {
      const routed = await routeFinding({
        incidents: nextIncidents,
        source: "monitor.assurance",
        finding: {
          deviceId: device.id,
          dedupeKey: findingKey,
          findingType: "assurance",
          severity: "info",
          title: `${contract.displayName} assurance healthy`,
          summary: evaluation.summary,
          evidenceJson: evaluation.evidenceJson,
          status: "resolved",
        },
        incident: {
          title: `Assurance failed: ${contract.displayName}`,
          summary: evaluation.summary,
          severity: criticalityToIncidentSeverity(contract.criticality),
          diagnosis: "Device assurance drifted from its expected state.",
          remediationPlan: "Inspect assurance evidence, confirm credentials, and remediate the workload drift.",
          metadata: {
            incidentType: ASSURANCE_FAILURE_INCIDENT_TYPE,
            scannerType: "assurance",
            assuranceId: contract.id,
            serviceContractId: contract.id,
            monitorType: evaluation.monitorType,
          },
          resolveMessage: `Assurance recovered: ${contract.displayName}`,
        },
        occurrenceMetadata: {
          assuranceId: contract.id,
          monitorType: evaluation.monitorType,
        },
      });
      nextIncidents = routed.incidents;
      continue;
    }

    if (evaluation.status === "pending") {
      await routeFinding({
        incidents: nextIncidents,
        source: "monitor.assurance",
        finding: {
          deviceId: device.id,
          dedupeKey: findingKey,
          findingType: "assurance_pending",
          severity: "info",
          title: `${contract.displayName} assurance pending`,
          summary: evaluation.summary,
          evidenceJson: evaluation.evidenceJson,
          status: "open",
        },
        occurrenceMetadata: {
          assuranceId: contract.id,
          monitorType: evaluation.monitorType,
        },
      });

      if (includeStateArtifacts) {
        const configRecommendation = ensureRecommendation(nextRecommendations, {
          title: `Complete assurance setup: ${contract.displayName}`,
          rationale: evaluation.summary,
          impact: "Allows Steward to actively validate this assurance.",
          priority: "medium",
          relatedDeviceIds: [device.id],
        });
        nextRecommendations = configRecommendation.next;
        recommendationsAdded += configRecommendation.added ? 1 : 0;
      }
      continue;
    }

    const severity = criticalityToIncidentSeverity(contract.criticality);
    if (!assuranceAlertsEnabled || !includeStateArtifacts) {
      const routed = await routeFinding({
        incidents: nextIncidents,
        source: "monitor.assurance",
        finding: {
          deviceId: device.id,
          dedupeKey: findingKey,
          findingType: "assurance",
          severity,
          title: `Assurance failed: ${contract.displayName}`,
          summary: !assuranceAlertsEnabled
            ? `${evaluation.summary} (alert suppressed by runtime settings).`
            : evaluation.summary,
          evidenceJson: evaluation.evidenceJson,
          status: includeStateArtifacts ? "resolved" : "open",
        },
        incident: {
          title: `Assurance failed: ${contract.displayName}`,
          summary: evaluation.summary,
          severity,
          diagnosis: "Device assurance drifted from its expected state.",
          remediationPlan: "Inspect assurance evidence, confirm credentials, and remediate the workload drift.",
          metadata: {
            incidentType: ASSURANCE_FAILURE_INCIDENT_TYPE,
            scannerType: "assurance",
            assuranceId: contract.id,
            serviceContractId: contract.id,
            monitorType: evaluation.monitorType,
          },
          resolveMessage: !assuranceAlertsEnabled
            ? `Assurance alerts disabled: ${contract.displayName}`
            : `Assurance tracked outside scanner cycle: ${contract.displayName}`,
        },
        occurrenceMetadata: {
          assuranceId: contract.id,
          monitorType: evaluation.monitorType,
          alertSuppressed: !assuranceAlertsEnabled,
          includeStateArtifacts,
        },
      });
      nextIncidents = routed.incidents;
      continue;
    }

    const routed = await routeFinding({
      incidents: nextIncidents,
      source: "monitor.assurance",
      finding: {
        deviceId: device.id,
        dedupeKey: findingKey,
        findingType: "assurance",
        severity,
        title: `Assurance failed: ${contract.displayName}`,
        summary: evaluation.summary,
        evidenceJson: evaluation.evidenceJson,
        status: "open",
      },
      incident: {
        title: `Assurance failed: ${contract.displayName}`,
        summary: evaluation.summary,
        severity,
        diagnosis: "Device assurance drifted from its expected state.",
        remediationPlan: "Inspect assurance evidence, confirm credentials, and remediate the workload drift.",
        metadata: {
          incidentType: ASSURANCE_FAILURE_INCIDENT_TYPE,
          scannerType: "assurance",
          assuranceId: contract.id,
          serviceContractId: contract.id,
          monitorType: evaluation.monitorType,
        },
        notifyOnOpen: true,
      },
      occurrenceMetadata: {
        assuranceId: contract.id,
        monitorType: evaluation.monitorType,
      },
    });
    nextIncidents = routed.incidents;
    incidentsOpened += routed.incidentOpened ? 1 : 0;

    const driftRecommendation = ensureRecommendation(nextRecommendations, {
      title: `Remediate assurance drift: ${contract.displayName}`,
      rationale: evaluation.summary,
      impact: "Restores expected runtime behavior and keeps automated checks green.",
      priority: criticalityToRecommendationPriority(contract.criticality),
      relatedDeviceIds: [device.id],
    });
    nextRecommendations = driftRecommendation.next;
    recommendationsAdded += driftRecommendation.added ? 1 : 0;
  }

  return {
    incidents: nextIncidents,
    recommendations: nextRecommendations,
    incidentsOpened,
    recommendationsAdded,
  };
};

const discoverPhase = async (
  trigger: "manual" | "interval",
  budgetMs?: number,
): Promise<{
  discovered: number;
  updatedDevices: number;
  devices: Device[];
  deepScan: boolean;
  scanMode: "incremental" | "deep";
  activeTargets: number;
  diagnostics?: DiscoveryDiagnostics;
}> => {
  const snapshot = await runDiscovery({
    forceDeepScan: trigger === "manual",
    budgetMs,
  });
  const state = await stateStore.getState();

  // Build lookup maps: primary IP, secondary IPs, and MAC -> device
  const existingByIp = new Map(state.devices.map((device) => [device.ip, device]));
  const existingByMac = new Map<string, Device>();
  for (const device of state.devices) {
    if (device.mac) {
      existingByMac.set(device.mac.toLowerCase(), device);
    }
    // Also index secondary IPs so we can find the device by any of its IPs
    for (const secIp of device.secondaryIps ?? []) {
      if (!existingByIp.has(secIp)) {
        existingByIp.set(secIp, device);
      }
    }
  }

  let updated = 0;
  let discovered = 0;
  const seenIps = new Set<string>();

  const cycleObservations = snapshot.merged.flatMap((candidate) => candidate.observations ?? []);
  if (cycleObservations.length > 0) {
    stateStore.addDiscoveryObservations(cycleObservations);
  }
  stateStore.pruneExpiredDiscoveryObservations();

  const recentObservations = stateStore.getRecentDiscoveryObservationsByIp(
    snapshot.merged.map((candidate) => candidate.ip),
    {
      sinceAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      limitPerIp: 40,
    },
  );

  for (const candidate of snapshot.merged) {
    const historical = (recentObservations.get(candidate.ip) ?? []).map((item) => ({
      ip: item.ip,
      source: item.source,
      evidenceType: item.evidenceType,
      confidence: item.confidence,
      observedAt: item.observedAt,
      expiresAt: item.expiresAt,
      details: item.details,
    }));
    const observations = dedupeObservations([...(candidate.observations ?? []), ...historical]);
    const fusedEvidence = evaluateDiscoveryEvidence(observations);
    if (!fusedEvidence.hasPositiveEvidence || fusedEvidence.confidence < 0.2) {
      continue;
    }

    const candidateWithEvidence = {
      ...candidate,
      observations,
      metadata: {
        ...candidate.metadata,
        discoveryEvidence: {
          confidence: fusedEvidence.confidence,
          status: fusedEvidence.status,
          hasPositiveEvidence: fusedEvidence.hasPositiveEvidence,
          hasStrongEvidence: fusedEvidence.hasStrongEvidence,
          evidenceTypes: fusedEvidence.evidenceTypes,
          sourceCounts: fusedEvidence.sourceCounts,
          observationCount: fusedEvidence.observationCount,
          fusedAt: new Date().toISOString(),
        },
      },
    };

    // Try to find existing device by: primary IP, secondary IPs, or MAC
    let previous = existingByIp.get(candidateWithEvidence.ip);
    if (!previous && candidateWithEvidence.mac) {
      previous = existingByMac.get(candidateWithEvidence.mac.toLowerCase());
    }

    const device = candidateToDevice(candidateWithEvidence, previous);
    seenIps.add(device.ip);
    for (const secIp of device.secondaryIps ?? []) {
      seenIps.add(secIp);
    }
    await stateStore.upsertDevice(mergeProtectedDeviceMetadata(device));
    stateStore.attachRecentObservationsToDevice(device.ip, device.id);
    await graphStore.attachDevice(device);
    updated += 1;
    discovered += 1;
  }

  let prunedDeviceIds: string[] = [];
  await stateStore.updateState(async (current) => {
    const nowMs = Date.now();
    const nowIso = new Date().toISOString();
    const removedIds = new Set<string>();
    const nextDevices: Device[] = [];

    for (const device of current.devices) {
      const adoptionStatus = getDeviceAdoptionStatus(device);
      const isPinned = adoptionStatus === "adopted" || adoptionStatus === "ignored";
      const source = typeof device.metadata.source === "string" ? String(device.metadata.source) : undefined;
      const manuallyAdded = source === "manual";
      const shouldRetain = isPinned || manuallyAdded;

      const discoveryMeta = (device.metadata.discovery as Record<string, unknown> | undefined) ?? {};
      const priorMissCountRaw = Number(discoveryMeta.missCount ?? 0);
      const priorMissCount = Number.isFinite(priorMissCountRaw) && priorMissCountRaw >= 0
        ? Math.floor(priorMissCountRaw)
        : 0;

      if (seenIps.has(device.ip)) {
        device.metadata.discovery = {
          ...discoveryMeta,
          missCount: 0,
          lastSeenCycleAt: nowIso,
        };
        nextDevices.push(device);
        continue;
      }

      const ageMs = nowMs - new Date(device.lastSeenAt).getTime();
      const missCount = priorMissCount + 1;
      const lowSignal = !device.mac && (device.services?.length ?? 0) === 0;
      const confidence = Number(discoveryMeta.confidence ?? 0);
      const hasEvidence = confidence >= 0.35 || !lowSignal;

      device.metadata.discovery = {
        ...discoveryMeta,
        missCount,
        lastMissedAt: nowIso,
      };

      if (!seenIps.has(device.ip)) {
        if (ageMs > 30 * 60 * 1000) {
          device.status = "offline";
        }
      }

      if (lowSignal && confidence < 0.35 && ageMs > 15 * 60 * 1000) {
        const latestDiscoveryMeta =
          (device.metadata.discovery as Record<string, unknown> | undefined) ?? {};
        device.metadata.discovery = {
          ...latestDiscoveryMeta,
          quarantined: true,
          quarantinedReason: "low_evidence_ghost_candidate",
          quarantinedAt: nowIso,
        };
        if (device.status === "online") {
          device.status = "unknown";
        }
      }

      const manualPruneMode = trigger === "manual" && discovered > 0;
      const shouldPrune =
        !shouldRetain &&
        (
          (manualPruneMode && !seenIps.has(device.ip)) ||
          (!hasEvidence && missCount >= 2 && ageMs > 10 * 60 * 1000) ||
          (missCount >= 4 && ageMs > 30 * 60 * 1000)
        );

      if (shouldPrune) {
        removedIds.add(device.id);
        continue;
      }

      nextDevices.push(device);
    }

    if (removedIds.size > 0) {
      const removedNodeIds = new Set(Array.from(removedIds).map((id) => `device:${id}`));
      const removedServicePrefixes = Array.from(removedIds).map((id) => `service:${id}:`);
      const isRemovedServiceNode = (nodeId: string): boolean =>
        removedServicePrefixes.some((prefix) => nodeId.startsWith(prefix));
      const isRemovedGraphRef = (nodeId: string): boolean =>
        removedNodeIds.has(nodeId) || isRemovedServiceNode(nodeId);

      current.devices = nextDevices;
      current.baselines = current.baselines.filter((baseline) => !removedIds.has(baseline.deviceId));
      current.playbookRuns = current.playbookRuns.filter((run) => !removedIds.has(run.deviceId));
      current.incidents = current.incidents
        .map((incident) => {
          const nextDeviceIds = incident.deviceIds.filter((id) => !removedIds.has(id));
          if (nextDeviceIds.length === incident.deviceIds.length) {
            return incident;
          }
          return {
            ...incident,
            deviceIds: nextDeviceIds,
            updatedAt: nowIso,
            timeline: [
              {
                at: nowIso,
                message: `Removed stale device references (${incident.deviceIds.length - nextDeviceIds.length})`,
              },
              ...incident.timeline,
            ].slice(0, 30),
          };
        })
        .filter((incident) => incident.deviceIds.length > 0);
      current.recommendations = current.recommendations
        .map((recommendation) => ({
          ...recommendation,
          relatedDeviceIds: recommendation.relatedDeviceIds.filter((id) => !removedIds.has(id)),
        }))
        .filter((recommendation) => recommendation.relatedDeviceIds.length > 0);
      current.graph.edges = current.graph.edges.filter((edge) => !isRemovedGraphRef(edge.from) && !isRemovedGraphRef(edge.to));
      current.graph.nodes = current.graph.nodes.filter((node) => !isRemovedGraphRef(node.id));

      prunedDeviceIds = Array.from(removedIds);
      return current;
    }

    current.devices = nextDevices;
    prunedDeviceIds = [];
    return current;
  });

  if (prunedDeviceIds.length > 0) {
    await stateStore.addAction({
      actor: "steward",
      kind: "discover",
      message: `Pruned ${prunedDeviceIds.length} stale unmanaged device${prunedDeviceIds.length === 1 ? "" : "s"}`,
      context: {
        trigger,
        prunedDeviceIds: prunedDeviceIds.slice(0, 200),
      },
    });
  }

  const nextState = await stateStore.getState();

  return {
    discovered,
    updatedDevices: updated,
    devices: nextState.devices,
    deepScan: snapshot.scanMode === "deep",
    scanMode: snapshot.scanMode,
    activeTargets: snapshot.activeTargets,
    diagnostics: snapshot.diagnostics,
  };
};

const inferCredentialTypes = (protocols: string[]): string[] => {
  const requirements = new Set<string>();
  if (protocols.includes("ssh")) requirements.add("ssh");
  if (protocols.includes("winrm")) requirements.add("winrm");
  if (protocols.includes("powershell-ssh")) requirements.add("powershell-ssh");
  if (protocols.includes("wmi")) requirements.add("wmi");
  if (protocols.includes("smb")) requirements.add("smb");
  if (protocols.includes("rdp")) requirements.add("rdp");
  if (protocols.includes("snmp")) requirements.add("snmp");
  if (protocols.includes("http-api")) requirements.add("api/web-admin");
  if (protocols.includes("docker")) requirements.add("docker");
  if (protocols.includes("kubernetes")) requirements.add("kubernetes");
  if (protocols.includes("mqtt")) requirements.add("mqtt");
  return Array.from(requirements);
};

const subnet24 = (ip: string): string | undefined => {
  const octets = ip.split(".");
  if (octets.length !== 4) return undefined;
  return `${octets[0]}.${octets[1]}.${octets[2]}`;
};

const understandPhase = async (devices: Device[], deepScan: boolean): Promise<void> => {
  const runtimeSettings = stateStore.getRuntimeSettings();
  const enrichedDevices: Device[] = [];

  for (const device of devices) {
    const surface = buildManagementSurface(device);
    const protocols = Array.from(
      new Set([...(device.protocols ?? []), ...(surface.capabilities.map((cap) => cap.protocol) ?? [])]),
    );

    const enriched: Device = {
      ...device,
      protocols,
      metadata: {
        ...device.metadata,
        managementSurface: surface,
        adoption: {
          ...getAdoptionRecord(device),
          status: getDeviceAdoptionStatus(device),
          requiredCredentials: inferCredentialTypes(protocols),
        },
      },
    };
    enrichedDevices.push(enriched);
    await stateStore.upsertDevice(mergeProtectedDeviceMetadata(enriched));
  }

  for (const device of enrichedDevices) {
    if (device.type === "server") {
      const nasPeer = enrichedDevices.find((item) => item.type === "nas");
      if (nasPeer) {
        await graphStore.addDependency(device.id, nasPeer.id, "Potential backup/data dependency");
      }
    }

    const network = subnet24(device.ip);
    if (!network) {
      continue;
    }

    const gateway = enrichedDevices.find((item) => {
      if (item.id === device.id) return false;
      const sameNetwork = subnet24(item.ip) === network;
      const networkRole = item.type === "router" || item.type === "firewall";
      const gatewayAddress = item.ip.endsWith(".1") || item.ip.endsWith(".254");
      return sameNetwork && (networkRole || gatewayAddress);
    });

    if (gateway) {
      await graphStore.addDependency(device.id, gateway.id, "Likely network gateway dependency");
    }
  }

  if (!deepScan) {
    return;
  }

  const advisoryCandidates = enrichedDevices
    .filter((device) => {
      const adoption = getAdoptionRecord(device);
      const adoptionStatus = getDeviceAdoptionStatus(device);

      if (adoptionStatus === "adopted" || adoptionStatus === "ignored") {
        return false;
      }

      return (
        !adoption.lastAdvisedAt ||
        Date.now() - new Date(String(adoption.lastAdvisedAt)).getTime() > 24 * 60 * 60 * 1000
      );
    })
    .slice(0, runtimeSettings.llmDiscoveryLimit);

  const advice = await generateDiscoveryAdvice(advisoryCandidates);
  if (advice.length === 0) {
    return;
  }

  const adviceByDeviceId = new Map(advice.map((item) => [item.deviceId, item]));
  for (const device of enrichedDevices) {
    const item = adviceByDeviceId.get(device.id);
    if (!item) {
      continue;
    }
    const existingAdoption = getAdoptionRecord(device);
    await stateStore.upsertDevice(mergeProtectedDeviceMetadata({
      ...device,
      role: device.role ?? item.role,
      metadata: {
        ...device.metadata,
        adoption: {
          ...existingAdoption,
          status: getDeviceAdoptionStatus(device),
          lastAdvisedAt: new Date().toISOString(),
          shouldManage: item.shouldManage,
          confidence: item.confidence,
          reason: item.reason,
          requiredCredentials: item.requiredCredentials,
        },
      },
    }));
  }
};

const actPhase = async (devices: Device[]): Promise<{
  incidentsOpened: number;
  recommendationsAdded: number;
  playbooksTriggered: number;
  playbooksCompleted: number;
  approvalsCreated: number;
}> => {
  const state = await stateStore.getState();
  const runtimeSettings = stateStore.getRuntimeSettings();
  const ignoredIncidentTypes = normalizedIgnoredIncidentTypes(runtimeSettings);
  const availabilityAlertsEnabled = runtimeSettings.availabilityScannerAlertsEnabled
    && !ignoredIncidentTypes.has(AVAILABILITY_OFFLINE_INCIDENT_TYPE);
  const securityAlertsEnabled = runtimeSettings.securityScannerAlertsEnabled
    && !ignoredIncidentTypes.has(SECURITY_TELNET_INCIDENT_TYPE);

  let incidents = [...state.incidents];
  let recommendations = [...state.recommendations];

  let incidentsOpened = 0;
  let recommendationsAdded = 0;
  let credentialOnboardingRecommendations = 0;

    for (const device of devices) {
      const adoptionStatus = getDeviceAdoptionStatus(device);
      const offlineIncidentKey = `offline:${device.id}`;
      const offlineIncidentEligible = adoptionStatus === "adopted";

      if (device.status !== "offline") {
        const routed = await routeFinding({
          incidents,
          source: "scanner.availability",
          finding: {
            deviceId: device.id,
            dedupeKey: offlineIncidentKey,
            findingType: "availability",
            severity: "warning",
            title: `${device.name} is offline`,
            summary: `${device.name} is currently reachable again.`,
            evidenceJson: {
              deviceStatus: device.status,
            },
            status: "resolved",
          },
          incident: {
            title: `${device.name} is offline`,
            summary: `${device.name} (${device.ip}) has not been seen recently and appears offline.`,
            severity: "warning",
            metadata: {
              incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
              scannerType: "availability",
            },
            resolveMessage: `Availability restored for ${device.name}`,
          },
          occurrenceMetadata: {
            adoptionStatus,
          },
        });
        incidents = routed.incidents;
      } else if (!offlineIncidentEligible) {
        const routed = await routeFinding({
          incidents,
          source: "scanner.availability",
          finding: {
            deviceId: device.id,
            dedupeKey: offlineIncidentKey,
            findingType: "availability",
            severity: "warning",
            title: `${device.name} is offline`,
            summary: `${device.name} (${device.ip}) is offline, but Steward only raises availability incidents for adopted devices.`,
            evidenceJson: {
              incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
              incidentKey: offlineIncidentKey,
              deviceStatus: device.status,
              adoptionStatus,
            },
            status: "resolved",
          },
          incident: {
            title: `${device.name} is offline`,
            summary: `${device.name} (${device.ip}) has not been seen recently and appears offline.`,
            severity: "warning",
            metadata: {
              incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
              scannerType: "availability",
            },
            resolveMessage: "Offline availability alerts only apply to adopted devices",
          },
          occurrenceMetadata: {
            adoptionStatus,
            alertEligible: false,
          },
        });
        incidents = routed.incidents;
      } else if (device.status === "offline") {
        if (!availabilityAlertsEnabled) {
          const routed = await routeFinding({
            incidents,
            source: "scanner.availability",
            finding: {
              deviceId: device.id,
              dedupeKey: offlineIncidentKey,
              findingType: "availability",
              severity: "warning",
              title: `${device.name} is offline`,
              summary: `${device.name} (${device.ip}) is offline, but this alert type is currently suppressed.`,
              evidenceJson: {
                incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
                incidentKey: offlineIncidentKey,
                deviceStatus: device.status,
              },
              status: "resolved",
            },
            incident: {
              title: `${device.name} is offline`,
              summary: `${device.name} (${device.ip}) has not been seen recently and appears offline.`,
              severity: "warning",
              metadata: {
                incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
                scannerType: "availability",
              },
              resolveMessage: "Availability alerts are disabled for offline checks",
            },
            occurrenceMetadata: {
              alertSuppressed: true,
              adoptionStatus,
            },
          });
          incidents = routed.incidents;
        } else {
          const routed = await routeFinding({
            incidents,
            source: "scanner.availability",
            finding: {
              deviceId: device.id,
              dedupeKey: offlineIncidentKey,
              findingType: "availability",
              severity: "warning",
              title: `${device.name} is offline`,
              summary: `${device.name} (${device.ip}) has not been seen recently and appears offline.`,
              evidenceJson: {
                incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
                incidentKey: offlineIncidentKey,
                deviceStatus: device.status,
              },
              status: "open",
            },
            incident: {
              title: `${device.name} is offline`,
              summary: `${device.name} (${device.ip}) has not been seen recently and appears offline.`,
              severity: "warning",
              metadata: {
                incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
                scannerType: "availability",
              },
              notifyOnOpen: true,
            },
            occurrenceMetadata: {
              adoptionStatus,
            },
          });
          incidents = routed.incidents;
          incidentsOpened += routed.incidentOpened ? 1 : 0;
        }
      }

      const telnetOpen = device.services.some((service) => service.port === 23);
      if (!telnetOpen) {
        const routed = await routeFinding({
          incidents,
          source: "scanner.security",
          finding: {
            deviceId: device.id,
            dedupeKey: `telnet:${device.id}`,
            findingType: "security_exposure",
            severity: "critical",
            title: `${device.name} exposes Telnet`,
            summary: `Telnet exposure appears closed for ${device.name}.`,
            evidenceJson: {
              port: 23,
              open: false,
            },
            status: "resolved",
          },
          incident: {
            title: `${device.name} exposes Telnet`,
            summary: `Port 23 is open on ${device.name} (${device.ip}), which is insecure for management traffic.`,
            severity: "critical",
            diagnosis: "Cleartext management protocol exposed.",
            remediationPlan: "Disable Telnet and enforce SSH or HTTPS management access.",
            metadata: {
              incidentType: SECURITY_TELNET_INCIDENT_TYPE,
              scannerType: "security",
            },
            resolveMessage: `Telnet exposure cleared for ${device.name}`,
          },
        });
        incidents = routed.incidents;
      }
      if (telnetOpen) {
        const incidentKeyValue = `telnet:${device.id}`;
        if (!securityAlertsEnabled) {
          const routed = await routeFinding({
            incidents,
            source: "scanner.security",
            finding: {
              deviceId: device.id,
              dedupeKey: incidentKeyValue,
              findingType: "security_exposure",
              severity: "critical",
              title: `${device.name} exposes Telnet`,
              summary: `Port 23 remains open on ${device.name}, but this alert type is currently suppressed.`,
              evidenceJson: {
                incidentType: SECURITY_TELNET_INCIDENT_TYPE,
                incidentKey: incidentKeyValue,
                port: 23,
                open: true,
              },
              status: "resolved",
            },
            incident: {
              title: `${device.name} exposes Telnet`,
              summary: `Port 23 is open on ${device.name} (${device.ip}), which is insecure for management traffic.`,
              severity: "critical",
              diagnosis: "Cleartext management protocol exposed.",
              remediationPlan: "Disable Telnet and enforce SSH or HTTPS management access.",
              metadata: {
                incidentType: SECURITY_TELNET_INCIDENT_TYPE,
                scannerType: "security",
              },
              resolveMessage: "Security exposure alerts are disabled for Telnet checks",
            },
            occurrenceMetadata: {
              alertSuppressed: true,
            },
          });
          incidents = routed.incidents;
        } else {
          const routed = await routeFinding({
            incidents,
            source: "scanner.security",
            finding: {
              deviceId: device.id,
              dedupeKey: incidentKeyValue,
              findingType: "security_exposure",
              severity: "critical",
              title: `${device.name} exposes Telnet`,
              summary: `Port 23 is open on ${device.name} (${device.ip}), which is insecure for management traffic.`,
              evidenceJson: {
                incidentType: SECURITY_TELNET_INCIDENT_TYPE,
                incidentKey: incidentKeyValue,
                port: 23,
                open: true,
              },
              status: "open",
            },
            incident: {
              title: `${device.name} exposes Telnet`,
              summary: `Port 23 is open on ${device.name} (${device.ip}), which is insecure for management traffic.`,
              severity: "critical",
              diagnosis: "Cleartext management protocol exposed.",
              remediationPlan: "Disable Telnet and enforce SSH or HTTPS management access.",
              metadata: {
                incidentType: SECURITY_TELNET_INCIDENT_TYPE,
                scannerType: "security",
              },
              notifyOnOpen: true,
            },
          });
          incidents = routed.incidents;
          incidentsOpened += routed.incidentOpened ? 1 : 0;

          const recommendation = ensureRecommendation(recommendations, {
            title: `Disable Telnet on ${device.name}`,
            rationale:
            "Cleartext device administration creates credential exposure and lateral movement risk.",
          impact: "Eliminates insecure remote management path.",
          priority: "high",
          relatedDeviceIds: [device.id],
        });
        recommendations = recommendation.next;
        recommendationsAdded += recommendation.added ? 1 : 0;
      }
    }

    const tlsServices = device.services
      .filter((service) => service.tlsCert?.validTo)
      .map((service) => ({
        service,
        daysRemaining: daysUntilIso(service.tlsCert?.validTo ?? ""),
      }))
      .filter((item): item is { service: Device["services"][number]; daysRemaining: number } => item.daysRemaining !== null)
      .sort((a, b) => a.daysRemaining - b.daysRemaining);

    for (const { service, daysRemaining } of tlsServices) {
      const cert = service.tlsCert;
      if (!cert) continue;

      const dedupeKey = `tls-cert-expiry:${device.id}:${service.id}`;
      const label = tlsServiceLabel(device, service);

      if (daysRemaining > TLS_CERT_WARNING_WINDOW_DAYS) {
        stateStore.upsertDeviceFindingByDedupe({
          deviceId: device.id,
          dedupeKey,
          findingType: "tls_certificate",
          severity: "info",
          title: `TLS certificate expiring on ${label}`,
          summary: `TLS certificate for ${label} is healthy (${daysRemaining} days remaining).`,
          evidenceJson: {
            serviceId: service.id,
            port: service.port,
            subject: cert.subject,
            issuer: cert.issuer,
            validTo: cert.validTo,
            daysRemaining,
          },
          status: "resolved",
        });
        continue;
      }

      const expired = daysRemaining < 0;
      const severity: Incident["severity"] = daysRemaining <= TLS_CERT_CRITICAL_WINDOW_DAYS ? "critical" : "warning";
      const summary = expired
        ? `TLS certificate for ${label} expired ${Math.abs(daysRemaining)} day(s) ago (${cert.validTo}).`
        : `TLS certificate for ${label} expires in ${daysRemaining} day(s) (${cert.validTo}).`;

      stateStore.upsertDeviceFindingByDedupe({
        deviceId: device.id,
        dedupeKey,
        findingType: "tls_certificate",
        severity,
        title: `TLS certificate expiring on ${label}`,
        summary,
        evidenceJson: {
          serviceId: service.id,
          port: service.port,
          subject: cert.subject,
          issuer: cert.issuer,
          validTo: cert.validTo,
          daysRemaining,
          selfSigned: cert.selfSigned,
        },
        status: "open",
      });

      const certRecommendation = ensureRecommendation(recommendations, {
        title: `Renew TLS certificate for ${device.name}`,
        rationale: summary,
        impact: "Prevents HTTPS management or application outages caused by certificate expiration.",
        priority: severity === "critical" ? "high" : "medium",
        relatedDeviceIds: [device.id],
      });
      recommendations = certRecommendation.next;
      recommendationsAdded += certRecommendation.added ? 1 : 0;
    }

    if (device.type === "access-point") {
      const recommendation = ensureRecommendation(recommendations, {
        title: `Review channel utilization on ${device.name}`,
        rationale: "Wireless performance bottlenecks are commonly caused by channel contention.",
        impact: "Improves throughput and client stability.",
        priority: "medium",
        relatedDeviceIds: [device.id],
      });
      recommendations = recommendation.next;
      recommendationsAdded += recommendation.added ? 1 : 0;
    }

    if (device.services.some((service) => service.port === 443)) {
      const recommendation = ensureRecommendation(recommendations, {
        title: `Track TLS certificate lifecycle for ${device.name}`,
        rationale:
          "HTTPS services require proactive certificate renewal to avoid service disruption.",
        impact: "Reduces outage risk from certificate expiration.",
        priority: "medium",
        relatedDeviceIds: [device.id],
      });
      recommendations = recommendation.next;
      recommendationsAdded += recommendation.added ? 1 : 0;
    }

    const surface =
      typeof device.metadata.managementSurface === "object" && device.metadata.managementSurface !== null
        ? (device.metadata.managementSurface as { capabilities?: Array<{ protocol: string }> })
        : undefined;
    const capabilities = surface?.capabilities ?? [];

    const adoption =
      getAdoptionRecord(device);

    const shouldRecommendAdoption =
      capabilities.length > 0 &&
      adoptionStatus !== "adopted" &&
      adoptionStatus !== "ignored" &&
      (adoption.shouldManage !== false || Number(adoption.confidence ?? 0) >= 0.5);

    const highValueType = new Set(["server", "router", "firewall", "switch", "nas", "camera", "hypervisor", "container-host"]);
    if (shouldRecommendAdoption && highValueType.has(device.type) && credentialOnboardingRecommendations < 20) {
      const protocols = Array.from(new Set(capabilities.map((capability) => capability.protocol))).slice(0, 4);
      const requiredCredentials = Array.isArray(adoption.requiredCredentials)
        ? adoption.requiredCredentials.join(", ")
        : protocols.join(", ");
      const recommendation = ensureRecommendation(recommendations, {
        title: `Adopt ${device.name} for active management`,
        rationale:
          typeof adoption.reason === "string"
            ? adoption.reason
            : `${device.name} exposes manageable interfaces (${protocols.join(", ") || "unknown"}).`,
        impact: `Enables deeper health checks and remediation. Credential onboarding needed: ${requiredCredentials || "platform-specific auth"}.`,
        priority: device.type === "firewall" || device.type === "router" || device.type === "nas" ? "high" : "medium",
        relatedDeviceIds: [device.id],
      }, {
        matchesExisting: (item) =>
          item.relatedDeviceIds.length === 1 &&
          item.relatedDeviceIds[0] === device.id &&
          ADOPTION_RECOMMENDATION_TITLE.test(item.title),
      });
      recommendations = recommendation.next;
      recommendationsAdded += recommendation.added ? 1 : 0;
      credentialOnboardingRecommendations += recommendation.added ? 1 : 0;
    }

  }

  recommendations = dedupeRecommendations(recommendations);

  await stateStore.setIncidents(incidents.slice(0, 400));
  await stateStore.setRecommendations(recommendations.slice(0, 400));

  // --- Playbook orchestration sub-phase ---
  let playbooksTriggered = 0;
  let playbooksCompleted = 0;
  let approvalsCreated = 0;

  const policyRules = stateStore.getPolicyRules();
  const maintenanceWindows = stateStore.getMaintenanceWindows();
  const existingRuns = stateStore.getPlaybookRuns({});
  const activeRunKeys = new Set(
    existingRuns
      .filter((r) => !["completed", "failed", "denied", "quarantined"].includes(r.status))
      .map((r) => `${r.deviceId}:${r.family}`),
  );

  const deviceMap = new Map(devices.map((d) => [d.id, d]));

  for (const incident of incidents) {
    if (incident.status === "resolved") continue;

    for (const deviceId of incident.deviceIds) {
      const device = deviceMap.get(deviceId);
      if (!device) continue;

      const matchingPlaybooks = matchPlaybooksForIncident(
        incident.title,
        incident.metadata,
        device,
      );

      for (const playbook of matchingPlaybooks) {
        const runKey = `${device.id}:${playbook.family}`;
        if (activeRunKeys.has(runKey)) continue;

        const missingCredentialProtocols = getMissingCredentialProtocolsForPlaybook(device, playbook);
        if (missingCredentialProtocols.length > 0) {
          const finding = stateStore.upsertDeviceFindingByDedupe({
            deviceId: device.id,
            dedupeKey: `missing-credentials:${playbook.family}:${missingCredentialProtocols.sort().join(",")}`,
            findingType: "missing_credentials",
            severity: "warning",
            title: `${device.name} missing credentials for ${playbook.family}`,
            summary: `Steward cannot execute "${playbook.name}" until credentials are provided for: ${missingCredentialProtocols.join(", ")}.`,
            evidenceJson: {
              incidentId: incident.id,
              playbookId: playbook.id,
              missingCredentialProtocols,
            },
            status: "open",
          });

          const recommendation = ensureRecommendation(recommendations, {
            title: `Provide ${missingCredentialProtocols.join(", ")} credentials for ${device.name}`,
            rationale: `Remediation playbook "${playbook.name}" is blocked by missing credentials.`,
            impact: "Enables automated diagnosis and recovery actions for this device.",
            priority: "high",
            relatedDeviceIds: [device.id],
          });
          recommendations = recommendation.next;
          recommendationsAdded += recommendation.added ? 1 : 0;

          void stateStore.addAction({
            actor: "steward",
            kind: "diagnose",
            message: `Blocked playbook due to missing credentials: ${playbook.name} on ${device.name}`,
            context: {
              deviceId: device.id,
              incidentId: incident.id,
              playbookId: playbook.id,
              missingCredentialProtocols,
              findingId: finding.id,
            },
          });

          continue;
        }

        const lane = "A" as const;
        const recentFailures = countRecentFamilyFailures(device.id, playbook.family);
        const quarantineActive = isFamilyQuarantined(device.id, playbook.family);
        const policyResult = evaluatePolicy(
          playbook.actionClass,
          device,
          policyRules,
          maintenanceWindows,
          {
            blastRadius: playbook.blastRadius,
            criticality: criticalityForActionClass(playbook.actionClass),
            lane,
            recentFailures,
            quarantineActive,
          },
        );

        if (policyResult.decision === "DENY") {
          void stateStore.addAction({
            actor: "steward",
            kind: "policy",
            message: `Denied playbook "${playbook.name}" on ${device.name}: ${policyResult.reason}`,
            context: { playbookId: playbook.id, deviceId: device.id, ruleId: policyResult.ruleId },
          });
          continue;
        }

        const run: PlaybookRun = buildPlaybookRun(playbook, {
          deviceId: device.id,
          incidentId: incident.id,
          policyEvaluation: policyResult,
          initialStatus: policyResult.decision === "ALLOW_AUTO" ? "approved" : "pending_approval",
          lane,
        });

        if (policyResult.decision === "REQUIRE_APPROVAL") {
          createApproval(run, device);
          approvalsCreated++;
          activeRunKeys.add(runKey);
        } else {
          // ALLOW_AUTO — execute immediately
          stateStore.upsertPlaybookRun(run);
          const result = await executePlaybook(run, device);
          stateStore.upsertPlaybookRun(result);
          activeRunKeys.add(runKey);

          playbooksCompleted += result.status === "completed" ? 1 : 0;

          void stateStore.addAction({
            actor: "steward",
            kind: "playbook",
            message: `Playbook "${playbook.name}" on ${device.name}: ${result.status}`,
            context: { playbookRunId: result.id, status: result.status },
          });
        }

        playbooksTriggered++;
      }
    }
  }

  // Execute any previously approved runs that haven't started yet
  const approvedRuns = stateStore.getPlaybookRuns({ status: "approved" });
  for (const run of approvedRuns) {
    const device = deviceMap.get(run.deviceId);
    if (!device) continue;

    const result = await executePlaybook(run, device);
    stateStore.upsertPlaybookRun(result);
    playbooksCompleted += result.status === "completed" ? 1 : 0;

    void stateStore.addAction({
      actor: "steward",
      kind: "playbook",
      message: `Playbook "${run.name}" on ${device.name}: ${result.status}`,
      context: { playbookRunId: result.id, status: result.status },
    });

    if (run.policyEvaluation.inputs.lane === "B" && result.status === "completed") {
      const promotion = ensureRecommendation(recommendations, {
        title: `Promote adaptive run "${run.family}" to deterministic adapter playbook`,
        rationale: "A Lane B Plan IR run completed successfully and is eligible for deterministic codification.",
        impact: "Improves repeatability and expands Lane A autonomous coverage.",
        priority: "medium",
        relatedDeviceIds: [device.id],
      });
      recommendations = promotion.next;
      recommendationsAdded += promotion.added ? 1 : 0;
    }
  }

  // Expire stale approvals
  expireStale();
  localToolRuntime.expireStaleApprovals();
  await localToolRuntime.runScheduledHealthChecks();
  await protocolSessionManager.sweep();
  await webSessionManager.sweep();
  await stateStore.setRecommendations(recommendations.slice(0, 400));

  return {
    incidentsOpened,
    recommendationsAdded,
    playbooksTriggered,
    playbooksCompleted,
    approvalsCreated,
  };
};

const learnPhase = async (devices: Device[]): Promise<void> => {
  const latencyResults = await Promise.all(
    devices.slice(0, 50).map(async (device) => ({
      deviceId: device.id,
      ip: device.ip,
      latencyMs: await measureLatency(device.ip),
    })),
  );
  const state = await stateStore.getState();
  const existingByDevice = new Map(state.baselines.map((baseline) => [baseline.deviceId, baseline]));
  const baselineUpdates: DeviceBaseline[] = [];

  for (const result of latencyResults) {
    if (result.latencyMs === undefined) {
      continue;
    }
    const baseline = buildBaseline(existingByDevice.get(result.deviceId), result.latencyMs);
    baseline.deviceId = result.deviceId;
    baselineUpdates.push(baseline);
  }

  stateStore.upsertBaselines(baselineUpdates);
};

let coordinatorHandle: NodeJS.Timeout | undefined;
let currentCoordinatorIntervalMs: number | undefined;
let coordinatorRunning = false;
let scannerWorkerRunning = false;
let runtimeWorkerRunning = false;
let scannerCycleRunning = false;
let sessionSweepHandle: NodeJS.Timeout | undefined;
let currentSessionSweepIntervalMs: number | undefined;
let leadershipHandle: NodeJS.Timeout | undefined;
let currentLeadershipRefreshMs: number | undefined;
let leaderActive = false;
let leadershipRefreshRunning = false;

const LOOP_LEASE_NAME = "control-plane.leader";
const CYCLE_LEASE_NAME = "scanner.cycle";
const AGENT_WAKE_LEASE_NAME = "agent.wake";
const PROCESS_HOLDER_ID = `control-plane:${process.pid}:${randomUUID()}`;
const SCANNER_DISCOVERY_JOB_KIND = "scanner.discovery";
const MONITOR_EXECUTE_JOB_KIND = "monitor.execute";
const AGENT_WAKE_JOB_KIND = "agent.wake";
const AGENT_ASSURANCE_JOB_KIND = "agent.assurance";
const SCANNER_JOB_KINDS = [SCANNER_DISCOVERY_JOB_KIND] as const;
const RUNTIME_JOB_KINDS = [MONITOR_EXECUTE_JOB_KIND, AGENT_WAKE_JOB_KIND, AGENT_ASSURANCE_JOB_KIND] as const;
const MIN_LEADER_LEASE_MS = 90_000;
const MIN_CYCLE_LEASE_MS = 4 * 60 * 1000;
const MIN_AGENT_WAKE_LEASE_MS = 60_000;
const MANUAL_SCANNER_DEDUPE_WINDOW_MS = 30_000;
const MIN_RUNTIME_JOB_STALE_MS = 60_000;

const emptyCycleSummary = (): StewardCycleSummary => ({
  discovered: 0,
  updatedDevices: 0,
  incidentsOpened: 0,
  recommendationsAdded: 0,
  playbooksTriggered: 0,
  playbooksCompleted: 0,
  approvalsCreated: 0,
});

const emptyAssuranceSweepSummary = (): AssuranceSweepSummary => ({
  dueAssurances: 0,
  evaluatedAssurances: 0,
  failingAssurances: 0,
  pendingAssurances: 0,
});

const leaderLeaseTtlMs = (settings: RuntimeSettings): number =>
  Math.max(settings.scannerIntervalMs * 3, MIN_LEADER_LEASE_MS);

const leaderRefreshIntervalMs = (settings: RuntimeSettings): number =>
  Math.max(5_000, Math.min(30_000, Math.floor(leaderLeaseTtlMs(settings) / 3)));

const discoveryPhaseTimeoutMs = (
  trigger: "manual" | "interval",
  settings: RuntimeSettings,
): number =>
  trigger === "manual"
    ? Math.max(8 * 60_000, settings.scannerIntervalMs * 3)
    : Math.max(3 * 60_000, settings.scannerIntervalMs + 60_000);

const cycleLeaseTtlMs = (
  trigger: "manual" | "interval",
  settings: RuntimeSettings,
): number => Math.max(
  discoveryPhaseTimeoutMs(trigger, settings) + 60_000,
  settings.scannerIntervalMs * 2,
  MIN_CYCLE_LEASE_MS,
);

const agentWakeLeaseTtlMs = (settings: RuntimeSettings): number =>
  Math.max(settings.agentWakeIntervalMs * 2, MIN_AGENT_WAKE_LEASE_MS);

const scannerJobStaleMs = (settings: RuntimeSettings): number =>
  Math.max(5 * 60_000, cycleLeaseTtlMs("interval", settings) + 15_000);

const runtimeJobStaleMs = (settings: RuntimeSettings): number =>
  Math.max(MIN_RUNTIME_JOB_STALE_MS, settings.protocolSessionSweepIntervalMs * 4);

const coordinatorIntervalMs = (settings: RuntimeSettings): number =>
  Math.max(
    5_000,
    Math.min(
      15_000,
      Math.floor(
        Math.min(
          settings.scannerIntervalMs,
          settings.agentWakeIntervalMs,
          settings.protocolSessionSweepIntervalMs,
        ) / 6,
      ),
    ),
  );

const withPhaseTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const latestScannerRunIsStale = (run: ScannerRunRecord | null, settings: RuntimeSettings): boolean => {
  if (!run) {
    return true;
  }
  const startedAtMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return true;
  }
  const staleAfterMs = Math.max(settings.scannerIntervalMs, 60_000);
  if (!run.completedAt) {
    return Date.now() - startedAtMs >= staleAfterMs;
  }
  return Date.now() - startedAtMs >= settings.scannerIntervalMs;
};

const latestAgentWakeIsStale = (run: AgentRunRecord | null, settings: RuntimeSettings): boolean => {
  if (!run) {
    return true;
  }
  const startedAtMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return true;
  }
  const staleAfterMs = Math.max(settings.agentWakeIntervalMs, 60_000);
  if (!run.completedAt) {
    return Date.now() - startedAtMs >= staleAfterMs;
  }
  return Date.now() - startedAtMs >= settings.agentWakeIntervalMs;
};

const schedulerSlotKey = (intervalMs: number, nowMs = Date.now()): number =>
  Math.floor(nowMs / Math.max(1_000, intervalMs));

const monitorJobKindForContract = (contract: ServiceContract): string => {
  const monitorType = getMonitorType(contract);
  return monitorType === "semantic_assertion" || monitorType === "desktop_ui_assertion"
    ? AGENT_ASSURANCE_JOB_KIND
    : MONITOR_EXECUTE_JOB_KIND;
};

const enqueueScannerJob = (
  trigger: "manual" | "interval",
  settings: RuntimeSettings,
): void => {
  const nowMs = Date.now();
  const bucket = trigger === "manual"
    ? schedulerSlotKey(MANUAL_SCANNER_DEDUPE_WINDOW_MS, nowMs)
    : schedulerSlotKey(settings.scannerIntervalMs, nowMs);
  stateStore.enqueueDurableJob(
    SCANNER_DISCOVERY_JOB_KIND,
    {
      trigger,
      requestedAt: new Date(nowMs).toISOString(),
    },
    `${SCANNER_DISCOVERY_JOB_KIND}:${trigger}:${bucket}`,
  );
};

const enqueueAgentWakeJob = (
  settings: RuntimeSettings,
  reason: string,
): void => {
  const nowMs = Date.now();
  const bucket = schedulerSlotKey(settings.agentWakeIntervalMs, nowMs);
  stateStore.enqueueDurableJob(
    AGENT_WAKE_JOB_KIND,
    {
      reason,
      requestedAt: new Date(nowMs).toISOString(),
    },
    `${AGENT_WAKE_JOB_KIND}:${reason}:${bucket}`,
  );
};

const enqueueAssuranceJob = (
  contract: ServiceContract,
  deviceId: string,
  trigger: "interval" | "review",
  nowMs = Date.now(),
): string => {
  const intervalMs = Math.max(15_000, Math.floor(contract.checkIntervalSec * 1_000));
  const kind = monitorJobKindForContract(contract);
  stateStore.enqueueDurableJob(
    kind,
    {
      assuranceId: contract.id,
      deviceId,
      trigger,
      monitorType: getMonitorType(contract),
      requestedAt: new Date(nowMs).toISOString(),
    },
    `${kind}:${contract.id}:${schedulerSlotKey(intervalMs, nowMs)}`,
  );
  return kind;
};

const queueDueAssuranceJobs = async (): Promise<AssuranceSweepSummary> => {
  const summary = emptyAssuranceSweepSummary();
  const state = await stateStore.getState();
  const nowMs = Date.now();

  for (const device of state.devices) {
    const dueContracts = stateStore
      .getAssurances(device.id)
      .filter((contract) => isServiceContractDue(contract, nowMs));
    if (dueContracts.length === 0) {
      continue;
    }

    summary.dueAssurances += dueContracts.length;
    summary.evaluatedAssurances += dueContracts.length;
    for (const contract of dueContracts) {
      enqueueAssuranceJob(contract, device.id, "interval", nowMs);
    }
  }

  return summary;
};

const persistAssuranceEvaluation = async (
  device: Device,
  contract: ServiceContract,
  runtimeSettings: RuntimeSettings,
): Promise<{
  status: "pass" | "fail" | "pending" | "skipped";
  summary: string;
  monitorType: string;
}> => {
  if (!isServiceContractDue(contract)) {
    return {
      status: "skipped",
      summary: `${contract.displayName} is not due for evaluation.`,
      monitorType: getMonitorType(contract),
    };
  }

  const state = await stateStore.getState();
  const evaluation = await evaluateAssurancesForDevice(
    device,
    state.incidents,
    state.recommendations,
    runtimeSettings,
    {
      assurances: [contract],
      includeStateArtifacts: true,
    },
  );
  await stateStore.setIncidents(evaluation.incidents.slice(0, 400));
  await stateStore.setRecommendations(evaluation.recommendations.slice(0, 400));

  const latestRun = stateStore
    .getLatestAssuranceRuns(device.id)
    .find((run) => run.assuranceId === contract.id);

  return {
    status: latestRun?.status ?? "skipped",
    summary: latestRun?.summary ?? `${contract.displayName} did not produce a new assurance result.`,
    monitorType: latestRun?.evidenceJson?.monitorType && typeof latestRun.evidenceJson.monitorType === "string"
      ? latestRun.evidenceJson.monitorType
      : getMonitorType(contract),
  };
};

const runMonitorJob = async (
  payload: Record<string, unknown>,
  runtimeSettings: RuntimeSettings,
): Promise<{
  status: "pass" | "fail" | "pending" | "skipped";
  summary: string;
  monitorType: string;
  assuranceId?: string;
  displayName?: string;
}> => {
  const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : "";
  const assuranceId = typeof payload.assuranceId === "string" ? payload.assuranceId : "";
  if (!deviceId || !assuranceId) {
    return {
      status: "skipped",
      summary: "Monitor job payload is missing deviceId or assuranceId.",
      monitorType: typeof payload.monitorType === "string" ? payload.monitorType : "unknown",
    };
  }

  const device = stateStore.getDeviceById(deviceId);
  const contract = stateStore.getAssuranceById(assuranceId);
  if (!device || !contract || contract.deviceId !== device.id) {
    return {
      status: "skipped",
      summary: "Monitor target no longer exists.",
      monitorType: typeof payload.monitorType === "string" ? payload.monitorType : "unknown",
      assuranceId,
    };
  }

  const result = await persistAssuranceEvaluation(device, contract, runtimeSettings);
  return {
    ...result,
    assuranceId: contract.id,
    displayName: contract.displayName,
  };
};

const runAgentWakeJob = async (
  payload: Record<string, unknown>,
  runtimeSettings: RuntimeSettings,
): Promise<{ summary: string; queuedAssurances: number; openIncidents: number }> => {
  const reason = typeof payload.reason === "string" && payload.reason.trim().length > 0
    ? payload.reason.trim()
    : "periodic_review";
  const lease = stateStore.tryAcquireRuntimeLease(
    AGENT_WAKE_LEASE_NAME,
    PROCESS_HOLDER_ID,
    agentWakeLeaseTtlMs(runtimeSettings),
    {
      pid: process.pid,
      reason,
    },
  );
  if (!lease.acquired) {
    return {
      summary: "Agent wake already running.",
      queuedAssurances: 0,
      openIncidents: 0,
    };
  }

  const runRecord: AgentRunRecord = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    outcome: "ok",
    summary: `Agent wake in progress (${reason}).`,
    details: {
      holder: PROCESS_HOLDER_ID,
      pid: process.pid,
      wakeReason: reason,
      plane: "agent",
      jobKind: AGENT_WAKE_JOB_KIND,
    },
  };

  try {
    await stateStore.upsertAgentRun(runRecord);
    const state = await stateStore.getState();
    const nowMs = Date.now();
    let queuedAssurances = 0;
    for (const device of state.devices) {
      const dueContracts = stateStore
        .getAssurances(device.id)
        .filter((contract) =>
          isServiceContractDue(contract, nowMs) && monitorJobKindForContract(contract) === AGENT_ASSURANCE_JOB_KIND
        );
      for (const contract of dueContracts) {
        enqueueAssuranceJob(contract, device.id, "review", nowMs);
        queuedAssurances += 1;
      }
    }

    const openIncidents = state.incidents.filter((incident) => incident.status === "open").length;
    runRecord.completedAt = new Date().toISOString();
    runRecord.summary = queuedAssurances > 0
      ? `Agent review queued ${queuedAssurances} agent assurance job(s); ${openIncidents} open incident(s) remain under review.`
      : openIncidents > 0
        ? `Agent review found no due agent assurances; ${openIncidents} open incident(s) remain under review.`
        : "Agent review found no agentic work.";
    runRecord.details = {
      ...runRecord.details,
      queuedAssurances,
      openIncidents,
    };
    await stateStore.upsertAgentRun(runRecord);
    await stateStore.addAction({
      actor: "steward",
      kind: "diagnose",
      message: runRecord.summary,
      context: {
        agentRunId: runRecord.id,
        wakeReason: reason,
      },
    });

    return {
      summary: runRecord.summary,
      queuedAssurances,
      openIncidents,
    };
  } catch (error) {
    runRecord.completedAt = new Date().toISOString();
    runRecord.outcome = "error";
    runRecord.summary = `Agent wake failed: ${error instanceof Error ? error.message : "unknown error"}`;
    runRecord.details = {
      ...runRecord.details,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
    await stateStore.upsertAgentRun(runRecord);
    throw error;
  } finally {
    stateStore.releaseRuntimeLease(AGENT_WAKE_LEASE_NAME, PROCESS_HOLDER_ID);
  }
};

const runAgentAssuranceJob = async (
  payload: Record<string, unknown>,
  runtimeSettings: RuntimeSettings,
): Promise<{ summary: string; status: string; assuranceId?: string }> => {
  const assuranceId = typeof payload.assuranceId === "string" ? payload.assuranceId : "";
  const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : "";
  const contract = assuranceId ? stateStore.getAssuranceById(assuranceId) : null;
  const displayName = contract?.displayName ?? assuranceId ?? "agent assurance";
  const monitorType = contract ? getMonitorType(contract) : (typeof payload.monitorType === "string" ? payload.monitorType : "unknown");

  const runRecord: AgentRunRecord = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    outcome: "ok",
    summary: `Agent assurance in progress: ${displayName}.`,
    details: {
      holder: PROCESS_HOLDER_ID,
      pid: process.pid,
      wakeReason: "assurance",
      plane: "agent",
      jobKind: AGENT_ASSURANCE_JOB_KIND,
      deviceId,
      assuranceId,
      monitorType,
    },
  };

  try {
    await stateStore.upsertAgentRun(runRecord);
    const result = await runMonitorJob(payload, runtimeSettings);
    runRecord.completedAt = new Date().toISOString();
    runRecord.summary = `${displayName}: ${result.summary}`;
    runRecord.details = {
      ...runRecord.details,
      status: result.status,
      summary: result.summary,
    };
    await stateStore.upsertAgentRun(runRecord);
    await stateStore.addAction({
      actor: "steward",
      kind: "diagnose",
      message: runRecord.summary,
      context: {
        agentRunId: runRecord.id,
        assuranceId,
        deviceId,
        status: result.status,
      },
    });
    return {
      summary: runRecord.summary,
      status: result.status,
      assuranceId,
    };
  } catch (error) {
    runRecord.completedAt = new Date().toISOString();
    runRecord.outcome = "error";
    runRecord.summary = `Agent assurance failed: ${error instanceof Error ? error.message : "unknown error"}`;
    runRecord.details = {
      ...runRecord.details,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
    await stateStore.upsertAgentRun(runRecord);
    throw error;
  }
};

const processScannerJobs = async (limit = 1): Promise<void> => {
  if (scannerWorkerRunning) {
    return;
  }

  scannerWorkerRunning = true;
  try {
    const jobs = stateStore.claimDurableJobs(limit, {
      kinds: Array.from(SCANNER_JOB_KINDS),
    });
    let scannerJobProcessed = false;

    for (const job of jobs) {
      try {
        if (scannerJobProcessed) {
          stateStore.completeDurableJob(job.id);
          continue;
        }
        scannerJobProcessed = true;
        const trigger = job.payload.trigger === "manual" ? "manual" : "interval";
        await runScannerCycle(trigger);
        stateStore.completeDurableJob(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stateStore.failDurableJob(
          job.id,
          message,
          Math.min(15 * 60_000, 15_000 * Math.max(1, job.attempts + 1)),
        );
      }
    }
  } finally {
    scannerWorkerRunning = false;
  }
};

const processRuntimeJobs = async (limit = 25): Promise<void> => {
  if (runtimeWorkerRunning) {
    return;
  }

  runtimeWorkerRunning = true;
  try {
    const runtimeSettings = stateStore.getRuntimeSettings();
    const jobs = stateStore.claimDurableJobs(limit, {
      kinds: Array.from(RUNTIME_JOB_KINDS),
    });
    let agentWakeProcessed = false;

    for (const job of jobs) {
      try {
        if (job.kind === MONITOR_EXECUTE_JOB_KIND) {
          await runMonitorJob(job.payload, runtimeSettings);
        } else if (job.kind === AGENT_WAKE_JOB_KIND) {
          if (agentWakeProcessed) {
            stateStore.completeDurableJob(job.id);
            continue;
          }
          agentWakeProcessed = true;
          await runAgentWakeJob(job.payload, runtimeSettings);
        } else if (job.kind === AGENT_ASSURANCE_JOB_KIND) {
          await runAgentAssuranceJob(job.payload, runtimeSettings);
        }
        stateStore.completeDurableJob(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stateStore.failDurableJob(
          job.id,
          message,
          Math.min(15 * 60_000, 15_000 * Math.max(1, job.attempts + 1)),
        );
      }
    }
  } finally {
    runtimeWorkerRunning = false;
  }
};

const runControlPlaneTick = async (): Promise<void> => {
  if (coordinatorRunning) {
    return;
  }

  coordinatorRunning = true;
  try {
    const settings = stateStore.getRuntimeSettings();
    expireStale();
    stateStore.cleanupExpiredRuntimeLeases();
    stateStore.requeueStaleDurableJobs(scannerJobStaleMs(settings), {
      kinds: Array.from(SCANNER_JOB_KINDS),
    });
    stateStore.requeueStaleDurableJobs(runtimeJobStaleMs(settings), {
      kinds: Array.from(RUNTIME_JOB_KINDS),
    });

    const latestScannerRun = stateStore.getLatestScannerRun();
    const scannerQueueBusy = stateStore.hasDurableJobsInFlight(Array.from(SCANNER_JOB_KINDS));
    if (latestScannerRunIsStale(latestScannerRun, settings) && !isStewardCycleRunning() && !scannerQueueBusy) {
      enqueueScannerJob("interval", settings);
    }

    await queueDueAssuranceJobs();

    const latestPeriodicAgentWake = stateStore.getLatestAgentRunByWakeReason("periodic_review");
    const agentWakeQueueBusy = stateStore.hasDurableJobsInFlight([AGENT_WAKE_JOB_KIND]);
    if (latestAgentWakeIsStale(latestPeriodicAgentWake, settings) && !agentWakeQueueBusy) {
      enqueueAgentWakeJob(settings, "periodic_review");
    }

    await Promise.all([
      processScannerJobs(),
      processRuntimeJobs(),
    ]);
  } finally {
    coordinatorRunning = false;
  }
};

const startLeaderWorkers = (settings: RuntimeSettings, options?: { immediate?: boolean }): void => {
  ensureDigestScheduler();
  ensureDeviceAutomationScheduler();

  const controlIntervalMs = coordinatorIntervalMs(settings);
  const sessionSweepIntervalMs = settings.protocolSessionSweepIntervalMs;
  const controlPlaneUnchanged = Boolean(coordinatorHandle) && currentCoordinatorIntervalMs === controlIntervalMs;
  const sessionSweepUnchanged = Boolean(sessionSweepHandle) && currentSessionSweepIntervalMs === sessionSweepIntervalMs;

  if (!controlPlaneUnchanged) {
    if (coordinatorHandle) {
      clearInterval(coordinatorHandle);
      coordinatorHandle = undefined;
    }
    currentCoordinatorIntervalMs = controlIntervalMs;
    coordinatorHandle = setInterval(() => {
      void runControlPlaneTick().catch((error) => {
        console.error("Control-plane tick failed", error);
      });
    }, controlIntervalMs);
  }

  if (!sessionSweepUnchanged) {
    if (sessionSweepHandle) {
      clearInterval(sessionSweepHandle);
      sessionSweepHandle = undefined;
    }
    currentSessionSweepIntervalMs = sessionSweepIntervalMs;
    sessionSweepHandle = setInterval(() => {
      void protocolSessionManager.sweep().catch((error) => {
        console.error("Protocol session sweep failed", error);
      });
      void webSessionManager.sweep().catch((error) => {
        console.error("Web session sweep failed", error);
      });
      void processNotificationJobs().catch((error) => {
        console.error("Notification worker failed", error);
      });
      expireStale();
      localToolRuntime.expireStaleApprovals();
    }, sessionSweepIntervalMs);
  }

  if (options?.immediate) {
    void runControlPlaneTick().catch((error) => {
      console.error("Control-plane bootstrap failed", error);
    });
  }

  void processNotificationJobs().catch((error) => {
    console.error("Notification worker startup failed", error);
  });
};

const stopLeaderWorkers = (): void => {
  stopDigestScheduler();
  stopDeviceAutomationScheduler();

  if (coordinatorHandle) {
    clearInterval(coordinatorHandle);
    coordinatorHandle = undefined;
  }
  if (sessionSweepHandle) {
    clearInterval(sessionSweepHandle);
    sessionSweepHandle = undefined;
  }

  currentCoordinatorIntervalMs = undefined;
  currentSessionSweepIntervalMs = undefined;
};

const refreshLeadership = async (): Promise<void> => {
  if (leadershipRefreshRunning) {
    return;
  }

  leadershipRefreshRunning = true;
  try {
    const settings = stateStore.getRuntimeSettings();
    const lease = stateStore.tryAcquireRuntimeLease(
      LOOP_LEASE_NAME,
      PROCESS_HOLDER_ID,
      leaderLeaseTtlMs(settings),
      {
        pid: process.pid,
      },
    );

    if (!lease.acquired) {
      if (leaderActive) {
        leaderActive = false;
        stopLeaderWorkers();
      }
      return;
    }

    const becameLeader = !leaderActive;
    leaderActive = true;
    if (becameLeader) {
      stateStore.markStaleScannerRuns(cycleLeaseTtlMs("interval", settings));
      stateStore.markStaleAgentRuns(agentWakeLeaseTtlMs(settings));
      stateStore.requeueProcessingDurableJobs({
        kinds: [
          ...Array.from(SCANNER_JOB_KINDS),
          ...Array.from(RUNTIME_JOB_KINDS),
        ],
      });
    }
    startLeaderWorkers(settings, { immediate: becameLeader });
  } finally {
    leadershipRefreshRunning = false;
  }
};

const runScannerCycle = async (
  trigger: "manual" | "interval" = "manual",
): Promise<StewardCycleSummary> => {
  if (scannerCycleRunning) {
    if (trigger === "manual") {
      throw new Error("Scanner cycle already running. Wait for the current cycle to finish.");
    }

    return emptyCycleSummary();
  }

  const runtimeSettings = stateStore.getRuntimeSettings();
  const cycleLease = stateStore.tryAcquireRuntimeLease(
    CYCLE_LEASE_NAME,
    PROCESS_HOLDER_ID,
    cycleLeaseTtlMs(trigger, runtimeSettings),
    {
      trigger,
      pid: process.pid,
    },
  );
  if (!cycleLease.acquired) {
    if (trigger === "manual") {
      throw new Error("Scanner cycle already running. Wait for the current cycle to finish.");
    }

    return emptyCycleSummary();
  }

  scannerCycleRunning = true;

  const runRecord: ScannerRunRecord = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    outcome: "ok",
    summary: trigger === "manual" ? "Manual scanner cycle in progress." : "Scheduled scanner cycle in progress.",
    details: {
      trigger,
      holder: PROCESS_HOLDER_ID,
    },
  };

  try {
    await stateStore.upsertScannerRun(runRecord);
    await stateStore.addAction({
      actor: "steward",
      kind: "discover",
      message: `Scanner cycle started (${trigger})`,
      context: {
        trigger,
        runId: runRecord.id,
      },
    });

    // Ensure adapters are loaded before running any phase.
    await adapterRegistry.initialize();

    const discover = await withPhaseTimeout(
      discoverPhase(
        trigger,
        Math.max(
          30_000,
          discoveryPhaseTimeoutMs(trigger, runtimeSettings) - 15_000,
        ),
      ),
      discoveryPhaseTimeoutMs(trigger, runtimeSettings),
      "Discovery phase timed out before cycle completion.",
    );
    runRecord.details = {
      ...runRecord.details,
      discovery: discover.diagnostics ?? null,
      discoveryScanMode: discover.scanMode,
      activeTargets: discover.activeTargets,
    };
    const actPromise = actPhase(discover.devices);
    const understandPromise = understandPhase(discover.devices, discover.deepScan);
    const learnPromise = learnPhase(discover.devices);
    const [act] = await Promise.all([actPromise, understandPromise, learnPromise]);

    const summary: StewardCycleSummary = {
      discovered: discover.discovered,
      updatedDevices: discover.updatedDevices,
      incidentsOpened: act.incidentsOpened,
      recommendationsAdded: act.recommendationsAdded,
      playbooksTriggered: act.playbooksTriggered,
      playbooksCompleted: act.playbooksCompleted,
      approvalsCreated: act.approvalsCreated,
    };

    runRecord.completedAt = new Date().toISOString();
    const summaryParts = [
      `discover=${summary.discovered}`,
      `devices-updated=${summary.updatedDevices}`,
      `incidents-opened=${summary.incidentsOpened}`,
      `recommendations-added=${summary.recommendationsAdded}`,
      `playbooks=${summary.playbooksTriggered}`,
      `approvals=${summary.approvalsCreated}`,
      `scan=${discover.scanMode}`,
    ];
    if ((discover.diagnostics?.constrainedPhaseCount ?? 0) > 0) {
      summaryParts.push(`discovery-limited=${discover.diagnostics?.constrainedPhaseCount ?? 0}`);
    }
    if ((discover.diagnostics?.failedPhaseCount ?? 0) > 0) {
      summaryParts.push(`discovery-failed=${discover.diagnostics?.failedPhaseCount ?? 0}`);
    }
    runRecord.summary = summaryParts.join(", ");
    runRecord.details = {
      ...runRecord.details,
      ...summary,
    };

    await stateStore.upsertScannerRun(runRecord);
    await stateStore.addAction({
      actor: "steward",
      kind: "learn",
      message: `Scanner cycle complete: ${runRecord.summary}`,
      context: {
        runId: runRecord.id,
      },
    });

    return summary;
  } catch (error) {
    runRecord.completedAt = new Date().toISOString();
    runRecord.outcome = "error";
    runRecord.summary = `Scanner cycle failed: ${error instanceof Error ? error.message : "unknown error"}`;
    runRecord.details = {
      ...runRecord.details,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };

    try {
      await stateStore.upsertScannerRun(runRecord);
      await stateStore.addAction({
        actor: "steward",
        kind: "diagnose",
        message: runRecord.summary,
        context: {
          runId: runRecord.id,
        },
      });
    } catch (persistError) {
      console.error("Failed to persist failed scanner run", persistError);
    }

    throw error;
  } finally {
    scannerCycleRunning = false;
    stateStore.releaseRuntimeLease(CYCLE_LEASE_NAME, PROCESS_HOLDER_ID);
  }
};

export const runStewardCycle = async (
  trigger: "manual" | "interval" = "manual",
): Promise<StewardCycleSummary> => runScannerCycle(trigger);

export const requestScannerCycle = (trigger: "manual" | "interval" = "manual"): void => {
  const settings = stateStore.getRuntimeSettings();
  enqueueScannerJob(trigger, settings);
  void processScannerJobs().catch((error) => {
    console.error("Manual scanner request failed", error);
  });
};

export const ensureStewardLoop = (): void => {
  const runtimeSettings = stateStore.getRuntimeSettings();
  const refreshMs = leaderRefreshIntervalMs(runtimeSettings);
  if (!leadershipHandle || currentLeadershipRefreshMs !== refreshMs) {
    if (leadershipHandle) {
      clearInterval(leadershipHandle);
      leadershipHandle = undefined;
    }

    currentLeadershipRefreshMs = refreshMs;
    leadershipHandle = setInterval(() => {
      void refreshLeadership().catch((error) => {
        console.error("Steward leadership refresh failed", error);
      });
    }, refreshMs);
  }

  void refreshLeadership().catch((error) => {
    console.error("Steward leadership bootstrap failed", error);
  });
};

export const stopStewardLoop = (): void => {
  if (leadershipHandle) {
    clearInterval(leadershipHandle);
    leadershipHandle = undefined;
    currentLeadershipRefreshMs = undefined;
  }
  leaderActive = false;
  stopLeaderWorkers();
  stateStore.releaseRuntimeLease(LOOP_LEASE_NAME, PROCESS_HOLDER_ID);
  stateStore.releaseRuntimeLease(CYCLE_LEASE_NAME, PROCESS_HOLDER_ID);
  stateStore.releaseRuntimeLease(AGENT_WAKE_LEASE_NAME, PROCESS_HOLDER_ID);
};

export const isStewardCycleRunning = (): boolean => {
  if (scannerCycleRunning) {
    return true;
  }

  const lease = stateStore.getRuntimeLease(CYCLE_LEASE_NAME);
  if (!lease) {
    return false;
  }

  const expiresAtMs = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
};
