import os from "node:os";

const VIRTUAL_IFACE_HINTS = ["virtual", "veth", "docker", "wsl", "hyper-v", "vmware", "loopback"];
const ZERO_MAC = "00:00:00:00:00:00";

const scoreInterfaceName = (name: string): number => {
  const lower = name.toLowerCase();
  return VIRTUAL_IFACE_HINTS.some((hint) => lower.includes(hint)) ? 1 : 0;
};

const isPrivateIpv4 = (ip: string): boolean =>
  /^(10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)/.test(ip);

export const normalizeMac = (raw: string | null | undefined): string | undefined => {
  if (!raw) {
    return undefined;
  }

  const compact = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (compact.length !== 12) {
    return undefined;
  }

  const normalized = compact.match(/.{2}/g)?.join(":");
  if (!normalized || normalized === ZERO_MAC) {
    return undefined;
  }

  return normalized;
};

export interface LocalInterfaceIdentity {
  ips: string[];
  ipSet: Set<string>;
  macSet: Set<string>;
}

export interface LocalIpv4Interface {
  name: string;
  ip: string;
  netmask?: string;
  virtual: boolean;
}

const ipv4ToInt = (value: string): number | null => {
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
};

const sameSubnet = (leftIp: string, rightIp: string, netmask?: string): boolean => {
  const left = ipv4ToInt(leftIp);
  const right = ipv4ToInt(rightIp);
  const mask = ipv4ToInt(netmask ?? "255.255.255.0");
  if (left === null || right === null || mask === null) {
    return false;
  }
  return (left & mask) === (right & mask);
};

export const getLocalInterfaceIdentity = (): LocalInterfaceIdentity => {
  const interfaces = os.networkInterfaces();
  const ipsWithScore: Array<{ ip: string; score: number }> = [];
  const macSet = new Set<string>();

  for (const [name, iface] of Object.entries(interfaces)) {
    if (!iface) {
      continue;
    }
    const score = scoreInterfaceName(name);

    for (const address of iface) {
      const mac = normalizeMac(address.mac);
      if (mac) {
        macSet.add(mac);
      }

      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      if (!isPrivateIpv4(address.address)) {
        continue;
      }

      ipsWithScore.push({
        ip: address.address,
        score,
      });
    }
  }

  const ips = Array.from(
    new Set(
      ipsWithScore
        .sort((a, b) => a.score - b.score || a.ip.localeCompare(b.ip))
        .map((item) => item.ip),
    ),
  );

  return {
    ips,
    ipSet: new Set(ips),
    macSet,
  };
};

export const getLocalIpv4Interfaces = (): LocalIpv4Interface[] => {
  const interfaces = os.networkInterfaces();
  const candidates: LocalIpv4Interface[] = [];

  for (const [name, iface] of Object.entries(interfaces)) {
    if (!iface) {
      continue;
    }
    const virtual = scoreInterfaceName(name) > 0;
    for (const address of iface) {
      if (address.family !== "IPv4" || address.internal || !isPrivateIpv4(address.address)) {
        continue;
      }
      candidates.push({
        name,
        ip: address.address,
        netmask: address.netmask,
        virtual,
      });
    }
  }

  return candidates.sort((a, b) => {
    const scoreDelta = Number(a.virtual) - Number(b.virtual);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    if (a.name !== b.name) {
      return a.name.localeCompare(b.name);
    }
    return a.ip.localeCompare(b.ip);
  });
};

export function getStewardHostNetworkSummary(targetIp?: string): {
  interfaces: LocalIpv4Interface[];
  summary: string;
  sameSubnet: boolean;
} {
  const interfaces = getLocalIpv4Interfaces();
  const sameSubnetMatch = Boolean(
    targetIp && interfaces.some((entry) => sameSubnet(entry.ip, targetIp, entry.netmask)),
  );
  if (interfaces.length === 0) {
    return {
      interfaces,
      sameSubnet: false,
      summary: "Steward host private IPv4 interfaces: unavailable.",
    };
  }
  const rendered = interfaces
    .map((entry) => `${entry.name}=${entry.ip}${entry.netmask ? `/${entry.netmask}` : ""}${entry.virtual ? " (virtual)" : ""}`)
    .join(", ");
  const suffix = targetIp
    ? ` Same subnet as ${targetIp}: ${sameSubnetMatch ? "yes" : "no"}.`
    : "";
  return {
    interfaces,
    sameSubnet: sameSubnetMatch,
    summary: `Steward host private IPv4 interfaces: ${rendered}.${suffix}`,
  };
}
