import { stateStore } from "@/lib/state/store";
import { normalizeCredentialProtocol } from "@/lib/protocols/catalog";
import type { Device, PlaybookDefinition } from "@/lib/state/types";

const CREDENTIAL_GATED_PROTOCOLS = new Set([
  "ssh",
  "winrm",
  "powershell-ssh",
  "wmi",
  "smb",
  "rdp",
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
    const normalized = normalizeCredentialProtocol(protocol);
    if (CREDENTIAL_GATED_PROTOCOLS.has(normalized)) {
      required.add(normalized);
    }
  }

  if (required.size === 0) {
    return [];
  }

  const available = new Set(stateStore.getUsableCredentialProtocols(device.id).map(normalizeCredentialProtocol));
  const missing = Array.from(required).filter((protocol) => !available.has(protocol));
  return missing;
}
