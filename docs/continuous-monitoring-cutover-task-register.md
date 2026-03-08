# Continuous Monitoring Cutover Task Register

Last validated: 2026-03-08

## Objective

Execute a clean cutover from the current monolithic interval loop toward a production monitoring control plane with:
- deterministic-first monitoring
- durable wake/job execution
- outbound notification delivery
- semantic monitor support for LLM-required workloads
- policy-safe remediation routing

## Implemented in This Tranche

| ID | Task | Status | Deliverable |
|---|---|---|---|
| CMC-001 | Formalize cutover analysis and task register | DONE | Architecture analysis plus this task register persisted in repo |
| CMC-002 | Add notification outbox domain model | DONE | Notification channels/deliveries persisted in SQLite |
| CMC-003 | Add Telegram and webhook channel delivery workers | DONE | Durable job worker can deliver outbound notifications |
| CMC-004 | Enqueue notifications for incident-open and approval lifecycle events | DONE | Incident/approval notifications are emitted into the outbox |
| CMC-005 | Add semantic monitor contract type | DONE | LLM-evaluated semantic assurance path exists for complex workloads |

## Remaining Cutover Tasks

| ID | Task | Status | Definition of Done |
|---|---|---|---|
| CMC-006 | Add first-class finding router | TODO | Signal dedupe, hysteresis, suppression, and incident promotion are separated from `actPhase` |
| CMC-007 | Add durable wake coordinator | TODO | Schedule and event wakes are queued as typed durable jobs instead of inline loop logic |
| CMC-008 | Move monitor execution to workerized jobs | TODO | Assurances and scanner packs run from per-monitor jobs with independent cadence |
| CMC-009 | Add projection/delta live state streams | TODO | UI no longer depends on full-state SSE polling |
| CMC-010 | Add time-series event store and anomaly engine | TODO | Baselines, thresholds, and anomaly wakes are stored and replayable |
| CMC-011 | Expand deterministic finding packs | TODO | Storage, backup, cert, network, workload, and security packs are implemented |
| CMC-012 | Add notification routing policies and operator-facing delivery management | TODO | Per-channel routing, quiet hours, escalation, and delivery inspection are complete |
| CMC-013 | Add semantic monitor authoring UX | TODO | Operators can create/edit semantic monitors from the product UI without raw API use |
| CMC-014 | Add integration coverage for notifications and semantic monitors | TODO | Delivery worker and semantic monitor flows are covered by automated tests |

## Execution Order

1. `CMC-006` + `CMC-007`
2. `CMC-008` + `CMC-011`
3. `CMC-012` + `CMC-013`
4. `CMC-009` + `CMC-010`
5. `CMC-014`

## Notes

- The current tranche establishes the foundation, not the full end-state.
- No runtime behavior in this cutover depends on environment variables.
- Notification credentials are vault-backed; channel metadata is DB-backed.
