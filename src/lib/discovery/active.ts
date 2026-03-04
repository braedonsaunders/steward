import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import { runShell } from "@/lib/utils/shell";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { ServiceFingerprint } from "@/lib/state/types";

export interface ActiveDiscoveryOptions {
  deepScan?: boolean;
  targetOffset?: number;
  maxTargets?: number;
  maxPortScanHosts?: number;
}

const COMMON_TCP_SERVICES: Array<{ port: number; name: string; secure: boolean }> = [
  { port: 21, name: "ftp", secure: false },
  { port: 22, name: "ssh", secure: true },
  { port: 23, name: "telnet", secure: false },
  { port: 53, name: "dns", secure: false },
  { port: 80, name: "http", secure: false },
  { port: 88, name: "kerberos", secure: true },
  { port: 135, name: "msrpc", secure: false },
  { port: 139, name: "netbios-ssn", secure: false },
  { port: 389, name: "ldap", secure: false },
  { port: 443, name: "https", secure: true },
  { port: 445, name: "microsoft-ds", secure: false },
  { port: 554, name: "rtsp", secure: false },
  { port: 631, name: "ipp", secure: false },
  { port: 993, name: "imaps", secure: true },
  { port: 995, name: "pop3s", secure: true },
  { port: 1433, name: "mssql", secure: false },
  { port: 1521, name: "oracle", secure: false },
  { port: 1883, name: "mqtt", secure: false },
  { port: 2375, name: "docker", secure: false },
  { port: 2376, name: "docker-tls", secure: true },
  { port: 3306, name: "mysql", secure: false },
  { port: 3389, name: "rdp", secure: true },
  { port: 5432, name: "postgresql", secure: false },
  { port: 5985, name: "winrm", secure: false },
  { port: 5986, name: "winrm-https", secure: true },
  { port: 6443, name: "kubernetes", secure: true },
  { port: 7443, name: "https-alt", secure: true },
  { port: 8000, name: "http-alt", secure: false },
  { port: 8080, name: "http-proxy", secure: false },
  { port: 8443, name: "https-alt", secure: true },
  { port: 9000, name: "http-admin", secure: false },
  { port: 9100, name: "jetdirect", secure: false },
  { port: 5000, name: "nas-web", secure: false },
  { port: 5001, name: "nas-web-ssl", secure: true },
];

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
  const hostname = hostMatch[2].trim() || undefined;
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
    const version = fields[6]?.trim() || undefined;

    if (!Number.isFinite(port) || state !== "open") {
      continue;
    }

    services.push({
      ...serviceFromNmap(port, transport, service),
      version,
    });
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
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const address of iface) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      if (/^(10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)/.test(address.address)) {
        return address.address;
      }
    }
  }

  const candidates = [
    "ipconfig",
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

const uniqueSubnetsFromIps = (ips: string[]): string[] => {
  return Array.from(new Set(ips.filter(isEligibleIp).map((ip) => toSlash24(ip)))).sort();
};

const sliceWithOffset = <T>(items: T[], offset: number, maxItems: number): T[] => {
  if (items.length <= maxItems) {
    return items;
  }

  const safeOffset = Math.max(0, offset % items.length);
  const first = items.slice(safeOffset, safeOffset + maxItems);
  if (first.length >= maxItems) {
    return first;
  }

  return [...first, ...items.slice(0, maxItems - first.length)];
};

const isEligibleIp = (ip: string): boolean => {
  const octets = ip.split(".").map((value) => Number(value));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }

  const a = octets[0];
  const b = octets[1];
  const d = octets[3];
  if (a === 127 || a >= 224 || a === 0 || d === 255) {
    return false;
  }

  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

const buildHostCandidatesFromLocalSubnet = (localIp: string): string[] => {
  const [a, b, c] = localIp.split(".");
  const ips: string[] = [];
  for (let host = 1; host <= 254; host += 1) {
    const ip = `${a}.${b}.${c}.${host}`;
    if (ip !== localIp) {
      ips.push(ip);
    }
  }
  return ips;
};

const hostsFromSubnet = (subnet: string): string[] => {
  const slash = subnet.indexOf("/");
  const base = slash >= 0 ? subnet.slice(0, slash) : subnet;
  const [a, b, c] = base.split(".").map((value) => Number(value));
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    !Number.isInteger(c) ||
    a < 0 ||
    b < 0 ||
    c < 0 ||
    a > 255 ||
    b > 255 ||
    c > 255
  ) {
    return [];
  }

  const hosts: string[] = [];
  for (let host = 1; host <= 254; host += 1) {
    hosts.push(`${a}.${b}.${c}.${host}`);
  }

  return hosts;
};

const buildHostCandidatesFromSubnets = (subnets: string[]): string[] => {
  const all = subnets.flatMap((subnet) => hostsFromSubnet(subnet));
  return Array.from(new Set(all)).filter(isEligibleIp).sort((a, b) => a.localeCompare(b));
};

const probeTcpPort = (ip: string, port: number, timeoutMs = 450): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.once("close", () => settle(false));
    socket.connect(port, ip);
  });
};

const scanTcpServices = async (ip: string): Promise<ServiceFingerprint[]> => {
  const discovered: ServiceFingerprint[] = [];
  const maxConcurrency = 24;

  for (let idx = 0; idx < COMMON_TCP_SERVICES.length; idx += maxConcurrency) {
    const chunk = COMMON_TCP_SERVICES.slice(idx, idx + maxConcurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (service) => ({ service, open: await probeTcpPort(ip, service.port) })),
    );

    for (const result of chunkResults) {
      if (!result.open) continue;
      discovered.push({
        id: randomUUID(),
        port: result.service.port,
        transport: "tcp",
        name: result.service.name,
        secure: result.service.secure,
        lastSeenAt: new Date().toISOString(),
      });
    }
  }

  return discovered;
};

const reverseLookup = async (ip: string): Promise<string | undefined> => {
  try {
    const names = await dns.reverse(ip);
    const first = names.find((value) => value.trim().length > 0);
    return first;
  } catch {
    return undefined;
  }
};

const pingSweep = async (ips: string[]): Promise<DiscoveryCandidate[]> => {
  const pingCommand = process.platform === "win32"
    ? (ip: string) => `ping -n 1 -w 1000 ${ip}`
    : (ip: string) => `ping -c 1 -W 1 ${ip}`;

  const results: Array<DiscoveryCandidate | undefined> = await Promise.all(
    ips.map(async (ip) => {
      const ping = await runShell(pingCommand(ip), 2_500);
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
  options: ActiveDiscoveryOptions = {},
): Promise<DiscoveryCandidate[]> => {
  const targetOffset = options.targetOffset ?? 0;
  const deepScan = options.deepScan ?? false;
  const maxTargets = options.maxTargets ?? (deepScan ? 256 : 32);
  const maxPortScanHosts = options.maxPortScanHosts ?? (deepScan ? 96 : 16);
  const maxNmapSubnets = deepScan ? 8 : 2;

  const hasNmap = await runShell(process.platform === "win32" ? "where nmap" : "command -v nmap", 1_500);

  const localIp = await tryGetLocalIp();
  const nmapSubnets = uniqueSubnetsFromIps([
    ...seedIps,
    ...(localIp ? [localIp] : []),
  ]).slice(0, maxNmapSubnets);

  if (deepScan && hasNmap.ok && hasNmap.stdout && nmapSubnets.length > 0) {
    const targetArgs = nmapSubnets.join(" ");
    const scan = await runShell(`nmap -sS -sV --version-light -Pn -T4 -F ${targetArgs} -oG -`, 120_000);

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

  const deduped = Array.from(new Set(seedIps.filter(isEligibleIp))).sort();
  let targets = sliceWithOffset(deduped, targetOffset, maxTargets);

  if (targets.length === 0) {
    if (!localIp) {
      return [];
    }

    targets = sliceWithOffset(buildHostCandidatesFromLocalSubnet(localIp), targetOffset, maxTargets);
  }

  if (targets.length < maxTargets) {
    const fallbackSubnets = uniqueSubnetsFromIps([
      ...seedIps,
      ...targets,
      ...(localIp ? [localIp] : []),
    ]);
    const fallbackHosts = buildHostCandidatesFromSubnets(fallbackSubnets).filter((ip) => !targets.includes(ip));
    if (fallbackHosts.length > 0) {
      const needed = maxTargets - targets.length;
      targets = [...targets, ...sliceWithOffset(fallbackHosts, targetOffset, needed)];
    }
  }

  const pingCandidates = await pingSweep(targets);
  const ipsToPortScan = sliceWithOffset(
    Array.from(new Set([...targets, ...pingCandidates.map((candidate) => candidate.ip)])),
    targetOffset,
    maxPortScanHosts,
  );

  const enriched = await Promise.all(
    ipsToPortScan.map(async (ip) => {
      const [services, hostname] = await Promise.all([
        scanTcpServices(ip),
        reverseLookup(ip),
      ]);

      return {
        ip,
        hostname,
        services,
        source: "active" as const,
        metadata: {
          scanner: "tcp-connect",
          deepScan,
        },
      };
    }),
  );

  return [...pingCandidates, ...enriched];
};
