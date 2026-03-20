import net from "node:net";
import { stateStore } from "@/lib/state/store";
import type { Device } from "@/lib/state/types";

function normalizeLookupToken(value: string): string {
  return value.trim().toLowerCase();
}

function compactLookupToken(value: string): string {
  return normalizeLookupToken(value).replace(/[^a-z0-9]/g, "");
}

function isLiteralIpAddress(value: string): boolean {
  return net.isIP(value.trim()) !== 0;
}

function exactTokenMatch(
  normalizedTarget: string,
  compactTarget: string,
  value: string | undefined,
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalizedValue = normalizeLookupToken(value);
  if (normalizedValue.length === 0) {
    return false;
  }
  return normalizedValue === normalizedTarget || compactLookupToken(value) === compactTarget;
}

export function buildLookupAliases(value: string | undefined): string[] {
  if (typeof value !== "string") {
    return [];
  }

  const normalized = normalizeLookupToken(value);
  if (normalized.length === 0) {
    return [];
  }

  const aliases = new Set<string>([normalized]);
  const compact = compactLookupToken(value);
  if (compact.length > 0) {
    aliases.add(compact);
  }

  if (isLiteralIpAddress(normalized)) {
    return Array.from(aliases);
  }

  const shortLabel = normalized.split(".")[0]?.trim();
  if (shortLabel) {
    aliases.add(shortLabel);
    const compactShort = shortLabel.replace(/[^a-z0-9]/g, "");
    if (compactShort.length > 0) {
      aliases.add(compactShort);
    }
  }

  return Array.from(aliases);
}

function scoreLookupAlias(
  targetAliases: string[],
  value: string | undefined,
  weights: {
    exact: number;
    prefix: number;
    contains: number;
  },
): number {
  const candidateAliases = buildLookupAliases(value);
  let best = 0;
  for (const targetAlias of targetAliases) {
    if (targetAlias.length === 0) {
      continue;
    }
    for (const alias of candidateAliases) {
      if (alias === targetAlias) {
        best = Math.max(best, weights.exact);
        continue;
      }
      if (alias.startsWith(targetAlias) || targetAlias.startsWith(alias)) {
        best = Math.max(best, weights.prefix);
        continue;
      }
      if (targetAlias.length >= 3 && (alias.includes(targetAlias) || targetAlias.includes(alias))) {
        best = Math.max(best, weights.contains);
      }
    }
  }
  return best;
}

function scoreExactDeviceMatch(target: string, device: Device): number {
  const normalizedTarget = normalizeLookupToken(target);
  if (normalizedTarget.length === 0) {
    return 0;
  }
  const compactTarget = compactLookupToken(target);

  if (exactTokenMatch(normalizedTarget, compactTarget, device.id)) return 500;
  if (exactTokenMatch(normalizedTarget, compactTarget, device.ip)) return 480;
  if ((device.secondaryIps ?? []).some((ip) => exactTokenMatch(normalizedTarget, compactTarget, ip))) return 470;
  if (exactTokenMatch(normalizedTarget, compactTarget, device.hostname)) return 460;
  if (exactTokenMatch(normalizedTarget, compactTarget, device.name)) return 440;
  return 0;
}

export async function resolveDeviceByTarget(
  rawTarget: string | undefined,
  attachedDeviceId?: string,
): Promise<Device | null> {
  const target = rawTarget?.trim();
  if ((!target || target.length === 0) && attachedDeviceId) {
    return stateStore.getDeviceById(attachedDeviceId);
  }

  if (!target) {
    return null;
  }

  const byId = stateStore.getDeviceById(target);
  if (byId) {
    return byId;
  }

  const devices = stateStore.getDevices();
  const exactMatches = devices
    .map((device) => ({
      device,
      score: scoreExactDeviceMatch(target, device),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.device.name.localeCompare(right.device.name));

  if (exactMatches.length > 0) {
    if (exactMatches.length === 1 || exactMatches[0].score > exactMatches[1].score) {
      return exactMatches[0].device;
    }
    return null;
  }

  const targetAliases = buildLookupAliases(target);
  const scored = devices
    .map((device) => ({
      device,
      score: Math.max(
        scoreLookupAlias(targetAliases, device.id, { exact: 140, prefix: 118, contains: 0 }),
        scoreLookupAlias(targetAliases, device.ip, { exact: 136, prefix: 0, contains: 0 }),
        ...((device.secondaryIps ?? []).map((ip) => scoreLookupAlias(targetAliases, ip, { exact: 134, prefix: 0, contains: 0 }))),
        scoreLookupAlias(targetAliases, device.hostname, { exact: 124, prefix: 104, contains: 82 }),
        scoreLookupAlias(targetAliases, device.name, { exact: 120, prefix: 100, contains: 78 }),
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.device.name.localeCompare(right.device.name));

  if (scored.length === 0) {
    return null;
  }
  if (scored.length === 1 || scored[0].score > scored[1].score) {
    return scored[0].device;
  }
  return null;
}
