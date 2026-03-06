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
