import net from "node:net";
import { interpolateOperationValue } from "@/lib/adapters/execution-template";
import {
  analyzeWinrmFailure,
  buildWinrmPowerShellScript,
  isWinrmIpLiteral,
  normalizeWinrmOutput,
  powerShellInstallHint,
  preferredWinrmHost,
  sanitizeWinrmHostCandidate,
  resolvePowerShellRuntime,
  resolveWinrmConnection,
} from "@/lib/adapters/winrm";
import { getStewardHostNetworkSummary } from "@/lib/discovery/local";
import { requestText } from "@/lib/network/http-client";
import {
  renderMqttBrokerRequest,
} from "@/lib/network/mqtt-client";
import { markCredentialValidatedFromUse } from "@/lib/adoption/credentials";
import {
  applyPathSegmentCredentialToPath,
  getHttpApiCredentialAuth,
} from "@/lib/credentials/http-api";
import { localToolRuntime } from "@/lib/local-tools/runtime";
import { protocolSessionManager } from "@/lib/protocol-sessions/manager";
import { normalizeCredentialProtocol, protocolDisplayLabel } from "@/lib/protocols/catalog";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import { runCommand } from "@/lib/utils/shell";
import { webSessionManager } from "@/lib/web-sessions/manager";
import type {
  Device,
  DeviceCredential,
  OperationExecutionPhase,
  OperationExecutionProof,
  OperationExecutionStatus,
  OperationSpec,
  WinrmAuthentication,
  WebSocketSuccessStrategy,
} from "@/lib/state/types";

export interface BrokerExecutionContext {
  actor: "steward" | "user";
  playbookRunId?: string;
  allowUnauthenticated?: boolean;
  allowProvidedCredentials?: boolean;
}

export interface BrokerExecutionResult {
  handled: boolean;
  ok: boolean;
  status: OperationExecutionStatus;
  phase: OperationExecutionPhase;
  proof: OperationExecutionProof;
  summary: string;
  output: string;
  details: Record<string, unknown>;
}

const TELNET_IAC = 255;
const TELNET_DONT = 254;
const TELNET_DO = 253;
const TELNET_WONT = 252;
const TELNET_WILL = 251;
const TELNET_SB = 250;
const TELNET_SE = 240;
const TELNET_IDLE_SETTLE_MS = 900;

function brokerResult(input: {
  handled?: boolean;
  status: OperationExecutionStatus;
  phase: OperationExecutionPhase;
  proof: OperationExecutionProof;
  summary: string;
  output: string;
  details?: Record<string, unknown>;
}): BrokerExecutionResult {
  return {
    handled: input.handled ?? true,
    ok: input.status === "succeeded",
    status: input.status,
    phase: input.phase,
    proof: input.proof,
    summary: input.summary,
    output: input.output,
    details: input.details ?? {},
  };
}

function formatCommandOutput(result: { ok: boolean; stdout: string; stderr: string; code: number }): BrokerExecutionResult {
  const output = `${result.stdout}${result.stderr ? `\n[stderr] ${result.stderr}` : ""}`.trim();
  if (!result.ok) {
    return brokerResult({
      status: "failed",
      phase: "executed",
      proof: "process",
      summary: `Command exited with code ${result.code}`,
      output: `${output}\n[exit code: ${result.code}]`.trim(),
      details: { exitCode: result.code },
    });
  }

  return brokerResult({
    status: "succeeded",
    phase: "executed",
    proof: "process",
    summary: "Command completed successfully",
    output,
    details: { exitCode: result.code },
  });
}

interface TrustedSshHostKeyRecord {
  host: string;
  port: number;
  keyId: string;
  trustedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretIsMissing(secret: string | undefined | null): secret is undefined | null {
  return secret === undefined || secret === null;
}

function getCredentialCandidatesForBroker(
  deviceId: string,
  protocols: string[],
  adapterId?: string,
): { candidates: DeviceCredential[]; availableStatuses: string[] } {
  const normalizedProtocols = new Set(protocols.map((protocol) => normalizeCredentialProtocol(protocol)));
  const candidates = stateStore.getDeviceCredentials(deviceId)
    .filter((credential) => normalizedProtocols.has(normalizeCredentialProtocol(credential.protocol)));

  const priority = ["validated", "provided", "invalid", "pending"] as const;
  const adapterPreference = (credential: DeviceCredential): number => {
    const credentialAdapter = credential.adapterId?.trim() ?? "";
    const targetAdapter = adapterId?.trim() ?? "";
    if (!targetAdapter) {
      return credentialAdapter.length === 0 ? 0 : 1;
    }
    if (credentialAdapter === targetAdapter) {
      return 0;
    }
    return credentialAdapter.length === 0 ? 1 : 2;
  };
  const sorted = [...candidates].sort((a, b) => {
    const aAdapterRank = adapterPreference(a);
    const bAdapterRank = adapterPreference(b);
    if (aAdapterRank !== bAdapterRank) {
      return aAdapterRank - bAdapterRank;
    }
    const aPriority = priority.indexOf(a.status as (typeof priority)[number]);
    const bPriority = priority.indexOf(b.status as (typeof priority)[number]);
    if (aPriority !== bPriority) {
      return (aPriority === -1 ? 99 : aPriority) - (bPriority === -1 ? 99 : bPriority);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return {
    candidates: sorted,
    availableStatuses: Array.from(new Set(candidates.map((credential) => credential.status))),
  };
}

function getCredentialForBroker(
  deviceId: string,
  protocols: string[],
  allowProvidedCredentials?: boolean,
  adapterId?: string,
): { credential?: DeviceCredential; availableStatuses: string[] } {
  const { candidates, availableStatuses } = getCredentialCandidatesForBroker(deviceId, protocols, adapterId);
  return {
    credential: candidates[0]
      ?? (allowProvidedCredentials ? candidates.find((credential) => credential.status === "provided") : undefined),
    availableStatuses,
  };
}

function isSshAuthenticationFailure(result: Pick<BrokerExecutionResult, "summary" | "output">): boolean {
  const text = `${result.summary}\n${result.output}`.toLowerCase();
  return /permission denied/.test(text)
    || /configured password was not accepted/.test(text)
    || /password was not accepted/.test(text)
    || /authentication failed/.test(text)
    || /access denied/.test(text)
    || /too many authentication failures/.test(text);
}

function readTrustedSshHostKeys(device: Device): TrustedSshHostKeyRecord[] {
  const raw = device.metadata.trustedSshHostKeys;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const host = typeof entry.host === "string" ? entry.host.trim().toLowerCase() : "";
    const port = Number(entry.port);
    const keyId = typeof entry.keyId === "string" ? entry.keyId.trim() : "";
    const trustedAt = typeof entry.trustedAt === "string" && entry.trustedAt.trim().length > 0
      ? entry.trustedAt
      : new Date(0).toISOString();
    if (!host || !Number.isInteger(port) || port <= 0 || !keyId) {
      return [];
    }
    return [{ host, port, keyId, trustedAt }];
  });
}

function findTrustedSshHostKey(device: Device, host: string, port: number): string | undefined {
  const hostCandidates = new Set(
    [
      host,
      device.ip,
      device.hostname,
      ...(device.secondaryIps ?? []),
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase()),
  );
  return readTrustedSshHostKeys(device)
    .find((entry) => entry.port === port && hostCandidates.has(entry.host))
    ?.keyId;
}

function parsePlinkUnknownHostKey(output: string): string | undefined {
  if (!/cannot confirm a host key in batch mode/i.test(output)) {
    return undefined;
  }

  const normalized = output.replace(/\r\n/g, "\n");
  const fingerprintMatch = normalized.match(/^\s*(ssh-[^\s]+\s+(?:\d+\s+)?(?:SHA256:[A-Za-z0-9+/=]+|MD5:[0-9a-f:]+))\s*$/im);
  return fingerprintMatch?.[1]?.trim();
}

async function persistTrustedSshHostKey(
  device: Device,
  host: string,
  port: number,
  keyId: string,
  actor: BrokerExecutionContext["actor"],
): Promise<void> {
  const normalizedHost = host.trim().toLowerCase();
  const existing = readTrustedSshHostKeys(device);
  if (existing.some((entry) => entry.host === normalizedHost && entry.port === port && entry.keyId === keyId)) {
    return;
  }

  const trustedAt = new Date().toISOString();
  const updatedDevice: Device = {
    ...device,
    lastChangedAt: trustedAt,
    metadata: {
      ...device.metadata,
      trustedSshHostKeys: [
        ...existing.filter((entry) => !(entry.host === normalizedHost && entry.port === port)),
        {
          host: normalizedHost,
          port,
          keyId,
          trustedAt,
        },
      ],
    },
  };

  await stateStore.upsertDevice(updatedDevice);
  device.metadata = updatedDevice.metadata;
  device.lastChangedAt = trustedAt;
  await stateStore.addAction({
    actor,
    kind: "config",
    message: `Trusted SSH host key for ${device.name}`,
    context: {
      deviceId: device.id,
      host: normalizedHost,
      port,
      keyId,
      trustModel: "first-use",
    },
  });
}

function winrmFailureCacheKey(input: {
  deviceId: string;
  host: string;
  ip: string;
  port: number;
  useSsl: boolean;
  authentication: string;
}): string {
  return [
    input.deviceId,
    input.host.toLowerCase(),
    input.ip,
    String(input.port),
    input.useSsl ? "ssl" : "plain",
    input.authentication.toLowerCase(),
  ].join("|");
}

function getCachedWinrmNegotiationFailure(cacheKey: string): CachedWinrmFailure | null {
  const cached = winrmNegotiationFailureCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > WINRM_NEGOTIATION_FAILURE_TTL_MS) {
    winrmNegotiationFailureCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function uniqStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)).map((value) => value.trim())));
}

function buildWinrmHostCandidates(device: Device, explicitHost?: string): string[] {
  if (explicitHost && explicitHost.trim().length > 0) {
    return uniqStrings([sanitizeWinrmHostCandidate(explicitHost), sanitizeWinrmHostCandidate(device.ip)]);
  }
  return uniqStrings([
    preferredWinrmHost(device),
    sanitizeWinrmHostCandidate(device.hostname),
    sanitizeWinrmHostCandidate(device.name),
    sanitizeWinrmHostCandidate(device.ip),
  ]);
}

function buildWindowsRemoteHostCandidates(device: Device, explicitHost?: string): string[] {
  if (explicitHost && explicitHost.trim().length > 0) {
    return uniqStrings([sanitizeWinrmHostCandidate(explicitHost), sanitizeWinrmHostCandidate(device.ip)]);
  }
  return uniqStrings([
    preferredWinrmHost(device),
    sanitizeWinrmHostCandidate(device.hostname),
    sanitizeWinrmHostCandidate(device.name),
    sanitizeWinrmHostCandidate(device.ip),
  ]);
}

function commandLooksRemoteForWmi(command: string): boolean {
  const normalized = command.toLowerCase();
  if (normalized.includes("$session") || normalized.includes("-cimsession") || normalized.includes("invoke-cimmethod")) {
    return true;
  }
  if (normalized.includes("get-ciminstance") || normalized.includes("get-wmiobject") || normalized.includes("gwmi")) {
    return normalized.includes("-computername") || normalized.includes("-cimsession");
  }
  return false;
}

function commandLooksRemoteForSmb(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.includes("$sharepath")
    || normalized.includes("$shareroot")
    || normalized.includes("join-path $sharepath")
    || normalized.includes("join-path $shareroot");
}

function renderWsmanUrl(host: string, connectionAttempt: { useSsl: boolean; port: number }): string {
  const scheme = connectionAttempt.useSsl ? "https" : "http";
  const hostLiteral = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${hostLiteral}:${connectionAttempt.port}/wsman`;
}

function buildWinrmAuthenticationCandidates(baseAuthentication: WinrmAuthentication, explicitAuthentication?: string, host?: string): WinrmAuthentication[] {
  const normalizedExplicit = explicitAuthentication?.trim().toLowerCase();
  if (normalizedExplicit) {
    return [baseAuthentication];
  }
  const hostLooksLikeName = typeof host === "string" && host.length > 0 && !isWinrmIpLiteral(host);
  return uniqStrings(
    hostLooksLikeName
      ? [baseAuthentication, "kerberos", "negotiate", "default"]
      : [baseAuthentication, "default", "negotiate", "kerberos"],
  ) as WinrmAuthentication[];
}

function buildWinrmConnectionAttempts(args: {
  device: Device;
  broker: NonNullable<OperationSpec["brokerRequest"]> & { protocol: "winrm" };
  targetHost: string;
}): Array<{ port: number; useSsl: boolean; skipCertChecks: boolean; authentication: WinrmAuthentication; hostPlatform: NodeJS.Platform }> {
  const baseResolution = resolveWinrmConnection(args.device, args.broker);
  if (!baseResolution.ok) {
    return [];
  }
  const base = baseResolution.value;
  const observedPorts = Array.from(new Set(
    args.device.services
      .filter((service) => service.transport === "tcp" && (service.port === 5985 || service.port === 5986))
      .map((service) => service.port),
  ));
  const explicitPort = typeof args.broker.port === "number" ? args.broker.port : undefined;
  const explicitUseSsl = typeof args.broker.useSsl === "boolean" ? args.broker.useSsl : undefined;
  const authCandidates = buildWinrmAuthenticationCandidates(base.authentication, args.broker.authentication, args.targetHost);
  const transportCandidates = explicitPort || explicitUseSsl !== undefined
    ? [{ port: base.port, useSsl: base.useSsl }]
    : uniqStrings([
      `${base.port}:${base.useSsl ? "ssl" : "plain"}`,
      ...(observedPorts.includes(5986) ? ["5986:ssl"] : []),
      ...(observedPorts.includes(5985) ? ["5985:plain"] : []),
    ]).map((value) => ({
      port: Number(value.split(":")[0]),
      useSsl: value.endsWith(":ssl"),
    }));

  return transportCandidates.flatMap((transport) => authCandidates.map((authentication) => ({
    port: transport.port,
    useSsl: transport.useSsl,
    skipCertChecks: transport.useSsl ? base.skipCertChecks : false,
    authentication,
    hostPlatform: base.hostPlatform,
  })));
}

function formatWinrmRemediationHints(output: string): string {
  const analysis = analyzeWinrmFailure(output);
  if (analysis.hints.length === 0) {
    return "";
  }
  return ["[remediation]", ...analysis.hints.map((hint) => `- ${hint}`)].join("\n");
}

function appendHostNetworkSummary(output: string, targetIp?: string): string {
  const hostNetwork = getStewardHostNetworkSummary(targetIp);
  return `${output}\n\n[steward-host] ${hostNetwork.summary}`.trim();
}

function analyzeWmiFailure(output: string, targetIp?: string): { summary: string; output: string; category: string } {
  const normalized = output.toLowerCase();
  const withHostSummary = appendHostNetworkSummary(output, targetIp);
  if (normalized.includes("0x800706ba") || normalized.includes("rpc server is unavailable")) {
    return {
      summary: "WMI reached the host but RPC/DCOM session startup failed",
      category: "rpc_unavailable",
      output: `${withHostSummary}\n\n[diagnostic] Steward did not prove a bad credential here. This usually means RPC/DCOM reachability, endpoint mapper, or firewall policy blocked the management session.`.trim(),
    };
  }
  if (normalized.includes("access is denied")) {
    return {
      summary: "WMI transport connected but execution was denied",
      category: "access_denied",
      output: `${withHostSummary}\n\n[diagnostic] The target responded, but WMI authorization failed. Check DCOM/WMI rights for the stored account.`.trim(),
    };
  }
  return {
    summary: "WMI command failed during remote execution",
    category: "generic",
    output: `${withHostSummary}\n\n[diagnostic] Steward could not complete the WMI/DCOM operation. Review the raw broker output before concluding the firewall is the only cause.`.trim(),
  };
}

function analyzeSmbFailure(output: string, targetIp?: string): { summary: string; output: string; category: string } {
  const normalized = output.toLowerCase();
  const withHostSummary = appendHostNetworkSummary(output, targetIp);
  if (normalized.includes("network name is no longer available")) {
    return {
      summary: "SMB reached the host but the session dropped during share setup",
      category: "session_dropped",
      output: `${withHostSummary}\n\n[diagnostic] The SMB path responded and then dropped. This can be caused by server policy, signing requirements, session setup failure, or filtering in the path.`.trim(),
    };
  }
  if (normalized.includes("logon failure") || normalized.includes("access is denied")) {
    return {
      summary: "SMB transport connected but share access was denied",
      category: "access_denied",
      output: `${withHostSummary}\n\n[diagnostic] The host responded, but the SMB session or share authorization was denied for the stored account.`.trim(),
    };
  }
  return {
    summary: "SMB command failed during share access",
    category: "generic",
    output: `${withHostSummary}\n\n[diagnostic] Steward could not complete the SMB share operation. Review the raw broker output before concluding the firewall is the only cause.`.trim(),
  };
}

function looksLikeDomainController(device: Device): boolean {
  const text = [device.name, device.hostname, device.os, device.role]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/(domain controller|active directory|\bpdc\b|\bdc\d+\b)/.test(text)) {
    return true;
  }
  const ports = new Set(device.services.map((service) => Number(service.port)));
  return ports.has(53) && ports.has(88) && ports.has(389);
}

function formatWinrmRemediationHintsForDevice(device: Device, output: string): string {
  const analysis = analyzeWinrmFailure(output);
  const hints = new Set<string>(analysis.hints);
  const hostNetwork = getStewardHostNetworkSummary(device.ip);
  if (analysis.categories.includes("operation_timeout_or_firewall")) {
    hints.add("Verify the WinRM firewall rule is scoped for the Steward host or subnet instead of broadening it blindly.");
  }
  if (hostNetwork.sameSubnet && /same local subnet|local subnet/i.test(output)) {
    hints.add("The WSMan fault text mentions 'same local subnet', but Steward is already on the same subnet. Treat that as generic WinRM guidance, not proof of a subnet mismatch.");
  }
  if (analysis.categories.includes("cannot_use_ip_address")) {
    hints.add("If possible, connect by hostname or FQDN so Kerberos can negotiate cleanly instead of relying on IP-based HTTP WinRM.");
  }
  if (looksLikeDomainController(device)) {
    hints.add("This host looks like a domain controller. Do not force the NIC profile or open WinRM to Any as a first step; verify the interface already shows DomainAuthenticated, confirm DNS/SPN alignment, and keep firewall scope narrow.");
  }
  if (hints.size === 0) {
    return formatWinrmRemediationHints(output);
  }
  return ["[remediation]", ...Array.from(hints).map((hint) => `- ${hint}`)].join("\n");
}

function summarizeWinrmFailureStage(output: string): {
  summaryWhenReachable: string;
  diagnosticWhenReachable: string;
  stage: string;
} {
  const analysis = analyzeWinrmFailure(output);
  if (analysis.stage === "test_wsman") {
    return {
      stage: analysis.stage,
      summaryWhenReachable: "WinRM listener responded but WSMan preflight failed during Steward session negotiation",
      diagnosticWhenReachable: "[diagnostic] WSMan responded on at least one attempted endpoint, but Steward failed during Test-WSMan negotiation before session creation.",
    };
  }
  if (analysis.stage === "session_create") {
    return {
      stage: analysis.stage,
      summaryWhenReachable: "WinRM listener responded but Steward could not create a remote PowerShell session",
      diagnosticWhenReachable: "[diagnostic] WSMan responded and preflight completed, but New-PSSession failed. This points to WinRM authorization, remoting configuration, or target shell startup rather than basic host reachability.",
    };
  }
  if (analysis.stage === "invoke_command") {
    return {
      stage: analysis.stage,
      summaryWhenReachable: "WinRM session opened but command execution failed inside the remote session",
      diagnosticWhenReachable: "[diagnostic] Steward created a remote PowerShell session, but the remote command failed after session establishment.",
    };
  }
  return {
    stage: analysis.stage ?? "unknown",
    summaryWhenReachable: "WinRM listener responded but Steward could not start a remote PowerShell session",
    diagnosticWhenReachable: "[diagnostic] WSMan responded on at least one attempted WinRM endpoint, but Steward could not establish a remote PowerShell session. This points to session negotiation, authentication mode, authorization, or remote shell startup failure rather than proving the server is unreachable.",
  };
}

interface CachedWinrmFailure {
  output: string;
  details: Record<string, unknown>;
  summary: string;
  cachedAt: number;
}

const WINRM_NEGOTIATION_FAILURE_TTL_MS = 20_000;
const winrmNegotiationFailureCache = new Map<string, CachedWinrmFailure>();

function logCredentialAccess(
  context: BrokerExecutionContext,
  operation: OperationSpec,
  device: Device,
  protocol: string,
  result: "granted" | "missing_secret" | "no_stored_credential" | "credential_unusable",
  details: Record<string, unknown>,
  credentialId?: string,
): void {
  stateStore.logCredentialAccess({
    credentialId,
    deviceId: device.id,
    protocol,
    playbookRunId: context.playbookRunId,
    operationId: operation.id,
    adapterId: operation.adapterId,
    actor: context.actor,
    purpose: operation.kind,
    result,
    details,
  });
}

function encodePowerShellScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function deviceHasObservedSsh(device: Device): boolean {
  return device.protocols.includes("ssh")
    || device.services.some((service) =>
      service.transport === "tcp"
      && (service.port === 22 || service.port === 2222 || /ssh/i.test(service.name)),
    );
}

function preferredSshPort(device: Device): number | undefined {
  const preferredPorts = [22, 2222, 2200];
  const candidates = device.services
    .filter((service) =>
      service.transport === "tcp"
      && (preferredPorts.includes(service.port) || /ssh/i.test(service.name)),
    )
    .sort((a, b) => {
      const aRank = preferredPorts.indexOf(a.port);
      const bRank = preferredPorts.indexOf(b.port);
      if (aRank !== bRank) {
        return (aRank === -1 ? 999 : aRank) - (bRank === -1 ? 999 : bRank);
      }
      return a.port - b.port;
    });
  return candidates[0]?.port;
}

function buildWindowsPowerShellSshArgv(command: string): string[] {
  return [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodePowerShellScript(command),
  ];
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

async function executePowerShellRuntimeScript(script: string, timeoutMs: number): Promise<{
  ok: boolean;
  output: string;
  details: Record<string, unknown>;
  executable?: string;
}> {
  const runtime = await resolvePowerShellRuntime();
  if (!runtime.available || !runtime.executable) {
    return {
      ok: false,
      output: powerShellInstallHint(process.platform),
      details: {
        hostPlatform: process.platform,
        triedExecutables: runtime.tried,
        runtimeError: runtime.error ?? null,
      },
    };
  }
  const attempt = await runCommand(
    runtime.executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(script)],
    timeoutMs,
  );
  return {
    ok: attempt.ok,
    output: normalizeWinrmOutput(`${attempt.stdout}${attempt.stderr ? `\n[stderr] ${attempt.stderr}` : ""}`).trim(),
    executable: runtime.executable,
    details: {
      executable: runtime.executable,
      powerShellVersion: runtime.version ?? null,
      exitCode: attempt.code,
    },
  };
}

function applyExpectationToOutput(input: {
  protocol: string;
  output: string;
  expectRegex?: string;
  details: Record<string, unknown>;
}): BrokerExecutionResult {
  if (input.expectRegex && !new RegExp(input.expectRegex, "i").test(input.output)) {
    return brokerResult({
      status: "failed",
      phase: "verified",
      proof: "process",
      summary: `${protocolDisplayLabel(input.protocol)} command completed but did not match expectation`,
      output: `${input.output}\n[expectation failed] ${input.expectRegex}`.trim(),
      details: {
        ...input.details,
        matchedExpectation: false,
        expectRegex: input.expectRegex,
      },
    });
  }
  return brokerResult({
    status: "succeeded",
    phase: input.expectRegex ? "verified" : "executed",
    proof: input.expectRegex ? "expectation" : "process",
    summary: `${protocolDisplayLabel(input.protocol)} command completed successfully`,
    output: input.output,
    details: {
      ...input.details,
      matchedExpectation: Boolean(input.expectRegex),
    },
  });
}

function shouldUseWindowsSshFallback(device: Device): boolean {
  return process.platform === "darwin" && deviceHasObservedSsh(device);
}

function selectCredentialForWindowsSshFallback(
  deviceId: string,
  allowProvidedCredentials: boolean | undefined,
): {
  credential?: DeviceCredential;
  availableStatuses: string[];
  sourceProtocol?: "ssh" | "winrm";
} {
  const sshSelection = getCredentialForBroker(deviceId, ["ssh"], allowProvidedCredentials, "ssh");
  if (sshSelection.credential) {
    return {
      credential: sshSelection.credential,
      availableStatuses: sshSelection.availableStatuses,
      sourceProtocol: "ssh",
    };
  }

  const winrmSelection = getCredentialForBroker(deviceId, ["winrm"], allowProvidedCredentials, "winrm");
  if (winrmSelection.credential) {
    return {
      credential: winrmSelection.credential,
      availableStatuses: [
        ...sshSelection.availableStatuses,
        ...winrmSelection.availableStatuses,
      ],
      sourceProtocol: "winrm",
    };
  }

  return {
    availableStatuses: [
      ...sshSelection.availableStatuses,
      ...winrmSelection.availableStatuses,
    ],
  };
}

async function runSshCommandWithCredential(input: {
  operation: OperationSpec;
  device: Device;
  context: BrokerExecutionContext;
  credential: DeviceCredential;
  accountLabel: string;
  secret: string;
  host: string;
  argv: string[];
  remoteCommand?: string;
  port?: number;
  validationMethod: string;
  validationDetails: Record<string, unknown>;
}): Promise<BrokerExecutionResult> {
  const remoteArgs = typeof input.remoteCommand === "string" && input.remoteCommand.trim().length > 0
    ? [input.remoteCommand]
    : input.argv;
  const port = input.port ?? 22;
  const executeSsh = (trustedHostKey?: string) => (
    process.platform === "win32"
      ? runCommand(
        "plink",
        [
          "-batch",
          "-ssh",
          ...(trustedHostKey ? ["-hostkey", trustedHostKey] : []),
          "-l",
          input.accountLabel,
          ...(port !== 22 ? ["-P", String(port)] : []),
          input.host,
          "-pw",
          input.secret,
          ...remoteArgs,
        ],
        input.operation.timeoutMs,
      )
      : runCommand(
        "sshpass",
        [
          "-p",
          input.secret,
          "ssh",
          "-l",
          input.accountLabel,
          ...(port !== 22 ? ["-p", String(port)] : []),
          "-o",
          "StrictHostKeyChecking=no",
          input.host,
          ...remoteArgs,
        ],
        input.operation.timeoutMs,
      )
  );

  let trustedHostKey = findTrustedSshHostKey(input.device, input.host, port);
  let trustedHostKeySource: "stored" | "observed" | undefined = trustedHostKey ? "stored" : undefined;
  let rawResult = await executeSsh(trustedHostKey);

  if (process.platform === "win32" && !trustedHostKey) {
    const discoveredHostKey = parsePlinkUnknownHostKey(`${rawResult.stdout}\n${rawResult.stderr}`.trim());
    if (discoveredHostKey) {
      await persistTrustedSshHostKey(input.device, input.host, port, discoveredHostKey, input.context.actor);
      trustedHostKey = discoveredHostKey;
      trustedHostKeySource = "observed";
      rawResult = await executeSsh(discoveredHostKey);
    }
  }

  const result = formatCommandOutput(rawResult);

  if (result.ok) {
    await markCredentialValidatedFromUse({
      deviceId: input.device.id,
      credentialId: input.credential.id,
      actor: input.context.actor,
      method: input.validationMethod,
      details: {
        ...input.validationDetails,
        host: input.host,
        port,
        ...(trustedHostKey
          ? {
            sshHostKey: trustedHostKey,
            sshHostKeySource: trustedHostKeySource,
          }
          : {}),
      },
    });
  }

  return {
    ...result,
    details: {
      ...result.details,
      host: input.host,
      port,
      ...(trustedHostKey
        ? {
          sshHostKey: trustedHostKey,
          sshHostKeySource: trustedHostKeySource,
        }
        : {}),
    },
  };
}

function parseTelnetChunk(input: Buffer): { text: string; responses: Buffer[]; remainder: Buffer } {
  const textBytes: number[] = [];
  const responses: Buffer[] = [];
  let index = 0;

  while (index < input.length) {
    const byte = input[index];
    if (byte !== TELNET_IAC) {
      textBytes.push(byte);
      index += 1;
      continue;
    }

    if (index + 1 >= input.length) {
      return {
        text: Buffer.from(textBytes).toString("utf-8"),
        responses,
        remainder: input.subarray(index),
      };
    }

    const command = input[index + 1];
    if (command === TELNET_IAC) {
      textBytes.push(TELNET_IAC);
      index += 2;
      continue;
    }

    if (command === TELNET_SB) {
      let cursor = index + 2;
      let foundEnd = false;
      while (cursor + 1 < input.length) {
        if (input[cursor] === TELNET_IAC && input[cursor + 1] === TELNET_SE) {
          cursor += 2;
          foundEnd = true;
          break;
        }
        cursor += 1;
      }
      if (!foundEnd) {
        return {
          text: Buffer.from(textBytes).toString("utf-8"),
          responses,
          remainder: input.subarray(index),
        };
      }
      index = cursor;
      continue;
    }

    if ([TELNET_DO, TELNET_DONT, TELNET_WILL, TELNET_WONT].includes(command)) {
      if (index + 2 >= input.length) {
        return {
          text: Buffer.from(textBytes).toString("utf-8"),
          responses,
          remainder: input.subarray(index),
        };
      }
      const option = input[index + 2];
      if (command === TELNET_DO) {
        responses.push(Buffer.from([TELNET_IAC, TELNET_WONT, option]));
      } else if (command === TELNET_WILL) {
        responses.push(Buffer.from([TELNET_IAC, TELNET_DONT, option]));
      }
      index += 3;
      continue;
    }

    index += 2;
  }

  return {
    text: Buffer.from(textBytes).toString("utf-8"),
    responses,
    remainder: Buffer.alloc(0),
  };
}

function telnetLooksLikePrompt(output: string): boolean {
  const tail = output.replace(/\r/g, "").split("\n").slice(-1)[0]?.trim() ?? "";
  if (tail.length === 0 || tail.length > 64) {
    return false;
  }
  return /(?:[$#>%])\s*$/.test(tail);
}

function stripTelnetPrompt(output: string): string {
  const normalized = output.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  const tail = lines[lines.length - 1]?.trim() ?? "";
  if (tail.length > 0 && tail.length <= 64 && /(?:[$#>%])\s*$/.test(tail)) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

async function runTelnetCommandWithCredential(input: {
  operation: OperationSpec;
  device: Device;
  context: BrokerExecutionContext;
  credential: DeviceCredential;
  accountLabel?: string;
  secret: string;
  host: string;
  command: string;
  port?: number;
  validationMethod: string;
  validationDetails: Record<string, unknown>;
}): Promise<BrokerExecutionResult> {
  const port = input.port ?? 23;
  const targetHost = input.host;
  const command = input.command.trim();
  const username = input.accountLabel?.trim() ?? "";

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let rawOutput = "";
    let negotiationRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let usernameSent = false;
    let passwordSent = false;
    let commandSent = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const finish = async (result: BrokerExecutionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      socket.destroy();
      if (result.ok) {
        await markCredentialValidatedFromUse({
          deviceId: input.device.id,
          credentialId: input.credential.id,
          actor: input.context.actor,
          method: input.validationMethod,
          details: input.validationDetails,
        });
      }
      resolve(result);
    };

    const fail = (summary: string, output: string, details?: Record<string, unknown>) => {
      void finish(
        brokerResult({
          status: "failed",
          phase: commandSent ? "executed" : "not-started",
          proof: commandSent ? "process" : "none",
          summary,
          output: output.trim(),
          details,
        }),
      );
    };

    const scheduleIdleCompletion = () => {
      if (!commandSent) {
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        void finish(
          brokerResult({
            status: "succeeded",
            phase: "executed",
            proof: "process",
            summary: "Telnet command completed successfully",
            output: stripTelnetPrompt(rawOutput),
            details: {
              host: targetHost,
              port,
              credentialId: input.credential.id,
            },
          }),
        );
      }, Math.min(TELNET_IDLE_SETTLE_MS, Math.max(350, Math.floor(input.operation.timeoutMs / 8))));
    };

    const sendLine = (value: string) => {
      socket.write(`${value}\r\n`);
    };

    socket.setTimeout(input.operation.timeoutMs, () => {
      fail(
        commandSent ? "Telnet command timed out" : "Telnet session timed out",
        stripTelnetPrompt(rawOutput) || "Timed out while waiting for the Telnet session to complete.",
        { host: targetHost, port, credentialId: input.credential.id },
      );
    });

    socket.on("error", (error) => {
      fail(
        "Telnet connection failed",
        `${stripTelnetPrompt(rawOutput)}\n${error.message}`.trim(),
        { host: targetHost, port, credentialId: input.credential.id },
      );
    });

    socket.on("data", (chunk) => {
      const combined = negotiationRemainder.length > 0 ? Buffer.concat([negotiationRemainder, chunk]) : chunk;
      const parsed = parseTelnetChunk(combined);
      negotiationRemainder = parsed.remainder;
      for (const response of parsed.responses) {
        socket.write(response);
      }
      if (parsed.text.length > 0) {
        rawOutput += parsed.text;
      }

      const normalizedTail = rawOutput.replace(/\r/g, "").slice(-400).toLowerCase();
      if (/login incorrect|authentication failed|access denied|incorrect password/.test(normalizedTail)) {
        fail(
          "Telnet authentication failed",
          stripTelnetPrompt(rawOutput),
          { host: targetHost, port, credentialId: input.credential.id },
        );
        return;
      }

      if (!usernameSent && /(login(?: as)?|username)\s*[:>]?\s*$/i.test(normalizedTail)) {
        if (username.length === 0) {
          fail(
            "Telnet username is required",
            stripTelnetPrompt(rawOutput) || "The Telnet service requested a username, but the stored Telnet credential has no accountLabel.",
            { credentialId: input.credential.id },
          );
          return;
        }
        sendLine(username);
        usernameSent = true;
        return;
      }

      if (!passwordSent && /password\s*[:>]?\s*$/i.test(normalizedTail)) {
        sendLine(input.secret);
        passwordSent = true;
        return;
      }

      if (!commandSent && telnetLooksLikePrompt(rawOutput)) {
        sendLine(command);
        commandSent = true;
        scheduleIdleCompletion();
        return;
      }

      scheduleIdleCompletion();
    });

    socket.connect(port, targetHost);
  });
}

function shellEscapeSingleQuoted(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

function buildSshRemoteCommand(command: string): string {
  return `sh -lc '${shellEscapeSingleQuoted(command)}'`;
}

function redactSensitiveHttpValue(value: string, secret?: string): string {
  if (!secret || !value) {
    return value;
  }

  let redacted = value.replaceAll(secret, "[redacted]");
  const encodedSecret = encodeURIComponent(secret);
  if (encodedSecret !== secret) {
    redacted = redacted.replaceAll(encodedSecret, "[redacted]");
  }
  return redacted;
}

function parseHttpResponseJson(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

async function executeSshBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "ssh") {
    return brokerResult({
      handled: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "SSH broker not applicable",
      output: "",
    });
  }

  const { candidates, availableStatuses } = getCredentialCandidatesForBroker(
    device.id,
    ["ssh"],
    operation.adapterId,
  );
  if (candidates.length === 0) {
    logCredentialAccess(
      context,
      operation,
      device,
      "ssh",
      availableStatuses.length > 0 ? "credential_unusable" : "no_stored_credential",
      {
        allowedStatuses: ["pending", "provided", "validated", "invalid"],
        availableStatuses,
      },
    );
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: context.allowUnauthenticated ? "SSH credential not available" : "SSH credential required",
      output: context.allowUnauthenticated
        ? "No stored SSH credential is available. Steward will not use ambient SSH usernames, keys, or agent state from the host machine."
        : "SSH broker requires a stored SSH credential",
      details: { availableStatuses, usedAmbientSsh: false },
    });
  }

  const remoteCommand = typeof broker.command === "string" && broker.command.trim().length > 0
    ? buildSshRemoteCommand(interpolateOperationValue(broker.command.trim(), device.ip, params))
    : undefined;
  const remoteArgv = remoteCommand
    ? []
    : (broker.argv ?? []).map((arg) => interpolateOperationValue(arg, device.ip, params));
  let lastFailure: BrokerExecutionResult | null = null;
  const attemptedCredentials: string[] = [];

  for (const credential of candidates) {
    attemptedCredentials.push(credential.id);

    const secret = await vault.getSecret(credential.vaultSecretRef);
    if (secretIsMissing(secret)) {
      logCredentialAccess(context, operation, device, "ssh", "missing_secret", {
        accountLabel: credential.accountLabel ?? null,
        credentialStatus: credential.status,
      }, credential.id);
      lastFailure = brokerResult({
        status: "failed",
        phase: "not-started",
        proof: "none",
        summary: "SSH secret missing",
        output: context.allowProvidedCredentials
          ? "Stored SSH credential is missing a usable secret"
          : "Validated SSH credential is missing a usable secret",
        details: { credentialId: credential.id, attemptedCredentials },
      });
      continue;
    }

    const accountLabel = credential.accountLabel?.trim() ?? "";
    if (accountLabel.length === 0) {
      logCredentialAccess(context, operation, device, "ssh", "credential_unusable", {
        credentialStatus: credential.status,
        reason: "missing_account_label",
      }, credential.id);
      lastFailure = brokerResult({
        status: "failed",
        phase: "not-started",
        proof: "none",
        summary: "SSH username is required",
        output: "SSH broker requires a credential with an accountLabel username.",
        details: { credentialId: credential.id, attemptedCredentials },
      });
      continue;
    }

    logCredentialAccess(context, operation, device, "ssh", "granted", {
      accountLabel,
      argv: remoteArgv,
      remoteCommand,
      credentialStatus: credential.status,
    }, credential.id);

    const result = await runSshCommandWithCredential({
      operation,
      device,
      context,
      credential,
      accountLabel,
      secret,
      host: device.ip,
      argv: remoteArgv,
      remoteCommand,
      port: broker.port,
      validationMethod: "ssh.command",
      validationDetails: { adapterId: operation.adapterId, operationId: operation.id },
    });
    if (result.ok) {
      return result;
    }

    lastFailure = {
      ...result,
      details: {
        ...result.details,
        attemptedCredentials,
      },
    };
    if (!isSshAuthenticationFailure(result)) {
      return lastFailure;
    }
  }

  return lastFailure ?? brokerResult({
    status: "failed",
    phase: "not-started",
    proof: "none",
    summary: "SSH credential required",
    output: "SSH broker requires a stored SSH credential",
    details: { availableStatuses, attemptedCredentials },
  });
}

async function executeTelnetBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "telnet") {
    return brokerResult({
      handled: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "Telnet broker not applicable",
      output: "",
    });
  }

  const { credential, availableStatuses } = getCredentialForBroker(
    device.id,
    ["telnet"],
    context.allowProvidedCredentials,
    operation.adapterId,
  );
  if (!credential) {
    logCredentialAccess(
      context,
      operation,
      device,
      "telnet",
      availableStatuses.length > 0 ? "credential_unusable" : "no_stored_credential",
      {
        allowedStatuses: ["pending", "provided", "validated", "invalid"],
        availableStatuses,
      },
    );
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "Telnet credential required",
      output: "Telnet broker requires a stored Telnet credential.",
      details: { availableStatuses },
    });
  }

  const secret = await vault.getSecret(credential.vaultSecretRef);
  if (secretIsMissing(secret)) {
    logCredentialAccess(context, operation, device, "telnet", "missing_secret", {
      accountLabel: credential.accountLabel ?? null,
      credentialStatus: credential.status,
    }, credential.id);
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "Telnet secret missing",
      output: "Stored Telnet credential is missing a usable secret.",
      details: { credentialId: credential.id },
    });
  }

  const targetHost = typeof broker.host === "string" && broker.host.trim().length > 0
    ? broker.host.trim()
    : device.ip;
  const command = interpolateOperationValue(broker.command, targetHost, params);

  logCredentialAccess(context, operation, device, "telnet", "granted", {
    accountLabel: credential.accountLabel ?? null,
    credentialStatus: credential.status,
    host: targetHost,
    port: broker.port ?? 23,
  }, credential.id);

  const telnetResult = await runTelnetCommandWithCredential({
    operation,
    device,
    context,
    credential,
    accountLabel: credential.accountLabel,
    secret,
    host: targetHost,
    command,
    port: broker.port,
    validationMethod: "telnet.command",
    validationDetails: {
      adapterId: operation.adapterId,
      operationId: operation.id,
      host: targetHost,
      port: broker.port ?? 23,
    },
  });
  if (!telnetResult.ok) {
    return {
      ...telnetResult,
      summary: "Telnet command failed",
    };
  }
  return applyExpectationToOutput({
    protocol: "telnet",
    output: telnetResult.output,
    expectRegex: broker.expectRegex,
    details: telnetResult.details,
  });
}

async function executeWinrmBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "winrm") {
    return brokerResult({
      handled: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WinRM broker not applicable",
      output: "",
    });
  }

  if (shouldUseWindowsSshFallback(device)) {
    const sshPort = preferredSshPort(device);
    const { credential, availableStatuses, sourceProtocol } = selectCredentialForWindowsSshFallback(
      device.id,
      context.allowProvidedCredentials,
    );

    if (!credential || !sourceProtocol) {
      logCredentialAccess(
        context,
        operation,
        device,
        "ssh",
        availableStatuses.length > 0 ? "credential_unusable" : "no_stored_credential",
        {
          allowedStatuses: ["pending", "provided", "validated", "invalid"],
          availableStatuses,
          fallbackFromProtocol: "winrm",
        },
      );
      return brokerResult({
        status: "failed",
        phase: "not-started",
        proof: "none",
        summary: "Windows remoting over SSH requires stored credentials",
        output: "This macOS Steward host prefers PowerShell over SSH for Windows targets that expose SSH. Store an SSH credential, or reuse the same username/password via the existing Windows credential.",
        details: {
          fallbackFromProtocol: "winrm",
          availableStatuses,
        },
      });
    }

    const secret = await vault.getSecret(credential.vaultSecretRef);
    if (secretIsMissing(secret)) {
      logCredentialAccess(context, operation, device, "ssh", "missing_secret", {
        accountLabel: credential.accountLabel ?? null,
        credentialStatus: credential.status,
        sourceCredentialProtocol: sourceProtocol,
        fallbackFromProtocol: "winrm",
      }, credential.id);
      return brokerResult({
        status: "failed",
        phase: "not-started",
        proof: "none",
        summary: "SSH fallback secret missing",
        output: `Stored ${sourceProtocol.toUpperCase()} credential is missing a usable secret for SSH transport.`,
        details: {
          credentialId: credential.id,
          sourceCredentialProtocol: sourceProtocol,
        },
      });
    }

    const accountLabel = credential.accountLabel?.trim() ?? "";
    if (accountLabel.length === 0) {
      logCredentialAccess(context, operation, device, "ssh", "credential_unusable", {
        credentialStatus: credential.status,
        sourceCredentialProtocol: sourceProtocol,
        reason: "missing_account_label",
        fallbackFromProtocol: "winrm",
      }, credential.id);
      return brokerResult({
        status: "failed",
        phase: "not-started",
        proof: "none",
        summary: "SSH fallback username is required",
        output: `Stored ${sourceProtocol.toUpperCase()} credential is missing an accountLabel username required for SSH transport.`,
        details: {
          credentialId: credential.id,
          sourceCredentialProtocol: sourceProtocol,
        },
      });
    }

    const targetHost = typeof broker.host === "string" && broker.host.trim().length > 0
      ? broker.host.trim()
      : device.ip;
    const remoteArgv = buildWindowsPowerShellSshArgv(interpolateOperationValue(broker.command, targetHost, params));

    logCredentialAccess(context, operation, device, "ssh", "granted", {
      accountLabel,
      argv: remoteArgv.slice(0, 5),
      credentialStatus: credential.status,
      sourceCredentialProtocol: sourceProtocol,
      fallbackFromProtocol: "winrm",
      host: targetHost,
      port: sshPort ?? 22,
    }, credential.id);

    const sshResult = await runSshCommandWithCredential({
      operation,
      device,
      context,
      credential,
      accountLabel,
      secret,
      host: targetHost,
      argv: remoteArgv,
      port: sshPort,
      validationMethod: sourceProtocol === "ssh" ? "ssh.command" : "ssh.command.via_winrm_credential",
      validationDetails: {
        adapterId: operation.adapterId,
        operationId: operation.id,
        sourceCredentialProtocol: sourceProtocol,
        fallbackFromProtocol: "winrm",
        host: targetHost,
        port: sshPort ?? 22,
      },
    });

    return {
      ...sshResult,
      summary: sshResult.ok
        ? "Windows PowerShell command completed successfully over SSH"
        : "Windows PowerShell command over SSH failed",
      details: {
        ...sshResult.details,
        fallbackFromProtocol: "winrm",
        sourceCredentialProtocol: sourceProtocol,
        sshPort: sshPort ?? 22,
      },
    };
  }

  const { credential, availableStatuses } = getCredentialForBroker(
    device.id,
    ["winrm"],
    context.allowProvidedCredentials,
    operation.adapterId,
  );
  if (!credential) {
    if (context.allowUnauthenticated) {
      return brokerResult({
        handled: true,
        status: "failed",
        phase: "not-started",
        proof: "none",
        summary: "WinRM credential not available",
        output: "",
      });
    }
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WinRM credential required",
      output: "WinRM broker requires a stored WinRM credential",
      details: { availableStatuses },
    });
  }

  const secret = await vault.getSecret(credential.vaultSecretRef);
  if (secretIsMissing(secret)) {
    logCredentialAccess(context, operation, device, "winrm", "missing_secret", {
      accountLabel: credential.accountLabel ?? null,
      credentialStatus: credential.status,
    }, credential.id);
    if (context.allowUnauthenticated) {
      return brokerResult({
        handled: true,
        status: "failed",
        phase: "not-started",
        proof: "none",
        summary: "WinRM secret missing",
        output: "",
      });
    }
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WinRM secret missing",
      output: context.allowProvidedCredentials
        ? "Stored WinRM credential is missing a usable secret"
        : "Validated WinRM credential is missing a usable secret",
      details: { credentialId: credential.id },
    });
  }

  const accountLabel = credential.accountLabel?.trim() ?? "";
  if (accountLabel.length === 0) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WinRM username is required",
      output: "WinRM broker requires a credential with an accountLabel username.",
      details: { credentialId: credential.id },
    });
  }

  const brokerHost = typeof broker.host === "string" && broker.host.trim().length > 0
    ? broker.host.trim()
    : undefined;
  const targetHost = brokerHost ?? preferredWinrmHost(device);
  const targetHostIsIp = isWinrmIpLiteral(targetHost);
  const connection = resolveWinrmConnection(device, broker);
  if (!connection.ok) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WinRM request is incompatible with this Steward host",
      output: connection.error,
      details: connection.details,
    });
  }

  const runtime = await resolvePowerShellRuntime();
  if (!runtime.available || !runtime.executable) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "PowerShell runtime not available for WinRM",
      output: powerShellInstallHint(process.platform),
      details: {
        hostPlatform: process.platform,
        triedExecutables: runtime.tried,
        runtimeError: runtime.error ?? null,
      },
    });
  }

  const hostCandidates = buildWinrmHostCandidates(device, brokerHost);
  if (hostCandidates.length === 0) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WinRM target host is invalid",
      output: "Steward could not derive a valid hostname or IP for WinRM. Discovery likely stored a friendly label instead of a routable host identifier.",
      details: {
        deviceName: device.name,
        deviceHostname: device.hostname ?? null,
        deviceIp: device.ip,
        explicitHost: brokerHost ?? null,
      },
    });
  }
  const connectionAttempts = buildWinrmConnectionAttempts({
    device,
    broker: broker as typeof broker & { protocol: "winrm" },
    targetHost,
  });
  if (connectionAttempts.length === 0) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WinRM request is incompatible with this Steward host",
      output: "Steward could not derive any usable WinRM host/auth/transport attempts for this request.",
      details: {
        targetHost,
        requestedAuthentication: broker.authentication ?? null,
        requestedPort: broker.port ?? null,
        requestedUseSsl: broker.useSsl ?? null,
      },
    });
  }
  const failureCacheKey = winrmFailureCacheKey({
    deviceId: device.id,
    host: `${targetHost}|${hostCandidates.join(",")}`,
    ip: device.ip,
    port: connection.value.port,
    useSsl: connection.value.useSsl,
    authentication: connectionAttempts.map((attempt) => `${attempt.authentication}:${attempt.port}:${attempt.useSsl ? "ssl" : "plain"}`).join(","),
  });
  const cachedNegotiationFailure = getCachedWinrmNegotiationFailure(failureCacheKey);
  if (cachedNegotiationFailure) {
    return brokerResult({
      status: "failed",
      phase: "executed",
      proof: "process",
      summary: `${cachedNegotiationFailure.summary} (cached)`,
      output: cachedNegotiationFailure.output,
      details: {
        ...cachedNegotiationFailure.details,
        cached: true,
      },
    });
  }

  logCredentialAccess(context, operation, device, "winrm", "granted", {
    accountLabel,
    host: hostCandidates[0],
    credentialStatus: credential.status,
    attempts: connectionAttempts.map((attempt) => ({
      port: attempt.port,
      useSsl: attempt.useSsl,
      authentication: attempt.authentication,
    })),
  }, credential.id);

  const executableUsed = runtime.executable;
  const failures: Array<{
    host: string;
    output: string;
    code: number;
    port: number;
    useSsl: boolean;
    authentication: WinrmAuthentication;
    wsmanStatusCode: number;
    wsmanOk: boolean;
    wsmanError: string | null;
    wsmanUrl: string;
  }> = [];
  let successfulHost: string | null = null;
  let successfulConnection = connection.value;
  let output = "";

  outer:
  for (const connectionAttempt of connectionAttempts) {
    const hostCandidateScores = await Promise.all(hostCandidates.map(async (hostCandidate) => {
      const wsmanUrl = renderWsmanUrl(hostCandidate, connectionAttempt);
      const probe = await requestText(new URL(wsmanUrl), {
        method: "GET",
        timeoutMs: 2_000,
        insecureSkipVerify: connectionAttempt.skipCertChecks,
      });
      const reachable = probe.statusCode === 405 || probe.statusCode === 401 || probe.ok;
      return { host: hostCandidate, reachable, probe, wsmanUrl };
    }));
    const orderedHostCandidates = hostCandidateScores
      .sort((a, b) => Number(b.reachable) - Number(a.reachable))
      .map((candidate) => candidate.host);

    for (const hostCandidate of orderedHostCandidates) {
      const command = interpolateOperationValue(broker.command, hostCandidate, params);
      const script = buildWinrmPowerShellScript({
        host: hostCandidate,
        username: accountLabel,
        password: secret,
        command,
        connection: connectionAttempt,
      });

      const attempt = await runCommand(
        executableUsed,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(script)],
        operation.timeoutMs,
      );
      output = normalizeWinrmOutput(`${attempt.stdout}${attempt.stderr ? `\n[stderr] ${attempt.stderr}` : ""}`).trim();
      if (attempt.ok) {
        successfulHost = hostCandidate;
        successfulConnection = connectionAttempt;
        break outer;
      }
      const matchingProbeEntry = hostCandidateScores.find((candidate) => candidate.host === hostCandidate);
      const matchingProbe = matchingProbeEntry?.probe;
      failures.push({
        host: hostCandidate,
        output,
        code: attempt.code,
        port: connectionAttempt.port,
        useSsl: connectionAttempt.useSsl,
        authentication: connectionAttempt.authentication,
        wsmanStatusCode: matchingProbe?.statusCode ?? 0,
        wsmanOk: matchingProbe?.ok ?? false,
        wsmanError: matchingProbe?.error ?? null,
        wsmanUrl: matchingProbeEntry?.wsmanUrl ?? renderWsmanUrl(hostCandidate, connectionAttempt),
      });
    }
  }

  if (!successfulHost) {
    const stageSummary = summarizeWinrmFailureStage(failures.map((failure) => failure.output).join("\n\n"));
    const failureOutput = failures.map((failure) => [
      `host=${failure.host} port=${failure.port} ssl=${failure.useSsl ? "true" : "false"} auth=${failure.authentication}`,
      failure.output,
      `[wsman url] ${failure.wsmanUrl}`,
      `[wsman probe] ${failure.wsmanError ?? `HTTP ${failure.wsmanStatusCode}`}`,
      `[exit code: ${failure.code}]`,
    ].join("\n")).join("\n\n");
    const anyListenerReachable = failures.some((failure) => failure.wsmanStatusCode === 405 || failure.wsmanStatusCode === 401 || failure.wsmanOk);
    const hostNetwork = getStewardHostNetworkSummary(device.ip);
    const diagnostic = anyListenerReachable
      ? stageSummary.diagnosticWhenReachable
      : `[diagnostic] Steward could not prove a reachable WSMan endpoint on the attempted WinRM combinations.`;
    const remediation = formatWinrmRemediationHintsForDevice(device, failureOutput);
    const summary = anyListenerReachable
      ? `${stageSummary.summaryWhenReachable} via ${executableUsed}`
      : `WinRM transport connection failed across attempted host/auth combinations via ${executableUsed}`;
    const details = {
      executable: executableUsed,
      powerShellVersion: runtime.version ?? null,
      host: hostCandidates[0],
      attemptedHosts: hostCandidates,
      attemptedConnections: connectionAttempts,
      matchedExpectation: false,
      targetHost,
      targetHostIsIp,
      failureStage: stageSummary.stage,
      hostNetwork,
    };
    const fullOutput = `${failureOutput}\n\n${diagnostic}\n\n[steward-host] ${hostNetwork.summary}${remediation ? `\n\n${remediation}` : ""}`.trim();
    if (anyListenerReachable) {
      winrmNegotiationFailureCache.set(failureCacheKey, {
        summary,
        output: fullOutput,
        details,
        cachedAt: Date.now(),
      });
    }
    return brokerResult({
      status: "failed",
      phase: "executed",
      proof: "process",
      summary,
      output: fullOutput,
      details,
    });
  }

  winrmNegotiationFailureCache.delete(failureCacheKey);

  if (broker.expectRegex) {
    const matched = new RegExp(broker.expectRegex, "i").test(output);
    if (!matched) {
      return brokerResult({
        status: "failed",
        phase: "verified",
        proof: "process",
        summary: "WinRM command completed but did not match expectation",
        output: `${output}\n[expectation failed] ${broker.expectRegex}`.trim(),
        details: {
          executable: executableUsed,
          powerShellVersion: runtime.version ?? null,
          host: successfulHost,
          port: successfulConnection.port,
          useSsl: successfulConnection.useSsl,
          skipCertChecks: successfulConnection.skipCertChecks,
          authentication: successfulConnection.authentication,
          matchedExpectation: false,
          expectRegex: broker.expectRegex,
        },
      });
    }
  }

  const winrmResult = brokerResult({
    status: "succeeded",
    phase: broker.expectRegex ? "verified" : "executed",
    proof: broker.expectRegex ? "expectation" : "process",
    summary: "WinRM command completed successfully",
    output,
    details: {
      executable: executableUsed,
      powerShellVersion: runtime.version ?? null,
      host: successfulHost,
      attemptedHosts: hostCandidates,
      attemptedConnections: connectionAttempts,
      port: successfulConnection.port,
      useSsl: successfulConnection.useSsl,
      skipCertChecks: successfulConnection.skipCertChecks,
      authentication: successfulConnection.authentication,
      matchedExpectation: Boolean(broker.expectRegex),
    },
  });
  await markCredentialValidatedFromUse({
    deviceId: device.id,
    credentialId: credential.id,
    actor: context.actor,
    method: "winrm.command",
      details: {
        adapterId: operation.adapterId,
        operationId: operation.id,
        host: successfulHost,
        port: successfulConnection.port,
        useSsl: successfulConnection.useSsl,
      },
  });
  return winrmResult;
}

async function executePowerShellSshBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "powershell-ssh") {
    return brokerResult({
      handled: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "PowerShell over SSH broker not applicable",
      output: "",
    });
  }

  const { credential, availableStatuses } = getCredentialForBroker(
    device.id,
    ["powershell-ssh", "ssh"],
    context.allowProvidedCredentials,
    operation.adapterId,
  );
  if (!credential) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "PowerShell over SSH credential required",
      output: "PowerShell over SSH broker requires a stored powershell-ssh or SSH credential.",
      details: { availableStatuses },
    });
  }

  const secret = await vault.getSecret(credential.vaultSecretRef);
  if (secretIsMissing(secret)) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "PowerShell over SSH secret missing",
      output: "Stored PowerShell over SSH or SSH credential is missing a usable secret.",
      details: { credentialId: credential.id },
    });
  }

  const accountLabel = credential.accountLabel?.trim() ?? "";
  if (accountLabel.length === 0) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "PowerShell over SSH username is required",
      output: "PowerShell over SSH broker requires an accountLabel username.",
      details: { credentialId: credential.id },
    });
  }

  const targetHost = typeof broker.host === "string" && broker.host.trim().length > 0
    ? broker.host.trim()
    : device.ip;
  const sshResult = await runSshCommandWithCredential({
    operation,
    device,
    context,
    credential,
    accountLabel,
    secret,
    host: targetHost,
    argv: buildWindowsPowerShellSshArgv(interpolateOperationValue(broker.command, targetHost, params)),
    port: broker.port,
    validationMethod: "powershell-ssh.command",
    validationDetails: {
      adapterId: operation.adapterId,
      operationId: operation.id,
      host: targetHost,
      port: broker.port ?? 22,
    },
  });
  if (!sshResult.ok) {
    return {
      ...sshResult,
      summary: "PowerShell over SSH command failed",
    };
  }
  return applyExpectationToOutput({
    protocol: "powershell-ssh",
    output: sshResult.output,
    expectRegex: broker.expectRegex,
    details: sshResult.details,
  });
}

async function executeWmiBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "wmi") {
    return brokerResult({ handled: false, status: "failed", phase: "not-started", proof: "none", summary: "WMI broker not applicable", output: "" });
  }
  if (process.platform !== "win32") {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WMI requires a Windows Steward host",
      output: "WMI/DCOM execution is only supported when Steward runs on Windows.",
    });
  }
  const { credential, availableStatuses } = getCredentialForBroker(device.id, ["wmi"], context.allowProvidedCredentials, operation.adapterId);
  if (!credential) {
    return brokerResult({ status: "failed", phase: "not-started", proof: "none", summary: "WMI credential required", output: "WMI broker requires a stored WMI credential.", details: { availableStatuses } });
  }
  const secret = await vault.getSecret(credential.vaultSecretRef);
  const accountLabel = credential.accountLabel?.trim() ?? "";
  if (secretIsMissing(secret) || !accountLabel) {
    return brokerResult({ status: "failed", phase: "not-started", proof: "none", summary: "WMI credential incomplete", output: "WMI requires a username and password.", details: { credentialId: credential.id } });
  }
  if (!commandLooksRemoteForWmi(broker.command)) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WMI command is not remote-safe",
      output: "This WMI broker only supports commands that explicitly execute against the remote CIM session. Use $session / -CimSession / -ComputerName, or choose WinRM/PowerShell over SSH for general remote PowerShell commands.",
      details: { commandPreview: broker.command.slice(0, 240) },
    });
  }
  const namespace = broker.namespace?.trim() || "root\\cimv2";
  const hostCandidates = buildWindowsRemoteHostCandidates(device, typeof broker.host === "string" ? broker.host.trim() : undefined);
  const failures: Array<{ host: string; output: string }> = [];
  for (const targetHost of hostCandidates) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `$secure = ConvertTo-SecureString '${escapePowerShellSingleQuoted(secret)}' -AsPlainText -Force`,
      `$credential = [System.Management.Automation.PSCredential]::new('${escapePowerShellSingleQuoted(accountLabel)}', $secure)`,
      `$computerName = '${escapePowerShellSingleQuoted(targetHost)}'`,
      `$namespace = '${escapePowerShellSingleQuoted(namespace)}'`,
      "$sessionOptions = $null",
      "try { $sessionOptions = New-CimSessionOption -Protocol Dcom -ErrorAction Stop } catch { throw ('[stage=cimsession_options] ' + $_.Exception.Message) }",
      "Write-Output ('[preflight] cim-host=' + $computerName + ' namespace=' + $namespace)",
      "try { $session = New-CimSession -ComputerName $computerName -Credential $credential -SessionOption $sessionOptions -ErrorAction Stop; Write-Output '[preflight] new-cimsession=ok' } catch { throw ('[stage=cimsession_create] ' + $_.Exception.Message) }",
      "try {",
      "$scriptText = @'",
      interpolateOperationValue(broker.command, targetHost, params),
      "'@",
      "$scriptBlock = [ScriptBlock]::Create($scriptText)",
      "& $scriptBlock",
      "} finally { if ($session) { Remove-CimSession -CimSession $session -ErrorAction SilentlyContinue } }",
    ].join("\n");
    const result = await executePowerShellRuntimeScript(script, operation.timeoutMs);
    if (result.ok) {
      await markCredentialValidatedFromUse({ deviceId: device.id, credentialId: credential.id, actor: context.actor, method: "wmi.command", details: { adapterId: operation.adapterId, operationId: operation.id, host: targetHost, namespace } });
      return applyExpectationToOutput({ protocol: "wmi", output: result.output, expectRegex: broker.expectRegex, details: { ...result.details, host: targetHost, namespace, attemptedHosts: hostCandidates } });
    }
    failures.push({ host: targetHost, output: result.output });
  }
  const failureOutput = failures.map((failure) => `host=${failure.host}\n${failure.output}`).join("\n\n");
  const analysis = analyzeWmiFailure(failureOutput, device.ip);
  return brokerResult({ status: "failed", phase: "executed", proof: "process", summary: analysis.summary, output: analysis.output, details: { host: hostCandidates[0] ?? device.ip, attemptedHosts: hostCandidates, namespace, category: analysis.category, hostNetwork: getStewardHostNetworkSummary(device.ip) } });
}

async function executeSmbBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "smb") {
    return brokerResult({ handled: false, status: "failed", phase: "not-started", proof: "none", summary: "SMB broker not applicable", output: "" });
  }
  if (process.platform !== "win32") {
    return brokerResult({ status: "failed", phase: "not-started", proof: "none", summary: "SMB requires a Windows Steward host", output: "SMB administrative share operations are currently supported only when Steward runs on Windows." });
  }
  const { credential, availableStatuses } = getCredentialForBroker(device.id, ["smb"], context.allowProvidedCredentials, operation.adapterId);
  if (!credential) {
    return brokerResult({ status: "failed", phase: "not-started", proof: "none", summary: "SMB credential required", output: "SMB broker requires a stored SMB credential.", details: { availableStatuses } });
  }
  const secret = await vault.getSecret(credential.vaultSecretRef);
  const accountLabel = credential.accountLabel?.trim() ?? "";
  if (secretIsMissing(secret) || !accountLabel) {
    return brokerResult({ status: "failed", phase: "not-started", proof: "none", summary: "SMB credential incomplete", output: "SMB requires a username and password.", details: { credentialId: credential.id } });
  }
  if (!commandLooksRemoteForSmb(broker.command)) {
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "SMB command is not share-scoped",
      output: "This SMB broker only supports commands that operate on the mapped remote share through $sharePath or $shareRoot. General Windows commands like systeminfo or Get-SmbShare do not execute remotely over SMB alone.",
      details: { commandPreview: broker.command.slice(0, 240) },
    });
  }
  const share = broker.share?.trim() || "C$";
  const hostCandidates = buildWindowsRemoteHostCandidates(device, typeof broker.host === "string" ? broker.host.trim() : undefined);
  const failures: Array<{ host: string; output: string }> = [];
  for (const targetHost of hostCandidates) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `$secure = ConvertTo-SecureString '${escapePowerShellSingleQuoted(secret)}' -AsPlainText -Force`,
      `$credential = [System.Management.Automation.PSCredential]::new('${escapePowerShellSingleQuoted(accountLabel)}', $secure)`,
      `$computerName = '${escapePowerShellSingleQuoted(targetHost)}'`,
      `$shareName = '${escapePowerShellSingleQuoted(share)}'`,
      "$shareRoot = if ($shareName.StartsWith('\\\\')) { $shareName } else { '\\\\' + $computerName + '\\' + $shareName }",
      "$driveName = 'STW' + [Guid]::NewGuid().ToString('N').Substring(0, 8)",
      "$mapped = $false",
      "Write-Output ('[preflight] smb-share=' + $shareRoot)",
      "try { New-SmbMapping -LocalPath ($driveName + ':') -RemotePath $shareRoot -UserName $credential.UserName -Password (New-Object System.Net.NetworkCredential('', $credential.Password).Password) -Persistent $false -ErrorAction Stop | Out-Null; $mapped = $true; Write-Output '[preflight] new-smbmapping=ok' } catch {",
      "  try { New-PSDrive -Name $driveName -PSProvider FileSystem -Root $shareRoot -Credential $credential -ErrorAction Stop | Out-Null; $mapped = $true; Write-Output '[preflight] new-psdrive=ok' } catch { throw ('[stage=share_setup] ' + $_.Exception.Message) }",
      "}",
      "try {",
      "$sharePath = $driveName + ':\\'",
      "$scriptText = @'",
      interpolateOperationValue(broker.command, targetHost, params),
      "'@",
      "$scriptBlock = [ScriptBlock]::Create($scriptText)",
      "& $scriptBlock",
      "} finally { if ($mapped) { Remove-SmbMapping -LocalPath ($driveName + ':') -Force -ErrorAction SilentlyContinue | Out-Null; Remove-PSDrive -Name $driveName -Force -ErrorAction SilentlyContinue | Out-Null } }",
    ].join("\n");
    const result = await executePowerShellRuntimeScript(script, operation.timeoutMs);
    if (result.ok) {
      await markCredentialValidatedFromUse({ deviceId: device.id, credentialId: credential.id, actor: context.actor, method: "smb.command", details: { adapterId: operation.adapterId, operationId: operation.id, host: targetHost, share } });
      return applyExpectationToOutput({ protocol: "smb", output: result.output, expectRegex: broker.expectRegex, details: { ...result.details, host: targetHost, share, attemptedHosts: hostCandidates } });
    }
    failures.push({ host: targetHost, output: result.output });
  }
  const failureOutput = failures.map((failure) => `host=${failure.host}\n${failure.output}`).join("\n\n");
  const analysis = analyzeSmbFailure(failureOutput, device.ip);
  return brokerResult({ status: "failed", phase: "executed", proof: "process", summary: analysis.summary, output: analysis.output, details: { host: hostCandidates[0] ?? device.ip, attemptedHosts: hostCandidates, share, category: analysis.category, hostNetwork: getStewardHostNetworkSummary(device.ip) } });
}

async function executeRdpBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "rdp") {
    return brokerResult({ handled: false, status: "failed", phase: "not-started", proof: "none", summary: "RDP broker not applicable", output: "" });
  }
  if (process.platform !== "win32") {
    return brokerResult({ status: "failed", phase: "not-started", proof: "none", summary: "RDP launch requires a Windows Steward host", output: "RDP client launch is currently supported only when Steward runs on Windows." });
  }
  const targetHost = typeof broker.host === "string" && broker.host.trim().length > 0 ? broker.host.trim() : device.ip;
  const port = broker.port ?? 3389;
  const action = broker.action ?? "launch";
  const { credential } = getCredentialForBroker(device.id, ["rdp"], context.allowProvidedCredentials, operation.adapterId);
  const secret = credential ? await vault.getSecret(credential.vaultSecretRef) : undefined;
  const accountLabel = credential?.accountLabel?.trim() ?? "";
  const renderedHost = interpolateOperationValue(targetHost, device.ip, params);
  const script = action === "check"
    ? [
      "$ErrorActionPreference = 'Stop'",
      `$ok = Test-NetConnection -ComputerName '${escapePowerShellSingleQuoted(renderedHost)}' -Port ${port} -InformationLevel Quiet`,
      "if (-not $ok) { throw 'RDP reachability check failed.' }",
      `'RDP reachable at ${escapePowerShellSingleQuoted(renderedHost)}:${port}'`,
    ].join("\n")
    : [
      "$ErrorActionPreference = 'Stop'",
      `$computerName = '${escapePowerShellSingleQuoted(renderedHost)}'`,
      `$port = ${port}`,
      "$target = if ($port -eq 3389) { $computerName } else { $computerName + ':' + $port }",
      ...(!secretIsMissing(secret) && accountLabel
        ? [
          `$username = '${escapePowerShellSingleQuoted(accountLabel)}'`,
          `$password = '${escapePowerShellSingleQuoted(secret)}'`,
          'cmdkey /generic:("TERMSRV/" + $computerName) /user:$username /pass:$password | Out-Null',
        ]
        : []),
      `$arguments = @('/v:' + $target${broker.admin ? ", '/admin'" : ""})`,
      'Start-Process -FilePath "mstsc.exe" -ArgumentList $arguments | Out-Null',
      '"RDP client launched for $target"',
    ].join("\n");
  const result = await executePowerShellRuntimeScript(script, operation.timeoutMs);
  if (!result.ok) {
    return brokerResult({ status: "failed", phase: "executed", proof: "process", summary: action === "check" ? "RDP reachability check failed" : "RDP launch failed", output: result.output, details: { ...result.details, host: renderedHost, port, action } });
  }
  if (credential && !secretIsMissing(secret) && accountLabel) {
    await markCredentialValidatedFromUse({ deviceId: device.id, credentialId: credential.id, actor: context.actor, method: action === "check" ? "rdp.check" : "rdp.launch", details: { adapterId: operation.adapterId, operationId: operation.id, host: renderedHost, port, action } });
  }
  return brokerResult({ status: "succeeded", phase: "executed", proof: "process", summary: action === "check" ? "RDP reachability verified" : "RDP client launched", output: result.output, details: { ...result.details, host: renderedHost, port, action } });
}

async function executeHttpBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "http") {
    return brokerResult({
      handled: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "HTTP broker not applicable",
      output: "",
    });
  }

  let path = interpolateOperationValue(broker.path, device.ip, params);
  const renderedQuery = broker.query
    ? Object.fromEntries(
      Object.entries(broker.query).map(([key, value]) => [
        key,
        typeof value === "string" ? interpolateOperationValue(value, device.ip, params) : String(value),
      ]),
    )
    : {};
  const renderedHeaders = broker.headers
    ? Object.fromEntries(
      Object.entries(broker.headers).map(([key, value]) => [key, interpolateOperationValue(value, device.ip, params)]),
    )
    : {};
  const body = broker.body ? interpolateOperationValue(broker.body, device.ip, params) : undefined;
  let credentialSecret: string | undefined;
  let credentialApplied = false;

  const { credential, availableStatuses } = getCredentialForBroker(
    device.id,
    ["http-api"],
    context.allowProvidedCredentials,
    operation.adapterId,
  );
  if (credential) {
    const secret = await vault.getSecret(credential.vaultSecretRef);
    if (secretIsMissing(secret)) {
      logCredentialAccess(context, operation, device, "http-api", "missing_secret", {
        accountLabel: credential.accountLabel ?? null,
        credentialStatus: credential.status,
      }, credential.id);
    } else {
      credentialSecret = secret;
      const auth = getHttpApiCredentialAuth(credential.scopeJson);
      const accountLabel = credential.accountLabel?.trim() || undefined;
      let unusableReason: string | undefined;

      switch (auth.mode) {
        case "basic":
          if (!accountLabel) {
            unusableReason = "missing_account_label";
            break;
          }
          renderedHeaders.Authorization = `Basic ${Buffer.from(`${accountLabel}:${secret}`).toString("base64")}`;
          credentialApplied = true;
          break;
        case "bearer":
          renderedHeaders.Authorization = `Bearer ${secret}`;
          credentialApplied = true;
          break;
        case "api-key":
          renderedHeaders[auth.headerName ?? "X-API-Key"] = secret;
          credentialApplied = true;
          break;
        case "query-param":
          renderedQuery[auth.queryParamName ?? "api_key"] = secret;
          credentialApplied = true;
          break;
        case "path-segment": {
          const rendered = applyPathSegmentCredentialToPath(path, secret, auth.pathPrefix);
          path = rendered.path;
          credentialApplied = rendered.applied;
          break;
        }
      }

      if (credentialApplied) {
        logCredentialAccess(context, operation, device, "http-api", "granted", {
          authMode: auth.mode,
          accountLabel: accountLabel ?? null,
          credentialStatus: credential.status,
          headerName: auth.headerName ?? null,
          queryParamName: auth.queryParamName ?? null,
          pathPrefix: auth.pathPrefix ?? null,
        }, credential.id);
      } else if (unusableReason) {
        logCredentialAccess(context, operation, device, "http-api", "credential_unusable", {
          authMode: auth.mode,
          accountLabel: accountLabel ?? null,
          credentialStatus: credential.status,
          reason: unusableReason,
        }, credential.id);
      }
    }
  } else if (availableStatuses.length > 0) {
    logCredentialAccess(context, operation, device, "http-api", "credential_unusable", {
      allowedStatuses: ["pending", "provided", "validated", "invalid"],
      availableStatuses,
    });
  }

  const schemes = broker.schemes && broker.schemes.length > 0
    ? broker.schemes
    : [broker.scheme ?? "https"];

  let lastFailure = "HTTP broker request failed";
  for (const scheme of schemes) {
    const url = new URL(`${scheme}://${device.ip}${broker.port ? `:${broker.port}` : ""}${path}`);
    for (const [key, value] of Object.entries(renderedQuery)) {
      url.searchParams.set(key, value);
    }

    const session = await webSessionManager.resolveSessionForUrl({
      deviceId: device.id,
      targetUrl: url.toString(),
      explicitSessionId: broker.sessionId,
    });
    const sessionCookie = session ? await webSessionManager.buildCookieHeader(session.id, url.toString()) : undefined;
    const requestHeaders = {
      ...renderedHeaders,
      ...(sessionCookie && !renderedHeaders.Cookie ? { Cookie: sessionCookie } : {}),
    };

    const response = await requestText(url, {
      method: broker.method,
      headers: requestHeaders,
      insecureSkipVerify: broker.insecureSkipVerify ?? false,
      body,
      timeoutMs: operation.timeoutMs,
    });
    const redactedUrl = redactSensitiveHttpValue(url.toString(), credentialSecret);
    const redactedBody = redactSensitiveHttpValue(response.body, credentialSecret);
    const redactedError = response.error ? redactSensitiveHttpValue(response.error, credentialSecret) : "";
    const responseJson = parseHttpResponseJson(redactedBody);

    const outputLines = [
      redactedBody,
      redactedError ? `[error] ${redactedError}` : "",
      `[status code: ${response.statusCode}]`,
      `[url] ${redactedUrl}`,
    ].filter((value) => value.trim().length > 0);
    const output = outputLines.join("\n").trim();

    if (!response.ok) {
      lastFailure = output || lastFailure;
      continue;
    }

    if (broker.expectRegex) {
      const matched = new RegExp(broker.expectRegex, "i").test(response.body);
      if (!matched) {
        lastFailure = `${output}\n[expectation failed] ${broker.expectRegex}`.trim();
        continue;
      }
    }

    const httpResult = brokerResult({
      status: "succeeded",
      phase: broker.expectRegex ? "verified" : "responded",
      proof: broker.expectRegex ? "expectation" : "response",
      summary: `${broker.method} ${redactedUrl} returned ${response.statusCode}`,
      output,
        details: {
          method: broker.method,
          url: redactedUrl,
          statusCode: response.statusCode,
          matchedExpectation: Boolean(broker.expectRegex),
          responseBody: redactedBody,
          responseJson,
          authApplied: credentialApplied,
          sessionId: session?.id,
          sessionCookieApplied: Boolean(sessionCookie),
        },
      });
    if (credential && credentialApplied) {
      await markCredentialValidatedFromUse({
        deviceId: device.id,
        credentialId: credential.id,
        actor: context.actor,
        method: "http.response",
        details: {
          adapterId: operation.adapterId,
          operationId: operation.id,
          url: redactedUrl,
          statusCode: response.statusCode,
        },
      });
    }
    return httpResult;
  }

  return brokerResult({
    status: "failed",
    phase: "responded",
    proof: broker.expectRegex ? "response" : "none",
    summary: "HTTP broker request failed",
    output: lastFailure,
  });
}

async function executeMqttBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "mqtt") {
    return brokerResult({
      handled: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "MQTT broker not applicable",
      output: "",
    });
  }

  const { credential, availableStatuses } = getCredentialForBroker(
    device.id,
    ["mqtt"],
    context.allowProvidedCredentials,
    operation.adapterId,
  );
  let secret: string | undefined;

  if (credential) {
    const candidateSecret = await vault.getSecret(credential.vaultSecretRef);
    if (secretIsMissing(candidateSecret)) {
      logCredentialAccess(context, operation, device, "mqtt", "missing_secret", {
        accountLabel: credential.accountLabel ?? null,
        credentialStatus: credential.status,
      }, credential.id);
    } else {
      secret = candidateSecret;
    }
  } else if (availableStatuses.length > 0) {
    logCredentialAccess(context, operation, device, "mqtt", "credential_unusable", {
      allowedStatuses: ["pending", "provided", "validated", "invalid"],
      availableStatuses,
    });
  }

  const rendered = renderMqttBrokerRequest({
    device,
    broker,
    params,
    credentialUsername: credential?.accountLabel,
    password: secret,
  });

  if (credential && secret) {
    logCredentialAccess(context, operation, device, "mqtt", "granted", {
      accountLabel: credential.accountLabel ?? null,
      renderedUsername: rendered.username ?? null,
      credentialStatus: credential.status,
      url: rendered.url,
      subscribeTopics: rendered.subscribeTopics,
      publishTopics: rendered.publishMessages.map((message) => message.topic),
    }, credential.id);
  }

  const holder = broker.sessionHolder?.trim()
    || `${context.actor}:${context.playbookRunId ?? operation.id}`;
  const purpose = `${operation.adapterId}:${operation.kind}`;
  const sessionExchange = await protocolSessionManager.exchangeMqtt({
    device,
    rendered,
    credentialId: credential?.id,
    sessionId: broker.sessionId,
    adapterId: operation.adapterId,
    holder,
    purpose,
    keepSessionOpen: broker.keepSessionOpen === true,
    desiredState: broker.keepSessionOpen ? "active" : "idle",
    arbitrationMode: broker.arbitrationMode,
    singleConnectionHint: broker.singleConnectionHint,
    leaseTtlMs: broker.leaseTtlMs,
  });
  const result = sessionExchange.result;
  if (result.ok && credential) {
    await markCredentialValidatedFromUse({
      deviceId: device.id,
      credentialId: credential.id,
      actor: context.actor,
      method: broker.keepSessionOpen ? "mqtt.session" : "mqtt.exchange",
      details: {
        adapterId: operation.adapterId,
        operationId: operation.id,
        url: rendered.url,
        sessionId: sessionExchange.session.id,
        leaseId: sessionExchange.lease.id,
        subscribeTopics: rendered.subscribeTopics,
        publishTopics: rendered.publishMessages.map((message) => message.topic),
      },
    });
  }

  return brokerResult({
    status: result.status,
    phase: result.phase,
    proof: result.proof,
    summary: result.summary,
    output: result.output,
    details: result.details,
  });
}

async function executeLocalToolBroker(
  operation: OperationSpec,
  _device: Device,
  _params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  void _device;
  void _params;
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "local-tool") {
    return brokerResult({
      handled: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "Local-tool broker not applicable",
      output: "",
    });
  }

  const result = await localToolRuntime.execute({
    toolId: broker.toolId,
    command: broker.command,
    argv: broker.argv ?? [],
    cwd: broker.cwd,
    timeoutMs: broker.timeoutMs ?? operation.timeoutMs,
    installIfMissing: broker.installIfMissing,
    healthCheckBeforeRun: broker.healthCheckBeforeRun,
    approvalReason: broker.approvalReason,
  }, context.actor);

  if (!("toolId" in result)) {
    return brokerResult({
      status: result.status === "blocked" ? "blocked" : "failed",
      phase: result.status === "blocked" ? "blocked" : "executed",
      proof: "process",
      summary: result.summary,
      output: result.error ?? result.summary,
      details: {
        toolId: broker.toolId,
        approvalId: result.approval?.id ?? null,
      },
    });
  }

  const execution = result;
  return brokerResult({
    status: execution.ok ? "succeeded" : "failed",
    phase: "executed",
    proof: "process",
    summary: execution.summary,
    output: `${execution.stdout}${execution.stderr ? `\n[stderr] ${execution.stderr}` : ""}`.trim(),
    details: {
      toolId: execution.toolId,
      command: execution.command,
      argv: execution.argv,
      code: execution.code,
      binPath: execution.binPath ?? null,
      durationMs: execution.durationMs,
    },
  });
}

async function normalizeWebSocketPayload(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }

  return String(data ?? "");
}

function resolveWebSocketSuccessStrategy(
  requested: WebSocketSuccessStrategy | undefined,
  operation: OperationSpec,
  hasMessages: boolean,
  hasExpectation: boolean,
): WebSocketSuccessStrategy {
  if (requested && requested !== "auto") {
    return requested;
  }
  if (hasExpectation) {
    return "expectation";
  }
  if (operation.mode === "mutate" && hasMessages) {
    return "response";
  }
  return "transport";
}

function websocketPhaseFromState(args: {
  opened: boolean;
  messagesSent: number;
  collected: number;
  expectationMatched: boolean;
}): OperationExecutionPhase {
  if (args.expectationMatched) {
    return "verified";
  }
  if (args.collected > 0) {
    return "responded";
  }
  if (args.messagesSent > 0) {
    return "sent";
  }
  if (args.opened) {
    return "connected";
  }
  return "not-started";
}

async function executeWebSocketBroker(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  _context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  void _context;
  const broker = operation.brokerRequest;
  if (!broker || broker.protocol !== "websocket") {
    return brokerResult({
      handled: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "WebSocket broker not applicable",
      output: "",
    });
  }

  const path = interpolateOperationValue(broker.path, device.ip, params);
  const query = broker.query
    ? Object.fromEntries(
      Object.entries(broker.query).map(([key, value]) => [
        key,
        typeof value === "string" ? interpolateOperationValue(value, device.ip, params) : String(value),
      ]),
    )
    : {};
  const headers = broker.headers
    ? Object.fromEntries(
      Object.entries(broker.headers).map(([key, value]) => [key, interpolateOperationValue(value, device.ip, params)]),
    )
    : {};
  const protocols = (broker.protocols ?? [])
    .map((value) => interpolateOperationValue(value, device.ip, params))
    .filter((value) => value.trim().length > 0);
  const renderedMessages = (broker.messages ?? []).map((message) =>
    interpolateOperationValue(message, device.ip, params),
  );
  const url = new URL(`${broker.scheme ?? "ws"}://${device.ip}${broker.port ? `:${broker.port}` : ""}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const session = await webSessionManager.resolveSessionForUrl({
    deviceId: device.id,
    targetUrl: url.toString(),
    explicitSessionId: broker.sessionId,
  });
  const sessionCookie = session ? await webSessionManager.buildCookieHeader(session.id, url.toString()) : undefined;
  const requestHeaders = {
    ...headers,
    ...(sessionCookie && !headers.Cookie ? { Cookie: sessionCookie } : {}),
  };

  const connectTimeoutMs = Math.max(250, Math.min(operation.timeoutMs, broker.connectTimeoutMs ?? 4_000));
  const responseTimeoutMs = Math.max(250, Math.min(operation.timeoutMs, broker.responseTimeoutMs ?? 1_500));
  const collectMessages = Math.max(1, broker.collectMessages ?? Math.max(1, renderedMessages.length + 1));
  const sendOn = broker.sendOn ?? "open";
  const successStrategy = resolveWebSocketSuccessStrategy(
    broker.successStrategy,
    operation,
    renderedMessages.length > 0,
    Boolean(broker.expectRegex),
  );

  return new Promise<BrokerExecutionResult>((resolve) => {
    let socket: WebSocket | null = null;
    let settled = false;
    let opened = false;
    let messagesSent = false;
    let sentCount = 0;
    const collected: string[] = [];
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let responseTimer: ReturnType<typeof setTimeout> | null = null;
    let closeCode: number | null = null;
    let closeReason = "";
    let termination: string | undefined;

    const clearTimers = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (responseTimer) clearTimeout(responseTimer);
      connectTimer = null;
      responseTimer = null;
    };

    const buildDetails = (extraError?: string, expectationMatched = false): Record<string, unknown> => ({
      url: url.toString(),
      successStrategy,
      sendOn,
      messagesAttempted: renderedMessages.length,
      messagesSent: sentCount,
      messagesCollected: collected.length,
      opened,
      closeCode,
      closeReason,
      connectTimeoutMs,
      responseTimeoutMs,
      protocols,
        headers: Object.keys(requestHeaders),
        sessionId: session?.id,
        sessionCookieApplied: Boolean(sessionCookie),
        termination: extraError ? "error" : termination ?? "completed",
      ...(extraError ? { error: extraError } : {}),
      ...(broker.expectRegex ? { expectRegex: broker.expectRegex, expectationMatched } : {}),
    });

    const buildOutput = (extraError?: string): string => {
      const lines = [
        ...collected,
        extraError ? `[error] ${extraError}` : "",
        `[success strategy: ${successStrategy}]`,
        `[messages sent: ${sentCount}/${renderedMessages.length}]`,
        `[messages collected: ${collected.length}]`,
        closeCode !== null ? `[close code: ${closeCode}]` : "",
        closeReason ? `[close reason: ${closeReason}]` : "",
        `[url] ${url.toString()}`,
      ].filter((value) => value.trim().length > 0);
      return lines.join("\n").trim();
    };

    const evaluateSuccess = (extraError?: string): BrokerExecutionResult => {
      const expectationMatched = broker.expectRegex
        ? new RegExp(broker.expectRegex, "i").test(collected.join("\n\n"))
        : false;
      const output = buildOutput(extraError);
      const phase = websocketPhaseFromState({
        opened,
        messagesSent: sentCount,
        collected: collected.length,
        expectationMatched,
      });
      if (extraError) {
        return brokerResult({
          status: "failed",
          phase,
          proof: phase === "responded" || phase === "verified" ? "response" : phase === "sent" || phase === "connected" ? "transport" : "none",
          summary: "WebSocket broker request failed",
          output,
          details: buildDetails(extraError, expectationMatched),
        });
      }

      if (successStrategy === "expectation") {
        if (!broker.expectRegex) {
          return brokerResult({
            status: "failed",
            phase,
            proof: phase === "responded" || phase === "verified" ? "response" : "none",
            summary: "WebSocket expectation strategy requires expectRegex",
            output,
            details: buildDetails("Missing expectRegex for expectation strategy", expectationMatched),
          });
        }
        if (!expectationMatched) {
          return brokerResult({
            status: "inconclusive",
            phase,
            proof: collected.length > 0 ? "response" : sentCount > 0 || opened ? "transport" : "none",
            summary: "WebSocket response did not match expectation",
            output: `${output}\n[expectation failed] ${broker.expectRegex}`.trim(),
            details: buildDetails(undefined, expectationMatched),
          });
        }
        return brokerResult({
          status: "succeeded",
          phase: "verified",
          proof: "expectation",
          summary: "WebSocket response matched expectation",
          output,
          details: buildDetails(undefined, expectationMatched),
        });
      }

      if (successStrategy === "response") {
        if (collected.length > 0) {
          return brokerResult({
            status: "succeeded",
            phase: "responded",
            proof: "response",
            summary: "WebSocket response received",
            output,
            details: buildDetails(undefined, expectationMatched),
          });
        }
        return brokerResult({
          status: "inconclusive",
          phase,
          proof: sentCount > 0 || opened ? "transport" : "none",
          summary: "WebSocket sent successfully but returned no response",
          output,
          details: buildDetails(undefined, expectationMatched),
        });
      }

      if (successStrategy === "transport") {
        const transportOk = opened && (renderedMessages.length === 0 || sentCount === renderedMessages.length);
        return brokerResult({
          status: transportOk ? "succeeded" : "failed",
          phase,
          proof: transportOk ? "transport" : "none",
          summary: transportOk
            ? "WebSocket transport opened and sent requested messages"
            : "WebSocket transport did not complete the requested send",
          output,
          details: buildDetails(undefined, expectationMatched),
        });
      }

      return brokerResult({
        status: "inconclusive",
        phase,
        proof: phase === "responded" || phase === "verified" ? "response" : phase === "sent" || phase === "connected" ? "transport" : "none",
        summary: "WebSocket execution was inconclusive",
        output,
        details: buildDetails(undefined, expectationMatched),
      });
    };

    const finalize = (extraError?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      try {
        socket?.close();
      } catch {
        // Best-effort close only.
      }
      resolve(evaluateSuccess(extraError));
    };

    const scheduleFinish = () => {
      if (responseTimer) {
        clearTimeout(responseTimer);
      }
      responseTimer = setTimeout(() => finalize(), responseTimeoutMs);
    };

    const sendMessages = () => {
      if (!socket || messagesSent || renderedMessages.length === 0) {
        return;
      }
      messagesSent = true;
      try {
        for (const message of renderedMessages) {
          socket.send(message);
          sentCount += 1;
        }
      } catch (error) {
        finalize(error instanceof Error ? error.message : String(error));
        return;
      }
      termination = "awaiting-response";
      scheduleFinish();
    };

    try {
      const WebSocketCtor = WebSocket as unknown as {
        new (url: string | URL, init?: { headers?: Record<string, string>; protocols?: string[] }): WebSocket;
      };
      socket = new WebSocketCtor(url, {
        ...(protocols.length > 0 ? { protocols } : {}),
        ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
      });
    } catch (error) {
      finalize(error instanceof Error ? error.message : String(error));
      return;
    }

    connectTimer = setTimeout(() => {
      finalize("WebSocket connect timeout");
    }, connectTimeoutMs);

    socket.addEventListener("open", () => {
      opened = true;
      termination = "open";
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }

      if (sendOn === "open") {
        sendMessages();
      } else if (renderedMessages.length === 0) {
        scheduleFinish();
      }
    });

    socket.addEventListener("message", (event) => {
      void normalizeWebSocketPayload(event.data)
        .then((payload) => {
          if (settled) {
            return;
          }

          collected.push(payload);
          if (sendOn === "first-message" && !messagesSent) {
            sendMessages();
          } else if (collected.length >= collectMessages) {
            termination = "message-limit";
            finalize();
          } else {
            termination = "awaiting-more-messages";
            scheduleFinish();
          }
        })
        .catch((error) => {
          finalize(error instanceof Error ? error.message : String(error));
        });
    });

    socket.addEventListener("error", (event) => {
      const message = event instanceof ErrorEvent && typeof event.message === "string" && event.message.trim().length > 0
        ? event.message
        : "WebSocket broker request failed";
      finalize(message);
    });

    socket.addEventListener("close", (event) => {
      closeCode = event.code;
      closeReason = event.reason;
      termination = termination ?? "closed";
      if (!settled) {
        finalize(opened ? undefined : "WebSocket connection closed before open");
      }
    });
  });
}

export async function executeBrokerOperation(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: BrokerExecutionContext,
): Promise<BrokerExecutionResult> {
  if (!operation.brokerRequest) {
    return brokerResult({
      handled: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "No broker request provided",
      output: "",
    });
  }

  if (operation.brokerRequest.protocol === "ssh") {
    return executeSshBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "telnet") {
    return executeTelnetBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "http") {
    return executeHttpBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "websocket") {
    return executeWebSocketBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "mqtt") {
    return executeMqttBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "local-tool") {
    return executeLocalToolBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "winrm") {
    return executeWinrmBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "powershell-ssh") {
    return executePowerShellSshBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "wmi") {
    return executeWmiBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "smb") {
    return executeSmbBroker(operation, device, params, context);
  }

  if (operation.brokerRequest.protocol === "rdp") {
    return executeRdpBroker(operation, device, params, context);
  }

  return brokerResult({
    handled: false,
    status: "failed",
    phase: "not-started",
    proof: "none",
    summary: "Unsupported broker protocol",
    output: "",
  });
}
