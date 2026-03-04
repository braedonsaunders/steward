# Steward — OSS Competitive Landscape

_Last updated: 2026-03-04_

## Executive Summary

Steward occupies a unique niche: a **self-hosted, LLM-powered, autonomous IT operations agent** for small networks. No single OSS project directly replicates this combination. The competitive field breaks into five tiers, each overlapping with parts of Steward's value proposition but missing others.

| Tier | What they do | What Steward adds |
|---|---|---|
| Traditional monitors | Collect metrics, fire alerts | LLM intelligence, auto-remediation, conversational UI |
| Homelab dashboards | Status pages, uptime checks | Device discovery, incident management, autonomous action |
| Open-source RMM | Remote control, patching | AI-powered diagnostics, zero-config discovery, single-agent simplicity |
| AIOps platforms | Alert correlation, noise reduction | LAN-first discovery, self-hosted simplicity, small-network focus |
| AI SRE agents | Self-healing infra (K8s/cloud) | Physical network awareness, device-level ops, non-cloud targets |

**Bottom line:** The market is crowded with monitoring tools and nascent AI agents, but nothing ties together LAN discovery + LLM reasoning + autonomous remediation + small-business simplicity the way Steward aims to.

---

## Tier 1 — Traditional Network Monitoring

These are the incumbents. Mature, battle-tested, enormous communities — but fundamentally **passive observe-and-alert** tools with no AI layer.

### Zabbix

| | |
|---|---|
| GitHub | [zabbix/zabbix](https://github.com/zabbix/zabbix) |
| Stars | ~4k |
| License | GPL v2 |
| Target | Enterprise / hybrid environments |

- **Strengths:** Scales to 15k+ devices, auto-discovery, rich template ecosystem, modern web UI, appliance ISO for quick start.
- **Weaknesses vs Steward:** Steep config curve (days of setup), no AI/LLM integration, no autonomous remediation, no conversational interface. Aimed at teams that already have IT staff.
- **AI integration:** None.
- **Auto-remediation:** Manual scripts only.

### Nagios Core

| | |
|---|---|
| GitHub | [NagiosEnterprises/nagioscore](https://github.com/NagiosEnterprises/nagioscore) |
| Stars | ~2k |
| License | GPL v2 |
| Target | Linux/Unix shops, legacy environments |

- **Strengths:** 25+ year track record, 5,000+ plugins, maximum customizability.
- **Weaknesses vs Steward:** Extremely steep learning curve, dated UI, no AI, no auto-discovery without plugins, no remediation. Requires significant ops expertise.
- **AI integration:** None.
- **Auto-remediation:** Via custom event handlers (manual scripting).

### LibreNMS

| | |
|---|---|
| GitHub | [librenms/librenms](https://github.com/librenms/librenms) |
| Stars | ~4k |
| License | GPL v3 |
| Target | Network-centric / SNMP-heavy environments, ISPs, MSPs |

- **Strengths:** Native SNMP auto-discovery, 10k+ device library, multi-tenant, mobile apps, bandwidth billing. Easiest setup of the traditional monitors.
- **Weaknesses vs Steward:** SNMP-focused (limited protocol breadth), no AI, no remediation, no conversational interface. Still requires network expertise.
- **AI integration:** None.
- **Auto-remediation:** None.

### Icinga 2

| | |
|---|---|
| GitHub | [Icinga/icinga2](https://github.com/Icinga/icinga2) |
| Stars | ~2.2k |
| License | GPL v2 |
| Target | Teams needing distributed, highly customizable monitoring |

- **Strengths:** Nagios-compatible plugin ecosystem, distributed architecture, strong clustering, Icinga Director for rule-based config.
- **Weaknesses vs Steward:** Complex setup requiring deep sysadmin knowledge, no AI, no autonomous action. Often requires layering on Grafana, InfluxDB, etc.
- **AI integration:** None.
- **Auto-remediation:** Event commands (manual scripting).

### Checkmk (Raw Edition)

| | |
|---|---|
| GitHub | [Checkmk/checkmk](https://github.com/Checkmk/checkmk) |
| Stars | ~2.2k |
| License | GPL v2 (Raw Edition) |
| Target | Teams wanting turnkey monitoring with minimal config |

- **Strengths:** Automatic service discovery, 2,000+ pre-configured checks, web-based config GUI, faster time-to-value than Nagios/Icinga.
- **Weaknesses vs Steward:** No AI/LLM layer, no conversational interface, no autonomous remediation. Commercial editions needed for advanced features.
- **AI integration:** None.
- **Auto-remediation:** None native.

---

## Tier 2 — Homelab / Lightweight Monitoring

Popular with the self-hosting community. Simple, beautiful, but narrow in scope.

### Uptime Kuma

| | |
|---|---|
| GitHub | [louislam/uptime-kuma](https://github.com/louislam/uptime-kuma) |
| Stars | ~65k+ |
| License | MIT |
| Target | Self-hosters, homelab enthusiasts |

- **Strengths:** Beautiful UI, dead-simple setup, HTTP/TCP/ping/DNS/Docker monitoring, 90+ notification integrations, status pages.
- **Weaknesses vs Steward:** Uptime-only (no device discovery, no incident management, no remediation, no AI). It checks if things are "up" — nothing more.
- **AI integration:** None.
- **Auto-remediation:** None.

### Netdata

| | |
|---|---|
| GitHub | [netdata/netdata](https://github.com/netdata/netdata) |
| Stars | ~78k |
| License | GPL v3 (agent), NCUL1 (dashboard) |
| Target | DevOps, SREs, homelab power users |

- **Strengths:** Zero-config auto-discovery, per-second granularity, 850+ integrations, unsupervised ML anomaly detection (18 models, 99% false-positive reduction), MCP server support (v2.6+), edge-native architecture.
- **Weaknesses vs Steward:** Observability-only — no incident management, no remediation actions, no conversational interface. ML is anomaly-flagging, not autonomous decision-making. Homelab plan is free but Cloud features are gated.
- **AI integration:** ML-based anomaly detection, MCP server for AI assistant queries (since v2.6/2.9).
- **Auto-remediation:** None.

**Netdata is the closest Tier 2 competitor** — its ML and MCP support put it on the AI spectrum, but it stops at "detect and visualize" while Steward aims to "detect, diagnose, and fix."

### Prometheus + Grafana

| | |
|---|---|
| GitHub | [prometheus/prometheus](https://github.com/prometheus/prometheus) / [grafana/grafana](https://github.com/grafana/grafana) |
| Stars | ~57k / ~67k |
| License | Apache 2.0 / AGPL v3 |
| Target | Cloud-native, Kubernetes, DevOps |

- **Strengths:** Industry standard for metrics, massive ecosystem, PromQL, rich visualization, alerting via Alertmanager.
- **Weaknesses vs Steward:** Pull-based model assumes you configure exporters (no LAN discovery), steep PromQL learning curve, no remediation, no AI. Designed for cloud-native, not physical network gear.
- **AI integration:** None native (Grafana has some AI features in Cloud tier).
- **Auto-remediation:** None.

---

## Tier 3 — Open-Source RMM (Remote Monitoring & Management)

These compete with commercial MSP tools (ConnectWise, NinjaRMM, Datto). Agent-based, endpoint-focused.

### TacticalRMM

| | |
|---|---|
| GitHub | [amidaware/tacticalrmm](https://github.com/amidaware/tacticalrmm) |
| Stars | ~4.1k |
| License | Tactical RMM License (source-available) |
| Target | MSPs, small IT teams managing endpoints |

- **Strengths:** Remote desktop/shell/file browser, automated checks (CPU/disk/memory/services), automated task runner, Windows patch management, Chocolatey software deployment, SSO support.
- **Weaknesses vs Steward:** Requires agent installation on every endpoint (no agentless network discovery), no AI/LLM integration, no conversational interface, Windows-centric. More "remote control" than "autonomous IT."
- **AI integration:** None.
- **Auto-remediation:** Script-based automated tasks (manual setup).

### MeshCentral

| | |
|---|---|
| GitHub | [Ylianst/MeshCentral](https://github.com/Ylianst/MeshCentral) |
| Stars | ~4.5k |
| License | Apache 2.0 |
| Target | Remote management / remote desktop |

- **Strengths:** Full remote desktop, terminal, file transfer. Cross-platform. Used as the remote access backbone for TacticalRMM.
- **Weaknesses vs Steward:** Pure remote access tool — no monitoring, no discovery, no AI, no incident management.
- **AI integration:** None.
- **Auto-remediation:** None.

---

## Tier 4 — AIOps & Alert Management Platforms

The emerging AI-native ops layer. Most target enterprise scale and cloud environments.

### Keep (keephq)

| | |
|---|---|
| GitHub | [keephq/keep](https://github.com/keephq/keep) |
| Stars | ~11.2k |
| License | MIT (core), proprietary (enterprise) |
| Target | Enterprise ops teams drowning in alerts |

- **Strengths:** Single pane of glass for alerts from 100+ integrations, AI-powered alert correlation and deduplication, declarative YAML workflows ("GitHub Actions for monitoring"), incident resolution AI assistant, SSO/RBAC/ABAC, K8s/Docker/ECS deployment.
- **Weaknesses vs Steward:** Aggregation layer — requires existing monitoring tools to feed it. No device discovery, no network awareness, no autonomous remediation of infrastructure. Enterprise-focused, not small-business friendly.
- **AI integration:** Yes — correlation, summarization, incident resolution assistant (OpenAI-powered).
- **Auto-remediation:** Workflow-based (YAML-defined), not autonomous.

**Keep is the most interesting competitive signal.** It proves demand for AI in ops, but it sits on top of existing monitoring rather than replacing it. Steward is the full stack.

### OpenObserve

| | |
|---|---|
| GitHub | [openobserve/openobserve](https://github.com/openobserve/openobserve) |
| Stars | ~14k+ |
| License | AGPL v3 |
| Target | Teams replacing Elasticsearch/Datadog for logs, metrics, traces |

- **Strengths:** 140x lower storage costs than Elasticsearch, petabyte-scale observability, O2 AI Agent for semantic analysis.
- **Weaknesses vs Steward:** Data platform, not an operations agent. No device discovery, no incident management, no remediation. Requires instrumentation.
- **AI integration:** O2 AI Agent for analysis.
- **Auto-remediation:** None.

---

## Tier 5 — AI SRE / Self-Healing Agents

The newest category — closest to Steward's vision, but almost all target cloud/K8s, not physical LANs.

### fuzzylabs/sre-agent

| | |
|---|---|
| GitHub | [fuzzylabs/sre-agent](https://github.com/fuzzylabs/sre-agent) |
| Stars | Small (early-stage) |
| License | Open source |
| Target | K8s operators, DevOps |

- **Strengths:** CLI-based AI agent for Kubernetes health, log analysis, issue diagnosis.
- **Weaknesses vs Steward:** K8s-only, no LAN/device discovery, no physical network awareness, CLI-only (no web UI).

### Autonomous-AI-powered-SRE-Agent

| | |
|---|---|
| GitHub | [Mrgig7/Autonomous-Al-powered-SRE-Agent](https://github.com/Mrgig7/Autonomous-Al-powered-SRE-Agent) |
| Stars | Small (early-stage) |
| License | Open source |
| Target | CI/CD pipeline self-healing |

- **Strengths:** Auto failure detection, AI root cause analysis, patch generation, sandbox validation, multi-CI integration (GitHub Actions, GitLab, Jenkins).
- **Weaknesses vs Steward:** CI/CD-focused, not infrastructure-focused. No device/network awareness.

### SmythOS SRE

| | |
|---|---|
| GitHub | [SmythOS/sre](https://github.com/SmythOS/sre) |
| Stars | Small |
| License | Open source |
| Target | Developers building custom AI agents |

- **Strengths:** Cloud-native runtime for agentic AI, unified API across LLM providers, modular architecture.
- **Weaknesses vs Steward:** Framework/runtime, not a product. You build agents on it; it doesn't monitor your network out of the box.

### CrewAI

| | |
|---|---|
| GitHub | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) |
| Stars | ~30k+ |
| License | MIT |
| Target | Developers building multi-agent systems |

- **Strengths:** Popular agent orchestration framework, multi-agent coordination, memory sharing, self-hosted.
- **Weaknesses vs Steward:** General-purpose agent framework — requires building everything on top. No IT ops features out of the box.

---

## Competitive Positioning Map

```
                    AI / Autonomous
                         ^
                         |
              Keep       |  *** STEWARD ***
            (alerts)     |  (full-stack autonomous IT)
                         |
         OpenObserve     |  fuzzylabs/sre-agent
            (data)       |  (K8s self-healing)
                         |
   Netdata (ML anomaly)  |
                         |
  ───────────────────────┼──────────────────────── Scope
  Narrow / single-purpose|  Broad / full-stack
                         |
         Uptime Kuma     |  Zabbix
          (uptime)       |  (enterprise monitoring)
                         |
         Prometheus      |  TacticalRMM
          (metrics)      |  (endpoint management)
                         |
                         |  LibreNMS / Checkmk
                         |  (network monitoring)
                         |
                    Manual / Alert-only
```

---

## Key Differentiators for Steward

1. **LAN-first auto-discovery** — ARP + nmap + mDNS, not cloud APIs. No agents to install.
2. **LLM-powered reasoning** — Not just anomaly detection (Netdata) or alert correlation (Keep), but natural-language diagnosis and remediation planning.
3. **Conversational interface** — Ask "why is the printer offline?" instead of writing PromQL.
4. **Autonomous remediation with tiered autonomy** — Observe / safe-auto / full-auto per device. No other OSS tool has this graduated model.
5. **Single-binary simplicity** — Docker run and go. No Prometheus + Grafana + Alertmanager + custom scripts assembly required.
6. **Multi-provider LLM support** — 14+ providers including local (Ollama, LM Studio). Air-gap friendly.
7. **Target audience alignment** — Built for the "no IT department" use case. Every competitor either targets enterprises or requires sysadmin expertise.

## Key Risks / Gaps

1. **Community & mindshare** — Netdata has 78k stars, Uptime Kuma 65k. Steward is starting from zero. Discovery and trust are hard.
2. **Breadth of integrations** — Zabbix/Nagios have thousands of plugins. Steward's protocol coverage is nascent.
3. **Remediation safety** — Autonomous action on production infrastructure is high-stakes. One bad LLM decision could cause real damage. The tiered autonomy model needs to be bulletproof.
4. **Keep is moving fast** — 11k stars, YC-backed, adding AI features aggressively. If they move down-market and add discovery, they could encroach on Steward's space.
5. **Netdata's MCP support** — Since v2.6, Netdata functions as an MCP server for AI assistants. If they add remediation actions, the combination of 78k-star observability + AI could be formidable.

---

## Sources

- [Uptrace: Best Network Monitoring Tools 2026](https://uptrace.dev/tools/network-monitoring-tools)
- [SigNoz: Zabbix Alternatives](https://signoz.io/comparisons/zabbix-alternatives/)
- [Keep GitHub](https://github.com/keephq/keep)
- [Netdata GitHub](https://github.com/netdata/netdata)
- [TacticalRMM GitHub](https://github.com/amidaware/tacticalrmm)
- [fuzzylabs/sre-agent GitHub](https://github.com/fuzzylabs/sre-agent)
- [Uptime Kuma](https://github.com/louislam/uptime-kuma)
- [Unite.AI: Agentic SRE 2026](https://www.unite.ai/agentic-sre-how-self-healing-infrastructure-is-redefining-enterprise-aiops-in-2026/)
- [last9/awesome-sre-agents](https://github.com/last9/awesome-sre-agents)
- [OpenObserve: AIOps Platforms](https://openobserve.ai/blog/top-10-aiops-platforms/)
- [NinjaOne: Open Source RMM Pros & Cons](https://www.ninjaone.com/blog/open-source-rmm-software-for-msps-pros-cons/)
- [Comparitech: Open Source Network Monitoring](https://www.comparitech.com/net-admin/open-source-network-monitoring-tools/)
- [OpenAlternative: Checkmk vs Icinga](https://openalternative.co/compare/checkmk/vs/icinga)
