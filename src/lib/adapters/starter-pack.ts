import type { AdapterManifest } from "@/lib/adapters/types";

export interface BuiltinAdapterBundle {
  dirName: string;
  manifest: AdapterManifest;
  entrySource: string;
}

const HTTP_SURFACE_ADAPTER_SOURCE = `
const HTTP_PORTS = new Set([80, 443, 8080, 8443, 5000, 5001, 7443, 9000, 9443]);

function normalizePorts(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((item) => Number(item))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

function hasHttpPort(services, ports) {
  return services.some((svc) => ports.includes(Number(svc.port)) || HTTP_PORTS.has(Number(svc.port)));
}

module.exports = {
  enrich(candidate, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return candidate;
    }

    const configuredPorts = normalizePorts(config.httpPorts, [80, 443, 8080, 8443, 5000, 5001]);
    if (!hasHttpPort(candidate.services || [], configuredPorts)) {
      return candidate;
    }

    const vendorHint = String(candidate.vendor || "").toLowerCase();
    const hostHint = String(candidate.hostname || "").toLowerCase();
    const shouldClassifyNas = config.classifyNas !== false;

    let typeHint = candidate.typeHint;
    if (shouldClassifyNas && /synology|diskstation|qnap|truenas|netgear readynas/.test(vendorHint + " " + hostHint)) {
      typeHint = "nas";
    }

    return {
      ...candidate,
      typeHint,
      metadata: {
        ...(candidate.metadata || {}),
        httpSurface: {
          managedBy: "steward.http-surface",
          ports: configuredPorts,
        },
      },
    };
  },

  capabilities(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }

    const configuredPorts = normalizePorts(config.httpPorts, [80, 443, 8080, 8443, 5000, 5001]);
    if (!hasHttpPort(device.services || [], configuredPorts)) {
      return [];
    }

    return [
      {
        id: "capability.http-surface",
        title: "Web Console Operations",
        protocol: "http",
        actions: [
          "Profile web console headers and version hints",
          "Track TLS certificate expiry",
          "Validate management endpoint reachability",
        ],
      },
    ];
  },
};
`;

const DOCKER_OPS_ADAPTER_SOURCE = `
function hasDockerPort(services) {
  return services.some((svc) => Number(svc.port) === 2375 || Number(svc.port) === 2376);
}

module.exports = {
  enrich(candidate, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return candidate;
    }

    if (!hasDockerPort(candidate.services || [])) {
      return candidate;
    }

    return {
      ...candidate,
      typeHint: candidate.typeHint === "unknown" || !candidate.typeHint ? "container-host" : candidate.typeHint,
      metadata: {
        ...(candidate.metadata || {}),
        dockerAdapter: {
          managedBy: "steward.docker-ops",
          discoveredDockerApi: true,
        },
      },
    };
  },

  capabilities(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }

    if (!hasDockerPort(device.services || [])) {
      return [];
    }

    return [
      {
        id: "capability.docker-ops",
        title: "Docker Host Operations",
        protocol: "docker",
        actions: [
          "Inventory running containers",
          "Restart unhealthy workloads",
          "Prune dangling images",
        ],
      },
    ];
  },

  playbooks(context) {
    const config = context.getConfig();
    if (config.enabled === false || config.enableImagePrunePlaybook === false) {
      return [];
    }

    const mutateSafety = {
      dryRunSupported: true,
      dryRunCommandTemplate: "ssh {{host}} 'docker image prune --filter dangling=true --force --dry-run 2>/dev/null || docker image ls -f dangling=true -q | wc -l'",
      requiresConfirmedRevert: false,
      criticality: "medium",
    };

    const readSafety = {
      dryRunSupported: false,
      requiresConfirmedRevert: false,
      criticality: "low",
    };

    return [
      {
        id: "playbook:docker:image-prune",
        family: "disk-cleanup",
        name: "Prune dangling Docker images",
        description: "Safely remove dangling Docker images to relieve disk pressure on container hosts.",
        actionClass: "B",
        blastRadius: "single-device",
        timeoutMs: 120000,
        preconditions: {
          requiredProtocols: ["docker"],
          healthChecks: ["docker info"],
        },
        steps: [
          {
            id: "step:docker:prune",
            label: "Prune dangling images",
            operation: {
              id: "op:docker:image-prune",
              adapterId: "docker",
              kind: "shell.command",
              mode: "mutate",
              timeoutMs: Number(config.pruneTimeoutMs || 45000),
              commandTemplate: "ssh {{host}} 'docker image prune -f'",
              expectedSemanticTarget: "docker:images:dangling",
              safety: mutateSafety,
            },
          },
        ],
        verificationSteps: [
          {
            id: "verify:docker:prune",
            label: "Count remaining dangling images",
            operation: {
              id: "op:docker:image-prune:verify",
              adapterId: "docker",
              kind: "shell.command",
              mode: "read",
              timeoutMs: 15000,
              commandTemplate: "ssh {{host}} 'docker image ls -f dangling=true -q | wc -l'",
              expectedSemanticTarget: "docker:images:dangling",
              safety: readSafety,
            },
          },
        ],
        rollbackSteps: [],
        matchesIncident(title, metadata) {
          const key = String((metadata && metadata.key) || "").toLowerCase();
          return title.includes("disk") || title.includes("docker") || key.includes("disk");
        },
      },
    ];
  },
};
`;

const SNMP_INTEL_ADAPTER_SOURCE = `
function asIpList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
}

function hasSnmpPort(services) {
  return services.some((svc) => Number(svc.port) === 161);
}

module.exports = {
  discover(knownIps, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }

    const known = new Set(Array.isArray(knownIps) ? knownIps : []);
    const seeds = asIpList(config.seedIps);
    const now = new Date().toISOString();

    return seeds
      .filter((ip) => !known.has(ip))
      .map((ip) => ({
        ip,
        source: "active",
        confidence: 0.45,
        typeHint: "switch",
        services: [
          {
            id: "seed-snmp-" + ip,
            port: 161,
            transport: "udp",
            name: "snmp",
            secure: false,
            lastSeenAt: now,
          },
        ],
        observations: [],
        metadata: {
          discoveredByAdapter: "steward.snmp-network-intel",
          seed: true,
        },
      }));
  },

  enrich(candidate, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return candidate;
    }

    if (!hasSnmpPort(candidate.services || [])) {
      return candidate;
    }

    const shouldClassifySwitch = config.classifyAsSwitch !== false;

    return {
      ...candidate,
      typeHint: shouldClassifySwitch ? (candidate.typeHint === "unknown" || !candidate.typeHint ? "switch" : candidate.typeHint) : candidate.typeHint,
      metadata: {
        ...(candidate.metadata || {}),
        snmpIntel: {
          managedBy: "steward.snmp-network-intel",
          defaultCommunityHint: config.communityHint || "public",
        },
      },
    };
  },

  capabilities(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }

    if (!hasSnmpPort(device.services || [])) {
      return [];
    }

    return [
      {
        id: "capability.snmp-network-intel",
        title: "SNMP Network Intel",
        protocol: "snmp",
        actions: [
          "Collect interface counters",
          "Track firmware and sysDescr metadata",
          "Flag likely switch/router roles",
        ],
      },
    ];
  },
};
`;

const LINUX_SERVER_ADAPTER_SOURCE = `
function hasSshPort(services) {
  return services.some((svc) => Number(svc.port) === 22 || Number(svc.port) === 2222);
}

function looksWindows(candidate) {
  const os = String(candidate.os || "").toLowerCase();
  const vendor = String(candidate.vendor || "").toLowerCase();
  const hostname = String(candidate.hostname || "").toLowerCase();
  return os.includes("windows") || vendor.includes("microsoft") || hostname.includes("win");
}

module.exports = {
  enrich(candidate, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return candidate;
    }

    if (!hasSshPort(candidate.services || []) || looksWindows(candidate)) {
      return candidate;
    }

    return {
      ...candidate,
      typeHint: candidate.typeHint === "unknown" || !candidate.typeHint ? "server" : candidate.typeHint,
      metadata: {
        ...(candidate.metadata || {}),
        linuxServer: {
          managedBy: "steward.linux-server",
          hardeningMode: config.hardeningMode || "baseline",
        },
      },
    };
  },

  capabilities(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }
    if (!hasSshPort(device.services || [])) {
      return [];
    }

    return [
      {
        id: "capability.linux-server",
        title: "Linux Server Operations",
        protocol: "ssh",
        actions: [
          "Collect host health snapshots",
          "Audit package and service posture",
          "Run safe hardening checks",
        ],
      },
    ];
  },

  playbooks(context) {
    const config = context.getConfig();
    if (config.enabled === false || config.enableHealthSnapshotPlaybook === false) {
      return [];
    }

    return [
      {
        id: "playbook:linux:health-snapshot",
        family: "linux-maintenance",
        name: "Collect Linux host health snapshot",
        description: "Runs a read-only Linux health snapshot (kernel, uptime, disk, memory).",
        actionClass: "A",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: {
          requiredProtocols: ["ssh"],
        },
        steps: [
          {
            id: "step:linux:snapshot",
            label: "Collect host snapshot",
            operation: {
              id: "op:linux:snapshot",
              adapterId: "ssh",
              kind: "shell.command",
              mode: "read",
              timeoutMs: 20000,
              commandTemplate: "ssh {{host}} 'uname -a; uptime; free -m; df -h'",
              expectedSemanticTarget: "linux:health",
              safety: {
                dryRunSupported: false,
                requiresConfirmedRevert: false,
                criticality: "low",
              },
            },
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
    ];
  },
};
`;

const WINDOWS_SERVER_ADAPTER_SOURCE = `
function hasWindowsMgmtPort(services) {
  return services.some((svc) =>
    Number(svc.port) === 5985 || Number(svc.port) === 5986 || Number(svc.port) === 3389);
}

module.exports = {
  enrich(candidate, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return candidate;
    }

    if (!hasWindowsMgmtPort(candidate.services || [])) {
      return candidate;
    }

    return {
      ...candidate,
      typeHint: candidate.typeHint === "unknown" || !candidate.typeHint ? "server" : candidate.typeHint,
      metadata: {
        ...(candidate.metadata || {}),
        windowsServer: {
          managedBy: "steward.windows-server",
          patchRing: config.patchRing || "stable",
        },
      },
    };
  },

  capabilities(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }
    if (!hasWindowsMgmtPort(device.services || [])) {
      return [];
    }

    return [
      {
        id: "capability.windows-server",
        title: "Windows Server Operations",
        protocol: "winrm",
        actions: [
          "Collect service inventory",
          "Review update posture",
          "Inspect critical event logs",
        ],
      },
    ];
  },

  playbooks(context) {
    const config = context.getConfig();
    if (config.enabled === false || config.enableServiceInventoryPlaybook === false) {
      return [];
    }

    return [
      {
        id: "playbook:windows:service-inventory",
        family: "windows-maintenance",
        name: "Collect Windows service inventory",
        description: "Runs a read-only service inventory query against Windows hosts.",
        actionClass: "A",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: {
          requiredProtocols: ["winrm"],
        },
        steps: [
          {
            id: "step:windows:services",
            label: "Query Windows services",
            operation: {
              id: "op:windows:services",
              adapterId: "winrm",
              kind: "shell.command",
              mode: "read",
              timeoutMs: 25000,
              commandTemplate: "Invoke-Command -ComputerName {{host}} -ScriptBlock { Get-Service | Select-Object -First 25 Name,Status,StartType }",
              expectedSemanticTarget: "windows:services",
              safety: {
                dryRunSupported: false,
                requiresConfirmedRevert: false,
                criticality: "low",
              },
            },
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
    ];
  },
};
`;

const UBIQUITI_UNIFI_ADAPTER_SOURCE = `
function hasUniFiPort(services) {
  return services.some((svc) =>
    [8080, 8443, 10001, 3478].includes(Number(svc.port)));
}

function hasUniFiHint(candidate) {
  const vendor = String(candidate.vendor || "").toLowerCase();
  const hostname = String(candidate.hostname || "").toLowerCase();
  const os = String(candidate.os || "").toLowerCase();
  return vendor.includes("ubiquiti")
    || vendor.includes("ubnt")
    || hostname.includes("unifi")
    || os.includes("edgeos");
}

module.exports = {
  enrich(candidate, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return candidate;
    }

    const matched = hasUniFiHint(candidate) || hasUniFiPort(candidate.services || []);
    if (!matched) {
      return candidate;
    }

    const defaultType = String(config.defaultType || "access-point");

    return {
      ...candidate,
      typeHint: candidate.typeHint === "unknown" || !candidate.typeHint
        ? defaultType
        : candidate.typeHint,
      metadata: {
        ...(candidate.metadata || {}),
        ubiquiti: {
          managedBy: "steward.ubiquiti-unifi",
          controllerPreferredPort: Number(config.controllerPort || 8443),
        },
      },
    };
  },

  capabilities(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }

    const matched = hasUniFiHint(device) || hasUniFiPort(device.services || []);
    if (!matched) {
      return [];
    }

    return [
      {
        id: "capability.ubiquiti-unifi",
        title: "Ubiquiti / UniFi Operations",
        protocol: "http",
        actions: [
          "Controller/API reachability checks",
          "Firmware posture review",
          "Client association and AP load diagnostics",
        ],
      },
    ];
  },

  playbooks(context) {
    const config = context.getConfig();
    if (config.enabled === false || config.enableControllerProbePlaybook === false) {
      return [];
    }

    const controllerPort = Number(config.controllerPort || 8443);
    const scheme = controllerPort === 443 || controllerPort === 8443 ? "https" : "http";

    return [
      {
        id: "playbook:ubiquiti:controller-probe",
        family: "config-backup",
        name: "Probe UniFi controller/API endpoint",
        description: "Runs a read-only health probe against the UniFi controller/API surface.",
        actionClass: "A",
        blastRadius: "single-device",
        timeoutMs: 30000,
        preconditions: {
          requiredProtocols: ["http-api"],
        },
        steps: [
          {
            id: "step:ubiquiti:probe",
            label: "Probe controller endpoint",
            operation: {
              id: "op:ubiquiti:probe",
              adapterId: "http-api",
              kind: "http.request",
              mode: "read",
              timeoutMs: 12000,
              commandTemplate: "curl -s -k --max-time 8 " + scheme + "://{{host}}:" + String(controllerPort) + "/",
              expectedSemanticTarget: "ubiquiti:controller",
              safety: {
                dryRunSupported: false,
                requiresConfirmedRevert: false,
                criticality: "low",
              },
            },
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
    ];
  },
};
`;

export const BUILTIN_ADAPTERS: BuiltinAdapterBundle[] = [
  {
    dirName: "steward-http-surface",
    manifest: {
      id: "steward.http-surface",
      name: "HTTP Surface",
      description: "Classifies and manages appliance-style web consoles with configurable HTTP port hints.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["enrichment", "protocol"],
      docsUrl: "https://steward.local/docs/adapters/http-surface",
      configSchema: [
        {
          key: "enabled",
          label: "Enabled",
          description: "Master toggle for this adapter.",
          type: "boolean",
          default: true,
        },
        {
          key: "classifyNas",
          label: "Classify NAS Devices",
          description: "Infer NAS type from vendor/hostname hints when HTTP consoles are detected.",
          type: "boolean",
          default: true,
        },
        {
          key: "httpPorts",
          label: "HTTP Port Hints",
          description: "Ports treated as management web surfaces.",
          type: "json",
          default: [80, 443, 8080, 8443, 5000, 5001],
        },
      ],
      defaultConfig: {
        enabled: true,
        classifyNas: true,
        httpPorts: [80, 443, 8080, 8443, 5000, 5001],
      },
      toolSkills: [
        {
          id: "skill.http.console-profile",
          name: "Console Profiling",
          description: "Profile device web consoles and surface likely appliance identities.",
          category: "diagnostics",
          operationKinds: ["http.request"],
          enabledByDefault: true,
        },
        {
          id: "skill.http.tls-expiry",
          name: "TLS Expiry Review",
          description: "Audit TLS certificate freshness for web-managed devices.",
          category: "security",
          operationKinds: ["http.request"],
          enabledByDefault: true,
        },
        {
          id: "skill.http.auth-surface",
          name: "Auth Surface Check",
          description: "Identify exposed login endpoints and auth patterns on remote web consoles.",
          category: "security",
          operationKinds: ["http.request"],
          enabledByDefault: true,
        },
        {
          id: "skill.http.reachability-slo",
          name: "Reachability SLO",
          description: "Continuously evaluate management endpoint reachability against SLA targets.",
          category: "operations",
          operationKinds: ["http.request"],
          enabledByDefault: true,
        },
      ],
      defaultToolConfig: {
        "skill.http.console-profile": { enabled: true, includeHeaders: true },
        "skill.http.tls-expiry": { enabled: true, warningDays: 21 },
        "skill.http.auth-surface": { enabled: true, followRedirects: true },
        "skill.http.reachability-slo": { enabled: true, timeoutMs: 6000 },
      },
    },
    entrySource: HTTP_SURFACE_ADAPTER_SOURCE,
  },
  {
    dirName: "steward-docker-ops",
    manifest: {
      id: "steward.docker-ops",
      name: "Docker Operations",
      description: "Adds Docker host classification, capabilities, and a safe dangling-image cleanup playbook.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["enrichment", "protocol", "playbooks"],
      docsUrl: "https://steward.local/docs/adapters/docker-ops",
      configSchema: [
        {
          key: "enabled",
          label: "Enabled",
          description: "Master toggle for this adapter.",
          type: "boolean",
          default: true,
        },
        {
          key: "enableImagePrunePlaybook",
          label: "Enable Image Prune Playbook",
          description: "Expose the dangling image cleanup playbook.",
          type: "boolean",
          default: true,
        },
        {
          key: "pruneTimeoutMs",
          label: "Prune Timeout (ms)",
          description: "Timeout budget for image prune operations.",
          type: "number",
          min: 5000,
          max: 300000,
          default: 45000,
        },
      ],
      defaultConfig: {
        enabled: true,
        enableImagePrunePlaybook: true,
        pruneTimeoutMs: 45000,
      },
      toolSkills: [
        {
          id: "skill.docker.inventory",
          name: "Container Inventory",
          description: "Inspect running workloads and identify stale container services.",
          category: "operations",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.docker.cleanup",
          name: "Safe Image Cleanup",
          description: "Run controlled dangling-image cleanup with verification.",
          category: "remediation",
          operationKinds: ["shell.command", "container.restart"],
          enabledByDefault: true,
        },
        {
          id: "skill.docker.resource-pressure",
          name: "Resource Pressure",
          description: "Analyze host/container CPU, memory, and disk pressure before incidents.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.docker.compose-drift",
          name: "Compose Drift",
          description: "Detect service/image drift between running containers and compose intent.",
          category: "operations",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
      ],
      defaultToolConfig: {
        "skill.docker.inventory": { enabled: true, includeStopped: false },
        "skill.docker.cleanup": { enabled: true, dryRunFirst: true },
        "skill.docker.resource-pressure": { enabled: true, cpuAlertPercent: 85 },
        "skill.docker.compose-drift": { enabled: true, includeImageDigest: true },
      },
    },
    entrySource: DOCKER_OPS_ADAPTER_SOURCE,
  },
  {
    dirName: "steward-snmp-network-intel",
    manifest: {
      id: "steward.snmp-network-intel",
      name: "SNMP Network Intel",
      description: "Seeds SNMP endpoints, enriches switch/router classification, and contributes network intel capabilities.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["discovery", "enrichment", "protocol"],
      docsUrl: "https://steward.local/docs/adapters/snmp-network-intel",
      configSchema: [
        {
          key: "enabled",
          label: "Enabled",
          description: "Master toggle for this adapter.",
          type: "boolean",
          default: true,
        },
        {
          key: "classifyAsSwitch",
          label: "Classify as Switch",
          description: "Promote SNMP-discovered unknown devices to switch class when possible.",
          type: "boolean",
          default: true,
        },
        {
          key: "communityHint",
          label: "Community Hint",
          description: "Non-secret hint used for diagnostics context only.",
          type: "string",
          placeholder: "public",
          default: "public",
        },
        {
          key: "seedIps",
          label: "Seed IPs",
          description: "Optional SNMP target IPs to inject into discovery.",
          type: "json",
          default: [],
        },
      ],
      defaultConfig: {
        enabled: true,
        classifyAsSwitch: true,
        communityHint: "public",
        seedIps: [],
      },
      toolSkills: [
        {
          id: "skill.snmp.interface-health",
          name: "Interface Health",
          description: "Collect and reason about SNMP interface counters.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.snmp.firmware-posture",
          name: "Firmware Posture",
          description: "Track sysDescr and firmware drift on network devices.",
          category: "security",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.snmp.port-errors",
          name: "Port Error Analysis",
          description: "Track CRC/error/discard trends and surface degraded interfaces.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.snmp.topology-hints",
          name: "Topology Hints",
          description: "Build L2/L3 relationship hints from SNMP metadata and neighbor signals.",
          category: "operations",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
      ],
      defaultToolConfig: {
        "skill.snmp.interface-health": { enabled: true, sampleWindowMinutes: 15 },
        "skill.snmp.firmware-posture": { enabled: true, alertOnUnknown: true },
        "skill.snmp.port-errors": { enabled: true, errorRateThreshold: 0.01 },
        "skill.snmp.topology-hints": { enabled: true, includeArpCorrelation: true },
      },
    },
    entrySource: SNMP_INTEL_ADAPTER_SOURCE,
  },
  {
    dirName: "steward-linux-server",
    manifest: {
      id: "steward.linux-server",
      name: "Linux Server",
      description: "Remote Linux server adapter with SSH-centric enrichment, skills, and maintenance playbooks.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["enrichment", "protocol", "playbooks"],
      docsUrl: "https://steward.local/docs/adapters/linux-server",
      configSchema: [
        { key: "enabled", label: "Enabled", type: "boolean", default: true },
        {
          key: "hardeningMode",
          label: "Hardening Mode",
          type: "select",
          default: "baseline",
          options: [
            { label: "Baseline", value: "baseline" },
            { label: "Strict", value: "strict" },
          ],
        },
        {
          key: "enableHealthSnapshotPlaybook",
          label: "Enable Health Snapshot Playbook",
          type: "boolean",
          default: true,
        },
      ],
      defaultConfig: {
        enabled: true,
        hardeningMode: "baseline",
        enableHealthSnapshotPlaybook: true,
      },
      toolSkills: [
        {
          id: "skill.linux.patch-audit",
          name: "Linux Patch Audit",
          description: "Review Linux patch and package update posture over SSH.",
          category: "security",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.linux.service-ops",
          name: "Linux Service Ops",
          description: "Diagnose and operate Linux services remotely via SSH.",
          category: "operations",
          operationKinds: ["service.restart", "service.stop", "shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.linux.disk-pressure",
          name: "Disk Pressure Analysis",
          description: "Detect filesystem and inode pressure before service degradation.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.linux.cis-baseline",
          name: "CIS Baseline Review",
          description: "Run remote Linux hardening posture checks against baseline controls.",
          category: "security",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
      ],
      defaultToolConfig: {
        "skill.linux.patch-audit": { enabled: true, severityFloor: "medium" },
        "skill.linux.service-ops": { enabled: true, autoRestart: false },
        "skill.linux.disk-pressure": { enabled: true, usageThresholdPercent: 85 },
        "skill.linux.cis-baseline": { enabled: true, profile: "level1" },
      },
    },
    entrySource: LINUX_SERVER_ADAPTER_SOURCE,
  },
  {
    dirName: "steward-windows-server",
    manifest: {
      id: "steward.windows-server",
      name: "Windows Server",
      description: "Remote Windows server adapter with WinRM/RDP classification and operational skills.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["enrichment", "protocol", "playbooks"],
      docsUrl: "https://steward.local/docs/adapters/windows-server",
      configSchema: [
        { key: "enabled", label: "Enabled", type: "boolean", default: true },
        {
          key: "patchRing",
          label: "Patch Ring",
          type: "select",
          default: "stable",
          options: [
            { label: "Stable", value: "stable" },
            { label: "Pilot", value: "pilot" },
          ],
        },
        {
          key: "enableServiceInventoryPlaybook",
          label: "Enable Service Inventory Playbook",
          type: "boolean",
          default: true,
        },
      ],
      defaultConfig: {
        enabled: true,
        patchRing: "stable",
        enableServiceInventoryPlaybook: true,
      },
      toolSkills: [
        {
          id: "skill.windows.service-audit",
          name: "Windows Service Audit",
          description: "Collect and evaluate Windows service state and startup configuration.",
          category: "operations",
          operationKinds: ["shell.command", "service.restart", "service.stop"],
          enabledByDefault: true,
        },
        {
          id: "skill.windows.patch-posture",
          name: "Windows Patch Posture",
          description: "Track Windows Update and patch-ring readiness.",
          category: "security",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.windows.eventlog-watch",
          name: "Event Log Watch",
          description: "Review critical event logs and detect recurring fault signatures.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
        {
          id: "skill.windows.rdp-posture",
          name: "RDP Posture",
          description: "Assess remote desktop exposure and hardening posture.",
          category: "security",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
        },
      ],
      defaultToolConfig: {
        "skill.windows.service-audit": { enabled: true, includeDisabled: false },
        "skill.windows.patch-posture": { enabled: true, maxAgeDays: 30 },
        "skill.windows.eventlog-watch": { enabled: true, lookbackHours: 24 },
        "skill.windows.rdp-posture": { enabled: true, requireNla: true },
      },
    },
    entrySource: WINDOWS_SERVER_ADAPTER_SOURCE,
  },
  {
    dirName: "steward-ubiquiti-unifi",
    manifest: {
      id: "steward.ubiquiti-unifi",
      name: "Ubiquiti / UniFi",
      description: "Remote Ubiquiti adapter for controller/API surfaces and AP/switch classification.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["enrichment", "protocol", "playbooks"],
      docsUrl: "https://steward.local/docs/adapters/ubiquiti-unifi",
      configSchema: [
        { key: "enabled", label: "Enabled", type: "boolean", default: true },
        {
          key: "defaultType",
          label: "Default Device Type",
          type: "select",
          default: "access-point",
          options: [
            { label: "Access Point", value: "access-point" },
            { label: "Switch", value: "switch" },
            { label: "Router", value: "router" },
          ],
        },
        {
          key: "controllerPort",
          label: "Controller Port",
          type: "number",
          min: 1,
          max: 65535,
          default: 8443,
        },
        {
          key: "enableControllerProbePlaybook",
          label: "Enable Controller Probe Playbook",
          type: "boolean",
          default: true,
        },
      ],
      defaultConfig: {
        enabled: true,
        defaultType: "access-point",
        controllerPort: 8443,
        enableControllerProbePlaybook: true,
      },
      toolSkills: [
        {
          id: "skill.ubiquiti.client-density",
          name: "Client Density Analysis",
          description: "Assess AP client load and association patterns in UniFi deployments.",
          category: "diagnostics",
          operationKinds: ["http.request"],
          enabledByDefault: true,
        },
        {
          id: "skill.ubiquiti.firmware-hygiene",
          name: "Firmware Hygiene",
          description: "Track and report firmware drift for Ubiquiti devices.",
          category: "security",
          operationKinds: ["http.request"],
          enabledByDefault: true,
        },
        {
          id: "skill.ubiquiti.wlan-health",
          name: "WLAN Health",
          description: "Analyze client association quality and channel utilization.",
          category: "diagnostics",
          operationKinds: ["http.request"],
          enabledByDefault: true,
        },
        {
          id: "skill.ubiquiti.port-profile-drift",
          name: "Port Profile Drift",
          description: "Detect switch/AP port profile drift from controller intent.",
          category: "operations",
          operationKinds: ["http.request"],
          enabledByDefault: true,
        },
      ],
      defaultToolConfig: {
        "skill.ubiquiti.client-density": { enabled: true, thresholdClients: 40 },
        "skill.ubiquiti.firmware-hygiene": { enabled: true, alertOnOutdated: true },
        "skill.ubiquiti.wlan-health": { enabled: true, maxChannelUtilizationPercent: 80 },
        "skill.ubiquiti.port-profile-drift": { enabled: true, includePoEProfiles: true },
      },
    },
    entrySource: UBIQUITI_UNIFI_ADAPTER_SOURCE,
  },
];
