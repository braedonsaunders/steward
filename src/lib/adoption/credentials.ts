import { randomUUID } from "node:crypto";
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
      return hasPort(5985) || hasPort(5986) || hasPort(3389);
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
  const valid = hasSecret && reachable;

  const updated: DeviceCredential = {
    ...credential,
    status: valid ? "validated" : "invalid",
    lastValidatedAt: nowIso(),
    updatedAt: nowIso(),
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
      status: updated.status,
    },
  });

  return updated;
}

export function redactDeviceCredential(credential: DeviceCredential): Omit<DeviceCredential, "vaultSecretRef"> {
  const { vaultSecretRef, ...rest } = credential;
  void vaultSecretRef;
  return rest;
}
