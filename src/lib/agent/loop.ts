import { randomUUID } from "node:crypto";
import { runDiscovery } from "@/lib/discovery/engine";
import { candidateToDevice } from "@/lib/discovery/classify";
import { buildManagementSurface } from "@/lib/protocols/negotiator";
import { graphStore } from "@/lib/state/graph";
import { stateStore } from "@/lib/state/store";
import { runShell } from "@/lib/utils/shell";
import type {
  AgentRunRecord,
  Device,
  DeviceBaseline,
  Incident,
  Recommendation,
} from "@/lib/state/types";

interface StewardCycleSummary {
  discovered: number;
  updatedDevices: number;
  incidentsOpened: number;
  recommendationsAdded: number;
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
  const ping = await runShell(`ping -c 1 -t 1 ${ip}`, 3_500);
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
  const updated: Incident = {
    ...existing,
    ...incoming,
    updatedAt: new Date().toISOString(),
    timeline: [
      {
        at: new Date().toISOString(),
        message: "Incident condition persisted",
      },
      ...existing.timeline,
    ].slice(0, 30),
  };

  const next = [...incidents];
  next[idx] = updated;
  return { next, opened: false };
};

const ensureRecommendation = (
  recommendations: Recommendation[],
  incoming: Omit<Recommendation, "id" | "createdAt" | "dismissed">,
): { next: Recommendation[]; added: boolean } => {
  const key = `${incoming.priority}:${incoming.title}:${incoming.relatedDeviceIds.join(",")}`;
  const exists = recommendations.some((item) => recommendationKey(item) === key && !item.dismissed);

  if (exists) {
    return { next: recommendations, added: false };
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

const discoverPhase = async (): Promise<{ discovered: number; updatedDevices: number; devices: Device[] }> => {
  const snapshot = await runDiscovery();
  const state = await stateStore.getState();
  const existingByIp = new Map(state.devices.map((device) => [device.ip, device]));

  let updated = 0;
  const seenIps = new Set<string>();

  for (const candidate of snapshot.merged) {
    const previous = existingByIp.get(candidate.ip);
    const device = candidateToDevice(candidate, previous);
    seenIps.add(device.ip);
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
  };
};

const understandPhase = async (devices: Device[]): Promise<void> => {
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
  }
};

const actPhase = async (devices: Device[]): Promise<{ incidentsOpened: number; recommendationsAdded: number }> => {
  const state = await stateStore.getState();
  let incidents = [...state.incidents];
  let recommendations = [...state.recommendations];

  let incidentsOpened = 0;
  let recommendationsAdded = 0;

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
  }

  await stateStore.setIncidents(incidents.slice(0, 400));
  await stateStore.setRecommendations(recommendations.slice(0, 400));

  return {
    incidentsOpened,
    recommendationsAdded,
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

export const runStewardCycle = async (
  trigger: "manual" | "interval" = "manual",
): Promise<StewardCycleSummary> => {
  if (loopRunning) {
    return {
      discovered: 0,
      updatedDevices: 0,
      incidentsOpened: 0,
      recommendationsAdded: 0,
    };
  }

  loopRunning = true;
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
    const discover = await discoverPhase();
    await understandPhase(discover.devices);
    const act = await actPhase(discover.devices);
    await learnPhase(discover.devices);

    const summary: StewardCycleSummary = {
      discovered: discover.discovered,
      updatedDevices: discover.updatedDevices,
      incidentsOpened: act.incidentsOpened,
      recommendationsAdded: act.recommendationsAdded,
    };

    runRecord.completedAt = new Date().toISOString();
    runRecord.summary = `discover=${summary.discovered}, devices-updated=${summary.updatedDevices}, incidents-opened=${summary.incidentsOpened}, recommendations-added=${summary.recommendationsAdded}`;
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
  if (loopHandle) {
    return;
  }

  const intervalMs = Number(process.env.STEWARD_AGENT_INTERVAL_MS ?? 120_000);
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
};
