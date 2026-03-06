import type { Device } from "@/lib/state/types";

const AUTO_NAME_PATTERN = /^(server|workstation|router|firewall|switch|access-point|camera|nas|printer|iot|container-host|hypervisor|unknown|device)-\d+-\d+-\d+-\d+$/;
const SLUG_ONLY_PATTERN = /^[a-z0-9-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ipSlug(ip: string): string {
  return ip.trim().toLowerCase().replaceAll(".", "-").replaceAll(":", "-");
}

export function looksLikeScannedDeviceName(device: Pick<Device, "name" | "ip">): boolean {
  const name = device.name.trim().toLowerCase();
  if (!name) {
    return true;
  }

  const dashedIp = ipSlug(device.ip);
  if (name === device.ip.trim().toLowerCase() || name === dashedIp) {
    return true;
  }

  if (AUTO_NAME_PATTERN.test(name)) {
    return true;
  }

  return SLUG_ONLY_PATTERN.test(name) && name.endsWith(`-${dashedIp}`);
}

export function getDeviceIdentityDescription(device: Pick<Device, "metadata">): string {
  if (!isRecord(device.metadata)) {
    return "";
  }

  const identity = isRecord(device.metadata.identity) ? device.metadata.identity : null;
  if (identity && typeof identity.description === "string" && identity.description.trim().length > 0) {
    return identity.description.trim();
  }

  const adoption = isRecord(device.metadata.adoption) ? device.metadata.adoption : null;
  if (adoption && typeof adoption.profileSummary === "string" && adoption.profileSummary.trim().length > 0) {
    return adoption.profileSummary.trim();
  }

  return "";
}
