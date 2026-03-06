import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dynamicTool, jsonSchema } from "ai";
import { adapterRegistry } from "@/lib/adapters/registry";
import {
  requiresWebResearchApiKey,
  webResearchApiKeySecretRef,
} from "@/lib/assistant/web-research-config";
import { runWebResearch } from "@/lib/assistant/web-research";
import { markCredentialValidatedFromUse } from "@/lib/adoption/credentials";
import {
  computeDeviceStateHash,
  executeOperationWithGates,
} from "@/lib/adapters/execution-kernel";
import { observeBrowserSurfaces } from "@/lib/discovery/browser-observer";
import { candidateToDevice } from "@/lib/discovery/classify";
import { dedupeObservations } from "@/lib/discovery/evidence";
import { fingerprintDevice } from "@/lib/discovery/fingerprint";
import { runNmapDeepFingerprint } from "@/lib/discovery/nmap-deep";
import { collectPacketIntelSnapshot } from "@/lib/discovery/packet-intel";
import { parseWinrmCommandTemplate } from "@/lib/adapters/winrm";
import { getDefaultProvider } from "@/lib/llm/config";
import { evaluatePolicy } from "@/lib/policy/engine";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { getDataDir } from "@/lib/state/db";
import { stateStore } from "@/lib/state/store";
import { vault } from "@/lib/security/vault";
import { runShell } from "@/lib/utils/shell";
import { generateAndStoreDeviceWidget } from "@/lib/widgets/generator";
import { DEVICE_TYPE_VALUES, type DeviceType } from "@/lib/state/types";
import type {
  ActionClass,
  Device,
  LLMProvider,
  OperationKind,
  OperationMode,
  OperationSpec,
  ProtocolBrokerRequest,
  ServiceFingerprint,
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

const BROWSER_BROWSE_ARTIFACT_RELATIVE_DIR = "artifacts/browser-browse";

function ensureBrowserBrowseArtifactDir(): string {
  const absoluteDir = path.join(getDataDir(), "artifacts", "browser-browse");
  mkdirSync(absoluteDir, { recursive: true });
  return absoluteDir;
}

function createBrowserBrowseScreenshotArtifact(ext: "jpg" | "png"): { absolutePath: string; relativePath: string } {
  const dir = ensureBrowserBrowseArtifactDir();
  const fileName = `${Date.now()}-${randomUUID()}.${ext}`;
  const absolutePath = path.join(dir, fileName);
  const relativePath = `${BROWSER_BROWSE_ARTIFACT_RELATIVE_DIR}/${fileName}`;
  return { absolutePath, relativePath };
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

function sanitizeSnmpToken(value: string | undefined, fallback: string, pattern: RegExp): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return pattern.test(trimmed) ? trimmed : fallback;
}

function normalizeCredentialProtocol(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "windows") return "winrm";
  if (normalized === "http" || normalized === "https") return "http-api";
  return normalized;
}

function resolveMode(kind: OperationKind, requested?: unknown): OperationMode {
  if (requested === "read" || requested === "mutate") {
    return requested;
  }
  return MUTATING_KINDS.has(kind) ? "mutate" : "read";
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

  const normalized = target.toLowerCase();
  const state = await stateStore.getState();
  return state.devices.find((device) =>
    device.ip.toLowerCase() === normalized || device.name.toLowerCase() === normalized,
  ) ?? null;
}

function validateDeviceReadyForToolUse(
  device: Device,
  options?: { allowPreOnboardingExecution?: boolean },
): { ok: true } | { ok: false; reason: string } {
  const adoptionStatus = getDeviceAdoptionStatus(device);
  if (options?.allowPreOnboardingExecution) {
    if (adoptionStatus === "ignored") {
      return { ok: false, reason: `Device ${device.name} is ignored and cannot be probed in onboarding.` };
    }
    return { ok: true };
  }

  if (adoptionStatus !== "adopted") {
    return { ok: false, reason: `Device ${device.name} is not adopted yet.` };
  }

  const run = stateStore.getLatestAdoptionRun(device.id);
  if (!run || run.status !== "completed") {
    return { ok: false, reason: `Device ${device.name} onboarding is not complete yet.` };
  }

  const unresolvedRequired = stateStore
    .getAdoptionQuestions(device.id, { runId: run.id, unresolvedOnly: true })
    .filter((question) => question.required)
    .length;

  if (unresolvedRequired > 0) {
    return {
      ok: false,
      reason: `Device ${device.name} still has ${unresolvedRequired} required onboarding questions pending.`,
    };
  }

  return { ok: true };
}

function hasSelectedAccessSurfaceForAdapter(deviceId: string, adapterId: string): boolean {
  const accessSurfaces = stateStore.getAccessSurfaces(deviceId);
  if (accessSurfaces.length === 0) {
    return true;
  }
  return accessSurfaces.some((surface) => surface.selected && surface.adapterId === adapterId);
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
  try {
    const moduleName = "playwright";
    const mod = await import(moduleName);
    const chromium = (mod as Record<string, unknown>).chromium as { executablePath?: () => string } | undefined;
    const executable = chromium?.executablePath?.();
    return typeof executable === "string" && executable.trim().length > 0;
  } catch {
    return false;
  }
}

function inferAdapterForKind(kind: OperationKind, device: Device): string {
  const protocols = new Set(device.protocols.map((protocol) => protocol.toLowerCase()));

  if (kind === "http.request") return "http-api";
  if (kind === "container.restart" || kind === "container.stop") return "docker";
  if (kind === "service.restart" || kind === "service.stop") {
    if (protocols.has("winrm")) return "winrm";
    if (protocols.has("ssh")) return "ssh";
  }
  if (kind === "shell.command") {
    if (protocols.has("ssh")) return "ssh";
    if (protocols.has("winrm")) return "winrm";
    if (protocols.has("docker")) return "docker";
    if (protocols.has("snmp")) return "snmp";
  }
  if (protocols.has("ssh")) return "ssh";
  if (protocols.has("winrm")) return "winrm";
  if (protocols.has("docker")) return "docker";
  if (protocols.has("http-api") || protocols.has("http")) return "http-api";
  return "ssh";
}

const HTTP_PORT_PREFERENCE = [80, 8080, 8000, 9000, 5000, 443, 8443, 7443, 9443, 5001];
const HTTPS_PORT_HINTS = new Set([443, 8443, 7443, 9443, 5001, 5986, 8883, 2376]);
const HTTP_PORT_HINTS = new Set([80, 8080, 8000, 9000, 5000, 5985, 1883, 2375]);
const SSH_PORT_PREFERENCE = [22, 2222, 2200];
const WINRM_PORT_PREFERENCE = [5985, 5986];
const DOCKER_PORT_PREFERENCE = [2375, 2376];
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

function inputBoolean(input: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

const INVALID_DEVICE_NAME_TOKENS = new Set([
  "this",
  "that",
  "it",
  "device",
  "host",
  "box",
  "machine",
  "appliance",
  "thing",
]);

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

function normalizeDeviceNameInput(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.?!,;:]+$/, "");
}

function isAcceptableDeviceName(value: string): boolean {
  const normalized = normalizeDeviceNameInput(value);
  if (normalized.length < 2 || normalized.length > 128) {
    return false;
  }
  const lowered = normalized.toLowerCase();
  if (INVALID_DEVICE_NAME_TOKENS.has(lowered)) {
    return false;
  }
  if (/^(?:this|that|it)(?:\s+device)?$/i.test(lowered)) {
    return false;
  }
  return true;
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
  const identityName = typeof identity?.name === "string" ? normalizeDeviceNameInput(identity.name) : "";
  if (identityName && isAcceptableDeviceName(identityName)) {
    return identityName;
  }

  const inferredProduct = isRecord(device.metadata.fingerprint)
    && typeof device.metadata.fingerprint.inferredProduct === "string"
    ? normalizeDeviceNameInput(device.metadata.fingerprint.inferredProduct)
    : "";
  if (inferredProduct && isAcceptableDeviceName(inferredProduct)) {
    return inferredProduct;
  }

  if (device.hostname) {
    const host = normalizeDeviceNameInput(device.hostname);
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

interface PlaywrightChromium {
  launch: (options: Record<string, unknown>) => Promise<{
    newContext: (options: Record<string, unknown>) => Promise<{
      newPage: () => Promise<{
        on: (event: string, handler: (...args: unknown[]) => void) => void;
        goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
        click: (selector: string, options?: Record<string, unknown>) => Promise<void>;
        hover: (selector: string, options?: Record<string, unknown>) => Promise<void>;
        fill: (selector: string, value: string, options?: Record<string, unknown>) => Promise<void>;
        press: (selector: string, key: string, options?: Record<string, unknown>) => Promise<void>;
        check: (selector: string, options?: Record<string, unknown>) => Promise<void>;
        uncheck: (selector: string, options?: Record<string, unknown>) => Promise<void>;
        selectOption: (selector: string, values: string | string[], options?: Record<string, unknown>) => Promise<void>;
        waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
        waitForURL: (urlOrRegex: string | RegExp, options?: Record<string, unknown>) => Promise<unknown>;
        waitForTimeout: (timeout: number) => Promise<void>;
        title: () => Promise<string>;
        url: () => string;
        content: () => Promise<string>;
        screenshot: (options?: Record<string, unknown>) => Promise<Uint8Array>;
        evaluate: <T>(fn: (...args: unknown[]) => T, arg?: unknown) => Promise<T>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  }>;
}

async function loadPlaywrightChromium(): Promise<PlaywrightChromium | null> {
  try {
    const moduleName = "playwright";
    const mod = await import(moduleName);
    const chromium = (mod as Record<string, unknown>).chromium;
    if (chromium && typeof chromium === "object" && "launch" in chromium) {
      return chromium as PlaywrightChromium;
    }
  } catch {
    // Playwright may be unavailable in minimal installs.
  }
  return null;
}

async function resolveBrowserCredential(device: Device): Promise<{
  credentialId?: string;
  username?: string;
  password?: string;
}> {
  const candidates = stateStore.getDeviceCredentials(device.id)
    .filter((credential) => credential.protocol.toLowerCase() === "http-api");
  if (candidates.length === 0) {
    return {};
  }
  const priority = ["validated", "provided", "invalid", "pending"] as const;
  const sorted = [...candidates].sort((a, b) => {
    const aPriority = priority.indexOf(a.status as (typeof priority)[number]);
    const bPriority = priority.indexOf(b.status as (typeof priority)[number]);
    if (aPriority !== bPriority) {
      return (aPriority === -1 ? 99 : aPriority) - (bPriority === -1 ? 99 : bPriority);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const selected = sorted[0];
  if (!selected) {
    return {};
  }
  const secret = await vault.getSecret(selected.vaultSecretRef);
  if (!secret || secret.trim().length === 0) {
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

function normalizeToolInput(args: ExecuteArgs & Record<string, unknown>): Record<string, unknown> {
  const nested = isRecord(args.input) ? { ...args.input } : {};
  const topLevelEntries = Object.entries(args)
    .filter(([key, value]) => key !== "device_id" && key !== "input" && value !== undefined);
  for (const [key, value] of topLevelEntries) {
    nested[key] = value;
  }
  return nested;
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

    if (safePort === undefined && device) {
      const webServices = device.services
        .filter((service) =>
          service.transport === "tcp"
          && (
            HTTP_PORT_HINTS.has(service.port)
            || HTTPS_PORT_HINTS.has(service.port)
            || /http|https|web|api/i.test(service.name)
          ))
        .sort((a, b) => {
          const ai = HTTP_PORT_PREFERENCE.indexOf(a.port);
          const bi = HTTP_PORT_PREFERENCE.indexOf(b.port);
          const aRank = ai === -1 ? 999 : ai;
          const bRank = bi === -1 ? 999 : bi;
          if (aRank !== bRank) {
            return aRank - bRank;
          }
          return a.port - b.port;
        });

      const preferred = webServices[0];
      if (preferred) {
        safePort = preferred.port;
        if (secure === undefined) {
          secure = preferred.secure || HTTPS_PORT_HINTS.has(preferred.port);
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
    if (adapterId === "docker") {
      const command = userCommand || "ps --format '{{.Names}} {{.Status}} {{.Image}}'";
      return `docker -H ${dockerHostTarget(device, input)} ${command}`;
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

  if (kind === "http.request") {
    const urlOverride = normalizeHttpTargetInput(input);
    const secureFromInput = inputSecurePreference(input) ?? urlOverride.secure;
    const port = Number(input.port ?? urlOverride.port);
    const explicitPort = Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : undefined;
    let secure = secureFromInput;
    let safePort = explicitPort;

    if (safePort === undefined && device) {
      const webServices = device.services
        .filter((service) =>
          service.transport === "tcp"
          && (
            HTTP_PORT_HINTS.has(service.port)
            || HTTPS_PORT_HINTS.has(service.port)
            || /http|https|web|api/i.test(service.name)
          ))
        .sort((a, b) => a.port - b.port);
      const preferred = webServices[0];
      if (preferred) {
        safePort = preferred.port;
        if (secure === undefined) {
          secure = preferred.secure || HTTPS_PORT_HINTS.has(preferred.port);
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
      argv: ["sh", "-lc", command],
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

function buildCommonToolArgumentProperties(): Record<string, unknown> {
  return {
    device_id: { type: "string", description: "Target device id, exact name, or IP." },
    operation_kind: { type: "string", description: "Optional operation override when a skill supports multiple actions." },
    mode: { type: "string", description: "Optional mode override: read or mutate." },
    adapter_id: { type: "string", description: "Optional adapter override when multiple protocols are possible." },
    protocol: { type: "string", description: "Optional protocol override such as ssh, winrm, docker, snmp, or http-api." },
    port: { type: "integer", description: "Optional management port override for this tool call." },
    secure: { type: "boolean", description: "Optional secure transport hint, such as HTTPS or WinRM over TLS." },
    use_ssl: { type: "boolean", description: "Alias for secure transport where applicable." },
    authentication: { type: "string", description: "Optional authentication mode override, such as basic or negotiate for WinRM." },
    winrm_authentication: { type: "string", description: "Optional WinRM authentication mode override." },
    scheme: { type: "string", description: "Optional URL scheme override, typically http or https." },
    url: { type: "string", description: "Optional full target URL for HTTP-oriented tools; host is normalized to the attached device." },
    path: { type: "string", description: "Optional request path for HTTP-style tools." },
    method: { type: "string", description: "Optional HTTP method override: GET, POST, PUT, PATCH, DELETE." },
    headers: { type: "object", description: "Optional HTTP headers for this tool call.", additionalProperties: true },
    query: { type: "object", description: "Optional HTTP query parameters.", additionalProperties: true },
    body: { type: ["string", "object", "array"], description: "Optional request body for HTTP tools." },
    expect_regex: { type: "string", description: "Optional HTTP response regex expectation." },
    insecure_skip_verify: { type: "boolean", description: "Skip TLS verification for this call when true." },
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

  const adapterId = explicitAdapterId
    || protocolHint
    || execution.adapterId
    || (kind === "shell.command" && hasSnmpInputHints(input)
      ? "snmp"
      : inferAdapterForKind(kind, device));

  const mode = resolveMode(kind, input.mode ?? execution.mode);

  const commandFromInput = typeof input.command_template === "string" ? input.command_template.trim() : "";
  const commandFromKindConfig = execution.commandTemplates?.[kind]?.trim() ?? "";
  const commandFromConfig = execution.commandTemplate?.trim() ?? "";
  const hasExplicitCommandTemplate = Boolean(commandFromInput || commandFromKindConfig || commandFromConfig);
  let brokerRequest = hasExplicitCommandTemplate
    ? undefined
    : defaultBrokerRequest(kind, adapterId, input, device);
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
  return operation.mode === "read" ? "A" : "C";
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

  return {
    kind,
    mode,
    adapterId,
    timeoutMs: safeTimeout,
    expectedSemanticTarget,
    commandTemplate,
    commandTemplates,
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

export async function buildAdapterSkillTools(
  options?: {
    attachedDeviceId?: string;
    allowPreOnboardingExecution?: boolean;
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
        const args = isRecord(argsUnknown) ? (argsUnknown as ExecuteArgs) : {};
        const input = normalizeToolInput(args as ExecuteArgs & Record<string, unknown>);

        const device = await resolveDeviceByTarget(args.device_id, options?.attachedDeviceId);
        if (!device) {
          return {
            ok: false,
            error: "Tool call requires a valid device_id (device id, IP, or exact name).",
          };
        }

        const readiness = validateDeviceReadyForToolUse(device, {
          allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
        });
        if (!readiness.ok) {
          return { ok: false, error: readiness.reason, deviceId: device.id };
        }

        if (!options?.allowPreOnboardingExecution && !hasSelectedAccessSurfaceForAdapter(device.id, descriptor.adapterId)) {
          return {
            ok: false,
            blocked: "binding",
            error: `Adapter ${descriptor.adapterName} is not selected for ${device.name}. Complete adapter binding in onboarding first.`,
          };
        }

        const planned = buildOperationFromDescriptor(descriptor, device, input);
        if ("error" in planned) {
          return {
            ok: false,
            blocked: "execution_config",
            error: planned.error,
            skillId: descriptor.skillId,
          };
        }

        const operation = planned.operation;
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
          idempotencySeed: `${descriptor.skillId}:${device.id}:${nowIso()}`,
          params: {},
        });

        await stateStore.addAction({
          actor: "user",
          kind: "diagnose",
          message: `Adapter skill executed: ${descriptor.skillName} on ${device.name}`,
          context: {
            deviceId: device.id,
            adapterId: descriptor.adapterId,
            adapterName: descriptor.adapterName,
            skillId: descriptor.skillId,
            toolCallName: descriptor.toolCallName,
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
          adapterId: descriptor.adapterId,
          skillId: descriptor.skillId,
          operationKind: operation.kind,
          operationMode: operation.mode,
          output: execution.output,
          gates: execution.gateResults,
          idempotencyKey: execution.idempotencyKey,
        };
      },
    });
  }

  tools.steward_shell_read = dynamicTool({
    description: "Run an investigative read-only command over SSH/WinRM/Docker. Use port for non-default management ports instead of embedding ssh wrappers in the command.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP" },
        command: { type: "string", description: "Read-only command to execute remotely" },
        protocol: { type: "string", description: "Optional protocol override: ssh, winrm, docker" },
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
        return { ok: false, error: "Valid device_id is required." };
      }

      const readiness = validateDeviceReadyForToolUse(device, {
        allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id };
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
      const port = coercePort(args.port) ?? normalizedShellInput.port;
      const shellInput = {
        command: normalizedShellInput.command,
        ...(port ? { port } : {}),
      };
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

      return {
        ok: execution.ok,
        deviceId: device.id,
        deviceName: device.name,
        adapterId,
        summary: execution.summary,
        reason: execution.ok ? undefined : execution.summary,
        output: execution.output,
        gates: execution.gateResults,
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
        return { ok: false, error: "Valid device_id is required." };
      }

      const readiness = validateDeviceReadyForToolUse(device, {
        allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id };
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

  tools.steward_web_research = dynamicTool({
    description: "Search the public web for current or external information and optionally read result pages. The model should decide breadth/depth per task, then iterate: first pass, inspect findings, optionally read more via read_from_result, or re-run with a refined query.",
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
      const chromium = await loadPlaywrightChromium();
      if (!chromium) {
        return {
          ok: false,
          error: "Playwright is not available on this Steward host.",
        };
      }

      const timeoutMs = clampInt(args.post_login_wait_ms, 0, 60_000, 1_000);
      const providedUsername = inputString(args, "username");
      const providedPassword = inputString(args, "password");
      const stored = device && useStoredCredentials
        ? await resolveBrowserCredential(device)
        : {};
      const username = providedUsername ?? stored.username;
      const password = providedPassword ?? stored.password;

      const usernameSelector = inputString(args, "username_selector");
      const passwordSelector = inputString(args, "password_selector");
      const submitSelector = inputString(args, "submit_selector");
      const waitForSelector = inputString(args, "wait_for_selector");
      const collectDiagnostics = inputBoolean(args, "collect_diagnostics") !== false;
      const includeHtml = inputBoolean(args, "include_html") === true;
      const rawSteps = Array.isArray(args.steps) ? args.steps.filter(isRecord) : [];

      let browser: Awaited<ReturnType<PlaywrightChromium["launch"]>> | null = null;
      let context: Awaited<ReturnType<Awaited<ReturnType<PlaywrightChromium["launch"]>>["newContext"]>> | null = null;
      let page: Awaited<ReturnType<Awaited<ReturnType<Awaited<ReturnType<PlaywrightChromium["launch"]>>["newContext"]>>["newPage"]>> | null = null;
      try {
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({
          ignoreHTTPSErrors: true,
        });
        page = await context.newPage();

        const consoleErrors: string[] = [];
        const requestFailures: string[] = [];
        const pageErrors: string[] = [];
        const stepResults: Array<Record<string, unknown>> = [];
        if (collectDiagnostics) {
          page.on("console", (...args) => {
            const message = args[0] as { type?: () => string; text?: () => string } | undefined;
            const type = message?.type?.() ?? "log";
            const text = message?.text?.() ?? "";
            if ((type === "error" || type === "warning") && text.trim().length > 0) {
              consoleErrors.push(`${type}: ${text.trim()}`);
            }
          });
          page.on("requestfailed", (...args) => {
            const request = args[0] as {
              method?: () => string;
              url?: () => string;
              failure?: () => { errorText?: string } | null;
            } | undefined;
            const method = request?.method?.() ?? "REQUEST";
            const url = request?.url?.() ?? "unknown-url";
            const failure = request?.failure?.()?.errorText ?? "request failed";
            requestFailures.push(`${method} ${url} :: ${failure}`);
          });
          page.on("pageerror", (...args) => {
            const err = args[0];
            const text = err instanceof Error ? err.message : String(err);
            if (text.trim().length > 0) {
              pageErrors.push(text.trim());
            }
          });
        }

        await page.goto(parsedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });

        let usedStoredCredential = false;
        if (usernameSelector && passwordSelector && username && password) {
          await page.fill(usernameSelector, username, { timeout: 15_000 });
          await page.fill(passwordSelector, password, { timeout: 15_000 });
          if (submitSelector) {
            await page.click(submitSelector, { timeout: 15_000 });
          } else {
            await page.press(passwordSelector, "Enter", { timeout: 15_000 });
          }
          if (timeoutMs > 0) {
            await page.waitForTimeout(timeoutMs);
          }
          usedStoredCredential = Boolean(stored.credentialId) && !providedPassword;
        }

        for (const step of rawSteps) {
          const action = typeof step.action === "string" ? step.action : "";
          const selector = typeof step.selector === "string" ? step.selector : "";
          const value = typeof step.value === "string" ? step.value : "";
          const url = typeof step.url === "string" ? step.url : "";
          const script = typeof step.script === "string" ? step.script : "";
          const label = typeof step.label === "string" ? step.label : undefined;
          const screenshotPath = typeof step.path === "string" ? step.path : undefined;
          const fullPage = typeof step.full_page === "boolean" ? step.full_page : false;
          const stepTimeout = clampInt(step.timeout_ms, 200, 120_000, 15_000);
          try {
            if (action === "goto") {
              const destination = url || value;
              if (!destination) {
                throw new Error("goto requires url or value");
              }
              await page.goto(destination, { waitUntil: "domcontentloaded", timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, url: page.url() });
            } else if (action === "click") {
              if (!selector) throw new Error("click requires selector");
              await page.click(selector, { timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, selector });
            } else if (action === "hover") {
              if (!selector) throw new Error("hover requires selector");
              await page.hover(selector, { timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, selector });
            } else if (action === "fill") {
              if (!selector) throw new Error("fill requires selector");
              await page.fill(selector, value, { timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, selector });
            } else if (action === "press") {
              if (!selector) throw new Error("press requires selector");
              await page.press(selector, value || "Enter", { timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, selector, key: value || "Enter" });
            } else if (action === "check") {
              if (!selector) throw new Error("check requires selector");
              await page.check(selector, { timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, selector });
            } else if (action === "uncheck") {
              if (!selector) throw new Error("uncheck requires selector");
              await page.uncheck(selector, { timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, selector });
            } else if (action === "select") {
              if (!selector) throw new Error("select requires selector");
              const values = value.includes("|")
                ? value.split("|").map((item) => item.trim()).filter(Boolean)
                : value;
              await page.selectOption(selector, values, { timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, selector, value });
            } else if (action === "wait_for_selector") {
              if (!selector) throw new Error("wait_for_selector requires selector");
              await page.waitForSelector(selector, { timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, selector });
            } else if (action === "wait_for_url") {
              const destination = url || value;
              if (!destination) throw new Error("wait_for_url requires url or value");
              await page.waitForURL(destination, { timeout: stepTimeout });
              stepResults.push({ action, label, ok: true, url: page.url() });
            } else if (action === "wait_for_timeout") {
              const waitMs = clampInt(step.timeout_ms, 0, 120_000, 1_000);
              await page.waitForTimeout(waitMs);
              stepResults.push({ action, label, ok: true, waitMs });
            } else if (action === "extract_text") {
              const extracted = await page.evaluate((args) => {
                const s = typeof args === "object" && args !== null && "selector" in args
                  ? String((args as Record<string, unknown>).selector ?? "")
                  : "";
                if (!s) {
                  return document.body?.innerText ?? "";
                }
                const element = document.querySelector(s);
                return element?.textContent ?? "";
              }, { selector });
              stepResults.push({ action, label, ok: true, selector: selector || "body", text: String(extracted).trim().slice(0, 2_000) });
            } else if (action === "extract_html") {
              const extracted = await page.evaluate((args) => {
                const s = typeof args === "object" && args !== null && "selector" in args
                  ? String((args as Record<string, unknown>).selector ?? "")
                  : "";
                if (!s) {
                  return document.documentElement?.outerHTML ?? "";
                }
                const element = document.querySelector(s);
                return element?.outerHTML ?? "";
              }, { selector });
              stepResults.push({ action, label, ok: true, selector: selector || "html", htmlPreview: String(extracted).trim().slice(0, 2_000) });
            } else if (action === "expect_text") {
              if (!value) throw new Error("expect_text requires value");
              const matched = await page.evaluate((args) => {
                const input = args as Record<string, unknown>;
                const selectorValue = typeof input.selector === "string" ? input.selector : "";
                const expected = typeof input.expected === "string" ? input.expected : "";
                const text = selectorValue
                  ? (document.querySelector(selectorValue)?.textContent ?? "")
                  : (document.body?.innerText ?? "");
                return text.includes(expected);
              }, { selector, expected: value });
              if (!matched) {
                throw new Error(`Expected text not found: ${value}`);
              }
              stepResults.push({ action, label, ok: true, selector: selector || "body", expected: value });
            } else if (action === "evaluate") {
              if (!script) throw new Error("evaluate requires script");
              const evalResult = await page.evaluate((source) => {
                const executable = new Function(`return (${source});`)();
                if (typeof executable === "function") {
                  return executable();
                }
                return executable;
              }, script);
              stepResults.push({
                action,
                label,
                ok: true,
                result: typeof evalResult === "string"
                  ? evalResult.slice(0, 2_000)
                  : JSON.stringify(evalResult).slice(0, 2_000),
              });
            } else if (action === "screenshot") {
              const inlineArtifact = screenshotPath
                ? undefined
                : createBrowserBrowseScreenshotArtifact(fullPage ? "png" : "jpg");
              const targetPath = screenshotPath ?? inlineArtifact?.absolutePath;
              const shot = await page.screenshot(
                targetPath
                  ? {
                    path: targetPath,
                    fullPage,
                  }
                  : {
                    fullPage,
                    type: "jpeg",
                    quality: 65,
                  },
              );
              stepResults.push({
                action,
                label,
                ok: true,
                ...(inlineArtifact
                  ? {
                    path: inlineArtifact.relativePath,
                    mimeType: fullPage ? "image/png" : "image/jpeg",
                  }
                  : screenshotPath
                    ? { path: screenshotPath }
                    : {
                      screenshotBase64: Buffer.from(shot).toString("base64"),
                      mimeType: "image/jpeg",
                    }),
                bytes: shot.byteLength,
              });
            } else {
              throw new Error(`Unsupported step action: ${action}`);
            }
          } catch (stepError) {
            const message = stepError instanceof Error ? stepError.message : String(stepError);
            throw new Error(`Browser step failed (${action || "unknown"}${label ? `:${label}` : ""}): ${message}`);
          }
        }

        if (waitForSelector) {
          await page.waitForSelector(waitForSelector, { timeout: 15_000 });
        }

        const finalUrl = page.url();
        const title = await page.title();
        const text = await page.evaluate(() => document.body?.innerText ?? "");
        const contentPreview = text.trim().replace(/\s+/g, " ").slice(0, 1_200);
        const htmlPreview = includeHtml
          ? (await page.content()).slice(0, 6_000)
          : undefined;

        if (device && usedStoredCredential && markCredentialValidated && stored.credentialId) {
          await markCredentialValidatedFromUse({
            deviceId: device.id,
            credentialId: stored.credentialId,
            actor: "user",
            method: "playwright.browser",
            details: {
              url: parsedUrl.toString(),
              finalUrl,
              title,
            },
          });
        }

        return {
          ok: true,
          deviceId: device?.id,
          deviceName: device?.name,
          url: parsedUrl.toString(),
          finalUrl,
          title,
          usedStoredCredential,
          credentialId: usedStoredCredential ? stored.credentialId : undefined,
          contentPreview,
          htmlPreview,
          stepsExecuted: stepResults.length,
          stepResults,
          diagnostics: collectDiagnostics
            ? {
              consoleErrors: consoleErrors.slice(0, 40),
              requestFailures: requestFailures.slice(0, 40),
              pageErrors: pageErrors.slice(0, 20),
            }
            : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: `Playwright browser flow failed: ${message}`,
          url: parsedUrl.toString(),
          deviceId: device?.id,
          deviceName: device?.name,
        };
      } finally {
        if (page) {
          try {
            await page.close();
          } catch {
            // ignore
          }
        }
        if (context) {
          try {
            await context.close();
          } catch {
            // ignore
          }
        }
        if (browser) {
          try {
            await browser.close();
          } catch {
            // ignore
          }
        }
      }
    },
  });

  tools.steward_manage_device = dynamicTool({
    description: "Get or update first-party device settings (name, category, notes, tags, autonomy) with guardrails against placeholder names.",
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
        return { ok: false, error: "Valid device_id is required or chat must be attached to a device." };
      }

      const readiness = validateDeviceReadyForToolUse(device, {
        allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id };
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
      const normalizedName = typeof nextNameRaw === "string" ? normalizeDeviceNameInput(nextNameRaw) : null;
      if (normalizedName !== null && !isAcceptableDeviceName(normalizedName)) {
        return {
          ok: false,
          error: `Invalid device name '${normalizedName}'. Provide a specific name (not placeholders like 'this').`,
          deviceId: device.id,
        };
      }

      const nextCategory = parseDeviceCategory(inputCategory)
        ?? (inferCategory ? inferManageableDeviceCategory(device) : null);

      const changedFields: string[] = [];
      const previousName = device.name;
      const previousCategory = device.type;
      const previousAutonomy = device.autonomyTier;

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

      if (changedFields.length === 0) {
        return {
          ok: true,
          deviceId: device.id,
          deviceName: device.name,
          changedFields,
          summary: `No device setting changes were needed for ${device.name}.`,
        };
      }

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
        inferredName: Boolean(inferName && !inputName && normalizedName),
        inferredCategory: Boolean(inferCategory && !inputCategory && nextCategory),
        summary: `Updated ${device.name}: ${changedFields.join(", ")}.`,
      };
    },
  });

  tools.steward_manage_widget = dynamicTool({
    description: "Create, inspect, revise, save, list, or delete persistent device widgets for a device page. Use this for remotes, dashboards, control panels, and operational panels. Inspect existing widget runtime state and recent operation runs before revising broken widgets. Prefer action='generate' for AI-driven create/revise work because generate persists immediately; use save only when manually providing final HTML/CSS/JS.",
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
        return { ok: false, error: "Valid device_id is required or chat must be attached to a device." };
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
          widgets: widgets.map((widget) => ({
            id: widget.id,
            slug: widget.slug,
            name: widget.name,
            description: widget.description,
            status: widget.status,
            revision: widget.revision,
            capabilities: widget.capabilities,
            updatedAt: widget.updatedAt,
          })),
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
          widget,
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
          widget: saved,
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

  return tools;
}
