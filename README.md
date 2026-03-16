<div align="center">
  <img src="steward.png" alt="Steward" width="100%" />
  <h1>Steward</h1>
  <p><strong>Your network's first employee.</strong></p>
  <p>
    <a href="#quickstart"><strong>Quickstart</strong></a>
    |
    <a href="#screenshots"><strong>Screenshots</strong></a>
    |
    <a href="#what-this-repo-actually-ships"><strong>What This Repo Ships</strong></a>
    |
    <a href="#api-surface"><strong>API Surface</strong></a>
  </p>
  <p>
    <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-yes-0f766e?style=for-the-badge" />
    <img alt="SQLite-backed state" src="https://img.shields.io/badge/state-SQLite-1d4ed8?style=for-the-badge" />
    <img alt="Agent loop" src="https://img.shields.io/badge/agent-discover%20-%3E%20understand%20-%3E%20act%20-%3E%20learn-111827?style=for-the-badge" />
    <img alt="RBAC" src="https://img.shields.io/badge/access-RBAC%20%2B%20SSO-7c3aed?style=for-the-badge" />
    <img alt="Remote access" src="https://img.shields.io/badge/remote-RDP%20%2F%20VNC%20%2F%20terminal-0f172a?style=for-the-badge" />
  </p>
</div>

Steward is a self-hosted IT operations control plane for small networks. This repo already ships a working local-first system with discovery, persistent state, graph-backed inventory, chat over live infrastructure context, policy-gated remediation, secure credential storage, device onboarding, widgets, automations, and operator access control.

> Status: this repository already implements a substantial control plane. The implementation checklist lives in [tasks.md](./tasks.md).

## Screenshots

> These are intentional placeholders. Replace the SVGs in `docs/screenshots/` with real captures later and the README layout stays intact.

<table>
  <tr>
    <td width="50%">
      <img src="./docs/screenshots/inbox-placeholder.svg" alt="Steward inbox placeholder" />
      <p><strong>Inbox and morning briefing</strong><br />Critical issues, approvals, recommendations, and operator context in one surface.</p>
    </td>
    <td width="50%">
      <img src="./docs/screenshots/chat-placeholder.svg" alt="Steward chat placeholder" />
      <p><strong>Conversation as the interface</strong><br />Ask why the NAS was slow yesterday and get an answer backed by live state.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="./docs/screenshots/device-placeholder.svg" alt="Steward device detail placeholder" />
      <p><strong>Device detail and management surface</strong><br />Per-device health, credentials, capabilities, autonomy tier, and recent actions.</p>
    </td>
    <td width="50%">
      <img src="./docs/screenshots/topology-placeholder.svg" alt="Steward topology placeholder" />
      <p><strong>Topology and dependencies</strong><br />Understand blast radius, upstream dependencies, and the shape of the network at a glance.</p>
    </td>
  </tr>
</table>

## What Steward Is

- A Next.js 16 + React 19 application with both operator UI and JSON APIs
- A persistent `discover -> understand -> act -> learn` agent loop with manual and scheduled execution
- SQLite-backed state, audit history, settings history, graph projections, protocol sessions, widget state, dashboard layout state, and device adoption records
- An encrypted vault for device credentials, provider secrets, OAuth tokens, and web research API keys using OS-native key protection plus AES-256-GCM
- Device discovery across passive ARP, mDNS, SSDP, multicast discovery, active nmap sweeps, reverse DNS, packet capture hints, browser observation, and service fingerprinting
- Device classification heuristics that infer type, vendor, OS family, management protocols, and confidence scores
- A graph-backed topology model linking devices, services, workloads, assurances, access methods, profiles, and site/subnet membership
- Incidents, recommendations, approvals, playbook runs, daily digests, and action logs
- A policy engine with autonomy tiers, action classes, maintenance windows, quantitative risk scoring, TTL-based approvals, escalation, rollback hooks, and quarantine on repeated failure
- A broker-first execution layer for SSH, HTTP, WebSocket, MQTT, WinRM, PowerShell over SSH, WMI, SMB, RDP, VNC-backed remote desktop, and local-tool operations
- Device-scoped chat with live context, graph queries, onboarding flows, browser-backed web sessions, remote terminal access, and widget generation
- Adapter management with file-backed and managed adapter packages, manifests, tool skills, runtime config, and adapter-contributed playbooks
- Device widgets, widget controls, per-device automations, and dashboard widget pages
- RBAC, local auth bootstrap, session auth, API token auth, OIDC SSO, and LDAP login
- DB-backed runtime, system, auth-token, and auth settings with mutation history and as-of reads

## Core Capabilities

### Discovery and inventory

Steward combines passive and active discovery so it can do more than ping a subnet. The current implementation uses ARP data, mDNS, SSDP, multicast discovery, nmap scans, reverse DNS, packet intel via `tshark`, browser-based observation of web consoles, TLS and HTTP inspection, SSH banner capture, SNMP and DNS probing, WinRM endpoint checks, MQTT broker checks, SMB negotiation, and NetBIOS hints.

Each device record carries services, protocols, evidence, metadata, timestamps, adoption state, and graph relationships. Discovery is not a one-shot import; it is part of the recurring agent loop.

### Operator control plane

The app already exposes real operator surfaces for:

- Dashboard
- Digest
- Devices
- Discovery
- Topology
- Incidents
- Activity
- Approvals
- Policies
- Chat
- Adapters
- Access control
- Settings

Per-device pages go beyond inventory. They include access methods, stored credentials, adapter/profile binding, workloads, assurances, findings, chat, widgets, automations, remote desktop, and remote terminal access.

### Safe automation and remediation

Steward does not jump straight from detection to mutation. The repo has a real approval and execution pipeline with policy evaluation, risk scoring, approval TTLs, escalation, safety gates, execution lanes, idempotency keys, verification steps, rollback sequences, and failure quarantine.

Built-in playbooks currently cover:

- systemd, Docker, and Windows service recovery
- TLS certificate renewal
- rsync backup retry
- NAS snapshot verification
- disk cleanup
- configuration backup over SSH or HTTP

### Assistant, remotes, and generated surfaces

The conversational layer runs against live local state, not a static prompt. It can answer from devices, incidents, graph structure, recent changes, and device-scoped context, then route into first-party operations.

The current codebase also includes:

- Browser-backed web sessions for recurring appliance UIs
- In-app remote desktop sessions for RDP and VNC via `guacd`
- A per-device remote terminal that selects SSH, WinRM, or PowerShell-over-SSH based on observed access
- Generated device widgets with first-class controls backed by the operation runtime
- Per-device automations that can run widget controls on manual, interval, or daily schedules

### Extensibility

Steward is already designed to be extended in-repo. Adapters can contribute discovery, enrichment, capability mapping, deterministic profile matching, tool skills, and playbooks. The app includes adapter package CRUD, config editing, tool-skill configuration, and built-in starter adapters for HTTP surfaces, Docker operations, and SNMP-derived network intelligence.

## LLM and Provider Support

The repo supports multiple model backends and local endpoints. Current provider support includes:

- OpenAI
- Anthropic
- Google
- Mistral
- Groq
- xAI
- Cohere
- DeepSeek
- Perplexity
- Fireworks
- Together AI
- OpenRouter
- Ollama
- LM Studio
- Custom OpenAI-compatible endpoints

Web research is also configurable through DB-backed settings and can use Brave scraping, DuckDuckGo scraping, Brave API, Serper, or SerpAPI.

## Quickstart

### Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3010](http://localhost:3010).

First-time flow:

1. Visit `/access` and bootstrap the first account.
2. Configure at least one LLM provider.
3. Run the agent loop from the UI or call `POST /api/agent/run`.
4. Review discovered devices.
5. Add credentials only where Steward should actually manage a device.
6. Tune runtime and system settings from the UI.

### Docker compose

```bash
docker compose up --build
```

This stack includes:

- Steward on port `3010`
- `guacd` for in-app remote desktop sessions
- Persistent local state mounted at `./.steward`

### Production scripts

macOS / Linux / WSL:

```bash
chmod +x ./scripts/install-prod.sh
chmod +x ./scripts/run-prod.sh
./scripts/install-prod.sh
./scripts/run-prod.sh
```

Windows PowerShell:

```powershell
./scripts/run-prod.ps1
```

## Host tooling

The repo expects real network tooling. The install scripts and postinstall hooks ensure or attempt to install:

- `nmap`
- `tshark`
- SNMP tools
- Playwright browser runtime
- PowerShell
- `guacd` or Docker-based `guacd` for remote desktop features

## State and Security Model

Steward stores local data under `.steward/`:

- `steward_state.db`
- `steward_audit.db`
- `vault.enc.json`
- `vault.key`

Runtime and product settings are persisted in SQLite. Provider secrets and device credentials are stored in the encrypted vault. API access can be gated by a DB-backed auth token, and operator access can be managed through local users, OIDC, or LDAP.

## API Surface

Core endpoints:

- `GET /api/health`
- `GET /api/state`
- `POST /api/agent/run`
- `POST /api/chat`

Settings:

- `GET/POST /api/settings/runtime`
- `GET/POST /api/settings/system`
- `GET/POST /api/settings/auth-token`
- `GET /api/settings/history?domain=runtime|system|auth`

Inventory and operations:

- `GET/POST /api/devices`
- `GET /api/devices/:id/adoption`
- `GET/POST /api/devices/:id/credentials`
- `GET/POST /api/devices/:id/widgets`
- `GET/POST /api/devices/:id/automations`
- `GET/PATCH /api/incidents`
- `GET /api/approvals`
- `POST /api/approvals/:id`
- `GET/POST /api/playbooks/runs`
- `GET /api/audit-events`
- `GET/POST /api/digest`

Identity and providers:

- `GET /api/auth/me`
- `POST /api/auth/bootstrap`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET/POST/PATCH/DELETE /api/auth/users`
- `GET/POST /api/providers`
- `GET /api/providers/models`
- `GET/POST /api/vault`

Remote access:

- `GET/POST /api/remote-desktop/sessions`
- `POST /api/remote-desktop/sessions/:id/viewer-bootstrap`
- `GET/POST /api/devices/:id/remote-terminal`

## Contributing

If you are contributing:

- Keep runtime and product configuration DB-backed
- Prefer deterministic execution paths and auditable state transitions
- Read [tasks.md](./tasks.md) before picking a major change

## Replace the screenshot placeholders

The README visuals are wired to files in `docs/screenshots/`.

- Keep the same filenames and swap the SVGs for real PNG, JPG, or GIF captures later
- Best results: 1600px wide images with a 16:10 or 16:9 aspect ratio
- Prefer crisp captures of the inbox, chat workspace, device detail, and topology views

## License

This repository does not currently declare a license in `README.md`. Add one before broad distribution.
