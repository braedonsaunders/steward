# Mission Control and Telegram Gateway

Last updated: 2026-03-17

## Purpose

Move Steward from short-lived agent turns and device-local automations toward durable agency over time.

This cutover adds:

- `missions` as durable goals Steward owns
- `subagents` as formal domain owners
- `investigations` as persistent follow-up state
- `packs` as the installable knowledge unit
- a Telegram-first `gateway` for human-facing operator presence
- mission-thread chat cutover so gateway threads, chat sessions, and mission ownership share one durable context
- mission-aware dashboard and device ownership surfaces

The cutover is additive. Existing `workloads`, `assurances`, `device_automations`, chat, playbooks, and approvals remain in place.

## Model

### Workloads and assurances stay

- `Workload` remains the concrete thing Steward is responsible for on a device.
- `Assurance` remains the deterministic check or desired-state contract attached to a device or workload.
- `DeviceAutomation` remains the low-level scheduled actuator.

### Missions sit above them

`Mission` is the durable responsibility layer:

- availability overwatch
- certificate watch
- backup hygiene
- storage health
- WAN guardian
- daily briefing

Mission state now includes cadence, scope, last run, next run, last status, shadow mode, and mission-owned links.

### Subagents own missions

`Subagent` is the formal operational owner of a domain:

- Availability Operator
- Certificate Operator
- Backup Operator
- Storage Operator
- Network Operator
- Briefing Operator

Subagents now persist typed scope and autonomy policy:

- domain and allowed mission families
- approval mode
- channel voice
- autonomy budgets
- escalation windows
- memory window
- standing orders
- mission-run memory
- inbound delegations
- cross-mission plans

They provide explicit ownership boundaries instead of one global agent loop carrying all context.

### Investigations persist ambiguity

`Investigation` is the durable follow-up object for issues that remain active over time.

It stores:

- current stage
- objective
- hypothesis
- evidence
- recommended actions
- unresolved questions
- source reference
- status
- step history
- next follow-up time

### Packs become the community object

`Pack` is now broader than an adapter package. A pack can carry:

- subagents
- mission templates
- workload templates
- assurance templates
- finding templates
- investigation heuristics
- playbooks
- report templates
- briefing templates
- gateway templates
- adapters
- tools
- lab fixtures

Pack lifecycle is now materialized in SQLite through:

- `pack_installs`
- `pack_versions`
- `pack_resources`

Managed packs are validated against a pack manifest schema and Steward version compatibility before install or update.

Managed trust policy now also supports:

- signer registry in SQLite
- Ed25519 signature verification for verified packs
- persisted verification status and verification timestamps
- compatibility-safe install, upgrade, disable, and remove flows

## Runtime

The autonomy runtime is implemented with durable jobs:

- `mission.tick`
- `investigation.step`
- `briefing.compile`
- `approval.followup`
- `channel.delivery`

These jobs are bootstrapped, queued, retried, and requeued through the same control-plane durability model as the scanner and runtime jobs.

## Domain Package Split

The autonomy cutover is no longer centered on one `src/lib/autonomy` package only.

Primary domain packages now exist under:

- `src/lib/missions`
- `src/lib/subagents`
- `src/lib/gateway`
- `src/lib/packs`
- `src/lib/investigations`

Each domain owns repository, service, and worker entrypoints while reusing shared autonomy types and runtime helpers where that reduces duplication.

## Gateway

Telegram is the first-class gateway surface.

Gateway state is DB-backed:

- `gateway_bindings`
- `gateway_threads`
- `gateway_inbound_events`
- `briefings`

Supported command surface:

- `/status`
- `/missions`
- `/subagents`
- `/investigations`
- `/briefing`
- `/approve <playbookRunId>`
- `/deny <playbookRunId> <reason>`

Gateway behavior now also includes:

- webhook update dedupe via `gateway_inbound_events`
- simple natural-language prompts for mission visibility and slowness triage
- durable delivery for briefings over `channel.delivery`
- durable `gateway_threads -> chat_sessions` binding so Telegram conversations append into mission-aware chat history

If a binding has no target thread yet, Steward can adopt the first inbound Telegram thread that reaches the webhook.

## Mission-Thread Chat Cutover

`ChatSession` now formally persists:

- `missionId`
- `subagentId`
- `gatewayThreadId`

That cutover means:

- Telegram threads can create or attach to a mission-aware chat session
- chat prompts can include mission plans, delegations, and open investigations
- device-scoped chat remains additive and compatible with the pre-existing chat/session APIs

This is implemented without moving configuration into environment variables.

## Mission Coordination

Mission coordination is now a first-class persisted layer instead of prompt-only convention.

The implementation now persists:

- `subagent_memories`
- `standing_orders`
- `mission_delegations`
- `mission_plans`

The runtime uses these records to:

- record mission-run memory after durable mission execution
- inject standing-order instructions into mission ownership behavior
- open delegations to other domain subagents when evidence crosses domain boundaries
- build durable mission plans and checkpoints for later operator and chat context

## Metrics and Validation

The autonomy layer now exposes a metrics surface through `GET /api/autonomy/metrics`.

It currently reports:

- worker health and leader activity
- pending, processing, and stale durable job counts
- queue lag
- mission latency
- briefing latency
- channel delivery latency

Validation coverage now includes:

- autonomy route tests
- Telegram gateway dedupe and threading tests
- mission replay fixtures for WAN, backup, and certificate guardians
- schema migration tests for autonomy-table and chat-session cutover
- restore-drill coverage for the autonomy state backup path

## API Surface

Mission control APIs:

- `GET /api/autonomy/metrics`
- `GET/POST /api/missions`
- `GET/PATCH /api/missions/:id`
- `GET /api/missions/:id/delegations`
- `GET /api/missions/:id/plan`
- `POST /api/missions/:id/run`
- `GET /api/subagents`
- `GET/PATCH /api/subagents/:id`
- `GET/POST /api/subagents/:id/orders`
- `GET /api/investigations`
- `GET/PATCH /api/investigations/:id`
- `GET/POST /api/packs`
- `GET/POST /api/packs/signers`
- `GET/PATCH/DELETE /api/packs/signers/:id`
- `GET/PATCH/DELETE /api/packs/:id`
- `POST /api/packs/:id/toggle`
- `GET /api/devices/:id/autonomy`
- `GET/POST /api/gateway/bindings`
- `GET/PATCH/DELETE /api/gateway/bindings/:id`
- `POST /api/gateway/telegram/:bindingId/webhook`
- `GET/POST /api/briefings`

## UI Surfaces

Primary operator views added in this tranche:

- `/missions`
- `/subagents`
- `/packs`
- `/gateway`
- `/` mission-control dashboard
- device contract views with mission ownership badges

These are now part of the main app navigation and act as the operator console for the autonomy layer.

## Remaining Follow-Up

The major architectural cutover items from the mission-control tranche are now implemented.

The main remaining production-proof gap is long-horizon soak evidence and broader certification depth:

- multi-day soak validation for mission families running unattended
- broader pack gallery and certification fixtures
- richer gateway escalation and routing policy beyond the Telegram-first baseline
