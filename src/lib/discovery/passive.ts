import { runShell } from "@/lib/utils/shell";
import type { DiscoveryCandidate } from "@/lib/discovery/types";

const ARP_LINE = /\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:.-]+|\(incomplete\))(?:\s+on\s+(\w+))?/i;

export const collectPassiveCandidates = async (): Promise<DiscoveryCandidate[]> => {
  const arp = await runShell("arp -a", 10_000);

  if (!arp.ok && !arp.stdout) {
    return [];
  }

  const lines = arp.stdout.split("\n").map((line) => line.trim());
  const candidates: DiscoveryCandidate[] = [];

  for (const line of lines) {
    const match = line.match(ARP_LINE);
    if (!match) {
      continue;
    }

    const ip = match[1];
    const macRaw = match[2];
    const iface = match[3];

    const mac = macRaw && macRaw !== "(incomplete)" ? macRaw.toLowerCase() : undefined;

    candidates.push({
      ip,
      mac,
      services: [],
      source: "passive",
      metadata: {
        interface: iface,
      },
    });
  }

  return candidates;
};
