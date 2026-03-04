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
| Stars | ~84k |
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

### Beszel

| | |
|---|---|
| GitHub | [henrygd/beszel](https://github.com/henrygd/beszel) |
| Stars | ~16.5k |
| License | MIT |
| Target | Homelabs, lightweight server monitoring |

- **Strengths:** Explosively popular (16.5k stars since 2024 launch). Ultra-lightweight hub-and-agent model (6MB RAM/agent, 23MB hub). CPU/RAM/disk/network/Docker stats, S.M.A.R.T. disk health, MFA. Multi-OS.
- **Weaknesses vs Steward:** Monitors known servers only — no network discovery, no AI, no remediation, no diagnosis. Very young project.
- **AI integration:** None.
- **Auto-remediation:** None.

### Prometheus + Grafana

| | |
|---|---|
| GitHub | [prometheus/prometheus](https://github.com/prometheus/prometheus) / [grafana/grafana](https://github.com/grafana/grafana) |
| Stars | ~63k / ~73k |
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

## Tier 4b — Event-Driven Automation & Security

Tools that execute remediation but require separate monitoring inputs. Worth knowing because they represent the "automation engine" pattern.

### StackStorm

| | |
|---|---|
| GitHub | [StackStorm/st2](https://github.com/StackStorm/st2) |
| Stars | ~6.4k |
| License | Apache 2.0 |
| Target | DevOps/SRE teams; "IFTTT for Ops" |

- **Strengths:** Event-driven automation with 160 packs and 6,000+ actions. Sensors → Rules → Workflows → Actions. ChatOps native. Used by NASA, Netflix, Cisco. Linux Foundation project.
- **Weaknesses vs Steward:** Requires separate monitoring tools to generate events. All automation is rule-based, not LLM-reasoned. Complex to configure. Significant infrastructure overhead. Not viable for non-technical operators.
- **AI integration:** None native (community LLM integrations emerging).
- **Auto-remediation:** Yes — powerful, but scripted/rule-based only.

### Wazuh

| | |
|---|---|
| GitHub | [wazuh/wazuh](https://github.com/wazuh/wazuh) |
| Stars | ~12.7k |
| License | GPL v2 |
| Target | Security teams, SOC, compliance |

- **Strengths:** Unified XDR + SIEM. File integrity monitoring, vulnerability detection, intrusion detection, compliance (PCI-DSS, GDPR, HIPAA, NIST). Active response agents can block IPs, kill processes. AI agent integration added in 2025 for interactive incident queries.
- **Weaknesses vs Steward:** Security-focused — doesn't monitor performance/availability/topology. Active response is rule-based, not LLM-reasoned. Heavy system. Not designed for switches/routers/IoT.
- **AI integration:** Yes — interactive incident queries (2025).
- **Auto-remediation:** Yes — active response scripts on security events.

**Wazuh is interesting as a complementary tool** rather than a direct competitor. Steward handles IT ops; Wazuh handles security. A combined deployment could be powerful.

---

## Tier 5 — AI SRE / Self-Healing Agents

The newest category — closest to Steward's vision, but almost all target cloud/K8s, not physical LANs.

### Stakpak Agent ⚠️ (Watch closely)

| | |
|---|---|
| GitHub | [stakpak/agent](https://github.com/stakpak/agent) |
| Stars | Growing (launched Jul 2025, Product Hunt featured) |
| License | Apache 2.0 |
| Funding | $500K seed (P1 Ventures + 500 Global) |
| Target | DevOps teams, server/application ops |

- **Strengths:** Open-source DevOps agent in Rust. Runs as persistent system service (Autopilot mode). Handles health check failures, TLS cert renewal, secret rotation, K8s debugging, infra code generation. **Key innovation:** 210+ secret types detected and redacted before any LLM sees them (restored only at execution). Cedar policy guardrails block destructive actions. Full audit log + rollback. MCP server support. Supports Claude, GPT-4, self-hosted models.
- **Weaknesses vs Steward:** Server/application-oriented only. No LAN device discovery, no network gear/printer/IoT awareness, no incident management system. Doesn't discover unknown devices on a subnet.
- **AI integration:** Yes — full LLM-powered autonomous execution with guardrails.
- **Auto-remediation:** Yes — e.g., health check failure → finds idle DB connections → restarts app → Slack summary, all autonomously.

**Stakpak is the closest competitor on the "autonomous LLM agent that fixes things while you sleep" axis.** The key difference: Stakpak operates at the server/application layer; Steward operates at the network/device layer. If Stakpak adds LAN discovery, or Steward doesn't ship fast enough, there could be direct collision.

### HolmesGPT (CNCF Sandbox) ⚠️

| | |
|---|---|
| GitHub | [robusta-dev/holmesgpt](https://github.com/robusta-dev/holmesgpt) |
| Stars | ~1,900 |
| License | Apache 2.0 |
| Target | K8s operators, on-call engineers |

- **Strengths:** CNCF Sandbox project (accepted Oct 2025). Agentic troubleshooter that actively decides what data to fetch (Prometheus, Grafana, Datadog, K8s logs, REST APIs), runs targeted queries, iteratively refines hypotheses, reports in plain English with suggested fixes. Co-maintained by Robusta.dev and Microsoft. Supports OpenAI, Anthropic, Azure, Gemini.
- **Weaknesses vs Steward:** Read-only by design (suggestions handed to humans). Cloud/K8s-native only. No LAN discovery, no physical device awareness.
- **AI integration:** Yes — deep LLM-powered investigation with iterative hypothesis refinement.
- **Auto-remediation:** Suggestions only (remediation via Robusta rules).

### NetAlertX (formerly Pi.Alert) ⚠️

| | |
|---|---|
| GitHub | [netalertx/NetAlertX](https://github.com/netalertx/NetAlertX) |
| Stars | ~5.6k |
| License | GPL v3 |
| Target | Homelab, small network operators |

- **Strengths:** Core purpose is exactly LAN device discovery — ARP, DHCP, ping/ICMP, Nmap scanning. Maintains live inventory (MAC, hostname, vendor, open ports). 80+ notification services. Home Assistant + MQTT integration. Plugin system for custom scanners. Docker-first.
- **Weaknesses vs Steward:** Discovery and alerting only — no LLM intelligence, no incident management, no auto-remediation, no conversational interface, no protocol negotiation.
- **AI integration:** None.
- **Auto-remediation:** None.

**NetAlertX is the most direct competitor for Steward's discovery engine.** It does ARP/Nmap discovery very well for 5.6k stars. Steward's value-add is everything that happens *after* discovery: LLM analysis, incident creation, and autonomous remediation.

### OneUptime

| | |
|---|---|
| GitHub | [OneUptime/oneuptime](https://github.com/OneUptime/oneuptime) |
| Stars | ~6k |
| License | Apache 2.0 |
| Target | Teams replacing Datadog + PagerDuty + Statuspage |

- **Strengths:** All-in-one: uptime monitoring, APM, logs, traces, on-call scheduling, escalation policies, incident management, status pages. AI agent detects anomalies, does root cause analysis, and opens ready-to-merge PRs with code fixes. Supports OpenAI, Anthropic, Ollama, self-hosted LLMs. Privacy-first.
- **Weaknesses vs Steward:** No agentless LAN discovery (ARP/SNMP). Requires you to configure what to monitor. Application/web-service focused, not network-device focused.
- **AI integration:** Yes — anomaly detection, RCA, automated PR creation.
- **Auto-remediation:** AI creates PRs; human reviews before deploy.

### Coroot

| | |
|---|---|
| GitHub | [coroot/coroot](https://github.com/coroot/coroot) |
| Stars | ~7.1k |
| License | Apache 2.0 |
| Target | DevOps, SREs |

- **Strengths:** Zero-instrumentation observability via eBPF. Combines metrics, logs, traces, continuous profiling, SLO-based alerting. AI-powered root cause analysis. Cloud cost monitoring.
- **Weaknesses vs Steward:** Application/service layer only. No LAN/network device awareness. AI is RCA, not autonomous action.
- **AI integration:** AI-powered root cause analysis.
- **Auto-remediation:** None.

### fuzzylabs/sre-agent

| | |
|---|---|
| GitHub | [fuzzylabs/sre-agent](https://github.com/fuzzylabs/sre-agent) |
| Stars | ~57 (early-stage) |
| License | Open source |
| Target | K8s operators, DevOps |

- **Strengths:** CLI-based AI agent using Anthropic MCP for Kubernetes health, log analysis, issue diagnosis. Architectural reference for MCP-based agents.
- **Weaknesses vs Steward:** K8s-only, no LAN/device discovery, no physical network awareness, CLI-only (no web UI). Demo/research project.

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
       Stakpak (server)  |  OneUptime (app + incident)
                         |
   HolmesGPT (K8s RCA)  |  Coroot (eBPF RCA)
                         |
   Netdata (ML anomaly)  |  OpenObserve (data + AI)
                         |
  ───────────────────────┼──────────────────────── Scope
  Narrow / single-purpose|  Broad / full-stack
                         |
     NetAlertX           |  Zabbix
     (LAN discovery)     |  (enterprise monitoring)
                         |
     Uptime Kuma         |  TacticalRMM
     (uptime)            |  (endpoint management)
                         |
     Prometheus          |  LibreNMS / Checkmk
     (metrics)           |  (network monitoring)
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
3. **Remediation safety** — Autonomous action on production infrastructure is high-stakes. One bad LLM decision could cause real damage. The tiered autonomy model needs to be bulletproof. (Note: Stakpak's approach — secret redaction + Cedar policy guardrails — is worth studying.)
4. **Keep is moving fast** — 11k stars, YC-backed (acquired by Elastic May 2025), adding AI features aggressively. If they move down-market and add discovery, they could encroach on Steward's space.
5. **Netdata's MCP support** — Since v2.6, Netdata functions as an MCP server for AI assistants. If they add remediation actions, the combination of 78k-star observability + AI could be formidable.
6. **Stakpak is the closest archetype** — Same vision (autonomous LLM agent that fixes things while you sleep), different layer (server/app vs. LAN/device). $500K funded, Apache 2.0, Rust-based. If they add network discovery, direct collision.
7. **NetAlertX already does discovery well** — 5.6k stars, Docker-first, ARP/Nmap/DHCP scanning. A user could combine NetAlertX + Keep + Stakpak to approximate Steward's value prop with existing tools. Steward's advantage is the integrated experience.
8. **CNCF legitimacy** — HolmesGPT is now a CNCF Sandbox project (co-maintained with Microsoft). CNCF endorsement creates enterprise trust that's hard to replicate as an indie project.
9. **StackStorm + LLM** is an obvious combination someone will build. StackStorm's 6,000+ actions + an LLM front-end would cover much of Steward's remediation surface for teams with DevOps expertise.
10. **Beszel's growth trajectory** — 16.5k stars in ~1 year shows the homelab community's appetite for simple monitoring. If Beszel adds AI features, it could capture Steward's target audience before Steward gets there.

---

## Full Comparison Table

| Tool | LAN Discovery | LLM Intelligence | Auto-Remediate | Incident Mgmt | Stars | Category |
|---|---|---|---|---|---|---|
| **Stakpak** | No | Yes (full) | Yes (guardrailed) | No | ~1.1k | DevOps Agent |
| **HolmesGPT** | No | Yes (deep K8s) | Suggestions only | Via integrations | ~1.9k | SRE AI Agent |
| **Keep** | No | Alert correlation | Workflow-based | Yes | ~11.2k | AIOps (YC/Elastic) |
| **OneUptime** | Partial | Yes (code fixes) | PR creation | Yes (full) | ~6k | Obs + Incident |
| **Wazuh** | No | Yes (queries) | Yes (active resp.) | Security events | ~12.7k | XDR/SIEM |
| **Coroot** | No | AI RCA | No | No | ~7.1k | APM/Obs |
| **NetAlertX** | Yes (ARP/Nmap) | MCP (early) | No | No | ~5.9k | LAN Discovery |
| **Netdata** | No (per-node) | ML + AI Co-Eng. | Suggests only | No | ~78k | Monitoring |
| **Zabbix** | Yes (SNMP) | ML (emerging) | Script-based | No | ~5.7k | NMS |
| **LibreNMS** | Yes (SNMP) | No | No | No | ~4.6k | NMS |
| **StackStorm** | No | No | Yes (event-driven) | No | ~6.4k | Automation |
| **TacticalRMM** | No (agent-dep.) | No | Script-based | No | ~4.1k | RMM |
| **Beszel** | No | No | No | No | ~16.5k | Homelab |
| **Uptime Kuma** | No | No | No | No | ~84k | Uptime |
| **Prometheus** | No | No | No | No | ~63k | Metrics |

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
- [Stakpak Agent GitHub](https://github.com/stakpak/agent)
- [HolmesGPT GitHub](https://github.com/robusta-dev/holmesgpt)
- [CNCF: HolmesGPT Sandbox](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/)
- [NetAlertX GitHub](https://github.com/netalertx/NetAlertX)
- [OneUptime GitHub](https://github.com/OneUptime/oneuptime)
- [Coroot GitHub](https://github.com/coroot/coroot)
- [Microsoft AIOpsLab](https://github.com/microsoft/AIOpsLab)
- [SigNoz GitHub](https://github.com/SigNoz/signoz)
- [StackStorm GitHub](https://github.com/StackStorm/st2)
- [Wazuh GitHub](https://github.com/wazuh/wazuh)
- [Beszel GitHub](https://github.com/henrygd/beszel)
- [n8n GitHub](https://github.com/n8n-io/n8n)
- [Ennetix: Autonomous IT Operations 2026](https://ennetix.com/the-rise-of-autonomous-it-operations-what-aiops-platforms-must-enable-by-2026/)
