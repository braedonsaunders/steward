# Steward Device Adoption + Autonomous Ops Task Register

Last validated: 2026-03-08

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
- Adoption orchestrator with persisted runs/stages/drafts (`src/lib/adoption/orchestrator.ts`).
- Chat-native onboarding session bootstrap for adopted devices (`src/lib/adoption/conversation.ts`).
- LLM discovery advisor for basic manageability recommendation (`src/lib/discovery/advisor.ts`).
- LLM + deterministic adoption profile generation with safe fallback (`src/lib/adoption/profile.ts`).
- Management-surface generation and protocol negotiation (`src/lib/protocols/negotiator.ts`).
- Adapter registry + dynamic capabilities + adapter playbooks (`src/lib/adapters/*`).
- Access-method and device-profile persistence/selection for onboarding decisions.
- Per-device credential storage with vault refs, redacted reads, and validation flows.
- Policy engine, approvals, playbook runtime safety gates (`src/lib/policy/*`, `src/lib/playbooks/*`).
- Credential-aware playbook blocking for missing or unusable credentials.
- Workload/assurance persistence and assurance run history (`workloads`, `assurances`, `assurance_runs`).
- Vault for encrypted secret storage (OS-keystore protected, AES-256-GCM) (`src/lib/security/vault.ts`).

## Gaps to Close

- Structured onboarding questions are generated, but they are not persisted/answered as first-class records; the current supported path is chat + draft editing.
- No dedicated deep endpoint profiling pass on adoption transition beyond current discovery evidence and profile synthesis.
- Adapter selection/binding persistence exists, but fallback lifecycle, verification, and override semantics still need hardening.
- No durable job worker executes onboarding stages or monitor activation work yet.
- Incident detection logic is still basic and not profile-driven.

## Target Architecture

### 1) Adoption Orchestrator (upgrade existing baseline)

- Trigger: device adoption transition (`discovered -> adopted`) in `PATCH /api/devices/[id]`.
- Stages:
  - `profile`: LLM + deterministic evidence synthesis.
  - `questions`: either persist structured questions or fully standardize chat-native onboarding as the only supported answer path.
  - `credentials`: compute required credential intents by protocol/adapter.
  - `adapter_binding`: score/select adapters and persist binding plan.
  - `activation`: enable checks/playbooks for this device.
- Execution model: queued durable jobs (audit DB durable_jobs) with idempotency keys.

### 2) Credential Broker (upgrade existing baseline)

- Store only secret references in state DB; secret values live in vault.
- Credential records include:
  - device, protocol, adapter scope, permission scope, rotation metadata, validation status.
- LLM and chat prompts receive only redacted metadata, never secret material.
- Playbook execution resolves a vault secret at runtime through a broker API.

### 3) Service Intent Contract (upgrade existing baseline)

- Persist user-confirmed "what must stay running" contracts:
  - service/container/process identifier
  - criticality and allowed downtime
  - restart policy
  - monitoring cadence
  - escalation policy

### 4) Adapter Selection Engine (upgrade existing baseline)

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

## DB Model Status (SQLite)

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

Note:
- these tables already exist in the repo baseline
- the main remaining gap is wiring them into a durable workerized onboarding/monitoring flow rather than adding schema

## API Surface Status

- [x] `POST /api/devices/:id/adoption`
- [x] `GET /api/devices/:id/adoption`
- [ ] `POST /api/devices/:id/adoption/questions/:questionId/answer`
  - currently returns `410`; chat-native onboarding plus draft editing is the supported path
- [x] `POST /api/devices/:id/credentials`
- [x] `GET /api/devices/:id/credentials` (redacted metadata only)
- [x] `POST /api/devices/:id/credentials/:credentialId/validate`
- [x] `GET /api/devices/:id/adapters/recommendations`
- [x] `POST /api/devices/:id/adapters/bind`
- [x] `GET /api/devices/:id/findings`

## UI Status

- Device detail onboarding panel:
  - current baseline includes onboarding nudges, chat session bootstrap, workload/assurance editing, and credential/profile visibility
  - remaining work is a tighter guided flow for onboarding completion and follow-up actions
- Discovery/inventory quick actions:
  - current baseline includes adoption controls
  - remaining work is a single end-to-end "Adopt + Start Onboarding" path with less context switching

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
| ADP-001 | Adoption workflow state machine | DONE | Adoption run lifecycle is persisted and visible per device |
| ADP-002 | Adoption profile generator (LLM + deterministic fusion) | IN PROGRESS | `profileJson` exists; next step is deeper active profiling on transition to adoption |
| ADP-003 | Onboarding Q&A loop | IN PROGRESS | Either first-class question records + answers exist, or chat-native onboarding is the only supported path and the stale question API is removed from the plan |
| ADP-004 | Credential broker + per-device credential records | DONE | Secrets are in the vault, DB stores refs/metadata, and validation flow works |
| ADP-005 | Adapter scoring + binding persistence | IN PROGRESS | Ranked candidates/bindings exist; primary/fallback lifecycle and verification need hardening |
| ADP-006 | Credential-aware playbook preconditions | DONE | Runs requiring missing creds stop before execution with clear policy reason |
| ADP-007 | Profile-driven checks engine | TODO | Adopted devices receive typed findings beyond basic offline/telnet |
| ADP-008 | Finding-to-remediation mapping | TODO | Findings map to deterministic playbooks or gated Lane B plan flow |
| ADP-009 | Device onboarding UX | IN PROGRESS | Device page supports onboarding context; remaining work is a tighter guided flow and discovery quick-start |
| ADP-010 | Audit and telemetry hardening | TODO | All onboarding/credential/binding actions emit audit events; no secrets in logs |

## Recommended Delivery Sequence

1. `ADP-003` (decide and complete the supported onboarding answer path).
2. `ADP-005` (finish adapter binding lifecycle and verification).
3. `ADP-007` + `ADP-008` (make adoption materially improve monitoring/remediation coverage).
4. `ADP-009` + `ADP-010` (tighten UX and trust/audit semantics).
5. `ADP-002` follow-on (deeper active profiling once the workflow boundaries are stable).

## Immediate Build Start (First Vertical Slice)

- Finish `ADP-003` first:
  - either persist structured question records and answers end-to-end
  - or remove the stale question-answer route from the plan and fully standardize chat/draft onboarding
- Then finish `ADP-005`:
  - verify and harden primary/fallback profile selection
  - activate monitoring/remediation according to the selected binding

This closes the current mismatch between onboarding scaffolding and the actual supported operator path.
