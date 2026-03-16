# Scanner and Agent Control Plane Task Register

Last updated: 2026-03-13

## Objective

Cut Steward over from a timer-led monolithic runtime into a DB-backed control plane with:

- a dedicated interval scanner for discovery and cheap network checks
- independently scheduled assurance execution
- periodic and event-driven agent wakes
- durable queued execution for scanner, monitor, and agent work
- separate operator-visible histories for scanner and agent activity

## Phase Register

| ID | Phase | Status | Definition of Done |
|---|---|---|---|
| SACP-001 | Formalize the control-plane architecture and task register | DONE | Architecture plan and task register are persisted in repo and linked from `tasks.md` |
| SACP-002 | Split DB-backed scanner cadence from agent wake cadence | DONE | Runtime settings expose `scannerIntervalMs` and `agentWakeIntervalMs`, with legacy scanner interval migrated cleanly |
| SACP-003 | Separate scanner history from real agent wakes | DONE | `scanner_runs` persists scanner cycles and `agent_runs` is reserved for agent-plane work |
| SACP-004 | Cut scanner, monitor, and agent work over to durable jobs | DONE | Queue-backed job kinds drive scanner discovery, monitor execution, and agent wakes/assurance jobs |
| SACP-005 | Add crash recovery for the control plane | DONE | Dead-process leases and stale `durable_jobs` no longer wedge the scheduler |
| SACP-006 | Update read models and UI labels | DONE | Settings and Activity distinguish scanner runs from agent runs and expose both cadences |
| SACP-007 | Rebuild, run, and monitor multiple live cycles | DONE | Production app completes several scanner intervals and assurance/agent jobs without wedging |

## Acceptance Criteria

- Scanner interval is DB-backed and visible in Settings.
- Agent wake interval is DB-backed and visible in Settings.
- Manual scanner trigger enqueues work through the control plane instead of bypassing it.
- `Activity` shows `Scanner Runs` and `Agent Runs` as separate histories.
- Simple assurances continue running even if discovery stalls or times out.
- Agent wakes are persisted with a wake reason in run details.
- Restarting the process does not leave the scheduler wedged behind stale leases or stale queue state.

## Notes

- Deterministic assurances continue to route through the monitor worker.
- Semantic and desktop-class assurances route through the agent plane job kinds.
- The current cutover preserves full-state SSE; projection/delta streaming remains a later scalability task.
