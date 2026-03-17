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

export const ipv4ToInt = (value: string): number | null => {
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
};

const intToIpv4 = (value: number): string => {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
};

export const prefixLengthFromNetmask = (netmask?: string): number | null => {
  const mask = ipv4ToInt(netmask ?? "255.255.255.0");
  if (mask === null) {
    return null;
  }
  let bits = 0;
  let seenZero = false;
  for (let idx = 31; idx >= 0; idx -= 1) {
    const bit = (mask >>> idx) & 1;
    if (bit === 1) {
      if (seenZero) {
        return null;
      }
      bits += 1;
    } else {
      seenZero = true;
    }
  }
  return bits;
};

export const sameSubnet = (leftIp: string, rightIp: string, netmask?: string): boolean => {
  const left = ipv4ToInt(leftIp);
  const right = ipv4ToInt(rightIp);
  const mask = ipv4ToInt(netmask ?? "255.255.255.0");
  if (left === null || right === null || mask === null) {
    return false;
  }
  return (left & mask) === (right & mask);
};

export const subnetCidrForIp = (ip: string, netmask?: string): string | null => {
  const ipInt = ipv4ToInt(ip);
  const maskInt = ipv4ToInt(netmask ?? "255.255.255.0");
  const prefixLength = prefixLengthFromNetmask(netmask);
  if (ipInt === null || maskInt === null || prefixLength === null) {
    return null;
  }
  const network = (ipInt & maskInt) >>> 0;
  return `${intToIpv4(network)}/${prefixLength}`;
};

export const hostsForSubnet = (cidr: string): string[] => {
  const [base, prefixRaw] = cidr.split("/");
  const baseInt = ipv4ToInt(base);
  const prefixLength = Number.parseInt(prefixRaw ?? "", 10);
  if (
    baseInt === null
    || !Number.isInteger(prefixLength)
    || prefixLength < 0
    || prefixLength > 32
  ) {
    return [];
  }

  if (prefixLength >= 31) {
    return [];
  }

  const hostBits = 32 - prefixLength;
  const networkSize = 2 ** hostBits;
  const network = (baseInt >>> 0);
  const firstHost = network + 1;
  const lastHost = network + networkSize - 2;
  const hosts: string[] = [];

  for (let current = firstHost; current <= lastHost; current += 1) {
    hosts.push(intToIpv4(current >>> 0));
  }

  return hosts;
};

export const sameSubnetUsingInterfaces = (
  leftIp: string,
  rightIp: string,
  interfaces: LocalIpv4Interface[] = getLocalIpv4Interfaces(),
): boolean => {
  let matchedKnownSubnet = false;
  for (const entry of interfaces) {
    const leftInSubnet = sameSubnet(leftIp, entry.ip, entry.netmask);
    const rightInSubnet = sameSubnet(rightIp, entry.ip, entry.netmask);
    if (leftInSubnet || rightInSubnet) {
      matchedKnownSubnet = true;
    }
    if (leftInSubnet && rightInSubnet) {
      return true;
    }
  }
  return matchedKnownSubnet ? false : sameSubnet(leftIp, rightIp);
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
