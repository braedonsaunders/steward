import type { MissionRecord } from "@/lib/autonomy/types";
import type { Assurance, Device, Workload } from "@/lib/state/types";

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(new Set(
    values.filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  ));
}

function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}

export function missionSelectorDeviceIds(mission: MissionRecord): string[] {
  return normalizeStringArray(mission.targetJson.selector?.deviceIds);
}

export function missionMatchesDeviceSelector(
  mission: MissionRecord,
  device: Device,
  options?: {
    linkedDeviceIds?: string[];
    workloads?: Workload[];
    assurances?: Assurance[];
  },
): boolean {
  const selector = mission.targetJson.selector;
  if (!selector) {
    return true;
  }

  const explicitDeviceIds = Array.from(new Set([
    ...missionSelectorDeviceIds(mission),
    ...(options?.linkedDeviceIds ?? []).map((value) => value.trim()).filter(Boolean),
  ]));
  if (explicitDeviceIds.length > 0 && !explicitDeviceIds.includes(device.id)) {
    return false;
  }

  if (selector.deviceTypes?.length && !selector.deviceTypes.includes(device.type)) {
    return false;
  }

  if (selector.deviceNames?.length) {
    const haystack = `${device.name} ${device.hostname ?? ""}`.toLowerCase();
    if (!selector.deviceNames.some((candidate) => haystack.includes(candidate.toLowerCase()))) {
      return false;
    }
  }

  if (selector.servicesWithTls) {
    const hasTlsService = device.services.some((service) => service.secure || Boolean(service.tlsCert));
    if (!hasTlsService) {
      return false;
    }
  }

  if (selector.workloadCategory) {
    const matchingWorkload = (options?.workloads ?? []).some((workload) => workload.category === selector.workloadCategory);
    if (!matchingWorkload) {
      return false;
    }
  }

  if (selector.workloadNamePattern) {
    const matchingWorkload = (options?.workloads ?? []).some((workload) =>
      matchesPattern(selector.workloadNamePattern ?? "", `${workload.displayName} ${workload.workloadKey}`),
    );
    if (!matchingWorkload) {
      return false;
    }
  }

  if (selector.assuranceMonitorTypes?.length) {
    const matchingAssurance = (options?.assurances ?? []).some((assurance) =>
      selector.assuranceMonitorTypes?.includes(assurance.monitorType ?? ""),
    );
    if (!matchingAssurance) {
      return false;
    }
  }

  if (explicitDeviceIds.length > 0) {
    return true;
  }

  if (selector.allDevices) {
    return true;
  }

  return true;
}

export function describeMissionScope(mission: MissionRecord): string {
  const selector = mission.targetJson.selector;
  if (!selector) {
    return "No selector";
  }

  const parts: string[] = [];
  const deviceIds = missionSelectorDeviceIds(mission);
  if (selector.allDevices) {
    parts.push("all devices");
  }
  if (deviceIds.length > 0) {
    parts.push(`${deviceIds.length} explicit device${deviceIds.length === 1 ? "" : "s"}`);
  }
  if (selector.deviceTypes?.length) {
    parts.push(selector.deviceTypes.join(", "));
  }
  if (selector.servicesWithTls) {
    parts.push("TLS endpoints");
  }
  if (selector.workloadCategory) {
    parts.push(`${selector.workloadCategory} responsibilities`);
  }
  if (selector.workloadNamePattern) {
    parts.push(`responsibilities:${selector.workloadNamePattern}`);
  }
  if (selector.assuranceMonitorTypes?.length) {
    parts.push(`assurances:${selector.assuranceMonitorTypes.join(", ")}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "No selector";
}
