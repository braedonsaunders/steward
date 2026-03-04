import { collectActiveCandidates } from "@/lib/discovery/active";
import { mergeDiscoveryCandidates } from "@/lib/discovery/classify";
import { collectPassiveCandidates } from "@/lib/discovery/passive";
import { fingerprintBatch, applyFingerprintResults } from "@/lib/discovery/fingerprint";
import { discoverMulticast } from "@/lib/discovery/multicast";
import { updateOuiDatabase } from "@/lib/discovery/oui";
import dns from "node:dns/promises";
import { pluginRegistry } from "@/lib/plugins/registry";
import { stateStore } from "@/lib/state/store";
import { runShell } from "@/lib/utils/shell";
import type { DiscoveryCandidate, DiscoverySnapshot } from "@/lib/discovery/types";

interface DiscoveryRunOptions {
  forceDeepScan?: boolean;
}

const isEligibleManagedIp = (ip: string): boolean => {
  const octets = ip.split(".").map((value) => Number(value));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }

  const [a, b, , d] = octets;
  if (a === 0 || a === 127 || a >= 224 || d === 255) {
    return false;
  }

  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

let lastDeepScanAt = 0;
let activeTargetCursor = 0;
let hostnameCursor = 0;
let fingerprintCursor = 0;
let lastOuiUpdateAt = 0;

const reverseHostname = async (ip: string): Promise<string | undefined> => {
  try {
    const names = await dns.reverse(ip);
    const resolved = names.find((value) => value.trim().length > 0);
    if (resolved) {
      return resolved;
    }
  } catch {
    // best-effort fallback below
  }

  if (process.platform === "win32") {
    const nbt = await runShell(`nbtstat -A ${ip}`, 2_000);
    if (nbt.stdout) {
      const nbtMatch = nbt.stdout.match(/^\s*([^\s<]+)\s+<00>\s+UNIQUE\s+Registered/im);
      if (nbtMatch?.[1]) {
        return nbtMatch[1].trim();
      }
    }
  }

  const nslookup = await runShell(`nslookup ${ip}`, 2_000);
  if (nslookup.stdout) {
    const directMatch = nslookup.stdout.match(/name\s*=\s*([^\s]+)/i);
    if (directMatch?.[1]) {
      return directMatch[1].trim();
    }
  }

  return undefined;
};

const enrichHostnames = async (
  candidates: DiscoverySnapshot["merged"],
  deepScan: boolean,
): Promise<DiscoverySnapshot["merged"]> => {
  const unresolved = candidates.filter((candidate) => !candidate.hostname).sort((a, b) => a.ip.localeCompare(b.ip));
  const maxChecks = deepScan ? 768 : 192;

  if (unresolved.length === 0) {
    return candidates;
  }

  const offset = hostnameCursor % unresolved.length;
  const selected = unresolved.slice(offset, offset + maxChecks);
  if (selected.length < maxChecks) {
    selected.push(...unresolved.slice(0, maxChecks - selected.length));
  }
  hostnameCursor = (hostnameCursor + maxChecks) % Math.max(1, unresolved.length);

  const resolved = await Promise.all(
    selected.map(async (candidate) => ({
      ip: candidate.ip,
      hostname: await reverseHostname(candidate.ip),
    })),
  );
  const byIp = new Map(resolved.filter((item) => item.hostname).map((item) => [item.ip, item.hostname as string]));

  return candidates.map((candidate) => {
    if (candidate.hostname) {
      return candidate;
    }
    const hostname = byIp.get(candidate.ip);
    if (!hostname) {
      return candidate;
    }
    return {
      ...candidate,
      hostname,
      metadata: {
        ...candidate.metadata,
        hostnameSource: "reverse-dns",
      },
    };
  });
};

/* ---------- Fingerprint Target Selection ---------- */

const selectFingerprintTargets = (
  candidates: DiscoveryCandidate[],
  deepScan: boolean,
  maxTargets: number,
): DiscoveryCandidate[] => {
  // Only fingerprint candidates with at least one open service port
  const eligible = candidates.filter((c) => {
    if (c.services.length === 0) return false;

    // Check cooldown: skip if recently fingerprinted
    const fp = c.metadata.fingerprint as Record<string, unknown> | undefined;
    if (fp?.lastFingerprintedAt) {
      const ageMs = Date.now() - new Date(fp.lastFingerprintedAt as string).getTime();
      // Shorter cooldown for unknown/low-confidence devices
      const isUnknown = !c.typeHint || c.typeHint === "unknown";
      const cooldown = isUnknown ? 10 * 60_000 : 60 * 60_000;
      if (ageMs < cooldown) return false;
    }

    return true;
  });

  // Prioritize: unknown-type devices first, then by number of services (more = more interesting)
  eligible.sort((a, b) => {
    const aUnknown = !a.typeHint || a.typeHint === "unknown" ? 0 : 1;
    const bUnknown = !b.typeHint || b.typeHint === "unknown" ? 0 : 1;
    if (aUnknown !== bUnknown) return aUnknown - bUnknown;
    return b.services.length - a.services.length;
  });

  if (eligible.length <= maxTargets) return eligible;

  const offset = fingerprintCursor % eligible.length;
  const selected = eligible.slice(offset, offset + maxTargets);
  if (selected.length < maxTargets) {
    selected.push(...eligible.slice(0, maxTargets - selected.length));
  }
  fingerprintCursor = (fingerprintCursor + maxTargets) % Math.max(1, eligible.length);

  return selected;
};

/* ---------- Main Discovery Pipeline ---------- */

export const runDiscovery = async (options: DiscoveryRunOptions = {}): Promise<DiscoverySnapshot> => {
  const settings = stateStore.getRuntimeSettings();

  const now = Date.now();
  const deepScan =
    options.forceDeepScan === true ||
    lastDeepScanAt === 0 ||
    now - lastDeepScanAt >= settings.deepScanIntervalMs;

  // Background OUI database update during deep scans
  if (deepScan && (lastOuiUpdateAt === 0 || now - lastOuiUpdateAt >= settings.ouiUpdateIntervalMs)) {
    lastOuiUpdateAt = now;
    updateOuiDatabase().catch((err) => console.error("[discovery] OUI update failed:", err));
  }

  /* ── Phase 1: Network Presence ────────────────────────────────────── */

  const passiveRaw = await collectPassiveCandidates();
  const passive = passiveRaw.filter((candidate) => isEligibleManagedIp(candidate.ip));

  // Multicast discovery (mDNS + SSDP)
  let multicastCandidates: DiscoveryCandidate[] = [];
  if (settings.enableMdnsDiscovery || settings.enableSsdpDiscovery) {
    try {
      const multicastRaw = await discoverMulticast(deepScan ? 8_000 : 3_000, {
        enableMdns: settings.enableMdnsDiscovery,
        enableSsdp: settings.enableSsdpDiscovery,
      });
      multicastCandidates = multicastRaw.filter((c) => isEligibleManagedIp(c.ip));
    } catch (err) {
      console.error("[discovery] Multicast discovery failed:", err);
    }
  }

  /* ── Phase 2: Port Scan ───────────────────────────────────────────── */

  const seedIps = [...passive, ...multicastCandidates].map((c) => c.ip);
  const activeRaw = await collectActiveCandidates(seedIps, {
    deepScan,
    targetOffset: activeTargetCursor,
    maxTargets: deepScan ? settings.deepActiveTargets : settings.incrementalActiveTargets,
    maxPortScanHosts: deepScan ? settings.deepPortScanHosts : settings.incrementalPortScanHosts,
  });
  const active = activeRaw.filter((candidate) => isEligibleManagedIp(candidate.ip));

  if (deepScan) {
    lastDeepScanAt = now;
  }

  const span = Math.max(1, deepScan ? settings.deepActiveTargets : settings.incrementalActiveTargets);
  activeTargetCursor = (activeTargetCursor + span) % 1024;

  // Plugin discovery sources
  const knownIps = [...new Set([...passive.map((c) => c.ip), ...multicastCandidates.map((c) => c.ip), ...active.map((c) => c.ip)])];
  const pluginCandidatesRaw = await pluginRegistry.runPluginDiscovery(knownIps);
  const pluginCandidates = pluginCandidatesRaw.filter((candidate) => isEligibleManagedIp(candidate.ip));

  /* ── Phase 3+4: Merge, Fingerprint, Enrich ────────────────────────── */

  const allCandidates = [...passive, ...multicastCandidates, ...active, ...pluginCandidates];
  let merged = mergeDiscoveryCandidates(allCandidates);

  // Service fingerprinting (incremental batch)
  const maxFpTargets = deepScan ? settings.deepFingerprintTargets : settings.incrementalFingerprintTargets;
  const fpTargets = selectFingerprintTargets(merged, deepScan, maxFpTargets);
  if (fpTargets.length > 0) {
    try {
      const fpResults = await fingerprintBatch(fpTargets, {
        maxConcurrency: deepScan ? 8 : 3,
        timeoutMs: 3_000,
        enableSnmp: settings.enableSnmpProbe,
      });
      merged = applyFingerprintResults(merged, fpResults);
    } catch (err) {
      console.error("[discovery] Fingerprinting failed:", err);
    }
  }

  // Hostname enrichment
  merged = await enrichHostnames(merged, deepScan);

  // Plugin enrichment
  merged = await Promise.all(
    merged.map((candidate) => pluginRegistry.enrichCandidate(candidate)),
  );

  /* ── Phase 5: Classification (happens in candidateToDevice, called by loop.ts) ── */

  return {
    discoveredAt: new Date().toISOString(),
    scanMode: deepScan ? "deep" : "incremental",
    activeTargets: active.length,
    passive,
    active,
    merged,
  };
};
