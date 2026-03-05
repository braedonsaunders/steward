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

export const backupRetryPlaybooks: PlaybookDefinition[] = [
  {
    id: "playbook:backup-retry:rsync",
    family: "backup-retry",
    name: "Retry failed rsync backup",
    description: "Retries a failed rsync-based backup job and verifies the destination was updated.",
    actionClass: "B",
    blastRadius: "single-device",
    timeoutMs: 300_000,
    preconditions: {
      requiredProtocols: ["ssh"],
    },
    steps: [
      {
        id: "step:backup:pre-check",
        label: "Check destination is reachable",
        operation: {
          id: "op:backup:destination-check",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'test -d {{destination}} && echo OK'",
          expectedSemanticTarget: "path:{{destination}}",
          safety: readSafety,
        },
      },
      {
        id: "step:backup:retry",
        label: "Run rsync backup",
        operation: {
          id: "op:backup:rsync",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "mutate",
          timeoutMs: 240_000,
          commandTemplate: "ssh {{host}} 'rsync -avz --delete {{source}} {{destination}}'",
          expectedSemanticTarget: "path:{{destination}}",
          safety: mutateSafety,
        },
      },
    ],
    verificationSteps: [
      {
        id: "verify:backup:timestamp",
        label: "Verify backup timestamp is recent",
        operation: {
          id: "op:backup:timestamp",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'stat -c %Y {{destination}} | xargs -I{} date -d @{}'",
          expectedSemanticTarget: "path:{{destination}}",
          safety: readSafety,
        },
      },
    ],
    rollbackSteps: [],
  },
  {
    id: "playbook:backup-retry:nas-snapshot",
    family: "backup-retry",
    name: "Trigger NAS snapshot verification",
    description: "Verifies that the latest NAS snapshot exists and is consistent.",
    actionClass: "A",
    blastRadius: "single-device",
    timeoutMs: 60_000,
    preconditions: {
      requiredProtocols: ["http-api"],
    },
    steps: [
      {
        id: "step:snapshot:list",
        label: "List recent snapshots",
        operation: {
          id: "op:snapshot:list",
          adapterId: "http-api",
          kind: "http.request",
          mode: "read",
          timeoutMs: 15_000,
          commandTemplate: "curl -s -k https://{{host}}:5001/webapi/entry.cgi?api=SYNO.Core.Share.Snapshot&version=1&method=list",
          expectedSemanticTarget: "snapshot:list",
          safety: readSafety,
        },
      },
    ],
    verificationSteps: [
      {
        id: "verify:snapshot:exists",
        label: "Verify snapshot freshness",
        operation: {
          id: "op:snapshot:freshness-check",
          adapterId: "http-api",
          kind: "http.request",
          mode: "read",
          timeoutMs: 15_000,
          commandTemplate: "curl -s -k https://{{host}}:5001/webapi/entry.cgi?api=SYNO.Core.Share.Snapshot&version=1&method=list | grep -c 'snapshot'",
          expectedSemanticTarget: "snapshot:list",
          safety: readSafety,
        },
      },
    ],
    rollbackSteps: [],
  },
];
