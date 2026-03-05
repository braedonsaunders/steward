# Steward Device Adoption + Autonomous Ops Task Register

Last validated: 2026-03-05

## Program Statement

When a device is adopted, Steward should immediately run an LLM-assisted onboarding workflow that:

1. Builds a rich endpoint profile (role, services, dependencies, risks, management approach).
2. Asks the user targeted questions when service intent is ambiguous.
3. Requests and stores required credentials securely (vault-backed, agent/LLM never receives secret values).
4. Selects and binds the best adapter(s) per device/protocol.
5. Starts continuous issue detection and policy-safe remediation.

## Existing Baseline (Already Implemented)

- Discovery pipeline: passive + active + multicast + fingerprinting (`src/lib/discovery/*`).
- Device classification and protocol inference (`src/lib/discovery/classify.ts`).
- Adoption status model (`discovered|adopted|ignored`) in device metadata.
- LLM discovery advisor for basic manageability recommendation (`src/lib/discovery/advisor.ts`).
- Management-surface generation and protocol negotiation (`src/lib/protocols/negotiator.ts`).
- Adapter registry + dynamic capabilities + adapter playbooks (`src/lib/adapters/*`).
- Policy engine, approvals, playbook runtime safety gates (`src/lib/policy/*`, `src/lib/playbooks/*`).
- Vault for encrypted secret storage (OS-keystore protected, AES-256-GCM) (`src/lib/security/vault.ts`).

## Gaps to Close

- No first-class adoption workflow state machine.
- No device onboarding Q&A (critical services, uptime expectations, watchlist).
- No per-device credential intent/binding model (only generic vault keys today).
- No adapter selection score/binding lifecycle persisted per adopted device.
- No credential-precondition enforcement before remediation execution.
- Incident detection logic is still basic and not profile-driven.

## Target Architecture

### 1) Adoption Orchestrator (new)

- Trigger: device adoption transition (`discovered -> adopted`) in `PATCH /api/devices/[id]`.
- Stages:
  - `profile`: LLM + deterministic evidence synthesis.
  - `questions`: generate only unresolved user questions.
  - `credentials`: compute required credential intents by protocol/adapter.
  - `adapter_binding`: score/select adapters and persist binding plan.
  - `activation`: enable checks/playbooks for this device.
- Execution model: queued durable jobs (audit DB durable_jobs) with idempotency keys.

### 2) Credential Broker (new)

- Store only secret references in state DB; secret values live in vault.
- Credential records include:
  - device, protocol, adapter scope, permission scope, rotation metadata, validation status.
- LLM and chat prompts receive only redacted metadata, never secret material.
- Playbook execution resolves a vault secret at runtime through a broker API.

### 3) Service Intent Contract (new)

- Persist user-confirmed "what must stay running" contracts:
  - service/container/process identifier
  - criticality and allowed downtime
  - restart policy
  - monitoring cadence
  - escalation policy

### 4) Adapter Selection Engine (new)

- Scoring inputs:
  - inferred protocols
  - device type/classification confidence
  - vendor/product fingerprint
  - adapter manifest capabilities and support hints
  - credential availability
- Outputs:
  - ranked adapter candidates
  - selected primary adapter(s)
  - fallback adapters
  - rationale + confidence

### 5) Profile-Driven Issue Detection + Remediation (upgrade)

- Move from generic heuristics to typed checks by adopted device profile.
- Each finding maps to:
  - incident key
  - severity
  - evidence
  - suggested deterministic playbook(s)
  - fallback Lane B Plan IR flow when no deterministic playbook exists.

## DB Model Additions (SQLite)

All DB-backed, no env-based runtime config.

- `adoption_runs`
  - `id`, `deviceId`, `status`, `stage`, `profileJson`, `summary`, `createdAt`, `updatedAt`
- `adoption_questions`
  - `id`, `runId`, `deviceId`, `questionKey`, `prompt`, `optionsJson`, `required`, `answerJson`, `answeredAt`
- `service_contracts`
  - `id`, `deviceId`, `serviceKey`, `displayName`, `criticality`, `desiredState`, `checkIntervalSec`, `policyJson`
- `device_credentials`
  - `id`, `deviceId`, `protocol`, `adapterId`, `vaultSecretRef`, `accountLabel`, `scopeJson`, `status`, `lastValidatedAt`
- `device_adapter_bindings`
  - `id`, `deviceId`, `adapterId`, `protocol`, `score`, `selected`, `reason`, `configJson`, `createdAt`, `updatedAt`
- `device_findings`
  - `id`, `deviceId`, `dedupeKey`, `findingType`, `severity`, `title`, `summary`, `evidenceJson`, `status`, `firstSeenAt`, `lastSeenAt`

## API Additions

- `POST /api/devices/:id/adoption/start`
- `GET /api/devices/:id/adoption`
- `POST /api/devices/:id/adoption/questions/:questionId/answer`
- `POST /api/devices/:id/credentials`
- `GET /api/devices/:id/credentials` (redacted metadata only)
- `POST /api/devices/:id/credentials/:credentialId/validate`
- `GET /api/devices/:id/adapters/recommendations`
- `POST /api/devices/:id/adapters/bind`
- `GET /api/devices/:id/findings`

## UI Additions

- Device detail onboarding panel:
  - adoption stage progress
  - unresolved onboarding questions
  - credential intents + secure submit controls
  - adapter recommendation and bind/override action
  - service contract editor
- Discovery table quick action:
  - "Adopt + Start Onboarding" (single action instead of status flip only)

## LLM Contracts

- `DeviceProfileV1` JSON output:
  - role hypothesis, critical services list, dependency hypotheses, risk flags, required credentials, candidate adapters.
- `OnboardingQuestionSetV1` JSON output:
  - only unresolved, high-value questions, max 5 per run.
- Safety:
  - prompt firewall on untrusted telemetry
  - strict JSON schema parse + fallback deterministic path
  - never include vault values or credential payloads in prompt context

## Policy + Remediation Integration

- Extend playbook preconditions with credential requirements.
- Block execution with explicit reason when required credentials are missing/invalid.
- Promote successful Lane B remediation plans into deterministic adapter playbooks (existing promotion recommendation path already present).

## Work Packages

| ID | Scope | Status | Definition of Done |
|---|---|---|---|
| ADP-001 | Adoption workflow state machine | TODO | Adoption run lifecycle persisted and visible per device |
| ADP-002 | Adoption profile generator (LLM + deterministic fusion) | TODO | `profileJson` generated with confidence and fallback path |
| ADP-003 | Onboarding Q&A loop | TODO | Unresolved service-intent questions are persisted and answerable in UI/API |
| ADP-004 | Credential broker + per-device credential records | TODO | Secrets stored in vault, DB stores only refs/metadata, validation flow works |
| ADP-005 | Adapter scoring + binding persistence | TODO | Ranked candidates + selected bindings persisted and editable |
| ADP-006 | Credential-aware playbook preconditions | TODO | Runs requiring missing creds stop before execution with clear policy reason |
| ADP-007 | Profile-driven checks engine | TODO | Adopted devices receive typed findings beyond basic offline/telnet |
| ADP-008 | Finding-to-remediation mapping | TODO | Findings map to deterministic playbooks or gated Lane B plan flow |
| ADP-009 | Device onboarding UX | TODO | Device page supports full onboarding lifecycle and status visibility |
| ADP-010 | Audit and telemetry hardening | TODO | All onboarding/credential/binding actions emit audit events; no secrets in logs |

## Recommended Delivery Sequence

1. `ADP-001` + `ADP-002` (create adoption orchestrator and profile output).
2. `ADP-003` + `ADP-004` (close user intent and credential loop).
3. `ADP-005` + `ADP-006` (adapter binding + execution enforcement).
4. `ADP-007` + `ADP-008` (agentic scan/remediation expansion).
5. `ADP-009` + `ADP-010` (UX + trust hardening).

## Immediate Build Start (First Vertical Slice)

- Implement `ADP-001` through `ADP-003` first:
  - add DB tables + state store methods
  - trigger onboarding job on adoption transition
  - generate and persist profile + unresolved questions
  - surface onboarding state in `/devices/[id]`

This provides a real end-to-end onboarding loop before adding credential and adapter binding depth.
