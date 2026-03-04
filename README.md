# Steward

**Your network's first employee.**

Steward is an autonomous IT operations agent for real-world small networks: servers, switches, NAS, APs, printers, IoT, Docker hosts, and VMs.

This repository now includes a complete self-hostable v1 foundation with:

- Persistent agent loop: `discover -> understand -> act -> learn`
- Structured knowledge graph + state persistence
- Multi-provider LLM harness (Vercel AI SDK)
- Providers: OpenAI, Anthropic, Google, OpenRouter
- Provider OAuth onboarding endpoints (PKCE code flow)
- Encrypted credentials vault (AES-256-GCM)
- Device discovery engine (passive + active)
- Incidents + recommendations pipeline
- Conversational operations interface
- Web control plane + API surface

## Core Architecture

### 1) Agent Loop

`src/lib/agent/loop.ts` runs a persistent cycle:

- **Discover**: passive/active network scan
- **Understand**: protocol negotiation + management surface generation
- **Act**: incident creation + recommendations + basic remediation decisions
- **Learn**: baseline updates (latency, history)

### 2) Knowledge Graph + Memory

`src/lib/state/*` stores persistent Steward state in `.steward/state.json`:

- Devices, services, incidents, recommendations, action logs
- Graph nodes + edges for dependencies and topology memory
- Agent run history
- Provider configurations and OAuth state

### 3) Discovery Engine

`src/lib/discovery/*`

- Passive discovery: ARP table sweep
- Active discovery: nmap if available, otherwise ping sweep
- Service fingerprint normalization and device classification heuristics

### 4) LLM Provider Harness (Vercel AI SDK)

`src/lib/llm/providers.ts`

- OpenAI via `@ai-sdk/openai`
- Anthropic via `@ai-sdk/anthropic`
- Google via `@ai-sdk/google`
- OpenRouter via OpenAI-compatible provider with custom base URL

### 5) OAuth Provider Onboarding

- Start flow: `GET /api/providers/oauth/start?provider=<provider>`
- Callback: `GET /api/providers/oauth/callback/[provider]`

Supports PKCE and stores resulting tokens in encrypted vault.

### 6) Security Model

`src/lib/security/vault.ts`

- Vault encryption: AES-256-GCM
- Key derivation: `scrypt` from passphrase
- Secrets never returned by APIs
- Optional API guard via `STEWARD_UI_TOKEN`

## Control Plane UI

The main UI (`/`) includes:

- Live inventory and status cards
- Incident feed
- Recommendation feed
- Agent run controls
- Device onboarding form
- Provider model/API key config
- OAuth connect links per provider
- Vault init/unlock/lock actions
- Conversational Steward interface

## API Surface

- `GET /api/health`
- `GET /api/state`
- `GET/POST /api/devices`
- `GET/PATCH /api/incidents`
- `GET/PATCH /api/recommendations`
- `POST /api/agent/run`
- `POST /api/chat`
- `GET/POST /api/providers`
- `GET /api/providers/oauth/start`
- `GET /api/providers/oauth/callback/[provider]`
- `GET/POST /api/vault`

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Copy env template:

```bash
cp .env.example .env.local
```

3. Start:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

See `.env.example` for full list.

Minimum recommended:

- `STEWARD_MASTER_PASSPHRASE=<strong passphrase>`
- At least one provider credential:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GOOGLE_GENERATIVE_AI_API_KEY`
  - `OPENROUTER_API_KEY`

Optional:

- `STEWARD_UI_TOKEN` to protect APIs/UI calls
- `STEWARD_DEFAULT_PROVIDER`
- Provider OAuth client credentials

## Docker

Build and run:

```bash
docker build -t steward .
docker run --rm -p 3000:3000 --env-file .env.local -v $(pwd)/.steward:/app/.steward steward
```

## Current Scope Notes

This is a full working foundation and includes real orchestration paths, encrypted secret handling, and live provider routing.

Some protocol/deep-remediation modules are currently heuristic-first (for safe default behavior) and intended to be expanded with device-specific adapters (UniFi/Synology/Proxmox/IPMI/SNMPv3 profile packs, etc.).
