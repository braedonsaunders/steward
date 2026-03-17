# API Guide

Steward exposes JSON APIs for inventory, operations, settings, autonomy, and remote access.

## Principles

- DB-backed configuration only
- explicit resource-oriented endpoints
- durable job handoff for long-running work
- live state over SSE patches

## Core endpoints

### Health and state

- `GET /api/health`
- `GET /api/state`
- `GET /api/state/stream`
- `POST /api/agent/run`

### Devices and inventory

- `GET/POST /api/devices`
- `GET/PATCH /api/devices/:id`
- `GET /api/devices/:id/findings`
- `GET/POST /api/devices/:id/credentials`
- `GET/POST /api/devices/:id/assurances`
- `GET/POST /api/devices/:id/workloads`
- `GET/POST /api/devices/:id/widgets`
- `GET/POST /api/devices/:id/automations`

### Incidents and approvals

- `GET/PATCH /api/incidents`
- `GET /api/approvals`
- `POST /api/approvals/:id`
- `GET/POST /api/playbooks/runs`

### Settings and auth

- `GET/POST /api/settings/runtime`
- `GET/POST /api/settings/system`
- `GET /api/settings/history`
- `GET /api/auth/me`
- `POST /api/auth/bootstrap`
- `POST /api/auth/login`
- `POST /api/auth/logout`

### Packs and autonomy

- `GET/POST /api/packs`
- `GET/PATCH/DELETE /api/packs/:id`
- `GET/POST /api/packs/signers`
- `GET/POST /api/missions`
- `GET/PATCH /api/missions/:id`
- `GET /api/investigations`
- `GET/PATCH /api/investigations/:id`
- `GET /api/subagents`
- `GET/PATCH /api/subagents/:id`

### Chat and remote access

- `POST /api/chat`
- `GET/POST /api/remote-desktop/sessions`
- `GET/POST /api/devices/:id/remote-terminal`

## Live updates

`/api/state/stream` emits SSE patch events. The client should:

1. load the full snapshot from `/api/state`
2. subscribe to `/api/state/stream`
3. merge incoming section patches into the last known state

## Compatibility

Steward does not guarantee long-term stable API versioning yet. The current API is intended for the bundled UI, local tooling, and early integrations.
