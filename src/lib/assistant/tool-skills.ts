import { randomUUID } from "node:crypto";
import { dynamicTool, jsonSchema } from "ai";
import { adapterRegistry } from "@/lib/adapters/registry";
import { runWebResearch } from "@/lib/assistant/web-research";
import {
  computeDeviceStateHash,
  executeOperationWithGates,
} from "@/lib/adapters/execution-kernel";
import { observeBrowserSurfaces } from "@/lib/discovery/browser-observer";
import { dedupeObservations } from "@/lib/discovery/evidence";
import { fingerprintDevice } from "@/lib/discovery/fingerprint";
import { runNmapDeepFingerprint } from "@/lib/discovery/nmap-deep";
import { collectPacketIntelSnapshot } from "@/lib/discovery/packet-intel";
import { parseWinrmCommandTemplate } from "@/lib/adapters/winrm";
import { getDefaultProvider } from "@/lib/llm/config";
import { evaluatePolicy } from "@/lib/policy/engine";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import { runShell } from "@/lib/utils/shell";
import { generateAndStoreDeviceWidget } from "@/lib/widgets/generator";
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
      const community = shellEscapeSingleQuoted(inputString(input, "community", "snmp_community") ?? "public");
      const version = inputString(input, "snmp_version", "version") ?? "2c";
      const oid = inputString(input, "oid", "snmp_oid") ?? "SNMPv2-MIB::sysDescr.0";
      const port = inputPort(input) ?? 161;
      const command = userCommand
        || `snmpget -v${version} -c '${community}' {{host}}:${port} ${oid} 2>/dev/null`;
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

    if (kind === "shell.command") {
      const command = typeof input.command === "string" && input.command.trim().length > 0
        ? input.command.trim()
        : "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime";
      return {
        protocol: "winrm",
        command,
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

  const adapterId = typeof input.adapter_id === "string"
    ? input.adapter_id.trim()
    : (execution.adapterId ?? inferAdapterForKind(kind, device));

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

      const updatedDevice: Device = {
        ...device,
        services: mergeServiceSet(device.services, candidate.services),
        hostname: device.hostname ?? candidate.hostname,
        os: device.os ?? candidate.os,
        metadata: {
          ...device.metadata,
          deepProbe: {
            lastRunAt: nowIso(),
            summary,
          },
        },
        lastSeenAt: nowIso(),
        lastChangedAt: nowIso(),
      };
      await stateStore.upsertDevice(updatedDevice);

      await stateStore.addAction({
        actor: "user",
        kind: "diagnose",
        message: `Deep probe completed for ${device.name}`,
        context: {
          deviceId: device.id,
          servicesBefore: device.services.length,
          servicesAfter: updatedDevice.services.length,
          observations: mergedObservations.length,
          summary,
        },
      });

      return {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        observations: mergedObservations.length,
        services: updatedDevice.services.map((service) => `${service.name}:${service.port}`),
        summary,
      };
    },
  });

  tools.steward_web_research = dynamicTool({
    description: "Search the public web for current or external information and optionally read top result pages. Use this for research, vendor docs, CVEs, current guidance, and anything Steward cannot verify from local state alone.",
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

      const result = await runWebResearch(query, {
        timeoutMs: runtime.webResearchTimeoutMs,
        maxResults: Math.min(
          runtime.webResearchMaxResults,
          clampInt(args.max_results, 1, 10, runtime.webResearchMaxResults),
        ),
        deepReadPages: Math.min(
          runtime.webResearchDeepReadPages,
          clampInt(args.deep_read_pages, 0, 5, runtime.webResearchDeepReadPages),
        ),
      });

      await stateStore.addAction({
        actor: "user",
        kind: "diagnose",
        message: `Public web research executed for query: ${query}`,
        context: {
          query,
          ok: result.ok,
          engine: result.engine,
          resultCount: result.resultCount,
          consultedCount: result.consultedCount,
          warnings: result.warnings,
        },
      });

      return result;
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
