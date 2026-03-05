import type { PlaybookDefinition } from "@/lib/state/types";

const readSafety = {
  dryRunSupported: false,
  requiresConfirmedRevert: false,
  criticality: "medium" as const,
};

const mutateSafety = {
  dryRunSupported: false,
  requiresConfirmedRevert: false,
  criticality: "high" as const,
};

export const certRenewalPlaybooks: PlaybookDefinition[] = [
  {
    id: "playbook:cert-renewal:acme-http",
    family: "cert-renewal",
    name: "Renew TLS certificate via ACME HTTP-01",
    description: "Renews an expiring TLS certificate using certbot with HTTP-01 challenge, then reloads the web server.",
    actionClass: "C",
    blastRadius: "single-service",
    timeoutMs: 120_000,
    preconditions: {
      requiredProtocols: ["ssh"],
      healthChecks: ["certbot --version"],
    },
    steps: [
      {
        id: "step:cert:backup",
        label: "Backup current certificate",
        operation: {
          id: "op:cert:backup",
          adapterId: "ssh",
          kind: "file.copy",
          mode: "mutate",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'sudo cp -r /etc/letsencrypt/live/{{domain}} /etc/letsencrypt/live/{{domain}}.bak'",
          expectedSemanticTarget: "certificate:{{domain}}",
          safety: mutateSafety,
        },
      },
      {
        id: "step:cert:renew",
        label: "Run certbot renewal",
        operation: {
          id: "op:cert:renew",
          adapterId: "ssh",
          kind: "cert.renew",
          mode: "mutate",
          timeoutMs: 60_000,
          commandTemplate: "ssh {{host}} 'sudo certbot renew --cert-name {{domain}} --non-interactive'",
          expectedSemanticTarget: "certificate:{{domain}}",
          safety: mutateSafety,
        },
      },
      {
        id: "step:cert:reload",
        label: "Reload web server",
        operation: {
          id: "op:cert:web-reload",
          adapterId: "ssh",
          kind: "service.restart",
          mode: "mutate",
          timeoutMs: 10_000,
          commandTemplate: "ssh {{host}} 'sudo systemctl reload nginx || sudo systemctl reload apache2 || true'",
          expectedSemanticTarget: "service:web",
          safety: mutateSafety,
        },
      },
    ],
    verificationSteps: [
      {
        id: "verify:cert:expiry",
        label: "Check new certificate expiry",
        operation: {
          id: "op:cert:expiry-check",
          adapterId: "ssh",
          kind: "shell.command",
          mode: "read",
          timeoutMs: 15_000,
          commandTemplate: "ssh {{host}} 'sudo certbot certificates --cert-name {{domain}} 2>/dev/null | grep Expiry'",
          expectedSemanticTarget: "certificate:{{domain}}",
          safety: readSafety,
        },
      },
    ],
    rollbackSteps: [
      {
        id: "rollback:cert:restore",
        label: "Restore certificate backup",
        operation: {
          id: "op:cert:restore-backup",
          adapterId: "ssh",
          kind: "file.copy",
          mode: "mutate",
          timeoutMs: 15_000,
          commandTemplate: "ssh {{host}} 'sudo rm -rf /etc/letsencrypt/live/{{domain}} && sudo mv /etc/letsencrypt/live/{{domain}}.bak /etc/letsencrypt/live/{{domain}} && sudo systemctl reload nginx || sudo systemctl reload apache2 || true'",
          expectedSemanticTarget: "certificate:{{domain}}",
          safety: mutateSafety,
        },
      },
    ],
  },
];
