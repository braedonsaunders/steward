# Continuous Monitoring Architecture Analysis

Last updated: 2026-03-08

## Executive Summary

Steward does not yet have the best final architecture for continuous monitoring, but it has the right primitives to get there quickly.

Today the system already has:
- a DB-backed recurring agent loop (`src/lib/agent/loop.ts`)
- deterministic service assurance checks (`src/lib/monitoring/contracts.ts`)
- deterministic findings for offline, Telnet exposure, and TLS expiry
- policy-gated playbook execution and approvals
- durable job primitives in SQLite (`durable_jobs`), although they are not yet the main execution path

The main architectural problem is that detection, incident promotion, remediation triggering, and operator notification still live inside one interval-driven control loop. That is good enough for a prototype, but not good enough for a world-class monitoring system.

The correct direction is:
- deterministic-first monitoring
- event-aware wake-ups
- durable job workers
- a normalized finding router
- a notification outbox
- LLM usage only for ambiguous diagnosis, monitor authoring, and gated fallback planning

## Current Strengths

### Deterministic baseline already exists

- `runStewardCycle` is DB-scheduled and persists outcomes.
- `actPhase` already evaluates deterministic conditions and creates incidents/recommendations.
- `evaluateServiceContract` can run protocol-aware checks without invoking an LLM.
- playbooks are already policy-gated and can auto-run or request approval.

### The product model is already compatible with better monitoring

- settings are DB-backed, not env-backed
- device credentials are vault-backed and redacted in state/API flows
- adoption/orchestration state already exists for turning discovered devices into managed assets
- protocol brokers already provide a better execution path than raw shell-only monitoring

## Current Weaknesses

### The loop is too monolithic

`src/lib/agent/loop.ts` currently mixes:
- issue detection
- incident creation/resolution
- recommendation generation
- playbook selection
- playbook execution
- approval expiry
- local tool health cleanup

That creates coupling between "notice a problem" and "decide what to do next". Continuous monitoring works better when those are separate workers with separate cadences and priorities.

### Schedule-driven only is too blunt

The repo has DB-backed interval scheduling, but no real wake coordinator. That means:
- no first-class event-driven remediations
- no durable prioritization between urgent and low-value work
- no clean path for webhook-triggered or protocol-session-triggered follow-up work

### Durable jobs exist but are not the control plane

`src/lib/state/store.ts` exposes enqueue/claim/complete/fail helpers for `durable_jobs`, but the main runtime is not workerized around them yet. That is a missed opportunity. The queue exists; the architecture has not fully pivoted to it.

### Notification fanout does not exist yet

There is no outbound alert transport for Telegram, webhooks, email, Slack, or Teams. The system can create incidents, but it cannot yet fan them out through an operator-friendly outbox with retries, routing rules, and escalation.

### Live state streaming is still full-state polling

`src/app/api/state/stream/route.ts` sends the full state every second. That is acceptable for a prototype and wrong for a larger monitoring product. It should become projection-based and delta-based.

## Recommended Architecture

### 1. Signal Plane

Everything that can be measured deterministically should be measured deterministically.

Sources:
- discovery collectors
- service assurances
- adapter-native health checks
- protocol session events
- external callbacks and webhooks
- scheduled hygiene scans

Output:
- normalized finding candidates with:
  - source
  - device/service scope
  - dedupe key
  - observed at
  - severity suggestion
  - evidence payload
  - remediation family hint

Important rule:
- the LLM should not be responsible for continuously re-checking conditions that can be proven by protocol-native or rule-based checks

### 2. Finding Router

Introduce a dedicated router between raw signals and incidents.

Responsibilities:
- dedupe repeated observations
- apply hysteresis and suppression
- correlate related findings
- promote findings to incidents
- resolve incidents when recovery evidence arrives
- trigger notification policies
- trigger remediation planning

This is the missing middle layer today.

### 3. Wake Coordinator

Add a wake coordinator that turns both schedules and events into durable jobs.

Schedule wakes:
- discovery passes
- assurance evaluations
- certificate sweeps
- backup verification
- patch drift checks
- digest generation
- approval TTL follow-up
- notification reminder/escalation passes

Event wakes:
- device status transitions
- finding opened/resolved
- protocol session message received
- webhook callback received
- credential validated
- device adopted
- approval approved/denied
- threshold crossed in the time-series store

Implementation direction:
- each wake becomes a `durable_jobs` entry with kind, priority, idempotency key, target scope, and run-after timestamp
- workers claim jobs and emit follow-up jobs instead of directly chaining everything in-process

### 4. Execution Plane

Deterministic remediation should stay the default.

Lane A:
- restart service
- retry backup
- renew certificate
- clean disk pressure
- export config backup

Lane B:
- only when no deterministic path exists or the diagnosis is ambiguous
- LLM builds a bounded plan
- policy engine still gates execution

Key principle:
- the agent should create or refine monitor contracts
- workers should execute monitor contracts

That means even "weird" workloads should trend toward deterministic monitoring after Steward learns them once.

### 5. Notification Outbox

Notifications should be an outbox, not inline side effects from the loop.

Needed components:
- `notification_channels`
- `notification_rules`
- `notification_deliveries`
- retry/backoff metadata
- escalation state

Channel order should be:
1. Telegram
2. Generic webhooks
3. Email
4. Slack / Teams
5. SMS / push

Why Telegram first:
- low setup friction
- common for homelabs and small operators
- strong fit for critical alerts and approval prompts

Configuration model:
- channel metadata in SQLite
- bot tokens and other secrets in the vault
- routing rules in DB-backed settings/policy tables

## Deterministic vs Agentic Boundary

### Deterministic by default

These should not require the LLM:
- service/process/container state checks
- port policy checks
- TLS expiry and hostname coverage checks
- backup age/success/restore-gap checks
- disk pressure and SMART thresholds
- interface errors, CRCs, PoE budget, DHCP exhaustion
- patch drift and config drift
- approval escalation timers
- incident dedupe and suppression
- known remediation selection when a finding maps cleanly to a playbook family

### Agentic only when necessary

Use the LLM for:
- ambiguous root-cause synthesis across multiple findings
- novel endpoint/workload profiling during onboarding
- generating new monitor contracts from chat/onboarding context
- proposing deterministic monitors for unsupported workloads
- Lane B remediation planning when no typed playbook exists
- high-quality operator explanations and postmortems

If the LLM becomes unavailable, Lane A monitoring and remediations should keep working.

## Concrete Repo Changes

### Phase 1: Extract the monitoring control plane

- split `actPhase` into:
  - signal collection
  - finding routing
  - incident promotion
  - remediation planning
  - notification dispatch
- stop doing all of that in one loop body

### Phase 2: Activate durable jobs

- use the existing `durable_jobs` table as the runtime queue
- add workers for:
  - monitor execution
  - incident routing
  - notification delivery
  - remediation planning
  - scheduled maintenance work

### Phase 3: Add notification outbox

- add Telegram first
- add generic webhook delivery second
- move approval escalations onto the outbox instead of only writing local actions

### Phase 4: Add a real event/time-series store

- preserve observations and finding occurrences
- compute baselines and threshold crossings outside the loop body
- let anomaly detection create wakes instead of embedding all logic in `learnPhase`

### Phase 5: Reduce LLM scope

- LLM should author, classify, and explain
- deterministic workers should monitor, alert, and remediate

## Recommended Delivery Order

1. Add the wake coordinator and workerized `durable_jobs` runtime.
2. Extract a dedicated finding router from `actPhase`.
3. Add notification outbox plus Telegram and webhook channels.
4. Move assurances and scanners onto typed monitor jobs with independent cadences.
5. Add time-series/anomaly storage and threshold-based event wakes.
6. Expand deterministic finding packs by device class.
7. Restrict agentic work to diagnosis, monitor synthesis, and Lane B planning.

## Bottom Line

The right architecture is not "let the agent continuously check everything." The right architecture is:

- deterministic workers gather facts
- a router turns facts into incidents and notifications
- durable jobs wake work on schedules and events
- policy decides whether remediation can run
- the LLM handles ambiguity, synthesis, and fallback planning

That is the path from the current prototype loop to a trustworthy continuous monitoring system.
