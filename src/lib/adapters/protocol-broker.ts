import { interpolateOperationValue } from "@/lib/adapters/execution-template";
import {
  buildWinrmPowerShellScript,
  powerShellInstallHint,
  preferredWinrmHost,
  resolvePowerShellRuntime,
  resolveWinrmConnection,
} from "@/lib/adapters/winrm";
import { requestText } from "@/lib/network/http-client";
import { markCredentialValidatedFromUse } from "@/lib/adoption/credentials";
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
): { credential?: DeviceCredential; availableStatuses: string[] } {
  const candidates = stateStore.getDeviceCredentials(deviceId)
    .filter((credential) => protocols.includes(credential.protocol.toLowerCase()));

  const priority = ["validated", "provided", "invalid", "pending"] as const;
  const sorted = [...candidates].sort((a, b) => {
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
    if (context.allowUnauthenticated) {
      return brokerResult({
        handled: false,
        status: "failed",
        phase: "not-started",
        proof: "none",
        summary: "SSH credential not available",
        output: "",
      });
    }
    return brokerResult({
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "SSH credential required",
      output: "SSH broker requires a stored SSH credential",
      details: { availableStatuses },
    });
  }

  const secret = await vault.getSecret(credential.vaultSecretRef);
  if (!secret || secret.trim().length === 0) {
    logCredentialAccess(context, operation, device, "ssh", "missing_secret", {
      accountLabel: credential.accountLabel ?? null,
      credentialStatus: credential.status,
    }, credential.id);
    if (context.allowUnauthenticated) {
      return brokerResult({
        handled: false,
        status: "failed",
        phase: "not-started",
        proof: "none",
        summary: "SSH secret missing",
        output: "",
      });
    }
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

  const remoteArgv = broker.argv.map((arg) => interpolateOperationValue(arg, device.ip, params));
  const host = (credential.accountLabel?.trim() || "").length > 0
    ? `${credential.accountLabel?.trim()}@${device.ip}`
    : device.ip;

  logCredentialAccess(context, operation, device, "ssh", "granted", {
    accountLabel: credential.accountLabel ?? null,
    argv: remoteArgv,
    credentialStatus: credential.status,
  }, credential.id);

  if (process.platform === "win32") {
    const result = formatCommandOutput(await runCommand(
      "plink",
      [
        "-batch",
        "-ssh",
        ...(broker.port && broker.port !== 22 ? ["-P", String(broker.port)] : []),
        host,
        "-pw",
        secret,
        ...remoteArgv,
      ],
      operation.timeoutMs,
    ));
    if (result.ok) {
      await markCredentialValidatedFromUse({
        deviceId: device.id,
        credentialId: credential.id,
        actor: context.actor,
        method: "ssh.command",
        details: { adapterId: operation.adapterId, operationId: operation.id },
      });
    }
    return result;
  }

  const result = formatCommandOutput(await runCommand(
    "sshpass",
    [
      "-p",
      secret,
      "ssh",
      ...(broker.port && broker.port !== 22 ? ["-p", String(broker.port)] : []),
      "-o",
      "StrictHostKeyChecking=no",
      host,
      ...remoteArgv,
    ],
    operation.timeoutMs,
  ));
  if (result.ok) {
    await markCredentialValidatedFromUse({
      deviceId: device.id,
      credentialId: credential.id,
      actor: context.actor,
      method: "ssh.command",
      details: { adapterId: operation.adapterId, operationId: operation.id },
    });
  }
  return result;
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

  const { credential, availableStatuses } = getCredentialForBroker(
    device.id,
    ["winrm", "windows"],
    context.allowProvidedCredentials,
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

  const hostCandidates = Array.from(new Set([targetHost, device.ip].filter((value) => value.length > 0)));

  logCredentialAccess(context, operation, device, "winrm", "granted", {
    accountLabel,
    host: hostCandidates[0],
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

  for (const hostCandidate of hostCandidates) {
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
    output = `${attempt.stdout}${attempt.stderr ? `\n[stderr] ${attempt.stderr}` : ""}`.trim();
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
    const wsmanScheme = connection.value.useSsl ? "https" : "http";
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
    return brokerResult({
      status: "failed",
      phase: "executed",
      proof: "process",
      summary: listenerReachable
        ? `WinRM session negotiation failed via ${executableUsed}`
        : `WinRM transport connection failed via ${executableUsed}`,
      output: `${failureOutput}\n\n${diagnostic}`.trim(),
      details: {
        executable: executableUsed,
        powerShellVersion: runtime.version ?? null,
        host: hostCandidates[0],
        attemptedHosts: hostCandidates,
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
      },
    });
  }

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
      attemptedHosts: hostCandidates,
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

  const path = interpolateOperationValue(broker.path, device.ip, params);
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

  const { credential, availableStatuses } = getCredentialForBroker(
    device.id,
    ["http-api"],
    context.allowProvidedCredentials,
  );
  if (credential) {
    const secret = await vault.getSecret(credential.vaultSecretRef);
    if (!secret || secret.trim().length === 0) {
      logCredentialAccess(context, operation, device, "http-api", "missing_secret", {
        accountLabel: credential.accountLabel ?? null,
        credentialStatus: credential.status,
      }, credential.id);
    } else if (credential.accountLabel?.trim()) {
      renderedHeaders.Authorization = `Basic ${Buffer.from(`${credential.accountLabel.trim()}:${secret}`).toString("base64")}`;
      logCredentialAccess(context, operation, device, "http-api", "granted", {
        authMode: "basic",
        accountLabel: credential.accountLabel.trim(),
        credentialStatus: credential.status,
      }, credential.id);
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

    const outputLines = [
      response.body,
      response.error ? `[error] ${response.error}` : "",
      `[status code: ${response.statusCode}]`,
      `[url] ${url.toString()}`,
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
      summary: `${broker.method} ${url.toString()} returned ${response.statusCode}`,
      output,
      details: {
        method: broker.method,
        url: url.toString(),
        statusCode: response.statusCode,
        matchedExpectation: Boolean(broker.expectRegex),
      },
    });
    if (credential) {
      await markCredentialValidatedFromUse({
        deviceId: device.id,
        credentialId: credential.id,
        actor: context.actor,
        method: "http.response",
        details: {
          adapterId: operation.adapterId,
          operationId: operation.id,
          url: url.toString(),
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
