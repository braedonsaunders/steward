import { randomUUID } from "node:crypto";
import {
  type HttpApiCredentialAuthMode,
  requiresHttpApiAccountLabel,
  withHttpApiCredentialAuth,
} from "@/lib/credentials/http-api";
import { isSupportedCredentialProtocol, normalizeCredentialProtocol } from "@/lib/protocols/catalog";
import { stateStore } from "@/lib/state/store";
import { vault } from "@/lib/security/vault";
import type { DeviceCredential } from "@/lib/state/types";

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
  scopeJson?: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultScope(protocol: string): Record<string, unknown> {
  switch (protocol) {
    case "ssh":
      return { level: "admin", operations: ["shell", "service-control"] };
    case "telnet":
      return { level: "admin", operations: ["shell", "legacy-console"] };
    case "winrm":
      return { level: "admin", operations: ["service-control", "eventlog"] };
    case "powershell-ssh":
      return { level: "admin", operations: ["powershell", "shell", "service-control"] };
    case "wmi":
      return { level: "admin", operations: ["inventory", "process-control", "service-control"] };
    case "smb":
      return { level: "admin", operations: ["file-copy", "share-access", "artifact-collection"] };
    case "rdp":
      return { level: "operator", operations: ["interactive-remote-control", "session-launch"] };
    case "vnc":
      return { level: "operator", operations: ["interactive-remote-control", "session-launch"] };
    case "snmp":
      return { level: "read", operations: ["telemetry"] };
    case "docker":
      return { level: "admin", operations: ["container-control"] };
    case "kubernetes":
      return { level: "admin", operations: ["workload-control"] };
    case "http-api":
      return withHttpApiCredentialAuth({ level: "admin", operations: ["api", "config"] });
    case "mqtt":
      return { level: "operator", operations: ["telemetry", "message-publish", "message-subscribe"] };
    default:
      return { level: "read", operations: ["observe"] };
  }
}

function mergeCredentialScope(
  protocol: string,
  baseScope?: Record<string, unknown>,
  overrideScope?: Record<string, unknown>,
): Record<string, unknown> {
  const merged = {
    ...defaultScope(protocol),
    ...(baseScope ?? {}),
    ...(overrideScope ?? {}),
  };
  if (protocol !== "http-api") {
    return merged;
  }

  const authOverride = isRecord(overrideScope?.auth) ? overrideScope.auth : undefined;
  return withHttpApiCredentialAuth(merged, {
    ...(authOverride && typeof authOverride.mode === "string"
      ? { mode: authOverride.mode as HttpApiCredentialAuthMode }
      : {}),
    ...(authOverride && typeof authOverride.headerName === "string" ? { headerName: authOverride.headerName } : {}),
    ...(authOverride && typeof authOverride.queryParamName === "string" ? { queryParamName: authOverride.queryParamName } : {}),
    ...(authOverride && typeof authOverride.pathPrefix === "string" ? { pathPrefix: authOverride.pathPrefix } : {}),
  });
}

function findExistingCredential(
  credentials: DeviceCredential[],
  protocol: string,
  adapterId?: string,
): DeviceCredential | undefined {
  const normalizedAdapter = adapterId?.trim() || "";
  return credentials.find((credential) => (
    normalizeCredentialProtocol(credential.protocol) === protocol &&
    (credential.adapterId?.trim() || "") === normalizedAdapter
  ));
}

export async function storeDeviceCredential(input: StoreDeviceCredentialInput): Promise<DeviceCredential> {
  if (typeof input.secret !== "string") {
    throw new Error("Credential secret is required");
  }

  const device = stateStore.getDeviceById(input.deviceId);
  if (!device) {
    throw new Error("Device not found");
  }

  const protocol = normalizeCredentialProtocol(input.protocol);
  if (!isSupportedCredentialProtocol(protocol)) {
    throw new Error(`Unsupported credential protocol: ${input.protocol}`);
  }
  const scopeJson = mergeCredentialScope(protocol, undefined, input.scopeJson);
  const accountLabel = input.accountLabel?.trim() || undefined;
  if (protocol === "http-api" && requiresHttpApiAccountLabel(scopeJson) && !accountLabel) {
    throw new Error("HTTP Basic credentials require an accountLabel username.");
  }
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
    accountLabel,
    scopeJson,
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
  const hasSecret = typeof secret === "string";
  if (!hasSecret) {
    throw new Error("Stored credential secret is missing");
  }

  const updated: DeviceCredential = {
    ...credential,
    status: credential.status === "pending" ? "pending" : "provided",
    lastValidatedAt: undefined,
    updatedAt: nowIso(),
  };
  stateStore.upsertDeviceCredential(updated);

  await stateStore.addAction({
    actor: "steward",
    kind: "diagnose",
    message: `Recorded credential ${credential.id} as available for ${device.name}`,
    context: {
      deviceId: device.id,
      credentialId: credential.id,
      protocol: credential.protocol,
      hasSecret,
      trustModel: "manual-entry-assumed-valid",
      status: updated.status,
    },
  });

  return updated;
}

export async function markCredentialValidatedFromUse(input: {
  deviceId: string;
  credentialId: string;
  actor?: "steward" | "user";
  method: string;
  details?: Record<string, unknown>;
}): Promise<DeviceCredential | null> {
  const credential = stateStore.getDeviceCredentialById(input.credentialId);
  if (!credential || credential.deviceId !== input.deviceId) {
    return null;
  }
  const updated: DeviceCredential = {
    ...credential,
    status: "validated",
    lastValidatedAt: nowIso(),
    updatedAt: nowIso(),
  };
  stateStore.upsertDeviceCredential(updated);
  await stateStore.addAction({
    actor: input.actor ?? "steward",
    kind: "diagnose",
    message: `Validated credential ${credential.id} for ${input.deviceId} via ${input.method}`,
    context: {
      deviceId: input.deviceId,
      credentialId: credential.id,
      protocol: credential.protocol,
      method: input.method,
      ...(input.details ?? {}),
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

  const nextProtocol = input.protocol ? normalizeCredentialProtocol(input.protocol) : normalizeCredentialProtocol(existing.protocol);
  if (!isSupportedCredentialProtocol(nextProtocol)) {
    throw new Error(`Unsupported credential protocol: ${input.protocol}`);
  }
  const nextAccountLabel = input.accountLabel === undefined
    ? existing.accountLabel
    : input.accountLabel.trim() || undefined;
  const nextScope = mergeCredentialScope(nextProtocol, existing.scopeJson, input.scopeJson);
  if (nextProtocol === "http-api" && requiresHttpApiAccountLabel(nextScope) && !nextAccountLabel) {
    throw new Error("HTTP Basic credentials require an accountLabel username.");
  }
  if (input.secret !== undefined) {
    const unlocked = await vault.ensureUnlocked();
    if (!unlocked) {
      throw new Error("Vault is unavailable");
    }
    await vault.setSecret(existing.vaultSecretRef, input.secret);
  }

  const updated: DeviceCredential = {
    ...existing,
    protocol: nextProtocol,
    accountLabel: nextAccountLabel,
    scopeJson: nextScope,
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
  const protocol = normalizeCredentialProtocol(rest.protocol);
  return {
    ...rest,
    protocol,
    scopeJson: mergeCredentialScope(protocol, rest.scopeJson),
  };
}

