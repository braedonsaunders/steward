import { randomUUID } from "node:crypto";
import {
  buildWinrmPowerShellScript,
  powerShellInstallHint,
  resolvePowerShellRuntime,
  resolveWinrmConnection,
} from "@/lib/adapters/winrm";
import { requestText } from "@/lib/network/http-client";
import { runCommand } from "@/lib/utils/shell";
import { stateStore } from "@/lib/state/store";
import { vault } from "@/lib/security/vault";
import type { Device, DeviceCredential } from "@/lib/state/types";

export interface StoreDeviceCredentialInput {
  deviceId: string;
  protocol: string;
  secret: string;
  adapterId?: string;
  accountLabel?: string;
  scopeJson?: Record<string, unknown>;
}

export interface UpdateDeviceCredentialInput {
  deviceId: string;
  credentialId: string;
  protocol?: string;
  secret?: string;
  accountLabel?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeProtocol(protocol: string): string {
  return protocol.trim().toLowerCase();
}

function defaultScope(protocol: string): Record<string, unknown> {
  switch (protocol) {
    case "ssh":
      return { level: "admin", operations: ["shell", "service-control"] };
    case "winrm":
      return { level: "admin", operations: ["service-control", "eventlog"] };
    case "snmp":
      return { level: "read", operations: ["telemetry"] };
    case "docker":
      return { level: "admin", operations: ["container-control"] };
    case "kubernetes":
      return { level: "admin", operations: ["workload-control"] };
    case "http-api":
      return { level: "admin", operations: ["api", "config"] };
    default:
      return { level: "read", operations: ["observe"] };
  }
}

function findExistingCredential(
  credentials: DeviceCredential[],
  protocol: string,
  adapterId?: string,
): DeviceCredential | undefined {
  const normalizedAdapter = adapterId?.trim() || "";
  return credentials.find((credential) => (
    credential.protocol === protocol &&
    (credential.adapterId?.trim() || "") === normalizedAdapter
  ));
}

function protocolLooksReachable(device: Device, protocol: string): boolean {
  const hasPort = (port: number): boolean => device.services.some((service) => service.port === port);
  if (device.protocols.includes(protocol)) {
    return true;
  }

  switch (protocol) {
    case "ssh":
      return hasPort(22) || hasPort(2222);
    case "winrm":
      return hasPort(5985) || hasPort(5986);
    case "snmp":
      return hasPort(161);
    case "http-api":
      return hasPort(80) || hasPort(443) || hasPort(8080) || hasPort(8443);
    case "docker":
      return hasPort(2375) || hasPort(2376);
    case "kubernetes":
      return hasPort(6443);
    default:
      return true;
  }
}

function credentialMeetsProtocolRequirements(credential: DeviceCredential): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const accountLabel = credential.accountLabel?.trim() ?? "";
  const scope = credential.scopeJson ?? {};
  const operations = Array.isArray(scope.operations)
    ? scope.operations.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if ((credential.protocol === "ssh" || credential.protocol === "winrm") && accountLabel.length === 0) {
    reasons.push("account_label_required");
  }

  if ((credential.protocol === "docker" || credential.protocol === "kubernetes") && operations.length === 0) {
    reasons.push("scope_operations_required");
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

interface ProtocolValidationResult {
  valid: boolean;
  method: string;
  details: Record<string, unknown>;
}

function clampText(value: string, maxChars = 400): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function scopeString(scope: Record<string, unknown>, key: string): string | undefined {
  const value = scope[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function scopeBoolean(scope: Record<string, unknown>, key: string): boolean | undefined {
  const value = scope[key];
  return typeof value === "boolean" ? value : undefined;
}

function scopeNumber(scope: Record<string, unknown>, key: string): number | undefined {
  const value = Number(scope[key]);
  return Number.isFinite(value) ? value : undefined;
}

function scopeNumberArray(scope: Record<string, unknown>, key: string): number[] {
  const raw = scope[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65536);
}

function scopeStringArray(scope: Record<string, unknown>, key: string): string[] {
  const raw = scope[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function encodePowerShellScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function validateSshCredential(
  device: Device,
  credential: DeviceCredential,
  secret: string,
): Promise<ProtocolValidationResult> {
  const username = credential.accountLabel?.trim();
  if (!username) {
    return {
      valid: false,
      method: "ssh.exec",
      details: {
        reason: "account_label_required",
      },
    };
  }

  const host = `${username}@${device.ip}`;
  const result = process.platform === "win32"
    ? await runCommand("plink", ["-batch", "-ssh", host, "-pw", secret, "true"], 10_000)
    : await runCommand(
      "sshpass",
      [
        "-p",
        secret,
        "ssh",
        "-o",
        "BatchMode=no",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "ConnectTimeout=5",
        host,
        "true",
      ],
      10_000,
    );

  return {
    valid: result.ok,
    method: process.platform === "win32" ? "plink-ssh" : "sshpass-ssh",
    details: {
      exitCode: result.code,
      stdout: clampText(result.stdout),
      stderr: clampText(result.stderr),
    },
  };
}

async function validateWinrmCredential(
  device: Device,
  credential: DeviceCredential,
  secret: string,
): Promise<ProtocolValidationResult> {
  const username = credential.accountLabel?.trim();
  if (!username) {
    return {
      valid: false,
      method: "winrm.powershell",
      details: {
        reason: "account_label_required",
      },
    };
  }

  const scope = credential.scopeJson ?? {};
  const connection = resolveWinrmConnection(device, {
    port: scopeNumber(scope, "port"),
    useSsl: scopeBoolean(scope, "useSsl"),
    skipCertChecks: scopeBoolean(scope, "skipCertChecks") ?? scopeBoolean(scope, "insecureSkipVerify"),
    authentication: scopeString(scope, "authentication"),
  });

  if (!connection.ok) {
    return {
      valid: false,
      method: "winrm.powershell",
      details: {
        reason: "unsupported_host_runtime_or_transport",
        ...connection.details,
      },
    };
  }

  const runtime = await resolvePowerShellRuntime();
  if (!runtime.available || !runtime.executable) {
    return {
      valid: false,
      method: "winrm.powershell",
      details: {
        reason: "powershell_runtime_missing",
        hostPlatform: process.platform,
        triedExecutables: runtime.tried,
        runtimeError: runtime.error ?? null,
        installHint: powerShellInstallHint(process.platform),
      },
    };
  }

  const validateCommand = scopeString(scope, "validateCommand")
    ?? "$PSVersionTable.PSVersion.ToString()";
  const expectedRegex = scopeString(scope, "expectedOutputRegex") ?? scopeString(scope, "expectedBodyRegex");
  const script = buildWinrmPowerShellScript({
    host: device.ip,
    username,
    password: secret,
    command: validateCommand,
    connection: connection.value,
  });

  const result = await runCommand(
    runtime.executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(script)],
    12_000,
  );
  const output = `${result.stdout}${result.stderr ? `\n[stderr] ${result.stderr}` : ""}`.trim();
  const expectedMatched = expectedRegex
    ? new RegExp(expectedRegex, "i").test(result.stdout)
    : true;

  return {
    valid: result.ok && expectedMatched,
    method: "winrm.powershell",
    details: {
      executable: runtime.executable,
      powerShellVersion: runtime.version ?? null,
      port: connection.value.port,
      useSsl: connection.value.useSsl,
      skipCertChecks: connection.value.skipCertChecks,
      authentication: connection.value.authentication,
      expectedMatched,
      expectedRegex: expectedRegex ?? null,
      exitCode: result.code,
      stdout: clampText(result.stdout),
      stderr: clampText(result.stderr),
      output: clampText(output),
    },
  };
}

function httpCandidateUrls(device: Device, credential: DeviceCredential): URL[] {
  const scope = credential.scopeJson ?? {};
  const explicitPort = scopeNumber(scope, "port");
  const explicitPorts = scopeNumberArray(scope, "ports");
  const explicitPath = scopeString(scope, "validatePath") ?? "/";
  const explicitScheme = scopeString(scope, "scheme");
  const explicitSchemes = scopeStringArray(scope, "schemes")
    .filter((value): value is "http" | "https" => value === "http" || value === "https");
  const candidates: Array<{ scheme: "http" | "https"; port?: number }> = [];

  const pushCandidate = (scheme: "http" | "https", port?: number) => {
    candidates.push({ scheme, port });
  };

  if (explicitPort) {
    if (explicitSchemes.length > 0) {
      explicitSchemes.forEach((scheme) => pushCandidate(scheme, explicitPort));
    } else if (explicitScheme === "http" || explicitScheme === "https") {
      pushCandidate(explicitScheme, explicitPort);
    } else {
      pushCandidate(explicitPort === 443 || explicitPort === 8443 || explicitPort === 5001 ? "https" : "http", explicitPort);
      pushCandidate(explicitPort === 443 || explicitPort === 8443 || explicitPort === 5001 ? "http" : "https", explicitPort);
    }
  }

  explicitPorts.forEach((port) => {
    if (explicitSchemes.length > 0) {
      explicitSchemes.forEach((scheme) => pushCandidate(scheme, port));
    } else {
      pushCandidate(port === 443 || port === 8443 || port === 5001 ? "https" : "http", port);
    }
  });

  for (const service of device.services) {
    const looksHttp = Boolean(service.httpInfo || service.tlsCert || /http|https|web|api/i.test(service.name));
    if (!looksHttp) continue;
    pushCandidate(service.secure ? "https" : "http", service.port);
  }

  if (candidates.length === 0) {
    pushCandidate("https", 443);
    pushCandidate("http", 80);
  }

  const deduped = new Set<string>();
  const urls: URL[] = [];
  for (const candidate of candidates) {
    const url = new URL(`${candidate.scheme}://${device.ip}${candidate.port ? `:${candidate.port}` : ""}${explicitPath}`);
    const key = url.toString();
    if (deduped.has(key)) continue;
    deduped.add(key);
    urls.push(url);
  }
  return urls.slice(0, 6);
}

async function validateHttpCredential(
  device: Device,
  credential: DeviceCredential,
  secret: string,
): Promise<ProtocolValidationResult> {
  const scope = credential.scopeJson ?? {};
  const urls = httpCandidateUrls(device, credential);
  const insecureSkipVerify = scopeBoolean(scope, "insecureSkipVerify") ?? true;
  const expectedRegex = scopeString(scope, "expectedBodyRegex");
  const allowPublicValidation = scopeBoolean(scope, "allowPublicValidation") ?? false;
  const timeoutMs = Math.max(2_000, Math.min(15_000, Math.floor(scopeNumber(scope, "validateTimeoutMs") ?? 8_000)));
  const configuredMode = scopeString(scope, "authMode");
  const authMode = configuredMode === "none" || configuredMode === "basic" || configuredMode === "bearer" || configuredMode === "header"
    ? configuredMode
    : (credential.accountLabel?.trim() ? "basic" : "bearer");

  const baseHeaders: Record<string, string> = {
    Accept: "*/*",
  };

  const authHeaders: Record<string, string> = { ...baseHeaders };
  if (authMode === "basic") {
    if (!credential.accountLabel?.trim()) {
      return {
        valid: false,
        method: "http.fetch",
        details: {
          reason: "account_label_required_for_basic_auth",
        },
      };
    }
    authHeaders.Authorization = `Basic ${Buffer.from(`${credential.accountLabel.trim()}:${secret}`).toString("base64")}`;
  } else if (authMode === "bearer") {
    const prefix = scopeString(scope, "tokenPrefix") ?? "Bearer";
    authHeaders.Authorization = `${prefix} ${secret}`;
  } else if (authMode === "header") {
    const headerName = scopeString(scope, "headerName");
    if (!headerName) {
      return {
        valid: false,
        method: "http.fetch",
        details: {
          reason: "header_name_required_for_header_auth",
        },
      };
    }
    const prefix = scopeString(scope, "headerPrefix");
    authHeaders[headerName] = prefix ? `${prefix}${secret}` : secret;
  }

  const attempts: Array<Record<string, unknown>> = [];
  for (const url of urls) {
    const unauth = authMode === "none"
      ? undefined
      : await requestText(url, {
        method: "GET",
        headers: baseHeaders,
        insecureSkipVerify,
        timeoutMs,
      });

    const auth = await requestText(url, {
      method: "GET",
      headers: authHeaders,
      insecureSkipVerify,
      timeoutMs,
    });

    const expectedMatched = expectedRegex
      ? new RegExp(expectedRegex, "i").test(auth.body)
      : true;
    const statusDiffered = unauth ? unauth.statusCode !== auth.statusCode : false;
    const bodyDiffered = unauth ? unauth.body !== auth.body : false;
    const authProven = authMode === "none"
      ? auth.ok
      : allowPublicValidation || !unauth?.ok || statusDiffered || bodyDiffered;
    const valid = auth.ok && expectedMatched && authProven;

    attempts.push({
      url: url.toString(),
      unauthStatus: unauth?.statusCode ?? null,
      authStatus: auth.statusCode,
      unauthError: unauth?.error ?? null,
      authError: auth.error ?? null,
      statusDiffered,
      bodyDiffered,
      expectedMatched,
      authProven,
    });

    if (valid) {
      return {
        valid: true,
        method: "http.fetch",
        details: {
          authMode,
          url: url.toString(),
          statusCode: auth.statusCode,
          expectedMatched,
          attempts,
        },
      };
    }
  }

  return {
    valid: false,
    method: "http.fetch",
    details: {
      authMode,
      attempts,
      reason: "no_authenticated_http_endpoint_validated",
    },
  };
}

async function validateCredentialByProtocol(
  device: Device,
  credential: DeviceCredential,
  secret: string,
): Promise<ProtocolValidationResult | null> {
  switch (credential.protocol) {
    case "ssh":
      return validateSshCredential(device, credential, secret);
    case "winrm":
      return validateWinrmCredential(device, credential, secret);
    case "http-api":
      return validateHttpCredential(device, credential, secret);
    default:
      return null;
  }
}

export async function storeDeviceCredential(input: StoreDeviceCredentialInput): Promise<DeviceCredential> {
  if (!input.secret || input.secret.trim().length === 0) {
    throw new Error("Credential secret is required");
  }

  const device = stateStore.getDeviceById(input.deviceId);
  if (!device) {
    throw new Error("Device not found");
  }

  const protocol = normalizeProtocol(input.protocol);
  const now = nowIso();
  const existing = findExistingCredential(stateStore.getDeviceCredentials(input.deviceId), protocol, input.adapterId);
  const credentialId = existing?.id ?? randomUUID();
  const vaultSecretRef = existing?.vaultSecretRef ?? `device.${input.deviceId}.credential.${credentialId}`;

  const unlocked = await vault.ensureUnlocked();
  if (!unlocked) {
    throw new Error("Vault is unavailable");
  }
  await vault.setSecret(vaultSecretRef, input.secret);

  const credential: DeviceCredential = {
    id: credentialId,
    deviceId: input.deviceId,
    protocol,
    adapterId: input.adapterId?.trim() || undefined,
    vaultSecretRef,
    accountLabel: input.accountLabel?.trim() || undefined,
    scopeJson: input.scopeJson ?? defaultScope(protocol),
    status: "provided",
    lastValidatedAt: existing?.lastValidatedAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  stateStore.upsertDeviceCredential(credential);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Stored credential for ${device.name} (${protocol})`,
    context: {
      deviceId: device.id,
      credentialId: credential.id,
      protocol,
      adapterId: credential.adapterId,
    },
  });

  return credential;
}

export async function validateDeviceCredential(
  deviceId: string,
  credentialId: string,
): Promise<DeviceCredential> {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    throw new Error("Device not found");
  }

  const credential = stateStore.getDeviceCredentialById(credentialId);
  if (!credential || credential.deviceId !== deviceId) {
    throw new Error("Credential not found");
  }

  const secret = await vault.getSecret(credential.vaultSecretRef);
  const hasSecret = typeof secret === "string" && secret.length > 0;
  const reachable = protocolLooksReachable(device, credential.protocol);
  const requirements = credentialMeetsProtocolRequirements(credential);
  const validation = hasSecret && requirements.ok
    ? await validateCredentialByProtocol(device, credential, secret)
    : null;
  const valid = hasSecret && requirements.ok && (validation ? validation.valid : reachable);
  const validatedAt = nowIso();

  const updated: DeviceCredential = {
    ...credential,
    status: valid ? "validated" : "invalid",
    lastValidatedAt: validatedAt,
    updatedAt: validatedAt,
  };
  stateStore.upsertDeviceCredential(updated);

  await stateStore.addAction({
    actor: "steward",
    kind: "diagnose",
    message: `${valid ? "Validated" : "Invalidated"} credential ${credential.id} for ${device.name}`,
    context: {
      deviceId: device.id,
      credentialId: credential.id,
      protocol: credential.protocol,
      hasSecret,
      reachable,
      protocolChecksPassed: requirements.ok,
      protocolCheckFailures: requirements.reasons,
      validationMethod: validation?.method ?? "reachability-fallback",
      validationDetails: validation?.details ?? null,
      status: updated.status,
    },
  });

  return updated;
}

export async function updateDeviceCredential(input: UpdateDeviceCredentialInput): Promise<DeviceCredential> {
  const device = stateStore.getDeviceById(input.deviceId);
  if (!device) {
    throw new Error("Device not found");
  }

  const existing = stateStore.getDeviceCredentialById(input.credentialId);
  if (!existing || existing.deviceId !== input.deviceId) {
    throw new Error("Credential not found");
  }

  const nextProtocol = input.protocol ? normalizeProtocol(input.protocol) : existing.protocol;
  if (input.secret && input.secret.trim().length > 0) {
    const unlocked = await vault.ensureUnlocked();
    if (!unlocked) {
      throw new Error("Vault is unavailable");
    }
    await vault.setSecret(existing.vaultSecretRef, input.secret);
  }

  const updated: DeviceCredential = {
    ...existing,
    protocol: nextProtocol,
    accountLabel: input.accountLabel?.trim() || undefined,
    scopeJson: existing.scopeJson ?? defaultScope(nextProtocol),
    status: "provided",
    updatedAt: nowIso(),
  };

  stateStore.upsertDeviceCredential(updated);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Updated credential ${updated.id} for ${device.name}`,
    context: {
      deviceId: device.id,
      credentialId: updated.id,
      protocol: updated.protocol,
    },
  });

  return updated;
}

export async function deleteDeviceCredential(deviceId: string, credentialId: string): Promise<void> {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    throw new Error("Device not found");
  }

  const credential = stateStore.getDeviceCredentialById(credentialId);
  if (!credential || credential.deviceId !== deviceId) {
    throw new Error("Credential not found");
  }

  await vault.deleteSecret(credential.vaultSecretRef);
  stateStore.deleteDeviceCredential(credentialId);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Deleted credential ${credential.id} for ${device.name}`,
    context: {
      deviceId: device.id,
      credentialId: credential.id,
      protocol: credential.protocol,
    },
  });
}

export function redactDeviceCredential(credential: DeviceCredential): Omit<DeviceCredential, "vaultSecretRef"> {
  const { vaultSecretRef, ...rest } = credential;
  void vaultSecretRef;
  return rest;
}
