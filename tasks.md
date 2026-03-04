# Steward Spec Checklist (Compared to `AGENTS.md`)

Last audited: 2026-03-04

Legend:
- `[x]` Implemented
- `[ ]` Not implemented or only partially implemented (details inline)

## 1) Core Architecture

- [x] Persistent agent loop exists (`discover -> understand -> act -> learn`)
- [x] Manual and interval loop execution supported
- [x] Agent run history persisted
- [x] State is persisted locally to disk
- [ ] Discover/understand/act/learn run concurrently (current implementation is sequential)
- [ ] Adaptive loop scheduling (current interval is fixed via env var)
- [ ] Priority-based action queues
- [ ] Cancellable long-running probes
- [ ] Idempotency keys for all actions

## 2) Knowledge Graph

- [x] Graph storage exists in persisted state (`nodes` + `edges`)
- [x] Device nodes are attached to the graph
- [x] Service nodes are attached to devices
- [x] Dependency edges (`depends_on`) are supported
- [x] Recent graph change query helper exists
- [ ] Full graph coverage for credentials/incidents/recommendations/baselines as first-class nodes
- [ ] Temporal version model (`first_seen_at`/`last_seen_at`/`changed_at`) across all node/edge types
- [ ] Snapshot-consistent historical traversals
- [ ] Topology traversal features surfaced in UI

## 3) Discovery Engine

- [x] Passive sweep via ARP table parsing
- [ ] Passive mDNS/SSDP/DHCP/broadcast listeners
- [x] Active enumeration via nmap (with ping fallback)
- [x] Basic service fingerprinting from open ports
- [ ] UDP probing for SNMP/DNS/NTP
- [ ] OS/vendor fingerprint confidence scoring
- [x] Device type classification heuristics
- [x] Protocol inference heuristics
- [ ] Rich protocol negotiation per-device with real auth checks
- [x] Continuous discovery via recurring loop
- [ ] New-device guided onboarding UX with device-specific prompts

## 4) Credential Onboarding and Vault

- [x] Encrypted vault at rest (AES-256-GCM)
- [x] Key derivation from passphrase (scrypt)
- [x] Vault init/unlock/lock API + UI controls
- [x] Secret keys can be listed without exposing values
- [x] Provider credentials/tokens stored in vault
- [ ] Hardware-token-backed master key mode (TPM/YubiKey/HSM)
- [ ] Per-secret key wrapping/KEK rotation
- [ ] Multi-user vault access policy

## 5) Management Surface

- [x] Dynamic management surface model exists per device
- [x] Basic capability mapping for SSH/WinRM/SNMP/Docker/K8s/HTTP
- [ ] Real protocol adapters executing device-specific operations
- [ ] Server management depth (patch orchestration, SMART, account audit, firewall drift)
- [ ] Network gear management depth (VLAN/STP/PoE/config backup)
- [ ] Storage management depth (pool health/snapshots/replication)
- [ ] Printer/IoT management depth beyond basic discovery

## 6) Conversational Layer

- [x] Conversation API endpoint exists
- [x] Multi-provider LLM support (OpenAI/Anthropic/Google/OpenRouter)
- [x] Context-aware prompt generated from live inventory/incidents
- [x] Chat UI exists in dashboard
- [ ] Deep graph query execution from natural language
- [x] Task delegation with executable plan + approval flow
- [ ] Automatic navigation linking chat responses to device/incident detail pages

## 7) Incident Response Pipeline

- [x] Detection creates incidents from heuristic conditions (offline/telnet)
- [x] Incident timeline model exists
- [x] Recommendation model/feed exists
- [x] Incident status updates supported via API
- [ ] Correlation across multi-device dependencies/events
- [ ] Root-cause diagnosis engine with targeted probes
- [ ] Real remediation executor for incidents
- [ ] Post-incident improvement suggestions based on recurrence analytics

## 8) Autonomy Model and Policy Engine

- [x] Device autonomy tier field exists (1/2/3)
- [x] Tiered behavior enforcement in action runtime
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
- [x] API token guard mechanism available (`STEWARD_UI_TOKEN`)
- [x] Action logs captured for system/user operations
- [ ] Immutable/tamper-evident audit ledger
- [ ] RBAC roles (`Owner/Admin/Operator/Auditor/ReadOnly`)
- [ ] SSO (OIDC/SAML) login model
- [ ] LDAP/AD integration
- [ ] Least-privilege, per-capability authorization workflow

## 11) Notifications and Reporting

- [x] In-app incident/recommendation feed in dashboard
- [x] Daily digest generation and delivery
- [ ] Weekly executive report generation
- [ ] Notification channel integrations (email/Slack/Teams/SMS/push)
- [x] Approval inbox with TTL/escalation rules

## 12) Deployment Model

- [x] Self-hostable via Docker
- [x] Local-only operation supported (no cloud required for core loop)
- [ ] Optional outbound cloud relay/tunnel
- [ ] Federated multi-site control plane
- [ ] MSP tenant model and delegated admin

## 13) API Surface (Current vs Spec)

- [x] Health endpoint
- [x] State endpoint
- [x] Devices CRUD (basic add/list)
- [x] Incident list + status patch
- [x] Recommendation list + dismiss patch
- [x] Manual agent cycle endpoint
- [x] Chat endpoint
- [x] Vault endpoints
- [x] Provider config + OAuth start/callback endpoints
- [x] Policy resource endpoints
- [x] Playbook resource endpoints
- [ ] Audit export endpoints
- [ ] Streaming event API for live updates

## 14) UX and Information Architecture

- [x] Inventory view
- [x] Incident feed view
- [x] Recommendation feed view
- [x] Chat panel
- [x] Provider management panel
- [x] Vault controls panel
- [x] Topology map/dependency visualization
- [x] Dedicated device detail pages
- [x] Incident deep-dive page with diagnosis/remediation evidence
- [x] Policy management UI
- [x] Reporting UI (daily/weekly summaries)

## 15) Extensibility

- [ ] Adapter SDK contract (`detect/collect/act/verify/rollback`)
- [ ] Adapter capability manifests + permission declarations
- [ ] Adapter certification/compatibility suite
- [ ] Adapter isolation/runtime limits

## 16) Reliability and Performance Targets

- [x] Basic state write serialization lock in place
- [ ] Uptime target instrumentation (99.9%) and monitoring
- [ ] Discovery freshness SLA tracking
- [ ] P95 conversational query latency tracking
- [ ] Checksummed snapshots and verified restore path
- [ ] Graceful degradation test coverage when LLM providers fail

## 17) Product Goals and Metrics

- [ ] Autonomous Resolution Rate (ARR) instrumentation
- [ ] MTTD/MTTR measurement pipeline
- [ ] Backup verification success metrics
- [ ] Cert-expiry prevention metrics
- [ ] Critical false-positive budget tracking
- [ ] Approval latency analytics

## 18) Acceptance Criteria (v1) Status

- [ ] Install-to-first-value in < 30 minutes (not benchmarked yet)
- [ ] Stable operation at >= 50 mixed devices (not validated)
- [x] At least 5 remediation playbooks with rollback
- [x] Action history is logged and attributable
- [ ] Low critical false-positive rate validated (not measured)
- [x] Daily digest useful for non-technical operators

## 19) Near-Term Build Tasks (Prioritized)

- [x] Implement policy engine and enforce autonomy tiers at execution time
- [x] Add first 5 typed remediation playbooks with preflight/verify/rollback
- [x] Build approval workflow with explicit `approve/deny` endpoints and UI actions
- [ ] Expand discovery to mDNS/SSDP/DHCP and UDP service probes
- [ ] Add first-party adapters (UniFi, Synology, Proxmox, pfSense)
- [ ] Implement notification channels (email first, then Slack/Teams)
- [x] Add daily digest generator and delivery scheduler
- [x] Add topology/dependency map UI
- [ ] Add RBAC + SSO foundation
- [ ] Add reliability and product KPI instrumentation (ARR/MTTD/MTTR)
