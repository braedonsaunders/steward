import { randomUUID } from "node:crypto";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { Device, DeviceType } from "@/lib/state/types";

const inferTypeFromPorts = (ports: number[]): DeviceType => {
  if (ports.includes(9100) || ports.includes(631)) {
    return "printer";
  }

  if (ports.includes(5000) || ports.includes(5001) || ports.includes(2049)) {
    return "nas";
  }

  if (ports.includes(6443)) {
    return "hypervisor";
  }

  if (ports.includes(2375) || ports.includes(2376)) {
    return "container-host";
  }

  if (ports.includes(161) || ports.includes(162)) {
    return "switch";
  }

  if (ports.includes(80) || ports.includes(443) || ports.includes(22) || ports.includes(3389)) {
    return "server";
  }

  return "unknown";
};

const inferProtocols = (ports: number[]): string[] => {
  const protocols = new Set<string>();

  if (ports.includes(22)) protocols.add("ssh");
  if (ports.includes(3389) || ports.includes(5985) || ports.includes(5986)) protocols.add("winrm");
  if (ports.includes(161)) protocols.add("snmp");
  if (ports.includes(443) || ports.includes(80)) protocols.add("http-api");
  if (ports.includes(2375) || ports.includes(2376)) protocols.add("docker");
  if (ports.includes(6443)) protocols.add("kubernetes");
  if (ports.includes(1883)) protocols.add("mqtt");

  return Array.from(protocols);
};

export const mergeDiscoveryCandidates = (
  candidates: DiscoveryCandidate[],
): DiscoveryCandidate[] => {
  const byIp = new Map<string, DiscoveryCandidate>();

  for (const candidate of candidates) {
    const existing = byIp.get(candidate.ip);
    if (!existing) {
      byIp.set(candidate.ip, candidate);
      continue;
    }

    byIp.set(candidate.ip, {
      ...existing,
      mac: existing.mac ?? candidate.mac,
      hostname: existing.hostname ?? candidate.hostname,
      vendor: existing.vendor ?? candidate.vendor,
      os: existing.os ?? candidate.os,
      services: [...existing.services, ...candidate.services],
      metadata: {
        ...existing.metadata,
        ...candidate.metadata,
      },
      source: candidate.source,
    });
  }

  return Array.from(byIp.values()).map((candidate) => {
    const serviceByKey = new Map<string, (typeof candidate.services)[number]>();

    for (const service of candidate.services) {
      const key = `${service.transport}:${service.port}`;
      serviceByKey.set(key, service);
    }

    return {
      ...candidate,
      services: Array.from(serviceByKey.values()).sort((a, b) => a.port - b.port),
    };
  });
};

export const candidateToDevice = (
  candidate: DiscoveryCandidate,
  previous?: Device,
): Device => {
  const now = new Date().toISOString();
  const ports = candidate.services.map((service) => service.port);
  const type = candidate.typeHint ?? inferTypeFromPorts(ports);
  const protocols = inferProtocols(ports);

  return {
    id: previous?.id ?? randomUUID(),
    name:
      previous?.name ??
      candidate.hostname ??
      `${type}-${candidate.ip.replaceAll(".", "-")}`,
    ip: candidate.ip,
    mac: candidate.mac ?? previous?.mac,
    hostname: candidate.hostname ?? previous?.hostname,
    vendor: candidate.vendor ?? previous?.vendor,
    os: candidate.os ?? previous?.os,
    role: previous?.role,
    type,
    status: "online",
    autonomyTier: previous?.autonomyTier ?? 1,
    tags: previous?.tags ?? [],
    protocols: Array.from(new Set([...(previous?.protocols ?? []), ...protocols])),
    services:
      candidate.services.length > 0
        ? candidate.services
        : (previous?.services ?? []).map((service) => ({
            ...service,
            lastSeenAt: now,
          })),
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastChangedAt: now,
    metadata: {
      ...previous?.metadata,
      ...candidate.metadata,
      source: candidate.source,
    },
  };
};
