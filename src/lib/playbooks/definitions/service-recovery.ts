import type { PlaybookDefinition } from "@/lib/state/types";

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
        command: "ssh {{host}} 'sudo systemctl restart {{service}}'",
        protocol: "ssh",
        timeoutMs: 15_000,
      },
    ],
    verificationSteps: [
      {
        id: "verify:systemd:active",
        label: "Verify service is active",
        command: "ssh {{host}} 'systemctl is-active {{service}}'",
        protocol: "ssh",
        timeoutMs: 10_000,
      },
    ],
    rollbackSteps: [
      {
        id: "rollback:systemd:stop",
        label: "Stop the service if restart caused issues",
        command: "ssh {{host}} 'sudo systemctl stop {{service}}'",
        protocol: "ssh",
        timeoutMs: 10_000,
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
        command: "ssh {{host}} 'docker restart {{container}}'",
        protocol: "docker",
        timeoutMs: 20_000,
      },
    ],
    verificationSteps: [
      {
        id: "verify:docker:running",
        label: "Verify container is running",
        command: "ssh {{host}} 'docker inspect -f {{\"{{.State.Running}}\"}} {{container}}'",
        protocol: "docker",
        timeoutMs: 10_000,
      },
    ],
    rollbackSteps: [
      {
        id: "rollback:docker:stop",
        label: "Stop the container",
        command: "ssh {{host}} 'docker stop {{container}}'",
        protocol: "docker",
        timeoutMs: 10_000,
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
        command: "Invoke-Command -ComputerName {{host}} -ScriptBlock { Restart-Service -Name '{{service}}' -Force }",
        protocol: "winrm",
        timeoutMs: 20_000,
      },
    ],
    verificationSteps: [
      {
        id: "verify:win:running",
        label: "Verify service is running",
        command: "Invoke-Command -ComputerName {{host}} -ScriptBlock { (Get-Service -Name '{{service}}').Status }",
        protocol: "winrm",
        timeoutMs: 10_000,
      },
    ],
    rollbackSteps: [
      {
        id: "rollback:win:stop",
        label: "Stop the service",
        command: "Invoke-Command -ComputerName {{host}} -ScriptBlock { Stop-Service -Name '{{service}}' -Force }",
        protocol: "winrm",
        timeoutMs: 10_000,
      },
    ],
  },
];
