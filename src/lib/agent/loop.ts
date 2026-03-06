import { randomUUID } from "node:crypto";
import { runDiscovery } from "@/lib/discovery/engine";
import { candidateToDevice } from "@/lib/discovery/classify";
import { dedupeObservations, evaluateDiscoveryEvidence } from "@/lib/discovery/evidence";
import { generateDiscoveryAdvice } from "@/lib/discovery/advisor";
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
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import {
  evaluateServiceContract,
  getRequiredProtocolsForServiceContract,
  isServiceContractDue,
} from "@/lib/monitoring/contracts";
import { graphStore } from "@/lib/state/graph";
import { stateStore } from "@/lib/state/store";
import { runShell } from "@/lib/utils/shell";
import type {
  AgentRunRecord,
  Device,
  DeviceBaseline,
  Incident,
  PlaybookRun,
  Recommendation,
  RuntimeSettings,
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

const AVAILABILITY_OFFLINE_INCIDENT_TYPE = "availability.offline";
const SECURITY_TELNET_INCIDENT_TYPE = "security.telnet-exposure";
const ASSURANCE_FAILURE_INCIDENT_TYPE = "assurance.failure";
const LEGACY_SERVICE_CONTRACT_FAILURE_INCIDENT_TYPE = "service-contract.failure";
const TLS_CERT_WARNING_WINDOW_DAYS = 30;
const TLS_CERT_CRITICAL_WINDOW_DAYS = 7;

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

const incidentKey = (incident: Incident): string =>
  String(incident.metadata.key ?? `${incident.severity}:${incident.title}:${incident.deviceIds.join(",")}`);

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

const upsertIncident = (
  incidents: Incident[],
  incoming: Omit<Incident, "id" | "detectedAt" | "updatedAt" | "timeline" | "autoRemediated">,
): { next: Incident[]; opened: boolean } => {
  const key = String(incoming.metadata.key ?? `${incoming.severity}:${incoming.title}:${incoming.deviceIds.join(",")}`);
  const idx = incidents.findIndex((incident) => incidentKey(incident) === key);

  if (idx === -1) {
    const created: Incident = {
      id: randomUUID(),
      detectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      timeline: [
        {
          at: new Date().toISOString(),
          message: "Detected by Steward",
        },
      ],
      autoRemediated: false,
      ...incoming,
    };

    return { next: [created, ...incidents], opened: true };
  }

  const existing = incidents[idx];
  const unchanged =
    existing.title === incoming.title &&
    existing.summary === incoming.summary &&
    existing.severity === incoming.severity &&
    existing.status === incoming.status;

  const now = Date.now();
  const lastEventAt = new Date(existing.timeline[0]?.at ?? existing.updatedAt).getTime();
  const shouldAppendHeartbeat = now - lastEventAt >= 15 * 60 * 1000;

  const updated: Incident = {
    ...existing,
    ...incoming,
    updatedAt: unchanged && !shouldAppendHeartbeat ? existing.updatedAt : new Date().toISOString(),
    timeline: shouldAppendHeartbeat
      ? [
          {
            at: new Date().toISOString(),
            message: "Incident condition persisted",
          },
          ...existing.timeline,
        ].slice(0, 30)
      : existing.timeline,
  };

  const next = [...incidents];
  next[idx] = updated;
  return { next, opened: false };
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

const resolveIncidentByKey = (
  incidents: Incident[],
  key: string,
  message: string,
): Incident[] => {
  const now = new Date().toISOString();
  return incidents.map((incident) => {
    const incidentKeyValue = String(incident.metadata.key ?? "");
    if (incidentKeyValue !== key || incident.status === "resolved") {
      return incident;
    }
    return {
      ...incident,
      status: "resolved",
      updatedAt: now,
      timeline: [
        { at: now, message },
        ...incident.timeline,
      ].slice(0, 30),
    };
  });
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

  const assurances = stateStore.getAssurances(device.id);
  if (assurances.length === 0) {
    return {
      incidents: nextIncidents,
      recommendations: nextRecommendations,
      incidentsOpened,
      recommendationsAdded,
    };
  }

  const nowMs = Date.now();
  const validated = new Set(
    stateStore.getValidatedCredentialProtocols(device.id).map((protocol) => protocol.toLowerCase()),
  );
  const ignoredTypes = normalizedIgnoredIncidentTypes(runtimeSettings);
  const assuranceAlertsEnabled = runtimeSettings.serviceContractScannerAlertsEnabled
    && !ignoredTypes.has(ASSURANCE_FAILURE_INCIDENT_TYPE)
    && !ignoredTypes.has(LEGACY_SERVICE_CONTRACT_FAILURE_INCIDENT_TYPE);

  for (const contract of assurances) {
    if (!isServiceContractDue(contract, nowMs)) {
      continue;
    }

    const requiredProtocols = getRequiredProtocolsForServiceContract(contract);
    const missingProtocols = requiredProtocols.filter((protocol) => !validated.has(protocol.toLowerCase()));
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

      const credentialRecommendation = ensureRecommendation(nextRecommendations, {
        title: `Provide ${missingProtocols.join(", ")} credentials for ${device.name}`,
        rationale: `Assurance "${contract.displayName}" is blocked by missing credentials.`,
        impact: "Enables monitor execution and automated incident detection.",
        priority: "high",
        relatedDeviceIds: [device.id],
      });
      nextRecommendations = credentialRecommendation.next;
      recommendationsAdded += credentialRecommendation.added ? 1 : 0;

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
      stateStore.upsertDeviceFindingByDedupe({
        deviceId: device.id,
        dedupeKey: findingKey,
        findingType: "assurance",
        severity: "info",
        title: `${contract.displayName} assurance healthy`,
        summary: evaluation.summary,
        evidenceJson: evaluation.evidenceJson,
        status: "resolved",
      });
      nextIncidents = resolveIncidentByKey(
        nextIncidents,
        findingKey,
        `Assurance recovered: ${contract.displayName}`,
      );
      continue;
    }

    if (evaluation.status === "pending") {
      stateStore.upsertDeviceFindingByDedupe({
        deviceId: device.id,
        dedupeKey: findingKey,
        findingType: "assurance_pending",
        severity: "info",
        title: `${contract.displayName} assurance pending`,
        summary: evaluation.summary,
        evidenceJson: evaluation.evidenceJson,
        status: "open",
      });

      const configRecommendation = ensureRecommendation(nextRecommendations, {
        title: `Complete assurance setup: ${contract.displayName}`,
        rationale: evaluation.summary,
        impact: "Allows Steward to actively validate this assurance.",
        priority: "medium",
        relatedDeviceIds: [device.id],
      });
      nextRecommendations = configRecommendation.next;
      recommendationsAdded += configRecommendation.added ? 1 : 0;
      continue;
    }

    const severity = criticalityToIncidentSeverity(contract.criticality);
    if (!assuranceAlertsEnabled) {
      nextIncidents = resolveIncidentByKey(
        nextIncidents,
        findingKey,
        `Assurance alerts disabled: ${contract.displayName}`,
      );
      stateStore.upsertDeviceFindingByDedupe({
        deviceId: device.id,
        dedupeKey: findingKey,
        findingType: "assurance",
        severity,
        title: `Assurance failed: ${contract.displayName}`,
        summary: `${evaluation.summary} (alert suppressed by runtime settings).`,
        evidenceJson: evaluation.evidenceJson,
        status: "resolved",
      });
      continue;
    }

    const incidentResult = upsertIncident(nextIncidents, {
      title: `Assurance failed: ${contract.displayName}`,
      summary: evaluation.summary,
      severity,
      deviceIds: [device.id],
      status: "open",
      diagnosis: "Device assurance drifted from its expected state.",
      remediationPlan: "Inspect assurance evidence, confirm credentials, and remediate the workload drift.",
      metadata: {
        key: findingKey,
        incidentType: ASSURANCE_FAILURE_INCIDENT_TYPE,
        scannerType: "assurance",
        assuranceId: contract.id,
        serviceContractId: contract.id,
        monitorType: evaluation.monitorType,
      },
    });
    nextIncidents = incidentResult.next;
    incidentsOpened += incidentResult.opened ? 1 : 0;

    stateStore.upsertDeviceFindingByDedupe({
      deviceId: device.id,
      dedupeKey: findingKey,
      findingType: "assurance",
      severity,
      title: `Assurance failed: ${contract.displayName}`,
      summary: evaluation.summary,
      evidenceJson: evaluation.evidenceJson,
      status: "open",
    });

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
): Promise<{ discovered: number; updatedDevices: number; devices: Device[]; deepScan: boolean }> => {
  const snapshot = await runDiscovery({
    forceDeepScan: trigger === "manual",
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
    await stateStore.upsertDevice(device);
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
  };
};

const inferCredentialTypes = (protocols: string[]): string[] => {
  const requirements = new Set<string>();
  if (protocols.includes("ssh")) requirements.add("ssh");
  if (protocols.includes("winrm")) requirements.add("winrm");
  if (protocols.includes("snmp")) requirements.add("snmp");
  if (protocols.includes("http-api")) requirements.add("api/web-admin");
  if (protocols.includes("docker")) requirements.add("docker");
  if (protocols.includes("kubernetes")) requirements.add("kubernetes");
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
    await stateStore.upsertDevice(enriched);
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
    await stateStore.upsertDevice({
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
    });
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
    if (device.status !== "offline") {
      stateStore.upsertDeviceFindingByDedupe({
        deviceId: device.id,
        dedupeKey: `offline:${device.id}`,
        findingType: "availability",
        severity: "warning",
        title: `${device.name} is offline`,
        summary: `${device.name} is currently reachable again.`,
        evidenceJson: {
          deviceStatus: device.status,
        },
        status: "resolved",
      });
    }

    if (device.status === "offline") {
      const incidentKeyValue = `offline:${device.id}`;
      if (!availabilityAlertsEnabled) {
        incidents = resolveIncidentByKey(
          incidents,
          incidentKeyValue,
          "Availability alerts are disabled for offline checks",
        );
        stateStore.upsertDeviceFindingByDedupe({
          deviceId: device.id,
          dedupeKey: incidentKeyValue,
          findingType: "availability",
          severity: "warning",
          title: `${device.name} is offline`,
          summary: `${device.name} (${device.ip}) is offline, but this alert type is currently suppressed.`,
          evidenceJson: {
            incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
            incidentKey: incidentKeyValue,
            deviceStatus: device.status,
          },
          status: "resolved",
        });
      } else {
        const upserted = upsertIncident(incidents, {
          title: `${device.name} is offline`,
          summary: `${device.name} (${device.ip}) has not been seen recently and appears offline.`,
          severity: "warning",
          deviceIds: [device.id],
          status: "open",
          metadata: {
            key: incidentKeyValue,
            incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
            scannerType: "availability",
          },
        });
        incidents = upserted.next;
        incidentsOpened += upserted.opened ? 1 : 0;

        stateStore.upsertDeviceFindingByDedupe({
          deviceId: device.id,
          dedupeKey: incidentKeyValue,
          findingType: "availability",
          severity: "warning",
          title: `${device.name} is offline`,
          summary: `${device.name} (${device.ip}) has not been seen recently and appears offline.`,
          evidenceJson: {
            incidentType: AVAILABILITY_OFFLINE_INCIDENT_TYPE,
            incidentKey: incidentKeyValue,
            deviceStatus: device.status,
          },
          status: "open",
        });
      }
    }

    const telnetOpen = device.services.some((service) => service.port === 23);
    if (!telnetOpen) {
      stateStore.upsertDeviceFindingByDedupe({
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
      });
    }
    if (telnetOpen) {
      const incidentKeyValue = `telnet:${device.id}`;
      if (!securityAlertsEnabled) {
        incidents = resolveIncidentByKey(
          incidents,
          incidentKeyValue,
          "Security exposure alerts are disabled for Telnet checks",
        );
        stateStore.upsertDeviceFindingByDedupe({
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
        });
      } else {
        const upserted = upsertIncident(incidents, {
          title: `${device.name} exposes Telnet`,
          summary: `Port 23 is open on ${device.name} (${device.ip}), which is insecure for management traffic.`,
          severity: "critical",
          deviceIds: [device.id],
          status: "open",
          diagnosis: "Cleartext management protocol exposed.",
          remediationPlan: "Disable Telnet and enforce SSH or HTTPS management access.",
          metadata: {
            key: incidentKeyValue,
            incidentType: SECURITY_TELNET_INCIDENT_TYPE,
            scannerType: "security",
          },
        });
        incidents = upserted.next;
        incidentsOpened += upserted.opened ? 1 : 0;

        stateStore.upsertDeviceFindingByDedupe({
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
        });

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
    const adoptionStatus = getDeviceAdoptionStatus(device);

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

    const contractEvaluation = await evaluateAssurancesForDevice(
      device,
      incidents,
      recommendations,
      runtimeSettings,
    );
    incidents = contractEvaluation.incidents;
    recommendations = contractEvaluation.recommendations;
    incidentsOpened += contractEvaluation.incidentsOpened;
    recommendationsAdded += contractEvaluation.recommendationsAdded;
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

let loopHandle: NodeJS.Timeout | undefined;
let loopRunning = false;
let currentIntervalMs: number | undefined;

export const runStewardCycle = async (
  trigger: "manual" | "interval" = "manual",
): Promise<StewardCycleSummary> => {
  if (loopRunning) {
    if (trigger === "manual") {
      throw new Error("Agent cycle already running. Wait for the current cycle to finish.");
    }

    return {
      discovered: 0,
      updatedDevices: 0,
      incidentsOpened: 0,
      recommendationsAdded: 0,
      playbooksTriggered: 0,
      playbooksCompleted: 0,
      approvalsCreated: 0,
    };
  }

  loopRunning = true;

  // Ensure adapters are loaded before running any phase.
  await adapterRegistry.initialize();

  const runRecord: AgentRunRecord = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    outcome: "ok",
    summary: "",
    details: {
      trigger,
    },
  };

  try {
    await stateStore.addAction({
      actor: "steward",
      kind: "discover",
      message: `Agent cycle started (${trigger})`,
      context: {
        trigger,
        runId: runRecord.id,
      },
    });

    const discover = await discoverPhase(trigger);
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
    runRecord.summary = `discover=${summary.discovered}, devices-updated=${summary.updatedDevices}, incidents-opened=${summary.incidentsOpened}, recommendations-added=${summary.recommendationsAdded}, playbooks=${summary.playbooksTriggered}, approvals=${summary.approvalsCreated}`;
    runRecord.details = {
      ...runRecord.details,
      ...summary,
    };

    await stateStore.addAgentRun(runRecord);
    await stateStore.addAction({
      actor: "steward",
      kind: "learn",
      message: `Agent cycle complete: ${runRecord.summary}`,
      context: {
        runId: runRecord.id,
      },
    });

    return summary;
  } catch (error) {
    runRecord.completedAt = new Date().toISOString();
    runRecord.outcome = "error";
    runRecord.summary = `Agent cycle failed: ${error instanceof Error ? error.message : "unknown error"}`;
    runRecord.details = {
      ...runRecord.details,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };

    try {
      await stateStore.addAgentRun(runRecord);
      await stateStore.addAction({
        actor: "steward",
        kind: "diagnose",
        message: runRecord.summary,
        context: {
          runId: runRecord.id,
        },
      });
    } catch (persistError) {
      console.error("Failed to persist failed agent run", persistError);
    }

    throw error;
  } finally {
    loopRunning = false;
  }
};

export const ensureStewardLoop = (): void => {
  ensureDigestScheduler();
  const intervalMs = stateStore.getRuntimeSettings().agentIntervalMs;
  if (loopHandle && currentIntervalMs === intervalMs) {
    return;
  }

  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = undefined;
  }

  currentIntervalMs = intervalMs;
  loopHandle = setInterval(() => {
    void runStewardCycle("interval").catch((error) => {
      console.error("Steward interval cycle failed", error);
    });
  }, intervalMs);
};

export const stopStewardLoop = (): void => {
  stopDigestScheduler();
  if (!loopHandle) {
    return;
  }

  clearInterval(loopHandle);
  loopHandle = undefined;
  currentIntervalMs = undefined;
};

export const isStewardCycleRunning = (): boolean => loopRunning;
