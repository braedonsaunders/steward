import { buildObservation, dedupeObservations } from "@/lib/discovery/evidence";
import { runShell } from "@/lib/utils/shell";
import type { DiscoveryObservationInput } from "@/lib/state/types";

interface HostTrafficProfile {
  ip: string;
  packets: number;
  txPackets: number;
  rxPackets: number;
  protocols: Map<string, number>;
  peers: Map<string, number>;
  dnsNames: Set<string>;
  tlsSni: Set<string>;
  httpHosts: Set<string>;
  dhcpHostnames: Set<string>;
}

export interface PacketIntelHost {
  ip: string;
  hostnameHint?: string;
  observations: DiscoveryObservationInput[];
  metadata: {
    packets: number;
    txPackets: number;
    rxPackets: number;
    topProtocols: Array<{ protocol: string; packets: number }>;
    topPeers: Array<{ ip: string; packets: number }>;
    dnsNames: string[];
    tlsSni: string[];
    httpHosts: string[];
    dhcpHostnames: string[];
  };
}

export interface PacketIntelSnapshot {
  hosts: PacketIntelHost[];
  topTalkers: Array<{ ip: string; packets: number }>;
  collectedAt: string;
  collector: "tshark";
}

export interface PacketIntelOptions {
  durationSec?: number;
  maxPackets?: number;
  topTalkers?: number;
  timeoutMs?: number;
}

const TSHARK_FIELDS = [
  "ip.src",
  "ip.dst",
  "_ws.col.Protocol",
  "dns.qry.name",
  "dns.resp.name",
  "tls.handshake.extensions_server_name",
  "http.host",
  "dhcp.option.hostname",
];

const isPrivateIp = (ip: string): boolean => {
  const octets = ip.split(".").map((value) => Number(value));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }

  const [a, b, , d] = octets;
  if (d === 255 || a === 127 || a >= 224 || a === 0) {
    return false;
  }

  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

const sanitizeText = (value: string | undefined, max = 120): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, max);
};

const topEntries = (
  map: Map<string, number>,
  limit: number,
  key: "protocol" | "ip",
): Array<{ protocol: string; packets: number } | { ip: string; packets: number }> =>
  Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, packets]) => (key === "protocol" ? { protocol: label, packets } : { ip: label, packets }));

const hasTsharkInstalled = async (): Promise<boolean> => {
  const probe = await runShell(process.platform === "win32" ? "where tshark" : "command -v tshark", 1_500);
  return probe.ok && probe.stdout.trim().length > 0;
};

const buildTsharkCommand = (durationSec: number, maxPackets: number): string => {
  const fieldArgs = TSHARK_FIELDS.map((field) => `-e ${field}`).join(" ");
  return [
    "tshark",
    "-l",
    "-n",
    "-Q",
    "-a", `duration:${durationSec}`,
    "-c", String(maxPackets),
    "-T", "fields",
    fieldArgs,
    "-E", "separator=\t",
    "-E", "header=n",
    "-E", "quote=n",
  ].join(" ");
};

const ensureProfile = (profiles: Map<string, HostTrafficProfile>, ip: string): HostTrafficProfile => {
  const existing = profiles.get(ip);
  if (existing) {
    return existing;
  }
  const created: HostTrafficProfile = {
    ip,
    packets: 0,
    txPackets: 0,
    rxPackets: 0,
    protocols: new Map(),
    peers: new Map(),
    dnsNames: new Set(),
    tlsSni: new Set(),
    httpHosts: new Set(),
    dhcpHostnames: new Set(),
  };
  profiles.set(ip, created);
  return created;
};

const increment = (map: Map<string, number>, key: string): void => {
  if (!key) {
    return;
  }
  map.set(key, (map.get(key) ?? 0) + 1);
};

const parseTsharkLine = (
  line: string,
  profiles: Map<string, HostTrafficProfile>,
): void => {
  const [srcRaw, dstRaw, protoRaw, dnsQueryRaw, dnsRespRaw, sniRaw, httpHostRaw, dhcpHostnameRaw] = line.split("\t");
  const src = sanitizeText(srcRaw, 64);
  const dst = sanitizeText(dstRaw, 64);
  const protocol = sanitizeText(protoRaw, 64) ?? "unknown";
  const dnsQuery = sanitizeText(dnsQueryRaw, 180);
  const dnsResp = sanitizeText(dnsRespRaw, 180);
  const sni = sanitizeText(sniRaw, 180);
  const httpHost = sanitizeText(httpHostRaw, 180);
  const dhcpHostname = sanitizeText(dhcpHostnameRaw, 120);

  if (!src || !dst || !isPrivateIp(src) || !isPrivateIp(dst)) {
    return;
  }

  const srcProfile = ensureProfile(profiles, src);
  const dstProfile = ensureProfile(profiles, dst);

  srcProfile.packets += 1;
  dstProfile.packets += 1;
  srcProfile.txPackets += 1;
  dstProfile.rxPackets += 1;
  increment(srcProfile.protocols, protocol);
  increment(dstProfile.protocols, protocol);
  increment(srcProfile.peers, dst);
  increment(dstProfile.peers, src);

  if (dnsQuery) {
    srcProfile.dnsNames.add(dnsQuery);
  }
  if (dnsResp) {
    dstProfile.dnsNames.add(dnsResp);
  }
  if (sni) {
    srcProfile.tlsSni.add(sni);
  }
  if (httpHost) {
    srcProfile.httpHosts.add(httpHost);
  }
  if (dhcpHostname) {
    srcProfile.dhcpHostnames.add(dhcpHostname);
  }
};

export async function collectPacketIntelSnapshot(
  options: PacketIntelOptions = {},
): Promise<PacketIntelSnapshot | null> {
  const tsharkInstalled = await hasTsharkInstalled();
  if (!tsharkInstalled) {
    return null;
  }

  const durationSec = Math.max(1, Math.min(60, Math.floor(options.durationSec ?? 5)));
  const maxPackets = Math.max(100, Math.min(50_000, Math.floor(options.maxPackets ?? 2_500)));
  const topTalkers = Math.max(1, Math.min(100, Math.floor(options.topTalkers ?? 12)));
  const timeoutMs = Math.max(3_000, Math.min(120_000, Math.floor(options.timeoutMs ?? (durationSec + 3) * 1_000)));

  const command = buildTsharkCommand(durationSec, maxPackets);
  const probe = await runShell(command, timeoutMs);
  if (!probe.ok && !probe.stdout) {
    return null;
  }

  const profiles = new Map<string, HostTrafficProfile>();
  for (const line of probe.stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    parseTsharkLine(line, profiles);
  }

  const collectedAt = new Date().toISOString();
  const hostProfiles = Array.from(profiles.values());
  const hosts: PacketIntelHost[] = hostProfiles.map((profile) => {
    const topProtocols = topEntries(profile.protocols, 8, "protocol") as Array<{ protocol: string; packets: number }>;
    const topPeers = topEntries(profile.peers, 6, "ip") as Array<{ ip: string; packets: number }>;
    const dnsNames = Array.from(profile.dnsNames).slice(0, 12);
    const tlsSni = Array.from(profile.tlsSni).slice(0, 12);
    const httpHosts = Array.from(profile.httpHosts).slice(0, 12);
    const dhcpHostnames = Array.from(profile.dhcpHostnames).slice(0, 6);
    const hostnameHint = dhcpHostnames[0];

    const observations: DiscoveryObservationInput[] = [
      buildObservation({
        ip: profile.ip,
        source: "passive",
        evidenceType: "packet_traffic_profile",
        confidence: 0.72,
        observedAt: collectedAt,
        ttlMs: 15 * 60_000,
        details: {
          packets: profile.packets,
          txPackets: profile.txPackets,
          rxPackets: profile.rxPackets,
          topProtocols,
          topPeers,
          dnsNames,
          tlsSni,
          httpHosts,
          collector: "tshark",
        },
      }),
    ];

    if (dhcpHostnames.length > 0) {
      observations.push(buildObservation({
        ip: profile.ip,
        source: "passive",
        evidenceType: "dhcp_lease",
        confidence: 0.86,
        observedAt: collectedAt,
        ttlMs: 12 * 60 * 60_000,
        details: {
          hostname: dhcpHostnames[0],
          hostnames: dhcpHostnames,
          collector: "tshark",
        },
      }));
    }

    return {
      ip: profile.ip,
      hostnameHint,
      observations: dedupeObservations(observations),
      metadata: {
        packets: profile.packets,
        txPackets: profile.txPackets,
        rxPackets: profile.rxPackets,
        topProtocols,
        topPeers,
        dnsNames,
        tlsSni,
        httpHosts,
        dhcpHostnames,
      },
    };
  });

  const topTalkersList = hostProfiles
    .map((profile) => ({ ip: profile.ip, packets: profile.packets }))
    .sort((a, b) => b.packets - a.packets)
    .slice(0, topTalkers);

  return {
    hosts,
    topTalkers: topTalkersList,
    collectedAt,
    collector: "tshark",
  };
}
