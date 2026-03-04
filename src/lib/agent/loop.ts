import { randomUUID } from "node:crypto";
import { runDiscovery } from "@/lib/discovery/engine";
import { candidateToDevice } from "@/lib/discovery/classify";
import { generateDiscoveryAdvice } from "@/lib/discovery/advisor";
import { buildManagementSurface } from "@/lib/protocols/negotiator";
import { evaluatePolicy } from "@/lib/policy/engine";
import { matchPlaybooksForIncident } from "@/lib/playbooks/registry";
import { executePlaybook } from "@/lib/playbooks/runtime";
import { createApproval, expireStale } from "@/lib/approvals/queue";
import { pluginRegistry } from "@/lib/plugins/registry";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { graphStore } from "@/lib/state/graph";
import { stateStore } from "@/lib/state/store";
import { runShell } from "@/lib/utils/shell";
import type {
  AgentRunRecord,
  Device,
  DeviceBaseline,
  Incident,
  PlaybookRun,
  PlaybookStep,
  Recommendation,
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
  const seenIps = new Set<string>();

  for (const candidate of snapshot.merged) {
    // Try to find existing device by: primary IP, secondary IPs, or MAC
    let previous = existingByIp.get(candidate.ip);
    if (!previous && candidate.mac) {
      previous = existingByMac.get(candidate.mac.toLowerCase());
    }

    const device = candidateToDevice(candidate, previous);
    seenIps.add(device.ip);
    for (const secIp of device.secondaryIps ?? []) {
      seenIps.add(secIp);
    }
    await stateStore.upsertDevice(device);
    await graphStore.attachDevice(device);
    updated += 1;
  }

  if (seenIps.size > 0) {
    await stateStore.updateState(async (current) => {
      for (const device of current.devices) {
        if (!seenIps.has(device.ip)) {
          const ageMs = Date.now() - new Date(device.lastSeenAt).getTime();
          if (ageMs > 30 * 60 * 1000) {
            device.status = "offline";
          }
        }
      }
      return current;
    });
  }

  const nextState = await stateStore.getState();

  return {
    discovered: snapshot.merged.length,
    updatedDevices: updated,
    devices: nextState.devices,
    deepScan: snapshot.scanMode === "deep",
  };
};

const inferCredentialTypes = (protocols: string[]): string[] => {
  const requirements = new Set<string>();
  if (protocols.includes("ssh")) requirements.add("ssh");
  if (protocols.includes("winrm") || protocols.includes("windows")) requirements.add("winrm");
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

  await stateStore.updateState(async (state) => {
    state.devices = state.devices.map((device) => {
      const surface = buildManagementSurface(device);
      const protocols = Array.from(
        new Set([...(device.protocols ?? []), ...(surface.capabilities.map((cap) => cap.protocol) ?? [])]),
      );

      return {
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
    });

    return state;
  });

  for (const device of devices) {
    if (device.type === "server") {
      const nasPeer = devices.find((item) => item.type === "nas");
      if (nasPeer) {
        await graphStore.addDependency(device.id, nasPeer.id, "Potential backup/data dependency");
      }
    }

    const network = subnet24(device.ip);
    if (!network) {
      continue;
    }

    const gateway = devices.find((item) => {
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

  const advisoryCandidates = devices
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
  await stateStore.updateState(async (state) => {
    state.devices = state.devices.map((device) => {
      const item = adviceByDeviceId.get(device.id);
      if (!item) {
        return device;
      }

      const existingAdoption =
        getAdoptionRecord(device);

      return {
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
      };
    });

    return state;
  });
};

const actPhase = async (devices: Device[]): Promise<{
  incidentsOpened: number;
  recommendationsAdded: number;
  playbooksTriggered: number;
  playbooksCompleted: number;
  approvalsCreated: number;
}> => {
  const state = await stateStore.getState();
  let incidents = [...state.incidents];
  let recommendations = [...state.recommendations];

  let incidentsOpened = 0;
  let recommendationsAdded = 0;
  let credentialOnboardingRecommendations = 0;

  for (const device of devices) {
    if (device.status === "offline") {
      const upserted = upsertIncident(incidents, {
        title: `${device.name} is offline`,
        summary: `${device.name} (${device.ip}) has not been seen recently and appears offline.`,
        severity: "warning",
        deviceIds: [device.id],
        status: "open",
        metadata: {
          key: `offline:${device.id}`,
        },
      });
      incidents = upserted.next;
      incidentsOpened += upserted.opened ? 1 : 0;
    }

    const telnetOpen = device.services.some((service) => service.port === 23);
    if (telnetOpen) {
      const upserted = upsertIncident(incidents, {
        title: `${device.name} exposes Telnet`,
        summary: `Port 23 is open on ${device.name} (${device.ip}), which is insecure for management traffic.`,
        severity: "critical",
        deviceIds: [device.id],
        status: "open",
        diagnosis: "Cleartext management protocol exposed.",
        remediationPlan: "Disable Telnet and enforce SSH or HTTPS management access.",
        metadata: {
          key: `telnet:${device.id}`,
        },
      });
      incidents = upserted.next;
      incidentsOpened += upserted.opened ? 1 : 0;

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

        const policyResult = evaluatePolicy(playbook.actionClass, device, policyRules, maintenanceWindows);

        if (policyResult.decision === "DENY") {
          void stateStore.addAction({
            actor: "steward",
            kind: "policy",
            message: `Denied playbook "${playbook.name}" on ${device.name}: ${policyResult.reason}`,
            context: { playbookId: playbook.id, deviceId: device.id, ruleId: policyResult.ruleId },
          });
          continue;
        }

        // Build the PlaybookRun
        const toRunStep = (s: Omit<PlaybookStep, "status" | "output" | "startedAt" | "completedAt">): PlaybookStep => ({
          ...s,
          status: "pending",
        });

        const run: PlaybookRun = {
          id: randomUUID(),
          playbookId: playbook.id,
          family: playbook.family,
          name: playbook.name,
          deviceId: device.id,
          incidentId: incident.id,
          actionClass: playbook.actionClass,
          status: policyResult.decision === "ALLOW_AUTO" ? "approved" : "pending_approval",
          policyEvaluation: policyResult,
          steps: playbook.steps.map(toRunStep),
          verificationSteps: playbook.verificationSteps.map(toRunStep),
          rollbackSteps: playbook.rollbackSteps.map(toRunStep),
          evidence: { logs: [] },
          createdAt: new Date().toISOString(),
          failureCount: 0,
        };

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
  }

  // Expire stale approvals
  expireStale();

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

  await stateStore.updateState(async (state) => {
    for (const result of latencyResults) {
      if (result.latencyMs === undefined) {
        continue;
      }

      const idx = state.baselines.findIndex((baseline) => baseline.deviceId === result.deviceId);
      const baseline = buildBaseline(state.baselines[idx], result.latencyMs);
      baseline.deviceId = result.deviceId;

      if (idx === -1) {
        state.baselines.push(baseline);
      } else {
        state.baselines[idx] = baseline;
      }
    }

    return state;
  });
};

let loopHandle: NodeJS.Timeout | undefined;
let loopRunning = false;
let currentIntervalMs: number | undefined;

export const runStewardCycle = async (
  trigger: "manual" | "interval" = "manual",
): Promise<StewardCycleSummary> => {
  if (loopRunning) {
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

  // Ensure plugins are loaded before running any phase
  await pluginRegistry.initialize();

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
    const discover = await discoverPhase(trigger);
    await understandPhase(discover.devices, discover.deepScan);
    const act = await actPhase(discover.devices);
    await learnPhase(discover.devices);

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
  if (!loopHandle) {
    return;
  }

  clearInterval(loopHandle);
  loopHandle = undefined;
  currentIntervalMs = undefined;
};
