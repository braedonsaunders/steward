# Steward Spec Checklist (Compared to `AGENTS.md`)

Last audited: 2026-03-05

Legend:
- `[x]` Implemented
- `[ ]` Not implemented or only partially implemented (details inline)

## 1) Core Architecture

- [x] Persistent agent loop exists (`discover -> understand -> act -> learn`)
- [x] Manual and interval loop execution supported
- [x] Agent run history persisted
- [x] State is persisted locally to disk
- [x] Runtime interval scheduling is DB-backed (not env-driven)
- [x] Phase overlap for `understand/act/learn` after discovery (safe concurrent execution)
- [ ] Fully concurrent/independent phase execution model across all internals
- [ ] Priority-based action queues
- [ ] Cancellable long-running probes
- [ ] Idempotency keys for every action type (playbook operations are covered)

## 2) Knowledge Graph

- [x] Graph storage exists in persisted state (`nodes` + `edges`)
- [x] Device nodes are attached to the graph
- [x] Service nodes are attached to devices
- [x] Dependency edges (`depends_on`) are supported
- [x] Recent graph change query helper exists
- [x] Topology traversal features surfaced in UI (topology page + device graph links)
- [ ] Full graph coverage for credentials/incidents/recommendations/baselines as first-class nodes
- [ ] Temporal version model (`first_seen_at`/`last_seen_at`/`changed_at`) across all node/edge types
- [ ] Snapshot-consistent historical traversals

## 3) Discovery Engine

- [x] Passive sweep via ARP table parsing
- [x] Passive mDNS listener
- [x] Passive SSDP listener
- [ ] Passive DHCP/broadcast listener coverage
- [x] Active enumeration via nmap (with ping fallback)
- [x] Basic service fingerprinting from open ports
- [x] UDP probing for DNS
- [x] UDP probing for SNMP
- [ ] UDP probing for NTP
- [x] OS/vendor confidence scoring
- [x] Device type classification heuristics
- [x] Protocol inference heuristics
- [ ] Rich protocol negotiation per-device with real auth checks
- [x] Continuous discovery via recurring loop
- [ ] New-device guided onboarding UX with device-specific prompts

## 4) Credential Onboarding and Vault

- [x] Encrypted vault at rest (AES-256-GCM)
- [x] OS-native key protection + auto-unlock (no passphrase flow)
- [x] Secret keys can be listed without exposing values
- [x] Provider credentials/tokens stored in vault
- [ ] Hardware-token-backed master key mode (TPM/YubiKey/HSM)
- [ ] Per-secret key wrapping/KEK rotation
- [ ] Multi-user vault access policy

## 5) Management Surface

- [x] Dynamic management surface model exists per device
- [x] Capability mapping for SSH/WinRM/SNMP/Docker/K8s/HTTP
- [x] Adapter execution kernel for typed operations with safety gates
- [ ] Deep device-specific adapter packs (Synology/Proxmox/pfSense and broader family)
- [ ] Server/network/storage management depth at full AGENTS target

## 6) Conversational Layer

- [x] Conversation API endpoint exists
- [x] Multi-provider LLM support
- [x] Context-aware prompt generated from live inventory/incidents
- [x] Chat UI exists in dashboard
- [x] Deterministic graph query execution for dependency and recent-change intents
- [x] Task delegation with executable playbook + approval flow
- [ ] Automatic chat deep-link navigation to relevant UI entities

## 7) Incident Response Pipeline

- [x] Detection creates incidents from heuristic conditions (offline/telnet)
- [x] Incident timeline model exists
- [x] Recommendation model/feed exists
- [x] Incident status updates supported via API
- [x] Policy-gated remediation execution path via playbooks
- [ ] Correlation across multi-device dependencies/events (advanced)
- [ ] Root-cause diagnosis engine with targeted probes (advanced)
- [ ] Recurrence analytics driving improvement recommendations

## 8) Autonomy Model and Policy Engine

- [x] Device autonomy tier field exists (1/2/3)
- [x] Central policy engine (`ALLOW_AUTO` / `REQUIRE_APPROVAL` / `DENY`)
- [x] Action classes (A/B/C/D) and risk scoring
- [x] Maintenance windows and freeze calendars
- [x] Preflight/postflight gates + rollback policy
- [x] Action quarantine/escalation on repeated failure

## 9) Security Posture (Managed Network)

- [x] Basic insecure-port detection (telnet example)
- [ ] Continuous vulnerability scanning against CVE data
- [ ] Open-port auditing against user-defined policy
- [ ] Firmware vulnerability tracking
- [ ] Anomalous traffic analytics (lateral movement/C2/exfiltration)
- [ ] Credential hygiene auditing across discovered infrastructure
- [ ] DNS anomaly analysis

## 10) Security Posture (Steward Itself)

- [x] Encrypted credential storage
- [x] DB-backed API token guard (no env runtime guard)
- [x] Action logs captured for system/user operations
- [x] Settings are versioned with `effective_from` and history
- [x] Settings support current + `asOf` reads by API
- [ ] Immutable/tamper-evident audit ledger (signed/hash-chain)
- [x] RBAC roles (`Owner/Admin/Operator/Auditor/ReadOnly`) with route-level permission enforcement
- [x] SSO login model baseline (OIDC PKCE + verified ID token callback)
- [x] LDAP integration baseline (bind/search auth + auto-provision controls)

## 11) Notifications and Reporting

- [x] In-app incident/recommendation feed
- [x] Daily digest generation endpoint
- [x] Daily digest scheduler (DB-backed system settings)
- [ ] Weekly executive report generation
- [ ] Notification channel integrations (email/Slack/Teams/SMS/push)
- [x] Approval inbox with TTL/escalation rules

## 12) Deployment Model

- [x] Self-hostable via Docker
- [x] Local-only operation supported
- [ ] Optional outbound cloud relay/tunnel
- [ ] Federated multi-site control plane
- [ ] MSP tenant model and delegated admin

## 13) API Surface (Current)

- [x] Health endpoint
- [x] State endpoint
- [x] Devices CRUD (basic)
- [x] Incident list + status patch
- [x] Recommendation list + dismiss patch
- [x] Manual agent cycle endpoint
- [x] Chat endpoint
- [x] Vault endpoints
- [x] Provider config + OAuth endpoints
- [x] Policy + maintenance window resources
- [x] Playbook resources
- [x] Audit export endpoint (`/api/audit-events`, JSON/JSONL)
- [x] Settings endpoints for runtime/system/auth + history
- [ ] Streaming event API for live status updates

## 14) UX and Information Architecture

- [x] Inventory view
- [x] Incident feed view
- [x] Recommendation feed view
- [x] Chat workspace
- [x] Provider management panel
- [x] Vault status panel
- [x] Topology/dependency map
- [x] Device detail pages
- [x] Incident deep-dive page
- [x] Policy management UI
- [x] Reporting UI (daily digest)
- [x] General settings UI for runtime + system + API token guard

## 15) Extensibility

- [x] Adapter contract in runtime
- [x] Adapter capability/tool-skill metadata
- [ ] Adapter certification/compatibility suite
- [ ] Adapter runtime isolation limits

## 16) Reliability and Performance Targets

- [x] State write serialization and durable DB paths
- [ ] Uptime SLO instrumentation (99.9%)
- [ ] Discovery freshness SLA tracking
- [ ] P95 conversational latency tracking
- [ ] Checksummed snapshot + verified restore workflow
- [ ] Graceful degradation test coverage when providers fail

## 17) Product Metrics Instrumentation

- [ ] ARR instrumentation
- [ ] MTTD/MTTR measurement pipeline
- [ ] Backup verification success metrics
- [ ] Certificate incident prevention metrics
- [ ] Critical false-positive budget tracking
- [ ] Approval latency analytics

## 18) Validation Gates (Current)

- [x] `npm run build` succeeds
- [x] `npm run lint` succeeds with zero warnings
- [x] No runtime `process.env.*` usage in product code paths
- [x] No `/plugins` API/page surface in runtime

## 19) Formal Remediation Tasks (2026-03-05)

- [x] TASK-01: Replace env-based API guard with DB-backed auth token settings
- [x] TASK-02: Add settings history with `effective_from` and `asOf` reads
- [x] TASK-03: Add DB-driven system settings and scheduled daily digest generation
- [x] TASK-04: Refactor loop for safe phase overlap (`understand/act/learn`)
- [x] TASK-05: Fix `/chat` build issue (`useSearchParams` suspense boundary)
- [x] TASK-06: Reconcile stale docs/checklists and remove `.env` runtime guidance
- [x] TASK-07: Implement RBAC + OIDC SSO + LDAP auth surface (session auth + role gates + access UI)
- [ ] TASK-08: Implement full CVE/traffic anomaly pipelines
- [ ] TASK-09: Implement multi-site federation/cloud relay
- [x] TASK-10: Clear all lint warnings and re-validate build/lint gates

## 20) Device Adoption Autonomy Program (2026-03-05)

- [x] ADP-BASE-01: Discovery + classification + protocol inference baseline exists
- [x] ADP-BASE-02: Adoption status model exists (`discovered|adopted|ignored`)
- [x] ADP-BASE-03: LLM discovery advisor exists (lightweight should-manage signal)
- [x] ADP-BASE-04: Adapter registry + capability enrichment baseline exists
- [x] ADP-BASE-05: Policy/approval/playbook runtime safety pipeline exists
- [ ] ADP-001: Add first-class adoption workflow state machine and persistence
- [ ] ADP-002: Trigger deep LLM endpoint profiling on adoption transition
- [ ] ADP-003: Add onboarding question loop for service intent and watchlist capture
- [ ] ADP-004: Add per-device credential broker (vault refs only, no secrets in DB/logs/prompts)
- [ ] ADP-005: Add adapter scoring and device binding lifecycle (primary/fallback)
- [ ] ADP-006: Enforce credential preconditions in playbook execution path
- [ ] ADP-007: Implement profile-driven issue detection packs per device class
- [ ] ADP-008: Map findings to deterministic remediation, then gated Lane B fallback
- [ ] ADP-009: Add onboarding UX in device detail/discovery flows
- [ ] ADP-010: Add audit/telemetry hardening for onboarding and credential flows

Reference: `docs/device-adoption-autonomy-task-register.md`

## 21) World-Class Systems Program (2026-03-06)

- [x] WCX-001: Land the detailed world-class backlog document and keep it current
- [ ] WCX-002: Replace shell-template-first execution with protocol-native execution brokers
- [ ] WCX-003: Add real credential governance (validated-use only, per-action access audit, scoped leases)
- [ ] WCX-004: Add quantitative risk scoring to policy evaluation and approval UX
- [ ] WCX-005: Expand deterministic findings and incident coverage across storage, backup, cert, network, workload, and security domains
- [ ] WCX-006: Add a real anomaly engine and time-series baseline model
- [ ] WCX-007: Make the knowledge graph operationally useful for correlation and diagnosis
- [ ] WCX-008: Complete onboarding/adoption state machine and profile-driven checks
- [ ] WCX-009: Add outbound notifications, escalations, and weekly reporting
- [ ] WCX-010: Replace full-state streaming and table rewrites with scalable projections/deltas/workers
- [ ] WCX-011: Add federation, site boundaries, and tenant-safe multi-site architecture
- [ ] WCX-012: Add integration/certification/restore-drill coverage for Steward itself
- [x] WCX-T1-001: Persist onboarding questions from adoption profiles and preserve answers across non-forced re-profiling
- [x] WCX-T1-002: Require validated credentials for runtime protocol availability checks
- [x] WCX-T1-003: Add credential access audit logging tied to device / operation / playbook run
- [x] WCX-T1-004: Add quantitative `riskScore` and `riskFactors` to policy evaluations
- [x] WCX-T1-005: Add deterministic TLS certificate expiry findings from discovered fingerprint data
- [x] WCX-T2-001: Add broker-first SSH/HTTP execution path and migrate built-in operations that fit it cleanly
- [x] WCX-T3-001: Add protocol-aware SSH/HTTP credential validation instead of reachability-only checks

Reference: `docs/world-class-system-program.md`
