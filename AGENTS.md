# Steward

**Your network's first employee.**

## Non-Negotiable Configuration Rule

- Under no circumstances should runtime/product configuration be introduced via environment variables.
- Do not create or rely on `.env` files for product behavior.
- All configuration must be persisted in SQLite and managed through Steward state/settings flows.
- If a new tunable is needed, add it to the DB-backed configuration model and expose it through the app/API.

## Implementation Backlog

- The live implementation checklist is tracked in `tasks.md`.
- The world-class systems backlog is tracked in `docs/world-class-system-program.md`.

---

## The Problem

Small businesses, freelancers, home labs, and lean startups all share the same infrastructure curse: they have real networks - servers, switches, NAS boxes, access points, printers, IoT devices, Docker hosts, VMs - but no one whose actual job it is to manage them. The founder "handles IT." The office manager reboots things. Someone's nephew set up the firewall two years ago and no one's touched it since.

When something breaks, it's a fire drill. When nothing breaks, nobody's checking whether backups are actually running, whether the SSL cert expires next week, whether the NAS firmware has a known exploit, or whether the switch is quietly dropping packets every afternoon.

Enterprise shops solve this with headcount - NOC teams, sysadmins, MSPs on retainer. But for a 10-person company, a solo developer with a homelab, or a small shop with a server closet? The options are either expensive managed services, a graveyard of half-configured monitoring tools, or hope.

## The Premise

Steward is a single autonomous agent that operates as your entire IT department. It's not a dashboard you have to learn. It's not a monitoring stack you have to configure. It's not a ticketing system you have to feed.

It's an employee. You point it at your network, hand it credentials as it asks for them, and let it work. It discovers, catalogs, monitors, diagnoses, remediates, reports, and recommends - continuously, without prompting, without supervision.

You interact with it the way you'd interact with an IT person: "Why was the file server slow yesterday?" "Can you make sure backups are running on the new box?" "What's the security posture look like?" It answers in plain language, backed by real telemetry, and takes action when you authorize it - or on its own, within boundaries you define.

---

## Core Architecture

### The Agent Loop

Steward's core is a persistent agentic loop - not a cron-based poller. It maintains a living model of your environment and continuously re-evaluates what needs attention. The loop operates across four phases:

**Discover** -> What exists on this network? What's new? What's gone?  
**Understand** -> What is each device? What services does it run? What's its role? What's normal?  
**Act** -> What needs fixing, updating, rotating, restarting, or flagging right now?  
**Learn** -> What patterns exist? What's this environment's personality? What should I suggest?

These phases aren't sequential - they're concurrent and overlapping. Steward is always discovering, always understanding, always acting, always learning.

### The Knowledge Graph

Everything Steward knows lives in a structured knowledge graph - not flat config files or a SQL dump. Devices are nodes. Relationships are edges. Services, credentials, dependencies, incidents, baselines, and history all attach as properties and subgraphs.

This means Steward can answer questions like:

- "What depends on this switch?" (topology traversal)
- "What changed in the last 24 hours?" (temporal diff)
- "If this server goes down, what breaks?" (dependency analysis)
- "Is this behavior normal for a Tuesday?" (baseline comparison)

The graph is the agent's memory. It persists across restarts, grows over time, and becomes the institutional knowledge of your infrastructure.

---

## Discovery Engine

### Phase 1: Passive Sweep

On first launch, Steward listens before it speaks. It monitors broadcast traffic, ARP tables, mDNS announcements, SSDP, and DHCP leases to build a preliminary map of the network without sending a single probe. This alone often reveals 60-80% of active devices.

### Phase 2: Active Enumeration

Steward then begins active scanning - ICMP sweeps, SYN scans on common ports, UDP probes for SNMP/DNS/NTP, and service fingerprinting on responsive ports. It identifies operating systems, service versions, and device types using a combination of signature matching and behavioral heuristics.

### Phase 3: Protocol Negotiation

For each discovered device, Steward determines the best management protocol available:

- **SSH/SCP** for Linux/Unix boxes, network gear
- **WinRM/RDP** for Windows machines
- **SNMP v2c/v3** for managed switches, printers, UPS units
- **REST/GraphQL APIs** for modern appliances (Synology, UniFi, Proxmox, etc.)
- **IPMI/iLO/iDRAC** for bare-metal out-of-band management
- **Docker/Podman sockets** for container hosts
- **Kubernetes API** for cluster management
- **MQTT/CoAP** for IoT devices
- **Web scraping** as a fallback for appliances with only a web GUI

### Phase 4: Credential Onboarding

Steward presents discovered devices in a guided onboarding flow:

> "I found a Synology DiskStation at 192.168.1.40 running DSM 7.2. I can manage storage pools, scheduled tasks, backups, and package updates if you give me an admin account. Want to set that up?"

Credentials are stored in an encrypted vault (AES-256-GCM, master key derived from a user passphrase or hardware token). Steward never displays stored credentials in the UI - it only indicates what it has access to and what it can manage as a result.

### Continuous Discovery

Discovery isn't a one-time event. Steward continuously monitors for new devices, changed services, and disappeared hosts. A new device on the network triggers an automatic classification attempt and a notification:

> "New device appeared at 192.168.1.67 - looks like a Raspberry Pi running Debian 12 with SSH open. Want me to manage it?"

---

## Management Surface

Once Steward has credentials, it builds a management surface for each device based on what's available. This isn't a fixed dashboard - it's dynamically generated from what Steward can actually observe and control.

### Servers (Linux/Windows)

- OS patch status and automated patching within maintenance windows
- Disk usage, SMART health, RAID status, filesystem monitoring
- Service/process monitoring with automatic restart on failure
- Log aggregation, anomaly detection, and searchable history
- CPU/RAM/IO baselines with alerting on deviation
- User account auditing and SSH key management
- Firewall rule review and drift detection
- Cron job / scheduled task inventory and failure alerting
- Certificate discovery and expiration tracking
- Container and VM lifecycle management

### Network Gear (Switches, Routers, APs)

- Port status, VLAN mapping, trunk configuration
- Traffic analysis per-port and per-VLAN
- Firmware version tracking with upgrade recommendations
- Configuration backup and drift detection
- STP topology visualization
- PoE budget monitoring
- Client association tracking for wireless APs
- Rogue AP detection

### Storage (NAS, SAN)

- Pool/volume health and capacity forecasting
- Snapshot scheduling and verification
- Replication status and lag monitoring
- Drive health prediction based on SMART trending
- Share/permission auditing
- Backup job monitoring with success/failure tracking

### Printers, IoT, Everything Else

- Toner/ink levels and supply ordering suggestions
- Print queue monitoring and jam detection
- Firmware tracking for IoT devices
- Anomalous traffic detection (IoT devices phoning home unexpectedly)
- Availability monitoring for anything with an IP address

---

## The Conversational Layer

Steward's primary interface is conversational. Not a chatbot bolted onto a dashboard - the conversation IS the interface. The topology map, device pages, and metric charts are visual aids that the conversational layer references and navigates you to.

### Natural Language Queries

You: "Why was the file server slow yesterday?"  
Steward: "Between 2:15 PM and 3:40 PM yesterday, disk I/O on nas-01 spiked to sustained 98% utilization. Root cause: the weekly Veeam backup job on vm-host-02 was writing verification data to the NAS over a 1Gbps link while three users were accessing shared project files. I'd recommend either scheduling the verification pass after hours or bonding a second NIC on the NAS. Want me to shift the backup window?"

### Task Delegation

You: "Make sure the new Ubuntu box is locked down."  
Steward: "I'll run my hardening checklist on srv-ubuntu-04:
  - Disable root SSH login
  - Configure UFW with default-deny inbound
  - Enable unattended-upgrades for security patches
  - Set up fail2ban on SSH
  - Remove unnecessary services
  - Configure audit logging
  Ready to proceed, or want to adjust the list?"

### Proactive Reporting

Steward doesn't wait to be asked. It surfaces issues and recommendations through a priority-ranked feed:

> **Critical** - RAID 5 on nas-01 is degraded. Drive 3 (WD Red 4TB, SN: WCC4E...) is reporting reallocated sectors. I have a replacement procedure ready and can order a matching drive. This array has no hot spare.

> **Warning** - The SSL certificate for gitlab.internal expires in 9 days. I can renew it via Let's Encrypt if you confirm the DNS challenge method, or I can generate a new self-signed cert now.

> **Info** - srv-docker-01 is running 14 containers. Three of them (redis:6.2, postgres:13, nginx:1.21) have newer stable images available. Want me to stage rolling updates?

> **Suggestion** - Your UniFi AP in the warehouse has 23 client associations but only supports Wi-Fi 5. Traffic analysis shows it's consistently at 80%+ airtime utilization during business hours. A Wi-Fi 6 AP would roughly double effective throughput for that space.

---

## Autonomy Model

Steward operates on a tiered autonomy system - you decide how much leash it gets.

### Tier 1: Observe Only

Steward monitors and reports but takes no action. Everything requires explicit approval. Good for initial deployment while building trust.

### Tier 2: Safe Auto-Remediation

Steward can automatically perform low-risk actions: restart a crashed service, clear a full `/tmp`, renew a certificate, retry a failed backup. It logs everything and notifies you after the fact.

### Tier 3: Full Autonomy

Steward can apply patches within maintenance windows, failover services, adjust firewall rules in response to detected threats, and perform any action in its playbook without pre-approval. It still logs and reports everything - you get a morning briefing instead of midnight pages.

Each device can have its own autonomy tier. Your production database server might be Tier 1 while your dev boxes are Tier 3.

---

## Incident Response Pipeline

When Steward detects an anomaly, it doesn't just fire an alert. It runs an investigation:

1. **Detect** - Something is outside baseline parameters (latency spike, service down, disk failing, unusual traffic pattern)
2. **Correlate** - Are other devices affected? Did anything change recently? Is there a known pattern? Check the knowledge graph for dependencies and recent events.
3. **Diagnose** - Narrow down root cause through targeted probes (traceroutes, log analysis, resource checks, dependency walks)
4. **Remediate** - If within autonomy tier, fix it. If not, present the diagnosis and proposed fix for approval.
5. **Document** - Log the entire incident timeline, root cause, and resolution in the knowledge graph. Use it to improve future detection.
6. **Improve** - "This is the third time this service has crashed due to memory exhaustion. I recommend increasing the container memory limit from 512MB to 1GB, or investigating the memory leak in the last release."

---

## Security Posture

### For the Network

- Continuous vulnerability scanning against CVE databases
- Open port auditing against a defined policy
- Firmware version tracking with known-vulnerability flagging
- Anomalous traffic detection (lateral movement, C2 beaconing, data exfiltration patterns)
- Credential hygiene auditing (default passwords, weak SSH keys, expired accounts)
- Firewall rule review and least-privilege recommendations
- DNS query analysis for suspicious resolution patterns

### For Itself

Steward takes its own security seriously. It's a high-value target - it holds credentials to everything.

- All credentials encrypted at rest with AES-256-GCM
- Master key never stored on disk (derived at startup from passphrase or hardware token)
- All management connections use encrypted channels (SSH, TLS, SNMPv3)
- Steward's own web UI requires authentication (local accounts, LDAP/AD, or SSO)
- Full audit log of every action Steward takes, immutable and exportable
- Role-based access for multi-user environments (admin sees everything, help desk sees alerts only)
- Steward runs with least privilege - it requests only the access it needs per device

---

## Deployment Model

### Self-Hosted (Primary)

Steward runs as a single Docker container or lightweight VM on any box inside your network. Minimum requirements are modest - 2 cores, 4GB RAM, 20GB storage for a network of up to ~200 devices. It needs no cloud connectivity to function. Everything runs locally.

### Optional Cloud Relay

For users who want remote access or multi-site management, Steward can establish an outbound tunnel to a relay service - no inbound ports needed. This is strictly optional and can be self-hosted as well.

### Multi-Site

Multiple Steward instances can federate, each managing its own site while reporting to a central console. The coffee shop chain with five locations gets a single pane of glass without punching holes in firewalls.

---

## Personality & Design Philosophy

Steward is not a power tool for sysadmins. It's a capable coworker for people who aren't sysadmins but need sysadmin-level outcomes. Its personality reflects this:

- **Plain language first.** "Drive 3 in your NAS is failing" not "sd3: UNC at LBA 847392"
- **Context-rich.** Every alert includes why it matters and what to do about it
- **Opinionated but overridable.** Steward has strong defaults and will tell you what it thinks is best, but always defers to your decision
- **Proactive, not noisy.** It batches low-priority items into daily digests. Critical issues get immediate notification. It never cries wolf.
- **Transparent.** Every action Steward takes is logged, explained, and reversible where possible
- **Patient.** It knows you might not respond for hours. It handles what it can and queues the rest.

The UI reflects this too - it's clean, calm, and information-dense without being cluttered. Think "competent IT person's daily status email" more than "enterprise monitoring wall of graphs."

---

## Target Users

- **Small businesses (5-50 people)** with a server closet and no IT staff
- **Solo developers / freelancers** running homelabs or client infrastructure
- **Small MSPs** looking for an agent they can deploy into client environments
- **Nonprofit / education** orgs with real infrastructure and no budget for managed services
- **Retail / hospitality** chains with multiple small sites and nobody technical on-site

---

## What Steward Is Not

- **Not an RMM tool.** It doesn't require agents installed on every endpoint. It manages from the outside in, using the protocols devices already support.
- **Not a SIEM.** It does security monitoring, but it's not trying to be Splunk. It's practical security for small environments.
- **Not a replacement for cloud management.** If your infra is 100% AWS/Azure/GCP, you need CloudWatch, not Steward. Steward is for physical and on-prem hybrid environments.
- **Not a NOC dashboard.** It's an autonomous agent that happens to have a UI, not a UI that happens to have some automation.

---

## The Name

*Steward (n.)*: one who manages another's property, finances, or household affairs. From Old English *stīweard* - "house guardian."

Set it loose. Let it work.

---

## Product Goals and Success Metrics

### Product Goals

- Deliver "first IT employee" outcomes in under 30 minutes from install.
- Reduce surprise outages by detecting leading indicators before user-visible impact.
- Convert noisy telemetry into actionable, plain-language decisions.
- Build trust through transparent actions, approvals, and reversibility.
- Keep operational overhead near zero for non-expert operators.

### North-Star Metric

- **Autonomous Resolution Rate (ARR):** percentage of incidents resolved by Steward within policy, without human intervention, and without causing regressions.

### Supporting Metrics

- Mean time to detect (MTTD)
- Mean time to remediate (MTTR)
- Percentage of managed devices with valid credentials
- Backup success rate and restore verification rate
- Certificate expiration incidents prevented
- False positive rate on critical incidents
- User approval latency for gated actions

### Non-Goals (v1)

- Endpoint EDR replacement
- Full SIEM log lake and threat hunting platform
- Public cloud control plane (AWS/Azure/GCP) parity
- Deep packet inspection at enterprise scale

---

## Product Scope

### v1 Scope

- Single-site deployment
- Up to ~200 devices
- Core discovery + classification
- Device inventory and dependency graph
- Incident pipeline with approval workflow
- Safe remediation playbooks
- Conversational interface over live state
- Daily and weekly reporting

### v1.5 Scope

- Multi-site federation
- MSP mode with tenant boundaries
- Extended adapter packs (UniFi, Synology, Proxmox, pfSense, VMware)
- Advanced maintenance windows and change freezes

### v2 Scope

- Probabilistic capacity planning
- Cross-site policy inheritance
- Human-in-the-loop "pair ops" mode for junior admins
- Hardware lifecycle forecasting and procurement suggestions

---

## Core User Journeys

### 1) First 30 Minutes

1. Install Steward on local Docker host or VM.
2. Initialize vault and choose passphrase/hardware key mode.
3. Run passive and active discovery.
4. Review discovered devices with confidence scores.
5. Provide credentials for high-value assets first (firewall, NAS, hypervisor).
6. Select default autonomy tier and maintenance windows.
7. Receive first baseline report and prioritized backlog.

### 2) Daily Operations

1. Read morning briefing (critical first, suggestions second).
2. Approve or reject queued actions.
3. Ask contextual questions in plain language.
4. Track completion and residual risk in incident timelines.

### 3) Incident Mode

1. Receive real-time incident summary with blast radius.
2. Review root-cause hypothesis and confidence.
3. Approve proposed remediation or allow policy auto-execution.
4. Verify post-remediation checks and rollback readiness.

---

## Detailed System Architecture

### Control Plane Components

- **Agent Orchestrator:** schedules and supervises discover/understand/act/learn loops.
- **Policy Engine:** evaluates whether actions are allowed, gated, or blocked.
- **Playbook Runtime:** executes deterministic remediation tasks with preflight and rollback hooks.
- **Conversation Layer:** translates natural language into graph queries, task plans, and summaries.
- **Notification Service:** routes alerts and approvals to configured channels.
- **Audit Ledger:** immutable action and decision log.

### Data Plane Components

- **Collectors:** passive sniffers, active probes, protocol adapters.
- **Normalizers:** unify vendor/protocol output into canonical device/service schemas.
- **Baseline Engine:** computes expected behavior per device and time window.
- **Anomaly Engine:** scores drift, severity, and confidence.

### Storage Components

- **Knowledge Graph Store:** devices, edges, incidents, dependencies, history.
- **Time-Series Store:** metric streams and rolling aggregates.
- **Secret Vault:** encrypted credentials and tokens.
- **Object Store:** config backups, evidence bundles, incident artifacts.

### Execution Model

- Loop intervals are adaptive, not fixed.
- Priority queues ensure critical remediation runs ahead of low-priority tasks.
- Long-running probes are cancellable.
- Every action has idempotency keys to prevent repeated execution.

---

## Knowledge Graph Schema (Expanded)

### Primary Node Types

- `Device`
- `Service`
- `Credential`
- `Incident`
- `Recommendation`
- `Baseline`
- `Site`
- `User`
- `Policy`
- `PlaybookRun`

### Primary Edge Types

- `depends_on`
- `hosts`
- `communicates_with`
- `managed_by`
- `triggered`
- `resolved_by`
- `belongs_to_site`
- `authorized_by`

### Temporal Model

- All nodes and edges are versioned with `first_seen_at`, `last_seen_at`, and `changed_at`.
- Drift is represented as delta events linked to impacted nodes.
- Historical traversals are snapshot-consistent at query time.

---

## Policy Engine and Guardrails

### Policy Inputs

- Device autonomy tier
- Environment label (`prod`, `staging`, `dev`, `lab`)
- Maintenance window and freeze calendar
- Action risk score
- Required approvals by action class

### Action Classes

- **Class A (Read-only):** safe inventory and diagnostics
- **Class B (Low risk):** restarts, retries, cache/tmp cleanup
- **Class C (Medium risk):** package updates, config changes with rollback
- **Class D (High risk):** firewall edits, failover, storage operations

### Decision Outcomes

- `ALLOW_AUTO`
- `REQUIRE_APPROVAL`
- `DENY`

### Safety Gates

- Preflight checks must pass before execution.
- Postflight validation must confirm expected outcome.
- If validation fails, rollback is automatic when available.
- On repeated failure, action is quarantined and escalated.

---

## Playbook Model

Each remediation is a typed playbook:

- Metadata: action class, blast radius estimate, timeout budget
- Preconditions: required protocols, privileges, health thresholds
- Steps: deterministic commands/API calls
- Verification: objective success criteria
- Rollback: inverse steps and fallback strategy
- Evidence: logs, command output, metrics diff

### Example Playbook Families

- Service recovery (`systemd`, Docker, Windows Service Manager)
- Certificate renewal (ACME DNS-01/HTTP-01)
- Backup retry and verification
- Disk pressure relief and cleanup
- Patch orchestration with maintenance windows
- Config backup + restore for network gear

---

## Incident Severity and SLOs

### Severity Model

- **Critical:** active outage, data risk, or severe security exposure
- **Warning:** degraded capacity, elevated risk, pending expiration
- **Info:** advisory optimization and hygiene findings

### SLO Targets (Default)

- Critical detection in < 60 seconds for managed assets
- Critical diagnosis hypothesis in < 5 minutes
- Critical remediation start in < 2 minutes if auto-allowed
- Daily digest delivered by 09:00 local time

### Error Budget Policy

- False-critical budget is capped monthly.
- Exceeding budget tightens anomaly thresholds and requires review.

---

## Notifications and Approvals

### Channels

- In-app inbox
- Email digest
- Slack/Teams
- SMS/push for critical only

### Approval UX Requirements

- One-click approve/deny with risk summary
- TTL on pending approvals
- Escalation path if no response (delegate or safe fallback)
- Mandatory "why" for denied high-severity actions

---

## Security and Compliance Requirements

### Cryptography and Secrets

- Vault encryption: AES-256-GCM
- Key derivation: memory-hard KDF (scrypt/Argon2)
- Per-secret DEKs wrapped by rotating KEKs
- Optional hardware-backed key mode (TPM/YubiKey/HSM)

### Identity and Access

- Local users + SSO (OIDC/SAML) support
- RBAC roles: `Owner`, `Admin`, `Operator`, `Auditor`, `ReadOnly`
- Just-in-time elevation for sensitive operations

### Auditability

- Immutable append-only audit stream
- Signed action bundles (who, what, when, why, result)
- Export format: JSONL + optional syslog forwarder

### Compliance Alignment (Target)

- SOC 2 security controls mapping
- CIS benchmark checks for supported OS families
- Configurable data retention and redaction policy

---

## Reliability and Performance Targets

- Steward control plane uptime target: 99.9% on supported deployments
- Discovery freshness target: < 5 minutes for active segments
- Query response target (P95): < 2 seconds for common conversational requests
- State durability: local persistent storage with checksummed snapshots
- Graceful degradation: if LLM/provider unavailable, core monitoring/remediation remains functional

---

## Extensibility Model

### Adapter SDK

- Protocol adapters implement a common capability contract.
- Required methods: `detect`, `collect`, `act`, `verify`, `rollback` (optional).
- Capability manifests declare required permissions and risk profiles.

### Marketplace Direction

- Signed adapter bundles
- Version compatibility matrix
- Per-adapter isolation and execution limits

---

## API Surface (Product-Level)

### Core Resources

- Devices
- Services
- Incidents
- Recommendations
- Policies
- Playbooks
- Audit events

### Design Principles

- Resource-oriented JSON APIs
- Idempotent remediation endpoints
- Streaming events for live status
- Explicit permission scopes per endpoint

---

## UX and Information Architecture

### Primary Views

- **Inbox:** prioritized feed of incidents, approvals, and suggestions
- **Network Map:** topology + dependency overlays
- **Device Detail:** health, history, controls, and recent actions
- **Incidents:** timeline, diagnosis, remediation, postmortem
- **Policies:** autonomy tiers, windows, approvals, and exceptions
- **Reports:** daily/weekly operational summary

### Design Requirements

- High signal density without graph overload
- Plain-language summaries with linked evidence
- Every recommendation shows expected impact and risk
- Every action is traceable and reversible when possible

---

## Reporting

### Daily Briefing

- Overnight incidents and auto-remediations
- New risks (expiring certs, failed backups, vulnerable firmware)
- Pending approvals and aging tasks
- Top 3 recommendations by impact

### Weekly Executive Summary

- Availability and incident trend
- Security posture delta
- Capacity and performance highlights
- Recommended next investments

---

## Deployment and Operations

### Installation Modes

- Docker single-node (default)
- Lightweight VM image
- Kubernetes deployment (advanced)

### Upgrade Strategy

- In-place rolling upgrade with schema migration safeguards
- Automatic backup before version transitions
- Compatibility check for adapters and policies

### Backup and Restore

- Scheduled encrypted backups of graph, config, and vault metadata
- Point-in-time restore for state and incident history
- Restore validation checklist built into onboarding

---

## Phased Delivery Plan

### Phase 0: Foundation (Complete in current repo baseline)

- Core loop, discovery, state, vault, chat interface
- Basic incidents and recommendations

### Phase 1: Trustworthy Autonomy

- Policy engine + action classes
- Typed playbooks with verification/rollback
- Approval workflows and richer audit trails

### Phase 2: Production Integrations

- First-party adapters for UniFi, Synology, Proxmox, pfSense
- Backup verification and certificate automation packs
- Multi-channel notification delivery

### Phase 3: Multi-Site and MSP

- Federation control plane
- Tenant isolation and delegated administration
- Cross-site reporting and policy inheritance

### Phase 4: Optimization Intelligence

- Predictive failure/risk forecasting
- Capacity planning and lifecycle recommendations
- Procurement-ready hardware/software suggestions

---

## Acceptance Criteria (v1)

- Install to first meaningful incident/recommendation in < 30 minutes.
- Steward can manage a mixed network of at least 50 devices with stable performance.
- At least 5 remediation playbooks support preflight, execution, verification, and rollback.
- All actions are auditable and attributable.
- Critical alerts maintain low false-positive rate under representative test conditions.
- Daily digest provides sufficient context for non-technical operators.

---

## Key Risks and Mitigations

- **Risk:** Over-automation causes unintended disruption.  
  **Mitigation:** strict policy gates, simulation mode, progressive autonomy defaults.

- **Risk:** Device/protocol heterogeneity breaks reliability.  
  **Mitigation:** adapter certification suite and confidence-scored capabilities.

- **Risk:** Credential compromise impact is high.  
  **Mitigation:** vault hardening, hardware-backed keys, least-privilege onboarding.

- **Risk:** User trust erosion from noisy alerts.  
  **Mitigation:** adaptive baselines, false-positive budget, digest-first UX.

---

## Open Questions

- Should Steward include optional lightweight endpoint agents for richer telemetry, while keeping agentless as default?
- What minimum adapter set is required for a credible "works out of the box" launch?
- How should data retention defaults vary between homelab, SMB, and MSP deployments?
- What legal/compliance commitments are needed before multi-tenant cloud relay GA?

---

## Proposed Defaults (v1 Decisions)

These defaults turn the open questions into an implementable baseline for v1 while keeping room for expansion.

### Agent Strategy

- Agentless-by-default across all supported environments.
- Optional lightweight endpoint helper is explicitly post-v1 and only for deep telemetry and local remediation acceleration.
- No core feature in v1 may require endpoint helper installation.

### Minimum Adapter Pack for "Works Out of the Box"

- Linux via SSH (`systemd`, package status, disk/service checks)
- Windows via WinRM (service status, patch state, event log subset)
- SNMP for switches/printers/UPS (inventory + health)
- HTTP(S) generic appliance adapter (read-only scrape + health checks)
- Docker host adapter (container inventory, health, restart actions)

### Data Retention Defaults by Deployment Type

- **Homelab:** metrics 30 days, incidents 180 days, audit 365 days.
- **SMB:** metrics 90 days, incidents 365 days, audit 2 years.
- **MSP:** metrics 180 days, incidents 2 years, audit 3 years (tenant-configurable).
- Retention is policy-driven and persisted in DB-backed settings.

### Cloud Relay Compliance Gate (Before GA)

- Baseline SOC 2 Type I controls documented and independently reviewed.
- Tenant isolation threat model completed with pen-test findings remediated.
- Regional data residency controls and retention policy enforcement validated.
- Customer-visible audit export and key-rotation procedures generally available.

---

## Configuration and State Model (DB-Backed)

Steward configuration is state, not process environment. All tunables are persisted in SQLite and exposed via internal services and APIs.

### Configuration Domains

- **System:** node identity, timezone, digest schedule, upgrade channel.
- **Policy:** autonomy tiers, action class gates, maintenance windows, freeze periods.
- **Discovery:** scan scope, cadence caps, passive/active enablement, deny-lists.
- **Notifications:** channel bindings, routing rules, escalation paths, quiet hours.
- **Retention:** metrics, incidents, evidence, audit, redaction/TTL behavior.

### Required Configuration Behaviors

- Versioned settings with `effective_from` timestamps.
- Atomic updates with validation and schema constraints.
- Audit event emitted for every settings mutation.
- Read path supports "current" and "as-of" historical evaluation.

---

## Canonical Entity Shape (v1)

The graph is the conceptual model; v1 persistence may blend relational tables with graph projections.

### Device

- Identity: stable `device_id`, `site_id`, observed addresses, vendor/model.
- Classification: `device_type`, `os_family`, confidence score, management protocols.
- State: health summary, last contact, autonomy tier, criticality tag.

### Service

- Identity: `service_id`, host `device_id`, service type, endpoint/port.
- State: availability, latency/error baseline, version/build metadata.
- Risk: exposure level, dependency count, vuln posture summary.

### Incident

- Identity: `incident_id`, severity, status, first/last observed.
- Investigation: hypotheses, confidence, affected nodes, evidence references.
- Outcome: remediation action, approval path, verification result, postmortem note.

### PlaybookRun

- Identity: `run_id`, playbook family/version, triggering condition.
- Execution: preflight result, step timeline, idempotency key.
- Result: success/failure/quarantined, rollback status, evidence bundle URI.

---

## API Contract Sketch (v1)

### Core Endpoint Patterns

- `GET /api/devices` with filters (`site`, `risk`, `managed`, `stale`).
- `GET /api/incidents` with severity/status/time range pagination.
- `POST /api/incidents/{id}/approve` and `POST /api/incidents/{id}/deny`.
- `POST /api/playbook-runs` for gated/manual execution with dry-run support.
- `GET /api/audit-events` as cursor-based immutable stream.

### Contract Requirements

- Idempotency supported for mutating endpoints with caller-supplied keys.
- Every mutation returns affected resource plus generated audit reference.
- Permission scopes enforced per endpoint and reflected in error payloads.
- Time values are UTC ISO-8601; all list endpoints are cursor-paginated.

### Event Streaming

- Server-sent events for inbox updates, incident state transitions, and approvals.
- Backpressure-safe consumer cursors and replay from last acknowledged offset.

---

## Decisioning and Remediation Flow (Executable Semantics)

### Decision Inputs

- Incident severity/confidence
- Target device criticality and environment label
- Action class risk and rollback availability
- Current maintenance/freeze state
- Historical failure rate for similar playbook runs

### Deterministic Decision Order

1. Validate action preconditions and required credentials.
2. Evaluate hard denies (policy, freeze, missing rollback for risky classes).
3. Evaluate approval requirements.
4. If auto-allowed, execute with preflight -> run -> postflight.
5. On postflight failure, trigger rollback; quarantine on repeated failure.

### Escalation Rules

- Approval timeout routes to delegate chain or safe fallback.
- Repeated quarantines auto-create recommendation to adjust policy/playbook.
- Critical unresolved incidents force notification escalation across channels.

---

## Validation and Test Strategy

### Test Layers

- **Unit:** policy decisions, parser/normalizer logic, risk scoring.
- **Integration:** adapter contracts (`detect`, `collect`, `act`, `verify`).
- **Scenario:** incident pipelines in simulated mixed-network lab fixtures.
- **Resilience:** provider outage, partial network partitions, DB recovery.

### Required v1 Test Artifacts

- Golden-path "first 30 minutes" fixture with expected milestones.
- Five playbook families with success + rollback path coverage.
- False-positive benchmark suite for critical anomaly triggers.
- Permission matrix tests for all API mutation endpoints.

### Release Gates

- Acceptance criteria in this spec must pass in CI/staging.
- Migration and backup/restore validation required for every release candidate.
- No release if critical playbook quarantine rate exceeds error budget.

---

## Observability of Steward Itself

Steward must monitor its own health with the same rigor it applies to managed infrastructure.

### Control Plane Health Signals

- Loop cadence lag, queue depth, action success rate, quarantine count.
- Adapter error rates by protocol/vendor.
- Notification delivery success and approval latency distributions.
- DB/vault operation latency and failure rates.

### Self-Protection Behaviors

- Automatic degrade mode when dependencies fail (LLM/provider/adapter outage).
- Rate limiting and circuit breakers on unstable integrations.
- Read-only safe mode for persistent postflight validation failures.

### Operator-Facing Transparency

- Dedicated "Steward Health" view with active degradations and impact.
- Plain-language explanation when autonomy is reduced automatically.
