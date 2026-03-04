import type { PlaybookDefinition } from "@/lib/state/types";

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
        command: "ssh {{host}} 'df -h / | tail -1'",
        protocol: "ssh",
        timeoutMs: 10_000,
      },
      {
        id: "step:disk:clean-tmp",
        label: "Clean /tmp files older than 7 days",
        command: "ssh {{host}} 'sudo find /tmp -type f -atime +7 -delete 2>/dev/null; echo done'",
        protocol: "ssh",
        timeoutMs: 15_000,
      },
      {
        id: "step:disk:rotate-logs",
        label: "Force log rotation",
        command: "ssh {{host}} 'sudo logrotate -f /etc/logrotate.conf 2>/dev/null; echo done'",
        protocol: "ssh",
        timeoutMs: 15_000,
      },
      {
        id: "step:disk:journal-vacuum",
        label: "Vacuum systemd journal to 100M",
        command: "ssh {{host}} 'sudo journalctl --vacuum-size=100M 2>/dev/null; echo done'",
        protocol: "ssh",
        timeoutMs: 15_000,
      },
    ],
    verificationSteps: [
      {
        id: "verify:disk:usage-after",
        label: "Record disk usage after cleanup",
        command: "ssh {{host}} 'df -h / | tail -1'",
        protocol: "ssh",
        timeoutMs: 10_000,
      },
    ],
    rollbackSteps: [],
  },
];
