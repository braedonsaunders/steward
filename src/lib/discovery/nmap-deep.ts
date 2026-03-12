import { randomUUID } from "node:crypto";
import { buildObservation } from "@/lib/discovery/evidence";
import { runShell } from "@/lib/utils/shell";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { DiscoveryObservationInput, ServiceFingerprint } from "@/lib/state/types";

interface NmapScriptFinding {
  port: number;
  id: string;
  output: string;
}

export interface NmapDeepResult {
  ip: string;
  services: ServiceFingerprint[];
  observations: DiscoveryObservationInput[];
  metadata: {
    command: string;
    scripts: NmapScriptFinding[];
    collectedAt: string;
  };
}

export interface NmapDeepOptions {
  timeoutMs?: number;
  maxConcurrency?: number;
}

const FALLBACK_PORTS = [80, 443, 554, 8080, 8443, 5000, 5001, 22, 161, 1883, 2375, 3389];
const NMAP_SCRIPT_SET = "banner,http-title,http-headers,ssl-cert,upnp-info";

const decodeXmlEntities = (raw: string): string => raw
  .replace(/&quot;/g, "\"")
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

const parsePortAttributes = (rawTag: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(rawTag)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
};

const serviceFromPortBlock = (
  block: string,
  existing: ServiceFingerprint | undefined,
  observedAt: string,
): ServiceFingerprint | null => {
  const portTagMatch = block.match(/<port\s+[^>]*>/);
  if (!portTagMatch) {
    return null;
  }
  const portAttrs = parsePortAttributes(portTagMatch[0]);
  const port = Number(portAttrs.portid);
  const transport = (portAttrs.protocol ?? "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    return null;
  }

  const isOpen = /<state\s+[^>]*state="open"/i.test(block);
  if (!isOpen) {
    return null;
  }

  const serviceTagMatch = block.match(/<service\s+[^>]*>/i);
  const serviceAttrs = serviceTagMatch ? parsePortAttributes(serviceTagMatch[0]) : {};
  const name = serviceAttrs.name?.trim() || existing?.name || "unknown";
  const secure = existing?.secure
    || /https|ssl|tls|ssh|imaps|ldaps/i.test(name)
    || Boolean(serviceAttrs.tunnel && /ssl|tls/i.test(serviceAttrs.tunnel));

  const versionParts = [serviceAttrs.version, serviceAttrs.extrainfo]
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .join(" ")
    .trim();

  return {
    id: existing?.id ?? randomUUID(),
    port,
    transport,
    name,
    secure,
    product: serviceAttrs.product?.trim() || existing?.product,
    version: versionParts || existing?.version,
    banner: existing?.banner,
    httpInfo: existing?.httpInfo,
    tlsCert: existing?.tlsCert,
    lastSeenAt: observedAt,
  };
};

const scriptFindingsFromBlock = (block: string, port: number): NmapScriptFinding[] => {
  const findings: NmapScriptFinding[] = [];
  const scriptRegex = /<script\s+([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(block)) !== null) {
    const attrs = parsePortAttributes(match[1]);
    const id = attrs.id?.trim();
    const output = attrs.output?.trim();
    if (!id || !output) {
      continue;
    }
    findings.push({
      port,
      id,
      output: output.slice(0, 2_000),
    });
  }
  return findings;
};

const buildPortList = (candidate: DiscoveryCandidate): string => {
  const preferred = candidate.services
    .filter((service) => service.transport === "tcp")
    .map((service) => service.port)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  const unique = Array.from(new Set([...preferred, ...FALLBACK_PORTS]));
  return unique.slice(0, 24).join(",");
};

const hasNmapInstalled = async (): Promise<boolean> => {
  const probe = await runShell(process.platform === "win32" ? "where nmap" : "command -v nmap", 1_500);
  return probe.ok && probe.stdout.trim().length > 0;
};

const deepScanCandidate = async (
  candidate: DiscoveryCandidate,
  timeoutMs: number,
): Promise<NmapDeepResult | null> => {
  const ports = buildPortList(candidate);
  if (!ports) {
    return null;
  }

  const command = `nmap -Pn -n --open -sV --version-light --script "${NMAP_SCRIPT_SET}" -p ${ports} ${candidate.ip} -oX -`;
  const scan = await runShell(command, timeoutMs);
  if (!scan.stdout) {
    return null;
  }

  const observedAt = new Date().toISOString();
  const serviceByPort = new Map(candidate.services.map((service) => [service.port, service]));
  const serviceResults: ServiceFingerprint[] = [];
  const findings: NmapScriptFinding[] = [];

  const portBlockRegex = /<port\s+[^>]*portid="(\d+)"[\s\S]*?<\/port>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = portBlockRegex.exec(scan.stdout)) !== null) {
    const block = blockMatch[0];
    const port = Number(blockMatch[1]);
    const existing = serviceByPort.get(port);
    const nextService = serviceFromPortBlock(block, existing, observedAt);
    if (nextService) {
      serviceResults.push(nextService);
    }
    findings.push(...scriptFindingsFromBlock(block, port));
  }

  const observations: DiscoveryObservationInput[] = findings.map((finding) =>
    buildObservation({
      ip: candidate.ip,
      source: "fingerprint",
      evidenceType: "nmap_script",
      confidence: 0.82,
      observedAt,
      ttlMs: 6 * 60 * 60_000,
      details: {
        port: finding.port,
        scriptId: finding.id,
        output: finding.output,
        scanner: "nmap",
      },
    }));

  const httpTitleFinding = findings.find((finding) => finding.id === "http-title");
  if (httpTitleFinding) {
    observations.push(buildObservation({
      ip: candidate.ip,
      source: "fingerprint",
      evidenceType: "http_banner",
      confidence: 0.8,
      observedAt,
      ttlMs: 90 * 60_000,
      details: {
        port: httpTitleFinding.port,
        title: httpTitleFinding.output,
        scanner: "nmap",
      },
    }));
  }

  if (serviceResults.length === 0 && observations.length === 0) {
    return null;
  }

  return {
    ip: candidate.ip,
    services: serviceResults,
    observations,
    metadata: {
      command,
      scripts: findings,
      collectedAt: observedAt,
    },
  };
};

export async function runNmapDeepFingerprint(
  candidates: DiscoveryCandidate[],
  options: NmapDeepOptions = {},
): Promise<NmapDeepResult[]> {
  if (candidates.length === 0) {
    return [];
  }

  const nmapAvailable = await hasNmapInstalled();
  if (!nmapAvailable) {
    return [];
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxConcurrency = Math.max(1, Math.min(8, options.maxConcurrency ?? 3));
  const results: NmapDeepResult[] = [];

  for (let idx = 0; idx < candidates.length; idx += maxConcurrency) {
    const batch = candidates.slice(idx, idx + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(async (candidate) => deepScanCandidate(candidate, timeoutMs)),
    );
    for (const item of batchResults) {
      if (item) {
        results.push(item);
      }
    }
  }

  return results;
}
