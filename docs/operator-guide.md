# Operator Guide

## Quickstart

### Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3010`.

### Docker

```bash
docker compose up --build
```

This starts:

- Steward
- `guacd` for remote desktop sessions
- persistent local state under `./.steward`

## First 30 minutes

1. Open `/access` and create the first operator account.
2. Configure at least one model provider in the UI.
3. Unlock or initialize the vault.
4. Run discovery from the UI or `POST /api/agent/run`.
5. Review discovered devices and provide credentials only for systems Steward should manage.
6. Set runtime policy, autonomy defaults, and maintenance windows.
7. Review the inbox, findings, and approvals.

## Daily operations

- Check the inbox for critical incidents, approvals, and recommendations.
- Review device findings and timelines before approving mutation work.
- Use chat for questions like "what changed", "why was this slow", or "show open approvals".
- Review daily digests and mission briefings for backlog and risk.

## Approvals and autonomy

Steward supports:

- observe-only devices
- safe auto-remediation
- policy-gated medium and high risk actions

Approved actions become durable playbook runs and execute through the control plane queue. Every run records status, evidence, and audit history.

## Runtime validation

Run before merge or release:

```bash
npm run lint
npm run test
npm run build
```

## Host requirements

Some features depend on local tooling:

- `nmap`
- `tshark`
- SNMP utilities
- Playwright browser runtime
- PowerShell
- `guacd` for remote desktop

## Data location

Local state is stored under `.steward/`:

- `steward_state.db`
- `steward_audit.db`
- `vault.enc.json`
- `vault.key`

## Troubleshooting

- If live updates stall, check `/api/state/stream` and the control-plane queue in the UI.
- If a playbook is approved but not running, inspect durable jobs and the playbook run status.
- If discovery looks stale, trigger `POST /api/agent/run` and verify scanner leases are healthy.
- If a provider fails, Steward keeps core monitoring state local; restore the provider and retry the blocked action.
