import type { PlaybookDefinition } from "@/lib/state/types";

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
        command: "ssh {{host}} 'sudo cp -r /etc/letsencrypt/live/{{domain}} /etc/letsencrypt/live/{{domain}}.bak'",
        protocol: "ssh",
        timeoutMs: 10_000,
      },
      {
        id: "step:cert:renew",
        label: "Run certbot renewal",
        command: "ssh {{host}} 'sudo certbot renew --cert-name {{domain}} --non-interactive'",
        protocol: "ssh",
        timeoutMs: 60_000,
      },
      {
        id: "step:cert:reload",
        label: "Reload web server",
        command: "ssh {{host}} 'sudo systemctl reload nginx || sudo systemctl reload apache2 || true'",
        protocol: "ssh",
        timeoutMs: 10_000,
      },
    ],
    verificationSteps: [
      {
        id: "verify:cert:expiry",
        label: "Check new certificate expiry",
        command: "ssh {{host}} 'sudo certbot certificates --cert-name {{domain}} 2>/dev/null | grep Expiry'",
        protocol: "ssh",
        timeoutMs: 15_000,
      },
    ],
    rollbackSteps: [
      {
        id: "rollback:cert:restore",
        label: "Restore certificate backup",
        command: "ssh {{host}} 'sudo rm -rf /etc/letsencrypt/live/{{domain}} && sudo mv /etc/letsencrypt/live/{{domain}}.bak /etc/letsencrypt/live/{{domain}} && sudo systemctl reload nginx || sudo systemctl reload apache2 || true'",
        protocol: "ssh",
        timeoutMs: 15_000,
      },
    ],
  },
];
