# Steward

**Your network's first employee.**

Steward is an autonomous IT operations agent for real-world small networks: servers, switches, NAS, APs, printers, IoT, Docker hosts, and VMs.

## Current Product Baseline

This repository provides a self-hosted control plane with:

- Persistent agent loop: `discover -> understand -> act -> learn`
- SQLite-backed state and audit durability split
- Dynamic topology graph (devices/services/dependencies)
- Device discovery (ARP + active scan + mDNS/SSDP + UDP service probes)
- Incident + recommendation pipeline
- Policy engine, action classes, approvals, and playbook runtime safety gates
- Conversational interface with deterministic graph-query handling for dependency/change questions
- Multi-provider LLM integration (OpenAI, Anthropic, Google, OpenRouter, and others)
- Encrypted vault for secrets and OAuth tokens
- RBAC-backed identity surface (local users/sessions, OIDC SSO, LDAP auth)

## Configuration Model (Non-Negotiable)

Steward does **not** use runtime `.env` product configuration.

- Runtime settings are DB-backed (`runtime.*` metadata + versioned settings history)
- System settings are DB-backed (`system.*` metadata + versioned settings history)
- API auth token guard is DB-backed (`auth.*` metadata + versioned settings history)
- Settings support historical `asOf` reads through API

## Persistence Layout

Steward stores local data under `.steward/`:

- State DB: `.steward/steward_state.db`
- Audit DB: `.steward/steward_audit.db`
- Vault: `.steward/vault.enc.json` + `.steward/vault.key`

## Key API Surface

Core:

- `GET /api/health`
- `GET /api/state`
- `POST /api/agent/run`
- `POST /api/chat`

Settings:

- `GET/POST /api/settings/runtime`
- `GET/POST /api/settings/system`
- `GET/POST /api/settings/auth-token`
- `GET /api/settings/history?domain=runtime|system|auth`

Access and Identity:

- `GET /api/auth/me`
- `POST /api/auth/bootstrap`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET/POST /api/auth/settings`
- `POST /api/auth/ldap/test`
- `GET /api/auth/oidc/start`
- `GET /api/auth/oidc/callback`
- `GET/POST/PATCH/DELETE /api/auth/users`

Inventory and Ops:

- `GET/POST /api/devices`
- `GET/PATCH /api/incidents`
- `GET/PATCH /api/recommendations`
- `GET /api/approvals`
- `POST /api/approvals/[id]`
- `GET/POST /api/playbooks/runs`
- `GET /api/audit-events` (JSON and JSONL)
- `GET/POST /api/digest`

Providers and Vault:

- `GET/POST /api/providers`
- `GET /api/providers/models`
- OAuth start/callback routes under `/api/providers/oauth/*`
- `GET /api/providers/status`
- `GET/POST /api/vault`

## Local Development

1. Install dependencies:

```bash
npm install
```

Playwright browser runtime (Chromium) is auto-installed during dependency install.
Required network tools (`nmap`, `tshark`) are also auto-checked/installed on launch scripts.

2. Start development server:

```bash
npm run dev
```

3. Open [http://localhost:3010](http://localhost:3010)
4. Open [http://localhost:3010/access](http://localhost:3010/access) for account bootstrap/login and RBAC auth settings.

Provider credentials, OAuth tokens, runtime settings, and auth token guard are configured from the UI/API and persisted to SQLite/vault.

## API Guard Token

By default, API calls are open on local instance until configured.

To enable token guard:

```bash
curl -X POST http://localhost:3010/api/settings/auth-token \
  -H 'content-type: application/json' \
  -d '{"token":"replace-with-strong-token-value"}'
```

Then send:

- `Authorization: Bearer <token>`
- or `x-steward-token: <token>`

To clear:

```bash
curl -X POST http://localhost:3010/api/settings/auth-token \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"token":null}'
```

## Docker

Build and run:

```bash
docker build -t steward .
docker run --rm -p 3000:3000 -v $(pwd)/.steward:/app/.steward steward
```

## Production Launch Options

### Script-based local launch

- PowerShell (Windows):

```powershell
./scripts/run-prod.ps1
```

- Bash (Linux/macOS/WSL):

```bash
chmod +x ./scripts/run-prod.sh
./scripts/run-prod.sh
```

Both launch scripts automatically verify/install Playwright Chromium before building.
They also verify/install required network tools (`nmap`, `tshark`, `snmpget`, `snmpwalk`).
On Windows, if package-manager install is unavailable, Steward falls back to the Net-SNMP upstream installer and prompts for elevation when needed.
To manage Windows endpoints over WinRM from Linux or macOS, install PowerShell 7 (`pwsh`) on the Steward host.

### PM2

```bash
npm i -g pm2
npm ci
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

Useful commands:

- `pm2 status`
- `pm2 logs steward`
- `pm2 restart steward`
- `pm2 stop steward`

### Docker Compose

```bash
docker compose up -d --build
```

App URL: [http://localhost:3010](http://localhost:3010)
