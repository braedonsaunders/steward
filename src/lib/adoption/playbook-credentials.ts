import { stateStore } from "@/lib/state/store";
import type { Device, PlaybookDefinition } from "@/lib/state/types";

function normalizeProtocol(protocol: string): string {
  const value = protocol.trim().toLowerCase();
  if (value === "windows") return "winrm";
  if (value === "http") return "http-api";
  if (value === "https") return "http-api";
  return value;
}

const CREDENTIAL_GATED_PROTOCOLS = new Set([
  "ssh",
  "winrm",
  "snmp",
  "http-api",
  "docker",
  "kubernetes",
  "mqtt",
]);

export function getMissingCredentialProtocolsForPlaybook(
  device: Device,
  playbook: Pick<PlaybookDefinition, "preconditions">,
): string[] {
  const required = new Set<string>();
  for (const protocol of playbook.preconditions.requiredProtocols) {
    const normalized = normalizeProtocol(protocol);
    if (CREDENTIAL_GATED_PROTOCOLS.has(normalized)) {
      required.add(normalized);
    }
  }

  if (required.size === 0) {
    return [];
  }

  const available = new Set(stateStore.getUsableCredentialProtocols(device.id).map(normalizeProtocol));
  const missing = Array.from(required).filter((protocol) => !available.has(protocol));
  return missing;
}
