import type { Device, PlaybookDefinition } from "@/lib/state/types";
import { adapterRegistry } from "@/lib/adapters/registry";
import { serviceRecoveryPlaybooks } from "@/lib/playbooks/definitions/service-recovery";
import { certRenewalPlaybooks } from "@/lib/playbooks/definitions/cert-renewal";
import { backupRetryPlaybooks } from "@/lib/playbooks/definitions/backup-retry";
import { diskCleanupPlaybooks } from "@/lib/playbooks/definitions/disk-cleanup";
import { configBackupPlaybooks } from "@/lib/playbooks/definitions/config-backup";

const BUILTIN_PLAYBOOKS: PlaybookDefinition[] = [
  ...serviceRecoveryPlaybooks,
  ...certRenewalPlaybooks,
  ...backupRetryPlaybooks,
  ...diskCleanupPlaybooks,
  ...configBackupPlaybooks,
];

function getAllPlaybooks(): PlaybookDefinition[] {
  return [...BUILTIN_PLAYBOOKS, ...adapterRegistry.getAdapterPlaybooks()];
}

export function getPlaybookDefinitions(): PlaybookDefinition[] {
  return getAllPlaybooks();
}

export function getPlaybookById(id: string): PlaybookDefinition | undefined {
  return getAllPlaybooks().find((p) => p.id === id);
}

/**
 * Returns playbook definitions whose preconditions are satisfiable by the
 * device's known protocols. The caller still needs to verify credentials
 * exist before actually executing.
 */
export function matchPlaybooksForDevice(device: Device): PlaybookDefinition[] {
  const deviceProtocols = new Set(device.protocols ?? []);

  return getAllPlaybooks().filter((playbook) => {
    return playbook.preconditions.requiredProtocols.every((proto) => deviceProtocols.has(proto));
  });
}

/**
 * Given an incident, infer which playbook family (if any) is relevant.
 * Returns all matching playbooks for the device.
 */
export function matchPlaybooksForIncident(
  incidentTitle: string,
  incidentMetadata: Record<string, unknown>,
  device: Device,
): PlaybookDefinition[] {
  const available = matchPlaybooksForDevice(device);
  const title = incidentTitle.toLowerCase();
  const key = String(incidentMetadata.key ?? "").toLowerCase();

  return available.filter((playbook) => {
    switch (playbook.family) {
      case "service-recovery":
        return title.includes("offline") || title.includes("service") || title.includes("down") || key.startsWith("offline:");
      case "disk-cleanup":
        return title.includes("disk") || title.includes("storage") || title.includes("full");
      case "cert-renewal":
        return title.includes("cert") || title.includes("tls") || title.includes("ssl") || title.includes("expir");
      case "backup-retry":
        return title.includes("backup") || title.includes("replication");
      case "config-backup":
        return title.includes("config") || title.includes("drift");
      default:
        // Adapter playbooks with custom families use matchesIncident.
        if (playbook.matchesIncident) {
          return playbook.matchesIncident(title, incidentMetadata);
        }
        return false;
    }
  });
}
