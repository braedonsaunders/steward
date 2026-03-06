import type { PlaybookDefinition } from "@/lib/state/types";
import { httpBrokerRequest, sshShellBrokerRequest } from "@/lib/playbooks/brokers";

const readSafety = {
  dryRunSupported: false,
  requiresConfirmedRevert: false,
  criticality: "low" as const,
};

const networkMutationSafety = {
  dryRunSupported: false,
  requiresConfirmedRevert: true,
  revertMechanism: "commit-confirmed" as const,
  criticality: "high" as const,
};

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
        operation: {
          id: "op:config:capture-ssh",
          adapterId: "network-ssh",
          kind: "network.config",
          mode: "read",
          timeoutMs: 20_000,
          brokerRequest: sshShellBrokerRequest(
            "show running-config 2>/dev/null || cat /etc/network/interfaces /etc/hosts /etc/resolv.conf 2>/dev/null || echo 'config-capture-unsupported'",
          ),
          commandTemplate:
            "ssh {{host}} 'show running-config' 2>/dev/null || ssh {{host}} 'cat /etc/network/interfaces /etc/hosts /etc/resolv.conf' 2>/dev/null || echo 'config-capture-unsupported'",
          expectedSemanticTarget: "config:running",
          safety: networkMutationSafety,
        },
      },
    ],
    verificationSteps: [
      {
        id: "verify:config:non-empty",
        label: "Verify config output is non-empty",
        operation: {
          id: "op:config:non-empty-check",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 5_000,
          commandTemplate: "test -n '{{last_output}}' && echo 'OK' || echo 'EMPTY'",
          expectedSemanticTarget: "config:running",
          safety: readSafety,
        },
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
        operation: {
          id: "op:config:http-export",
          adapterId: "http-api",
          kind: "http.request",
          mode: "read",
          timeoutMs: 20_000,
          brokerRequest: httpBrokerRequest({
            method: "GET",
            schemes: ["https", "http"],
            path: "/api/config/export",
            insecureSkipVerify: true,
          }),
          commandTemplate:
            "curl -s -k https://{{host}}/api/config/export 2>/dev/null || curl -s -k http://{{host}}/api/config/export 2>/dev/null || echo 'api-export-unsupported'",
          expectedSemanticTarget: "config:export",
          safety: readSafety,
        },
      },
    ],
    verificationSteps: [
      {
        id: "verify:config:http-non-empty",
        label: "Verify export output is non-empty",
        operation: {
          id: "op:config:http-non-empty-check",
          adapterId: "http-api",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 5_000,
          commandTemplate: "test -n '{{last_output}}' && echo 'OK' || echo 'EMPTY'",
          expectedSemanticTarget: "config:export",
          safety: readSafety,
        },
      },
    ],
    rollbackSteps: [],
  },
];
