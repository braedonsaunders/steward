import { randomUUID } from "node:crypto";
import { runShell } from "@/lib/utils/shell";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { ServiceFingerprint } from "@/lib/state/types";

const serviceFromNmap = (
  port: number,
  transport: "tcp" | "udp",
  name: string,
): ServiceFingerprint => {
  const secureByName = /(https|ssh|tls|ssl|imaps|ldaps|snmpv3)/i.test(name);

  return {
    id: randomUUID(),
    port,
    transport,
    name: name || "unknown",
    secure: secureByName,
    lastSeenAt: new Date().toISOString(),
  };
};

const parseNmapLine = (line: string): DiscoveryCandidate | undefined => {
  if (!line.startsWith("Host:")) {
    return undefined;
  }

  const hostMatch = line.match(/^Host:\s+(\d+\.\d+\.\d+\.\d+)\s+\(([^)]*)\)\s+Ports:\s+(.+)$/);
  if (!hostMatch) {
    return undefined;
  }

  const ip = hostMatch[1];
  const hostname = hostMatch[2] || undefined;
  const portBlob = hostMatch[3];

  const services: ServiceFingerprint[] = [];

  for (const chunk of portBlob.split(",")) {
    const fields = chunk.trim().split("/");
    if (fields.length < 5) {
      continue;
    }

    const port = Number(fields[0]);
    const state = fields[1];
    const transport = fields[2] as "tcp" | "udp";
    const service = fields[4] || "unknown";

    if (!Number.isFinite(port) || state !== "open") {
      continue;
    }

    services.push(serviceFromNmap(port, transport, service));
  }

  return {
    ip,
    hostname,
    services,
    source: "active",
    metadata: {
      scanner: "nmap",
    },
  };
};

const tryGetLocalIp = async (): Promise<string | undefined> => {
  const candidates = [
    "ipconfig getifaddr en0",
    "ipconfig getifaddr en1",
    "hostname -I",
    "ip -4 route get 1.1.1.1 | awk '{print $7}'",
  ];

  for (const command of candidates) {
    const result = await runShell(command, 2_500);
    if (!result.stdout) {
      continue;
    }

    const ip = result.stdout.split(/\s+/).find((item) => /\d+\.\d+\.\d+\.\d+/.test(item));
    if (ip) {
      return ip;
    }
  }

  return undefined;
};

const toSlash24 = (ip: string): string => {
  const [a, b, c] = ip.split(".");
  return `${a}.${b}.${c}.0/24`;
};

const pingSweep = async (ips: string[]): Promise<DiscoveryCandidate[]> => {
  const results: Array<DiscoveryCandidate | undefined> = await Promise.all(
    ips.map(async (ip) => {
      const ping = await runShell(`ping -c 1 -t 1 ${ip}`, 2_500);
      if (!ping.ok) {
        return undefined;
      }

      return {
        ip,
        services: [] as ServiceFingerprint[],
        source: "active" as const,
        metadata: {
          scanner: "ping",
        },
      };
    }),
  );

  return results.filter((item): item is DiscoveryCandidate => Boolean(item));
};

export const collectActiveCandidates = async (
  seedIps: string[] = [],
): Promise<DiscoveryCandidate[]> => {
  const hasNmap = await runShell("command -v nmap", 1_500);

  if (hasNmap.ok && hasNmap.stdout) {
    const localIp = await tryGetLocalIp();
    if (localIp) {
      const target = toSlash24(localIp);
      const scan = await runShell(`nmap -sS -Pn -T4 -F ${target} -oG -`, 45_000);

      if (scan.stdout) {
        const parsed = scan.stdout
          .split("\n")
          .map((line) => parseNmapLine(line.trim()))
          .filter((item): item is DiscoveryCandidate => Boolean(item));

        if (parsed.length > 0) {
          return parsed;
        }
      }
    }
  }

  const deduped = Array.from(new Set(seedIps));
  if (deduped.length === 0) {
    const localIp = await tryGetLocalIp();
    if (!localIp) {
      return [];
    }

    const [a, b, c] = localIp.split(".");
    const candidates = [1, 2, 10, 20, 30, 40, 50, 100, 200, 254].map(
      (n) => `${a}.${b}.${c}.${n}`,
    );

    return pingSweep(candidates);
  }

  return pingSweep(deduped);
};
