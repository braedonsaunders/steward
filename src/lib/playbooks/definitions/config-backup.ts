import type { PlaybookDefinition } from "@/lib/state/types";

export const configBackupPlaybooks: PlaybookDefinition[] = [
  {
    id: "playbook:config-backup:ssh-show",
    family: "config-backup",
    name: "Backup network device configuration via SSH",
    description: "Connects to a network device via SSH and captures the running configuration.",
    actionClass: "A",
    blastRadius: "single-device",
    timeoutMs: 30_000,
    preconditions: {
      requiredProtocols: ["ssh"],
    },
    steps: [
      {
        id: "step:config:capture",
        label: "Capture running configuration",
        command: "ssh {{host}} 'show running-config' 2>/dev/null || ssh {{host}} 'cat /etc/network/interfaces /etc/hosts /etc/resolv.conf' 2>/dev/null || echo 'config-capture-unsupported'",
        protocol: "ssh",
        timeoutMs: 20_000,
      },
    ],
    verificationSteps: [
      {
        id: "verify:config:non-empty",
        label: "Verify config output is non-empty",
        command: "test -n '{{last_output}}' && echo 'OK' || echo 'EMPTY'",
        protocol: "ssh",
        timeoutMs: 5_000,
      },
    ],
    rollbackSteps: [],
  },
  {
    id: "playbook:config-backup:http-export",
    family: "config-backup",
    name: "Backup appliance configuration via HTTP API",
    description: "Exports configuration from an appliance with HTTP management API.",
    actionClass: "A",
    blastRadius: "single-device",
    timeoutMs: 30_000,
    preconditions: {
      requiredProtocols: ["http-api"],
    },
    steps: [
      {
        id: "step:config:http-export",
        label: "Export configuration via API",
        command: "curl -s -k https://{{host}}/api/config/export 2>/dev/null || curl -s -k http://{{host}}/api/config/export 2>/dev/null || echo 'api-export-unsupported'",
        protocol: "http-api",
        timeoutMs: 20_000,
      },
    ],
    verificationSteps: [
      {
        id: "verify:config:http-non-empty",
        label: "Verify export output is non-empty",
        command: "test -n '{{last_output}}' && echo 'OK' || echo 'EMPTY'",
        protocol: "http-api",
        timeoutMs: 5_000,
      },
    ],
    rollbackSteps: [],
  },
];
