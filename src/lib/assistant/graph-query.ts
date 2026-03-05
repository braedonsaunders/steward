import { graphStore } from "@/lib/state/graph";
import { stateStore } from "@/lib/state/store";
import type { Device } from "@/lib/state/types";

interface GraphQueryResult {
  handled: boolean;
  response?: string;
  metadata?: Record<string, unknown>;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
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

    const dependentIds = await graphStore.getDependents(target.id);
    const dependentDevices = dependentIds
      .map((id) => devices.find((device) => device.id === id))
      .filter((device): device is Device => Boolean(device));

    return {
      handled: true,
      response: formatDependents(target, dependentDevices),
      metadata: {
        query: "dependency",
        targetDeviceId: target.id,
        dependentCount: dependentDevices.length,
      },
    };
  }

  if (/what\s+changed|changes?\s+in\s+the\s+last/i.test(lower)) {
    const hours = extractHours(lower);
    const nodes = await graphStore.getRecentChanges(hours);
    const labels = nodes.map((node) => `${node.type}: ${node.label}`);
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
