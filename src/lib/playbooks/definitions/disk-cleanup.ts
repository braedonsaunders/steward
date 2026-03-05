import type { PlaybookDefinition } from "@/lib/state/types";

const readSafety = {
  dryRunSupported: false,
  requiresConfirmedRevert: false,
  criticality: "low" as const,
};

const mutateSafety = {
  dryRunSupported: false,
  requiresConfirmedRevert: false,
  criticality: "medium" as const,
};

export const diskCleanupPlaybooks: PlaybookDefinition[] = [
  {
    id: "playbook:disk-cleanup:tmp",
    family: "disk-cleanup",
    name: "Clean temporary files and old logs",
    description: "Frees disk space by clearing /tmp, rotating logs, and vacuuming systemd journal.",
    actionClass: "B",
    blastRadius: "single-device",
    timeoutMs: 60_000,
    preconditions: {
      requiredProtocols: ["ssh"],
    },
    steps: [
      {
        id: "step:disk:snapshot-before",
        label: "Record disk usage before cleanup",
        operation: {
          id: "op:disk:usage-before",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'df -h / | tail -1'",
          expectedSemanticTarget: "filesystem:/",
          safety: readSafety,
        },
      },
      {
        id: "step:disk:clean-tmp",
        label: "Clean /tmp files older than 7 days",
        operation: {
          id: "op:disk:clean-tmp",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "mutate",
          timeoutMs: 15_000,
          commandTemplate: "ssh {{host}} 'sudo find /tmp -type f -atime +7 -delete 2>/dev/null; echo done'",
          expectedSemanticTarget: "filesystem:/tmp",
          safety: mutateSafety,
        },
      },
      {
        id: "step:disk:rotate-logs",
        label: "Force log rotation",
        operation: {
          id: "op:disk:rotate-logs",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "mutate",
          timeoutMs: 15_000,
          commandTemplate: "ssh {{host}} 'sudo logrotate -f /etc/logrotate.conf 2>/dev/null; echo done'",
          expectedSemanticTarget: "logs:system",
          safety: mutateSafety,
        },
      },
      {
        id: "step:disk:journal-vacuum",
        label: "Vacuum systemd journal to 100M",
        operation: {
          id: "op:disk:vacuum-journal",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "mutate",
          timeoutMs: 15_000,
          commandTemplate: "ssh {{host}} 'sudo journalctl --vacuum-size=100M 2>/dev/null; echo done'",
          expectedSemanticTarget: "logs:journal",
          safety: mutateSafety,
        },
      },
    ],
    verificationSteps: [
      {
        id: "verify:disk:usage-after",
        label: "Record disk usage after cleanup",
        operation: {
          id: "op:disk:usage-after",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'df -h / | tail -1'",
          expectedSemanticTarget: "filesystem:/",
          safety: readSafety,
        },
      },
    ],
    rollbackSteps: [],
  },
];
