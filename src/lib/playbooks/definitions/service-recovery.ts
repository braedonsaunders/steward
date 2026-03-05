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

export const serviceRecoveryPlaybooks: PlaybookDefinition[] = [
  {
    id: "playbook:service-recovery:systemd",
    family: "service-recovery",
    name: "Restart failed systemd service",
    description: "Detects a failed systemd service and restarts it, verifying it returns to active state.",
    actionClass: "B",
    blastRadius: "single-service",
    timeoutMs: 30_000,
    preconditions: {
      requiredProtocols: ["ssh"],
      healthChecks: ["systemctl is-system-running"],
    },
    steps: [
      {
        id: "step:systemd:restart",
        label: "Restart the service",
        operation: {
          id: "op:systemd:restart",
          adapterId: "ssh",
          kind: "service.restart",
          mode: "mutate",
          timeoutMs: 15_000,
          commandTemplate: "ssh {{host}} 'sudo systemctl restart {{service}}'",
          expectedSemanticTarget: "service:{{service}}",
          safety: mutateSafety,
        },
      },
    ],
    verificationSteps: [
      {
        id: "verify:systemd:active",
        label: "Verify service is active",
        operation: {
          id: "op:systemd:active-check",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'systemctl is-active {{service}}'",
          expectedSemanticTarget: "service:{{service}}",
          safety: readSafety,
        },
      },
    ],
    rollbackSteps: [
      {
        id: "rollback:systemd:stop",
        label: "Stop the service if restart caused issues",
        operation: {
          id: "op:systemd:stop",
          adapterId: "ssh",
          kind: "service.stop",
          mode: "mutate",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'sudo systemctl stop {{service}}'",
          expectedSemanticTarget: "service:{{service}}",
          safety: mutateSafety,
        },
      },
    ],
  },
  {
    id: "playbook:service-recovery:docker",
    family: "service-recovery",
    name: "Restart stopped Docker container",
    description: "Restarts a stopped or exited Docker container and verifies it reaches running state.",
    actionClass: "B",
    blastRadius: "single-service",
    timeoutMs: 30_000,
    preconditions: {
      requiredProtocols: ["docker"],
      healthChecks: ["docker info"],
    },
    steps: [
      {
        id: "step:docker:restart",
        label: "Restart the container",
        operation: {
          id: "op:docker:restart",
          adapterId: "docker",
          kind: "container.restart",
          mode: "mutate",
          timeoutMs: 20_000,
          commandTemplate: "ssh {{host}} 'docker restart {{container}}'",
          expectedSemanticTarget: "container:{{container}}",
          safety: mutateSafety,
        },
      },
    ],
    verificationSteps: [
      {
        id: "verify:docker:running",
        label: "Verify container is running",
        operation: {
          id: "op:docker:running-check",
          adapterId: "docker",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'docker inspect -f {{\"{{.State.Running}}\"}} {{container}}'",
          expectedSemanticTarget: "container:{{container}}",
          safety: readSafety,
        },
      },
    ],
    rollbackSteps: [
      {
        id: "rollback:docker:stop",
        label: "Stop the container",
        operation: {
          id: "op:docker:stop",
          adapterId: "docker",
          kind: "container.stop",
          mode: "mutate",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'docker stop {{container}}'",
          expectedSemanticTarget: "container:{{container}}",
          safety: mutateSafety,
        },
      },
    ],
  },
  {
    id: "playbook:service-recovery:windows",
    family: "service-recovery",
    name: "Restart stopped Windows service",
    description: "Restarts a stopped Windows service and verifies it enters Running state.",
    actionClass: "B",
    blastRadius: "single-service",
    timeoutMs: 30_000,
    preconditions: {
      requiredProtocols: ["winrm"],
    },
    steps: [
      {
        id: "step:win:restart",
        label: "Restart the service",
        operation: {
          id: "op:windows:service-restart",
          adapterId: "winrm",
          kind: "service.restart",
          mode: "mutate",
          timeoutMs: 20_000,
          commandTemplate: "Invoke-Command -ComputerName {{host}} -ScriptBlock { Restart-Service -Name '{{service}}' -Force }",
          expectedSemanticTarget: "service:{{service}}",
          safety: mutateSafety,
        },
      },
    ],
    verificationSteps: [
      {
        id: "verify:win:running",
        label: "Verify service is running",
        operation: {
          id: "op:windows:service-running-check",
          adapterId: "winrm",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 10_000,
          commandTemplate: "Invoke-Command -ComputerName {{host}} -ScriptBlock { (Get-Service -Name '{{service}}').Status }",
          expectedSemanticTarget: "service:{{service}}",
          safety: readSafety,
        },
      },
    ],
    rollbackSteps: [
      {
        id: "rollback:win:stop",
        label: "Stop the service",
        operation: {
          id: "op:windows:service-stop",
          adapterId: "winrm",
          kind: "service.stop",
          mode: "mutate",
          timeoutMs: 10_000,
          commandTemplate: "Invoke-Command -ComputerName {{host}} -ScriptBlock { Stop-Service -Name '{{service}}' -Force }",
          expectedSemanticTarget: "service:{{service}}",
          safety: mutateSafety,
        },
      },
    ],
  },
];
