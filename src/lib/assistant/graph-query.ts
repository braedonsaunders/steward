import { graphStore } from "@/lib/state/graph";
import { getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import type { Device } from "@/lib/state/types";

interface GraphQueryResult {
  handled: boolean;
  response?: string;
  metadata?: Record<string, unknown>;
}

export type NetworkQueryAction = "inventory" | "device_summary" | "dependencies" | "recent_changes";

export interface StructuredNetworkQueryInput {
  action: NetworkQueryAction;
  deviceId?: string;
  sameSubnetAsDeviceId?: string;
  sameSubnetAsAttachedDevice?: boolean;
  query?: string;
  adoptionStatus?: "any" | "discovered" | "adopted" | "ignored";
  status?: "any" | "online" | "offline" | "degraded" | "unknown";
  type?: Device["type"] | "any";
  limit?: number;
  hours?: number;
}

export interface StructuredNetworkQueryResult {
  ok: boolean;
  action: NetworkQueryAction;
  summary?: string;
  error?: string;
  targetDevice?: Record<string, unknown>;
  sameSubnetTarget?: Record<string, unknown>;
  devices?: Array<Record<string, unknown>>;
  subnetPeers?: Array<Record<string, unknown>>;
  dependentDevices?: Array<Record<string, unknown>>;
  dependentCount?: number;
  matchedDeviceCount?: number;
  adoptionCounts?: Record<string, number>;
  hours?: number;
  count?: number;
  changes?: Array<Record<string, unknown>>;
  openIncidents?: Array<Record<string, unknown>>;
  openRecommendations?: Array<Record<string, unknown>>;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function sameSubnet24(a: string, b: string): boolean {
  const aParts = a.split(".");
  const bParts = b.split(".");
  return aParts.length === 4 && bParts.length === 4
    && aParts[0] === bParts[0]
    && aParts[1] === bParts[1]
    && aParts[2] === bParts[2];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function extractHours(lowerInput: string): number {
  const match = lowerInput.match(/last\s+(\d+)\s*(hour|hours|day|days)/i);
  if (!match) {
    return 24;
  }
  const amount = Math.max(1, Number(match[1]));
  if (match[2].toLowerCase().startsWith("day")) {
    return Math.min(24 * 14, amount * 24);
  }
  return Math.min(24 * 14, amount);
}

function resolveDeviceReference(
  reference: string | undefined,
  devices: Device[],
  fallbackDevice?: Device | null,
): Device | null {
  const token = reference ? normalize(reference) : "";
  if (!token) {
    return fallbackDevice ?? null;
  }

  return devices.find((device) =>
    normalize(device.id) === token
    || normalize(device.ip) === token
    || normalize(device.name) === token,
  ) ?? null;
}

function resolveDeviceFromInput(input: string, devices: Device[], fallbackDevice?: Device | null): Device | null {
  const lower = normalize(input);

  // Prefer explicit references by id/ip.
  const exact = devices.find((device) =>
    lower.includes(normalize(device.id))
    || lower.includes(normalize(device.ip))
    || lower.includes(normalize(device.name)),
  );
  if (exact) {
    return exact;
  }

  // Fallback to attached device if the user asks "this device/server".
  if (fallbackDevice && /(this\s+(device|server|host)|it|that\s+device)/i.test(lower)) {
    return fallbackDevice;
  }

  return null;
}

function formatDependents(target: Device, dependents: Device[]): string {
  if (dependents.length === 0) {
    return `No managed dependencies currently point to ${target.name} (${target.ip}).`;
  }

  const lines = dependents
    .slice(0, 20)
    .map((device) => `- ${device.name} (${device.ip})`);
  return [
    `Devices that depend on ${target.name} (${target.ip}):`,
    ...lines,
    dependents.length > 20 ? `- ...and ${dependents.length - 20} more` : "",
  ].filter(Boolean).join("\n");
}

function formatRecentChanges(hours: number, labels: string[]): string {
  if (labels.length === 0) {
    return `No graph node changes were recorded in the last ${hours} hour${hours === 1 ? "" : "s"}.`;
  }
  return [
    `Graph changes in the last ${hours} hour${hours === 1 ? "" : "s"}:`,
    ...labels.slice(0, 20).map((label) => `- ${label}`),
    labels.length > 20 ? `- ...and ${labels.length - 20} more` : "",
  ].filter(Boolean).join("\n");
}

function buildDeviceSearchHaystack(device: Device): string {
  return [
    device.id,
    device.name,
    device.ip,
    device.hostname ?? "",
    device.vendor ?? "",
    device.os ?? "",
    device.type,
    device.tags.join(" "),
    device.protocols.join(" "),
    device.services.map((service) => `${service.name} ${service.port} ${service.product ?? ""}`).join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

function inventoryMatchScore(
  device: Device,
  query: string,
  sameSubnetTarget?: Device | null,
): number {
  const normalizedQuery = normalize(query);
  let score = 0;
  if (normalize(device.id) === normalizedQuery) score += 12;
  if (normalize(device.ip) === normalizedQuery) score += 12;
  if (normalize(device.name) === normalizedQuery) score += 10;
  if (normalize(device.hostname ?? "") === normalizedQuery) score += 9;
  if (normalize(device.name).includes(normalizedQuery)) score += 6;
  if (normalize(device.hostname ?? "").includes(normalizedQuery)) score += 5;
  if (normalize(device.vendor ?? "").includes(normalizedQuery)) score += 3;
  if (normalize(device.os ?? "").includes(normalizedQuery)) score += 2;
  if (buildDeviceSearchHaystack(device).includes(normalizedQuery)) score += 1;
  if (sameSubnetTarget && sameSubnet24(device.ip, sameSubnetTarget.ip)) score += 1;
  if (device.status === "online") score += 1;
  return score;
}

function summarizeDeviceRecord(
  device: Device,
  args?: {
    attachedDevice?: Device | null;
    incidentCount?: number;
    recommendationCount?: number;
    sameSubnetTarget?: Device | null;
  },
): Record<string, unknown> {
  return {
    id: device.id,
    name: device.name,
    ip: device.ip,
    hostname: device.hostname ?? null,
    vendor: device.vendor ?? null,
    os: device.os ?? null,
    type: device.type,
    status: device.status,
    adoptionStatus: getDeviceAdoptionStatus(device),
    autonomyTier: device.autonomyTier,
    protocols: device.protocols.slice(0, 12),
    tags: device.tags,
    services: device.services.slice(0, 8).map((service) => `${service.name}:${service.port}`),
    incidentCount: args?.incidentCount ?? 0,
    recommendationCount: args?.recommendationCount ?? 0,
    sameSubnetAsAttachedDevice: args?.attachedDevice ? sameSubnet24(device.ip, args.attachedDevice.ip) : undefined,
    sameSubnetAsTarget: args?.sameSubnetTarget ? sameSubnet24(device.ip, args.sameSubnetTarget.ip) : undefined,
    lastSeenAt: device.lastSeenAt,
    lastChangedAt: device.lastChangedAt,
  };
}

export async function queryNetworkState(
  input: StructuredNetworkQueryInput,
  attachedDevice?: Device | null,
): Promise<StructuredNetworkQueryResult> {
  const state = await stateStore.getState();
  const devices = state.devices;
  const incidentsByDeviceId = new Map<string, number>();
  const recommendationsByDeviceId = new Map<string, number>();

  for (const incident of state.incidents) {
    if (incident.status === "resolved") {
      continue;
    }
    for (const deviceId of incident.deviceIds) {
      incidentsByDeviceId.set(deviceId, (incidentsByDeviceId.get(deviceId) ?? 0) + 1);
    }
  }

  for (const recommendation of state.recommendations) {
    if (recommendation.dismissed) {
      continue;
    }
    for (const deviceId of recommendation.relatedDeviceIds) {
      recommendationsByDeviceId.set(deviceId, (recommendationsByDeviceId.get(deviceId) ?? 0) + 1);
    }
  }

  if (input.action === "inventory") {
    const query = input.query?.trim() ?? "";
    const adoptionStatus = input.adoptionStatus && input.adoptionStatus !== "any"
      ? input.adoptionStatus
      : null;
    const status = input.status && input.status !== "any" ? input.status : null;
    const type = input.type && input.type !== "any" ? input.type : null;
    const sameSubnetTarget = input.sameSubnetAsAttachedDevice
      ? attachedDevice ?? null
      : resolveDeviceReference(input.sameSubnetAsDeviceId, devices);

    if (input.sameSubnetAsAttachedDevice && !attachedDevice) {
      return {
        ok: false,
        action: input.action,
        error: "same_subnet_as_attached_device requires a device-attached chat session.",
      };
    }

    if (input.sameSubnetAsDeviceId && !sameSubnetTarget) {
      return {
        ok: false,
        action: input.action,
        error: `No device matched '${input.sameSubnetAsDeviceId}'.`,
      };
    }

    let matched = devices.filter((device) => {
      if (adoptionStatus && getDeviceAdoptionStatus(device) !== adoptionStatus) {
        return false;
      }
      if (status && device.status !== status) {
        return false;
      }
      if (type && device.type !== type) {
        return false;
      }
      if (sameSubnetTarget && (device.id === sameSubnetTarget.id || !sameSubnet24(device.ip, sameSubnetTarget.ip))) {
        return false;
      }
      if (query.length > 0 && !buildDeviceSearchHaystack(device).includes(normalize(query))) {
        return false;
      }
      return true;
    });

    matched = matched.sort((a, b) => {
      const scoreDelta = inventoryMatchScore(b, query, sameSubnetTarget) - inventoryMatchScore(a, query, sameSubnetTarget);
      if (scoreDelta !== 0) return scoreDelta;
      if (a.status !== b.status) {
        return a.status === "online" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    const limit = clampInt(input.limit, 1, 100, 20);
    const adoptionCounts = matched.reduce<Record<string, number>>((counts, device) => {
      const adoption = getDeviceAdoptionStatus(device);
      counts[adoption] = (counts[adoption] ?? 0) + 1;
      return counts;
    }, {});
    const summaryParts = [`Matched ${matched.length} device${matched.length === 1 ? "" : "s"}`];
    if (sameSubnetTarget) {
      summaryParts.push(`on the same subnet as ${sameSubnetTarget.name}`);
    }
    if (query.length > 0) {
      summaryParts.push(`for "${query}"`);
    }

    return {
      ok: true,
      action: input.action,
      summary: matched.length === 0
        ? "No devices matched the current network query."
        : `${summaryParts.join(" ")}.`,
      matchedDeviceCount: matched.length,
      adoptionCounts,
      sameSubnetTarget: sameSubnetTarget ? summarizeDeviceRecord(sameSubnetTarget, { attachedDevice }) : undefined,
      devices: matched.slice(0, limit).map((device) =>
        summarizeDeviceRecord(device, {
          attachedDevice,
          incidentCount: incidentsByDeviceId.get(device.id) ?? 0,
          recommendationCount: recommendationsByDeviceId.get(device.id) ?? 0,
          sameSubnetTarget,
        })
      ),
    };
  }

  if (input.action === "device_summary") {
    const target = resolveDeviceReference(input.deviceId, devices, attachedDevice);
    if (!target) {
      return {
        ok: false,
        action: input.action,
        error: "device_id is required unless the chat is attached to a device.",
      };
    }

    const openIncidents = state.incidents
      .filter((incident) => incident.status !== "resolved" && incident.deviceIds.includes(target.id))
      .slice(0, 10)
      .map((incident) => ({
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
      }));
    const openRecommendations = state.recommendations
      .filter((recommendation) => !recommendation.dismissed && recommendation.relatedDeviceIds.includes(target.id))
      .slice(0, 10)
      .map((recommendation) => ({
        id: recommendation.id,
        title: recommendation.title,
        priority: recommendation.priority,
      }));
    const dependentIds = await graphStore.getDependents(target.id);
    const dependentDevices = dependentIds
      .map((id) => devices.find((device) => device.id === id))
      .filter((device): device is Device => Boolean(device));
    const subnetPeers = devices
      .filter((device) => device.id !== target.id && sameSubnet24(device.ip, target.ip))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 12)
      .map((device) =>
        summarizeDeviceRecord(device, {
          attachedDevice,
          incidentCount: incidentsByDeviceId.get(device.id) ?? 0,
          recommendationCount: recommendationsByDeviceId.get(device.id) ?? 0,
          sameSubnetTarget: target,
        })
      );

    return {
      ok: true,
      action: input.action,
      summary: `${target.name} is a ${getDeviceAdoptionStatus(target)} ${target.status} ${target.type} at ${target.ip}.`
        + ` Open incidents: ${openIncidents.length}. Open recommendations: ${openRecommendations.length}.`
        + ` Dependent devices: ${dependentDevices.length}.`,
      targetDevice: summarizeDeviceRecord(target, {
        attachedDevice,
        incidentCount: openIncidents.length,
        recommendationCount: openRecommendations.length,
      }),
      openIncidents,
      openRecommendations,
      dependentCount: dependentDevices.length,
      dependentDevices: dependentDevices.map((device) =>
        summarizeDeviceRecord(device, {
          attachedDevice,
          incidentCount: incidentsByDeviceId.get(device.id) ?? 0,
          recommendationCount: recommendationsByDeviceId.get(device.id) ?? 0,
          sameSubnetTarget: target,
        })
      ),
      subnetPeers,
      sameSubnetTarget: summarizeDeviceRecord(target, { attachedDevice }),
    };
  }

  if (input.action === "dependencies") {
    const target = resolveDeviceReference(input.deviceId, devices, attachedDevice);
    if (!target) {
      return {
        ok: false,
        action: input.action,
        error: "device_id is required unless the chat is attached to a device.",
      };
    }

    const dependentIds = await graphStore.getDependents(target.id);
    const dependentDevices = dependentIds
      .map((id) => devices.find((device) => device.id === id))
      .filter((device): device is Device => Boolean(device));

    return {
      ok: true,
      action: input.action,
      summary: dependentDevices.length === 0
        ? `No managed dependencies currently point to ${target.name} (${target.ip}).`
        : `Found ${dependentDevices.length} dependent device${dependentDevices.length === 1 ? "" : "s"} for ${target.name}.`,
      targetDevice: summarizeDeviceRecord(target, {
        attachedDevice,
        incidentCount: incidentsByDeviceId.get(target.id) ?? 0,
        recommendationCount: recommendationsByDeviceId.get(target.id) ?? 0,
      }),
      dependentCount: dependentDevices.length,
      dependentDevices: dependentDevices.map((device) =>
        summarizeDeviceRecord(device, {
          attachedDevice,
          incidentCount: incidentsByDeviceId.get(device.id) ?? 0,
          recommendationCount: recommendationsByDeviceId.get(device.id) ?? 0,
          sameSubnetTarget: target,
        })
      ),
    };
  }

  const hours = clampInt(input.hours, 1, 24 * 14, 24);
  const query = input.query?.trim().toLowerCase() ?? "";
  const limit = clampInt(input.limit, 1, 100, 20);
  const nodes = await graphStore.getRecentChanges(hours);
  const filteredNodes = nodes
    .filter((node) => {
      if (!query) return true;
      return node.type.toLowerCase().includes(query)
        || node.label.toLowerCase().includes(query)
        || JSON.stringify(node.properties).toLowerCase().includes(query);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    ok: true,
    action: input.action,
    summary: filteredNodes.length === 0
      ? `No graph node changes were recorded in the last ${hours} hour${hours === 1 ? "" : "s"}.`
      : `Found ${filteredNodes.length} graph change${filteredNodes.length === 1 ? "" : "s"} in the last ${hours} hour${hours === 1 ? "" : "s"}.`,
    hours,
    count: filteredNodes.length,
    changes: filteredNodes.slice(0, limit).map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      updatedAt: node.updatedAt,
      createdAt: node.createdAt,
    })),
  };
}

export async function tryExecuteGraphQuery(
  input: string,
  attachedDevice?: Device | null,
): Promise<GraphQueryResult> {
  const lower = normalize(input);
  const state = await stateStore.getState();
  const devices = state.devices;

  const dependencyIntent =
    /(what|which).*(depends?\s+on|dependents?\s+of)/i.test(lower)
    || /(what\s+breaks\s+if|if\s+.+\s+goes?\s+down)/i.test(lower);
  if (dependencyIntent) {
    const target = resolveDeviceFromInput(input, devices, attachedDevice);
    if (!target) {
      return {
        handled: true,
        response: "Dependency query needs a target device. Include a device name, ID, or IP.",
        metadata: { query: "dependency", resolved: false },
      };
    }

    const result = await queryNetworkState({
      action: "dependencies",
      deviceId: target.id,
    }, attachedDevice);

    return {
      handled: true,
      response: result.summary ?? formatDependents(target, []),
      metadata: {
        query: "dependency",
        targetDeviceId: target.id,
        dependentCount: result.dependentCount ?? 0,
      },
    };
  }

  if (/what\s+changed|changes?\s+in\s+the\s+last/i.test(lower)) {
    const hours = extractHours(lower);
    const result = await queryNetworkState({
      action: "recent_changes",
      hours,
    }, attachedDevice);
    const labels = Array.isArray(result.changes)
      ? result.changes.map((node) => `${String(node.type)}: ${String(node.label)}`)
      : [];
    return {
      handled: true,
      response: formatRecentChanges(hours, labels),
      metadata: {
        query: "recent_changes",
        hours,
        count: labels.length,
      },
    };
  }

  return { handled: false };
}
