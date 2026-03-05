import { runShell } from "@/lib/utils/shell";
import { buildObservation } from "@/lib/discovery/evidence";
import type { DiscoveryCandidate } from "@/lib/discovery/types";

const ARP_LINE = /\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:.-]+|\(incomplete\))(?:\s+on\s+(\w+))?/i;
const ARP_WINDOWS_LINE = /^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17}|incomplete)\s+(dynamic|static)$/i;

const isEligibleIp = (ip: string): boolean => {
  const octets = ip.split(".").map((value) => Number(value));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }

  const [a, b, , d] = octets;

  if (a === 127 || a >= 224 || a === 0) {
    return false;
  }

  if (d === 255) {
    return false;
  }

  const isPrivate =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);

  return isPrivate;
};

export const collectPassiveCandidates = async (): Promise<DiscoveryCandidate[]> => {
  const arp = await runShell("arp -a", 10_000);

  if (!arp.ok && !arp.stdout) {
    return [];
  }

  const lines = arp.stdout.split("\n").map((line) => line.trim());
  const candidates: DiscoveryCandidate[] = [];

  for (const line of lines) {
    const unixMatch = line.match(ARP_LINE);
    if (unixMatch) {
      const ip = unixMatch[1];
      if (!isEligibleIp(ip)) {
        continue;
      }
      const macRaw = unixMatch[2];
      const iface = unixMatch[3];
      const mac = macRaw && macRaw !== "(incomplete)" ? macRaw.toLowerCase() : undefined;
      if (!mac) {
        continue;
      }

      candidates.push({
        ip,
        mac,
        services: [],
        source: "passive",
        observations: [
          buildObservation({
            ip,
            source: "passive",
            evidenceType: "arp_resolved",
            confidence: 0.9,
            observedAt: new Date().toISOString(),
            ttlMs: 20 * 60_000,
            details: {
              interface: iface,
              method: "arp",
            },
          }),
        ],
        metadata: {
          interface: iface,
        },
      });
      continue;
    }

    const windowsMatch = line.match(ARP_WINDOWS_LINE);
    if (windowsMatch) {
      const ip = windowsMatch[1];
      if (!isEligibleIp(ip)) {
        continue;
      }
      const macRaw = windowsMatch[2];
      const mac = macRaw.toLowerCase() !== "incomplete" ? macRaw.toLowerCase().replace(/-/g, ":") : undefined;
      if (!mac) {
        continue;
      }

      candidates.push({
        ip,
        mac,
        services: [],
        source: "passive",
        observations: [
          buildObservation({
            ip,
            source: "passive",
            evidenceType: "arp_resolved",
            confidence: 0.9,
            observedAt: new Date().toISOString(),
            ttlMs: 20 * 60_000,
            details: {
              method: "arp",
              arpType: windowsMatch[3].toLowerCase(),
            },
          }),
        ],
        metadata: {
          arpType: windowsMatch[3].toLowerCase(),
        },
      });
    }
  }

  return candidates;
};
