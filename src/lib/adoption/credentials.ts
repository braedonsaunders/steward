import { randomUUID } from "node:crypto";
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
  if (!hasSecret) {
    throw new Error("Stored credential secret is missing");
  }
  const validatedAt = nowIso();

  const updated: DeviceCredential = {
    ...credential,
    status: "validated",
    lastValidatedAt: validatedAt,
    updatedAt: validatedAt,
  };
  stateStore.upsertDeviceCredential(updated);

  await stateStore.addAction({
    actor: "steward",
    kind: "diagnose",
    message: `Marked credential ${credential.id} as validated for ${device.name}`,
    context: {
      deviceId: device.id,
      credentialId: credential.id,
      protocol: credential.protocol,
      hasSecret,
      validationMethod: "manual-status-mark",
      validationDetails: {
        source: "user_or_agent_assertion",
        note: "No programmatic network verification was performed.",
      },
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

  const validatedAt = nowIso();
  const updated: DeviceCredential = {
    ...credential,
    status: "validated",
    lastValidatedAt: validatedAt,
    updatedAt: validatedAt,
  };
  stateStore.upsertDeviceCredential(updated);

  if (credential.status !== "validated") {
    const device = stateStore.getDeviceById(input.deviceId);
    await stateStore.addAction({
      actor: input.actor ?? "steward",
      kind: "diagnose",
      message: `Marked credential ${credential.id} as validated${device ? ` for ${device.name}` : ""}`,
      context: {
        deviceId: input.deviceId,
        credentialId: credential.id,
        protocol: credential.protocol,
        validationMethod: input.method,
        validationDetails: input.details ?? null,
        status: updated.status,
      },
    });
  }

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
