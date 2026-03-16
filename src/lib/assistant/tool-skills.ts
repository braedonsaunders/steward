import { randomUUID } from "node:crypto";
import { dynamicTool, jsonSchema } from "ai";
import { adapterRegistry } from "@/lib/adapters/registry";
import type { AdapterToolSkill } from "@/lib/adapters/types";
import {
  queryNetworkState,
  type NetworkQueryAction,
  type StructuredNetworkQueryInput,
} from "@/lib/assistant/graph-query";
import {
  requiresWebResearchApiKey,
  webResearchApiKeySecretRef,
} from "@/lib/assistant/web-research-config";
import { runWebResearch } from "@/lib/assistant/web-research";
import {
  deleteDeviceCredential,
  redactDeviceCredential,
  storeDeviceCredential,
  updateDeviceCredential,
  validateDeviceCredential,
} from "@/lib/adoption/credentials";
import {
  HTTP_API_AUTH_MODES,
  describeHttpApiCredentialAuth,
  getHttpApiCredentialAuth,
  httpApiCredentialAuthLabel,
  type HttpApiCredentialAuthMode,
  withHttpApiCredentialAuth,
} from "@/lib/credentials/http-api";
import { isWindowsPlatformDevice, normalizeCredentialProtocol, protocolDisplayLabel } from "@/lib/protocols/catalog";
import {
  completeDeviceOnboarding,
  getDeviceAdoptionSnapshot,
  startDeviceAdoption,
  updateDeviceOnboardingDraft,
} from "@/lib/adoption/orchestrator";
import {
  computeDeviceStateHash,
  executeOperationWithGates,
} from "@/lib/adapters/execution-kernel";
import { observeBrowserSurfaces } from "@/lib/discovery/browser-observer";
import { candidateToDevice } from "@/lib/discovery/classify";
import { dedupeObservations } from "@/lib/discovery/evidence";
import { fingerprintDevice } from "@/lib/discovery/fingerprint";
import { buildHostnameResolutionSummary } from "@/lib/discovery/hostname-resolution";
import { runRemoteDesktopFlow } from "@/lib/remote-desktop/agent";
import { runNmapDeepFingerprint } from "@/lib/discovery/nmap-deep";
import { getOuiStats, lookupOuiVendor } from "@/lib/discovery/oui";
import { collectPacketIntelSnapshot } from "@/lib/discovery/packet-intel";
import {
  createAssurance,
  createResponsibility,
  deleteAssurance,
  deleteResponsibility,
  resolveAssuranceForDevice,
  resolveResponsibilityForDevice,
  summarizeDeviceContractForPrompt,
  updateAssurance,
  updateResponsibility,
} from "@/lib/devices/contract-management";
import { localToolManifestSchema } from "@/lib/local-tools/schema";
import { localToolRuntime } from "@/lib/local-tools/runtime";
import { parseWinrmCommandTemplate } from "@/lib/adapters/winrm";
import { getDeviceNameValidationError, normalizeDeviceName } from "@/lib/devices/naming";
import { getDefaultProvider } from "@/lib/llm/config";
import { evaluatePolicy } from "@/lib/policy/engine";
import { protocolSessionManager } from "@/lib/protocol-sessions/manager";
import { loadPlaywrightChromiumRuntime } from "@/lib/runtime/playwright";
import { webSessionManager } from "@/lib/web-sessions/manager";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import { vault } from "@/lib/security/vault";
import { runShell } from "@/lib/utils/shell";
import {
  automationTargetControlId,
  automationTargetWidgetId,
  runDeviceAutomation,
  computeAutomationNextRunAt,
} from "@/lib/widgets/automations";
import { executeWidgetControl, getWidgetControl } from "@/lib/widgets/controls";
import { generateAndStoreDeviceWidget } from "@/lib/widgets/generator";
import { DEVICE_TYPE_VALUES, type DeviceType } from "@/lib/state/types";
import type {
  AccessMethod,
  ActionClass,
  Assurance,
  DeviceAutomation,
  Device,
  DeviceCredential,
  DeviceWidget,
  DeviceWidgetControl,
  DiscoveryObservation,
  LLMProvider,
  OnboardingDraftAssurance,
  OnboardingDraftWorkload,
  OperationKind,
  OperationMode,
  OperationSpec,
  ProtocolBrokerRequest,
  ServiceFingerprint,
  Workload,
  WorkloadCategory,
} from "@/lib/state/types";
import type { DiscoveryCandidate } from "@/lib/discovery/types";

interface ExecuteArgs {
  device_id?: string;
  input?: Record<string, unknown>;
}

interface SkillExecutionConfig {
  kind?: OperationKind;
  mode?: OperationMode;
  adapterId?: string;
  timeoutMs?: number;
  expectedSemanticTarget?: string;
  commandTemplate?: string;
  commandTemplates?: Partial<Record<OperationKind, string>>;
  localToolId?: string;
  localToolCommand?: string;
  localToolArgs?: string[];
  localToolCwd?: string;
  localToolInstallIfMissing?: boolean;
}

interface SkillRuntimeDescriptor {
  adapterId: string;
  adapterName: string;
  skillId: string;
  skillName: string;
  operationKinds: OperationKind[];
  toolCallName: string;
  toolCallDescription: string;
  toolCallParameters: Record<string, unknown>;
  execution: SkillExecutionConfig;
}

const OPERATION_KINDS: OperationKind[] = [
  "shell.command",
  "service.restart",
  "service.stop",
  "container.restart",
  "container.stop",
  "http.request",
  "websocket.message",
  "mqtt.message",
  "cert.renew",
  "file.copy",
  "network.config",
];

const MUTATING_KINDS = new Set<OperationKind>([
  "service.restart",
  "service.stop",
  "container.restart",
  "container.stop",
  "cert.renew",
  "file.copy",
  "network.config",
]);

const NETWORK_QUERY_ACTIONS = ["inventory", "device_summary", "dependencies", "recent_changes"] as const;
const NETWORK_QUERY_ADOPTION_STATUSES = ["any", "discovered", "adopted", "ignored"] as const;
const NETWORK_QUERY_DEVICE_STATUSES = ["any", "online", "offline", "degraded", "unknown"] as const;

const WEB_RESEARCH_MAX_RESULTS_LIMIT = 80;
const WEB_RESEARCH_DEEP_READ_LIMIT = 40;
const WEB_RESEARCH_SEARCH_PAGE_LIMIT = 10;
const WEB_RESEARCH_RESULTS_PER_PAGE_HINT = 8;

function nowIso(): string {
  return new Date().toISOString();
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function slugifyWidgetKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64) || "device-widget";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperationKind(value: string): value is OperationKind {
  return OPERATION_KINDS.includes(value as OperationKind);
}

function toOperationKind(value: unknown): OperationKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return isOperationKind(normalized) ? normalized : undefined;
}

function shellEscapeSingleQuoted(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}

function shellEscapeDoubleQuoted(value: string): string {
  return value.replace(/"/g, '\\"');
}

function sanitizeSnmpToken(value: string | undefined, fallback: string, pattern: RegExp): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return pattern.test(trimmed) ? trimmed : fallback;
}

function resolveMode(kind: OperationKind, requested?: unknown): OperationMode {
  if (requested === "read" || requested === "mutate") {
    return requested;
  }
  return MUTATING_KINDS.has(kind) ? "mutate" : "read";
}

const DEVICE_REQUIRED_ERROR =
  "Valid device_id is required. This is a non-retryable blocker until you supply a resolvable device id, IP, hostname, or unique device name.";
const ATTACHED_DEVICE_REQUIRED_ERROR =
  "Valid device_id is required or chat must be attached to a device. This is a non-retryable blocker until the chat is attached or the device target resolves.";

function normalizeLookupToken(value: string): string {
  return value.trim().toLowerCase();
}

function compactLookupToken(value: string): string {
  return normalizeLookupToken(value).replace(/[^a-z0-9]/g, "");
}

function buildLookupAliases(value: string | undefined): string[] {
  if (typeof value !== "string") {
    return [];
  }

  const normalized = normalizeLookupToken(value);
  if (normalized.length === 0) {
    return [];
  }

  const aliases = new Set<string>([normalized]);
  const compact = compactLookupToken(value);
  if (compact.length > 0) {
    aliases.add(compact);
  }

  const shortLabel = normalized.split(".")[0]?.trim();
  if (shortLabel) {
    aliases.add(shortLabel);
    const compactShort = shortLabel.replace(/[^a-z0-9]/g, "");
    if (compactShort.length > 0) {
      aliases.add(compactShort);
    }
  }

  return Array.from(aliases);
}

function scoreLookupAlias(targetAliases: string[], value: string | undefined, weights: {
  exact: number;
  prefix: number;
  contains: number;
}): number {
  const candidateAliases = buildLookupAliases(value);
  let best = 0;
  for (const targetAlias of targetAliases) {
    if (targetAlias.length === 0) {
      continue;
    }
    for (const alias of candidateAliases) {
      if (alias === targetAlias) {
        best = Math.max(best, weights.exact);
        continue;
      }
      if (alias.startsWith(targetAlias) || targetAlias.startsWith(alias)) {
        best = Math.max(best, weights.prefix);
        continue;
      }
      if (targetAlias.length >= 3 && (alias.includes(targetAlias) || targetAlias.includes(alias))) {
        best = Math.max(best, weights.contains);
      }
    }
  }
  return best;
}

async function resolveDeviceByTarget(rawTarget: string | undefined, attachedDeviceId?: string): Promise<Device | null> {
  const target = rawTarget?.trim();
  if ((!target || target.length === 0) && attachedDeviceId) {
    return stateStore.getDeviceById(attachedDeviceId);
  }

  if (!target) {
    return null;
  }

  const byId = stateStore.getDeviceById(target);
  if (byId) return byId;

  const targetAliases = buildLookupAliases(target);
  const state = await stateStore.getState();
  const scored = state.devices
    .map((device) => ({
      device,
      score: Math.max(
        scoreLookupAlias(targetAliases, device.id, { exact: 140, prefix: 118, contains: 0 }),
        scoreLookupAlias(targetAliases, device.ip, { exact: 136, prefix: 0, contains: 0 }),
        scoreLookupAlias(targetAliases, device.hostname, { exact: 124, prefix: 104, contains: 82 }),
        scoreLookupAlias(targetAliases, device.name, { exact: 120, prefix: 100, contains: 78 }),
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.device.name.localeCompare(right.device.name));
  if (scored.length === 0) {
    return null;
  }
  if (scored.length === 1 || scored[0].score > scored[1].score) {
    return scored[0].device;
  }
  return null;
}

function validateDeviceReadyForToolUse(
  device: Device,
  options?: { allowPreOnboardingExecution?: boolean },
): { ok: true } | { ok: false; reason: string } {
  const adoptionStatus = getDeviceAdoptionStatus(device);
  if (options?.allowPreOnboardingExecution) {
    if (adoptionStatus === "ignored") {
      return {
        ok: false,
        reason: `Device ${device.name} is ignored and cannot be probed. This is a non-retryable blocker until the device is unignored.`,
      };
    }
    return { ok: true };
  }

  if (adoptionStatus !== "adopted") {
    return {
      ok: false,
      reason: `Device ${device.name} is not adopted yet. This is a non-retryable blocker for managed chat tools until adoption starts or the device is attached to its onboarding flow.`,
    };
  }

  const run = stateStore.getLatestAdoptionRun(device.id);
  if (!run || run.status !== "completed") {
    return {
      ok: false,
      reason: `Device ${device.name} onboarding is not complete yet. This is a non-retryable blocker for managed chat tools until onboarding finishes or the chat is attached to that onboarding session.`,
    };
  }

  return { ok: true };
}

function deviceHasObservedProtocol(device: Device, protocols: string[], servicePorts: number[]): boolean {
  if (device.protocols.some((value) => protocols.includes(normalizeCredentialProtocol(value)))) {
    return true;
  }

  if (stateStore.getAccessMethods(device.id).some((method) => {
    const kind = normalizeCredentialProtocol(method.kind);
    const protocol = normalizeCredentialProtocol(method.protocol);
    return protocols.includes(kind) || protocols.includes(protocol);
  })) {
    return true;
  }

  return device.services.some((service) =>
    service.transport === "tcp" && servicePorts.includes(service.port),
  );
}

function validateDeviceReadyForContractToolUse(
  device: Device,
): { ok: true } | { ok: false; reason: string } {
  return validateDeviceReadyForToolUse(device);
}

function validateDeviceReadyForExplorationToolUse(
  device: Device,
  options?: { allowPreOnboardingExecution?: boolean },
): { ok: true } | { ok: false; reason: string } {
  return validateDeviceReadyForToolUse(device, {
    allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
  });
}

function hasSelectedProfileForAdapter(deviceId: string, adapterId: string): boolean {
  const profiles = stateStore.getDeviceProfiles(deviceId);
  const matchingProfiles = profiles.filter((profile) =>
    profile.profileId === adapterId || profile.adapterId === adapterId,
  );
  if (matchingProfiles.length === 0) {
    return true;
  }
  return matchingProfiles.some((profile) =>
    ["selected", "verified", "active"].includes(profile.status)
  );
}

function sameSubnet24(a: string, b: string): boolean {
  const aParts = a.split(".");
  const bParts = b.split(".");
  return aParts.length === 4 && bParts.length === 4
    && aParts[0] === bParts[0]
    && aParts[1] === bParts[1]
    && aParts[2] === bParts[2];
}

function deviceLooksLikeGateway(device: Device): boolean {
  if (["router", "firewall", "modem", "access-point"].includes(device.type)) {
    return true;
  }

  const ports = new Set(device.services.map((service) => service.port));
  const identityText = `${device.name} ${device.hostname ?? ""} ${device.vendor ?? ""}`.toLowerCase();
  return /\b(router|gateway|firewall|pfsense|opnsense|unifi|dream machine|mikrotik)\b/.test(identityText)
    || ((ports.has(53) || ports.has(67)) && (ports.has(80) || ports.has(443)));
}

function summarizeDiscoveryObservation(observation: DiscoveryObservation): string {
  const details = observation.details;

  if (observation.evidenceType === "dhcp_lease") {
    const hostname = typeof details.hostname === "string" ? details.hostname : undefined;
    const hostnames = Array.isArray(details.hostnames)
      ? details.hostnames.filter((value): value is string => typeof value === "string").slice(0, 3)
      : [];
    return hostname
      ? `DHCP hostname ${hostname}`
      : hostnames.length > 0
        ? `DHCP hostnames ${hostnames.join(", ")}`
        : "DHCP lease hint";
  }

  if (observation.evidenceType === "packet_traffic_profile") {
    const dnsNames = Array.isArray(details.dnsNames)
      ? details.dnsNames.filter((value): value is string => typeof value === "string").slice(0, 2)
      : [];
    const httpHosts = Array.isArray(details.httpHosts)
      ? details.httpHosts.filter((value): value is string => typeof value === "string").slice(0, 2)
      : [];
    const tlsSni = Array.isArray(details.tlsSni)
      ? details.tlsSni.filter((value): value is string => typeof value === "string").slice(0, 2)
      : [];
    const parts = [
      dnsNames.length > 0 ? `dns=${dnsNames.join(",")}` : "",
      httpHosts.length > 0 ? `http=${httpHosts.join(",")}` : "",
      tlsSni.length > 0 ? `tls=${tlsSni.join(",")}` : "",
    ].filter((part) => part.length > 0);
    return parts.length > 0 ? `Traffic hints ${parts.join(" ")}` : "Traffic profile";
  }

  if (observation.evidenceType === "browser_observation") {
    const title = typeof details.title === "string" ? details.title : undefined;
    const url = typeof details.finalUrl === "string"
      ? details.finalUrl
      : typeof details.url === "string"
        ? details.url
        : undefined;
    const statusCode = typeof details.statusCode === "number" ? details.statusCode : undefined;
    const serverHeader = typeof details.serverHeader === "string" ? details.serverHeader : undefined;
    const vendorHints = Array.isArray(details.vendorHints)
      ? details.vendorHints.filter((value): value is string => typeof value === "string").slice(0, 2)
      : [];
    const parts = [
      statusCode ? `HTTP ${statusCode}` : "",
      serverHeader ? `Server ${serverHeader}` : "",
      title,
      vendorHints.length > 0 ? vendorHints.join(", ") : "",
      url,
    ].filter(Boolean);
    return parts.length > 0 ? `Browser ${parts.join(" | ")}` : "Browser observation";
  }

  if (observation.evidenceType === "favicon_hash") {
    const hash = typeof details.hash === "string" ? details.hash : "";
    return hash ? `Favicon hash ${hash.slice(0, 16)}` : "Favicon hash";
  }

  if (observation.evidenceType === "protocol_hint") {
    const protocol = typeof details.protocol === "string" ? details.protocol : "unknown";
    const port = typeof details.port === "number" ? details.port : "";
    return `Protocol hint ${protocol}${port ? ` on ${port}` : ""}`;
  }

  if (observation.evidenceType === "nmap_script") {
    const scriptId = typeof details.scriptId === "string" ? details.scriptId : "script";
    const port = typeof details.port === "number" ? details.port : "";
    return `Nmap ${scriptId}${port ? ` on ${port}` : ""}`;
  }

  if (observation.evidenceType === "http_banner") {
    const statusCode = typeof details.statusCode === "number" ? details.statusCode : undefined;
    const serverHeader = typeof details.serverHeader === "string" ? details.serverHeader : undefined;
    const title = typeof details.title === "string" ? details.title : undefined;
    const parts = [
      statusCode ? `HTTP ${statusCode}` : "",
      serverHeader ? `Server ${serverHeader}` : "",
      title ? `Title ${title}` : "",
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" | ") : "HTTP banner";
  }

  return observation.evidenceType.replace(/_/g, " ");
}

function getRecentDiscoveryObservationsForDevice(
  device: Device,
  observationWindowMinutes: number,
  limitPerIp = 8,
): DiscoveryObservation[] {
  const ips = [device.ip, ...(device.secondaryIps ?? [])].filter((value, index, all) => all.indexOf(value) === index);
  const sinceAt = new Date(Date.now() - observationWindowMinutes * 60_000).toISOString();
  const grouped = stateStore.getRecentDiscoveryObservationsByIp(ips, { sinceAt, limitPerIp });
  return Array.from(grouped.values())
    .flat()
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

function buildDiscoveryHintBuckets(observations: DiscoveryObservation[]): Record<string, string[]> {
  const dhcpHostnames = new Set<string>();
  const dnsNames = new Set<string>();
  const httpHosts = new Set<string>();
  const tlsSni = new Set<string>();
  const faviconHashes = new Set<string>();
  const browserTitles = new Set<string>();
  const browserVendorHints = new Set<string>();
  const protocolHints = new Set<string>();

  for (const observation of observations) {
    const details = observation.details;
    if (observation.evidenceType === "dhcp_lease") {
      if (typeof details.hostname === "string") dhcpHostnames.add(details.hostname);
      if (Array.isArray(details.hostnames)) {
        for (const value of details.hostnames) {
          if (typeof value === "string") dhcpHostnames.add(value);
        }
      }
    }

    if (observation.evidenceType === "packet_traffic_profile") {
      for (const key of ["dnsNames", "httpHosts", "tlsSni"] as const) {
        const values = details[key];
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          if (typeof value !== "string") continue;
          if (key === "dnsNames") dnsNames.add(value);
          if (key === "httpHosts") httpHosts.add(value);
          if (key === "tlsSni") tlsSni.add(value);
        }
      }
    }

    if (observation.evidenceType === "browser_observation") {
      if (typeof details.title === "string") browserTitles.add(details.title);
      if (Array.isArray(details.vendorHints)) {
        for (const value of details.vendorHints) {
          if (typeof value === "string") browserVendorHints.add(value);
        }
      }
    }

    if (observation.evidenceType === "favicon_hash" && typeof details.hash === "string") {
      faviconHashes.add(details.hash.slice(0, 16));
    }

    if (observation.evidenceType === "protocol_hint" && typeof details.protocol === "string") {
      protocolHints.add(details.protocol);
    }
  }

  return {
    dhcpHostnames: Array.from(dhcpHostnames).slice(0, 6),
    dnsNames: Array.from(dnsNames).slice(0, 6),
    httpHosts: Array.from(httpHosts).slice(0, 6),
    tlsSni: Array.from(tlsSni).slice(0, 6),
    browserTitles: Array.from(browserTitles).slice(0, 4),
    browserVendorHints: Array.from(browserVendorHints).slice(0, 4),
    faviconHashes: Array.from(faviconHashes).slice(0, 4),
    protocolHints: Array.from(protocolHints).slice(0, 6),
  };
}

async function buildRouterCandidateSummaries(device: Device, limit = 5): Promise<Array<Record<string, unknown>>> {
  const state = await stateStore.getState();
  return state.devices
    .filter((candidate) => candidate.id !== device.id && deviceLooksLikeGateway(candidate))
    .sort((a, b) => {
      const subnetScore = Number(sameSubnet24(b.ip, device.ip)) - Number(sameSubnet24(a.ip, device.ip));
      if (subnetScore !== 0) return subnetScore;
      const typeScore = Number(b.type === "router" || b.type === "firewall") - Number(a.type === "router" || a.type === "firewall");
      if (typeScore !== 0) return typeScore;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit)
    .map((candidate) => {
      const routerLeaseIntel = isRecord(candidate.metadata.routerLeaseIntel) ? candidate.metadata.routerLeaseIntel : {};
      const hasHttpCredential = stateStore.getDeviceCredentials(candidate.id)
        .some((credential) => credential.protocol.toLowerCase() === "http-api");
      return {
        deviceId: candidate.id,
        name: candidate.name,
        ip: candidate.ip,
        type: candidate.type,
        vendor: candidate.vendor ?? null,
        hostname: candidate.hostname ?? null,
        sameSubnet24: sameSubnet24(candidate.ip, device.ip),
        services: candidate.services.slice(0, 6).map((service) => `${service.name}:${service.port}`),
        hasRouterLeaseIntel: Object.keys(routerLeaseIntel).length > 0,
        preferredLeaseEndpoint: typeof routerLeaseIntel.preferredLeaseEndpoint === "string"
          ? routerLeaseIntel.preferredLeaseEndpoint
          : null,
        hasHttpCredential,
      };
    });
}

const UNKNOWN_SERVICE_NAMES = new Set(["", "unknown", "tcpwrapped", "generic"]);
const WEB_PORT_HINTS = new Set([80, 443, 8080, 8443, 8000, 9000, 5000, 5001, 7443, 9443]);

function isUnknownServiceName(name: string | undefined): boolean {
  return !name || UNKNOWN_SERVICE_NAMES.has(name.trim().toLowerCase());
}

function mergeServiceSet(current: ServiceFingerprint[], patches: ServiceFingerprint[]): ServiceFingerprint[] {
  const byKey = new Map<string, ServiceFingerprint>();
  for (const service of current) {
    byKey.set(`${service.transport}:${service.port}`, service);
  }
  for (const patch of patches) {
    const key = `${patch.transport}:${patch.port}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, patch);
      continue;
    }
    byKey.set(key, {
      ...existing,
      ...patch,
      id: existing.id,
      name: !isUnknownServiceName(patch.name) ? patch.name : existing.name,
      secure: existing.secure || patch.secure,
      product: patch.product ?? existing.product,
      version: patch.version ?? existing.version,
      banner: patch.banner ?? existing.banner,
      httpInfo: patch.httpInfo ?? existing.httpInfo,
      tlsCert: patch.tlsCert ?? existing.tlsCert,
      lastSeenAt: patch.lastSeenAt ?? existing.lastSeenAt,
    });
  }
  return Array.from(byKey.values()).sort((a, b) => a.port - b.port);
}

function candidateFromDevice(device: Device): DiscoveryCandidate {
  return {
    ip: device.ip,
    ...(device.mac ? { mac: device.mac } : {}),
    ...(device.hostname ? { hostname: device.hostname } : {}),
    ...(device.vendor ? { vendor: device.vendor } : {}),
    ...(device.os ? { os: device.os } : {}),
    typeHint: device.type,
    services: [...device.services],
    source: "active",
    observations: [],
    metadata: typeof device.metadata === "object" && device.metadata !== null
      ? { ...device.metadata }
      : {},
  };
}

async function localCommandAvailable(command: string): Promise<boolean> {
  const probe = await runShell(
    process.platform === "win32" ? `where ${command}` : `command -v ${command}`,
    1_500,
  );
  return probe.ok && probe.stdout.trim().length > 0;
}

async function localPlaywrightAvailable(): Promise<boolean> {
  const chromium = await loadPlaywrightChromiumRuntime();
  return Boolean(chromium);
}

function inferAdapterForKind(kind: OperationKind, device: Device): string {
  const protocols = new Set(device.protocols.map((protocol) => normalizeCredentialProtocol(protocol)));

  if (kind === "http.request") return "http-api";
  if (kind === "mqtt.message") return "mqtt";
  if (kind === "container.restart" || kind === "container.stop") return "docker";
  if (kind === "service.restart" || kind === "service.stop") {
    if (protocols.has("winrm")) return "winrm";
    if (protocols.has("powershell-ssh")) return "powershell-ssh";
    if (protocols.has("wmi")) return "wmi";
    if (protocols.has("ssh")) return "ssh";
  }
  if (kind === "file.copy") {
    if (protocols.has("smb")) return "smb";
    if (protocols.has("ssh")) return "ssh";
  }
  if (kind === "shell.command") {
    if (protocols.has("ssh") || deviceHasObservedProtocol(device, ["ssh"], [22, 2222])) return "ssh";
    if (protocols.has("winrm") || deviceHasObservedProtocol(device, ["winrm"], [5985, 5986])) return "winrm";
    if (protocols.has("powershell-ssh")) return "powershell-ssh";
    if (protocols.has("wmi")) return "wmi";
    if (protocols.has("smb") || deviceHasObservedProtocol(device, ["smb"], [445])) return "smb";
    if (protocols.has("docker") || deviceHasObservedProtocol(device, ["docker"], [2375, 2376])) return "docker";
    if (protocols.has("telnet") || deviceHasObservedProtocol(device, ["telnet"], [23])) return "telnet";
    if (protocols.has("snmp") || deviceHasObservedProtocol(device, ["snmp"], [161])) return "snmp";
  }
  if (protocols.has("ssh") || deviceHasObservedProtocol(device, ["ssh"], [22, 2222])) return "ssh";
  if (protocols.has("winrm") || deviceHasObservedProtocol(device, ["winrm"], [5985, 5986])) return "winrm";
  if (protocols.has("powershell-ssh")) return "powershell-ssh";
  if (protocols.has("wmi")) return "wmi";
  if (protocols.has("smb") || deviceHasObservedProtocol(device, ["smb"], [445])) return "smb";
  if (protocols.has("telnet") || deviceHasObservedProtocol(device, ["telnet"], [23])) return "telnet";
  if (protocols.has("rdp")) return "rdp";
  if (protocols.has("vnc")) return "vnc";
  if (protocols.has("docker") || deviceHasObservedProtocol(device, ["docker"], [2375, 2376])) return "docker";
  if (protocols.has("mqtt")) return "mqtt";
  if (protocols.has("http-api") || protocols.has("http")) return "http-api";
  return "ssh";
}

const HTTP_PORT_PREFERENCE = [80, 8080, 8000, 9000, 5000, 443, 8443, 7443, 9443, 5001];
const HTTPS_PORT_PREFERENCE = [443, 8443, 7443, 9443, 5001];
const HTTPS_PORT_HINTS = new Set([443, 8443, 7443, 9443, 5001, 5986, 8883, 2376]);
const HTTP_PORT_HINTS = new Set([80, 8080, 8000, 9000, 5000, 5985, 1883, 2375]);
const SSH_PORT_PREFERENCE = [22, 2222, 2200];
const WINRM_PORT_PREFERENCE = [5985, 5986];
const DOCKER_PORT_PREFERENCE = [2375, 2376];
const MQTT_PORT_PREFERENCE = [8883, 1883];
const SHELL_READ_FAILURE_CACHE_TTL_MS = 60_000;
const shellReadFailureCache = new Map<string, {
  at: number;
  result: Record<string, unknown>;
}>();
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SSH_OPTIONS_WITH_VALUE = new Set([
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

function coercePort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

function inputPort(input: Record<string, unknown>): number | undefined {
  return coercePort(input.port)
    ?? coercePort(input.ssh_port)
    ?? coercePort(input.winrm_port)
    ?? coercePort(input.http_port)
    ?? coercePort(input.api_port)
    ?? coercePort(input.docker_port)
    ?? coercePort(input.mqtt_port)
    ?? coercePort(input.snmp_port)
    ?? coercePort(input.connection_port)
    ?? coercePort(input.management_port);
}

function inputString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function inputRawString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function inputBoolean(input: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function shellReadCredentialCacheToken(deviceId: string): string {
  return stateStore.getDeviceCredentials(deviceId)
    .map((credential) => ({
      protocol: normalizeCredentialProtocol(credential.protocol),
      adapterId: credential.adapterId?.trim() ?? "",
      status: credential.status,
      accountLabel: credential.accountLabel?.trim().toLowerCase() ?? "",
      updatedAt: credential.updatedAt,
      lastValidatedAt: credential.lastValidatedAt ?? "",
    }))
    .sort((a, b) =>
      a.protocol.localeCompare(b.protocol)
      || a.adapterId.localeCompare(b.adapterId)
      || a.accountLabel.localeCompare(b.accountLabel)
      || a.updatedAt.localeCompare(b.updatedAt)
      || a.lastValidatedAt.localeCompare(b.lastValidatedAt),
    )
    .map((credential) =>
      [
        credential.protocol,
        credential.adapterId,
        credential.status,
        credential.accountLabel,
        credential.updatedAt,
        credential.lastValidatedAt,
      ].join("|"),
    )
    .join(";");
}

function inputStringArray(input: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = input[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return items;
  }
  return undefined;
}

function parseWorkloadCategory(value: unknown): WorkloadCategory | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return [
    "application",
    "platform",
    "data",
    "network",
    "perimeter",
    "storage",
    "telemetry",
    "background",
    "unknown",
  ].includes(normalized)
    ? normalized as WorkloadCategory
    : undefined;
}

function parseCriticality(value: unknown): Workload["criticality"] | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function parseDesiredState(value: unknown): Assurance["desiredState"] | undefined {
  if (value === "running" || value === "stopped") {
    return value;
  }
  return undefined;
}

function summarizeResponsibilityEntry(workload: Workload): Record<string, unknown> {
  return {
    id: workload.id,
    key: workload.workloadKey,
    displayName: workload.displayName,
    category: workload.category,
    criticality: workload.criticality,
    summary: workload.summary ?? null,
  };
}

function summarizeAssuranceEntry(
  assurance: Assurance,
  responsibilitiesById: Map<string, Workload>,
): Record<string, unknown> {
  const linkedResponsibility = assurance.workloadId
    ? responsibilitiesById.get(assurance.workloadId)
    : undefined;
  return {
    id: assurance.id,
    key: assurance.assuranceKey,
    displayName: assurance.displayName,
    responsibilityId: assurance.workloadId ?? null,
    responsibilityKey: linkedResponsibility?.workloadKey ?? null,
    responsibilityName: linkedResponsibility?.displayName ?? null,
    criticality: assurance.criticality,
    desiredState: assurance.desiredState,
    checkIntervalSec: assurance.checkIntervalSec,
    monitorType: assurance.monitorType ?? null,
    requiredProtocols: assurance.requiredProtocols ?? [],
    rationale: assurance.rationale ?? null,
  };
}

function buildContractSnapshotPayload(deviceId: string): {
  responsibilities: Record<string, unknown>[];
  assurances: Record<string, unknown>[];
} {
  const responsibilities = stateStore.getWorkloads(deviceId);
  const responsibilitiesById = new Map(responsibilities.map((item) => [item.id, item]));
  return {
    responsibilities: responsibilities.map((item) => summarizeResponsibilityEntry(item)),
    assurances: stateStore.getAssurances(deviceId).map((item) => summarizeAssuranceEntry(item, responsibilitiesById)),
  };
}

function summarizeCredentialEntry(
  credential: DeviceCredential | Omit<DeviceCredential, "vaultSecretRef">,
): Record<string, unknown> {
  const protocol = normalizeCredentialProtocol(credential.protocol);
  const summary: Record<string, unknown> = {
    id: credential.id,
    protocol,
    protocolLabel: protocolDisplayLabel(protocol),
    adapterId: credential.adapterId ?? null,
    accountLabel: credential.accountLabel ?? null,
    status: credential.status,
    updatedAt: credential.updatedAt,
  };

  if (protocol === "http-api") {
    const auth = getHttpApiCredentialAuth(credential.scopeJson);
    summary.httpAuthMode = auth.mode;
    summary.httpAuth = describeHttpApiCredentialAuth(credential.scopeJson);
    summary.headerName = auth.headerName ?? null;
    summary.queryParamName = auth.queryParamName ?? null;
    summary.pathPrefix = auth.pathPrefix ?? null;
  }

  return summary;
}

function credentialUsageHints(
  credential: DeviceCredential | Omit<DeviceCredential, "vaultSecretRef">,
): Record<string, unknown> | undefined {
  if (normalizeCredentialProtocol(credential.protocol) !== "http-api") {
    return undefined;
  }

  const auth = getHttpApiCredentialAuth(credential.scopeJson);
  return {
    authMode: auth.mode,
    authLabel: httpApiCredentialAuthLabel(auth.mode),
    authSummary: describeHttpApiCredentialAuth(credential.scopeJson),
    pathConvention: auth.mode === "path-segment"
      ? `Use request paths under ${auth.pathPrefix ?? "/api"} and Steward will inject the stored token after that prefix.`
      : null,
  };
}

function parseHttpApiCredentialMode(value: unknown): HttpApiCredentialAuthMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if ((HTTP_API_AUTH_MODES as readonly string[]).includes(normalized)) {
    return normalized as HttpApiCredentialAuthMode;
  }

  switch (normalized) {
    case "username-password":
    case "password":
      return "basic";
    case "bearer-token":
    case "token":
      return "bearer";
    case "header-token":
    case "api-key-header":
      return "api-key";
    case "query-token":
      return "query-param";
    case "path-token":
      return "path-segment";
    default:
      return undefined;
  }
}

function inferHttpApiCredentialMode(
  args: Record<string, unknown>,
  existingScope?: Record<string, unknown>,
): HttpApiCredentialAuthMode {
  const explicit = parseHttpApiCredentialMode(
    inputString(args, "http_auth_mode", "credential_type", "secret_type"),
  );
  if (explicit) {
    return explicit;
  }
  if (inputString(args, "http_path_prefix", "path_prefix")) {
    return "path-segment";
  }
  if (inputString(args, "http_query_param_name", "query_param_name")) {
    return "query-param";
  }
  if (inputString(args, "http_header_name", "header_name")) {
    return "api-key";
  }
  if (inputString(args, "account_label", "username")) {
    return "basic";
  }
  return existingScope ? getHttpApiCredentialAuth(existingScope).mode : "bearer";
}

function buildCredentialScopeFromArgs(
  protocol: string,
  args: Record<string, unknown>,
  existingScope?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (protocol !== "http-api") {
    return existingScope;
  }

  return withHttpApiCredentialAuth(existingScope, {
    mode: inferHttpApiCredentialMode(args, existingScope),
    ...(inputString(args, "http_header_name", "header_name")
      ? { headerName: inputString(args, "http_header_name", "header_name") }
      : {}),
    ...(inputString(args, "http_query_param_name", "query_param_name")
      ? { queryParamName: inputString(args, "http_query_param_name", "query_param_name") }
      : {}),
    ...(inputString(args, "http_path_prefix", "path_prefix")
      ? { pathPrefix: inputString(args, "http_path_prefix", "path_prefix") }
      : {}),
  });
}

function resolveCredentialForDevice(
  deviceId: string,
  selector: {
    id?: string;
    protocol?: string;
    accountLabel?: string;
    adapterId?: string;
  },
): { ok: true; value: DeviceCredential } | { ok: false; error: string; matches?: Record<string, unknown>[] } {
  const credentials = stateStore.getDeviceCredentials(deviceId);
  if (selector.id) {
    const exact = credentials.find((credential) => credential.id === selector.id);
    return exact
      ? { ok: true, value: exact }
      : { ok: false, error: `Credential ${selector.id} not found.` };
  }

  const normalizedProtocol = selector.protocol ? normalizeCredentialProtocol(selector.protocol) : undefined;
  const normalizedAccountLabel = selector.accountLabel?.trim().toLowerCase();
  const normalizedAdapterId = selector.adapterId?.trim();

  const matches = credentials.filter((credential) => {
    if (normalizedProtocol && credential.protocol.toLowerCase() !== normalizedProtocol) {
      return false;
    }
    if (normalizedAccountLabel && (credential.accountLabel?.trim().toLowerCase() ?? "") !== normalizedAccountLabel) {
      return false;
    }
    if (normalizedAdapterId && (credential.adapterId?.trim() ?? "") !== normalizedAdapterId) {
      return false;
    }
    return true;
  });

  if (matches.length === 1) {
    return { ok: true, value: matches[0] };
  }
  if (matches.length === 0) {
    return { ok: false, error: "Credential not found." };
  }

  return {
    ok: false,
    error: "Multiple credentials matched. Provide credential_id or narrow by account_label / adapter_id.",
    matches: matches.map((credential) => summarizeCredentialEntry(credential)),
  };
}

const DEVICE_TYPE_ALIAS_MAP: Record<string, DeviceType> = {
  server: "server",
  workstation: "workstation",
  desktop: "workstation",
  laptop: "laptop",
  notebook: "laptop",
  smartphone: "smartphone",
  phone: "smartphone",
  tablet: "tablet",
  router: "router",
  firewall: "firewall",
  switch: "switch",
  "access-point": "access-point",
  ap: "access-point",
  modem: "modem",
  "load-balancer": "load-balancer",
  "vpn-appliance": "vpn-appliance",
  "wan-optimizer": "wan-optimizer",
  camera: "camera",
  nvr: "nvr",
  dvr: "dvr",
  nas: "nas",
  san: "san",
  printer: "printer",
  scanner: "scanner",
  pbx: "pbx",
  "voip-phone": "voip-phone",
  "conference-system": "conference-system",
  "point-of-sale": "point-of-sale",
  pos: "point-of-sale",
  "badge-reader": "badge-reader",
  "door-controller": "door-controller",
  ups: "ups",
  pdu: "pdu",
  bmc: "bmc",
  iot: "iot",
  sensor: "sensor",
  controller: "controller",
  "smart-tv": "smart-tv",
  "media-streamer": "media-streamer",
  "game-console": "game-console",
  "container-host": "container-host",
  hypervisor: "hypervisor",
  "vm-host": "vm-host",
  "kubernetes-master": "kubernetes-master",
  "kubernetes-worker": "kubernetes-worker",
  unknown: "unknown",
};

function isAcceptableDeviceName(value: string): boolean {
  return getDeviceNameValidationError(value) === null;
}

function parseDeviceCategory(value: string | undefined): DeviceType | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  if ((DEVICE_TYPE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as DeviceType;
  }
  return DEVICE_TYPE_ALIAS_MAP[normalized] ?? null;
}

function inferManageableDeviceName(device: Device): string | null {
  const identity = isRecord(device.metadata.identity) ? device.metadata.identity : null;
  const identityName = typeof identity?.name === "string" ? normalizeDeviceName(identity.name) : "";
  if (identityName && isAcceptableDeviceName(identityName)) {
    return identityName;
  }

  const inferredProduct = isRecord(device.metadata.fingerprint)
    && typeof device.metadata.fingerprint.inferredProduct === "string"
    ? normalizeDeviceName(device.metadata.fingerprint.inferredProduct)
    : "";
  if (inferredProduct && isAcceptableDeviceName(inferredProduct)) {
    return inferredProduct;
  }

  if (device.hostname) {
    const host = normalizeDeviceName(device.hostname);
    if (isAcceptableDeviceName(host)) {
      return host;
    }
  }

  return null;
}

function inferManageableDeviceCategory(device: Device): DeviceType | null {
  const identity = isRecord(device.metadata.identity) ? device.metadata.identity : null;
  const identityType = parseDeviceCategory(typeof identity?.type === "string" ? identity.type : undefined);
  if (identityType) {
    return identityType;
  }

  const hints = [
    device.name,
    device.hostname,
    device.vendor,
    device.os,
    typeof identity?.description === "string" ? identity.description : "",
    isRecord(device.metadata.fingerprint) && typeof device.metadata.fingerprint.inferredProduct === "string"
      ? device.metadata.fingerprint.inferredProduct
      : "",
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (hints.includes("barracuda") && hints.includes("backup")) return "nas";
  if (/(firewall|pfsense|fortigate|opnsense|checkpoint)/.test(hints)) return "firewall";
  if (/(router|gateway|edge-router)/.test(hints)) return "router";
  if (/(switch|aruba|cisco catalyst)/.test(hints)) return "switch";
  if (/(access point|wireless ap|unifi ap)/.test(hints)) return "access-point";
  if (/(printer|laserjet|officejet)/.test(hints)) return "printer";
  if (/(nas|synology|qnap)/.test(hints)) return "nas";
  if (/(ups|uninterruptible power)/.test(hints)) return "ups";
  if (/(vmware|esxi|proxmox|hyper-v|hypervisor)/.test(hints)) return "hypervisor";
  if (/(server|ubuntu|debian|windows server|rhel)/.test(hints)) return "server";

  return null;
}

async function resolveBrowserCredential(device: Device): Promise<{
  credentialId?: string;
  username?: string;
  password?: string;
  unsupportedAuthMode?: HttpApiCredentialAuthMode;
}> {
  const candidates = stateStore.getDeviceCredentials(device.id)
    .filter((credential) =>
      credential.protocol.toLowerCase() === "http-api"
    );
  if (candidates.length === 0) {
    return {};
  }
  const priority = ["validated", "provided", "pending"] as const;
  const sorted = [...candidates].sort((a, b) => {
    const aPriority = priority.indexOf(a.status as (typeof priority)[number]);
    const bPriority = priority.indexOf(b.status as (typeof priority)[number]);
    if (aPriority !== bPriority) {
      return (aPriority === -1 ? 99 : aPriority) - (bPriority === -1 ? 99 : bPriority);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const selected = sorted.find((credential) => getHttpApiCredentialAuth(credential.scopeJson).mode === "basic")
    ?? sorted[0];
  if (!selected) {
    return {};
  }
  const auth = getHttpApiCredentialAuth(selected.scopeJson);
  if (auth.mode !== "basic") {
    return {
      credentialId: selected.id,
      unsupportedAuthMode: auth.mode,
    };
  }
  const secret = await vault.getSecret(selected.vaultSecretRef);
  if (secret === undefined || secret === null) {
    return { credentialId: selected.id, username: selected.accountLabel?.trim() };
  }
  return {
    credentialId: selected.id,
    username: selected.accountLabel?.trim(),
    password: secret,
  };
}

function hasSnmpInputHints(input: Record<string, unknown>): boolean {
  const community = inputString(input, "community", "snmp_community");
  const version = inputString(input, "snmp_version", "version");
  const oid = inputString(input, "oid", "snmp_oid");
  const port = coercePort(input.snmp_port) ?? coercePort(input.port);
  return Boolean(community || version || oid || port === 161);
}

function inputObject(input: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = input[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter(([, item]) =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    )
    .map(([key, item]) => [key, String(item)]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeQueryMap(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter(([, item]) =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );
  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, string | number | boolean>
    : undefined;
}

function normalizeHttpMethod(input: Record<string, unknown>): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  const method = inputString(input, "method", "http_method");
  if (!method) {
    return "GET";
  }
  const normalized = method.toUpperCase();
  return HTTP_METHODS.has(normalized)
    ? normalized as "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
    : "GET";
}

function inputSecurePreference(input: Record<string, unknown>): boolean | undefined {
  const scheme = inputString(input, "scheme");
  if (scheme === "https") return true;
  if (scheme === "http") return false;
  return inputBoolean(input, "secure", "use_ssl");
}

function winrmSecurePreference(input: Record<string, unknown>): boolean | undefined {
  const explicit = inputSecurePreference(input);
  if (explicit !== undefined) {
    return explicit;
  }
  const port = inputPort(input);
  if (port === 5986) return true;
  if (port === 5985) return false;
  return undefined;
}

function winrmAuthenticationPreference(input: Record<string, unknown>): string | undefined {
  const authentication = inputString(input, "winrm_authentication", "authentication");
  return authentication ? authentication.toLowerCase() : undefined;
}

function winrmSkipCertChecksPreference(input: Record<string, unknown>): boolean | undefined {
  return inputBoolean(input, "skip_cert_checks", "skipCertChecks", "insecure_skip_verify");
}

function mqttSecurePreference(input: Record<string, unknown>): boolean | undefined {
  const scheme = inputString(input, "scheme");
  if (scheme === "mqtts") return true;
  if (scheme === "mqtt") return false;
  const explicit = inputSecurePreference(input);
  if (explicit !== undefined) {
    return explicit;
  }
  const port = inputPort(input);
  if (port === 8883) return true;
  if (port === 1883) return false;
  return undefined;
}

function mqttSkipCertChecksPreference(input: Record<string, unknown>): boolean | undefined {
  return inputBoolean(input, "insecure_skip_verify", "skip_cert_checks", "skipCertChecks");
}

function preferredWinrmPort(device?: Device, explicitPort?: number, secure?: boolean): number | undefined {
  if (explicitPort) {
    return explicitPort;
  }

  if (!device) {
    return secure === true ? 5986 : 5985;
  }

  const candidates = device.services
    .filter((service) => service.transport === "tcp" && (service.port === 5985 || service.port === 5986))
    .sort((a, b) => {
      const ai = WINRM_PORT_PREFERENCE.indexOf(a.port);
      const bi = WINRM_PORT_PREFERENCE.indexOf(b.port);
      const aRank = ai === -1 ? 999 : ai;
      const bRank = bi === -1 ? 999 : bi;
      if (secure === true) {
        return bRank - aRank;
      }
      if (secure === false) {
        return aRank - bRank;
      }
      return aRank - bRank;
    });

  return candidates[0]?.port ?? (secure === true ? 5986 : 5985);
}

function preferredDockerPort(device?: Device, explicitPort?: number, secure?: boolean): number | undefined {
  if (explicitPort) {
    return explicitPort;
  }

  if (!device) {
    return secure === true ? 2376 : 2375;
  }

  const candidates = device.services
    .filter((service) => service.transport === "tcp" && (service.port === 2375 || service.port === 2376))
    .sort((a, b) => {
      const ai = DOCKER_PORT_PREFERENCE.indexOf(a.port);
      const bi = DOCKER_PORT_PREFERENCE.indexOf(b.port);
      const aRank = ai === -1 ? 999 : ai;
      const bRank = bi === -1 ? 999 : bi;
      if (secure === true) {
        return bRank - aRank;
      }
      if (secure === false) {
        return aRank - bRank;
      }
      return aRank - bRank;
    });

  return candidates[0]?.port ?? (secure === true ? 2376 : 2375);
}

function preferredMqttPort(device?: Device, explicitPort?: number, secure?: boolean): number | undefined {
  if (explicitPort) {
    return explicitPort;
  }

  if (!device) {
    return secure === false ? 1883 : 8883;
  }

  const candidates = device.services
    .filter((service) =>
      service.transport === "tcp"
      && (service.port === 1883 || service.port === 8883 || /mqtt/i.test(service.name)),
    )
    .sort((a, b) => {
      const ai = MQTT_PORT_PREFERENCE.indexOf(a.port);
      const bi = MQTT_PORT_PREFERENCE.indexOf(b.port);
      const aRank = ai === -1 ? 999 : ai;
      const bRank = bi === -1 ? 999 : bi;
      if (secure === true) {
        return Number(b.secure) - Number(a.secure) || aRank - bRank;
      }
      if (secure === false) {
        return Number(a.secure) - Number(b.secure) || aRank - bRank;
      }
      return aRank - bRank;
    });

  return candidates[0]?.port ?? (secure === false ? 1883 : 8883);
}

function normalizeTopicList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0);
}

function normalizeMqttPublishMessages(input: Record<string, unknown>): Array<{
  topic: string;
  payload?: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
}> {
  const raw = input.publish_messages ?? input.publishMessages;
  if (Array.isArray(raw)) {
    return raw
      .filter(isRecord)
      .map((item) => {
        const topic = typeof item.topic === "string" ? item.topic.trim() : "";
        if (!topic) return undefined;
        const payload = typeof item.payload === "string"
          ? item.payload
          : Array.isArray(item.payload) || isRecord(item.payload)
            ? JSON.stringify(item.payload)
            : undefined;
        const qosValue = Number(item.qos);
        const qos = qosValue === 0 || qosValue === 1 || qosValue === 2 ? qosValue : undefined;
        const retain = typeof item.retain === "boolean" ? item.retain : undefined;
        return { topic, ...(payload !== undefined ? { payload } : {}), ...(qos !== undefined ? { qos } : {}), ...(retain !== undefined ? { retain } : {}) };
      })
      .filter((item): item is { topic: string; payload?: string; qos?: 0 | 1 | 2; retain?: boolean } => Boolean(item));
  }

  const topic = inputString(input, "topic");
  if (!topic) {
    return [];
  }
  const payloadRaw = input.payload;
  if (payloadRaw === undefined) {
    return [];
  }
  const payload = typeof payloadRaw === "string"
    ? payloadRaw
    : Array.isArray(payloadRaw) || isRecord(payloadRaw)
      ? JSON.stringify(payloadRaw)
      : undefined;
  const qosValue = Number(input.qos);
  const qos = qosValue === 0 || qosValue === 1 || qosValue === 2 ? qosValue : undefined;
  const retain = inputBoolean(input, "retain");
  return [{ topic, ...(payload !== undefined ? { payload } : {}), ...(qos !== undefined ? { qos } : {}), ...(retain !== undefined ? { retain } : {}) }];
}

function hasMqttPublishInput(input: Record<string, unknown>): boolean {
  return normalizeMqttPublishMessages(input).length > 0;
}

function dockerHostTarget(device: Device | undefined, input: Record<string, unknown>): string {
  const explicitHost = inputString(input, "docker_host");
  if (explicitHost) {
    return explicitHost;
  }

  const secure = inputSecurePreference(input);
  const port = preferredDockerPort(device, inputPort(input), secure);
  return port ? `tcp://{{host}}:${port}` : "tcp://{{host}}";
}

function normalizeHttpTargetInput(
  input: Record<string, unknown>,
): {
  path?: string;
  query?: Record<string, string | number | boolean>;
  port?: number;
  secure?: boolean;
  scheme?: "http" | "https";
} {
  const urlInput = inputString(input, "url", "target_url", "endpoint");
  if (!urlInput) {
    return {};
  }

  try {
    const parsed = new URL(urlInput.startsWith("http://") || urlInput.startsWith("https://")
      ? urlInput
      : `http://${urlInput}`);
    const queryEntries = Array.from(parsed.searchParams.entries());
    return {
      path: parsed.pathname || "/",
      ...(queryEntries.length > 0 ? { query: Object.fromEntries(queryEntries) } : {}),
      ...(parsed.port ? { port: coercePort(parsed.port) } : {}),
      scheme: parsed.protocol === "https:" ? "https" : "http",
      secure: parsed.protocol === "https:",
    };
  } catch {
    return {};
  }
}

function preferredSshPort(device?: Device, explicitPort?: number): number | undefined {
  if (explicitPort) {
    return explicitPort;
  }

  if (!device) {
    return undefined;
  }

  const candidates = device.services
    .filter((service) =>
      service.transport === "tcp"
      && (service.port === 22 || service.port === 2222 || /ssh/i.test(service.name)),
    )
    .sort((a, b) => {
      const ai = SSH_PORT_PREFERENCE.indexOf(a.port);
      const bi = SSH_PORT_PREFERENCE.indexOf(b.port);
      const aRank = ai === -1 ? 999 : ai;
      const bRank = bi === -1 ? 999 : bi;
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      return a.port - b.port;
    });

  return candidates[0]?.port;
}

function sshCommandPrefix(device: Device | undefined, input: Record<string, unknown>): string {
  const port = preferredSshPort(device, inputPort(input));
  const portFlag = port && port !== 22 ? ` -p ${port}` : "";
  return `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=8${portFlag} {{host}}`;
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function stripOuterQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function looksLikeSshTarget(value: string, device?: Device): boolean {
  const normalized = stripOuterQuotes(value).trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return normalized.includes("@")
    || normalized === (device?.ip ?? "").toLowerCase()
    || normalized === (device?.hostname ?? "").toLowerCase()
    || normalized === "localhost"
    || normalized.includes(".")
    || normalized.includes(":")
    || normalized.startsWith("[");
}

function normalizeShellReadCommand(
  command: string,
  device?: Device,
): { command: string; port?: number } {
  const trimmed = command.trim();
  if (!trimmed.startsWith("ssh ")) {
    return { command: trimmed };
  }

  const tokens = tokenizeCommand(trimmed);
  if (tokens[0] !== "ssh") {
    return { command: trimmed };
  }

  let port: number | undefined;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "-p" && index + 1 < tokens.length) {
      port = coercePort(stripOuterQuotes(tokens[index + 1] ?? "")) ?? port;
      index += 2;
      continue;
    }
    if (/^-p\d+$/.test(token)) {
      port = coercePort(token.slice(2)) ?? port;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += SSH_OPTIONS_WITH_VALUE.has(token) && index + 1 < tokens.length ? 2 : 1;
      continue;
    }
    break;
  }

  const remaining = tokens.slice(index);
  if (remaining.length === 0) {
    return { command: trimmed, port };
  }

  const remoteTokens = looksLikeSshTarget(remaining[0] ?? "", device)
    ? remaining.slice(1)
    : remaining;
  const remoteCommand = remoteTokens.map(stripOuterQuotes).join(" ").trim();
  return {
    command: remoteCommand.length > 0 ? remoteCommand : trimmed,
    ...(port ? { port } : {}),
  };
}

function validateShellReadCommandForAdapter(
  adapterId: string,
  command: string,
): { ok: true } | { ok: false; error: string; hint: string } {
  const normalized = command.trim().toLowerCase();
  if (adapterId === "wmi") {
    const usesRemoteSession = normalized.includes("$session")
      || normalized.includes("-cimsession")
      || normalized.includes("-computername")
      || normalized.includes("invoke-cimmethod");
    if (!usesRemoteSession) {
      return {
        ok: false,
        error: "WMI is not a general remote shell. The command must explicitly use the injected remote CIM session.",
        hint: "Use `$session`, `-CimSession`, or `-ComputerName`, for example: `Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime`.",
      };
    }
  }
  if (adapterId === "smb") {
    const shareScoped = normalized.includes("$sharepath")
      || normalized.includes("$shareroot")
      || normalized.includes("join-path $sharepath")
      || normalized.includes("join-path $shareroot");
    if (!shareScoped) {
      return {
        ok: false,
        error: "SMB is share access only. It cannot execute general Windows commands remotely.",
        hint: "Use a share-scoped file operation against `$sharePath` or `$shareRoot`, for example: `Get-ChildItem $sharePath | Select-Object -First 20 Name,Length,LastWriteTime`.",
      };
    }
  }
  return { ok: true };
}
function normalizeToolInput(args: ExecuteArgs & Record<string, unknown>): Record<string, unknown> {
  const nested = isRecord(args.input) ? { ...args.input } : {};
  const topLevelEntries = Object.entries(args)
    .filter(([key, value]) => key !== "device_id" && key !== "input" && value !== undefined);
  for (const [key, value] of topLevelEntries) {
    nested[key] = value;
  }
  return nested;
}

function buildExecutionTemplateParams(input: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (/(?:password|secret|token|authorization|cookie|body)/i.test(key)) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params[key] = String(value);
    }
  }
  return params;
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function summarizeAdapterRecord(
  record: NonNullable<ReturnType<typeof adapterRegistry.getAdapterRecordById>>,
): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    version: record.version,
    author: record.author,
    source: record.source,
    enabled: record.enabled,
    status: record.status,
    error: record.error ?? null,
    provides: record.provides,
    toolSkillCount: record.toolSkills.length,
    toolSkills: record.toolSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      category: skill.category ?? null,
      operationKinds: skill.operationKinds ?? [],
      toolCallName: skill.toolCall?.name ?? null,
    })),
    updatedAt: record.updatedAt,
  };
}

function buildAdapterPackagePayload(
  pkg: NonNullable<ReturnType<typeof adapterRegistry.getAdapterPackageById>>,
  options?: {
    includeEntrySource?: boolean;
    includeMarkdown?: boolean;
  },
): Record<string, unknown> {
  return {
    adapter: summarizeAdapterRecord(pkg.adapter),
    manifest: cloneJsonValue(pkg.manifest),
    isBuiltin: pkg.isBuiltin,
    ...(options?.includeEntrySource === false ? {} : { entrySource: pkg.entrySource }),
    ...(options?.includeMarkdown === false
      ? {}
      : {
        adapterSkillMd: pkg.adapterSkillMd ?? null,
        toolSkillMd: cloneJsonValue(pkg.toolSkillMd),
      }),
  };
}

function rankWebAccessMethodStatus(value: AccessMethod["status"]): number {
  return value === "validated"
    ? 0
    : value === "credentialed"
      ? 1
      : value === "observed"
        ? 2
        : 3;
}

function webSurfacePortRank(port: number | undefined, secure: boolean): number {
  const value = port ?? -1;
  const preferredPorts = secure ? HTTPS_PORT_PREFERENCE : HTTP_PORT_PREFERENCE;
  const preferredIdx = preferredPorts.indexOf(value);
  if (preferredIdx !== -1) {
    return preferredIdx;
  }
  const fallbackIdx = HTTP_PORT_PREFERENCE.indexOf(value);
  return fallbackIdx === -1 ? 999 : fallbackIdx + 100;
}

function compareWebAccessMethods(
  left: AccessMethod,
  right: AccessMethod,
  securePreference?: boolean,
): number {
  const leftSecure = Boolean(left.secure);
  const rightSecure = Boolean(right.secure);
  if (leftSecure !== rightSecure) {
    if (securePreference === false) {
      return leftSecure ? 1 : -1;
    }
    return leftSecure ? -1 : 1;
  }
  if (rankWebAccessMethodStatus(left.status) !== rankWebAccessMethodStatus(right.status)) {
    return rankWebAccessMethodStatus(left.status) - rankWebAccessMethodStatus(right.status);
  }
  const leftRank = webSurfacePortRank(left.port, leftSecure);
  const rightRank = webSurfacePortRank(right.port, rightSecure);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return (left.port ?? 0) - (right.port ?? 0);
}

function preferredWebAccessMethod(device: Device, securePreference?: boolean): AccessMethod | null {
  return stateStore.getAccessMethods(device.id)
    .filter((method) => method.kind === "web-session" || method.kind === "http-api")
    .sort((left, right) => compareWebAccessMethods(left, right, securePreference))[0] ?? null;
}

function webServiceAppearsSecure(service: ServiceFingerprint): boolean {
  return Boolean(service.secure) || HTTPS_PORT_HINTS.has(service.port);
}

function compareWebServices(
  left: ServiceFingerprint,
  right: ServiceFingerprint,
  securePreference?: boolean,
): number {
  const leftSecure = webServiceAppearsSecure(left);
  const rightSecure = webServiceAppearsSecure(right);
  if (leftSecure !== rightSecure) {
    if (securePreference === false) {
      return leftSecure ? 1 : -1;
    }
    return leftSecure ? -1 : 1;
  }
  const leftRank = webSurfacePortRank(left.port, leftSecure);
  const rightRank = webSurfacePortRank(right.port, rightSecure);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.port - right.port;
}

function resolvePreferredHttpTarget(
  device: Device | undefined,
  securePreference?: boolean,
): { port: number; secure: boolean } | null {
  if (!device) {
    return null;
  }

  const accessMethod = preferredWebAccessMethod(device, securePreference);
  if (accessMethod?.port) {
    return {
      port: accessMethod.port,
      secure: Boolean(accessMethod.secure),
    };
  }

  const service = device.services
    .filter((candidate) =>
      candidate.transport === "tcp"
      && (
        WEB_PORT_HINTS.has(candidate.port)
        || /http|https|web|api/i.test(candidate.name)
      ))
    .sort((left, right) => compareWebServices(left, right, securePreference))[0];
  if (!service) {
    return null;
  }

  return {
    port: service.port,
    secure: webServiceAppearsSecure(service),
  };
}

function buildDeviceWebUrl(device: Device, method?: AccessMethod | null, pathName = "/"): string {
  const selected = method ?? preferredWebAccessMethod(device);
  const secure = selected?.secure ?? true;
  const port = selected?.port;
  const normalizedPath = pathName.startsWith("/") ? pathName : `/${pathName}`;
  return `${secure ? "https" : "http"}://${device.ip}${port ? `:${port}` : ""}${normalizedPath}`;
}

function inferFallbackMatchedAdapters(device: Device): Array<Record<string, unknown>> {
  if (isWindowsPlatformDevice(device)) {
    const type = String(device.type || "").toLowerCase();
    const name = [device.name, device.hostname, device.os, device.role].filter(Boolean).join(" ").toLowerCase();
    const isServer = type === "server" || /domain controller|active directory|windows server/.test(name);
    return [
      {
        adapterId: isServer ? "steward.windows-server" : "steward.windows-workstation",
        profileId: isServer ? "steward.windows-server" : "steward.windows-workstation",
        name: isServer ? "Windows Server" : "Windows Workstation",
        kind: "fallback",
        confidence: 0.55,
        summary: "Heuristic Windows profile fallback based on device classification and observed services.",
        requiredAccessMethods: device.protocols.filter((protocol) => ["winrm", "powershell-ssh", "wmi", "smb", "rdp", "vnc"].includes(normalizeCredentialProtocol(protocol))),
        requiredCredentialProtocols: device.protocols.filter((protocol) => ["winrm", "powershell-ssh", "wmi", "smb", "rdp", "vnc"].includes(normalizeCredentialProtocol(protocol))),
      },
    ];
  }
  return [];
}

function upsertAdapterToolSkillInManifest(
  manifest: Record<string, unknown>,
  skillInput: AdapterToolSkill,
  replaceExisting: boolean,
): { manifest: Record<string, unknown>; replaced: boolean } {
  const toolSkills = Array.isArray(manifest.toolSkills)
    ? cloneJsonValue(manifest.toolSkills)
    : [];
  const existingIndex = toolSkills.findIndex((entry) =>
    isRecord(entry) && typeof entry.id === "string" && entry.id === skillInput.id
  );

  if (existingIndex >= 0 && !replaceExisting) {
    throw new Error(`Adapter already has a tool skill with id ${skillInput.id}`);
  }

  if (existingIndex >= 0) {
    const existing = toolSkills[existingIndex];
    toolSkills[existingIndex] = isRecord(existing)
      ? { ...existing, ...skillInput }
      : cloneJsonValue(skillInput);
  } else {
    toolSkills.push(cloneJsonValue(skillInput));
  }

  return {
    manifest: {
      ...manifest,
      toolSkills,
    },
    replaced: existingIndex >= 0,
  };
}

function defaultCommandTemplate(
  kind: OperationKind,
  adapterId: string,
  input: Record<string, unknown>,
  device?: Device,
): string | null {
  if (kind === "http.request") {
    const urlOverride = normalizeHttpTargetInput(input);
    const secureFromInput = inputSecurePreference(input) ?? urlOverride.secure;
    const port = Number(input.port ?? urlOverride.port);
    const explicitPort = Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : undefined;
    let secure = secureFromInput;
    let safePort = explicitPort;

    if (safePort === undefined) {
      const preferred = resolvePreferredHttpTarget(device, secure);
      if (preferred) {
        safePort = preferred.port;
        if (secure === undefined) {
          secure = preferred.secure;
        }
      }
    }

    if (safePort === undefined) {
      safePort = secure === true ? 443 : 80;
    }
    if (secure === undefined) {
      secure = HTTPS_PORT_HINTS.has(safePort) && !HTTP_PORT_HINTS.has(safePort);
    }

    const pathRaw = typeof input.path === "string" && input.path.trim().length > 0
      ? input.path.trim()
      : typeof urlOverride.path === "string" && urlOverride.path.trim().length > 0
        ? urlOverride.path.trim()
      : "/";
    const safePath = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;
    const timeoutMs = Number(input.timeout_ms);
    const timeoutSeconds = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.max(2, Math.min(30, Math.floor(timeoutMs / 1000)))
      : 8;
    const scheme = secure ? "https" : "http";
    return `curl -sS -k --max-time ${timeoutSeconds} ${scheme}://{{host}}:${safePort}${safePath}`;
  }

  if (kind === "shell.command") {
    const userCommand = typeof input.command === "string" ? input.command.trim() : "";
    if (adapterId === "winrm") {
      const command = userCommand || "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime";
      const secure = winrmSecurePreference(input);
      const port = preferredWinrmPort(device, inputPort(input), secure);
      const useSslFlag = secure ? " -UseSSL" : "";
      const portFlag = port ? ` -Port ${port}` : "";
      const auth = winrmAuthenticationPreference(input);
      const authFlag = auth ? ` -Authentication ${auth}` : "";
      return `pwsh -NoLogo -NonInteractive -Command "Invoke-Command -ComputerName {{host}}${portFlag}${useSslFlag}${authFlag} -ScriptBlock { ${command} }"`;
    }
    if (adapterId === "powershell-ssh") {
      const command = userCommand || "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime";
      return `ssh {{host}} \"powershell.exe -NoLogo -NoProfile -NonInteractive -Command \\\"${shellEscapeDoubleQuoted(command)}\\\"\"`;
    }
    if (adapterId === "wmi") {
      const command = userCommand || "Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime";
      return `pwsh -NoLogo -NonInteractive -Command \"$session=New-CimSession -ComputerName {{host}}; try { ${shellEscapeDoubleQuoted(command)} } finally { if ($session) { Remove-CimSession $session } }\"`;
    }
    if (adapterId === "smb") {
      const command = userCommand || "Get-ChildItem $sharePath | Select-Object -First 20 Name,Length,LastWriteTime";
      return `pwsh -NoLogo -NonInteractive -Command \"$sharePath='\\\\{{host}}\\C$'; ${shellEscapeDoubleQuoted(command)}\"`;
    }
    if (adapterId === "docker") {
      const command = userCommand || "ps --format '{{.Names}} {{.Status}} {{.Image}}'";
      return `docker -H ${dockerHostTarget(device, input)} ${command}`;
    }
    if (adapterId === "telnet") {
      const command = userCommand || "help";
      const port = inputPort(input) ?? 23;
      return `telnet {{host}}:${port} # managed-session command: ${command}`;
    }
    if (adapterId === "snmp") {
      const community = sanitizeSnmpToken(
        inputString(input, "community", "snmp_community"),
        "public",
        /^[A-Za-z0-9_.:@+-]{1,128}$/,
      );
      const version = sanitizeSnmpToken(
        inputString(input, "snmp_version", "version"),
        "2c",
        /^(1|2c|3)$/i,
      );
      const oid = sanitizeSnmpToken(
        inputString(input, "oid", "snmp_oid"),
        "SNMPv2-MIB::sysDescr.0",
        /^[A-Za-z0-9_.:-]+$/,
      );
      const port = inputPort(input) ?? 161;
      const command = userCommand
        || `snmpget -v${version} -c ${community} {{host}}:${port} ${oid}`;
      return command;
    }
    const command = userCommand || "uname -a; uptime; df -h; free -m";
    return `${sshCommandPrefix(device, input)} '${shellEscapeSingleQuoted(command)}'`;
  }

  if (kind === "service.restart" || kind === "service.stop") {
    const service = typeof input.service === "string" ? input.service.trim() : "";
    if (!service) return null;
    if (adapterId === "winrm") {
      const verb = kind === "service.restart" ? "Restart-Service" : "Stop-Service";
      const secure = winrmSecurePreference(input);
      const port = preferredWinrmPort(device, inputPort(input), secure);
      const useSslFlag = secure ? " -UseSSL" : "";
      const portFlag = port ? ` -Port ${port}` : "";
      const auth = winrmAuthenticationPreference(input);
      const authFlag = auth ? ` -Authentication ${auth}` : "";
      return `pwsh -NoLogo -NonInteractive -Command "Invoke-Command -ComputerName {{host}}${portFlag}${useSslFlag}${authFlag} -ScriptBlock { ${verb} -Name '${service}' -ErrorAction Stop }"`;
    }
    if (adapterId === "powershell-ssh") {
      const verb = kind === "service.restart" ? "Restart-Service" : "Stop-Service";
      return `ssh {{host}} \"powershell.exe -NoLogo -NoProfile -NonInteractive -Command \\\"${verb} -Name '${service}' -ErrorAction Stop\\\"\"`;
    }
    if (adapterId === "wmi") {
      const method = kind === "service.restart" ? "StartService" : "StopService";
      return `pwsh -NoLogo -NonInteractive -Command \"$session=New-CimSession -ComputerName {{host}}; try { Invoke-CimMethod -CimSession $session -Query 'SELECT * FROM Win32_Service WHERE Name=\\\'${service}\\\'' -MethodName ${method} } finally { if ($session) { Remove-CimSession $session } }\"`;
    }
    const verb = kind === "service.restart" ? "restart" : "stop";
    return `${sshCommandPrefix(device, input)} 'sudo systemctl ${verb} ${shellEscapeSingleQuoted(service)}'`;
  }

  if (kind === "container.restart" || kind === "container.stop") {
    const container = typeof input.container === "string" ? input.container.trim() : "";
    if (!container) return null;
    const verb = kind === "container.restart" ? "restart" : "stop";
    return `docker -H ${dockerHostTarget(device, input)} ${verb} ${container}`;
  }

  return null;
}

function defaultBrokerRequest(
  kind: OperationKind,
  adapterId: string,
  input: Record<string, unknown>,
  device?: Device,
): ProtocolBrokerRequest | undefined {
  if (adapterId === "winrm") {
    const secure = winrmSecurePreference(input);
    const authentication = winrmAuthenticationPreference(input);
    const port = preferredWinrmPort(device, inputPort(input), secure);
    const skipCertChecks = winrmSkipCertChecksPreference(input);
    const host = inputString(input, "host", "computer_name", "winrm_host");

    if (kind === "shell.command") {
      const command = typeof input.command === "string" && input.command.trim().length > 0
        ? input.command.trim()
        : "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime";
      return {
        protocol: "winrm",
        command,
        ...(host ? { host } : {}),
        ...(port ? { port } : {}),
        ...(secure !== undefined ? { useSsl: secure } : {}),
        ...(skipCertChecks !== undefined ? { skipCertChecks } : {}),
        ...(authentication ? { authentication } : {}),
      };
    }

    if (kind === "service.restart" || kind === "service.stop") {
      const service = typeof input.service === "string" ? input.service.trim() : "";
      if (!service) return undefined;
      return {
        protocol: "winrm",
        command: `${kind === "service.restart" ? "Restart-Service" : "Stop-Service"} -Name '${service}' -ErrorAction Stop`,
        ...(host ? { host } : {}),
        ...(port ? { port } : {}),
        ...(secure !== undefined ? { useSsl: secure } : {}),
        ...(skipCertChecks !== undefined ? { skipCertChecks } : {}),
        ...(authentication ? { authentication } : {}),
      };
    }
  }

  if (adapterId === "powershell-ssh") {
    const host = inputString(input, "host", "computer_name", "ssh_host");
    const port = inputPort(input) ?? 22;
    if (kind === "shell.command") {
      const command = typeof input.command === "string" && input.command.trim().length > 0
        ? input.command.trim()
        : "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime";
      return {
        protocol: "powershell-ssh",
        command,
        ...(host ? { host } : {}),
        port,
      };
    }
    if (kind === "service.restart" || kind === "service.stop") {
      const service = typeof input.service === "string" ? input.service.trim() : "";
      if (!service) return undefined;
      return {
        protocol: "powershell-ssh",
        command: `${kind === "service.restart" ? "Restart-Service" : "Stop-Service"} -Name '${service}' -ErrorAction Stop`,
        ...(host ? { host } : {}),
        port,
      };
    }
  }

  if (adapterId === "telnet") {
    const host = inputString(input, "host", "computer_name", "telnet_host");
    const port = inputPort(input) ?? 23;
    if (kind === "shell.command") {
      const command = typeof input.command === "string" && input.command.trim().length > 0
        ? input.command.trim()
        : "help";
      const expectRegex = inputString(input, "expect_regex");
      return {
        protocol: "telnet",
        command,
        ...(host ? { host } : {}),
        port,
        ...(expectRegex ? { expectRegex } : {}),
      };
    }
  }

  if (adapterId === "wmi") {
    const host = inputString(input, "host", "computer_name", "wmi_host");
    if (kind === "shell.command") {
      const command = typeof input.command === "string" && input.command.trim().length > 0
        ? input.command.trim()
        : "Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime";
      return {
        protocol: "wmi",
        command,
        ...(host ? { host } : {}),
      };
    }
  }

  if (adapterId === "smb") {
    const host = inputString(input, "host", "computer_name", "smb_host");
    const share = inputString(input, "share", "share_name");
    if (kind === "shell.command") {
      const command = typeof input.command === "string" && input.command.trim().length > 0
        ? input.command.trim()
        : "Get-ChildItem $sharePath | Select-Object -First 20 Name,Length,LastWriteTime";
      return {
        protocol: "smb",
        command,
        ...(host ? { host } : {}),
        ...(share ? { share } : {}),
      };
    }
  }

  if (adapterId === "rdp") {
    const host = inputString(input, "host", "computer_name", "rdp_host");
    return {
      protocol: "rdp",
      ...(host ? { host } : {}),
      ...(inputPort(input) ? { port: inputPort(input) } : {}),
      ...(input.admin === true ? { admin: true } : {}),
      action: input.action === "check" ? "check" : "launch",
    };
  }

  if (kind === "http.request") {
    const urlOverride = normalizeHttpTargetInput(input);
    const secureFromInput = inputSecurePreference(input) ?? urlOverride.secure;
    const port = Number(input.port ?? urlOverride.port);
    const explicitPort = Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : undefined;
    let secure = secureFromInput;
    let safePort = explicitPort;

    if (safePort === undefined) {
      const preferred = resolvePreferredHttpTarget(device, secure);
      if (preferred) {
        safePort = preferred.port;
        if (secure === undefined) {
          secure = preferred.secure;
        }
      }
    }

    if (safePort === undefined) {
      safePort = secure === true ? 443 : 80;
    }
    if (secure === undefined) {
      secure = HTTPS_PORT_HINTS.has(safePort) && !HTTP_PORT_HINTS.has(safePort);
    }

    const pathRaw = typeof input.path === "string" && input.path.trim().length > 0
      ? input.path.trim()
      : typeof urlOverride.path === "string" && urlOverride.path.trim().length > 0
        ? urlOverride.path.trim()
      : "/";
    const safePath = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;
    const method = normalizeHttpMethod(input);
    const query = {
      ...(urlOverride.query ?? {}),
      ...(normalizeQueryMap(inputObject(input, "query")) ?? {}),
    };
    const headers = normalizeStringMap(inputObject(input, "headers"));
    const inputBody = input.body;
    const body = typeof inputBody === "string"
      ? inputBody
      : Array.isArray(inputBody) || isRecord(inputBody)
        ? JSON.stringify(inputBody)
        : undefined;
    const insecureSkipVerify = inputBoolean(input, "insecure_skip_verify") ?? (secure ?? false);
    const expectRegex = inputString(input, "expect_regex");
    const bodyIsStructured = Array.isArray(inputBody) || isRecord(inputBody);
    const normalizedHeaders = bodyIsStructured
      ? { "Content-Type": "application/json", ...(headers ?? {}) }
      : headers;

    return {
      protocol: "http",
      method,
      scheme: secure ? "https" : "http",
      port: safePort,
      path: safePath,
      ...(Object.keys(query).length > 0 ? { query } : {}),
      ...(normalizedHeaders ? { headers: normalizedHeaders } : {}),
      ...(body ? { body } : {}),
      insecureSkipVerify,
      ...(expectRegex ? { expectRegex } : {}),
      ...(inputString(input, "session_id") ? { sessionId: inputString(input, "session_id") } : {}),
      ...(inputString(input, "session_holder") ? { sessionHolder: inputString(input, "session_holder") } : {}),
    };
  }

  if (adapterId === "mqtt" || kind === "mqtt.message") {
    if (kind !== "mqtt.message") {
      return undefined;
    }

    const secure = mqttSecurePreference(input);
    const port = preferredMqttPort(device, inputPort(input), secure);
    const resolvedSecure = secure ?? (port === 8883);
    const publishMessages = normalizeMqttPublishMessages(input);
    let subscribeTopics = normalizeTopicList(
      input.subscribe_topics ?? input.subscribeTopics ?? input.topics,
    );
    if (subscribeTopics.length === 0 && publishMessages.length === 0) {
      const singleTopic = inputString(input, "topic");
      if (singleTopic) {
        subscribeTopics = [singleTopic];
      }
    }
    if (subscribeTopics.length === 0 && publishMessages.length === 0) {
      return undefined;
    }

    const successStrategyRaw = inputString(input, "success_strategy");
    const successStrategy = successStrategyRaw && ["auto", "transport", "response", "expectation"].includes(successStrategyRaw)
      ? successStrategyRaw as "auto" | "transport" | "response" | "expectation"
      : undefined;
    const username = inputString(input, "username", "mqtt_username");
    const clientId = inputString(input, "client_id", "mqtt_client_id");
    const qosValue = Number(input.qos);
    const qos = qosValue === 0 || qosValue === 1 || qosValue === 2 ? qosValue : undefined;
    const retain = inputBoolean(input, "retain");
    const connectTimeoutMs = Number(input.connect_timeout_ms);
    const responseTimeoutMs = Number(input.response_timeout_ms);
    const collectMessages = Number(input.collect_messages);
    const keepaliveSec = Number(input.keepalive_sec);
    const expectRegex = inputString(input, "expect_regex");
    const insecureSkipVerify = mqttSkipCertChecksPreference(input);
    const sessionId = inputString(input, "session_id");
    const sessionHolder = inputString(input, "session_holder");
    const leaseTtlMs = Number(input.lease_ttl_ms);
    const keepSessionOpen = inputBoolean(input, "keep_session_open");
    const arbitrationMode = inputString(input, "arbitration_mode");
    const singleConnectionHint = inputBoolean(input, "single_connection_hint");

    return {
      protocol: "mqtt",
      scheme: resolvedSecure ? "mqtts" : "mqtt",
      ...(port ? { port } : {}),
      ...(clientId ? { clientId } : {}),
      ...(username ? { username } : {}),
      ...(typeof input.clean === "boolean" ? { clean: input.clean } : {}),
      ...(qos !== undefined ? { qos } : {}),
      ...(retain !== undefined ? { retain } : {}),
      ...(subscribeTopics.length > 0 ? { subscribeTopics } : {}),
      ...(publishMessages.length > 0 ? { publishMessages } : {}),
      ...(Number.isFinite(connectTimeoutMs) ? { connectTimeoutMs: clampInt(connectTimeoutMs, 250, 120_000, 5_000) } : {}),
      ...(Number.isFinite(responseTimeoutMs) ? { responseTimeoutMs: clampInt(responseTimeoutMs, 250, 120_000, 2_000) } : {}),
      ...(Number.isFinite(collectMessages) ? { collectMessages: clampInt(collectMessages, 0, 50, 1) } : {}),
      ...(Number.isFinite(keepaliveSec) ? { keepaliveSec: clampInt(keepaliveSec, 5, 1_200, 30) } : {}),
      ...(expectRegex ? { expectRegex } : {}),
      ...(successStrategy ? { successStrategy } : {}),
      ...(insecureSkipVerify !== undefined ? { insecureSkipVerify } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionHolder ? { sessionHolder } : {}),
      ...(Number.isFinite(leaseTtlMs) ? { leaseTtlMs: clampInt(leaseTtlMs, 10_000, 24 * 60 * 60 * 1000, 5 * 60 * 1000) } : {}),
      ...(keepSessionOpen !== undefined ? { keepSessionOpen } : {}),
      ...(
        arbitrationMode === "shared" || arbitrationMode === "exclusive" || arbitrationMode === "single-connection"
          ? { arbitrationMode }
          : {}
      ),
      ...(singleConnectionHint !== undefined ? { singleConnectionHint } : {}),
    };
  }

  const sshCapable = adapterId === "ssh" || adapterId === "network-ssh" || adapterId === "shell";
  if (!sshCapable) {
    return undefined;
  }

  if (kind === "shell.command") {
    const command = typeof input.command === "string" && input.command.trim().length > 0
      ? input.command.trim()
      : "uname -a; uptime; df -h; free -m";
    const port = preferredSshPort(device, inputPort(input));
    return {
      protocol: "ssh",
      command,
      ...(port ? { port } : {}),
    };
  }

  if (kind === "service.restart" || kind === "service.stop") {
    const service = typeof input.service === "string" ? input.service.trim() : "";
    if (!service) return undefined;
    const port = preferredSshPort(device, inputPort(input));
    return {
      protocol: "ssh",
      argv: ["sudo", "systemctl", kind === "service.restart" ? "restart" : "stop", service],
      ...(port ? { port } : {}),
    };
  }

  return undefined;
}

function localToolBrokerRequest(
  execution: SkillExecutionConfig,
  input: Record<string, unknown>,
): ProtocolBrokerRequest | undefined {
  const toolId = inputString(input, "local_tool_id") ?? execution.localToolId?.trim();
  if (!toolId) {
    return undefined;
  }

  const command = inputString(input, "local_tool_command", "local_tool_bin", "command")
    ?? execution.localToolCommand?.trim();
  if (!command) {
    return undefined;
  }

  const timeoutValue = Number(input.timeout_ms ?? execution.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue >= 1_000 && timeoutValue <= 15 * 60 * 1000
    ? Math.floor(timeoutValue)
    : undefined;

  return {
    protocol: "local-tool",
    toolId,
    command,
    argv: inputStringArray(input, "argv", "local_tool_args") ?? execution.localToolArgs,
    cwd: inputString(input, "cwd", "local_tool_cwd") ?? execution.localToolCwd,
    timeoutMs,
    installIfMissing: inputBoolean(input, "install_if_missing") ?? execution.localToolInstallIfMissing,
    healthCheckBeforeRun: inputBoolean(input, "health_check_before_run"),
    approvalReason: inputString(input, "approval_reason"),
  };
}

function buildCommonToolArgumentProperties(): Record<string, unknown> {
  return {
    device_id: { type: "string", description: "Target device id, IP, hostname, or unique device name." },
    operation_kind: { type: "string", description: "Optional operation override when a skill supports multiple actions." },
    mode: { type: "string", description: "Optional mode override: read or mutate." },
    adapter_id: { type: "string", description: "Optional adapter override when multiple protocols are possible." },
    protocol: { type: "string", description: "Optional protocol override such as ssh, winrm, docker, snmp, mqtt, or http-api." },
    port: { type: "integer", description: "Optional management port override for this tool call." },
    secure: { type: "boolean", description: "Optional secure transport hint, such as HTTPS or WinRM over TLS." },
    use_ssl: { type: "boolean", description: "Alias for secure transport where applicable." },
    client_id: { type: "string", description: "Optional MQTT client id override." },
    username: { type: "string", description: "Optional protocol username override, such as MQTT username or HTTP basic-auth username." },
    authentication: { type: "string", description: "Optional authentication mode override, such as basic or negotiate for WinRM." },
    winrm_authentication: { type: "string", description: "Optional WinRM authentication mode override." },
    scheme: { type: "string", description: "Optional URL scheme override, typically http or https." },
    url: { type: "string", description: "Optional full target URL for HTTP-oriented tools; host is normalized to the attached device." },
    path: { type: "string", description: "Optional request path for HTTP-style tools." },
    method: { type: "string", description: "Optional HTTP method override: GET, POST, PUT, PATCH, DELETE." },
    headers: { type: "object", description: "Optional HTTP headers for this tool call.", additionalProperties: true },
    query: { type: "object", description: "Optional HTTP query parameters.", additionalProperties: true },
    body: {
      type: ["string", "object", "array"],
      description: "Optional request body for HTTP tools.",
      items: {},
    },
    expect_regex: { type: "string", description: "Optional HTTP response regex expectation." },
    topic: { type: "string", description: "Optional MQTT topic. If payload is also provided, Steward publishes to this topic; otherwise it subscribes." },
    subscribe_topics: { type: "array", description: "Optional MQTT topics to subscribe to before waiting for messages.", items: { type: "string" } },
    publish_messages: {
      type: "array",
      description: "Optional MQTT publish messages. Each item may include topic, payload, qos, and retain.",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          payload: { type: ["string", "object", "array"], items: {} },
          qos: { type: "integer" },
          retain: { type: "boolean" },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
    payload: {
      type: ["string", "object", "array"],
      description: "Optional MQTT payload for single-message publish flows.",
      items: {},
    },
    qos: { type: "integer", description: "Optional MQTT QoS level (0, 1, or 2)." },
    retain: { type: "boolean", description: "Optional MQTT retain flag." },
    collect_messages: { type: "integer", description: "Optional MQTT message collection limit before Steward returns." },
    connect_timeout_ms: { type: "integer", description: "Optional MQTT connect timeout in milliseconds." },
    response_timeout_ms: { type: "integer", description: "Optional MQTT response wait window in milliseconds." },
    keepalive_sec: { type: "integer", description: "Optional MQTT keepalive in seconds." },
    success_strategy: { type: "string", description: "Optional message success rule: auto, transport, response, expectation." },
    insecure_skip_verify: { type: "boolean", description: "Skip TLS verification for this call when true." },
    session_id: { type: "string", description: "Optional managed protocol session id to reuse." },
    session_holder: { type: "string", description: "Optional lease holder label for managed protocol sessions." },
    lease_ttl_ms: { type: "integer", description: "Optional protocol session lease TTL in milliseconds." },
    keep_session_open: { type: "boolean", description: "When true, keep the managed protocol session connected after the exchange." },
    arbitration_mode: { type: "string", description: "Optional session arbitration mode: shared, exclusive, or single-connection." },
    single_connection_hint: { type: "boolean", description: "When true, Steward treats the protocol session as single-connection." },
    local_tool_id: { type: "string", description: "Optional managed local-tool manifest id." },
    local_tool_command: { type: "string", description: "Managed local-tool command/bin name to execute." },
    local_tool_args: { type: "array", description: "Optional argv array for managed local-tool execution.", items: { type: "string" } },
    argv: { type: "array", description: "Alias for local_tool_args.", items: { type: "string" } },
    install_if_missing: { type: "boolean", description: "Allow Steward to install the managed local tool if it is not installed yet." },
    health_check_before_run: { type: "boolean", description: "Run the managed local-tool health check before execution." },
    approval_reason: { type: "string", description: "Optional approval context for governed local-tool execution." },
    skip_cert_checks: { type: "boolean", description: "Skip WinRM certificate checks for this call when true." },
    timeout_ms: { type: "integer", description: "Optional per-call timeout override in milliseconds." },
    command: { type: "string", description: "Optional remote command for shell-based tools." },
    command_template: { type: "string", description: "Optional raw command template override for advanced use." },
    service: { type: "string", description: "Optional service name for service operation tools." },
    container: { type: "string", description: "Optional container name for container operation tools." },
    docker_host: { type: "string", description: "Optional full Docker host target, such as tcp://host:2375." },
    community: { type: "string", description: "Optional SNMP community string for this call." },
    snmp_version: { type: "string", description: "Optional SNMP version override such as 1, 2c, or 3." },
    oid: { type: "string", description: "Optional SNMP OID override." },
    host: { type: "string", description: "Optional remote host override for brokered protocols such as WinRM." },
    computer_name: { type: "string", description: "Alias for WinRM host override." },
    input: {
      type: "object",
      description: "Optional nested arguments object. Top-level arguments are also accepted.",
      additionalProperties: true,
    },
  };
}

function augmentToolCallParameters(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = isRecord(parameters) ? parameters : {};
  const baseProperties = isRecord(base.properties) ? base.properties : {};
  const inputProperty = isRecord(baseProperties.input) ? baseProperties.input : {};
  const inputProperties = isRecord(inputProperty.properties) ? inputProperty.properties : {};
  const commonProperties = buildCommonToolArgumentProperties();
  const commonInput = isRecord(commonProperties.input) ? commonProperties.input : {};
  const mergedInput = {
    ...commonInput,
    ...inputProperty,
    properties: {
      ...(isRecord(commonInput.properties) ? commonInput.properties : {}),
      ...inputProperties,
    },
    additionalProperties: true,
  };

  return {
    ...base,
    type: "object",
    properties: {
      ...commonProperties,
      ...baseProperties,
      input: mergedInput,
    },
    required: Array.from(
      new Set(
        (Array.isArray(base.required) ? base.required : [])
          .filter((value): value is string => typeof value === "string"),
      ),
    ),
    additionalProperties: base.additionalProperties ?? true,
  };
}

function makeOperation(
  kind: OperationKind,
  adapterId: string,
  mode: OperationMode,
  commandTemplate: string | undefined,
  expectedSemanticTarget: string,
  timeoutMs: number,
  brokerRequest?: ProtocolBrokerRequest,
): OperationSpec {
  return {
    id: `tool:${kind}:${Date.now()}`,
    adapterId,
    kind,
    mode,
    timeoutMs,
    ...(commandTemplate ? { commandTemplate } : {}),
    brokerRequest,
    expectedSemanticTarget,
    safety: {
      dryRunSupported: false,
      requiresConfirmedRevert: false,
      criticality: mode === "mutate" ? "medium" : "low",
    },
  };
}

function pickOperationKind(descriptor: SkillRuntimeDescriptor, input: Record<string, unknown>): OperationKind {
  const requested = toOperationKind(input.operation_kind);
  if (requested && descriptor.operationKinds.includes(requested)) {
    return requested;
  }

  if (descriptor.execution.kind && descriptor.operationKinds.includes(descriptor.execution.kind)) {
    return descriptor.execution.kind;
  }

  const readFirst = descriptor.operationKinds.find((kind) => !MUTATING_KINDS.has(kind));
  return readFirst ?? descriptor.operationKinds[0] ?? "shell.command";
}

function buildOperationFromDescriptor(
  descriptor: SkillRuntimeDescriptor,
  device: Device,
  input: Record<string, unknown>,
): { operation: OperationSpec } | { error: string } {
  const kind = pickOperationKind(descriptor, input);
  const execution = descriptor.execution;

  const explicitAdapterId = typeof input.adapter_id === "string"
    ? input.adapter_id.trim()
    : "";
  const protocolHint = typeof input.protocol === "string"
    ? normalizeCredentialProtocol(input.protocol)
    : "";
  const localToolId = inputString(input, "local_tool_id") ?? execution.localToolId?.trim();

  const adapterId = explicitAdapterId
    || protocolHint
    || (localToolId ? `local-tool:${localToolId}` : "")
    || execution.adapterId
    || (kind === "shell.command" && hasSnmpInputHints(input)
      ? "snmp"
      : inferAdapterForKind(kind, device));

  const requestedMode = input.mode ?? execution.mode;
  const mode = kind === "mqtt.message" && requestedMode === undefined && hasMqttPublishInput(input)
    ? "mutate"
    : resolveMode(kind, requestedMode);

  const commandFromInput = typeof input.command_template === "string" ? input.command_template.trim() : "";
  const commandFromKindConfig = execution.commandTemplates?.[kind]?.trim() ?? "";
  const commandFromConfig = execution.commandTemplate?.trim() ?? "";
  const hasExplicitCommandTemplate = Boolean(commandFromInput || commandFromKindConfig || commandFromConfig);
  let brokerRequest = hasExplicitCommandTemplate
    ? undefined
    : (localToolBrokerRequest(execution, input) ?? defaultBrokerRequest(kind, adapterId, input, device));
  const resolvedCommandTemplate = commandFromInput
    || commandFromKindConfig
    || commandFromConfig
    || (brokerRequest ? undefined : (defaultCommandTemplate(kind, adapterId, input, device) ?? undefined));

  if (!brokerRequest && adapterId === "winrm" && kind === "shell.command" && resolvedCommandTemplate) {
    brokerRequest = parseWinrmCommandTemplate(resolvedCommandTemplate)
      ?? defaultBrokerRequest(kind, adapterId, { ...input, command: resolvedCommandTemplate }, device);
  }

  const commandTemplate = brokerRequest && adapterId === "winrm"
    ? undefined
    : resolvedCommandTemplate;

  if (!commandTemplate && !brokerRequest) {
    return {
      error: `Tool ${descriptor.toolCallName} requires a command template for ${kind}. Provide input.command_template or configure tool execution defaults.`,
    };
  }

  const timeoutRaw = Number(input.timeout_ms ?? execution.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 1_000 && timeoutRaw <= 600_000
    ? Math.floor(timeoutRaw)
    : (mode === "mutate" ? 180_000 : 45_000);

  const expectedSemanticTarget = typeof execution.expectedSemanticTarget === "string" && execution.expectedSemanticTarget.trim().length > 0
    ? execution.expectedSemanticTarget.trim()
    : `${descriptor.skillId}:${kind}`;

  return {
    operation: makeOperation(
      kind,
      adapterId,
      mode,
      commandTemplate,
      expectedSemanticTarget,
      timeoutMs,
      brokerRequest,
    ),
  };
}

function actionClassForOperation(operation: OperationSpec): ActionClass {
  if (operation.mode === "read") {
    return "A";
  }
  if (
    operation.kind === "http.request"
    || operation.kind === "websocket.message"
    || operation.kind === "mqtt.message"
    || operation.kind === "service.restart"
    || operation.kind === "service.stop"
    || operation.kind === "container.restart"
    || operation.kind === "container.stop"
  ) {
    return "B";
  }
  return "C";
}

function toSkillExecutionConfig(value: unknown): SkillExecutionConfig {
  if (!isRecord(value)) {
    return {};
  }

  const kind = toOperationKind(value.kind);
  const mode = value.mode === "read" || value.mode === "mutate"
    ? value.mode
    : undefined;

  const adapterId = typeof value.adapterId === "string" && value.adapterId.trim().length > 0
    ? value.adapterId.trim()
    : undefined;

  const timeoutMs = Number(value.timeoutMs);
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 600_000
    ? Math.floor(timeoutMs)
    : undefined;

  const expectedSemanticTarget = typeof value.expectedSemanticTarget === "string"
    ? value.expectedSemanticTarget
    : undefined;

  const commandTemplate = typeof value.commandTemplate === "string"
    ? value.commandTemplate
    : undefined;

  const commandTemplates = isRecord(value.commandTemplates)
    ? Object.fromEntries(
      Object.entries(value.commandTemplates)
        .filter(([k, v]) => isOperationKind(k) && typeof v === "string"),
    ) as Partial<Record<OperationKind, string>>
    : undefined;
  const localToolId = typeof value.localToolId === "string" && value.localToolId.trim().length > 0
    ? value.localToolId.trim()
    : undefined;
  const localToolCommand = typeof value.localToolCommand === "string" && value.localToolCommand.trim().length > 0
    ? value.localToolCommand.trim()
    : undefined;
  const localToolArgs = Array.isArray(value.localToolArgs)
    ? value.localToolArgs.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
  const localToolCwd = typeof value.localToolCwd === "string" && value.localToolCwd.trim().length > 0
    ? value.localToolCwd.trim()
    : undefined;
  const localToolInstallIfMissing = typeof value.localToolInstallIfMissing === "boolean"
    ? value.localToolInstallIfMissing
    : undefined;

  return {
    kind,
    mode,
    adapterId,
    timeoutMs: safeTimeout,
    expectedSemanticTarget,
    commandTemplate,
    commandTemplates,
    localToolId,
    localToolCommand,
    localToolArgs,
    localToolCwd,
    localToolInstallIfMissing,
  };
}

function mapSkillDescriptors(): SkillRuntimeDescriptor[] {
  const records = adapterRegistry
    .getAdapterRecords()
    .filter((record) => record.enabled && record.status === "loaded");

  const descriptors: SkillRuntimeDescriptor[] = [];

  for (const record of records) {
    for (const skill of record.toolSkills) {
      const config = record.toolConfig?.[skill.id];
      if (isRecord(config) && config.enabled === false) {
        continue;
      }

      const toolCallName = skill.toolCall?.name;
      if (!toolCallName || toolCallName.trim().length === 0) {
        continue;
      }

      const mergedExecution = {
        ...toSkillExecutionConfig(((skill as unknown) as Record<string, unknown>).execution),
        ...toSkillExecutionConfig(isRecord(config) ? config.execution : undefined),
      };

      descriptors.push({
        adapterId: record.id,
        adapterName: record.name,
        skillId: skill.id,
        skillName: skill.name,
        operationKinds: (skill.operationKinds ?? ["shell.command"]).slice(0, 8),
        toolCallName,
        toolCallDescription: skill.toolCall?.description ?? skill.description,
        toolCallParameters: augmentToolCallParameters(skill.toolCall?.parameters),
        execution: mergedExecution,
      });
    }
  }

  return descriptors;
}

function resolveLiveSkillDescriptor(seed: SkillRuntimeDescriptor): SkillRuntimeDescriptor {
  const descriptors = mapSkillDescriptors();
  return descriptors.find((candidate) =>
    candidate.toolCallName === seed.toolCallName
    && candidate.skillId === seed.skillId
    && candidate.adapterId === seed.adapterId
  ) ?? descriptors.find((candidate) => candidate.toolCallName === seed.toolCallName)
    ?? seed;
}

function validateGenericToolOperation(
  descriptor: SkillRuntimeDescriptor,
  operation: OperationSpec,
  input: Record<string, unknown>,
): string | null {
  if (operation.kind === "http.request" && operation.mode === "read") {
    const method = normalizeHttpMethod(input);
    if (method !== "GET") {
      return `${descriptor.toolCallName} is read-only and cannot use HTTP ${method}. Create or update a mutating tool skill instead of using a probe/audit tool for live changes.`;
    }
    if (typeof input.body !== "undefined") {
      return `${descriptor.toolCallName} is read-only and cannot send an HTTP request body. Create or update a mutating tool skill instead.`;
    }
  }
  return null;
}

export async function buildAdapterSkillTools(
  options?: {
    attachedDeviceId?: string;
    allowPreOnboardingExecution?: boolean;
    includeWidgetManagementTool?: boolean;
    widgetVerificationMode?: "strict" | "warn-on-connectivity";
    provider?: LLMProvider;
    model?: string;
  },
): Promise<Record<string, ReturnType<typeof dynamicTool>>> {
  await adapterRegistry.initialize();
  const descriptors = mapSkillDescriptors();
  const tools: Record<string, ReturnType<typeof dynamicTool>> = {};

  for (const descriptor of descriptors) {
    tools[descriptor.toolCallName] = dynamicTool({
      description: descriptor.toolCallDescription,
      inputSchema: jsonSchema(descriptor.toolCallParameters),
      execute: async (argsUnknown: unknown) => {
        const liveDescriptor = resolveLiveSkillDescriptor(descriptor);
        const args = isRecord(argsUnknown) ? (argsUnknown as ExecuteArgs) : {};
        const input = normalizeToolInput(args as ExecuteArgs & Record<string, unknown>);

        const device = await resolveDeviceByTarget(args.device_id, options?.attachedDeviceId);
        if (!device) {
          return {
            ok: false,
            error: DEVICE_REQUIRED_ERROR,
            retryable: false,
          };
        }

        const readiness = validateDeviceReadyForToolUse(device, {
          allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
        });
        if (!readiness.ok) {
          return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
        }

        if (!options?.allowPreOnboardingExecution && !hasSelectedProfileForAdapter(device.id, liveDescriptor.adapterId)) {
          return {
            ok: false,
            blocked: "profile",
            error: `Adapter ${liveDescriptor.adapterName} is not selected for ${device.name}. Complete onboarding and select the matching adapter first.`,
          };
        }

        const planned = buildOperationFromDescriptor(liveDescriptor, device, input);
        if ("error" in planned) {
          return {
            ok: false,
            blocked: "execution_config",
            error: planned.error,
            skillId: liveDescriptor.skillId,
          };
        }

        const operation = planned.operation;
        const operationValidationError = validateGenericToolOperation(liveDescriptor, operation, input);
        if (operationValidationError) {
          return {
            ok: false,
            blocked: "execution_config",
            error: operationValidationError,
            skillId: liveDescriptor.skillId,
            deviceId: device.id,
            deviceName: device.name,
          };
        }
        const actionClass = actionClassForOperation(operation);

        const policy = evaluatePolicy(
          actionClass,
          device,
          stateStore.getPolicyRules(),
          stateStore.getMaintenanceWindows(),
          {
            blastRadius: "single-device",
            criticality: operation.mode === "mutate" ? "high" : "low",
            lane: "A",
            recentFailures: 0,
            quarantineActive: false,
          },
        );

        if (operation.mode === "mutate" && policy.decision !== "ALLOW_AUTO") {
          return {
            ok: false,
            blocked: "policy",
            error: `Policy blocked immediate execution (${policy.decision}): ${policy.reason}`,
            policy,
            deviceId: device.id,
          };
        }

        const adoption = getAdoptionRecord(device);
        const requiredProtocols = Array.isArray(adoption.requiredCredentials)
          ? adoption.requiredCredentials
            .filter((value): value is string => typeof value === "string")
            .map((value) => normalizeCredentialProtocol(value))
          : [];

        if (
          !options?.allowPreOnboardingExecution
          && requiredProtocols.includes(normalizeCredentialProtocol(operation.adapterId))
        ) {
          const usable = new Set(
            stateStore.getUsableCredentialProtocols(device.id).map((value) => normalizeCredentialProtocol(value)),
          );
          if (!usable.has(normalizeCredentialProtocol(operation.adapterId))) {
            return {
              ok: false,
              blocked: "credentials",
              error: `Missing stored credentials for protocol ${operation.adapterId} on ${device.name}.`,
              deviceId: device.id,
            };
          }
        }

        const execution = await executeOperationWithGates(operation, device, {
          actor: "user",
          lane: "A",
          actionClass,
          blastRadius: "single-device",
          policyDecision: policy.decision,
          policyReason: policy.reason,
          approved: true,
          expectedStateHash: computeDeviceStateHash(device),
          runtimeSettings: stateStore.getRuntimeSettings(),
          recentFailures: 0,
          quarantineActive: false,
          allowUnauthenticated: options?.allowPreOnboardingExecution === true && operation.mode === "read",
          allowProvidedCredentials: true,
          idempotencySeed: `${liveDescriptor.skillId}:${device.id}:${nowIso()}`,
          params: buildExecutionTemplateParams(input),
        });

        await stateStore.addAction({
          actor: "user",
          kind: "diagnose",
          message: `Adapter skill executed: ${liveDescriptor.skillName} on ${device.name}`,
          context: {
            deviceId: device.id,
            adapterId: liveDescriptor.adapterId,
            adapterName: liveDescriptor.adapterName,
            skillId: liveDescriptor.skillId,
            toolCallName: liveDescriptor.toolCallName,
            operationKind: operation.kind,
            operationMode: operation.mode,
            executionOk: execution.ok,
            policyDecision: policy.decision,
          },
        });

        return {
          ok: execution.ok,
          deviceId: device.id,
          deviceName: device.name,
          adapterId: liveDescriptor.adapterId,
          skillId: liveDescriptor.skillId,
          operationKind: operation.kind,
          operationMode: operation.mode,
          summary: execution.summary,
          output: execution.output,
          gates: execution.gateResults,
          idempotencyKey: execution.idempotencyKey,
        };
      },
    });
  }

  tools.steward_query_network = dynamicTool({
    description: "Query Steward's network-wide inventory and graph state across adopted and discovered devices. Use this for other-device lookups, discovery/adoption status, same-subnet peers, dependencies, and recent graph changes.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...NETWORK_QUERY_ACTIONS],
          description: "Network query action: inventory, device_summary, dependencies, or recent_changes.",
        },
        device_id: {
          type: "string",
          description: "Target device id, IP, hostname, or unique device name. Optional for device_summary/dependencies when chat is attached to a device.",
        },
        same_subnet_as_device_id: {
          type: "string",
          description: "Optional inventory filter: only show devices on the same /24 subnet as this device.",
        },
        same_subnet_as_attached_device: {
          type: "boolean",
          description: "Optional inventory filter: only show devices on the same /24 subnet as the attached device.",
        },
        query: {
          type: "string",
          description: "Optional inventory or recent-change search text matched against device identity fields, services, or graph node labels.",
        },
        adoption_status: {
          type: "string",
          enum: [...NETWORK_QUERY_ADOPTION_STATUSES],
          description: "Optional inventory filter for discovered, adopted, ignored, or any devices.",
        },
        status: {
          type: "string",
          enum: [...NETWORK_QUERY_DEVICE_STATUSES],
          description: "Optional inventory filter for runtime status.",
        },
        device_type: {
          type: "string",
          enum: ["any", ...DEVICE_TYPE_VALUES],
          description: "Optional inventory filter for device type.",
        },
        limit: {
          type: "integer",
          description: "Maximum rows to return. Defaults to 20.",
        },
        hours: {
          type: "integer",
          description: "For recent_changes: how far back to inspect graph node updates. Defaults to 24 hours.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const action = inputString(args, "action");
      if (!action || !NETWORK_QUERY_ACTIONS.includes(action as NetworkQueryAction)) {
        return { ok: false, error: "Valid action is required.", action: "inventory" };
      }

      const adoptionStatus = inputString(args, "adoption_status");
      const status = inputString(args, "status");
      const deviceType = inputString(args, "device_type");
      const attachedDevice = options?.attachedDeviceId ? stateStore.getDeviceById(options.attachedDeviceId) : null;

      const queryInput: StructuredNetworkQueryInput = {
        action: action as NetworkQueryAction,
        deviceId: inputString(args, "device_id"),
        sameSubnetAsDeviceId: inputString(args, "same_subnet_as_device_id"),
        sameSubnetAsAttachedDevice: inputBoolean(args, "same_subnet_as_attached_device") === true,
        query: inputString(args, "query"),
        adoptionStatus: adoptionStatus && NETWORK_QUERY_ADOPTION_STATUSES.includes(adoptionStatus as typeof NETWORK_QUERY_ADOPTION_STATUSES[number])
          ? adoptionStatus as StructuredNetworkQueryInput["adoptionStatus"]
          : undefined,
        status: status && NETWORK_QUERY_DEVICE_STATUSES.includes(status as typeof NETWORK_QUERY_DEVICE_STATUSES[number])
          ? status as StructuredNetworkQueryInput["status"]
          : undefined,
        type: deviceType && (deviceType === "any" || DEVICE_TYPE_VALUES.includes(deviceType as DeviceType))
          ? deviceType as StructuredNetworkQueryInput["type"]
          : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        hours: typeof args.hours === "number" ? args.hours : undefined,
      };

      return queryNetworkState(queryInput, attachedDevice);
    },
  });

  tools.steward_device_identity = dynamicTool({
    description: "Inspect Steward's stored local identity evidence for a device. Returns MAC, hostname, hostname-resolution ladder details, discovery evidence, recent DHCP/browser/packet signals, HTTP status/header hints, and candidate router/gateway devices for DHCP-client correlation. Use this before public web research or asking the user to identify a private-network device manually.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP. Optional when chat is attached to a device." },
        observation_window_minutes: {
          type: "integer",
          description: "How far back to read recent discovery observations. Defaults to 720 minutes.",
        },
        include_router_candidates: {
          type: "boolean",
          description: "Include likely router/gateway devices that can be queried for lease/client tables.",
        },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForExplorationToolUse(device, {
        allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const observationWindowMinutes = clampInt(args.observation_window_minutes, 5, 10_080, 720);
      const observations = getRecentDiscoveryObservationsForDevice(device, observationWindowMinutes, 10);
      const hints = buildDiscoveryHintBuckets(observations);
      const discovery = isRecord(device.metadata.discovery) ? device.metadata.discovery : {};
      const classification = isRecord(device.metadata.classification) ? device.metadata.classification : {};
      const browserObservation = isRecord(device.metadata.browserObservation) ? device.metadata.browserObservation : {};
      const fingerprint = isRecord(device.metadata.fingerprint) ? device.metadata.fingerprint : {};
      const routerCandidates = inputBoolean(args, "include_router_candidates") === false
        ? []
        : await buildRouterCandidateSummaries(device, 5);
      const hostnameResolution = buildHostnameResolutionSummary(device, observations, routerCandidates);

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        ip: device.ip,
        secondaryIps: device.secondaryIps ?? [],
        mac: device.mac ?? null,
        hostname: device.hostname ?? null,
        vendor: device.vendor ?? null,
        os: device.os ?? null,
        role: device.role ?? null,
        type: device.type,
        status: device.status,
        protocols: device.protocols.slice(0, 12),
        services: device.services.slice(0, 12).map((service) => ({
          name: service.name,
          port: service.port,
          transport: service.transport,
          secure: service.secure,
          product: service.product ?? null,
          version: service.version ?? null,
          httpInfo: service.httpInfo
            ? {
                statusCode: service.httpInfo.statusCode ?? null,
                serverHeader: service.httpInfo.serverHeader ?? null,
                title: service.httpInfo.title ?? null,
                poweredBy: service.httpInfo.poweredBy ?? null,
              }
            : null,
        })),
        hostnameResolution,
        discovery: {
          confidence: typeof discovery.confidence === "number" ? discovery.confidence : null,
          evidenceTypes: Array.isArray(discovery.evidenceTypes)
            ? discovery.evidenceTypes.filter((value): value is string => typeof value === "string").slice(0, 12)
            : [],
          observationCount: typeof discovery.observationCount === "number" ? discovery.observationCount : null,
          sourceCounts: isRecord(discovery.sourceCounts) ? discovery.sourceCounts : {},
        },
        classification: {
          confidence: typeof classification.confidence === "number" ? classification.confidence : null,
          signals: Array.isArray(classification.signals)
            ? classification.signals
              .filter((value): value is Record<string, unknown> => isRecord(value))
              .slice(0, 6)
              .map((signal) => ({
                source: typeof signal.source === "string" ? signal.source : null,
                type: typeof signal.type === "string" ? signal.type : null,
                reason: typeof signal.reason === "string" ? signal.reason : null,
              }))
            : [],
        },
        fingerprint: {
          inferredOs: typeof fingerprint.inferredOs === "string" ? fingerprint.inferredOs : null,
          inferredProduct: typeof fingerprint.inferredProduct === "string" ? fingerprint.inferredProduct : null,
          sshBanner: typeof fingerprint.sshBanner === "string" ? fingerprint.sshBanner : null,
        },
        browserObservation: {
          endpoints: Array.isArray(browserObservation.endpoints)
            ? browserObservation.endpoints
              .filter((value): value is Record<string, unknown> => isRecord(value))
              .slice(0, 4)
              .map((endpoint) => ({
                url: typeof endpoint.url === "string" ? endpoint.url : null,
                finalUrl: typeof endpoint.finalUrl === "string" ? endpoint.finalUrl : null,
                statusCode: typeof endpoint.statusCode === "number" ? endpoint.statusCode : null,
                serverHeader: typeof endpoint.serverHeader === "string" ? endpoint.serverHeader : null,
                title: typeof endpoint.title === "string" ? endpoint.title : null,
                vendorHints: Array.isArray(endpoint.vendorHints)
                  ? endpoint.vendorHints.filter((value): value is string => typeof value === "string").slice(0, 3)
                  : [],
              }))
            : [],
        },
        recentObservationWindowMinutes: observationWindowMinutes,
        recentObservations: observations.slice(0, 12).map((observation) => ({
          ip: observation.ip,
          evidenceType: observation.evidenceType,
          source: observation.source,
          confidence: observation.confidence,
          observedAt: observation.observedAt,
          summary: summarizeDiscoveryObservation(observation),
        })),
        hints,
        routerCandidates,
      };
    },
  });

  tools.steward_shell_read = dynamicTool({
    description: "Run an investigative read-only command over supported remote transports such as SSH, Telnet, WinRM, PowerShell over SSH, WMI, SMB, or Docker. For WMI, the command itself must use `$session` or `-CimSession`; for SMB, only share-scoped file operations using `$sharePath` or `$shareRoot` are valid. Use port for non-default management ports instead of embedding transport wrappers in the command.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP" },
        command: { type: "string", description: "Read-only command to execute remotely" },
        protocol: { type: "string", description: "Optional protocol override: ssh, telnet, winrm, powershell-ssh, wmi, smb, docker" },
        port: { type: "integer", description: "Optional management port override, such as SSH on 2222." },
      },
      required: ["device_id", "command"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        typeof args.device_id === "string" ? args.device_id : undefined,
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForExplorationToolUse(device, {
        allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) {
        return { ok: false, error: "command is required." };
      }

      const requestedProtocol = typeof args.protocol === "string" ? args.protocol.trim().toLowerCase() : "";
      const adapterId = requestedProtocol || inferAdapterForKind("shell.command", device);
      const normalizedShellInput = adapterId === "ssh" || adapterId === "network-ssh" || adapterId === "shell"
        ? normalizeShellReadCommand(command, device)
        : { command };
      const commandValidation = validateShellReadCommandForAdapter(adapterId, normalizedShellInput.command);
      if (!commandValidation.ok) {
        return {
          ok: false,
          deviceId: device.id,
          deviceName: device.name,
          adapterId,
          error: commandValidation.error,
          summary: `${protocolDisplayLabel(adapterId)} shell read needs a protocol-scoped command`,
          hint: commandValidation.hint,
        };
      }
      const port = coercePort(args.port) ?? normalizedShellInput.port;
      const shellInput = {
        command: normalizedShellInput.command,
        ...(port ? { port } : {}),
      };
      const shellCacheKey = [
        device.id,
        adapterId,
        shellInput.command,
        String(port ?? ""),
        shellReadCredentialCacheToken(device.id),
      ].join("::");
      const cachedFailure = shellReadFailureCache.get(shellCacheKey);
      if (cachedFailure && Date.now() - cachedFailure.at < SHELL_READ_FAILURE_CACHE_TTL_MS) {
        return {
          ...cachedFailure.result,
          cached: true,
          summary: typeof cachedFailure.result.summary === "string"
            ? `${cachedFailure.result.summary} (cached identical failure)`
            : "Cached identical shell read failure",
        };
      }
      const commandTemplate = defaultCommandTemplate("shell.command", adapterId, shellInput, device);
      if (!commandTemplate) {
        return { ok: false, error: `Cannot build command template for adapter ${adapterId}.` };
      }

      const operation = makeOperation(
        "shell.command",
        adapterId,
        "read",
        commandTemplate,
        "steward_shell_read:shell",
        120_000,
        defaultBrokerRequest("shell.command", adapterId, shellInput, device),
      );

      const policy = evaluatePolicy(
        "A",
        device,
        stateStore.getPolicyRules(),
        stateStore.getMaintenanceWindows(),
        {
          blastRadius: "single-device",
          criticality: "low",
          lane: "A",
          recentFailures: 0,
          quarantineActive: false,
        },
      );

      const execution = await executeOperationWithGates(operation, device, {
        actor: "user",
        lane: "A",
        actionClass: "A",
        blastRadius: "single-device",
        policyDecision: policy.decision,
        policyReason: policy.reason,
        approved: true,
        expectedStateHash: computeDeviceStateHash(device),
        runtimeSettings: stateStore.getRuntimeSettings(),
        recentFailures: 0,
        quarantineActive: false,
        allowUnauthenticated: options?.allowPreOnboardingExecution === true,
        allowProvidedCredentials: true,
        idempotencySeed: `steward_shell_read:${device.id}:${nowIso()}`,
        params: {},
      });

      const result = {
        ok: execution.ok,
        deviceId: device.id,
        deviceName: device.name,
        adapterId,
        summary: execution.summary,
        reason: execution.ok ? undefined : execution.summary,
        output: execution.output,
        gates: execution.gateResults,
      };
      if (!execution.ok) {
        shellReadFailureCache.set(shellCacheKey, {
          at: Date.now(),
          result,
        });
      } else {
        shellReadFailureCache.delete(shellCacheKey);
      }
      return result;
    },
  });

  tools.steward_mqtt_exchange = dynamicTool({
    description: "Run a native MQTT or MQTTS exchange against a device using stored Steward credentials when available. Use subscribe_topics for telemetry reads, publish_messages for commands, or both for request/response flows.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP." },
        mode: { type: "string", enum: ["read", "mutate"], description: "Optional mode override. Defaults to mutate when publish_messages is provided." },
        port: { type: "integer", description: "Optional MQTT port override." },
        secure: { type: "boolean", description: "Optional secure transport override. True uses MQTTS." },
        use_ssl: { type: "boolean", description: "Alias for secure transport." },
        scheme: { type: "string", enum: ["mqtt", "mqtts"], description: "Optional MQTT scheme override." },
        username: { type: "string", description: "Optional MQTT username override. Stored credential accountLabel is used when present." },
        client_id: { type: "string", description: "Optional MQTT client id override." },
        topic: { type: "string", description: "Single MQTT topic. If payload is provided Steward publishes to it, otherwise Steward subscribes to it." },
        payload: {
          type: ["string", "object", "array"],
          description: "Optional MQTT payload for the single-topic shorthand.",
          items: {},
        },
        subscribe_topics: { type: "array", items: { type: "string" }, description: "Optional MQTT topics to subscribe to before waiting for messages." },
        publish_messages: {
          type: "array",
          description: "Optional MQTT publish messages. Each item may include topic, payload, qos, and retain.",
          items: {
            type: "object",
            properties: {
              topic: { type: "string" },
              payload: { type: ["string", "object", "array"], items: {} },
              qos: { type: "integer" },
              retain: { type: "boolean" },
            },
            required: ["topic"],
            additionalProperties: false,
          },
        },
        qos: { type: "integer", description: "Optional default MQTT QoS level (0, 1, or 2)." },
        retain: { type: "boolean", description: "Optional default retain flag." },
        collect_messages: { type: "integer", description: "Optional number of MQTT messages to collect before returning." },
        connect_timeout_ms: { type: "integer", description: "Optional MQTT connect timeout in milliseconds." },
        response_timeout_ms: { type: "integer", description: "Optional MQTT response wait window in milliseconds." },
        keepalive_sec: { type: "integer", description: "Optional MQTT keepalive in seconds." },
        expect_regex: { type: "string", description: "Optional regex that must match the collected MQTT payloads." },
        success_strategy: {
          type: "string",
          enum: ["auto", "transport", "response", "expectation"],
          description: "Optional success rule override. Use response or expectation for request/response protocols.",
        },
        insecure_skip_verify: { type: "boolean", description: "Skip MQTT TLS certificate verification when true." },
        session_id: { type: "string", description: "Optional persistent session id to reuse." },
        session_holder: { type: "string", description: "Optional lease holder label." },
        lease_ttl_ms: { type: "integer", description: "Optional session lease TTL in milliseconds." },
        keep_session_open: { type: "boolean", description: "When true, keep the managed MQTT session connected after the exchange." },
        arbitration_mode: {
          type: "string",
          enum: ["shared", "exclusive", "single-connection"],
          description: "Optional session arbitration mode.",
        },
        single_connection_hint: { type: "boolean", description: "When true, Steward treats the session as single-connection." },
      },
      required: ["device_id"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        typeof args.device_id === "string" ? args.device_id : undefined,
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForExplorationToolUse(device, {
        allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const requestedMode = args.mode === "read" || args.mode === "mutate" ? args.mode : undefined;
      const mode = requestedMode ?? (hasMqttPublishInput(args) ? "mutate" : "read");
      const brokerRequest = defaultBrokerRequest("mqtt.message", "mqtt", args, device);
      if (!brokerRequest || brokerRequest.protocol !== "mqtt") {
        return {
          ok: false,
          error: "MQTT exchange requires at least one topic to subscribe to or a publish_messages entry to send.",
          deviceId: device.id,
        };
      }

      const timeoutMs = clampInt(args.timeout_ms, 1_000, 120_000, mode === "mutate" ? 15_000 : 10_000);
      const actionClass: ActionClass = mode === "read" ? "A" : "B";
      const operation = makeOperation(
        "mqtt.message",
        "mqtt",
        mode,
        undefined,
        "steward_mqtt_exchange:mqtt",
        timeoutMs,
        brokerRequest,
      );

      const policy = evaluatePolicy(
        actionClass,
        device,
        stateStore.getPolicyRules(),
        stateStore.getMaintenanceWindows(),
        {
          blastRadius: "single-device",
          criticality: "low",
          lane: "A",
          recentFailures: 0,
          quarantineActive: false,
        },
      );

      const execution = await executeOperationWithGates(operation, device, {
        actor: "user",
        lane: "A",
        actionClass,
        blastRadius: "single-device",
        policyDecision: policy.decision,
        policyReason: policy.reason,
        approved: true,
        expectedStateHash: computeDeviceStateHash(device),
        runtimeSettings: stateStore.getRuntimeSettings(),
        recentFailures: 0,
        quarantineActive: false,
        allowUnauthenticated: options?.allowPreOnboardingExecution === true,
        allowProvidedCredentials: true,
        idempotencySeed: `steward_mqtt_exchange:${device.id}:${nowIso()}`,
        params: {},
      });

      return {
        ok: execution.ok,
        deviceId: device.id,
        deviceName: device.name,
        adapterId: "mqtt",
        summary: execution.summary,
        reason: execution.ok ? undefined : execution.summary,
        output: execution.output,
        details: execution.details,
        gates: execution.gateResults,
      };
    },
  });

  tools.steward_list_local_tools = dynamicTool({
    description: "List governed local-tool manifests Steward knows about, along with installation state, health, and approval status.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "Optional free-text filter over id, name, description, and capabilities." },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      await localToolRuntime.initialize();
      const query = inputString(args, "query")?.toLowerCase();
      const tools = localToolRuntime.listTools().filter((tool) => {
        if (!query) {
          return true;
        }
        const haystack = [
          tool.id,
          tool.manifest.name,
          tool.manifest.description,
          ...tool.manifest.capabilities,
        ].join("\n").toLowerCase();
        return haystack.includes(query);
      });
      return {
        ok: true,
        count: tools.length,
        tools,
      };
    },
  });

  tools.steward_register_local_tool = dynamicTool({
    description: "Register or update a governed local-tool manifest. Use this to describe a third-party host utility without hardcoding it into Steward.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        manifest: { type: "object", additionalProperties: true },
      },
      required: ["manifest"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const parsed = localToolManifestSchema.safeParse(args.manifest);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.flatten() };
      }
      await localToolRuntime.initialize();
      const tool = localToolRuntime.registerManifest(parsed.data);
      return { ok: true, tool };
    },
  });

  tools.steward_install_local_tool = dynamicTool({
    description: "Install a governed local tool according to Steward policy. If policy requires approval, this call returns the pending approval record instead of bypassing it.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        tool_id: { type: "string", description: "Managed local-tool id." },
      },
      required: ["tool_id"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const toolId = inputString(args, "tool_id");
      if (!toolId) {
        return { ok: false, error: "tool_id is required." };
      }
      await localToolRuntime.initialize();
      return localToolRuntime.installTool(toolId, "steward");
    },
  });

  tools.steward_list_local_tool_approvals = dynamicTool({
    description: "List governed local-tool approval records so Steward can see whether installs or executions are pending, approved, or denied.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        tool_id: { type: "string", description: "Optional local-tool id filter." },
        status: { type: "string", enum: ["pending", "approved", "denied", "expired"], description: "Optional approval status filter." },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      await localToolRuntime.initialize();
      return {
        ok: true,
        approvals: localToolRuntime.listApprovals({
          ...(inputString(args, "tool_id") ? { toolId: inputString(args, "tool_id") } : {}),
          ...(args.status === "pending" || args.status === "approved" || args.status === "denied" || args.status === "expired"
            ? { status: args.status }
            : {}),
        }),
      };
    },
  });

  tools.steward_resolve_local_tool_approval = dynamicTool({
    description: "Approve or deny a governed local-tool approval request.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        approval_id: { type: "string", description: "Pending approval id." },
        decision: { type: "string", enum: ["approve", "deny"], description: "Approval decision." },
        reason: { type: "string", description: "Optional denial reason." },
      },
      required: ["approval_id", "decision"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const approvalId = inputString(args, "approval_id");
      if (!approvalId) {
        return { ok: false, error: "approval_id is required." };
      }
      const decision = inputString(args, "decision");
      const approval = decision === "approve"
        ? localToolRuntime.approveApproval(approvalId, "steward")
        : localToolRuntime.denyApproval(approvalId, "steward", inputString(args, "reason") ?? "");
      if (!approval) {
        return { ok: false, error: `Approval ${approvalId} was not pending.` };
      }
      return { ok: true, approval };
    },
  });

  tools.steward_run_local_tool = dynamicTool({
    description: "Execute a governed local-tool command on the Steward host. The tool must be registered, approved per policy, and constrained to its managed command set.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        tool_id: { type: "string", description: "Managed local-tool id." },
        command: { type: "string", description: "Managed command/bin name from the tool manifest." },
        argv: { type: "array", items: { type: "string" }, description: "Optional argv array." },
        timeout_ms: { type: "integer", description: "Optional execution timeout in milliseconds." },
        install_if_missing: { type: "boolean", description: "Install the tool first if it is not installed yet." },
        health_check_before_run: { type: "boolean", description: "Run the managed health check before execution." },
        approval_reason: { type: "string", description: "Optional approval context if policy gates execution." },
      },
      required: ["tool_id", "command"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const toolId = inputString(args, "tool_id");
      const command = inputString(args, "command");
      if (!toolId || !command) {
        return { ok: false, error: "tool_id and command are required." };
      }
      await localToolRuntime.initialize();
      return localToolRuntime.execute({
        toolId,
        command,
        argv: inputStringArray(args, "argv"),
        timeoutMs: clampInt(args.timeout_ms, 1_000, 15 * 60 * 1000, 60_000),
        installIfMissing: inputBoolean(args, "install_if_missing"),
        healthCheckBeforeRun: inputBoolean(args, "health_check_before_run"),
        approvalReason: inputString(args, "approval_reason"),
      }, "steward");
    },
  });

  tools.steward_list_protocol_sessions = dynamicTool({
    description: "List governed protocol sessions Steward is managing, including status, arbitration mode, leases, and recent connectivity state.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Optional target device id, name, or IP." },
        protocol: { type: "string", enum: ["mqtt", "websocket", "web-session"], description: "Optional session protocol filter." },
        status: { type: "string", enum: ["idle", "connecting", "connected", "blocked", "error", "stopped"], description: "Optional session status filter." },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = inputString(args, "device_id")
        ? await resolveDeviceByTarget(inputString(args, "device_id"), options?.attachedDeviceId)
        : undefined;
      return {
        ok: true,
        sessions: protocolSessionManager.listSessions({
          ...(device ? { deviceId: device.id } : {}),
          ...(args.protocol === "mqtt" || args.protocol === "websocket" || args.protocol === "web-session" ? { protocol: args.protocol } : {}),
          ...(args.status === "idle" || args.status === "connecting" || args.status === "connected" || args.status === "blocked" || args.status === "error" || args.status === "stopped" ? { status: args.status } : {}),
        }),
      };
    },
  });

  tools.steward_open_mqtt_session = dynamicTool({
    description: "Open or renew a persistent managed MQTT session with lease arbitration. Use this for telemetry subscriptions that must stay connected across turns.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP." },
        port: { type: "integer", description: "Optional MQTT port override." },
        secure: { type: "boolean", description: "Optional secure transport override." },
        use_ssl: { type: "boolean", description: "Alias for secure transport." },
        scheme: { type: "string", enum: ["mqtt", "mqtts"], description: "Optional MQTT scheme override." },
        username: { type: "string", description: "Optional MQTT username override." },
        client_id: { type: "string", description: "Optional MQTT client id override." },
        subscribe_topics: { type: "array", items: { type: "string" }, description: "Topics to keep subscribed on the managed session." },
        qos: { type: "integer", description: "Optional MQTT QoS level (0, 1, or 2)." },
        keepalive_sec: { type: "integer", description: "Optional MQTT keepalive in seconds." },
        connect_timeout_ms: { type: "integer", description: "Optional MQTT connect timeout." },
        response_timeout_ms: { type: "integer", description: "Optional response timeout used by the session bootstrap exchange." },
        insecure_skip_verify: { type: "boolean", description: "Skip MQTT TLS verification when true." },
        session_id: { type: "string", description: "Optional explicit session id." },
        session_holder: { type: "string", description: "Optional lease holder label." },
        purpose: { type: "string", description: "Optional session purpose label." },
        arbitration_mode: { type: "string", enum: ["shared", "exclusive", "single-connection"], description: "Optional session arbitration mode." },
        single_connection_hint: { type: "boolean", description: "When true, Steward leases the session as single-connection." },
      },
      required: ["device_id"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        typeof args.device_id === "string" ? args.device_id : undefined,
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const brokerRequest = defaultBrokerRequest("mqtt.message", "mqtt", {
        ...args,
        session_holder: inputString(args, "session_holder") ?? `steward:${device.id}`,
        keep_session_open: true,
      }, device);
      if (!brokerRequest || brokerRequest.protocol !== "mqtt") {
        return { ok: false, error: "At least one subscribe_topics entry is required to open a managed MQTT session." };
      }

      const credentials = stateStore.getDeviceCredentials(device.id)
        .filter((credential) => credential.protocol === "mqtt")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const credential = credentials.find((entry) => entry.status === "provided" || entry.status === "pending") ?? credentials[0];
      try {
        const session = await protocolSessionManager.openPersistentMqttSession({
          device,
          broker: brokerRequest,
          credentialId: credential?.id,
          credentialUsername: brokerRequest.username ?? credential?.accountLabel,
          holder: brokerRequest.sessionHolder ?? `steward:${device.id}`,
          purpose: inputString(args, "purpose") ?? `Managed MQTT session for ${device.name}`,
          sessionId: brokerRequest.sessionId,
          adapterId: "mqtt",
          arbitrationMode: brokerRequest.arbitrationMode,
          singleConnectionHint: brokerRequest.singleConnectionHint,
        });

        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          session,
        };
      } catch (error) {
        return {
          ok: false,
          deviceId: device.id,
          deviceName: device.name,
          error: error instanceof Error ? error.message : "Failed to open managed MQTT session.",
        };
      }
    },
  });

  tools.steward_read_protocol_session_messages = dynamicTool({
    description: "Read recent messages captured by a managed protocol session.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        session_id: { type: "string", description: "Managed protocol session id." },
        limit: { type: "integer", description: "Optional number of recent messages to return." },
      },
      required: ["session_id"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const sessionId = inputString(args, "session_id");
      if (!sessionId) {
        return { ok: false, error: "session_id is required." };
      }
      const session = protocolSessionManager.getSession(sessionId);
      if (!session) {
        return { ok: false, error: `Protocol session ${sessionId} not found.` };
      }
      const limit = clampInt(args.limit, 1, 2_000, 100);
      return {
        ok: true,
        session,
        messages: protocolSessionManager.getMessages(sessionId, limit),
      };
    },
  });

  tools.steward_release_protocol_session = dynamicTool({
    description: "Release the active lease for a managed protocol session so Steward disconnects when policy requires it.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        session_id: { type: "string", description: "Managed protocol session id." },
        lease_id: { type: "string", description: "Optional explicit lease id. Defaults to the session's active lease." },
      },
      required: ["session_id"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const sessionId = inputString(args, "session_id");
      if (!sessionId) {
        return { ok: false, error: "session_id is required." };
      }
      const session = protocolSessionManager.getSession(sessionId);
      if (!session) {
        return { ok: false, error: `Protocol session ${sessionId} not found.` };
      }
      const leaseId = inputString(args, "lease_id") ?? session.activeLeaseId;
      if (!leaseId) {
        return { ok: false, error: `Protocol session ${sessionId} has no active lease.` };
      }
      const lease = protocolSessionManager.releaseLease(leaseId);
      if (!lease) {
        return { ok: false, error: `Lease ${leaseId} was not active.` };
      }
      return {
        ok: true,
        lease,
        session: protocolSessionManager.getSession(sessionId),
      };
    },
  });

  tools.steward_open_web_session = dynamicTool({
    description: "Open or refresh a persistent managed browser session for a web-managed device so Steward can reuse authenticated state across turns.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP." },
        url: { type: "string", description: "Absolute login or landing URL." },
        username: { type: "string", description: "Optional username override." },
        password: { type: "string", description: "Optional password override." },
        use_stored_credentials: { type: "boolean", description: "Use stored http-api credentials when available." },
        username_selector: { type: "string", description: "Optional CSS selector for username field." },
        password_selector: { type: "string", description: "Optional CSS selector for password field." },
        submit_selector: { type: "string", description: "Optional CSS selector for submit button." },
        wait_for_selector: { type: "string", description: "Optional selector expected after successful auth." },
        post_login_wait_ms: { type: "integer", description: "Optional wait after submit." },
        session_id: { type: "string", description: "Optional existing managed web session id." },
        reuse_session: { type: "boolean", description: "Reuse a compatible session when available." },
        reset_session: { type: "boolean", description: "Discard persisted browser state and start fresh." },
      },
      required: ["device_id", "url"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const targetUrl = inputString(args, "url");
      if (!targetUrl) {
        return { ok: false, error: "url is required." };
      }
      const device = await resolveDeviceByTarget(inputString(args, "device_id"), options?.attachedDeviceId);
      if (!device) {
        return { ok: false, error: DEVICE_REQUIRED_ERROR, retryable: false };
      }
      const useStoredCredentials = args.use_stored_credentials !== false;
      const providedUsername = inputString(args, "username");
      const providedPassword = inputRawString(args, "password");
      const stored = useStoredCredentials ? await resolveBrowserCredential(device) : {};
      if (providedUsername === undefined && providedPassword === undefined && stored.unsupportedAuthMode) {
        return {
          ok: false,
          error: `Browser automation cannot apply stored ${httpApiCredentialAuthLabel(stored.unsupportedAuthMode)} credentials. Use broker-backed HTTP/API tools instead.`,
          deviceId: device.id,
          deviceName: device.name,
          credentialId: stored.credentialId,
        };
      }
      return webSessionManager.runBrowserFlow({
        url: targetUrl,
        device,
        sessionId: inputString(args, "session_id"),
        username: providedUsername ?? stored.username,
        password: providedPassword ?? stored.password,
        credentialId: stored.credentialId,
        usernameSelector: inputString(args, "username_selector"),
        passwordSelector: inputString(args, "password_selector"),
        submitSelector: inputString(args, "submit_selector"),
        waitForSelector: inputString(args, "wait_for_selector"),
        postLoginWaitMs: clampInt(args.post_login_wait_ms, 0, 60_000, 1_000),
        collectDiagnostics: true,
        includeHtml: false,
        persistSession: true,
        reuseSession: inputBoolean(args, "reuse_session") !== false,
        resetSession: inputBoolean(args, "reset_session") === true,
        markCredentialValidated: true,
        actor: "steward",
      });
    },
  });

  tools.steward_list_web_flows = dynamicTool({
    description: "List reusable adapter-defined web flows that Steward can run against a device's web UI.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP." },
      },
      required: ["device_id"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(inputString(args, "device_id"), options?.attachedDeviceId);
      if (!device) {
        return { ok: false, error: DEVICE_REQUIRED_ERROR, retryable: false };
      }
      const flows = await adapterRegistry.getDeviceWebFlows(device);
      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        flows: flows.map((entry) => ({
          adapterId: entry.adapterId,
          adapterName: entry.adapterName,
          flowId: entry.flow.id,
          name: entry.flow.name,
          description: entry.flow.description,
          startUrl: entry.flow.startUrl,
          requiresAuth: entry.flow.requiresAuth === true,
          confidence: entry.profileMatch?.confidence ?? null,
          kind: entry.profileMatch?.kind ?? null,
        })),
      };
    },
  });

  tools.steward_execute_web_flow = dynamicTool({
    description: "Execute the best adapter-defined web flow for a device, reusing a managed web session whenever possible.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP." },
        flow_id: { type: "string", description: "Optional explicit flow id." },
        adapter_id: { type: "string", description: "Optional adapter id to narrow matching flows." },
        intent: { type: "string", description: "Optional task intent, such as status, reports, alerts, backups, or settings." },
        reset_session: { type: "boolean", description: "Ignore persisted browser state and start fresh." },
        include_html: { type: "boolean", description: "Include final HTML preview in the result." },
      },
      required: ["device_id"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(inputString(args, "device_id"), options?.attachedDeviceId);
      if (!device) {
        return { ok: false, error: DEVICE_REQUIRED_ERROR, retryable: false };
      }
      const intent = inputString(args, "intent")?.toLowerCase();
      const flowId = inputString(args, "flow_id");
      const adapterId = inputString(args, "adapter_id");
      const flows = (await adapterRegistry.getDeviceWebFlows(device))
        .filter((entry) => !adapterId || entry.adapterId === adapterId)
        .filter((entry) => !flowId || entry.flow.id === flowId);
      if (flows.length === 0) {
        return {
          ok: false,
          error: `No adapter-defined web flows are available for ${device.name}.`,
          deviceId: device.id,
          deviceName: device.name,
        };
      }

      const score = (entry: Awaited<ReturnType<typeof adapterRegistry.getDeviceWebFlows>>[number]): number => {
        let total = (entry.profileMatch?.confidence ?? 0.35) * 100;
        if ((entry.profileMatch?.kind ?? "supporting") === "primary") total += 40;
        if ((entry.profileMatch?.kind ?? "supporting") === "fallback") total += 20;
        if (intent) {
          const text = `${entry.flow.id} ${entry.flow.name} ${entry.flow.description}`.toLowerCase();
          if (text.includes(intent)) total += 50;
          if (intent.includes("status") && /home|status|dashboard/.test(text)) total += 30;
          if (intent.includes("report") && /report|history/.test(text)) total += 30;
          if (intent.includes("backup") && /backup|restore/.test(text)) total += 30;
          if (intent.includes("setting") && /setting|config|admin/.test(text)) total += 30;
        }
        return total;
      };

      const selected = [...flows].sort((left, right) => score(right) - score(left))[0];
      const method = preferredWebAccessMethod(device);
      const startUrl = /^https?:\/\//i.test(selected.flow.startUrl)
        ? selected.flow.startUrl
        : buildDeviceWebUrl(device, method, selected.flow.startUrl);
      const stored = await resolveBrowserCredential(device);
      const waitForSelector = selected.flow.successAssertions?.find((assertion) => assertion.selector)?.selector;
      const result = await webSessionManager.runBrowserFlow({
        url: startUrl,
        device,
        username: stored.username,
        password: stored.password,
        credentialId: stored.credentialId,
        usernameSelector: selected.flow.usernameSelector,
        passwordSelector: selected.flow.passwordSelector,
        submitSelector: selected.flow.submitSelector,
        waitForSelector,
        postLoginWaitMs: selected.flow.postLoginWaitMs,
        collectDiagnostics: true,
        includeHtml: inputBoolean(args, "include_html") === true,
        steps: selected.flow.steps.map((step) => ({
          action: step.action,
          selector: step.selector,
          value: step.value,
          url: step.url,
          script: step.script,
          label: step.label,
          timeout_ms: step.timeoutMs,
        })),
        persistSession: true,
        reuseSession: true,
        resetSession: inputBoolean(args, "reset_session") === true,
        markCredentialValidated: true,
        actor: "steward",
      });
      if (!result.ok) {
        return {
          ...result,
          adapterId: selected.adapterId,
          flowId: selected.flow.id,
          flowName: selected.flow.name,
        };
      }

      const finalUrl = typeof result.finalUrl === "string" ? result.finalUrl : "";
      const preview = typeof result.contentPreview === "string" ? result.contentPreview.toLowerCase() : "";
      for (const assertion of selected.flow.successAssertions ?? []) {
        if (assertion.urlIncludes && !finalUrl.includes(assertion.urlIncludes)) {
          return {
            ok: false,
            error: `Web flow ${selected.flow.id} did not satisfy URL assertion ${assertion.urlIncludes}.`,
            adapterId: selected.adapterId,
            flowId: selected.flow.id,
            result,
          };
        }
        if (assertion.textIncludes && !preview.includes(assertion.textIncludes.toLowerCase())) {
          return {
            ok: false,
            error: `Web flow ${selected.flow.id} did not satisfy text assertion ${assertion.textIncludes}.`,
            adapterId: selected.adapterId,
            flowId: selected.flow.id,
            result,
          };
        }
      }

      return {
        ...result,
        adapterId: selected.adapterId,
        adapterName: selected.adapterName,
        flowId: selected.flow.id,
        flowName: selected.flow.name,
      };
    },
  });

  tools.steward_deep_probe = dynamicTool({
    description: "Run deep device identification (fingerprint + nmap scripts + browser observation + packet intel).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP." },
        include_packet_intel: {
          type: "boolean",
          description: "Include short passive packet-intel capture when enabled in runtime settings.",
        },
      },
      required: ["device_id"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        typeof args.device_id === "string" ? args.device_id : undefined,
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForExplorationToolUse(device, {
        allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const runtime = stateStore.getRuntimeSettings();
      const [nmapAvailable, tsharkAvailable, playwrightAvailable] = await Promise.all([
        localCommandAvailable("nmap"),
        localCommandAvailable("tshark"),
        localPlaywrightAvailable(),
      ]);
      let candidate = candidateFromDevice(device);
      const observations = [...candidate.observations];
      const summary: Record<string, unknown> = {
        toolAvailability: {
          nmap: nmapAvailable,
          tshark: tsharkAvailable,
          playwright: playwrightAvailable,
        },
        fingerprint: {},
        nmap: {
          enabled: runtime.enableAdvancedNmapFingerprint,
          available: nmapAvailable,
          findings: 0,
          reason: runtime.enableAdvancedNmapFingerprint
            ? (nmapAvailable ? "pending" : "nmap_not_installed")
            : "disabled_in_runtime",
        },
        browser: {
          enabled: runtime.enableBrowserObservation,
          available: true,
          playwright: playwrightAvailable,
          findings: 0,
          reason: runtime.enableBrowserObservation ? "pending" : "disabled_in_runtime",
        },
        packetIntel: {
          enabled: runtime.enablePacketIntel,
          available: tsharkAvailable,
          findings: 0,
          reason: runtime.enablePacketIntel
            ? (tsharkAvailable ? "pending" : "tshark_not_installed")
            : "disabled_in_runtime",
        },
      };

      const fingerprint = await fingerprintDevice(candidate, {
        timeoutMs: 3_500,
        enableSnmp: runtime.enableSnmpProbe,
        aggressive: true,
      });
      candidate = {
        ...candidate,
        services: mergeServiceSet(candidate.services, fingerprint.services),
        ...(fingerprint.inferredOs && !candidate.os ? { os: fingerprint.inferredOs } : {}),
        observations: dedupeObservations([...(candidate.observations ?? []), ...fingerprint.observations]),
        metadata: {
          ...candidate.metadata,
          fingerprint: {
            ...(isRecord(candidate.metadata.fingerprint) ? candidate.metadata.fingerprint : {}),
            inferredOs: fingerprint.inferredOs,
            inferredProduct: fingerprint.inferredProduct,
            winrm: fingerprint.winrm,
            dnsService: fingerprint.dnsService,
            mqtt: fingerprint.mqtt,
            netbiosName: fingerprint.netbiosName,
            smbDialect: fingerprint.smbDialect,
            protocolHints: fingerprint.protocolHints,
            lastFingerprintedAt: nowIso(),
          },
        },
      };
      observations.push(...fingerprint.observations);
      summary.fingerprint = {
        inferredOs: fingerprint.inferredOs ?? null,
        inferredProduct: fingerprint.inferredProduct ?? null,
        protocolHints: fingerprint.protocolHints.length,
      };

      if (runtime.enableAdvancedNmapFingerprint && nmapAvailable) {
        const nmapResults = await runNmapDeepFingerprint([candidate], {
          timeoutMs: runtime.nmapFingerprintTimeoutMs,
          maxConcurrency: 1,
        });
        const nmap = nmapResults[0];
        if (nmap) {
          candidate = {
            ...candidate,
            services: mergeServiceSet(candidate.services, nmap.services),
            observations: dedupeObservations([...(candidate.observations ?? []), ...nmap.observations]),
            metadata: {
              ...candidate.metadata,
              nmapDeep: nmap.metadata,
            },
          };
          observations.push(...nmap.observations);
          summary.nmap = {
            enabled: true,
            available: true,
            findings: nmap.metadata.scripts.length,
            scripts: nmap.metadata.scripts.slice(0, 8),
            reason: nmap.metadata.scripts.length > 0 ? "scripts_collected" : "no_script_output",
          };
        } else {
          summary.nmap = {
            enabled: true,
            available: true,
            findings: 0,
            reason: "no_nmap_response",
          };
        }
      }

      if (runtime.enableBrowserObservation && candidate.services.some((service) => WEB_PORT_HINTS.has(service.port))) {
        const browserResults = await observeBrowserSurfaces([candidate], {
          timeoutMs: runtime.browserObservationTimeoutMs,
          maxTargets: 1,
          maxConcurrency: 1,
          captureScreenshots: runtime.browserObservationCaptureScreenshots,
        });
        const browser = browserResults[0];
        if (browser) {
          candidate = {
            ...candidate,
            services: mergeServiceSet(candidate.services, browser.services),
            observations: dedupeObservations([...(candidate.observations ?? []), ...browser.observations]),
            metadata: {
              ...candidate.metadata,
              browserObservation: browser.metadata,
            },
          };
          observations.push(...browser.observations);
          summary.browser = {
            enabled: true,
            available: true,
            playwright: playwrightAvailable,
            findings: browser.metadata.endpoints.length,
            endpoints: browser.metadata.endpoints.slice(0, 4),
            reason: browser.metadata.endpoints.length > 0 ? "surface_profiled" : "no_surface_response",
          };
        } else {
          summary.browser = {
            enabled: true,
            available: true,
            playwright: playwrightAvailable,
            findings: 0,
            reason: "no_surface_response",
          };
        }
      } else if (runtime.enableBrowserObservation) {
        summary.browser = {
          enabled: true,
          available: true,
          playwright: playwrightAvailable,
          findings: 0,
          reason: "no_web_ports_observed",
        };
      }

      const includePacketIntel = args.include_packet_intel !== false;
      if (runtime.enablePacketIntel && includePacketIntel && tsharkAvailable) {
        const packetSnapshot = await collectPacketIntelSnapshot({
          durationSec: runtime.packetIntelDurationSec,
          maxPackets: runtime.packetIntelMaxPackets,
          topTalkers: runtime.packetIntelTopTalkers,
          timeoutMs: Math.max((runtime.packetIntelDurationSec + 4) * 1_000, 4_000),
        });
        const hostIntel = packetSnapshot?.hosts.find((host) => host.ip === device.ip);
        if (packetSnapshot && hostIntel) {
          const filteredPacketObservations = runtime.enableDhcpLeaseIntel
            ? hostIntel.observations
            : hostIntel.observations.filter((observation) => observation.evidenceType !== "dhcp_lease");
          candidate = {
            ...candidate,
            hostname: candidate.hostname ?? hostIntel.hostnameHint,
            observations: dedupeObservations([
              ...(candidate.observations ?? []),
              ...filteredPacketObservations,
            ]),
            metadata: {
              ...candidate.metadata,
              packetIntel: {
                ...hostIntel.metadata,
                collector: packetSnapshot.collector,
                collectedAt: packetSnapshot.collectedAt,
              },
            },
          };
          observations.push(...filteredPacketObservations);
          summary.packetIntel = {
            enabled: true,
            available: true,
            findings: filteredPacketObservations.length,
            topProtocols: hostIntel.metadata.topProtocols,
            topPeers: hostIntel.metadata.topPeers,
            reason: filteredPacketObservations.length > 0 ? "traffic_observed" : "no_traffic_for_target",
          };
        } else if (packetSnapshot) {
          summary.packetIntel = {
            enabled: true,
            available: true,
            findings: 0,
            reason: "no_traffic_for_target",
          };
        } else {
          summary.packetIntel = {
            enabled: true,
            available: true,
            findings: 0,
            reason: "collector_failed",
          };
        }
      } else if (runtime.enablePacketIntel && !includePacketIntel) {
        summary.packetIntel = {
          enabled: true,
          available: tsharkAvailable,
          findings: 0,
          reason: "skipped_by_input",
        };
      }

      const mergedObservations = dedupeObservations(observations);
      if (mergedObservations.length > 0) {
        stateStore.addDiscoveryObservations(mergedObservations);
      }

      const reclassified = candidateToDevice(candidate, device);
      const updatedDevice: Device = {
        ...reclassified,
        metadata: {
          ...reclassified.metadata,
          deepProbe: {
            lastRunAt: nowIso(),
            summary,
          },
        },
        lastSeenAt: nowIso(),
        lastChangedAt: nowIso(),
      };
      await stateStore.upsertDevice(updatedDevice);
      if (updatedDevice.name !== device.name) {
        for (const session of stateStore.getChatSessions()) {
          if (session.deviceId === device.id && session.title.startsWith("[Onboarding]")) {
            stateStore.updateChatSessionTitle(session.id, `[Onboarding] ${updatedDevice.name}`);
          }
        }
      }

      await stateStore.addAction({
        actor: "user",
        kind: "diagnose",
        message: `Deep probe completed for ${device.name}`,
        context: {
          deviceId: device.id,
          nameBefore: device.name,
          nameAfter: updatedDevice.name,
          typeBefore: device.type,
          typeAfter: updatedDevice.type,
          servicesBefore: device.services.length,
          servicesAfter: updatedDevice.services.length,
          observations: mergedObservations.length,
          summary,
        },
      });

      return {
        ok: true,
        deviceId: device.id,
        deviceName: updatedDevice.name,
        deviceType: updatedDevice.type,
        observations: mergedObservations.length,
        services: updatedDevice.services.map((service) => `${service.name}:${service.port}`),
        summary,
      };
    },
  });

  tools.steward_complete_onboarding = dynamicTool({
    description: "Commit onboarding for a device by selecting the adapter, accepted access methods, and any workloads or assurances Steward will own.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        summary: {
          type: "string",
          description: "Short operator-facing summary of the committed responsibility contract.",
        },
        profile_ids: {
          type: "array",
          items: { type: "string" },
          description: "Selected device profile ids to activate.",
        },
        access_method_keys: {
          type: "array",
          items: { type: "string" },
          description: "Accepted access method keys such as ssh:22 or mqtt:8883.",
        },
        workloads: {
          type: "array",
          description: "Optional committed workloads Steward will own after onboarding. Omit to use the current draft, or pass an empty array to commit no ongoing responsibilities.",
          items: {
            type: "object",
            properties: {
              workloadKey: { type: "string" },
              displayName: { type: "string" },
              category: { type: "string" },
              criticality: { type: "string", enum: ["low", "medium", "high"] },
              summary: { type: "string" },
            },
            required: ["workloadKey", "displayName", "criticality"],
            additionalProperties: false,
          },
        },
        assurances: {
          type: "array",
          description: "Optional committed assurances/checks Steward will keep running for the device. Omit to use the current draft, or pass an empty array to commit no ongoing monitoring.",
          items: {
            type: "object",
            properties: {
              assuranceKey: { type: "string" },
              workloadKey: { type: "string" },
              displayName: { type: "string" },
              criticality: { type: "string", enum: ["low", "medium", "high"] },
              desiredState: { type: "string", enum: ["running", "stopped"] },
              checkIntervalSec: { type: "integer" },
              monitorType: { type: "string" },
              requiredProtocols: {
                type: "array",
                items: { type: "string" },
              },
              rationale: { type: "string" },
            },
            required: ["assuranceKey", "displayName", "criticality", "checkIntervalSec"],
            additionalProperties: false,
          },
        },
        residual_unknowns: {
          type: "array",
          items: { type: "string" },
          description: "Any explicitly acknowledged unknowns or follow-up risks that remain after completion.",
        },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const snapshot = await completeDeviceOnboarding({
        deviceId: device.id,
        summary: inputString(args, "summary") ?? undefined,
        selectedProfileIds: Array.isArray(args.profile_ids)
          ? args.profile_ids.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : undefined,
        selectedAccessMethodKeys: Array.isArray(args.access_method_keys)
          ? args.access_method_keys.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : undefined,
        workloads: Array.isArray(args.workloads)
          ? args.workloads
            .filter(isRecord)
            .map((entry) => ({
              workloadKey: inputString(entry, "workloadKey") ?? "",
              displayName: inputString(entry, "displayName") ?? "",
              category: (inputString(entry, "category") ?? "unknown") as OnboardingDraftWorkload["category"],
              criticality: inputString(entry, "criticality") === "high" || inputString(entry, "criticality") === "low"
                ? inputString(entry, "criticality") as "low" | "medium" | "high"
                : "medium",
              summary: inputString(entry, "summary") ?? undefined,
            }))
          : undefined,
        assurances: Array.isArray(args.assurances)
          ? args.assurances
            .filter(isRecord)
            .map((entry) => ({
              assuranceKey: inputString(entry, "assuranceKey") ?? "",
              workloadKey: inputString(entry, "workloadKey") ?? undefined,
              displayName: inputString(entry, "displayName") ?? "",
              criticality: inputString(entry, "criticality") === "high" || inputString(entry, "criticality") === "low"
                ? inputString(entry, "criticality") as "low" | "medium" | "high"
                : "medium",
              desiredState: (inputString(entry, "desiredState") === "stopped" ? "stopped" : "running") as OnboardingDraftAssurance["desiredState"],
              checkIntervalSec: clampInt(entry.checkIntervalSec, 15, 3600, 120),
              monitorType: inputString(entry, "monitorType") ?? undefined,
              requiredProtocols: Array.isArray(entry.requiredProtocols)
                ? entry.requiredProtocols.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
                : [],
              rationale: inputString(entry, "rationale") ?? undefined,
            }))
          : undefined,
        residualUnknowns: Array.isArray(args.residual_unknowns)
          ? args.residual_unknowns.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : undefined,
        actor: "user",
      });

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        runId: snapshot.run?.id,
        onboardingStatus: snapshot.run?.status,
        selectedProfiles: snapshot.profiles
          .filter((profile) => ["selected", "verified", "active"].includes(profile.status))
          .map((profile) => ({
            profileId: profile.profileId,
            name: profile.name,
            status: profile.status,
          })),
        selectedAccessMethods: snapshot.accessMethods
          .filter((method) => method.selected)
          .map((method) => ({
            key: method.key,
            kind: method.kind,
            title: method.title,
            status: method.status,
          })),
        workloadsCommitted: snapshot.workloads.length,
        assurancesCommitted: snapshot.assurances.length,
        summary: snapshot.run?.summary ?? snapshot.draft?.summary ?? `Onboarding completed for ${device.name}.`,
        residualUnknowns: snapshot.draft?.residualUnknowns ?? [],
      };
    },
  });

  tools.steward_list_adapters = dynamicTool({
    description: "List Steward adapter packages, including built-in and custom adapters, their capabilities, status, and tool skills. Use this before creating a new adapter so you can reuse or extend an existing package when possible.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Optional device id, name, or IP. When provided, Steward returns device-scoped matched adapters first instead of a generic package list.",
        },
        query: {
          type: "string",
          description: "Optional free-text filter matched against adapter id, name, description, author, and skill names.",
        },
        provides: {
          type: "array",
          items: { type: "string" },
          description: "Optional capability filter such as profile, protocol, discovery, enrichment, or playbooks.",
        },
        enabled_only: {
          type: "boolean",
          description: "When true, only return enabled adapters.",
        },
        tool_query: {
          type: "string",
          description: "Optional filter matched against tool skill ids, names, descriptions, and tool call names.",
        },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      await adapterRegistry.initialize();
      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      const query = inputString(args, "query")?.toLowerCase();
      const provides = (inputStringArray(args, "provides") ?? []).map((value) => value.toLowerCase());
      const enabledOnly = inputBoolean(args, "enabled_only") === true;
      const toolQuery = inputString(args, "tool_query")?.toLowerCase();

      let records = adapterRegistry.getAdapterRecords().filter((record) => {
        if (enabledOnly && !record.enabled) {
          return false;
        }
        if (device && !record.provides.includes("profile")) {
          return false;
        }
        if (provides.length > 0 && !provides.every((capability) => record.provides.some((provided) => provided === capability))) {
          return false;
        }
        if (query) {
          const haystack = [
            record.id,
            record.name,
            record.description,
            record.author,
            ...record.toolSkills.map((skill) => skill.id),
            ...record.toolSkills.map((skill) => skill.name),
          ].join("\n").toLowerCase();
          if (!haystack.includes(query)) {
            return false;
          }
        }
        if (toolQuery) {
          const matched = record.toolSkills.some((skill) =>
            [
              skill.id,
              skill.name,
              skill.description,
              skill.toolCall?.name ?? "",
            ].join("\n").toLowerCase().includes(toolQuery)
          );
          if (!matched) {
            return false;
          }
        }
        return true;
      });

      let matchedAdapters: Array<Record<string, unknown>> = [];
      if (device) {
        const matches = await adapterRegistry.getDeviceProfileMatches(device);
        const matchedIds = new Set(matches.map((match) => match.adapterId));
        matchedAdapters = matches.map((match) => ({
          adapterId: match.adapterId,
          profileId: match.profileId ?? null,
          name: match.name,
          kind: match.kind ?? "primary",
          confidence: match.confidence ?? null,
          summary: match.summary ?? null,
          requiredAccessMethods: match.requiredAccessMethods ?? [],
          requiredCredentialProtocols: match.requiredCredentialProtocols ?? [],
        }));
        if (matchedAdapters.length === 0) {
          matchedAdapters = inferFallbackMatchedAdapters(device);
          for (const match of matchedAdapters) {
            if (typeof match.adapterId === "string") {
              matchedIds.add(match.adapterId);
            }
          }
        }
        if (matchedIds.size > 0) {
          records = records.filter((record) => matchedIds.has(record.id));
        }
      }

      const scopedAdapters = device
        ? matchedAdapters.map((match) => {
          const record = records.find((candidate) => candidate.id === match.adapterId);
          return record ? summarizeAdapterRecord(record) : {
            id: match.adapterId,
            name: match.name,
            description: match.summary,
            provides: ["profile"],
          };
        })
        : records.map((record) => summarizeAdapterRecord(record));

      return {
        ok: true,
        ...(device
          ? {
            deviceId: device.id,
            deviceName: device.name,
            matchedAdapterCount: matchedAdapters.length,
            matchedAdapters,
          }
          : {}),
        count: device ? matchedAdapters.length : records.length,
        adapters: scopedAdapters,
      };
    },
  });

  tools.steward_get_adapter_package = dynamicTool({
    description: "Read a full adapter package, including manifest, entry source, and Markdown guidance. Use this to inspect existing adapters before extending them or using one as a template for a new device family.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        adapter_id: {
          type: "string",
          description: "Adapter id to inspect.",
        },
        include_entry_source: {
          type: "boolean",
          description: "When false, omit the adapter entry source code.",
        },
        include_markdown: {
          type: "boolean",
          description: "When false, omit adapter and tool Markdown guidance files.",
        },
      },
      required: ["adapter_id"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const adapterId = inputString(args, "adapter_id");
      if (!adapterId) {
        return { ok: false, error: "adapter_id is required." };
      }

      try {
        await adapterRegistry.initialize();
        const pkg = adapterRegistry.getAdapterPackageById(adapterId);
        if (!pkg) {
          return { ok: false, error: `Adapter ${adapterId} not found.` };
        }

        return {
          ok: true,
          adapterId,
          ...buildAdapterPackagePayload(pkg, {
            includeEntrySource: inputBoolean(args, "include_entry_source") !== false,
            includeMarkdown: inputBoolean(args, "include_markdown") !== false,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : `Failed to load adapter ${adapterId}.`,
        };
      }
    },
  });

  tools.steward_create_adapter_package = dynamicTool({
    description: "Create a real adapter package in Steward, backed by the same registry and package files as the adapters page. Use this after research when a device or vendor needs new adapter coverage.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        manifest: {
          type: "object",
          description: "Full adapter manifest object.",
          additionalProperties: true,
        },
        entry_source: {
          type: "string",
          description: "Complete adapter entry source code.",
        },
        adapter_skill_md: {
          type: "string",
          description: "Optional adapter-level Markdown guidance.",
        },
        tool_skill_md: {
          type: "object",
          description: "Optional map of tool skill id to Markdown guidance.",
          additionalProperties: { type: "string" },
        },
        include_package: {
          type: "boolean",
          description: "When true, include the resulting adapter package contents in the response.",
        },
        include_entry_source: {
          type: "boolean",
          description: "When include_package is true, include the entry source code unless false.",
        },
        include_markdown: {
          type: "boolean",
          description: "When include_package is true, include Markdown guidance unless false.",
        },
      },
      required: ["manifest", "entry_source"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      if (!isRecord(args.manifest)) {
        return { ok: false, error: "manifest must be an object." };
      }
      const entrySource = inputString(args, "entry_source");
      if (!entrySource) {
        return { ok: false, error: "entry_source is required." };
      }

      try {
        const created = await adapterRegistry.createAdapterPackage({
          manifest: cloneJsonValue(args.manifest),
          entrySource,
          adapterSkillMd: inputString(args, "adapter_skill_md"),
          toolSkillMd: readStringRecord(args.tool_skill_md),
        }, { actor: "steward" });
        const pkg = inputBoolean(args, "include_package")
          ? adapterRegistry.getAdapterPackageById(created.id)
          : undefined;

        return {
          ok: true,
          adapterId: created.id,
          adapterName: created.name,
          summary: `Created adapter ${created.name}. Newly added chat tool calls become available on subsequent requests, not earlier in the same turn.`,
          adapter: summarizeAdapterRecord(created),
          ...(pkg
            ? {
              package: buildAdapterPackagePayload(pkg, {
                includeEntrySource: inputBoolean(args, "include_entry_source") !== false,
                includeMarkdown: inputBoolean(args, "include_markdown") !== false,
              }),
            }
            : {}),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Failed to create adapter package.",
        };
      }
    },
  });

  tools.steward_update_adapter_package = dynamicTool({
    description: "Update an existing adapter package by replacing its manifest and entry source with a full new package definition.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        adapter_id: {
          type: "string",
          description: "Existing adapter id to update.",
        },
        manifest: {
          type: "object",
          description: "Full replacement adapter manifest object. Its id must match adapter_id.",
          additionalProperties: true,
        },
        entry_source: {
          type: "string",
          description: "Complete replacement adapter entry source code.",
        },
        adapter_skill_md: {
          type: "string",
          description: "Optional replacement adapter-level Markdown guidance.",
        },
        tool_skill_md: {
          type: "object",
          description: "Optional replacement map of tool skill id to Markdown guidance.",
          additionalProperties: { type: "string" },
        },
        include_package: {
          type: "boolean",
          description: "When true, include the resulting adapter package contents in the response.",
        },
        include_entry_source: {
          type: "boolean",
          description: "When include_package is true, include the entry source code unless false.",
        },
        include_markdown: {
          type: "boolean",
          description: "When include_package is true, include Markdown guidance unless false.",
        },
      },
      required: ["adapter_id", "manifest", "entry_source"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const adapterId = inputString(args, "adapter_id");
      if (!adapterId) {
        return { ok: false, error: "adapter_id is required." };
      }
      if (!isRecord(args.manifest)) {
        return { ok: false, error: "manifest must be an object." };
      }
      const entrySource = inputString(args, "entry_source");
      if (!entrySource) {
        return { ok: false, error: "entry_source is required." };
      }

      try {
        await adapterRegistry.initialize();
        const existingPackage = adapterRegistry.getAdapterPackageById(adapterId);
        if (!existingPackage) {
          return { ok: false, error: `Adapter ${adapterId} not found.` };
        }

        const updated = await adapterRegistry.updateAdapterPackage(adapterId, {
          manifest: cloneJsonValue(args.manifest),
          entrySource,
          adapterSkillMd: inputString(args, "adapter_skill_md") ?? existingPackage.adapterSkillMd,
          toolSkillMd: Object.keys(readStringRecord(args.tool_skill_md)).length > 0
            ? readStringRecord(args.tool_skill_md)
            : existingPackage.toolSkillMd,
        }, { actor: "steward" });
        const pkg = inputBoolean(args, "include_package")
          ? adapterRegistry.getAdapterPackageById(updated.id)
          : undefined;

        return {
          ok: true,
          adapterId: updated.id,
          adapterName: updated.name,
          summary: `Updated adapter ${updated.name}. Existing tool calls will use the refreshed config on subsequent executions.`,
          adapter: summarizeAdapterRecord(updated),
          ...(pkg
            ? {
              package: buildAdapterPackagePayload(pkg, {
                includeEntrySource: inputBoolean(args, "include_entry_source") !== false,
                includeMarkdown: inputBoolean(args, "include_markdown") !== false,
              }),
            }
            : {}),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : `Failed to update adapter ${adapterId}.`,
        };
      }
    },
  });

  tools.steward_add_adapter_tool = dynamicTool({
    description: "Add or update a tool skill on an existing adapter package. Use this when Steward knows the adapter but needs new operational tools for a device family.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        adapter_id: {
          type: "string",
          description: "Adapter id to extend.",
        },
        skill: {
          type: "object",
          description: "Adapter tool skill object to insert or update.",
          additionalProperties: true,
        },
        replace_existing: {
          type: "boolean",
          description: "When false, fail if the adapter already has a tool skill with the same id. Defaults to true.",
        },
        manifest_patch: {
          type: "object",
          description: "Optional shallow manifest patch merged before the tool skill is saved. Do not include id or toolSkills here.",
          additionalProperties: true,
        },
        version: {
          type: "string",
          description: "Optional explicit manifest version to write after the patch.",
        },
        tool_skill_md: {
          type: "string",
          description: "Optional Markdown guidance for this tool skill.",
        },
        adapter_skill_md: {
          type: "string",
          description: "Optional replacement adapter-level Markdown guidance.",
        },
        tool_config: {
          type: "object",
          description: "Optional persisted tool config patch for this skill, for example {\"enabled\": true}.",
          additionalProperties: true,
        },
        entry_source_mode: {
          type: "string",
          enum: ["preserve", "append", "replace"],
          description: "How to handle adapter entry source. Defaults to preserve.",
        },
        entry_source: {
          type: "string",
          description: "Entry source content used when entry_source_mode is append or replace.",
        },
        include_package: {
          type: "boolean",
          description: "When true, include the resulting adapter package contents in the response.",
        },
        include_entry_source: {
          type: "boolean",
          description: "When include_package is true, include the entry source code unless false.",
        },
        include_markdown: {
          type: "boolean",
          description: "When include_package is true, include Markdown guidance unless false.",
        },
      },
      required: ["adapter_id", "skill"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const adapterId = inputString(args, "adapter_id");
      if (!adapterId) {
        return { ok: false, error: "adapter_id is required." };
      }
      if (!isRecord(args.skill)) {
        return { ok: false, error: "skill must be an object." };
      }

      const skillId = inputString(args.skill, "id");
      if (!skillId) {
        return { ok: false, error: "skill.id is required." };
      }

      try {
        await adapterRegistry.initialize();
        const pkg = adapterRegistry.getAdapterPackageById(adapterId);
        if (!pkg) {
          return { ok: false, error: `Adapter ${adapterId} not found.` };
        }

        const manifest = isRecord(pkg.manifest) ? cloneJsonValue(pkg.manifest) : {};
        const manifestPatch = isRecord(args.manifest_patch) ? cloneJsonValue(args.manifest_patch) : {};

        if (manifestPatch.id !== undefined && String(manifestPatch.id) !== adapterId) {
          return { ok: false, error: "manifest_patch.id cannot change the adapter id." };
        }
        delete manifestPatch.id;
        delete manifestPatch.toolSkills;

        const replaceExisting = inputBoolean(args, "replace_existing") !== false;
        const skillInput = cloneJsonValue(args.skill) as unknown as AdapterToolSkill;
        const { manifest: nextManifestWithSkill, replaced } = upsertAdapterToolSkillInManifest(
          { ...manifest, ...manifestPatch },
          skillInput,
          replaceExisting,
        );

        const version = inputString(args, "version");
        const nextManifest = version
          ? { ...nextManifestWithSkill, version }
          : nextManifestWithSkill;

        const entrySourceMode = inputString(args, "entry_source_mode") ?? "preserve";
        const entrySourceInput = inputString(args, "entry_source");
        let nextEntrySource = pkg.entrySource;
        if (entrySourceMode === "replace") {
          if (!entrySourceInput) {
            return { ok: false, error: "entry_source is required when entry_source_mode is replace." };
          }
          nextEntrySource = entrySourceInput;
        } else if (entrySourceMode === "append") {
          if (!entrySourceInput) {
            return { ok: false, error: "entry_source is required when entry_source_mode is append." };
          }
          nextEntrySource = `${pkg.entrySource.trimEnd()}\n\n${entrySourceInput.trim()}\n`;
        } else if (entrySourceMode !== "preserve") {
          return { ok: false, error: `Unsupported entry_source_mode: ${entrySourceMode}` };
        }

        const nextToolSkillMd = {
          ...pkg.toolSkillMd,
          ...(
            typeof args.tool_skill_md === "string" && args.tool_skill_md.trim().length > 0
              ? { [skillId]: args.tool_skill_md }
              : {}
          ),
        };

        const updated = await adapterRegistry.updateAdapterPackage(adapterId, {
          manifest: nextManifest,
          entrySource: nextEntrySource,
          adapterSkillMd: inputString(args, "adapter_skill_md") ?? pkg.adapterSkillMd,
          toolSkillMd: nextToolSkillMd,
        }, { actor: "steward" });

        if (isRecord(args.tool_config) && Object.keys(args.tool_config).length > 0) {
          await adapterRegistry.updateAdapterConfig(adapterId, {
            toolConfig: {
              [skillId]: cloneJsonValue(args.tool_config),
            },
          }, { actor: "steward" });
        }

        const refreshedPackage = inputBoolean(args, "include_package")
          ? adapterRegistry.getAdapterPackageById(adapterId)
          : undefined;

        return {
          ok: true,
          adapterId: updated.id,
          adapterName: updated.name,
          skillId,
          skillName: inputString(args.skill, "name") ?? skillId,
          replaced,
          summary: `${replaced ? "Updated" : "Added"} adapter tool ${inputString(args.skill, "name") ?? skillId} on ${updated.name}. Refreshed execution config applies to subsequent tool executions.`,
          adapter: summarizeAdapterRecord(updated),
          ...(refreshedPackage
            ? {
              package: buildAdapterPackagePayload(refreshedPackage, {
                includeEntrySource: inputBoolean(args, "include_entry_source") !== false,
                includeMarkdown: inputBoolean(args, "include_markdown") !== false,
              }),
            }
            : {}),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : `Failed to extend adapter ${adapterId}.`,
        };
      }
    },
  });

  tools.steward_list_contract = dynamicTool({
    description: "Read the committed Steward contract for a device, including responsibilities and assurances. Use this before editing or deleting contract items when ids or exact names are unclear.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForContractToolUse(device);
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const snapshot = buildContractSnapshotPayload(device.id);
      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        summary: summarizeDeviceContractForPrompt(device.id),
        responsibilityCount: snapshot.responsibilities.length,
        assuranceCount: snapshot.assurances.length,
        responsibilities: snapshot.responsibilities,
        assurances: snapshot.assurances,
      };
    },
  });

  tools.steward_add_responsibility = dynamicTool({
    description: "Add a committed Steward responsibility for the attached device. Use this after enabling or installing something new that Steward should own ongoing.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        display_name: {
          type: "string",
          description: "Operator-facing name for the responsibility, for example Plex Media Server or Printer availability.",
        },
        responsibility_key: {
          type: "string",
          description: "Optional stable key. If omitted, Steward derives one from the display name.",
        },
        category: {
          type: "string",
          enum: ["application", "platform", "data", "network", "perimeter", "storage", "telemetry", "background", "unknown"],
          description: "Responsibility category. Optional; Steward can infer a reasonable default.",
        },
        criticality: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Operational importance. Defaults to medium.",
        },
        summary: {
          type: "string",
          description: "Optional one-paragraph summary of what Steward is responsible for.",
        },
      },
      required: ["display_name"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const displayName = inputString(args, "display_name", "name");
      if (!displayName) {
        return { ok: false, error: "display_name is required." };
      }

      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForContractToolUse(device);
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const responsibility = await createResponsibility({
        device,
        displayName,
        workloadKey: inputString(args, "responsibility_key", "workload_key"),
        category: parseWorkloadCategory(args.category),
        criticality: parseCriticality(args.criticality),
        summary: inputString(args, "summary"),
        metadata: {
          actor: "user",
          workloadSource: "operator",
          method: "assistant_tool",
          origin: "chat_contract_tool",
        },
      });
      const snapshot = buildContractSnapshotPayload(device.id);

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        responsibility: summarizeResponsibilityEntry(responsibility),
        responsibilityCount: snapshot.responsibilities.length,
        assuranceCount: snapshot.assurances.length,
        responsibilities: snapshot.responsibilities,
      };
    },
  });

  tools.steward_update_responsibility = dynamicTool({
    description: "Edit a committed Steward responsibility by id, key, or exact display name.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        responsibility_id: { type: "string" },
        responsibility_key: { type: "string" },
        responsibility_name: { type: "string", description: "Exact current display name when id/key are unknown." },
        display_name: { type: "string", description: "New display name." },
        category: {
          type: "string",
          enum: ["application", "platform", "data", "network", "perimeter", "storage", "telemetry", "background", "unknown"],
        },
        criticality: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
        summary: { type: "string", description: "Replacement summary text." },
        clear_summary: { type: "boolean", description: "Clear the current summary." },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForContractToolUse(device);
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const resolved = resolveResponsibilityForDevice(device.id, {
        id: inputString(args, "responsibility_id"),
        key: inputString(args, "responsibility_key"),
        name: inputString(args, "responsibility_name"),
      });
      if (!resolved.ok || !resolved.value) {
        return {
          ok: false,
          error: resolved.error ?? "Responsibility not found.",
          matches: resolved.matches ?? [],
        };
      }

      const responsibility = await updateResponsibility({
        device,
        responsibility: resolved.value,
        displayName: inputString(args, "display_name"),
        category: parseWorkloadCategory(args.category),
        criticality: parseCriticality(args.criticality),
        summary: inputString(args, "summary"),
        clearSummary: inputBoolean(args, "clear_summary") === true,
        metadata: {
          actor: "user",
          workloadSource: "operator",
          method: "assistant_tool",
          origin: "chat_contract_tool",
        },
      });
      const snapshot = buildContractSnapshotPayload(device.id);

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        responsibility: summarizeResponsibilityEntry(responsibility),
        responsibilityCount: snapshot.responsibilities.length,
        assuranceCount: snapshot.assurances.length,
        responsibilities: snapshot.responsibilities,
      };
    },
  });

  tools.steward_delete_responsibility = dynamicTool({
    description: "Delete a committed Steward responsibility by id, key, or exact display name. Any linked assurances are deleted with it.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        responsibility_id: { type: "string" },
        responsibility_key: { type: "string" },
        responsibility_name: { type: "string", description: "Exact current display name when id/key are unknown." },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForContractToolUse(device);
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const resolved = resolveResponsibilityForDevice(device.id, {
        id: inputString(args, "responsibility_id"),
        key: inputString(args, "responsibility_key"),
        name: inputString(args, "responsibility_name"),
      });
      if (!resolved.ok || !resolved.value) {
        return {
          ok: false,
          error: resolved.error ?? "Responsibility not found.",
          matches: resolved.matches ?? [],
        };
      }

      const deleted = await deleteResponsibility({
        device,
        responsibility: resolved.value,
        metadata: {
          actor: "user",
          workloadSource: "operator",
          method: "assistant_tool",
          origin: "chat_contract_tool",
        },
      });
      const snapshot = buildContractSnapshotPayload(device.id);

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        deletedResponsibility: summarizeResponsibilityEntry(deleted.responsibility),
        deletedAssuranceCount: deleted.deletedAssuranceCount,
        responsibilityCount: snapshot.responsibilities.length,
        assuranceCount: snapshot.assurances.length,
        responsibilities: snapshot.responsibilities,
        assurances: snapshot.assurances,
      };
    },
  });

  tools.steward_add_assurance = dynamicTool({
    description: "Add a committed Steward assurance for the attached device. Link it to an existing responsibility so Steward knows what outcome it is protecting.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        display_name: {
          type: "string",
          description: "Operator-facing assurance name, for example Plex HTTP reachability or Print failure alert.",
        },
        assurance_key: {
          type: "string",
          description: "Optional stable key. If omitted, Steward derives one from the display name.",
        },
        responsibility_id: { type: "string" },
        responsibility_key: { type: "string" },
        responsibility_name: { type: "string", description: "Exact existing responsibility name when id/key are unknown." },
        criticality: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Operational importance. Defaults to medium.",
        },
        desired_state: {
          type: "string",
          enum: ["running", "stopped"],
          description: "Desired enforcement state. Defaults to running.",
        },
        check_interval_sec: {
          type: "integer",
          description: "Evaluation interval in seconds. Defaults to 120.",
        },
        monitor_type: {
          type: "string",
          description: "Optional monitor type such as http, mqtt, or process.",
        },
        required_protocols: {
          type: "array",
          items: { type: "string" },
          description: "Optional protocols Steward needs to perform the check.",
        },
        rationale: {
          type: "string",
          description: "Optional explanation of what the assurance protects or why it matters.",
        },
      },
      required: ["display_name"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const displayName = inputString(args, "display_name", "name");
      if (!displayName) {
        return { ok: false, error: "display_name is required." };
      }

      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForContractToolUse(device);
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const responsibilitySelector = {
        id: inputString(args, "responsibility_id"),
        key: inputString(args, "responsibility_key"),
        name: inputString(args, "responsibility_name"),
      };
      const hasResponsibilitySelector = Boolean(
        responsibilitySelector.id || responsibilitySelector.key || responsibilitySelector.name,
      );
      if (!hasResponsibilitySelector) {
        return {
          ok: false,
          error: "Link the assurance to an existing responsibility with responsibility_id, responsibility_key, or responsibility_name. Add the responsibility first if needed.",
        };
      }

      const resolvedResponsibility = resolveResponsibilityForDevice(device.id, responsibilitySelector);
      if (!resolvedResponsibility.ok || !resolvedResponsibility.value) {
        return {
          ok: false,
          error: resolvedResponsibility.error ?? "Responsibility not found.",
          matches: resolvedResponsibility.matches ?? [],
        };
      }

      const assurance = await createAssurance({
        device,
        displayName,
        assuranceKey: inputString(args, "assurance_key"),
        workloadId: resolvedResponsibility.value.id,
        criticality: parseCriticality(args.criticality),
        desiredState: parseDesiredState(args.desired_state),
        checkIntervalSec: clampInt(args.check_interval_sec, 15, 3600, 120),
        monitorType: inputString(args, "monitor_type"),
        requiredProtocols: inputStringArray(args, "required_protocols"),
        rationale: inputString(args, "rationale"),
        metadata: {
          actor: "user",
          workloadSource: "operator",
          method: "assistant_tool",
          origin: "chat_contract_tool",
        },
      });
      const snapshot = buildContractSnapshotPayload(device.id);

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        assurance: summarizeAssuranceEntry(
          assurance,
          new Map(stateStore.getWorkloads(device.id).map((item) => [item.id, item])),
        ),
        responsibilityCount: snapshot.responsibilities.length,
        assuranceCount: snapshot.assurances.length,
        assurances: snapshot.assurances,
      };
    },
  });

  tools.steward_update_assurance = dynamicTool({
    description: "Edit a committed Steward assurance by id, key, or exact display name.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        assurance_id: { type: "string" },
        assurance_key: { type: "string" },
        assurance_name: { type: "string", description: "Exact current assurance name when id/key are unknown." },
        display_name: { type: "string", description: "New display name." },
        responsibility_id: { type: "string", description: "Move this assurance to another existing responsibility." },
        responsibility_key: { type: "string", description: "Move this assurance to another existing responsibility." },
        responsibility_name: { type: "string", description: "Exact name of another existing responsibility." },
        criticality: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
        desired_state: {
          type: "string",
          enum: ["running", "stopped"],
        },
        check_interval_sec: { type: "integer" },
        monitor_type: { type: "string" },
        clear_monitor_type: { type: "boolean" },
        required_protocols: {
          type: "array",
          items: { type: "string" },
        },
        clear_required_protocols: { type: "boolean" },
        rationale: { type: "string" },
        clear_rationale: { type: "boolean" },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForContractToolUse(device);
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const resolvedAssurance = resolveAssuranceForDevice(device.id, {
        id: inputString(args, "assurance_id"),
        key: inputString(args, "assurance_key"),
        name: inputString(args, "assurance_name"),
      });
      if (!resolvedAssurance.ok || !resolvedAssurance.value) {
        return {
          ok: false,
          error: resolvedAssurance.error ?? "Assurance not found.",
          matches: resolvedAssurance.matches ?? [],
        };
      }

      let targetResponsibilityId: string | undefined;
      const responsibilitySelector = {
        id: inputString(args, "responsibility_id"),
        key: inputString(args, "responsibility_key"),
        name: inputString(args, "responsibility_name"),
      };
      if (responsibilitySelector.id || responsibilitySelector.key || responsibilitySelector.name) {
        const resolvedResponsibility = resolveResponsibilityForDevice(device.id, responsibilitySelector);
        if (!resolvedResponsibility.ok || !resolvedResponsibility.value) {
          return {
            ok: false,
            error: resolvedResponsibility.error ?? "Responsibility not found.",
            matches: resolvedResponsibility.matches ?? [],
          };
        }
        targetResponsibilityId = resolvedResponsibility.value.id;
      }

      const assurance = await updateAssurance({
        device,
        assurance: resolvedAssurance.value,
        workloadId: targetResponsibilityId,
        displayName: inputString(args, "display_name"),
        criticality: parseCriticality(args.criticality),
        desiredState: parseDesiredState(args.desired_state),
        checkIntervalSec: typeof args.check_interval_sec === "number"
          ? clampInt(args.check_interval_sec, 15, 3600, resolvedAssurance.value.checkIntervalSec)
          : undefined,
        monitorType: inputString(args, "monitor_type"),
        clearMonitorType: inputBoolean(args, "clear_monitor_type") === true,
        requiredProtocols: inputStringArray(args, "required_protocols"),
        clearRequiredProtocols: inputBoolean(args, "clear_required_protocols") === true,
        rationale: inputString(args, "rationale"),
        clearRationale: inputBoolean(args, "clear_rationale") === true,
        metadata: {
          actor: "user",
          workloadSource: "operator",
          method: "assistant_tool",
          origin: "chat_contract_tool",
        },
      });
      const snapshot = buildContractSnapshotPayload(device.id);

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        assurance: summarizeAssuranceEntry(
          assurance,
          new Map(stateStore.getWorkloads(device.id).map((item) => [item.id, item])),
        ),
        responsibilityCount: snapshot.responsibilities.length,
        assuranceCount: snapshot.assurances.length,
        assurances: snapshot.assurances,
      };
    },
  });

  tools.steward_delete_assurance = dynamicTool({
    description: "Delete a committed Steward assurance by id, key, or exact display name.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        assurance_id: { type: "string" },
        assurance_key: { type: "string" },
        assurance_name: { type: "string", description: "Exact current assurance name when id/key are unknown." },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForContractToolUse(device);
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const resolved = resolveAssuranceForDevice(device.id, {
        id: inputString(args, "assurance_id"),
        key: inputString(args, "assurance_key"),
        name: inputString(args, "assurance_name"),
      });
      if (!resolved.ok || !resolved.value) {
        return {
          ok: false,
          error: resolved.error ?? "Assurance not found.",
          matches: resolved.matches ?? [],
        };
      }

      const assurance = await deleteAssurance({
        device,
        assurance: resolved.value,
        metadata: {
          actor: "user",
          workloadSource: "operator",
          method: "assistant_tool",
          origin: "chat_contract_tool",
        },
      });
      const snapshot = buildContractSnapshotPayload(device.id);

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        deletedAssurance: summarizeAssuranceEntry(
          assurance,
          new Map(stateStore.getWorkloads(device.id).map((item) => [item.id, item])),
        ),
        responsibilityCount: snapshot.responsibilities.length,
        assuranceCount: snapshot.assurances.length,
        assurances: snapshot.assurances,
      };
    },
  });

  tools.steward_lookup_oui = dynamicTool({
    description: "Look up a MAC address or OUI prefix in Steward's local IEEE-backed OUI database. Use this instead of public web research for vendor identification from MAC prefixes.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        mac: {
          type: "string",
          description: "Full MAC address or OUI prefix such as 00:55:DA or 00:55:DA:52:EE:6B.",
        },
      },
      required: ["mac"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const rawMac = typeof args.mac === "string" ? args.mac.trim() : "";
      if (!rawMac) {
        return { ok: false, error: "mac is required." };
      }

      const normalized = rawMac.toLowerCase().replace(/-/g, ":");
      const prefix = normalized.slice(0, 8);
      const vendor = lookupOuiVendor(normalized);
      const stats = getOuiStats();

      return {
        ok: Boolean(vendor),
        mac: rawMac,
        normalizedMac: normalized,
        prefix,
        vendor: vendor ?? null,
        summary: vendor
          ? `Local OUI database matched ${prefix} to ${vendor}.`
          : `No vendor match found in the local OUI database for ${prefix}.`,
        database: stats,
      };
    },
  });

  tools.steward_web_research = dynamicTool({
    description: "Search the public web for current or external information and optionally read result pages. Use this for public internet facts, not for MAC/OUI vendor lookups that should use steward_lookup_oui. The model should decide breadth/depth per task, then iterate: first pass, inspect findings, optionally read more via read_from_result, or re-run with a refined query.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for the public web.",
        },
        max_results: {
          type: "integer",
          description: "Optional result cap. Defaults to runtime settings and is clamped to safe limits.",
        },
        deep_read_pages: {
          type: "integer",
          description: "Optional number of top results to open and extract. Defaults to runtime settings.",
        },
        search_pages: {
          type: "integer",
          description: "Optional number of search result pages to traverse.",
        },
        read_from_result: {
          type: "integer",
          description: "Optional 1-based result rank to start deep reads from. Use this with nextReadFromResult to continue reading additional results without re-reading earlier ones.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { ok: false, error: "query is required." };
      }

      const runtime = stateStore.getRuntimeSettings();
      if (!runtime.enableWebResearch) {
        return {
          ok: false,
          blocked: "runtime",
          error: "Public web research is disabled in runtime settings.",
        };
      }

      const hasMaxResultsArg = Number.isFinite(Number(args.max_results));
      const hasDeepReadArg = Number.isFinite(Number(args.deep_read_pages));
      const hasSearchPagesArg = Number.isFinite(Number(args.search_pages));
      const hasReadFromResultArg = Number.isFinite(Number(args.read_from_result));

      const maxResults = hasMaxResultsArg
        ? clampInt(args.max_results, 1, WEB_RESEARCH_MAX_RESULTS_LIMIT, runtime.webResearchMaxResults)
        : clampInt(runtime.webResearchMaxResults, 1, WEB_RESEARCH_MAX_RESULTS_LIMIT, runtime.webResearchMaxResults);

      const requestedDeepReads = hasDeepReadArg
        ? clampInt(args.deep_read_pages, 0, WEB_RESEARCH_DEEP_READ_LIMIT, runtime.webResearchDeepReadPages)
        : clampInt(runtime.webResearchDeepReadPages, 0, WEB_RESEARCH_DEEP_READ_LIMIT, runtime.webResearchDeepReadPages);
      const deepReadPages = Math.min(requestedDeepReads, maxResults);
      const searchPages = hasSearchPagesArg
        ? clampInt(args.search_pages, 1, WEB_RESEARCH_SEARCH_PAGE_LIMIT, 1)
        : clampInt(
          Math.ceil(maxResults / WEB_RESEARCH_RESULTS_PER_PAGE_HINT),
          1,
          WEB_RESEARCH_SEARCH_PAGE_LIMIT,
          1,
        );
      const readFromResult = hasReadFromResultArg
        ? clampInt(args.read_from_result, 1, WEB_RESEARCH_MAX_RESULTS_LIMIT, 1)
        : 1;

      const provider = runtime.webResearchProvider;
      let apiKey: string | undefined;
      const apiKeys: Partial<Record<"brave_api" | "serper" | "serpapi", string>> = {};
      if (requiresWebResearchApiKey(provider)) {
        apiKey = await vault.getSecret(webResearchApiKeySecretRef(provider));
      }
      for (const keyProvider of ["brave_api", "serper", "serpapi"] as const) {
        const key = await vault.getSecret(webResearchApiKeySecretRef(keyProvider));
        if (key && key.trim().length > 0) {
          apiKeys[keyProvider] = key;
        }
      }

      const result = await runWebResearch(query, {
        provider,
        apiKey,
        apiKeys,
        fallbackStrategy: runtime.webResearchFallbackStrategy,
        timeoutMs: runtime.webResearchTimeoutMs,
        maxResults,
        deepReadPages,
        searchPages,
        readFromResult,
      });

      await stateStore.addAction({
        actor: "user",
        kind: "diagnose",
        message: `Public web research executed for query: ${query}`,
        context: {
          query,
          ok: result.ok,
          engine: result.engine,
          provider,
          resultCount: result.resultCount,
          consultedCount: result.consultedCount,
          warnings: result.warnings,
        },
      });

      return result;
    },
  });

  tools.steward_remote_desktop = dynamicTool({
    description: "Open RDP or VNC desktops inside Steward, capture snapshots, and execute atomic remote desktop actions.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        protocol: {
          type: "string",
          enum: ["rdp", "vnc"],
          description: "Optional remote desktop protocol override.",
        },
        credential_id: {
          type: "string",
          description: "Optional stored credential id to force for the desktop session.",
        },
        mode: {
          type: "string",
          enum: ["observe", "command"],
          description: "Observe opens the session read-only. Command allows control.",
        },
        keep_session_open: {
          type: "boolean",
          description: "Keep the governed session lease open after the flow completes.",
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["snapshot", "click", "double_click", "drag", "scroll", "type", "key", "wait"],
              },
              label: { type: "string" },
              x: { type: "integer" },
              y: { type: "integer" },
              from_x: { type: "integer" },
              from_y: { type: "integer" },
              to_x: { type: "integer" },
              to_y: { type: "integer" },
              text: { type: "string" },
              key: { type: "string" },
              direction: { type: "string", enum: ["up", "down"] },
              amount: { type: "integer" },
              duration_ms: { type: "integer" },
              timeout_ms: { type: "integer" },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(inputString(args, "device_id"), options?.attachedDeviceId);
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForToolUse(device, {
        allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const protocol = (() => {
        const raw = inputString(args, "protocol");
        if (raw === "rdp" || raw === "vnc") {
          return raw;
        }
        return undefined;
      })();
      const rawSteps = Array.isArray(args.steps) ? args.steps.filter(isRecord) : [];
      return runRemoteDesktopFlow({
        device,
        protocol,
        credentialId: inputString(args, "credential_id"),
        holder: "user:" + device.id + ":remote-desktop",
        purpose: "Assistant remote desktop flow for " + device.name,
        mode: inputString(args, "mode") === "observe" ? "observe" : "command",
        keepSessionOpen: inputBoolean(args, "keep_session_open") === true,
        steps: rawSteps as Array<{
          action: "snapshot" | "click" | "double_click" | "drag" | "scroll" | "type" | "key" | "wait";
          label?: string;
          x?: number;
          y?: number;
          from_x?: number;
          from_y?: number;
          to_x?: number;
          to_y?: number;
          text?: string;
          key?: string;
          direction?: "up" | "down";
          amount?: number;
          duration_ms?: number;
          timeout_ms?: number;
        }>,
      });
    },
  });

  tools.steward_browser_browse = dynamicTool({
    description: "Browse web UIs with Playwright as a first-class tool for login, navigation, diagnostics, and interactive changes.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute URL to open.",
        },
        device_id: {
          type: "string",
          description: "Optional device id/name/IP for using stored credentials and logging context.",
        },
        username: {
          type: "string",
          description: "Optional username for login form fill.",
        },
        password: {
          type: "string",
          description: "Optional password for login form fill.",
        },
        use_stored_credentials: {
          type: "boolean",
          description: "When true, use stored http-api credential for the device if username/password are not provided.",
        },
        username_selector: {
          type: "string",
          description: "CSS selector for username field.",
        },
        password_selector: {
          type: "string",
          description: "CSS selector for password field.",
        },
        submit_selector: {
          type: "string",
          description: "Optional CSS selector for login submit button.",
        },
        wait_for_selector: {
          type: "string",
          description: "Optional CSS selector expected after actions complete.",
        },
        post_login_wait_ms: {
          type: "integer",
          description: "Optional wait after login submit.",
        },
        collect_diagnostics: {
          type: "boolean",
          description: "Capture browser console errors and failed network requests.",
        },
        include_html: {
          type: "boolean",
          description: "Include final page HTML snapshot in the response.",
        },
        mark_credential_validated: {
          type: "boolean",
          description: "When true, mark the stored credential validated after successful browser-authenticated access.",
        },
        session_id: {
          type: "string",
          description: "Optional managed web session id to reuse.",
        },
        persist_session: {
          type: "boolean",
          description: "Persist authenticated browser state for reuse across turns.",
        },
        reuse_session: {
          type: "boolean",
          description: "Reuse a compatible managed web session when one exists.",
        },
        reset_session: {
          type: "boolean",
          description: "Ignore any persisted browser state and start a fresh login flow.",
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "goto",
                  "click",
                  "hover",
                  "fill",
                  "press",
                  "check",
                  "uncheck",
                  "select",
                  "wait_for_selector",
                  "wait_for_url",
                  "wait_for_timeout",
                  "extract_text",
                  "extract_html",
                  "expect_text",
                  "evaluate",
                  "screenshot",
                ],
              },
              selector: { type: "string" },
              value: { type: "string" },
              url: { type: "string" },
              script: { type: "string" },
              label: { type: "string" },
              full_page: { type: "boolean" },
              path: { type: "string" },
              timeout_ms: { type: "integer" },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
      },
      required: ["url"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const targetUrl = inputString(args, "url");
      if (!targetUrl) {
        return { ok: false, error: "url is required." };
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(targetUrl);
      } catch {
        return { ok: false, error: "url must be an absolute URL." };
      }

      const device = await resolveDeviceByTarget(inputString(args, "device_id"), options?.attachedDeviceId);
      const useStoredCredentials = args.use_stored_credentials !== false;
      const markCredentialValidated = args.mark_credential_validated !== false;
      const timeoutMs = clampInt(args.post_login_wait_ms, 0, 60_000, 1_000);
      const providedUsername = inputString(args, "username");
      const providedPassword = inputRawString(args, "password");
      const stored = device && useStoredCredentials
        ? await resolveBrowserCredential(device)
        : {};
      if (providedUsername === undefined && providedPassword === undefined && stored.unsupportedAuthMode) {
        return {
          ok: false,
          error: `Browser automation cannot apply stored ${httpApiCredentialAuthLabel(stored.unsupportedAuthMode)} credentials. Use broker-backed HTTP/API tools instead of steward_browser_browse for this device.`,
          url: parsedUrl.toString(),
          deviceId: device?.id,
          deviceName: device?.name,
          credentialId: stored.credentialId,
        };
      }
      const username = providedUsername ?? stored.username;
      const password = providedPassword ?? stored.password;

      const usernameSelector = inputString(args, "username_selector");
      const passwordSelector = inputString(args, "password_selector");
      const submitSelector = inputString(args, "submit_selector");
      const waitForSelector = inputString(args, "wait_for_selector");
      const collectDiagnostics = inputBoolean(args, "collect_diagnostics") !== false;
      const includeHtml = inputBoolean(args, "include_html") === true;
      const rawSteps = Array.isArray(args.steps) ? args.steps.filter(isRecord) : [];
      return webSessionManager.runBrowserFlow({
        url: parsedUrl.toString(),
        device: device ?? undefined,
        sessionId: inputString(args, "session_id"),
        username,
        password,
        credentialId: stored.credentialId,
        usernameSelector,
        passwordSelector,
        submitSelector,
        waitForSelector,
        postLoginWaitMs: timeoutMs,
        collectDiagnostics,
        includeHtml,
        steps: rawSteps as Array<{
          action: string;
          selector?: string;
          value?: string;
          url?: string;
          script?: string;
          label?: string;
          full_page?: boolean;
          path?: string;
          timeout_ms?: number;
        }>,
        persistSession: inputBoolean(args, "persist_session") ?? Boolean(device),
        reuseSession: inputBoolean(args, "reuse_session") !== false,
        resetSession: inputBoolean(args, "reset_session") === true,
        markCredentialValidated,
        actor: "user",
      });
    },
  });

  tools.steward_manage_device = dynamicTool({
    description: "Get or update first-party device settings, onboarding selections, and access/profile bindings with guardrails against placeholder names and invalid adapter matches.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "update"],
          description: "Action to perform.",
        },
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        name: {
          type: "string",
          description: "Optional new display name. Must not be a placeholder like 'this' or 'it'.",
        },
        category: {
          type: "string",
          description: "Optional device category/device type. Accepts canonical values and common aliases.",
        },
        infer_name: {
          type: "boolean",
          description: "Infer an operator-friendly name from known identity signals when true.",
        },
        infer_category: {
          type: "boolean",
          description: "Infer a category from known identity signals when true.",
        },
        autonomy_tier: {
          type: "integer",
          enum: [1, 2, 3],
          description: "Optional autonomy tier update.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional full tag set to replace current tags.",
        },
        operator_notes: {
          type: ["string", "null"],
          description: "Optional operator context note text.",
        },
        structured_memory_json: {
          type: ["object", "null"],
          description: "Optional structured memory JSON object.",
          additionalProperties: true,
        },
        selected_profile_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional full adapter/profile selection to apply for the device. An empty array clears the current draft selection.",
        },
        selected_access_method_keys: {
          type: "array",
          items: { type: "string" },
          description: "Optional full access-method selection to apply for the device. An empty array clears the current draft selection.",
        },
        refresh_onboarding: {
          type: "boolean",
          description: "Refresh onboarding draft state and available profile/access candidates before returning or applying changes.",
        },
        force_refresh_onboarding: {
          type: "boolean",
          description: "Force a full onboarding draft resync by clearing and rebuilding candidate profile/access bindings first.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const action = inputString(args, "action");
      if (!action) {
        return { ok: false, error: "action is required." };
      }

      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForToolUse(device, {
        allowPreOnboardingExecution: true,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      const readSelectedProfileIds = (snapshot: Awaited<ReturnType<typeof getDeviceAdoptionSnapshot>> | null): string[] => {
        if (snapshot?.draft?.selectedProfileIds) {
          return snapshot.draft.selectedProfileIds;
        }
        return (snapshot?.profiles ?? [])
          .filter((profile) => ["selected", "verified", "active"].includes(profile.status))
          .map((profile) => profile.profileId);
      };

      const readSelectedAccessMethodKeys = (snapshot: Awaited<ReturnType<typeof getDeviceAdoptionSnapshot>> | null): string[] => {
        if (snapshot?.draft?.selectedAccessMethodKeys) {
          return snapshot.draft.selectedAccessMethodKeys;
        }
        return (snapshot?.accessMethods ?? [])
          .filter((method) => method.selected)
          .map((method) => method.key);
      };

      let adoptionSnapshot: Awaited<ReturnType<typeof getDeviceAdoptionSnapshot>> | null = null;
      const refreshRequested = inputBoolean(args, "refresh_onboarding") === true
        || inputBoolean(args, "force_refresh_onboarding") === true;
      if (action === "get" || refreshRequested || "selected_profile_ids" in args || "selected_access_method_keys" in args) {
        try {
          adoptionSnapshot = refreshRequested || "selected_profile_ids" in args || "selected_access_method_keys" in args
            ? await startDeviceAdoption(device.id, {
              triggeredBy: "steward",
              force: inputBoolean(args, "force_refresh_onboarding") === true,
            })
            : await getDeviceAdoptionSnapshot(device.id);
        } catch (error) {
          if (action === "get") {
            adoptionSnapshot = null;
          } else {
            return {
              ok: false,
              error: error instanceof Error ? error.message : "Failed to refresh device onboarding state.",
              deviceId: device.id,
            };
          }
        }
      }

      if (action === "get") {
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          name: device.name,
          category: device.type,
          autonomyTier: device.autonomyTier,
          tags: device.tags,
          operatorNotes: isRecord(device.metadata.notes) && typeof device.metadata.notes.operatorContext === "string"
            ? device.metadata.notes.operatorContext
            : "",
          structuredMemoryJson: isRecord(device.metadata.notes) && isRecord(device.metadata.notes.structuredContext)
            ? device.metadata.notes.structuredContext
            : {},
          selectedProfileIds: readSelectedProfileIds(adoptionSnapshot),
          selectedAccessMethodKeys: readSelectedAccessMethodKeys(adoptionSnapshot),
          availableProfiles: adoptionSnapshot?.profiles.map((profile) => ({
            profileId: profile.profileId,
            adapterId: profile.adapterId,
            status: profile.status,
            selected: ["selected", "verified", "active"].includes(profile.status),
            summary: profile.summary,
          })) ?? [],
          availableAccessMethods: adoptionSnapshot?.accessMethods.map((method) => ({
            key: method.key,
            kind: method.kind,
            selected: method.selected,
            status: method.status,
            summary: method.summary,
          })) ?? [],
        };
      }

      if (action !== "update") {
        return { ok: false, error: `Unsupported action: ${action}` };
      }

      const inferName = inputBoolean(args, "infer_name") === true;
      const inferCategory = inputBoolean(args, "infer_category") === true;
      const inputName = inputString(args, "name");
      const inputCategory = inputString(args, "category");
      const nextNameRaw = inputName ?? (inferName ? inferManageableDeviceName(device) : null);
      const normalizedName = typeof nextNameRaw === "string" ? normalizeDeviceName(nextNameRaw) : null;
      const nameValidationError = normalizedName !== null ? getDeviceNameValidationError(normalizedName) : null;
      if (nameValidationError) {
        return {
          ok: false,
          error: `Invalid device name '${normalizedName}'. ${nameValidationError}`,
          deviceId: device.id,
        };
      }

      const nextCategory = parseDeviceCategory(inputCategory)
        ?? (inferCategory ? inferManageableDeviceCategory(device) : null);

      const changedFields: string[] = [];
      const previousName = device.name;
      const previousCategory = device.type;
      const previousAutonomy = device.autonomyTier;

      if (refreshRequested) {
        changedFields.push(inputBoolean(args, "force_refresh_onboarding") === true ? "onboardingRebuilt" : "onboardingRefreshed");
      }

      if (normalizedName && normalizedName !== device.name) {
        device.name = normalizedName;
        const identity = isRecord(device.metadata.identity) ? device.metadata.identity : {};
        device.metadata = {
          ...device.metadata,
          identity: {
            ...identity,
            nameManuallySet: true,
            nameManuallySetAt: nowIso(),
            nameSetBy: "steward_manage_device",
          },
        };
        changedFields.push("name");
      }

      if (nextCategory && nextCategory !== device.type) {
        device.type = nextCategory;
        changedFields.push("category");
      }

      const autonomyTier = typeof args.autonomy_tier === "number"
        ? clampInt(args.autonomy_tier, 1, 3, device.autonomyTier)
        : undefined;
      if (autonomyTier && autonomyTier !== device.autonomyTier) {
        device.autonomyTier = autonomyTier as Device["autonomyTier"];
        changedFields.push("autonomyTier");
      }

      if (Array.isArray(args.tags)) {
        const tags = args.tags
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        if (JSON.stringify(tags) !== JSON.stringify(device.tags)) {
          device.tags = tags;
          changedFields.push("tags");
        }
      }

      if ("operator_notes" in args) {
        const nextNotes = args.operator_notes === null
          ? ""
          : typeof args.operator_notes === "string"
            ? args.operator_notes.trim()
            : "";
        const existingNotes = isRecord(device.metadata.notes)
          && typeof device.metadata.notes.operatorContext === "string"
          ? device.metadata.notes.operatorContext
          : "";
        if (nextNotes !== existingNotes) {
          const existing = isRecord(device.metadata.notes) ? device.metadata.notes : {};
          device.metadata = {
            ...device.metadata,
            notes: {
              ...existing,
              operatorContext: nextNotes,
              operatorContextUpdatedAt: nowIso(),
            },
          };
          changedFields.push("operatorNotes");
        }
      }

      if ("structured_memory_json" in args) {
        if (args.structured_memory_json !== null && !isRecord(args.structured_memory_json)) {
          return { ok: false, error: "structured_memory_json must be an object or null.", deviceId: device.id };
        }
        const existingStructured = isRecord(device.metadata.notes) && isRecord(device.metadata.notes.structuredContext)
          ? device.metadata.notes.structuredContext
          : {};
        const nextStructured = args.structured_memory_json ?? {};
        if (JSON.stringify(existingStructured) !== JSON.stringify(nextStructured)) {
          const existing = isRecord(device.metadata.notes) ? device.metadata.notes : {};
          device.metadata = {
            ...device.metadata,
            notes: {
              ...existing,
              structuredContext: nextStructured,
              structuredContextUpdatedAt: nowIso(),
            },
          };
          changedFields.push("structuredMemoryJson");
        }
      }

      const selectedProfileIdsRequested = "selected_profile_ids" in args;
      const selectedAccessMethodKeysRequested = "selected_access_method_keys" in args;
      if (selectedProfileIdsRequested || selectedAccessMethodKeysRequested) {
        if (!adoptionSnapshot) {
          try {
            adoptionSnapshot = await startDeviceAdoption(device.id, { triggeredBy: "steward" });
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : "Failed to refresh device onboarding state.",
              deviceId: device.id,
            };
          }
        }

        const nextSelectedProfileIds = selectedProfileIdsRequested
          ? (inputStringArray(args, "selected_profile_ids") ?? [])
          : readSelectedProfileIds(adoptionSnapshot);
        const nextSelectedAccessMethodKeys = selectedAccessMethodKeysRequested
          ? (inputStringArray(args, "selected_access_method_keys") ?? [])
          : readSelectedAccessMethodKeys(adoptionSnapshot);
        const availableProfiles = new Set(adoptionSnapshot.profiles.map((profile) => profile.profileId));
        const availableAccessMethods = new Set(adoptionSnapshot.accessMethods.map((method) => method.key));
        const missingProfiles = nextSelectedProfileIds.filter((profileId) => !availableProfiles.has(profileId));
        if (missingProfiles.length > 0) {
          return {
            ok: false,
            error: `Unknown adapter selection: ${missingProfiles.join(", ")}`,
            deviceId: device.id,
          };
        }
        const missingAccessMethods = nextSelectedAccessMethodKeys.filter((key) => !availableAccessMethods.has(key));
        if (missingAccessMethods.length > 0) {
          return {
            ok: false,
            error: `Unknown access method selection: ${missingAccessMethods.join(", ")}`,
            deviceId: device.id,
          };
        }

        const currentSelectedProfileIds = readSelectedProfileIds(adoptionSnapshot);
        const currentSelectedAccessMethodKeys = readSelectedAccessMethodKeys(adoptionSnapshot);
        const profileSelectionChanged = JSON.stringify(currentSelectedProfileIds) !== JSON.stringify(nextSelectedProfileIds);
        const accessSelectionChanged = JSON.stringify(currentSelectedAccessMethodKeys) !== JSON.stringify(nextSelectedAccessMethodKeys);

        if (profileSelectionChanged) {
          stateStore.selectDeviceProfiles(device.id, nextSelectedProfileIds);
          changedFields.push("selectedProfileIds");
        }
        if (accessSelectionChanged) {
          stateStore.selectAccessMethods(device.id, nextSelectedAccessMethodKeys);
          changedFields.push("selectedAccessMethodKeys");
        }

        if (profileSelectionChanged || accessSelectionChanged) {
          adoptionSnapshot = await updateDeviceOnboardingDraft({
            deviceId: device.id,
            selectedProfileIds: nextSelectedProfileIds,
            selectedAccessMethodKeys: nextSelectedAccessMethodKeys,
            actor: "steward",
          });
        }
      }

      if (changedFields.length === 0) {
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          changedFields,
          selectedProfileIds: readSelectedProfileIds(adoptionSnapshot),
          selectedAccessMethodKeys: readSelectedAccessMethodKeys(adoptionSnapshot),
          summary: `No manage-device changes were needed for ${device.name}.`,
        };
      }

      const deviceFieldsChanged = changedFields.some((field) =>
        ["name", "category", "autonomyTier", "tags", "operatorNotes", "structuredMemoryJson"].includes(field),
      );
      if (deviceFieldsChanged) {
        device.lastChangedAt = nowIso();
        await stateStore.upsertDevice(device);
        await stateStore.addAction({
          actor: "steward",
          kind: "config",
          message: `Updated device settings for ${device.name}`,
          context: {
            deviceId: device.id,
            changedFields,
            previousName,
            nextName: device.name,
            previousCategory,
            nextCategory: device.type,
            previousAutonomy,
            nextAutonomy: device.autonomyTier,
            viaTool: "steward_manage_device",
          },
        });
      }

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        previousName,
        previousCategory,
        name: device.name,
        category: device.type,
        autonomyTier: device.autonomyTier,
        changedFields,
        selectedProfileIds: readSelectedProfileIds(adoptionSnapshot),
        selectedAccessMethodKeys: readSelectedAccessMethodKeys(adoptionSnapshot),
        inferredName: Boolean(inferName && !inputName && normalizedName),
        inferredCategory: Boolean(inferCategory && !inputCategory && nextCategory),
        summary: `Updated ${device.name}: ${changedFields.join(", ")}.`,
      };
    },
  });

  tools.steward_manage_credentials = dynamicTool({
    description: "List, store, update, validate, or delete first-party device credentials in Steward's vault-backed credential store. Use this during onboarding instead of telling the user to save credentials manually.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "store", "update", "validate", "delete"],
          description: "Credential action to perform.",
        },
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is attached to a device.",
        },
        credential_id: {
          type: "string",
          description: "Existing credential id for update, validate, or delete.",
        },
        credential_protocol: {
          type: "string",
          description: "Selector for an existing credential protocol when credential_id is not known.",
        },
        credential_adapter_id: {
          type: "string",
          description: "Optional selector to narrow an existing credential by adapter id.",
        },
        match_account_label: {
          type: "string",
          description: "Optional selector to narrow an existing credential by current account label.",
        },
        protocol: {
          type: "string",
          description: "Credential protocol to store, or replacement protocol when updating.",
        },
        adapter_id: {
          type: "string",
          description: "Optional adapter binding for the stored credential.",
        },
        account_label: {
          type: "string",
          description: "Optional username or account label. Required for HTTP Basic auth.",
        },
        secret: {
          type: "string",
          description: "Secret value to store. Never returned by the tool.",
        },
        validate_now: {
          type: "boolean",
          description: "Legacy compatibility flag. Steward now trusts manually entered credentials and does not perform active validation here.",
        },
        http_auth_mode: {
          type: "string",
          enum: [
            ...HTTP_API_AUTH_MODES,
            "username-password",
            "bearer-token",
            "api-key-header",
            "query-token",
            "path-token",
          ],
          description: "For http-api credentials: basic, bearer, api-key, query-param, or path-segment. Use path-token for Hue-style /api/<token>/... auth.",
        },
        http_header_name: {
          type: "string",
          description: "For http-api api-key mode: header name to populate with the stored secret. Defaults to X-API-Key.",
        },
        http_query_param_name: {
          type: "string",
          description: "For http-api query-param mode: query parameter name to populate with the stored secret. Defaults to api_key.",
        },
        http_path_prefix: {
          type: "string",
          description: "For http-api path-segment mode: path prefix after which Steward inserts the stored secret. Defaults to /api.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const action = inputString(args, "action");
      if (!action) {
        return { ok: false, error: "action is required." };
      }

      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      const readiness = validateDeviceReadyForToolUse(device, {
        allowPreOnboardingExecution: true,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id, retryable: false };
      }

      if (action === "list") {
        const credentials = stateStore.getDeviceCredentials(device.id).map((credential) =>
          summarizeCredentialEntry(redactDeviceCredential(credential))
        );
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          credentialCount: credentials.length,
          credentials,
        };
      }

      if (action === "store") {
        const protocolInput = inputString(args, "protocol");
        if (!protocolInput) {
          return { ok: false, error: "protocol is required for store." };
        }
        const secret = inputRawString(args, "secret");
        if (secret === undefined) {
          return { ok: false, error: "secret is required for store." };
        }

        const protocol = normalizeCredentialProtocol(protocolInput);
        const accountLabel = inputString(args, "account_label");
        const scopeJson = buildCredentialScopeFromArgs(protocol, args);
        if (protocol === "http-api") {
          const auth = getHttpApiCredentialAuth(scopeJson);
          if (auth.mode === "basic" && !accountLabel) {
            return { ok: false, error: "account_label is required for HTTP Basic auth." };
          }
        }

        const credential = await storeDeviceCredential({
          deviceId: device.id,
          protocol,
          secret,
          adapterId: inputString(args, "adapter_id"),
          accountLabel,
          scopeJson,
        });

        const redacted = redactDeviceCredential(credential);
        const protocolLabel = protocolDisplayLabel(redacted.protocol);
        const validationSummary = `Stored ${protocolLabel} credential for ${device.name}. Steward trusts manually entered credentials and will verify the transport during real operations.`;
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          credential: summarizeCredentialEntry(redacted),
          usageHints: credentialUsageHints(redacted),
          credentialCount: stateStore.getDeviceCredentials(device.id).length,
          summary: validationSummary,
        };
      }

      const resolved = resolveCredentialForDevice(device.id, {
        id: inputString(args, "credential_id"),
        protocol: inputString(args, "credential_protocol"),
        accountLabel: inputString(args, "match_account_label"),
        adapterId: inputString(args, "credential_adapter_id"),
      });
      if (!resolved.ok) {
        return {
          ok: false,
          error: resolved.error,
          matches: resolved.matches,
          deviceId: device.id,
          deviceName: device.name,
        };
      }

      if (action === "validate") {
        const credential = await validateDeviceCredential(device.id, resolved.value.id);
        const redacted = redactDeviceCredential(credential);
        const protocolLabel = protocolDisplayLabel(redacted.protocol);
        const summary = `Recorded ${protocolLabel} credential for ${device.name} as trusted manual input. Steward will verify the transport during real operations instead of pre-validating the credential.`;
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          credential: summarizeCredentialEntry(redacted),
          usageHints: credentialUsageHints(redacted),
          summary,
        };
      }

      if (action === "delete") {
        const deleted = redactDeviceCredential(resolved.value);
        await deleteDeviceCredential(device.id, resolved.value.id);
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          deletedCredential: summarizeCredentialEntry(deleted),
          credentialCount: stateStore.getDeviceCredentials(device.id).length,
          summary: `Deleted ${protocolDisplayLabel(normalizeCredentialProtocol(resolved.value.protocol))} credential for ${device.name}.`,
        };
      }

      if (action !== "update") {
        return { ok: false, error: `Unsupported action: ${action}` };
      }

      const replacementProtocolRaw = inputString(args, "protocol");
      const nextProtocol = normalizeCredentialProtocol(replacementProtocolRaw ?? resolved.value.protocol);
      const nextAccountLabel = inputString(args, "account_label");
      const scopeJson = buildCredentialScopeFromArgs(nextProtocol, args, resolved.value.scopeJson);
      if (nextProtocol === "http-api") {
        const auth = getHttpApiCredentialAuth(scopeJson);
        const effectiveAccountLabel = nextAccountLabel ?? resolved.value.accountLabel;
        if (auth.mode === "basic" && !effectiveAccountLabel?.trim()) {
          return { ok: false, error: "account_label is required for HTTP Basic auth." };
        }
      }

      const updated = await updateDeviceCredential({
        deviceId: device.id,
        credentialId: resolved.value.id,
        protocol: replacementProtocolRaw ? nextProtocol : undefined,
        secret: inputRawString(args, "secret"),
        accountLabel: nextAccountLabel,
        scopeJson,
      });

      const redacted = redactDeviceCredential(updated);
      const protocolLabel = protocolDisplayLabel(redacted.protocol);
      const summary = `Updated ${protocolLabel} credential for ${device.name}. Steward trusts manually entered credentials and will verify the transport during real operations.`;
      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        credential: summarizeCredentialEntry(redacted),
        usageHints: credentialUsageHints(redacted),
        summary,
      };
    },
  });

  const summarizeWidgetControlEntry = (control: DeviceWidgetControl): Record<string, unknown> => ({
    id: control.id,
    label: control.label,
    description: control.description ?? null,
    kind: control.kind,
    parameterCount: control.parameters.length,
    parameters: control.parameters.map((parameter) => ({
      key: parameter.key,
      label: parameter.label,
      type: parameter.type,
      required: parameter.required ?? false,
      defaultValue: parameter.defaultValue ?? null,
      options: parameter.options?.map((option) => ({
        label: option.label,
        value: option.value,
      })) ?? [],
    })),
    executionKind: control.execution.kind,
    danger: control.danger ?? false,
    confirmation: control.confirmation ?? null,
  });

  const summarizeWidgetEntry = (widget: DeviceWidget): Record<string, unknown> => ({
    id: widget.id,
    slug: widget.slug,
    name: widget.name,
    description: widget.description ?? null,
    status: widget.status,
    revision: widget.revision,
    capabilities: widget.capabilities,
    controlCount: widget.controls.length,
    controls: widget.controls.map(summarizeWidgetControlEntry),
    updatedAt: widget.updatedAt,
  });

  const summarizeDeviceAutomationEntry = (automation: DeviceAutomation): Record<string, unknown> => {
    const widget = automation.targetKind === "widget-control"
      ? stateStore.getDeviceWidgetById(automationTargetWidgetId(automation))
      : null;
    const control = widget && automation.targetKind === "widget-control"
      ? getWidgetControl(widget, automationTargetControlId(automation))
      : null;
    return {
      id: automation.id,
      name: automation.name,
      description: automation.description ?? null,
      enabled: automation.enabled,
      targetKind: automation.targetKind,
      scheduleKind: automation.scheduleKind,
      intervalMinutes: automation.intervalMinutes ?? null,
      hourLocal: automation.hourLocal ?? null,
      minuteLocal: automation.minuteLocal ?? null,
      widgetId: automationTargetWidgetId(automation),
      widgetName: widget?.name ?? null,
      widgetSlug: widget?.slug ?? null,
      controlId: automationTargetControlId(automation),
      controlLabel: control?.label ?? null,
      target: automation.targetJson,
      input: automation.inputJson,
      lastRunAt: automation.lastRunAt ?? null,
      nextRunAt: automation.nextRunAt ?? null,
      lastRunStatus: automation.lastRunStatus ?? null,
      lastRunSummary: automation.lastRunSummary ?? null,
      createdBy: automation.createdBy,
      updatedAt: automation.updatedAt,
    };
  };

  const resolveWidgetForDevice = (
    deviceId: string,
    widgetId?: string,
    widgetSlug?: string,
  ): DeviceWidget | null => {
    const widget = widgetId
      ? stateStore.getDeviceWidgetById(widgetId)
      : widgetSlug
        ? stateStore.getDeviceWidgetBySlug(deviceId, widgetSlug)
        : null;
    if (!widget || widget.deviceId !== deviceId) {
      return null;
    }
    return widget;
  };

  tools.steward_control_widget = dynamicTool({
    description: "Inspect and execute first-class widget controls exposed by persistent device widgets. Use this when the user wants to operate a widget, trigger a button, toggle a setting, set a value, or inspect what controls a widget exposes.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "execute"],
        },
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is already attached to a device.",
        },
        widget_id: {
          type: "string",
          description: "Optional widget id. Required for get and execute unless widget_slug is provided.",
        },
        widget_slug: {
          type: "string",
          description: "Optional widget slug. Required for get and execute unless widget_id is provided.",
        },
        control_id: {
          type: "string",
          description: "Control id for get or execute.",
        },
        input_values: {
          type: "object",
          description: "Control parameter values keyed by parameter id.",
          additionalProperties: true,
        },
        approved: {
          type: "boolean",
          description: "Retry an approval-gated control after explicit user approval.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const action = inputString(args, "action");
      if (!action) {
        return { ok: false, error: "action is required." };
      }

      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      if (action === "list") {
        const widget = resolveWidgetForDevice(
          device.id,
          inputString(args, "widget_id"),
          inputString(args, "widget_slug"),
        );
        if (widget) {
          return {
            ok: true,
            deviceId: device.id,
            deviceName: device.name,
            widget: summarizeWidgetEntry(widget),
            controls: widget.controls.map(summarizeWidgetControlEntry),
          };
        }

        const savedWidgets = stateStore.getDeviceWidgets(device.id);
        const widgets = savedWidgets
          .filter((candidate) => candidate.controls.length > 0);
        const summary = savedWidgets.length === 0
          ? `No widgets are currently saved for ${device.name}.`
          : widgets.length === savedWidgets.length
            ? `Found ${widgets.length} saved widget${widgets.length === 1 ? "" : "s"} on ${device.name}, and all expose callable controls.`
            : `Found ${savedWidgets.length} saved widget${savedWidgets.length === 1 ? "" : "s"} on ${device.name}; ${widgets.length} expose callable controls.`;
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          summary,
          widgetCount: savedWidgets.length,
          controllableWidgetCount: widgets.length,
          widgets: widgets.map(summarizeWidgetEntry),
          savedWidgets: savedWidgets.map(summarizeWidgetEntry),
        };
      }

      const widget = resolveWidgetForDevice(
        device.id,
        inputString(args, "widget_id"),
        inputString(args, "widget_slug"),
      );
      if (!widget) {
        return { ok: false, error: "Existing widget not found for this device." };
      }

      const controlId = inputString(args, "control_id");
      if (action === "get") {
        if (!controlId) {
          return {
            ok: true,
            deviceId: device.id,
            deviceName: device.name,
            widget: summarizeWidgetEntry(widget),
            controls: widget.controls.map(summarizeWidgetControlEntry),
            summary: widget.controls.length === 0
              ? `${widget.name} is saved but currently exposes 0 callable controls.`
              : `Loaded ${widget.controls.length} callable control${widget.controls.length === 1 ? "" : "s"} from ${widget.name}.`,
          };
        }
        const control = getWidgetControl(widget, controlId);
        if (!control) {
          return {
            ok: false,
            error: `Control ${controlId} was not found on widget ${widget.name}.`,
            availableControls: widget.controls.map(summarizeWidgetControlEntry),
          };
        }
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          widget: summarizeWidgetEntry(widget),
          control: summarizeWidgetControlEntry(control),
        };
      }

      if (action !== "execute") {
        return { ok: false, error: `Unsupported action: ${action}` };
      }

      if (!controlId) {
        return {
          ok: false,
          error: widget.controls.length === 0
            ? `${widget.name} is saved but exposes 0 callable controls. Revise the widget before trying to execute a control.`
            : "control_id is required.",
          availableControls: widget.controls.map(summarizeWidgetControlEntry),
        };
      }

      const control = getWidgetControl(widget, controlId);
      if (!control) {
        return {
          ok: false,
          error: widget.controls.length === 0
            ? `${widget.name} is saved but exposes 0 callable controls. Revise the widget before trying to execute ${controlId}.`
            : `Control ${controlId} was not found on widget ${widget.name}.`,
          availableControls: widget.controls.map(summarizeWidgetControlEntry),
        };
      }

      if (control.execution.kind === "operation") {
        const readiness = validateDeviceReadyForToolUse(device);
        if (!readiness.ok) {
          return { ok: false, error: readiness.reason, retryable: false };
        }
      }

      try {
        const result = await executeWidgetControl({
          device,
          widget,
          control,
          inputValues: isRecord(args.input_values) ? args.input_values : undefined,
          approved: inputBoolean(args, "approved") === true,
          actor: "steward",
        });
        return {
          ok: result.ok,
          deviceId: device.id,
          deviceName: device.name,
          widget: summarizeWidgetEntry(widget),
          control: summarizeWidgetControlEntry(control),
          result,
          summary: result.summary,
        };
      } catch (error) {
        return {
          ok: false,
          deviceId: device.id,
          deviceName: device.name,
          widget: summarizeWidgetEntry(widget),
          control: summarizeWidgetControlEntry(control),
          error: error instanceof Error ? error.message : "Widget control failed.",
        };
      }
    },
  });

  tools.steward_manage_automation = dynamicTool({
    description: "Create, inspect, list, update, delete, or run device automations. Widget controls are the current first supported target type, but the automation model is intentionally broader than widgets.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "delete", "run"],
        },
        device_id: {
          type: "string",
          description: "Target device id, name, or IP. Optional when chat is already attached to a device.",
        },
        automation_id: {
          type: "string",
          description: "Existing automation id for get, update, delete, or run.",
        },
        widget_id: {
          type: "string",
          description: "Target widget id for create.",
        },
        widget_slug: {
          type: "string",
          description: "Target widget slug for create.",
        },
        control_id: {
          type: "string",
          description: "Target control id for create.",
        },
        name: {
          type: "string",
          description: "Automation display name.",
        },
        description: {
          type: "string",
          description: "Automation description.",
        },
        enabled: {
          type: "boolean",
          description: "Whether the automation should run automatically.",
        },
        schedule_kind: {
          type: "string",
          enum: ["manual", "interval", "daily"],
        },
        interval_minutes: {
          type: "number",
          description: "Required when schedule_kind=interval.",
        },
        hour_local: {
          type: "number",
          description: "0-23 local hour for schedule_kind=daily.",
        },
        minute_local: {
          type: "number",
          description: "0-59 local minute for schedule_kind=daily.",
        },
        input_values: {
          type: "object",
          description: "Default control input values.",
          additionalProperties: true,
        },
      },
      required: ["action"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const action = inputString(args, "action");
      if (!action) {
        return { ok: false, error: "action is required." };
      }

      const device = await resolveDeviceByTarget(
        inputString(args, "device_id"),
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
      }

      if (action === "list") {
        const automations = stateStore.getDeviceAutomations(device.id);
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          count: automations.length,
          automations: automations.map(summarizeDeviceAutomationEntry),
        };
      }

      const automationId = inputString(args, "automation_id");
      const existingAutomation = automationId ? stateStore.getDeviceAutomationById(automationId) : null;
      if (automationId && (!existingAutomation || existingAutomation.deviceId !== device.id)) {
        return { ok: false, error: "Existing automation not found for this device." };
      }

      if (action === "get") {
        if (!existingAutomation) {
          return { ok: false, error: "automation_id is required for get." };
        }
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          automation: summarizeDeviceAutomationEntry(existingAutomation),
          runs: stateStore.getDeviceAutomationRuns(existingAutomation.id, 10),
        };
      }

      if (action === "delete") {
        if (!existingAutomation) {
          return { ok: false, error: "automation_id is required for delete." };
        }
        const deleted = stateStore.deleteDeviceAutomation(existingAutomation.id);
        if (deleted) {
          await stateStore.addAction({
            actor: "steward",
            kind: "config",
            message: `Deleted automation ${existingAutomation.name} for ${device.name}`,
            context: {
              deviceId: device.id,
              automationId: existingAutomation.id,
            },
          });
        }
        return {
          ok: deleted,
          deviceId: device.id,
          deviceName: device.name,
          deletedAutomationId: existingAutomation.id,
          summary: deleted
            ? `Deleted automation ${existingAutomation.name} for ${device.name}.`
            : `Failed to delete automation ${existingAutomation.name}.`,
        };
      }

      if (action === "run") {
        if (!existingAutomation) {
          return { ok: false, error: "automation_id is required for run." };
        }
        const result = await runDeviceAutomation({
          automationId: existingAutomation.id,
          trigger: "manual",
        });
        return {
          ok: result.run.status === "succeeded",
          deviceId: device.id,
          deviceName: device.name,
          automation: summarizeDeviceAutomationEntry(result.automation),
          run: result.run,
          summary: result.run.summary,
        };
      }

      const widget = resolveWidgetForDevice(
        device.id,
        inputString(args, "widget_id"),
        inputString(args, "widget_slug"),
      ) ?? (existingAutomation ? stateStore.getDeviceWidgetById(existingAutomation.widgetId) : null);
      if (!widget || widget.deviceId !== device.id) {
        return { ok: false, error: "Target widget not found for this device." };
      }

      const control = getWidgetControl(
        widget,
        inputString(args, "control_id") ?? existingAutomation?.controlId ?? "",
      );
      if (!control) {
        return {
          ok: false,
          error: "Target control not found for this widget.",
          availableControls: widget.controls.map(summarizeWidgetControlEntry),
        };
      }

      const requestedScheduleKind = inputString(args, "schedule_kind");
      if (
        requestedScheduleKind
        && !["manual", "interval", "daily"].includes(requestedScheduleKind)
      ) {
        return { ok: false, error: "schedule_kind must be manual, interval, or daily." };
      }
      const scheduleKind = (
        requestedScheduleKind
        ?? existingAutomation?.scheduleKind
        ?? "manual"
      ) as DeviceAutomation["scheduleKind"];
      const enabled = typeof args.enabled === "boolean"
        ? args.enabled
        : existingAutomation?.enabled ?? true;
      const intervalMinutes = typeof args.interval_minutes === "number"
        ? Math.round(args.interval_minutes)
        : existingAutomation?.intervalMinutes;
      const hourLocal = typeof args.hour_local === "number"
        ? Math.round(args.hour_local)
        : existingAutomation?.hourLocal;
      const minuteLocal = typeof args.minute_local === "number"
        ? Math.round(args.minute_local)
        : existingAutomation?.minuteLocal;

      if (scheduleKind === "interval" && typeof intervalMinutes !== "number") {
        return { ok: false, error: "interval_minutes is required for interval automations." };
      }
      if (scheduleKind === "daily" && (typeof hourLocal !== "number" || typeof minuteLocal !== "number")) {
        return { ok: false, error: "hour_local and minute_local are required for daily automations." };
      }

      const now = new Date().toISOString();
      const name = inputString(args, "name")
        ?? existingAutomation?.name
        ?? `${widget.name} · ${control.label}`;

      const automation: DeviceAutomation = {
        id: existingAutomation?.id ?? `device-automation-${randomUUID()}`,
        deviceId: device.id,
        targetKind: "widget-control",
        widgetId: widget.id,
        controlId: control.id,
        targetJson: {
          widgetId: widget.id,
          controlId: control.id,
          widgetSlug: widget.slug,
          controlLabel: control.label,
        },
        name,
        description: inputString(args, "description") ?? existingAutomation?.description,
        enabled,
        scheduleKind,
        intervalMinutes: scheduleKind === "interval" ? intervalMinutes : undefined,
        hourLocal: scheduleKind === "daily" ? hourLocal : undefined,
        minuteLocal: scheduleKind === "daily" ? minuteLocal : undefined,
        inputJson: isRecord(args.input_values)
          ? args.input_values
          : existingAutomation?.inputJson ?? {},
        lastRunAt: existingAutomation?.lastRunAt,
        nextRunAt: undefined,
        lastRunStatus: existingAutomation?.lastRunStatus,
        lastRunSummary: existingAutomation?.lastRunSummary,
        createdBy: existingAutomation?.createdBy ?? "steward",
        createdAt: existingAutomation?.createdAt ?? now,
        updatedAt: now,
      };
      automation.nextRunAt = computeAutomationNextRunAt(automation, new Date(now));
      const saved = stateStore.upsertDeviceAutomation(automation);
      await stateStore.addAction({
        actor: "steward",
        kind: "config",
        message: `${existingAutomation ? "Updated" : "Created"} automation ${saved.name} for ${device.name}`,
        context: {
          deviceId: device.id,
          automationId: saved.id,
          widgetId: widget.id,
          controlId: control.id,
        },
      });
      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        automation: summarizeDeviceAutomationEntry(saved),
        summary: `${existingAutomation ? "Updated" : "Created"} automation ${saved.name} for ${device.name}.`,
      };
    },
  });

  if (options?.includeWidgetManagementTool) {
    tools.steward_manage_widget = dynamicTool({
      description: "Create, inspect, revise, save, list, or delete persistent device widgets for a device page, but only when the user explicitly asks for widget work. If a widget would merely be helpful, suggest it in prose instead. When a relevant widget already exists, inspect or revise it instead of creating a duplicate unless the user explicitly asks for a new one.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "get", "generate", "save", "delete"],
            description: "Widget action to perform.",
          },
          device_id: {
            type: "string",
            description: "Target device id, name, or IP. Optional when chat is already attached to a device.",
          },
          widget_id: {
            type: "string",
            description: "Existing widget id for get, generate revision, save, or delete.",
          },
          widget_slug: {
            type: "string",
            description: "Existing widget slug for get, generate revision, save, or delete.",
          },
          prompt: {
            type: "string",
            description: "Natural-language request used for widget generation or revision.",
          },
          name: {
            type: "string",
            description: "Widget display name for save.",
          },
          description: {
            type: "string",
            description: "Widget description for save.",
          },
          slug: {
            type: "string",
            description: "Explicit widget slug for save.",
          },
          html: {
            type: "string",
            description: "Widget HTML markup for save. Do not include script or style tags.",
          },
          css: {
            type: "string",
            description: "Widget CSS for save.",
          },
          js: {
            type: "string",
            description: "Widget JavaScript for save.",
          },
          capabilities: {
            type: "array",
            items: {
              type: "string",
              enum: ["context", "state", "device-control"],
            },
            description: "Widget runtime capabilities for save.",
          },
          controls: {
            type: "array",
            description: "Standard control manifest for save.",
            items: {
              type: "object",
              additionalProperties: true,
            },
          },
        },
        required: ["action"],
        additionalProperties: false,
      }),
      execute: async (argsUnknown: unknown) => {
        const args = isRecord(argsUnknown) ? argsUnknown : {};
        const action = inputString(args, "action");
        if (!action) {
          return { ok: false, error: "action is required." };
        }

        const device = await resolveDeviceByTarget(
          inputString(args, "device_id"),
          options?.attachedDeviceId,
        );
        if (!device) {
          return { ok: false, error: ATTACHED_DEVICE_REQUIRED_ERROR, retryable: false };
        }

        const widgetId = inputString(args, "widget_id");
        const widgetSlug = inputString(args, "widget_slug");
        const resolveWidget = () => {
          const widget = widgetId
            ? stateStore.getDeviceWidgetById(widgetId)
            : widgetSlug
              ? stateStore.getDeviceWidgetBySlug(device.id, widgetSlug)
              : null;
          if (widget && widget.deviceId !== device.id) {
            return null;
          }
          return widget;
        };

        if (action === "list") {
          const widgets = stateStore.getDeviceWidgets(device.id);
          return {
            ok: true,
            deviceId: device.id,
            deviceName: device.name,
            count: widgets.length,
            widgets: widgets.map(summarizeWidgetEntry),
          };
        }

        if (action === "get") {
          const widget = resolveWidget();
          if (!widget) {
            return { ok: false, error: "Existing widget not found for this device." };
          }
          return {
            ok: true,
            deviceId: device.id,
            deviceName: device.name,
            widget: summarizeWidgetEntry(widget),
            runtimeState: stateStore.getDeviceWidgetRuntimeState(widget.id)?.stateJson ?? {},
            recentOperationRuns: stateStore.getDeviceWidgetOperationRuns(widget.id, 15),
          };
        }

        if (action === "generate") {
          const prompt = inputString(args, "prompt");
          if (!prompt) {
            return { ok: false, error: "prompt is required for generate." };
          }
          const widget = resolveWidget();
          const provider = typeof options?.provider === "string" && options.provider.length > 0
            ? options.provider
            : await getDefaultProvider();
          const generated = await generateAndStoreDeviceWidget({
            deviceId: device.id,
            prompt,
            provider,
            model: options?.model,
            actor: "steward",
            targetWidgetId: widget?.id,
            targetWidgetSlug: widget ? undefined : widgetSlug,
            verificationMode: options?.widgetVerificationMode,
          });
          await stateStore.addAction({
            actor: "steward",
            kind: "config",
            message: `${generated.updatedExisting ? "Updated" : "Created"} widget ${generated.widget.name} for ${device.name}`,
            context: {
              deviceId: device.id,
              widgetId: generated.widget.id,
              widgetSlug: generated.widget.slug,
              updatedExisting: generated.updatedExisting,
              viaTool: "steward_manage_widget",
            },
          });
          return {
            ok: true,
            deviceId: device.id,
            deviceName: device.name,
            updatedExisting: generated.updatedExisting,
            summary: generated.summary,
            warnings: generated.warnings,
            widget: generated.widget,
          };
        }

        if (action === "save") {
          const existing = resolveWidget();
          const name = inputString(args, "name") ?? existing?.name;
          const html = inputString(args, "html") ?? existing?.html;
          const js = inputString(args, "js") ?? existing?.js;
          const capabilitiesRaw = Array.isArray(args.capabilities)
            ? args.capabilities.filter((value): value is string =>
              typeof value === "string" && ["context", "state", "device-control"].includes(value),
            )
            : existing?.capabilities;
          const controlsRaw = Array.isArray(args.controls)
            ? args.controls.filter((value): value is DeviceWidget["controls"][number] =>
              typeof value === "object" && value !== null && !Array.isArray(value),
            )
            : existing?.controls;

          if (!name || !html || !js || !capabilitiesRaw || capabilitiesRaw.length === 0) {
            return {
              ok: false,
              error: "save requires name, html, js, and capabilities unless updating an existing widget with those fields already present.",
            };
          }

          const now = new Date().toISOString();
          const slug = inputString(args, "slug") ?? existing?.slug ?? slugifyWidgetKey(name);
          const saved = stateStore.upsertDeviceWidget({
            id: existing?.id ?? `widget-${randomUUID()}`,
            deviceId: device.id,
            slug,
            name,
            description: inputString(args, "description") ?? existing?.description,
            status: existing?.status ?? "active",
            html,
            css: inputString(args, "css") ?? existing?.css ?? "",
            js,
            capabilities: capabilitiesRaw as Array<"context" | "state" | "device-control">,
            controls: controlsRaw ?? [],
            sourcePrompt: existing?.sourcePrompt,
            createdBy: existing?.createdBy ?? "steward",
            revision: existing?.revision ?? 1,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          });
          if (!stateStore.getDeviceWidgetRuntimeState(saved.id)) {
            stateStore.upsertDeviceWidgetRuntimeState({
              widgetId: saved.id,
              deviceId: device.id,
              stateJson: {},
              updatedAt: now,
            });
          }
          await stateStore.addAction({
            actor: "steward",
            kind: "config",
            message: `${existing ? "Saved changes to" : "Saved new"} widget ${saved.name} for ${device.name}`,
            context: {
              deviceId: device.id,
              widgetId: saved.id,
              widgetSlug: saved.slug,
              updatedExisting: Boolean(existing),
              viaTool: "steward_manage_widget",
            },
          });
          return {
            ok: true,
            deviceId: device.id,
            deviceName: device.name,
            updatedExisting: Boolean(existing),
            widget: summarizeWidgetEntry(saved),
          };
        }

        if (action === "delete") {
          const widget = resolveWidget();
          if (!widget) {
            return { ok: false, error: "Existing widget not found for this device." };
          }
          const deleted = stateStore.deleteDeviceWidget(widget.id);
          if (deleted) {
            await stateStore.addAction({
              actor: "steward",
              kind: "config",
              message: `Deleted widget ${widget.name} for ${device.name}`,
              context: {
                deviceId: device.id,
                widgetId: widget.id,
                widgetSlug: widget.slug,
                viaTool: "steward_manage_widget",
              },
            });
          }
          return {
            ok: deleted,
            deviceId: device.id,
            deviceName: device.name,
            deletedWidgetId: widget.id,
            deletedWidgetSlug: widget.slug,
          };
        }

        return { ok: false, error: `Unsupported widget action: ${action}` };
      },
    });
  }

  return tools;
}

