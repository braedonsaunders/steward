import { interpolateOperationValue } from "@/lib/adapters/execution-template";
import {
  analyzeWinrmFailure,
  buildWinrmPowerShellScript,
  isWinrmIpLiteral,
  normalizeWinrmOutput,
  powerShellInstallHint,
  preferredWinrmHost,
  resolvePowerShellRuntime,
  resolveWinrmConnection,
} from "@/lib/adapters/winrm";
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
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import { runCommand } from "@/lib/utils/shell";
import type {
  Device,
  DeviceCredential,
  OperationExecutionPhase,
  OperationExecutionProof,
  OperationExecutionStatus,
  OperationSpec,
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

function getCredentialForBroker(
  deviceId: string,
  protocols: string[],
  allowProvidedCredentials?: boolean,
  adapterId?: string,
): { credential?: DeviceCredential; availableStatuses: string[] } {
  const candidates = stateStore.getDeviceCredentials(deviceId)
    .filter((credential) => protocols.includes(credential.protocol.toLowerCase()));

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
    credential: sorted[0]
      ?? (allowProvidedCredentials ? candidates.find((credential) => credential.status === "provided") : undefined),
    availableStatuses: Array.from(new Set(candidates.map((credential) => credential.status))),
  };
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

function formatWinrmRemediationHints(output: string): string {
  const analysis = analyzeWinrmFailure(output);
  if (analysis.hints.length === 0) {
    return "";
  }
  return ["[remediation]", ...analysis.hints.map((hint) => `- ${hint}`)].join("\n");
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
  port?: number;
  validationMethod: string;
  validationDetails: Record<string, unknown>;
}): Promise<BrokerExecutionResult> {
  const result = process.platform === "win32"
    ? formatCommandOutput(await runCommand(
      "plink",
      [
        "-batch",
        "-ssh",
        "-l",
        input.accountLabel,
        ...(input.port && input.port !== 22 ? ["-P", String(input.port)] : []),
        input.host,
        "-pw",
        input.secret,
        ...input.argv,
      ],
      input.operation.timeoutMs,
    ))
    : formatCommandOutput(await runCommand(
      "sshpass",
      [
        "-p",
        input.secret,
        "ssh",
        "-l",
        input.accountLabel,
        ...(input.port && input.port !== 22 ? ["-p", String(input.port)] : []),
        "-o",
        "StrictHostKeyChecking=no",
        input.host,
        ...input.argv,
      ],
      input.operation.timeoutMs,
    ));

  if (result.ok) {
    await markCredentialValidatedFromUse({
      deviceId: input.device.id,
      credentialId: input.credential.id,
      actor: input.context.actor,
      method: input.validationMethod,
      details: input.validationDetails,
    });
  }

  return result;
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

  const { credential, availableStatuses } = getCredentialForBroker(
    device.id,
    ["ssh"],
    context.allowProvidedCredentials,
    operation.adapterId,
  );
  if (!credential) {
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

  const secret = await vault.getSecret(credential.vaultSecretRef);
  if (!secret || secret.trim().length === 0) {
    logCredentialAccess(context, operation, device, "ssh", "missing_secret", {
      accountLabel: credential.accountLabel ?? null,
      credentialStatus: credential.status,
    }, credential.id);
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "SSH secret missing",
      output: context.allowProvidedCredentials
        ? "Stored SSH credential is missing a usable secret"
        : "Validated SSH credential is missing a usable secret",
      details: { credentialId: credential.id },
    });
  }

  const accountLabel = credential.accountLabel?.trim() ?? "";
  if (accountLabel.length === 0) {
    logCredentialAccess(context, operation, device, "ssh", "credential_unusable", {
      credentialStatus: credential.status,
      reason: "missing_account_label",
    }, credential.id);
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "SSH username is required",
      output: "SSH broker requires a credential with an accountLabel username.",
      details: { credentialId: credential.id },
    });
  }

  const remoteArgv = broker.argv.map((arg) => interpolateOperationValue(arg, device.ip, params));

  logCredentialAccess(context, operation, device, "ssh", "granted", {
    accountLabel,
    argv: remoteArgv,
    credentialStatus: credential.status,
  }, credential.id);

  return runSshCommandWithCredential({
    operation,
    device,
    context,
    credential,
    accountLabel,
    secret,
    host: device.ip,
    argv: remoteArgv,
    port: broker.port,
    validationMethod: "ssh.command",
    validationDetails: { adapterId: operation.adapterId, operationId: operation.id },
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
    if (!secret || secret.trim().length === 0) {
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
    ["winrm", "windows"],
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
  if (!secret || secret.trim().length === 0) {
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

  const failureCacheKey = winrmFailureCacheKey({
    deviceId: device.id,
    host: targetHost,
    ip: device.ip,
    port: connection.value.port,
    useSsl: connection.value.useSsl,
    authentication: connection.value.authentication,
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

  const allowIpFallback = connection.value.useSsl || targetHostIsIp;
  const hostCandidates = Array.from(new Set([
    targetHost,
    ...(allowIpFallback ? [device.ip] : []),
  ].filter((value) => value.length > 0)));
  const wsmanScheme = connection.value.useSsl ? "https" : "http";
  const hostCandidateScores = await Promise.all(hostCandidates.map(async (hostCandidate) => {
    const probe = await requestText(new URL(`${wsmanScheme}://${hostCandidate}:${connection.value.port}/wsman`), {
      method: "GET",
      timeoutMs: 2_000,
      insecureSkipVerify: connection.value.skipCertChecks,
    });
    const reachable = probe.statusCode === 405 || probe.statusCode === 401 || probe.ok;
    return { host: hostCandidate, reachable };
  }));
  const orderedHostCandidates = hostCandidateScores
    .sort((a, b) => Number(b.reachable) - Number(a.reachable))
    .map((candidate) => candidate.host);

  logCredentialAccess(context, operation, device, "winrm", "granted", {
    accountLabel,
    host: orderedHostCandidates[0],
    credentialStatus: credential.status,
    port: connection.value.port,
    useSsl: connection.value.useSsl,
    skipCertChecks: connection.value.skipCertChecks,
    authentication: connection.value.authentication,
  }, credential.id);

  const executableUsed = runtime.executable;
  const failures: Array<{ host: string; output: string; code: number }> = [];
  let successfulHost: string | null = null;
  let output = "";

  for (const hostCandidate of orderedHostCandidates) {
    const command = interpolateOperationValue(broker.command, hostCandidate, params);
    const script = buildWinrmPowerShellScript({
      host: hostCandidate,
      username: accountLabel,
      password: secret,
      command,
      connection: connection.value,
    });

    const attempt = await runCommand(
      executableUsed,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(script)],
      operation.timeoutMs,
    );
    output = normalizeWinrmOutput(`${attempt.stdout}${attempt.stderr ? `\n[stderr] ${attempt.stderr}` : ""}`).trim();
    if (attempt.ok) {
      successfulHost = hostCandidate;
      break;
    }
    failures.push({
      host: hostCandidate,
      output,
      code: attempt.code,
    });
  }

  if (!successfulHost) {
    const wsmanProbe = await requestText(new URL(`${wsmanScheme}://${device.ip}:${connection.value.port}/wsman`), {
      method: "GET",
      timeoutMs: 4_000,
      insecureSkipVerify: connection.value.skipCertChecks,
    });
    const listenerReachable = wsmanProbe.statusCode === 405 || wsmanProbe.statusCode === 401 || wsmanProbe.ok;
    const failureOutput = failures.map((failure) => `host=${failure.host}\n${failure.output}\n[exit code: ${failure.code}]`).join("\n\n");
    const diagnostic = listenerReachable
      ? `[diagnostic] WinRM listener reachable at ${device.ip}:${connection.value.port} (HTTP ${wsmanProbe.statusCode}), but remoting session negotiation failed.`
      : `[diagnostic] WinRM listener probe failed at ${device.ip}:${connection.value.port} (${wsmanProbe.error ?? `HTTP ${wsmanProbe.statusCode}`}).`;
    const remediation = formatWinrmRemediationHints(failureOutput);
    const summary = listenerReachable
      ? `WinRM session negotiation failed via ${executableUsed}`
      : `WinRM transport connection failed via ${executableUsed}`;
    const details = {
      executable: executableUsed,
      powerShellVersion: runtime.version ?? null,
      host: orderedHostCandidates[0],
      attemptedHosts: orderedHostCandidates,
      port: connection.value.port,
      useSsl: connection.value.useSsl,
      skipCertChecks: connection.value.skipCertChecks,
      authentication: connection.value.authentication,
      wsmanProbe: {
        url: `${wsmanScheme}://${device.ip}:${connection.value.port}/wsman`,
        statusCode: wsmanProbe.statusCode,
        ok: wsmanProbe.ok,
        error: wsmanProbe.error ?? null,
      },
      matchedExpectation: false,
      ipFallbackEnabled: allowIpFallback,
      targetHost,
      targetHostIsIp,
    };
    if (listenerReachable) {
      winrmNegotiationFailureCache.set(failureCacheKey, {
        summary,
        output: `${failureOutput}\n\n${diagnostic}${remediation ? `\n\n${remediation}` : ""}`.trim(),
        details,
        cachedAt: Date.now(),
      });
    }
    return brokerResult({
      status: "failed",
      phase: "executed",
      proof: "process",
      summary,
      output: `${failureOutput}\n\n${diagnostic}${remediation ? `\n\n${remediation}` : ""}`.trim(),
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
          port: connection.value.port,
          useSsl: connection.value.useSsl,
          skipCertChecks: connection.value.skipCertChecks,
          authentication: connection.value.authentication,
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
      attemptedHosts: orderedHostCandidates,
      port: connection.value.port,
      useSsl: connection.value.useSsl,
      skipCertChecks: connection.value.skipCertChecks,
      authentication: connection.value.authentication,
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
        port: connection.value.port,
        useSsl: connection.value.useSsl,
      },
  });
  return winrmResult;
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
    if (!secret || secret.trim().length === 0) {
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

    const response = await requestText(url, {
      method: broker.method,
      headers: renderedHeaders,
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
    if (!candidateSecret || candidateSecret.trim().length === 0) {
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
      headers: Object.keys(headers),
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
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
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

  return brokerResult({
    handled: false,
    status: "failed",
    phase: "not-started",
    proof: "none",
    summary: "Unsupported broker protocol",
    output: "",
  });
}
