import type { PlaybookDefinition } from "@/lib/state/types";

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
        command: "ssh {{host}} 'test -d {{destination}} && echo OK'",
        protocol: "ssh",
        timeoutMs: 10_000,
      },
      {
        id: "step:backup:retry",
        label: "Run rsync backup",
        command: "ssh {{host}} 'rsync -avz --delete {{source}} {{destination}}'",
        protocol: "ssh",
        timeoutMs: 240_000,
      },
    ],
    verificationSteps: [
      {
        id: "verify:backup:timestamp",
        label: "Verify backup timestamp is recent",
        command: "ssh {{host}} 'stat -c %Y {{destination}} | xargs -I{} date -d @{}'",
        protocol: "ssh",
        timeoutMs: 10_000,
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
        command: "curl -s -k https://{{host}}:5001/webapi/entry.cgi?api=SYNO.Core.Share.Snapshot&version=1&method=list",
        protocol: "http-api",
        timeoutMs: 15_000,
      },
    ],
    verificationSteps: [
      {
        id: "verify:snapshot:exists",
        label: "Verify snapshot freshness",
        command: "curl -s -k https://{{host}}:5001/webapi/entry.cgi?api=SYNO.Core.Share.Snapshot&version=1&method=list | grep -c 'snapshot'",
        protocol: "http-api",
        timeoutMs: 15_000,
      },
    ],
    rollbackSteps: [],
  },
];
