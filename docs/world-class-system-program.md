# World-Class System Program

Last updated: 2026-03-08

Purpose:
- Turn Steward from a strong prototype into a world-class autonomous IT operator.
- Track the concrete engineering work needed beyond the current repo baseline.
- Keep implementation grounded in DB-backed state/settings and deterministic execution paths.

Status:
- Initial program backlog persisted.
- First implementation tranche started on 2026-03-06.
- Backlog reconciled against the current repo on 2026-03-08.
- Continuous monitoring should now be treated as deterministic-first with a wake coordinator and notification outbox, not as one monolithic interval loop.

## 0. Continuous Monitoring, Wake-Ups, and Notifications

- [ ] Split the current interval loop into signal collection, finding routing, remediation planning, and notification delivery workers.
- [ ] Add a wake coordinator that converts schedules, state transitions, protocol-session events, and webhooks into durable jobs.
- [ ] Add a normalized finding router with dedupe, hysteresis, suppression, and incident-promotion rules.
- [ ] Keep deterministic checks as the default path; reserve LLM usage for ambiguous diagnosis, monitor synthesis, and Lane B/C planning.
- [ ] Add a notification outbox with Telegram-first delivery, then webhooks, email, Slack, Teams, and SMS/push.

Reference: `docs/continuous-monitoring-architecture-analysis.md`, `docs/continuous-monitoring-cutover-task-register.md`

## 1. Execution Safety and Control Plane

- [ ] Replace shell-template-first execution with protocol-native brokers for SSH, WinRM, SNMP, HTTP/API, Docker, and network-device operations. SSH/HTTP baseline exists; other protocol families still need migration.
- [ ] Eliminate password injection into command strings for normal execution paths.
- [ ] Add connection pooling, host identity validation, timeout policy, retry policy, and typed protocol results.
- [ ] Add per-operation capability scoping with durable audit linkage to playbook runs.
- [ ] Add device-native rollback coordination for network/storage mutations (`commit confirmed`, timed rollback, checkpoint/restore).
- [ ] Deny or force approval for any Class C/D mutation without a proven rollback path.
- [ ] Add state-aware idempotency checks that verify whether remediation is still needed before execution.

## 2. Credentials, Vault, and Secret Governance

- [x] Tighten credential usability rules so execution depends on validated credentials, not merely stored secrets.
- [x] Add protocol-aware credential validation workflows with real handshakes where supported.
- [x] Add per-action credential access audit logs linked to `playbookRunId`, `operationId`, and device.
- [ ] Add scoped credential leases / ephemeral execution grants instead of long-lived raw secret use.
- [ ] Add credential rotation workflows and last-used / last-verified timestamps.
- [ ] Add multi-user vault access policy and just-in-time elevation for sensitive credentials.
- [ ] Add hardware-backed key mode and key rotation roadmap for the vault.

## 3. Policy, Risk, and Autonomy

- [x] Add quantitative policy risk scoring using blast radius, criticality, failure history, maintenance context, and rollback confidence.
- [ ] Persist risk context alongside policy evaluations for every playbook run.
- [ ] Add freeze-window, change-budget, and failure-budget policy inputs.
- [ ] Add site-aware and tenant-aware policy inheritance.
- [ ] Add simulation mode for high-risk changes before approval.

## 4. Detection, Findings, and Incident Coverage

- [ ] Expand deterministic scanner findings far beyond offline / Telnet / assurance drift / TLS expiry.
- [ ] Add storage findings: SMART drift, RAID degradation, filesystem pressure, replication lag.
- [ ] Add backup findings: failed jobs, stale jobs, restore verification gaps.
- [ ] Expand certificate findings from current expiry coverage to chain issues, weak TLS, and hostname mismatch.
- [ ] Add network findings: interface errors, CRC/drop spikes, PoE exhaustion, STP drift, rogue AP indicators, DHCP exhaustion.
- [ ] Add workload findings: container crash loops, failed services, unhealthy scheduled tasks, patch drift, config drift.
- [ ] Add security findings: insecure management surfaces, exposed admin UIs, firmware/CVE drift, weak/default credential indicators, anomalous auth behavior.
- [ ] Add open-port auditing against user policy instead of fixed heuristics only.

## 5. Time-Series, Baselines, and Anomaly Intelligence

- [ ] Add a real metric/event store instead of point-in-time latency-only learning.
- [ ] Add per-device/per-service seasonality-aware baselines.
- [ ] Add anomaly scoring with confidence and false-positive suppression.
- [ ] Add trend forecasting for capacity, certificate windows, disk growth, and backup health.
- [ ] Add ARR, MTTD, MTTR, false-critical budget, and approval latency instrumentation.

## 6. Knowledge Graph and Diagnosis

- [ ] Promote incidents, credentials, recommendations, baselines, and playbook runs into first-class graph entities.
- [ ] Add temporal graph versioning across nodes and edges.
- [ ] Use graph dependencies during incident correlation and blast-radius analysis.
- [ ] Add “change before failure” correlation using graph and audit history together.
- [ ] Add snapshot-consistent historical traversals for conversational queries.

## 7. Onboarding and Device Adoption

- [ ] Finish the onboarding lifecycle as the only supported path. Run/draft/access/profile persistence exists today, but the workflow is still split across draft state and chat guidance.
- [ ] Persist and answer onboarding questions generated by adoption profiling.
- [ ] Preserve answers across non-forced reprofiling when question keys remain stable.
- [ ] Add profile-driven findings/check packs by device class.
- [ ] Add adapter binding lifecycle with primary/fallback selection and operator override.
- [ ] Add deeper credential-aware activation gating before advanced management is enabled.
- [ ] Add device-specific onboarding prompts and remediation recommendations.

## 8. Conversation, Explanations, and Operator Experience

- [ ] Expand deterministic graph queries into fuller dependency, drift, and historical explanation coverage.
- [ ] Add graph-backed root-cause summaries for incident timelines.
- [ ] Add UI deep links from chat responses into incidents, devices, findings, approvals, and topology views.
- [ ] Add operator-facing “why this action is safe / risky” explanations based on policy and evidence.
- [ ] Add richer post-remediation narratives with before/after evidence.

## 9. Notifications, Reporting, and Escalation

- [ ] Add outbound notification channels: Telegram, email, Slack, Teams, SMS/push, webhooks.
- [ ] Add escalation rules, delegate paths, reminder flows, and quiet hours.
- [ ] Add weekly executive summary generation.
- [ ] Add approval escalation and routing by action class, severity, and site.
- [ ] Add operator digest personalization and “critical now vs digest later” policies.

## 10. State, Performance, and Streaming

- [ ] Replace full-state polling/streaming with projection-based and delta-based streaming.
- [ ] Replace whole-table rewrite patterns with incremental updates where possible.
- [ ] Add workerized durable job processing instead of write-only queue APIs.
- [ ] Route wakes, notifications, and monitor executions through durable workers instead of inline loop side effects.
- [ ] Add paginated read models for large installations and evidence-heavy incidents.
- [ ] Add control-plane self-observability for queue lag, DB contention, loop time, and provider health.

## 11. Reliability, Testing, and Certification

- [ ] Add integration tests for discovery, onboarding, policy, approvals, and playbooks.
- [ ] Add adapter certification fixtures and conformance test packs.
- [ ] Add replayable incident fixtures and rollback drills.
- [ ] Add restore validation for state/audit/vault backups.
- [ ] Add Steward internal SLO tracking and regression gates.

## 12. Federation, Multi-Site, and Tenant Boundaries

- [ ] Replace `site:default` assumptions with explicit site entities and IDs.
- [ ] Add multi-site federation and aggregation model.
- [ ] Add tenant boundaries and MSP-safe RBAC/data partitioning.
- [ ] Add cross-site reporting, policy inheritance, and delegated administration.

## 13. Current Implementation Tranche

- [x] Persist the world-class program into repo planning artifacts and cross-reference it from `AGENTS.md`.
- [x] Add adoption orchestrator state, draft-backed onboarding snapshots, and chat session bootstrap.
- [x] Add per-device credential records backed by vault refs plus validation endpoints.
- [ ] Wire first-class onboarding question records and answer reuse; generated prompts currently live only in onboarding draft state.
- [x] Add quantitative `riskScore` data to policy evaluations.
- [x] Add credential access audit logging linked to playbook execution.
- [x] Tighten runtime credential availability to require validated credentials.
- [x] Add deterministic TLS certificate expiry findings and renewal recommendations from fingerprint data.
- [x] Add a broker-first execution path for migrated SSH and HTTP operations, with shell-template fallback for unmigrated operations.
- [x] Add protocol-aware credential validation handshakes for SSH and HTTP API credentials, with explicit fallback heuristics for unsupported protocols.
