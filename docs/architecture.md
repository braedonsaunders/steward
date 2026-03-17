# Steward Architecture

Steward is a self-hosted IT operations control plane for small networks. It combines continuous discovery, a durable local control plane, graph-backed state, policy-gated remediation, and a conversational operator interface.

## Core model

Steward runs as a local-first system:

- SQLite stores product state, graph projections, settings history, runtime leases, missions, approvals, and audit metadata.
- A separate audit database stores durable jobs and append-only audit events.
- The vault stores credentials and provider secrets encrypted at rest.
- The UI and JSON APIs are served from the same Next.js application that hosts the control plane.

## Control plane

The runtime is organized around durable jobs instead of timer-bound inline work.

- `scanner.discovery` drives discovery and inventory refresh.
- `monitor.execute` and `agent.assurance` drive assurance evaluation.
- `agent.wake` drives periodic agent review.
- `playbook.execute` drives queued remediation after policy approval or auto-allow.
- notification delivery runs through durable jobs as well.

This makes monitoring, remediation, and notifications resumable and observable from the same queue model.

## Discovery pipeline

Steward combines passive and active discovery:

- passive observation from ARP, mDNS, SSDP, packet hints, and browser observation
- active ICMP and nmap sweeps
- reverse DNS and service fingerprinting
- protocol negotiation for SSH, WinRM, SNMP, HTTP(S), MQTT, WebSocket, SMB, WMI, PowerShell-over-SSH, RDP, and VNC-backed remote access

Discovered devices are persisted with evidence, services, management surfaces, and graph relationships.

## State model

Steward persists both relational state and graph projections.

- devices, incidents, recommendations, approvals, playbook runs, missions, investigations, adapters, widgets, and settings live in relational tables
- graph projections map devices, sites, subnets, services, workloads, assurances, access methods, and profiles into nodes and edges
- graph node and edge versions preserve temporal history for change review and incident context
- metric series and metric samples persist time-series evidence for latency and assurance scoring

## Learn and diagnosis layers

Steward's learn phase records time-series samples and updates baselines:

- device latency is recorded as a metric series
- assurance outcomes are recorded as a metric series
- latency anomalies are routed into findings and incidents when the sample materially exceeds historical bounds
- graph versions and metric samples provide evidence for "what changed" and "what was abnormal"

## Streaming model

The initial state loads from `/api/state`. Live updates then use section-based SSE patches from `/api/state/stream`.

- the server computes cheap per-section revisions
- only changed sections are hydrated and streamed
- the client merges patches into the last full state

This replaces the previous full-state JSON push loop and reduces unnecessary reads and wire churn.

## Policy and remediation

Playbooks are deterministic remediation units with:

- typed action classes
- policy evaluation
- approval TTLs and escalation
- verification steps
- rollback steps
- failure quarantine

Approved or auto-allowed runs are queued onto the durable job plane and executed by the control plane worker.

## Extensibility

Steward supports two extension surfaces:

- adapters for discovery, control, and tool-backed operations
- packs for operational knowledge and reusable policy/runtime assets

Packs can contribute subagents, mission templates, workload and assurance templates, findings, investigations, playbooks, reports, gateway templates, adapters, and tools.

## Public release posture

Steward is designed for:

- single-site deployments first
- local operation without cloud dependency
- DB-backed configuration only
- auditable actions and durable state transitions

Product behavior must not depend on environment variables.
