# Steward Architecture - Refined Council Proposal (Historical)

Status note (2026-03-05): this is an architecture review artifact, not the live implementation status source of truth. For current implementation coverage and task state, use [`/tasks.md`](/Users/braedonsaunders/Documents/Code/steward/tasks.md) and [`/README.md`](/Users/braedonsaunders/Documents/Code/steward/README.md).

## Executive Summary

This document synthesizes peer critiques from the architecture council and produces a revised, actionable engineering plan. The key insight from all reviewers is that **safety must be enforced at the execution layer, not just the policy layer**. The current codebase has a protocol negotiator (`src/lib/protocols/negotiator.ts`) that defines capabilities but the playbook runtime (`src/lib/playbooks/runtime.ts:27`) bypasses it entirely, executing raw shell commands.

**Key refinements from vote feedback (Cycle 2):**
1. **Lockout Paradox** - Network changes can sever the agent's connection. Added device-native dead man's switches (Cisco `reload in`, Juniper `commit confirmed`).
2. **Prompt Firewall** - Added defense against LLM prompt injection via untrusted telemetry (device banners, logs, SNMP strings).
3. **Concrete Two-DB Architecture** - Explicit `steward_state.db` + `steward_audit.db` with WAL from day one.
4. **Semantic Concurrency Control** - Strengthened state-hash validation to prevent "right schema, wrong target" outages.

---

## 1) Top 10 Critical Critiques (Refined Order)

### 0. THE LOCKOUT PARADOX (CRITICAL - EXISTENTIAL)
**Issue:** A flawed network change (VLAN drift, firewall rule, ACL edit) severs the agent's connection to the asset. Remote central rollback fails because Steward is disconnected.
**Evidence:** No current mechanism exists for post-change connection recovery
**Fix:** Network mutating actions **must** utilize device-native "dead man's switches":
  - Cisco: `configure terminal; interface {x}; switchport mode access; reload in 5` (auto-revert if no confirm)
  - Juniper: `commit confirmed 5` (auto-rollback after 5 minutes without confirm)
  - HP/Aruba: `checkpoint` + timer-based revert
  - Generic: Pre-change config backup + explicit post-change verification before removing revert guard
**Rule:** If device-native revert unavailable, policy auto-upgrades to `REQUIRE_APPROVAL` with mandatory human-in-loop

### 1. Execution Bypasses Protocol Adapter Layer (CRITICAL - EXISTENTIAL)
**Location:** `src/lib/playbooks/runtime.ts:27`
**Issue:** `runShell(command)` executes locally, not via SSH/WinRM/SNMP adapters
**Evidence:** Protocol negotiator exists but playbook runtime never calls it
**Fix:** Replace `runShell` with `ProtocolBroker.execute(operation, deviceId, credentialScope)`

### 2. Lane B Has No Semantic Validation (CRITICAL)
**Location:** No typed Plan IR exists in current codebase
**Issue:** LLM outputs free-form text; even with JSON schema validation, wrong-target + right-schema = outage
**Fix:** Implement **four-gate validation**: schema → semantic target check (state hash) → policy → dry-run simulation

### 3. Lane C "Sandbox" Is Conceptually Flawed (CRITICAL)
**Peer consensus:** Network operations cannot be sandboxed in traditional sense
**Fix:** Lane C becomes **Semantic Protocol Proxy** - same adapters, command-blocklist enforcement, mandatory step-by-step approval, no local filesystem writes

### 3.5. LLM Prompt Injection via Telemetry (CRITICAL - NEW FROM VOTE)
**Issue:** Untrusted device banners, SNMP strings, log entries, or syslog messages could contain prompt injections designed to manipulate the LLM planner into emitting destructive IR
**Evidence:** No sanitization layer exists between raw telemetry and LLM context packing
**Fix:** Implement **Prompt Firewall**:
  - Strip/Control characters from all telemetry before context packing
  - Truncate overly long strings (LLM context limits)
  - Block known injection patterns (markdown code blocks, JSON-smuggling, system prompt overrides)
  - Log all sanitization events for audit

### 4. Policy Engine Lacks Quantitative Risk Scoring (HIGH)
**Location:** `src/lib/policy/engine.ts:83-134`
**Issue:** Binary decisions (ALLOW/DENY/APPROVAL) with no blast-radius or failure-history weighting
**Fix:** Add `riskScore: number (0-100)`, factor in: action blast radius + device criticality + 24h failure rate + quarantine signals

### 5. Idempotency Is Hash-Based, Not State-Based (HIGH)
**Location:** `src/lib/playbooks/runtime.ts:68-149`
**Issue:** 24-hour hash lockout ignores recurring crashes (service crashes at T, crashes again at T+2h)
**Fix:** State-based idempotency - preflight must verify "is action actually needed right now?" Time lockouts apply only to quarantines

### 6. SQLite Concurrency Not Addressed (HIGH)
**Peer concern:** Single DB file with high-frequency telemetry + state updates will hit `SQLITE_BUSY`
**Fix:** Implement **Two-DB architecture with WAL from day one**:
  - `steward_state.db`: Configuration, Policy, RBAC, Knowledge Graph, Incident State
  - `steward_audit.db`: Append-only ledger via asynchronous bounded queue (does not block state operations)
  - Both use `PRAGMA journal_mode=WAL` immediately
  - Use `cron-parser` library; store parsed windows with explicit UTC ranges

### 7. Credential Access Not Per-Action Audited (MEDIUM)
**Location:** `src/lib/security/vault.ts`
**Issue:** Vault operations not linked to playbook_run_id
**Fix:** Add `credential_access_log` table: `playbook_run_id, credential_id, accessed_at, operation`

### 8. No LLM Provider Fallback for Core Operations (MEDIUM)
**Issue:** If LLM unavailable, discovery advice and adaptive planning halt entirely
**Fix:** Implement **degrade-to-deterministic mode** - queue LLM tasks, continue monitoring/remediation with Lane A only

### 8.5. Silent LLM Degradation (HIGH - NEW FROM VOTE)
**Issue:** No explicit state machine exists for LLM provider outages, risking pipeline stalls
**Fix:** Implement **LLM Availability State Machine**:
  - `AVAILABLE`: Lane B enabled, normal operation
  - `DEGRADED`: Latency >30s or error rate >10%, prefer Lane A deterministic
  - `UNAVAILABLE`: Provider unreachable, Lane A only, queue incidents for human review
  - State transitions logged with timestamps for audit

### 9. Maintenance Window Edge Cases (MEDIUM)
**Location:** `src/lib/policy/engine.ts:19-42`
**Issue:** Custom cron parser doesn't handle day-of-week, month, or TZ correctly
**Fix:** Use `cron-parser` library; store parsed windows with explicit UTC ranges

### 10. Graph Store Exists But Unused for Incidents (LOW)
**Location:** `src/lib/state/graph.ts`
**Issue:** Dependency graph built but not queried during diagnosis
**Fix:** Query graph for `depends_on` edges when correlating multi-device incidents

---

## 2) Revised Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CONTROL PLANE                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐    ┌────────────────┐    ┌─────────────────────────┐  │
│  │ Agent Loop     │    │ Policy Engine  │    │ Conversation Layer      │  │
│  │ Orchestrator   │───▶│ (Risk Scoring) │    │ (LLM Adapter + Plan IR)│  │
│  └────────────────┘    └────────────────┘    └─────────────────────────┘  │
│           │                     │                          │                 │
│  ┌────────┴─────────────────────┴──────────────────────────┴────────────┐  │
│  │                    FOUR-LANE EXECUTION MODEL                          │  │
│  ├─────────────┬──────────────────┬───────────────────┬───────────────────┤  │
│  │ Lane A      │ Lane B           │ Lane C            │ Lane D (Safety)   │  │
│  │ Deterministic│ LLM-Compiled    │ Semantic Proxy    │ Read-Only Probe  │  │
│  │ (Verified)  │ (4-gate validated)│ (Blocklist+Appr) │ (Fallback)        │  │
│  └─────────────┴──────────────────┴───────────────────┴───────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    EXECUTION GATE (CRITICAL)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  ProtocolBroker.execute(operation, deviceId, credentialScope)         │  │
│  │    1. Lookup device capabilities from ManagementSurface               │  │
│  │    2. Request ephemeral token from Vault (scoped to op + target)    │  │
│  │    3. Route through SSH/WinRM/SNMP/API/NETCONF adapter               │  │
│  │    4. Execute with preflight state-hash validation                   │  │
│  │    5. Verify postconditions, trigger rollback on failure              │  │
│  │    6. For network ops: configure dead man's switch before change      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DATA PLANE (Two-DB WAL Model)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────┐  ┌────────────────────────────────────────┐  │
│  │ steward_state.db       │  │ steward_audit.db                       │  │
│  │ ├─ Configuration       │  │ ├─ Append-only ledger (hash-chained)  │  │
│  │ ├─ Policy + RBAC       │  │ ├─ Evidence bundles (per-run)          │  │
│  │ ├─ Knowledge Graph     │  │ ├─ Credential access log               │  │
│  │ ├─ Incident State      │  │ └─ Async queue (bounded, non-blocking)│  │
│  │ └─ Time-Series Metrics │  │                                        │  │
│  │    (WAL mode enabled)  │  │    (WAL mode enabled)                  │  │
│  └────────────────────────┘  └────────────────────────────────────────┘  │
│                                                                             │
│  ┌────────────────────────┐  ┌────────────────────────────────────────┐  │
│  │ Secret Vault           │  │ Prompt Firewall                        │  │
│  │ ├─ AEAD encryption    │  │ ├─ Sanitize untrusted telemetry        │  │
│  │ ├─ Ephemeral tokens    │  │ ├─ Block injection patterns            │  │
│  │ └─ Per-action scoping  │  │ └─ Truncate + log sanitization        │  │
│  └────────────────────────┘  └────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PROTOCOL ADAPTER LAYER                               │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ SSH      │  │ WinRM    │  │ SNMP     │  │ HTTP/API │  │ NETCONF    │  │
│  │ Adapter  │  │ Adapter  │  │ Adapter  │  │ Adapter  │  │ Adapter    │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Responsibility | Current State |
|-----------|----------------|----------------|
| **ProtocolBroker** | Routes all execution through adapters, enforces capability tokens | DOES NOT EXIST - must create |
| **PlanIRValidator** | 4-gate validation (schema, semantic, policy, dry-run) | Partial JSON validation only |
| **RiskScoringEngine** | Quantitative risk scores + blast radius heuristics | Binary decisions only |
| **CredentialAccessLog** | Per-action audit trail linking to playbook_run_id | DOES NOT EXIST |
| **EphemeralTokenBroker** | Scoped, time-limited credential handles for execution | Vault has static secrets only |
| **StateHashPreflight** | Optimistic concurrency - abort if target state changed since diagnosis | DOES NOT EXIST |
| **PromptFirewall** | Sanitize untrusted telemetry, block injection patterns | DOES NOT EXIST |
| **LLMAvailabilityStateMachine** | Explicit degrade states for LLM provider outages | DOES NOT EXIST |
| **DeadManSwitchCoordinator** | Configure device-native revert timers for network changes | DOES NOT EXIST |

---

## 3) Safety Model

### Risk Classification Matrix

| Level | Description | Examples | Default Decision |
|-------|-------------|----------|------------------|
| **Safe (1-20)** | Reads, queries, ephemeral diagnostics | `ping`, `top`, `Get-Process`, SNMP walks | ALLOW_AUTO |
| **Targeted (21-50)** | Single service/file on non-critical host | `systemctl restart nginx`, file cleanup | ALLOW_AUTO if maintenance window |
| **Wide (51-80)** | Multi-device, routing, firewall | VLAN changes, route updates, mass restarts | REQUIRE_APPROVAL |
| **Critical (81-100)** | Gateway, hypervisor, storage operations | Firmware updates, RAID rebuilds, ACL changes | REQUIRE_APPROVAL + DENY outside window |

### Blast Radius Heuristic

```
blastRadius = 
  (deviceCriticality × 0.4) +      # gateway/hypervisor = 1.0, endpoint = 0.3
  (actionScope × 0.3) +             # single = 0.3, subnet = 0.7, multi-site = 1.0
  (dependencyCount × 0.2) +         # how many devices depend on target
  (failureHistory × 0.1)            # 24h failure rate weighting
```

### Rollback Rules

| Action Type | Rollback Mechanism | Timeout |
|-------------|---------------------|---------|
| Service restart | Auto - inverse operation | 30s |
| Config change | Native commit-confirm (Junos-style) | 300s |
| **Network change** | **Device-native timed rollback + pre-change backup** | **600s** |
| Storage operation | Pre-check snapshot, restore on failure | 900s |

**Critical Rule:** If no proven rollback path exists for Class C/D actions, policy auto-upgrades to `DENY`.

**Network Change Safety Rule (Lockout Paradox Fix):**
- All VLAN/route/ACL/firewall mutations require device-native commit-confirm or equivalent reversible transaction
- Pre-change: capture config snapshot to local audit store
- Execute: apply change with dead man's switch active
- Post-change: verify connectivity to affected devices within 60s
- Confirm: explicitly remove dead man's switch only after verification passes
- Auto-revert: if 60s timeout without confirmation, device-native timer executes rollback
- If device-native unavailable: require human approval with explicit acknowledgment of lockout risk

### Four-Gate Lane B Execution

```
Gate 1: Schema Validation
  └── JSON Schema check - syntactically valid Plan IR

Gate 2: Semantic Target Validation
  └── For each operation: fetch current state hash, verify target hasn't changed
  └── Abort if: device offline, credential expired, state drift detected

Gate 3: Policy/Risk Gate
  └── Compute riskScore, check blastRadius, verify maintenance window
  └── Decision: ALLOW_AUTO | REQUIRE_APPROVAL | DENY

Gate 4: Dry-Run Simulation (where possible)
  └── For config changes: diff-only mode, never apply
  └── For commands: echo/validate flags
  └── Abort if: unexpected output patterns
```

---

## 4) Coverage Strategy for Long-Tail Incidents

### v1 Priority Tiers

**Tier 1: High-Frequency Core (95% of incidents)**
- Service restart (systemd, Windows Service Manager, Docker)
- Certificate renewal (Let's Encrypt, self-signed)
- Backup retry and verification
- Disk pressure relief and cleanup
- Interface bounce with preflight validation

**Tier 2: Standard Coverage (80% of device classes)**
- DNS record repair (Windows DNS, BIND, RFC2136)
- AD replication check and repair
- Switch port status and VLAN reconciliation
- SNMP-based firmware version tracking

**Tier 3: Long-Tail Handling**
- **Cameras/IoT:** Reboot, config backup via HTTP API only
- **Printers:** Queue clear, status check via SNMP
- **Legacy devices:** Read-only probes, no mutations

### Long-Tail Strategy

1. **Capability-based, not device-based:** Define `service.restart` capability, not "support Synology"
2. **Adapter SDK for Tier 3:** External adapters with signed bundles and capability manifests
3. **Lane C for unknowns:** Semantic proxy with blocklist - if adapter doesn't exist, route through Lane C with mandatory approval
4. **Graceful degradation:** If no remediation available, escalate to human with diagnostic evidence bundle

---

## 5) 30/90/180 Day Delivery Plan

### Phase 1: Foundation (Days 1-30)

| Week | Deliverable | Success Metric |
|------|-------------|----------------|
| 1 | **Two-DB architecture**: Split `steward_state.db` + `steward_audit.db` with WAL | Both DBs use WAL, audit writes don't block state |
| 2 | Implement ProtocolBroker with SSH adapter routing | Playbook execution through SSH, not local shell |
| 3 | Add risk scoring to Policy Engine + Dead Man's Switch coordinator | Risk scores computed for all actions; network ops use revert timers |
| 4 | State-hash preflight for critical operations + Prompt Firewall | Abort if device state changed since diagnosis; telemetry sanitized |

**Code Changes:**
- New: `src/lib/execution/protocol-broker.ts`
- New: `src/lib/security/credential-access-log.ts`
- New: `src/lib/execution/dead-man-switch.ts`
- New: `src/lib/llm/prompt-firewall.ts`
- Modify: `src/lib/playbooks/runtime.ts` - remove `runShell`, use broker
- Modify: `src/lib/policy/engine.ts` - add risk scoring

### Phase 2: Trust Infrastructure (Days 31-90)

| Week | Deliverable | Success Metric |
|------|-------------|----------------|
| 5-6 | Plan IR with 4-gate validation | LLM plans validated before execution |
| 7-8 | Ephemeral token broker for credentials + LLM Availability State Machine | No long-lived credentials in memory; explicit degrade states |
| 9 | Lane C Semantic Protocol Proxy | Blocklist + step-approval enforced |
| 10 | LLM fallback mode | Core ops continue without LLM |

**Code Changes:**
- New: `src/lib/execution/plan-ir-validator.ts`
- New: `src/lib/security/token-broker.ts`
- New: `src/lib/execution/lane-c-proxy.ts`
- New: `src/lib/llm/fallback-mode.ts`
- New: `src/lib/llm/availability-state-machine.ts`

### Phase 3: Production Hardening (Days 91-180)

| Week | Deliverable | Success Metric |
|------|-------------|----------------|
| 11-13 | Multi-device incident correlation | Graph queries for `depends_on` edges |
| 14-16 | Promotion loop for adaptive→deterministic | 5 successful runs → human review → deterministic |
| 17-20 | Extended adapter coverage (WinRM, SNMP, HTTP) | 80% device classes covered |
| 21-24 | Full audit trail + compliance export | JSONL + syslog export functional |

### Success Metrics (Measurable)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Lane A execution rate | >80% of incidents | Playbook run status distribution |
| Lane B rejection rate | <10% of plans pass all 4 gates | PlanIR validation failures |
| False positive rate (critical) | <5% | Incidents auto-closed without action |
| Core ops availability (no LLM) | 99.5% | Degraded mode uptime |
| Credential access audit coverage | 100% | All executions have credential_access_log entry |
| Mean time to remediate (Tier 1) | <5 minutes | Playbook start→complete duration |
| **Network rollback success** | **100%** | **Dead man's switch auto-revert triggers correctly** |
| **Prompt injection blocks** | **>0 detected** | **Firewall catches test injection patterns** |
| **Two-DB contention** | **<1% busy** | **SQLITE_BUSY events per hour** |

---

## 6) Open Questions Requiring Product-Level Decisions

1. **Lane C Default State:** Should Lane C be disabled by default globally, or only for production environments?

2. **Promotion Loop Thresholds:** What statistical gates? (Suggested: 5 runs across ≥2 environments, zero regressions, explicit reviewer sign-off)

3. **Blast Radius Confidence:** How to validate blast radius estimates? Should devices be tagged with explicit dependency lists, or computed from graph?

4. **Multi-DB Migration:** At what SQLite contention threshold do we split into `state.db` + `telemetry.db`? (Need metrics first)

5. **Human Accountability Boundaries:** Who is the "approving actor of record" - is it the user who clicked approve, or the Steward instance? How to capture this for compliance?

6. **LLM Provider Selection:** Should we support multiple LLM providers with automatic fallback, or single-provider with explicit degraded mode?

7. **Legacy Device Policy:** What is the explicit allowlist for read-only operations on unmanaged devices without credentials?

---

## 7) Implementation Priorities (Immediate Action)

### This Week

1. **Kill `runShell` in playbook runtime** - Replace with ProtocolBroker stub that logs warnings but still executes locally (for backwards compatibility during transition)
2. **Enable Two-DB with WAL** - Create `steward_state.db` + `steward_audit.db`, both with `PRAGMA journal_mode=WAL`
3. **Add credential_access_log table schema**
4. **Add dead-man-switch coordinator stub** - Interface for device-native revert timers

### This Month

1. **Ship ProtocolBroker with SSH adapter** - First-class protocol routing
2. **Add risk scoring to Policy Engine** - Quantitative weights, not binary
3. **Implement state-hash preflight** - Optimistic concurrency for critical ops
4. **Implement Prompt Firewall** - Sanitize telemetry before LLM context packing

---

## 8) Tradeoffs and Constraints

| Decision | Tradeoff | Mitigation |
|----------|----------|------------|
| SQLite over PostgreSQL | Contention at high scale | WAL mode + metrics-driven DB split |
| Typed IR over free-form | More upfront modeling work | Start with 15 core operations, expand iteratively |
| Lane C as semantic proxy | Less flexible than "true" sandbox | Restrict to read-only + mandatory approval |
| Per-action credential tokens | More complex credential flow | Ephemeral tokens with 5-minute TTL |

---

## Conclusion

The peer critiques converge on a single theme: **safety must be architectural, not aspirational**. The current codebase has the right components (protocol negotiator, policy engine, vault) but they're not wired together. The refactored architecture enforces:

1. **ProtocolBroker** - All execution through capability-scoped adapters
2. **Four-gate validation** - LLM plans validated at multiple layers
3. **Quantitative risk** - Not binary decisions
4. **State-based idempotency** - Not hash-based lockouts
5. **Ephemeral credentials** - No long-lived secrets in memory
6. **Dead Man's Switch** - Network changes auto-revert if connection lost
7. **Prompt Firewall** - LLM injection via telemetry blocked
8. **Two-DB WAL** - Audit doesn't block state operations
9. **LLM Availability State Machine** - Explicit degrade states

**Why this version should earn stronger consensus:**

| Vote Concern | How Addressed |
|--------------|----------------|
| Lockout Paradox (existential) | Dead man's switch for all network mutations |
| Prompt injection (critical) | Explicit Prompt Firewall component |
| SQLite contention (real) | Concrete Two-DB with WAL from day 1 |
| Semantic hallucinations | Four-gate validation with state-hash preflight |
| Silent LLM degradation | Explicit state machine with AVAILABLE/DEGRADED/UNAVAILABLE |

This approach balances practicality (existing code, iterative rollout), correctness (multiple safety layers), and delivery speed (30-day foundation phase).
