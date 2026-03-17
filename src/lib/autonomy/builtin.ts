import type {
  MissionKind,
  MissionRecord,
  PackManifest,
  PackRecord,
  SubagentAutonomyPolicy,
  SubagentRecord,
  SubagentScope,
} from "@/lib/autonomy/types";

const nowIso = () => new Date().toISOString();

function builtinPack(input: {
  id: string;
  slug: string;
  name: string;
  description: string;
  resources: PackManifest["resources"];
  tags: string[];
  version?: string;
}): PackRecord {
  const now = nowIso();
  const manifest: PackManifest = {
    slug: input.slug,
    name: input.name,
    version: input.version ?? "1.0.0",
    description: input.description,
    resources: input.resources,
    tags: input.tags,
    stewardCompatibility: {
      minimumVersion: "0.1.0",
    },
  };

  return {
    id: input.id,
    slug: input.slug,
    name: input.name,
    version: manifest.version,
    description: input.description,
    kind: "builtin",
    enabled: true,
    builtin: true,
    trustMode: "builtin",
    signerId: undefined,
    signature: undefined,
    signatureAlgorithm: undefined,
    verificationStatus: "builtin",
    verifiedAt: now,
    manifestJson: manifest,
    installedAt: now,
    updatedAt: now,
  };
}

function scope(
  domain: SubagentScope["domain"],
  input: Omit<SubagentScope, "domain">,
): SubagentScope {
  return {
    domain,
    ...input,
  };
}

function autonomy(
  allowedMissionKinds: MissionKind[],
  input: Partial<SubagentAutonomyPolicy>,
): SubagentAutonomyPolicy {
  return {
    approvalMode: "approval_required",
    allowedMissionKinds,
    channelVoice: "Plain, concise, evidence-backed operational updates.",
    operatingPrinciples: [
      "Prefer deterministic evidence over speculation.",
      "Escalate risk early, but avoid noise.",
      "Keep operators informed in plain language.",
    ],
    autonomyBudget: {
      maxActionsPerHour: 6,
      maxConcurrentInvestigations: 4,
    },
    escalationPolicy: {
      remindAfterMinutes: 30,
      escalateAfterMinutes: 120,
    },
    memoryWindowDays: 30,
    urgency: "medium",
    shadowModeDefault: false,
    ...input,
  };
}

export function builtinPacks(): PackRecord[] {
  return [
    builtinPack({
      id: "pack.core-availability",
      slug: "core-availability",
      name: "Core Availability",
      description: "Mission templates and heuristics for reachability, outage correlation, and device availability.",
      resources: [
        { type: "subagent", key: "availability-operator", title: "Availability Operator" },
        { type: "mission-template", key: "availability-overwatch", title: "Availability Overwatch" },
        { type: "finding-template", key: "availability-finding-policy", title: "Availability finding policy" },
        { type: "investigation-heuristic", key: "availability-investigations", title: "Availability investigation heuristics" },
        { type: "lab", key: "availability-replay", title: "Availability replay scenario" },
      ],
      tags: ["built-in", "availability", "missions"],
    }),
    builtinPack({
      id: "pack.core-certificates",
      slug: "core-certificates",
      name: "Core Certificates",
      description: "Certificate lifecycle monitoring, investigation heuristics, and remediation planning surfaces.",
      resources: [
        { type: "subagent", key: "certificate-operator", title: "Certificate Operator" },
        { type: "mission-template", key: "certificate-watch", title: "Certificate Watch" },
        { type: "finding-template", key: "certificate-expiry-policy", title: "Certificate expiry findings" },
        { type: "investigation-heuristic", key: "certificate-investigations", title: "Certificate investigation heuristics" },
        { type: "report-template", key: "certificate-ops-report", title: "Certificate ops report" },
        { type: "lab", key: "certificate-replay", title: "Certificate replay scenario" },
      ],
      tags: ["built-in", "certificates", "missions"],
    }),
    builtinPack({
      id: "pack.core-backups",
      slug: "core-backups",
      name: "Core Backups",
      description: "Backup freshness, restore confidence, and durable backup follow-up missions.",
      resources: [
        { type: "subagent", key: "backup-operator", title: "Backup Operator" },
        { type: "mission-template", key: "backup-hygiene", title: "Backup Hygiene" },
        { type: "finding-template", key: "backup-staleness-policy", title: "Backup staleness findings" },
        { type: "investigation-heuristic", key: "backup-investigations", title: "Backup investigation heuristics" },
        { type: "report-template", key: "backup-reliability-report", title: "Backup reliability report" },
        { type: "lab", key: "backup-replay", title: "Backup replay scenario" },
      ],
      tags: ["built-in", "backup", "missions"],
    }),
    builtinPack({
      id: "pack.core-storage",
      slug: "core-storage",
      name: "Core Storage",
      description: "Storage pressure, disk health, and durable remediation planning for storage-heavy systems.",
      resources: [
        { type: "subagent", key: "storage-operator", title: "Storage Operator" },
        { type: "mission-template", key: "storage-health", title: "Storage Health" },
        { type: "finding-template", key: "storage-pressure-policy", title: "Storage pressure findings" },
        { type: "investigation-heuristic", key: "storage-investigations", title: "Storage investigation heuristics" },
        { type: "report-template", key: "storage-risk-report", title: "Storage risk report" },
        { type: "lab", key: "storage-replay", title: "Storage replay scenario" },
      ],
      tags: ["built-in", "storage", "missions"],
    }),
    builtinPack({
      id: "pack.core-network-hygiene",
      slug: "core-network-hygiene",
      name: "Core Network Hygiene",
      description: "WAN, network path, and edge hygiene missions for routers, switches, access points, and perimeter gear.",
      resources: [
        { type: "subagent", key: "network-operator", title: "Network Operator" },
        { type: "mission-template", key: "wan-guardian", title: "WAN Guardian" },
        { type: "finding-template", key: "wan-health-policy", title: "WAN health findings" },
        { type: "investigation-heuristic", key: "network-investigations", title: "Network investigation heuristics" },
        { type: "report-template", key: "network-edge-report", title: "Network edge report" },
        { type: "lab", key: "wan-replay", title: "WAN replay scenario" },
      ],
      tags: ["built-in", "network", "missions"],
    }),
    builtinPack({
      id: "pack.telegram-ops",
      slug: "telegram-ops",
      name: "Telegram Ops",
      description: "Telegram-first gateway presence for briefings, approvals, and operator-facing mission updates.",
      resources: [
        { type: "subagent", key: "briefing-operator", title: "Briefing Operator" },
        { type: "mission-template", key: "daily-briefing", title: "Daily Briefing" },
        { type: "gateway-template", key: "telegram-binding", title: "Telegram binding" },
        { type: "briefing-template", key: "telegram-daily-briefing", title: "Telegram briefing delivery" },
        { type: "report-template", key: "telegram-mission-report", title: "Telegram mission report" },
        { type: "tool", key: "telegram-commands", title: "Telegram command surface" },
        { type: "lab", key: "telegram-ops-replay", title: "Telegram ops replay" },
      ],
      tags: ["built-in", "telegram", "gateway"],
    }),
  ];
}

export function builtinSubagents(now = nowIso()): SubagentRecord[] {
  return [
    {
      id: "subagent.availability-operator",
      slug: "availability-operator",
      name: "Availability Operator",
      description: "Owns reachability, outage detection, and online/offline drift across managed devices.",
      status: "active",
      scopeJson: scope("availability", {
        missionKinds: ["availability-guardian"],
        ownsCapabilities: ["reachability", "incident-correlation"],
        ownsDeviceReachability: true,
      }),
      autonomyJson: autonomy(["availability-guardian"], {
        urgency: "high",
        channelVoice: "Be direct about outages, scope, and immediate blast radius.",
        autonomyBudget: {
          maxActionsPerHour: 12,
          maxConcurrentInvestigations: 8,
        },
      }),
      packId: "pack.core-availability",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "subagent.certificate-operator",
      slug: "certificate-operator",
      name: "Certificate Operator",
      description: "Owns TLS lifecycle, expiry awareness, and certificate hygiene.",
      status: "active",
      scopeJson: scope("certificates", {
        missionKinds: ["certificate-guardian"],
        ownsCapabilities: ["tls-inventory", "expiry-tracking", "renewal-readiness"],
        ownsTlsLifecycle: true,
      }),
      autonomyJson: autonomy(["certificate-guardian"], {
        channelVoice: "Explain certificate risk plainly and tie it to user-visible impact.",
      }),
      packId: "pack.core-certificates",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "subagent.backup-operator",
      slug: "backup-operator",
      name: "Backup Operator",
      description: "Owns backup freshness, retry workflows, and restore confidence tracking.",
      status: "active",
      scopeJson: scope("backups", {
        missionKinds: ["backup-guardian"],
        workloadCategories: ["data"],
        ownsCapabilities: ["backup-freshness", "retry-followup", "restore-confidence"],
        ownsBackupState: true,
      }),
      autonomyJson: autonomy(["backup-guardian"], {
        urgency: "high",
        channelVoice: "Frame backup issues in terms of data risk, freshness, and restore confidence.",
      }),
      packId: "pack.core-backups",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "subagent.storage-operator",
      slug: "storage-operator",
      name: "Storage Operator",
      description: "Owns storage pressure, pool health, and disk-related operational drift.",
      status: "active",
      scopeJson: scope("storage", {
        missionKinds: ["storage-guardian"],
        deviceTypes: ["nas", "san", "server", "vm-host", "container-host"],
        ownsCapabilities: ["disk-health", "storage-pressure", "pool-health"],
        ownsDiskHealth: true,
      }),
      autonomyJson: autonomy(["storage-guardian"], {
        urgency: "high",
        channelVoice: "Make storage risk concrete, with timing and capacity pressure called out explicitly.",
      }),
      packId: "pack.core-storage",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "subagent.network-operator",
      slug: "network-operator",
      name: "Network Operator",
      description: "Owns WAN, edge, and network hygiene drift across routers, switches, APs, and firewalls.",
      status: "active",
      scopeJson: scope("network", {
        missionKinds: ["wan-guardian"],
        deviceTypes: ["router", "switch", "access-point", "firewall", "gateway"],
        workloadCategories: ["network", "perimeter"],
        ownsCapabilities: ["wan-health", "edge-hygiene", "network-drift"],
        ownsNetworkHealth: true,
      }),
      autonomyJson: autonomy(["wan-guardian"], {
        urgency: "high",
        channelVoice: "Lead with user impact, blast radius, and what the network is doing now.",
      }),
      packId: "pack.core-network-hygiene",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "subagent.briefing-operator",
      slug: "briefing-operator",
      name: "Briefing Operator",
      description: "Owns operator briefings, morning summaries, and channel-facing mission updates.",
      status: "active",
      scopeJson: scope("briefing", {
        missionKinds: ["daily-briefing"],
        ownsCapabilities: ["briefings", "operator-updates", "channel-presence"],
        ownsBriefings: true,
      }),
      autonomyJson: autonomy(["daily-briefing"], {
        urgency: "medium",
        approvalMode: "safe_autonomy",
        channelVoice: "Summarize only what matters, keep it calm, and point to the evidence.",
        autonomyBudget: {
          maxActionsPerHour: 24,
          maxConcurrentInvestigations: 2,
        },
      }),
      packId: "pack.telegram-ops",
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function builtinMissions(now = nowIso()): MissionRecord[] {
  return [
    {
      id: "mission.availability-overwatch",
      slug: "availability-overwatch",
      title: "Availability Overwatch",
      summary: "Continuously watch device reachability and correlate outages into durable investigations.",
      kind: "availability-guardian",
      status: "active",
      priority: "high",
      objective: "Own online/offline visibility, correlation, and escalation for managed devices.",
      subagentId: "subagent.availability-operator",
      packId: "pack.core-availability",
      cadenceMinutes: 10,
      autoRun: true,
      autoApprove: false,
      shadowMode: false,
      targetJson: {
        selector: {
          allDevices: true,
        },
        incidentTypes: ["availability.offline"],
      },
      stateJson: {},
      nextRunAt: now,
      createdBy: "steward",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "mission.certificate-watch",
      slug: "certificate-watch",
      title: "Certificate Watch",
      summary: "Watch TLS expiry and surface certificate lifecycle risk before operator impact.",
      kind: "certificate-guardian",
      status: "active",
      priority: "high",
      objective: "Own certificate visibility, expiry risk, and renewal readiness.",
      subagentId: "subagent.certificate-operator",
      packId: "pack.core-certificates",
      cadenceMinutes: 60,
      autoRun: true,
      autoApprove: false,
      shadowMode: false,
      targetJson: {
        selector: {
          servicesWithTls: true,
        },
        recommendationPattern: "tls|certificate|cert",
      },
      stateJson: {},
      nextRunAt: now,
      createdBy: "steward",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "mission.backup-hygiene",
      slug: "backup-hygiene",
      title: "Backup Hygiene",
      summary: "Watch backup freshness and convert stale or failing backup signals into durable follow-up.",
      kind: "backup-guardian",
      status: "active",
      priority: "high",
      objective: "Own backup freshness, retry follow-up, and escalation for backup-related risk.",
      subagentId: "subagent.backup-operator",
      packId: "pack.core-backups",
      cadenceMinutes: 60,
      autoRun: true,
      autoApprove: false,
      shadowMode: false,
      targetJson: {
        selector: {
          workloadCategory: "data",
          workloadNamePattern: "backup|snapshot|replication|archive",
        },
        findingTypes: ["backup_staleness"],
      },
      stateJson: {},
      nextRunAt: now,
      createdBy: "steward",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "mission.storage-health",
      slug: "storage-health",
      title: "Storage Health",
      summary: "Watch disk pressure and storage health drift across storage-sensitive systems.",
      kind: "storage-guardian",
      status: "active",
      priority: "high",
      objective: "Own disk pressure awareness and storage risk escalation across NAS, SAN, and server workloads.",
      subagentId: "subagent.storage-operator",
      packId: "pack.core-storage",
      cadenceMinutes: 30,
      autoRun: true,
      autoApprove: false,
      shadowMode: false,
      targetJson: {
        selector: {
          deviceTypes: ["nas", "san", "server", "vm-host", "container-host"],
        },
        findingTypes: ["disk_pressure"],
      },
      stateJson: {},
      nextRunAt: now,
      createdBy: "steward",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "mission.wan-guardian",
      slug: "wan-guardian",
      title: "WAN Guardian",
      summary: "Track WAN and network-edge drift across routers, firewalls, switches, and access points.",
      kind: "wan-guardian",
      status: "active",
      priority: "high",
      objective: "Own WAN visibility, edge degradation follow-up, and durable network-health investigations.",
      subagentId: "subagent.network-operator",
      packId: "pack.core-network-hygiene",
      cadenceMinutes: 15,
      autoRun: true,
      autoApprove: false,
      shadowMode: false,
      targetJson: {
        selector: {
          deviceTypes: ["router", "switch", "access-point", "firewall", "gateway"],
          workloadCategory: "network",
          assuranceMonitorTypes: ["icmp", "snmp", "interface"],
        },
        incidentTypes: ["availability.offline"],
        recommendationPattern: "wan|latency|link|packet loss|internet|network",
      },
      stateJson: {},
      nextRunAt: now,
      createdBy: "steward",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "mission.daily-briefing",
      slug: "daily-briefing",
      title: "Daily Briefing",
      summary: "Compile a daily operator briefing across active missions, investigations, incidents, and approvals.",
      kind: "daily-briefing",
      status: "active",
      priority: "medium",
      objective: "Deliver a daily summary to the operator through configured gateway bindings.",
      subagentId: "subagent.briefing-operator",
      packId: "pack.telegram-ops",
      cadenceMinutes: 24 * 60,
      autoRun: true,
      autoApprove: false,
      shadowMode: false,
      targetJson: {
        scheduleMode: "systemDigest",
      },
      stateJson: {},
      nextRunAt: now,
      createdBy: "steward",
      createdAt: now,
      updatedAt: now,
    },
  ];
}
