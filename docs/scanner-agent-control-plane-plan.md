# Scanner and Agent Control Plane Plan

Last updated: 2026-03-13

## Purpose

Define the target control-plane architecture for two different runtime behaviors that Steward currently blurs together:

1. the interval scanner that deterministically inspects the network and cheap health signals
2. the agent wake path that periodically or eventfully reasons about complex assurances, diagnosis, and remediation

This plan is intended to turn the current monolithic loop into a durable, inspectable system with clear ownership boundaries, clear UI semantics, and DB-backed scheduling.

## Problem Statement

Today Steward still mixes too much work inside `src/lib/agent/loop.ts`.

That creates four operational problems:

- scanner work, assurance work, and agentic work share one runtime path, so a stuck discovery pass starves unrelated checks
- the UI does not cleanly distinguish scanner cycles, assurance evaluations, agent wakes, and remediation runs
- there is no first-class wake coordinator for schedule-driven and event-driven work
- expensive or ambiguous work has no separate queue, priority model, or audit model from cheap deterministic work

The system needs a harder split.

## Design Principles

- Deterministic-first. If a check can be proven with ping, SSH, WinRM, SNMP, HTTP, browser automation, or protocol-native queries, do that first.
- Agentic-second. The LLM is for ambiguity, semantic interpretation, plan synthesis, and fallback workflows, not for being the default scheduler.
- DB-backed control plane. All schedules, leases, queue state, monitor definitions, and run histories live in SQLite-backed state.
- Separate run histories. Scanner cycles, assurance runs, agent wakes, and remediation runs must be different first-class records.
- Failure isolation. Discovery timeouts must not block assurance checks. Agent failures must not block simple monitoring.
- Operator clarity. The UI should answer: what ran, why it ran, what it checked, what changed, and what needs approval.

## Target Runtime Model

### 1. Scanner Plane

The scanner is an interval worker owned by runtime settings.

Responsibilities:

- passive and active discovery
- topology refresh
- cheap reachability signals
- availability baselines
- low-cost scanner-owned checks such as:
  - host reachability
  - ping latency
  - port-open checks
  - passive surface changes
  - certificate sweeps

The scanner does not own:

- complex per-assurance cadence
- semantic UI assertions
- diagnosis synthesis
- remediation planning

Primary record:

- `scanner_runs`

Result:

- signal events and scan observations, not direct operator-facing work by default

### 2. Monitor Plane

All assurances become typed monitors with independent cadence.

Monitor classes:

- `probe`
  - ping, TCP open, HTTP reachability, DNS resolve
- `broker`
  - SSH, WinRM, SNMP, Docker, HTTP API, browser session checks
- `semantic`
  - assertions that require an agent or model to interpret evidence
- `desktop`
  - RDP/VNC/browser viewer driven checks

Each monitor gets:

- `monitor_id`
- `device_id`
- `workload_id`
- `monitor_type`
- `cadence_sec`
- `runner_kind`
- `timeout_ms`
- `required_protocols`
- `risk_class`
- `last_due_at`
- `last_started_at`
- `last_completed_at`
- `last_status`
- `last_summary`
- `next_due_at`

Primary records:

- `assurances` remains the product-facing contract model
- add `monitor_jobs` or `monitor_schedules` as the execution model
- keep `assurance_runs` as the operator-facing history for each contract

Important rule:

- the scanner may execute some `probe` monitors opportunistically, but monitor cadence is not derived from scanner completion

### 3. Wake Coordinator

Introduce a durable wake coordinator that converts schedules and events into jobs.

Wake sources:

- scanner interval
- monitor cadence expiry
- device adoption completed
- credential validated
- finding opened
- incident reopened
- approval approved or expired
- remediation verification due
- webhook or protocol-session event
- periodic agent wake

Wake output:

- one `durable_jobs` entry per typed wake

Core job kinds:

- `scanner.discovery`
- `monitor.execute`
- `finding.route`
- `agent.wake`
- `agent.assurance`
- `agent.diagnose`
- `playbook.plan`
- `playbook.execute`
- `notification.deliver`
- `digest.generate`

Every job needs:

- priority
- scope
- idempotency key
- retry policy
- lease owner
- run-after timestamp
- evidence pointer

### 4. Agent Plane

The agent is not the scanner.

The agent should wake in two ways:

- periodic agent review
  - a low-frequency cadence for strategic review, recommendation generation, backlog cleanup, and deferred diagnosis
- event-driven agent wake
  - only when a deterministic worker produces a case that requires reasoning or semantic action

Agent responsibilities:

- semantic assurance evaluation
- RDP/browser/UI-backed assertions
- multi-signal diagnosis
- plan generation when no typed playbook exists
- remediation recommendation wording
- postmortem and operator explanation

Agent non-responsibilities:

- network discovery
- simple ping and reachability checks
- routine process/service checks that protocol-native brokers can execute

Primary record:

- `agent_runs`

That record should represent:

- why the agent woke
- what evidence it consumed
- whether it was reasoning, validating a semantic assurance, or producing a remediation plan

### 5. Finding Router

Add a dedicated finding router between raw monitor/scanner results and incidents.

Responsibilities:

- dedupe repeated observations
- apply hysteresis
- suppress known noisy conditions
- correlate related signals
- promote findings to incidents
- resolve incidents on recovery evidence
- enqueue downstream jobs:
  - `notification.deliver`
  - `playbook.plan`
  - `agent.diagnose`

Primary records:

- `finding_occurrences`
- `findings`
- `incidents`

The router is where Steward decides whether something is merely "a failed check" or "an operator-visible incident."

### 6. Remediation Plane

Remediation remains policy-gated and deterministic-first.

Flow:

1. finding router attaches remediation family hints
2. deterministic planner selects a playbook when one exists
3. policy engine decides `ALLOW_AUTO`, `REQUIRE_APPROVAL`, or `DENY`
4. if no deterministic path exists, enqueue `agent.diagnose` or `playbook.plan`
5. successful playbooks emit verification jobs rather than assuming success

Primary records:

- `playbook_runs`
- `approvals`
- `device_findings`

### 7. UI and Read Models

The UI needs separate views and names for separate runtime concepts.

Required distinctions:

- `Scanner Runs`
  - discovery and scanner-owned signal collection only
- `Assurance Runs`
  - per-check history, last result, next due, duration, evidence
- `Agent Runs`
  - LLM or semantic wake-ups, including why the agent woke
- `Remediation Runs`
  - playbook execution and verification

Required device-page visibility:

- last assurance result
- last evaluated time
- next due time
- runner type
- blocked reason
- evidence summary

Required settings visibility:

- scanner interval
- agent wake interval
- per-monitor cadence override support
- worker health
- queue lag
- last successful scanner cycle
- last successful agent wake

## Scheduling Model

### Scanner cadence

DB-backed runtime setting:

- `scannerIntervalMs`

Behavior:

- drives network discovery and cheap scanner-owned checks
- one leader lease for scanner ownership
- one cycle lease per active scanner pass

### Agent cadence

DB-backed runtime setting:

- `agentWakeIntervalMs`

Behavior:

- periodic review wake for backlog, diagnosis, and semantic work
- does not own every assurance
- may be skipped when there is no work

### Monitor cadence

DB-backed per-assurance setting:

- `checkIntervalSec`

Behavior:

- each assurance schedules itself independently
- due monitors enqueue `monitor.execute`
- semantic and desktop assurances may enqueue `agent.assurance` instead of direct execution

## Assurance Routing Rules

### Class A: scanner-owned

Examples:

- ping
- TCP reachability
- passive online/offline
- HTTP 200 reachability
- TLS expiry

Execution:

- scanner or cheap monitor worker

### Class B: broker-owned

Examples:

- service running over SSH
- Windows service state over WinRM
- SNMP interface counters
- Docker container health

Execution:

- monitor worker through protocol broker

### Class C: agent-assisted

Examples:

- browser-authenticated workflow checks
- semantic validation of app state
- "log into the app and confirm dashboard widget X is present"

Execution:

- monitor worker gathers evidence
- agent wake interprets and decides pass/fail

### Class D: agent-operated desktop

Examples:

- RDP into a host and inspect a GUI-only application
- VNC/browser viewer navigation
- verify a Windows desktop app is usable

Execution:

- durable desktop session job
- agent or bounded automation drives the session
- findings routed back through the same assurance model

## Data Model Changes

### Keep

- `assurances`
- `assurance_runs`
- `agent_runs`
- `playbook_runs`
- `notification_deliveries`
- `durable_jobs`

### Add

- `scanner_runs`
- `finding_occurrences`
- `finding_state`
- `wake_rules`
- `worker_leases`
- `monitor_schedule_state`
- `agent_wake_reasons`

### Rename in UI, not necessarily storage immediately

- current `agent_runs` table is being used as scanner history in parts of the product
- short term: relabel the existing runtime concept in UI and split new records cleanly
- medium term: move scanner history to `scanner_runs` and reserve `agent_runs` for real agent wake history

## Execution Order

### Phase 0: Stabilize the current runtime

- finish scanner/assurance split so assurance cadence does not depend on discovery completion
- keep stale leases from dead processes from blocking the runtime
- make scanner failures fail closed and visible
- make device pages show assurance last result and next due

### Phase 1: Wake coordinator

- turn schedule expiry into `durable_jobs`
- add typed job kinds for scanner, monitor, agent, router, notification, and playbook work
- move timer callbacks from inline loop code toward queue-driven workers

### Phase 2: First-class finding router

- separate raw observation ingestion from incident creation
- add dedupe, hysteresis, and suppression rules
- route downstream notifications and remediation planning through jobs

### Phase 3: Agent wake split

- add `agentWakeIntervalMs` to runtime settings
- add explicit `agent.wake`, `agent.assurance`, and `agent.diagnose` job kinds
- persist true `agent_runs` with reason, scope, and consumed evidence

### Phase 4: Assurance type completion

- classify every assurance into `probe`, `broker`, `semantic`, or `desktop`
- complete runner support for browser and remote-desktop-backed assertions
- let onboarding generate these typed assurance contracts directly

### Phase 5: UI and operator clarity

- split Activity into scanner, assurances, agent, and remediations
- surface queue health, worker ownership, and blocked reasons
- add last-success and next-due summaries to device and settings views

### Phase 6: Remediation and verification

- enqueue remediation planning from routed findings
- keep deterministic playbooks primary
- add agent fallback only when no deterministic playbook exists
- add verification jobs after remediation instead of inline assumptions

## Immediate Implementation Recommendations

1. Introduce `agentWakeIntervalMs` in DB-backed runtime settings.
2. Add `scanner_runs` as a distinct persistence model instead of overloading `agent_runs`.
3. Move due-assurance selection into a queue-backed monitor scheduler.
4. Add `wake_reason` metadata to every agent wake.
5. Add a `finding_occurrences` table before expanding more finding packs.
6. Keep discovery timeout bounded so scanner history stays truthful.
7. Treat RDP/browser-driven checks as typed `desktop` or `semantic` monitors, not ad hoc agent prompts.

## Bottom Line

The correct end-state is:

- the scanner continuously gathers deterministic network facts on its own cadence
- monitors evaluate assurances on their own cadence
- the finding router decides what matters
- the agent wakes periodically and on-demand for reasoning-heavy work
- remediation is policy-gated and verified
- the UI makes these runtime concepts visible as separate things

That architecture supports both of your requirements:

- a reliable interval scanner for network and cheap assurances
- a separately scheduled agent for complex checks, diagnosis, and remediation
