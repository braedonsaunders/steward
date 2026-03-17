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
        protocol: "web-session",
        actions: [
          "Profile web console headers and version hints",
          "Track TLS certificate expiry",
          "Validate management endpoint reachability",
          "Run persistent browser-backed management flows",
        ],
      },
    ];
  },

  match(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return null;
    }
    const configuredPorts = normalizePorts(config.httpPorts, [80, 443, 8080, 8443, 5000, 5001]);
    if (!hasHttpPort(device.services || [], configuredPorts)) {
      return null;
    }

    const protocols = Array.isArray(device.protocols) ? device.protocols.map((value) => String(value).toLowerCase()) : [];
    const strongAlt = protocols.some((value) => ["ssh", "winrm", "powershell-ssh", "docker", "kubernetes", "mqtt"].includes(value));
    const confidence = strongAlt ? 0.54 : 0.86;
    return {
      profileId: "steward.http-surface.generic-web-console",
      adapterId: "steward.http-surface",
      name: strongAlt ? "Web Console Companion" : "Web Console Primary Management",
      kind: strongAlt ? "supporting" : "primary",
      confidence,
      summary: strongAlt
        ? "This device exposes a reusable web console that Steward can manage through persistent browser-backed sessions."
        : "This device is primarily managed through a web console, so Steward should prefer persistent web sessions and reusable web flows.",
      requiredAccessMethods: ["web-session", "http-api"],
      requiredCredentialProtocols: ["http-api"],
    };
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
          "Restart unhealthy responsibilities",
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

function serviceText(candidate) {
  return (candidate.services || [])
    .map((svc) => [svc.name, svc.product, svc.version, svc.banner].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase();
}

function looksLinux(candidate) {
  const text = [
    candidate.name,
    candidate.hostname,
    candidate.os,
    candidate.role,
    serviceText(candidate),
  ].filter(Boolean).join(" ").toLowerCase();
  return /(ubuntu|debian|rocky|almalinux|centos|fedora|linux|unix)/.test(text);
}

function looksWindows(candidate) {
  const text = [
    candidate.name,
    candidate.hostname,
    candidate.os,
    candidate.role,
    serviceText(candidate),
  ].filter(Boolean).join(" ").toLowerCase();
  const protocols = new Set((candidate.protocols || []).map((value) => String(value || "").toLowerCase()));
  const ports = new Set((candidate.services || []).map((svc) => Number(svc.port)));
  if (looksLinux(candidate)) {
    return false;
  }
  return /(windows|active directory|domain controller|hyper-v|exchange|sql server)/.test(text)
    || protocols.has("winrm")
    || protocols.has("powershell-ssh")
    || protocols.has("wmi")
    || ports.has(5985)
    || ports.has(5986)
    || ports.has(3389)
    || (ports.has(135) && ports.has(445))
    || (ports.has(88) && ports.has(389));
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

  match(device, context) {
    const services = device.services || [];
    if (!hasSshPort(services) || looksWindows(device)) {
      return [];
    }

    const type = String(device.type || "").toLowerCase();
    const text = [
      device.name,
      device.hostname,
      device.os,
      device.role,
      device.vendor,
    ].filter(Boolean).join(" ").toLowerCase();
    const serverLike = ["server", "nas", "container-host", "hypervisor", "vm-host"].includes(type)
      || /(ubuntu|debian|rocky|almalinux|centos|fedora|linux|server|proxmox|synology|truenas)/.test(text);
    if (!serverLike) {
      return [];
    }

    let confidence = 0.48;
    if (type === "server" || type === "container-host" || type === "vm-host" || type === "hypervisor") confidence += 0.22;
    if (/(ubuntu|debian|rocky|almalinux|centos|fedora|linux)/.test(text)) confidence += 0.18;
    if (device.protocols.includes("ssh")) confidence += 0.08;

    return [{
      profileId: "steward.linux-server",
      name: "Linux Server",
      kind: "primary",
      confidence: Math.min(0.96, confidence),
      summary: "Linux host managed over SSH for health, service, and hardening workflows.",
      evidence: {
        type: device.type,
        protocols: device.protocols,
      },
      requiredAccessMethods: ["ssh"],
      requiredCredentialProtocols: ["ssh"],
      defaultWorkloads: [
        {
          workloadKey: "host-availability",
          displayName: "Host availability",
          criticality: "high",
          category: "platform",
          summary: "Keep the host reachable and responsive over its management surface.",
        },
        {
          workloadKey: "system-services",
          displayName: "Core system services",
          criticality: "high",
          category: "platform",
          summary: "Track important services and restart or escalate when they drift.",
        },
      ],
      defaultAssurances: [
        {
          assuranceKey: "host-availability",
          workloadKey: "host-availability",
          displayName: "SSH reachability",
          criticality: "high",
          checkIntervalSec: 60,
          monitorType: "ssh_reachability",
          requiredProtocols: ["ssh"],
          rationale: "Steward needs a dependable management path before deeper automation is safe.",
        },
      ],
    }];
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

const WINDOWS_SERVER_ADAPTER_SOURCE = String.raw`
function hasPort(services, port, pattern) {
  return (services || []).some((svc) =>
    Number(svc.port) === port || (pattern ? pattern.test(String(svc.name || "")) : false));
}

function hasWinrmPort(services) {
  return hasPort(services, 5985, /winrm/i) || hasPort(services, 5986, /winrm/i);
}

function hasSshPort(services) {
  return hasPort(services, 22, /ssh/i);
}

function hasWmiPort(services) {
  return hasPort(services, 135, /msrpc|wmi/i);
}

function hasSmbPort(services) {
  return hasPort(services, 445, /smb|cifs|microsoft-ds/i);
}

function hasRdpPort(services) {
  return hasPort(services, 3389, /rdp/i);
}

function deviceText(device) {
  return [
    device.name,
    device.hostname,
    device.os,
    device.role,
    device.vendor,
  ].filter(Boolean).join(" ").toLowerCase();
}

function serviceText(device) {
  return (device.services || [])
    .map((svc) => [svc.name, svc.product, svc.version, svc.banner].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase();
}

function looksLinux(device) {
  return /(ubuntu|debian|rocky|almalinux|centos|fedora|linux|unix)/.test(deviceText(device) + " " + serviceText(device));
}

function windowsSignals(device, services) {
  const text = deviceText(device) + " " + serviceText(device);
  const protocols = new Set((device.protocols || []).map((value) => String(value || "").toLowerCase()));
  const ports = new Set((services || []).map((svc) => Number(svc.port)));
  if (looksLinux(device)) {
    return false;
  }
  return /windows|active directory|domain controller|hyper-v|exchange|sql server/.test(text)
    || protocols.has("winrm")
    || protocols.has("powershell-ssh")
    || protocols.has("wmi")
    || hasWinrmPort(services)
    || hasWmiPort(services)
    || hasRdpPort(services)
    || (ports.has(135) && ports.has(445))
    || (ports.has(88) && ports.has(389));
}

function primaryWindowsProtocol(device, services) {
  if (hasWinrmPort(services)) return "winrm";
  if (hasSshPort(services) && (/windows|powershell/.test(deviceText(device)) || windowsSignals(device, services))) {
    return "powershell-ssh";
  }
  if (hasWmiPort(services)) return "wmi";
  if (hasSmbPort(services)) return "smb";
  if (hasRdpPort(services)) return "rdp";
  return null;
}

function isWindowsServer(device, services) {
  const type = String(device.type || device.typeHint || "").toLowerCase();
  const text = deviceText(device);
  const serverLike = type === "server"
    || /windows server|domain controller|active directory|hyper-v|exchange|sql server/.test(text);
  return serverLike && windowsSignals(device, services);
}

function serverServiceInventoryOperation(protocol) {
  if (protocol === "powershell-ssh") {
    return {
      adapterId: "powershell-ssh",
      kind: "shell.command",
      mode: "read",
      timeoutMs: 25000,
      brokerRequest: {
        protocol: "powershell-ssh",
        command: "Get-Service | Select-Object -First 25 Name,Status,StartType",
      },
      expectedSemanticTarget: "windows:services",
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "low" },
    };
  }
  if (protocol === "wmi") {
    return {
      adapterId: "wmi",
      kind: "shell.command",
      mode: "read",
      timeoutMs: 25000,
      brokerRequest: {
        protocol: "wmi",
        command: "Get-CimInstance -CimSession $session -ClassName Win32_Service | Select-Object -First 25 Name,State,StartMode",
      },
      expectedSemanticTarget: "windows:services",
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "low" },
    };
  }
  if (protocol === "smb") {
    return {
      adapterId: "smb",
      kind: "shell.command",
      mode: "read",
      timeoutMs: 25000,
      brokerRequest: {
        protocol: "smb",
        share: "C$",
        command: "Get-ChildItem $sharePath\\Windows\\System32 | Select-Object -First 25 Name,Length,LastWriteTime",
      },
      expectedSemanticTarget: "windows:smb-system32-audit",
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "low" },
    };
  }
  return {
    adapterId: "winrm",
    kind: "shell.command",
    mode: "read",
    timeoutMs: 25000,
    brokerRequest: {
      protocol: "winrm",
      command: "Get-Service | Select-Object -First 25 Name,Status,StartType",
    },
    expectedSemanticTarget: "windows:services",
    safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "low" },
  };
}

function serverServiceRestartOperation(protocol, serviceName) {
  if (protocol === "powershell-ssh" || protocol === "winrm") {
    return {
      adapterId: protocol,
      kind: "service.restart",
      mode: "mutate",
      timeoutMs: 25000,
      brokerRequest: {
        protocol,
        command: "Restart-Service -Name '" + serviceName + "' -ErrorAction Stop; (Get-Service -Name '" + serviceName + "').Status",
        expectRegex: "Running",
      },
      expectedSemanticTarget: "service:" + serviceName,
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "medium" },
    };
  }
  if (protocol === "wmi") {
    return {
      adapterId: "wmi",
      kind: "service.restart",
      mode: "mutate",
      timeoutMs: 25000,
      brokerRequest: {
        protocol: "wmi",
        command: "$svc = Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter \\\"Name='" + serviceName + "'\\\"; Invoke-CimMethod -InputObject $svc -MethodName StopService | Out-Null; Start-Sleep -Seconds 2; Invoke-CimMethod -InputObject $svc -MethodName StartService | Out-Null; (Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter \\\"Name='" + serviceName + "'\\\").State",
        expectRegex: "Running",
      },
      expectedSemanticTarget: "service:" + serviceName,
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "medium" },
    };
  }
  return null;
}

function serverSmbFileStageOperation(relativePath, content) {
  return {
    adapterId: "smb",
    kind: "file.copy",
    mode: "mutate",
    timeoutMs: 25000,
    brokerRequest: {
      protocol: "smb",
      share: "C$",
      command: "$targetPath = Join-Path $sharePath '" + relativePath.replace(/\\/g, "\\\\") + "'; $targetDir = Split-Path -Parent $targetPath; New-Item -ItemType Directory -Path $targetDir -Force | Out-Null; Set-Content -Path $targetPath -Value '" + content.replace(/'/g, "''") + "' -Force; Get-Content $targetPath",
      expectRegex: "Steward",
    },
    expectedSemanticTarget: "file:" + relativePath.replace(/\\/g, "/"),
    safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "medium" },
  };
}

module.exports = {
  enrich(candidate, context) {
    const config = context.getConfig();
    const services = candidate.services || [];
    if (config.enabled === false || !isWindowsServer(candidate, services)) {
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
          preferredProtocol: primaryWindowsProtocol(candidate, services),
        },
      },
    };
  },

  match(device) {
    const services = device.services || [];
    const preferredProtocol = primaryWindowsProtocol(device, services);
    if (!preferredProtocol || !isWindowsServer(device, services)) {
      return [];
    }

    const type = String(device.type || "").toLowerCase();
    const text = deviceText(device);
    let confidence = 0.52;
    if (type === "server") confidence += 0.22;
    if (/windows server|active directory|domain controller/.test(text)) confidence += 0.18;
    if ((device.protocols || []).includes("winrm")) confidence += 0.08;
    if (preferredProtocol !== "winrm") confidence += 0.04;

    return [{
      profileId: "steward.windows-server",
      name: "Windows Server",
      kind: "primary",
      confidence: Math.min(0.96, confidence),
      summary: "Windows server with explicit remote-management transports for service, patch, and event-log workflows.",
      evidence: {
        type: device.type,
        protocols: device.protocols,
      },
      requiredAccessMethods: [preferredProtocol],
      requiredCredentialProtocols: [preferredProtocol],
      defaultWorkloads: [
        {
          workloadKey: "server-availability",
          displayName: "Server availability",
          criticality: "high",
          category: "platform",
          summary: "Keep the Windows server reachable and healthy.",
        },
        {
          workloadKey: "windows-services",
          displayName: "Critical Windows services",
          criticality: "high",
          category: "platform",
          summary: "Track service drift and failure for important Windows roles.",
        },
      ],
      defaultAssurances: [
        {
          assuranceKey: preferredProtocol + "-reachability",
          workloadKey: "server-availability",
          displayName: preferredProtocol.toUpperCase() + " reachability",
          criticality: "high",
          checkIntervalSec: 60,
          monitorType: preferredProtocol === "rdp" ? "rdp_exposure" : "winrm_reachability",
          requiredProtocols: [preferredProtocol],
          rationale: "Steward needs a verified Windows management transport before it can manage this server safely.",
        },
      ],
    }];
  },

  capabilities(device, context) {
    const config = context.getConfig();
    const services = device.services || [];
    const preferredProtocol = primaryWindowsProtocol(device, services);
    if (config.enabled === false || !preferredProtocol || !isWindowsServer(device, services)) {
      return [];
    }

    return [{
      id: "capability.windows-server",
      title: "Windows Server Operations",
      protocol: preferredProtocol,
      actions: [
        "Collect service inventory",
        "Review update posture",
        "Inspect critical event logs",
      ],
    }];
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
            operation: Object.assign({ id: "op:windows:services" }, serverServiceInventoryOperation("winrm")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows:powershell-ssh-service-inventory",
        family: "windows-maintenance",
        name: "Collect Windows service inventory over PowerShell SSH",
        description: "Runs a read-only service inventory query against Windows hosts over PowerShell over SSH.",
        actionClass: "A",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: { requiredProtocols: ["powershell-ssh"] },
        steps: [
          {
            id: "step:windows:psssh-services",
            label: "Query Windows services over PowerShell SSH",
            operation: Object.assign({ id: "op:windows:psssh-services" }, serverServiceInventoryOperation("powershell-ssh")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows:wmi-service-inventory",
        family: "windows-maintenance",
        name: "Collect Windows service inventory over WMI",
        description: "Runs a read-only service inventory query against Windows hosts over WMI/CIM.",
        actionClass: "A",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: { requiredProtocols: ["wmi"] },
        steps: [
          {
            id: "step:windows:wmi-services",
            label: "Query Windows services over WMI",
            operation: Object.assign({ id: "op:windows:wmi-services" }, serverServiceInventoryOperation("wmi")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows:powershell-ssh-spooler-restart",
        family: "windows-maintenance",
        name: "Restart Print Spooler over PowerShell SSH",
        description: "Restarts the Print Spooler service over PowerShell over SSH.",
        actionClass: "B",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: { requiredProtocols: ["powershell-ssh"] },
        steps: [
          {
            id: "step:windows:psssh-restart-spooler",
            label: "Restart Print Spooler over PowerShell SSH",
            operation: Object.assign({ id: "op:windows:psssh-restart-spooler" }, serverServiceRestartOperation("powershell-ssh", "Spooler")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows:wmi-spooler-restart",
        family: "windows-maintenance",
        name: "Restart Print Spooler over WMI",
        description: "Restarts the Print Spooler service over WMI/CIM.",
        actionClass: "B",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: { requiredProtocols: ["wmi"] },
        steps: [
          {
            id: "step:windows:wmi-restart-spooler",
            label: "Restart Print Spooler over WMI",
            operation: Object.assign({ id: "op:windows:wmi-restart-spooler" }, serverServiceRestartOperation("wmi", "Spooler")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows:smb-stage-health-marker",
        family: "windows-maintenance",
        name: "Stage Steward health marker over SMB",
        description: "Stages a small Steward marker file on the Windows server via SMB administrative shares.",
        actionClass: "C",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: { requiredProtocols: ["smb"] },
        steps: [
          {
            id: "step:windows:smb-stage-health-marker",
            label: "Stage health marker file",
            operation: Object.assign({ id: "op:windows:smb-stage-health-marker" }, serverSmbFileStageOperation("Steward\\staged\\server-health-marker.txt", "Steward server health marker")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [
          {
            id: "rollback:windows:smb-remove-health-marker",
            label: "Remove health marker file",
            operation: {
              id: "op:windows:smb-remove-health-marker",
              adapterId: "smb",
              kind: "file.copy",
              mode: "mutate",
              timeoutMs: 25000,
              brokerRequest: {
                protocol: "smb",
                share: "C$",
                command: "$targetPath = Join-Path $sharePath 'Steward\\staged\\server-health-marker.txt'; if (Test-Path $targetPath) { Remove-Item $targetPath -Force }; 'removed'",
                expectRegex: "removed",
              },
              expectedSemanticTarget: "file:Steward/staged/server-health-marker.txt",
              safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "medium" },
            },
          },
        ],
      },
    ];
  },
};
`;

const WINDOWS_WORKSTATION_ADAPTER_SOURCE = String.raw`
function hasRdpPort(services) {
  return services.some((svc) =>
    Number(svc.port) === 3389 || /rdp/i.test(String(svc.name || "")));
}

function hasWinrmPort(services) {
  return services.some((svc) =>
    Number(svc.port) === 5985
      || Number(svc.port) === 5986
      || /winrm/i.test(String(svc.name || "")));
}

function hasSshPort(services) {
  return services.some((svc) => Number(svc.port) === 22 || /ssh/i.test(String(svc.name || "")));
}

function hasWmiPort(services) {
  return services.some((svc) => Number(svc.port) === 135 || /msrpc|wmi/i.test(String(svc.name || "")));
}

function hasSmbPort(services) {
  return services.some((svc) => Number(svc.port) === 445 || /smb|cifs|microsoft-ds/i.test(String(svc.name || "")));
}

function hasServerPorts(services) {
  return services.some((svc) =>
    [53, 88, 389, 5985, 5986, 1433, 1521, 3306, 5432, 6379, 27017].includes(Number(svc.port)));
}

function deviceText(candidate) {
  return [
    candidate.typeHint,
    candidate.type,
    candidate.role,
    candidate.hostname,
    candidate.name,
    candidate.os,
  ].filter(Boolean).join(" ").toLowerCase();
}

function serviceText(candidate) {
  return (candidate.services || [])
    .map((svc) => [svc.name, svc.product, svc.version, svc.banner].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase();
}

function looksLinux(candidate) {
  return /(ubuntu|debian|rocky|almalinux|centos|fedora|linux|unix)/.test(deviceText(candidate) + " " + serviceText(candidate));
}

function looksWindows(candidate) {
  const protocols = new Set((candidate.protocols || []).map((value) => String(value || "").toLowerCase()));
  const ports = new Set((candidate.services || []).map((svc) => Number(svc.port)));
  if (looksLinux(candidate)) {
    return false;
  }
  return /windows|active directory|domain controller|hyper-v|exchange|sql server/.test(deviceText(candidate) + " " + serviceText(candidate))
    || protocols.has("winrm")
    || protocols.has("powershell-ssh")
    || protocols.has("wmi")
    || hasWinrmPort(candidate.services || [])
    || hasWmiPort(candidate.services || [])
    || hasRdpPort(candidate.services || [])
    || (ports.has(135) && ports.has(445))
    || (ports.has(88) && ports.has(389));
}

function primaryWindowsProtocol(candidate, services) {
  if (hasWinrmPort(services)) return "winrm";
  if (hasSshPort(services) && (/windows|powershell/.test(deviceText(candidate)) || looksWindows(candidate))) return "powershell-ssh";
  if (hasWmiPort(services)) return "wmi";
  if (hasSmbPort(services)) return "smb";
  if (hasRdpPort(services)) return "rdp";
  return null;
}

function looksWorkstation(candidate) {
    const text = deviceText(candidate);
    if (/(domain controller|active directory|windows server|hyper-v|exchange|sql server|dc\d|\bpdc\b)/.test(text)) {
      return false;
    }
  return String(candidate.typeHint || "").toLowerCase() === "workstation"
    || /(workstation|desktop|laptop|gaming|pc|rog|tuf|legion|alienware|omen|zephyrus)/.test(text);
}

function isWorkstationTarget(candidate, services) {
  const typeHint = String(candidate.typeHint || candidate.type || "").toLowerCase();
  const text = deviceText(candidate);
  if (/(server|domain controller|active directory|hyper-v|dc\d|\bpdc\b)/.test(text)) {
    return false;
  }
  return typeHint === "workstation"
    || looksWorkstation(candidate)
    || (hasRdpPort(services) && !hasServerPorts(services));
}

function workstationSnapshotOperation(protocol) {
  if (protocol === "powershell-ssh") {
    return {
      adapterId: "powershell-ssh",
      kind: "shell.command",
      mode: "read",
      timeoutMs: 25000,
      brokerRequest: {
        protocol: "powershell-ssh",
        command: "Get-CimInstance Win32_OperatingSystem | Select-Object CSName,Caption,Version,LastBootUpTime; Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,UserName,TotalPhysicalMemory",
      },
      expectedSemanticTarget: "windows:workstation-snapshot",
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "low" },
    };
  }
  if (protocol === "wmi") {
    return {
      adapterId: "wmi",
      kind: "shell.command",
      mode: "read",
      timeoutMs: 25000,
      brokerRequest: {
        protocol: "wmi",
        command: "Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem | Select-Object CSName,Caption,Version,LastBootUpTime; Get-CimInstance -CimSession $session -ClassName Win32_ComputerSystem | Select-Object Manufacturer,Model,UserName,TotalPhysicalMemory",
      },
      expectedSemanticTarget: "windows:workstation-snapshot",
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "low" },
    };
  }
  if (protocol === "smb") {
    return {
      adapterId: "smb",
      kind: "shell.command",
      mode: "read",
      timeoutMs: 25000,
      brokerRequest: {
        protocol: "smb",
        share: "C$",
        command: "Get-ChildItem $sharePath\\Users | Select-Object -First 20 Name,LastWriteTime",
      },
      expectedSemanticTarget: "windows:smb-user-profile-audit",
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "low" },
    };
  }
  return {
    adapterId: "winrm",
    kind: "shell.command",
    mode: "read",
    timeoutMs: 25000,
    brokerRequest: {
      protocol: "winrm",
      command: "Get-CimInstance Win32_OperatingSystem | Select-Object CSName,Caption,Version,LastBootUpTime; Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,UserName,TotalPhysicalMemory",
    },
    expectedSemanticTarget: "windows:workstation-snapshot",
    safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "low" },
  };
}

function workstationServiceRestartOperation(protocol, serviceName) {
  if (protocol === "powershell-ssh" || protocol === "winrm") {
    return {
      adapterId: protocol,
      kind: "service.restart",
      mode: "mutate",
      timeoutMs: 25000,
      brokerRequest: {
        protocol,
        command: "Restart-Service -Name '" + serviceName + "' -ErrorAction Stop; (Get-Service -Name '" + serviceName + "').Status",
        expectRegex: "Running",
      },
      expectedSemanticTarget: "service:" + serviceName,
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "medium" },
    };
  }
  if (protocol === "wmi") {
    return {
      adapterId: "wmi",
      kind: "service.restart",
      mode: "mutate",
      timeoutMs: 25000,
      brokerRequest: {
        protocol: "wmi",
        command: "$svc = Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter \\\"Name='" + serviceName + "'\\\"; Invoke-CimMethod -InputObject $svc -MethodName StopService | Out-Null; Start-Sleep -Seconds 2; Invoke-CimMethod -InputObject $svc -MethodName StartService | Out-Null; (Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter \\\"Name='" + serviceName + "'\\\").State",
        expectRegex: "Running",
      },
      expectedSemanticTarget: "service:" + serviceName,
      safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "medium" },
    };
  }
  return null;
}

function workstationSmbFileStageOperation(relativePath, content) {
  return {
    adapterId: "smb",
    kind: "file.copy",
    mode: "mutate",
    timeoutMs: 25000,
    brokerRequest: {
      protocol: "smb",
      share: "C$",
      command: "$targetPath = Join-Path $sharePath '" + relativePath.replace(/\\/g, "\\\\") + "'; $targetDir = Split-Path -Parent $targetPath; New-Item -ItemType Directory -Path $targetDir -Force | Out-Null; Set-Content -Path $targetPath -Value '" + content.replace(/'/g, "''") + "' -Force; Get-Content $targetPath",
      expectRegex: "Steward",
    },
    expectedSemanticTarget: "file:" + relativePath.replace(/\\/g, "/"),
    safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "medium" },
  };
}

module.exports = {
  enrich(candidate, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return candidate;
    }

    const services = candidate.services || [];
    const windowsLike = looksWindows(candidate) || hasRdpPort(services) || hasWinrmPort(services) || hasWmiPort(services);
    if (!windowsLike) {
      return candidate;
    }

    const workstationLike = isWorkstationTarget(candidate, services);
    if (!workstationLike) {
      return candidate;
    }

    return {
      ...candidate,
      typeHint: candidate.typeHint === "unknown" || !candidate.typeHint || candidate.typeHint === "server"
        ? "workstation"
        : candidate.typeHint,
      metadata: {
        ...(candidate.metadata || {}),
        windowsWorkstation: {
          managedBy: "steward.windows-workstation",
          profile: config.profile || "personal",
          remoteDesktopObserved: hasRdpPort(services),
          winrmObserved: hasWinrmPort(services),
        },
      },
    };
  },

  match(device, context) {
    const services = device.services || [];
    const windowsLike = looksWindows(device) || hasRdpPort(services) || hasWinrmPort(services) || hasWmiPort(services);
    if (!windowsLike) {
      return [];
    }

    const workstationLike = isWorkstationTarget(device, services);
    if (!workstationLike) {
      return [];
    }

    let confidence = 0.46;
    if (String(device.type || "").toLowerCase() === "workstation") confidence += 0.24;
    if (hasWinrmPort(services)) confidence += 0.12;
    if (hasRdpPort(services)) confidence += 0.08;

     const preferredProtocol = primaryWindowsProtocol(device, services) || "rdp";
     const requiredAccessMethods = [preferredProtocol];
     const requiredCredentialProtocols = preferredProtocol === "rdp" ? ["rdp"] : [preferredProtocol];

    return [{
      profileId: "steward.windows-workstation",
      name: "Windows Workstation",
      kind: "primary",
      confidence: Math.min(0.94, confidence),
      summary: "Windows desktop or laptop with workstation-oriented health and exposure checks.",
      evidence: {
        type: device.type,
        rdpObserved: hasRdpPort(services),
        winrmObserved: hasWinrmPort(services),
      },
      requiredAccessMethods,
      requiredCredentialProtocols,
      defaultWorkloads: [
        {
          workloadKey: "desktop-availability",
          displayName: "Desktop availability",
          criticality: "medium",
          category: "platform",
          summary: "Keep the workstation reachable and surface health drift clearly.",
        },
      ],
      defaultAssurances: [
        {
          assuranceKey: "desktop-reachability",
          workloadKey: "desktop-availability",
           displayName: preferredProtocol === "rdp" ? "RDP exposure check" : preferredProtocol.toUpperCase() + " reachability",
           criticality: preferredProtocol === "rdp" ? "low" : "medium",
           checkIntervalSec: 120,
           monitorType: preferredProtocol === "rdp" ? "rdp_exposure" : "winrm_reachability",
           requiredProtocols: requiredAccessMethods,
           rationale: preferredProtocol === "rdp"
             ? "RDP is an exposure surface that Steward should monitor even when deep management is unavailable."
             : "Validated workstation management depends on a healthy remote management transport.",
         },
       ],
    }];
  },

  capabilities(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }

    const services = device.services || [];
    if (!isWorkstationTarget(device, services)) {
      return [];
    }
    const capabilities = [];

    const preferredProtocol = primaryWindowsProtocol(device, services);

     if (preferredProtocol && preferredProtocol !== "rdp") {
       capabilities.push({
         id: "capability.windows-workstation",
         title: "Windows Workstation Management",
         protocol: preferredProtocol,
         actions: [
           "Collect desktop health snapshots",
           "Audit active user sessions and startup items",
          "Inspect GPU/display and patch posture",
        ],
      });
    }

    if (hasRdpPort(services)) {
      capabilities.push({
        id: "capability.windows-rdp-surface",
        title: "Remote Desktop Surface",
        protocol: "rdp",
        actions: [
          "Track RDP reachability",
          "Review NLA and access posture",
          "Plan deeper management via WinRM if needed",
        ],
      });
    }

    return capabilities;
  },

  playbooks(context) {
    const config = context.getConfig();
    if (config.enabled === false || config.enableSnapshotPlaybook === false) {
      return [];
    }

    return [
      {
        id: "playbook:windows-workstation:snapshot",
        family: "windows-maintenance",
        name: "Collect Windows workstation snapshot",
        description: "Runs a read-only workstation posture snapshot against Windows desktops and laptops.",
        actionClass: "A",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: {
          requiredProtocols: ["winrm"],
        },
        steps: [
          {
            id: "step:windows-workstation:snapshot",
            label: "Query workstation posture",
            operation: Object.assign({ id: "op:windows-workstation:snapshot" }, workstationSnapshotOperation("winrm")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows-workstation:powershell-ssh-snapshot",
        family: "windows-maintenance",
        name: "Collect workstation snapshot over PowerShell SSH",
        description: "Runs a read-only workstation posture snapshot over PowerShell over SSH.",
        actionClass: "A",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: {
          requiredProtocols: ["powershell-ssh"],
        },
        steps: [
          {
            id: "step:windows-workstation:psssh-snapshot",
            label: "Query workstation posture over PowerShell SSH",
            operation: Object.assign({ id: "op:windows-workstation:psssh-snapshot" }, workstationSnapshotOperation("powershell-ssh")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows-workstation:wmi-snapshot",
        family: "windows-maintenance",
        name: "Collect workstation snapshot over WMI",
        description: "Runs a read-only workstation posture snapshot over WMI/CIM.",
        actionClass: "A",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: {
          requiredProtocols: ["wmi"],
        },
        steps: [
          {
            id: "step:windows-workstation:wmi-snapshot",
            label: "Query workstation posture over WMI",
            operation: Object.assign({ id: "op:windows-workstation:wmi-snapshot" }, workstationSnapshotOperation("wmi")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows-workstation:smb-user-profile-audit",
        family: "windows-maintenance",
        name: "Audit workstation user profiles over SMB",
        description: "Runs a read-only workstation user-profile share audit over SMB.",
        actionClass: "A",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: {
          requiredProtocols: ["smb"],
        },
        steps: [
          {
            id: "step:windows-workstation:smb-user-profiles",
            label: "Inspect user profiles over SMB",
            operation: Object.assign({ id: "op:windows-workstation:smb-user-profiles" }, workstationSnapshotOperation("smb")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows-workstation:powershell-ssh-wuauserv-restart",
        family: "windows-maintenance",
        name: "Restart Windows Update service over PowerShell SSH",
        description: "Restarts the Windows Update service over PowerShell over SSH.",
        actionClass: "B",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: { requiredProtocols: ["powershell-ssh"] },
        steps: [
          {
            id: "step:windows-workstation:psssh-restart-wuauserv",
            label: "Restart Windows Update service over PowerShell SSH",
            operation: Object.assign({ id: "op:windows-workstation:psssh-restart-wuauserv" }, workstationServiceRestartOperation("powershell-ssh", "wuauserv")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows-workstation:wmi-wuauserv-restart",
        family: "windows-maintenance",
        name: "Restart Windows Update service over WMI",
        description: "Restarts the Windows Update service over WMI/CIM.",
        actionClass: "B",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: { requiredProtocols: ["wmi"] },
        steps: [
          {
            id: "step:windows-workstation:wmi-restart-wuauserv",
            label: "Restart Windows Update service over WMI",
            operation: Object.assign({ id: "op:windows-workstation:wmi-restart-wuauserv" }, workstationServiceRestartOperation("wmi", "wuauserv")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [],
      },
      {
        id: "playbook:windows-workstation:smb-stage-operator-note",
        family: "windows-maintenance",
        name: "Stage operator note over SMB",
        description: "Stages a small Steward operator note on the workstation via SMB administrative shares.",
        actionClass: "C",
        blastRadius: "single-device",
        timeoutMs: 45000,
        preconditions: { requiredProtocols: ["smb"] },
        steps: [
          {
            id: "step:windows-workstation:smb-stage-operator-note",
            label: "Stage operator note",
            operation: Object.assign({ id: "op:windows-workstation:smb-stage-operator-note" }, workstationSmbFileStageOperation("Users\\Public\\Documents\\Steward\\operator-note.txt", "Steward workstation operator note")),
          },
        ],
        verificationSteps: [],
        rollbackSteps: [
          {
            id: "rollback:windows-workstation:smb-remove-operator-note",
            label: "Remove operator note",
            operation: {
              id: "op:windows-workstation:smb-remove-operator-note",
              adapterId: "smb",
              kind: "file.copy",
              mode: "mutate",
              timeoutMs: 25000,
              brokerRequest: {
                protocol: "smb",
                share: "C$",
                command: "$targetPath = Join-Path $sharePath 'Users\\Public\\Documents\\Steward\\operator-note.txt'; if (Test-Path $targetPath) { Remove-Item $targetPath -Force }; 'removed'",
                expectRegex: "removed",
              },
              expectedSemanticTarget: "file:Users/Public/Documents/Steward/operator-note.txt",
              safety: { dryRunSupported: false, requiresConfirmedRevert: false, criticality: "medium" },
            },
          },
        ],
      },
    ];
  },
};
`;

const UBIQUITI_UNIFI_ADAPTER_SOURCE = `
function hasUniFiPort(services) {
  const ports = new Set((services || []).map((svc) => Number(svc.port)));
  return ports.has(8443)
    || ports.has(10001)
    || ports.has(3478)
    || (ports.has(8080) && (ports.has(8443) || ports.has(10001) || ports.has(3478)));
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

  match(device, context) {
    const matched = hasUniFiHint(device) || hasUniFiPort(device.services || []);
    if (!matched) {
      return [];
    }

    let confidence = 0.54;
    if (hasUniFiHint(device)) confidence += 0.24;
    if (hasUniFiPort(device.services || [])) confidence += 0.12;
    if (String(device.type || "").toLowerCase() === "access-point" || String(device.type || "").toLowerCase() === "router") {
      confidence += 0.06;
    }

    return [{
      profileId: "steward.ubiquiti-unifi",
      name: "Ubiquiti / UniFi",
      kind: "primary",
      confidence: Math.min(0.98, confidence),
      summary: "UniFi-managed network gear or controller with HTTP management workflows.",
      evidence: {
        type: device.type,
        protocols: device.protocols,
      },
      requiredAccessMethods: ["http-api"],
      requiredCredentialProtocols: ["http-api"],
      defaultWorkloads: [
        {
          workloadKey: "controller-availability",
          displayName: "Controller and API availability",
          criticality: "high",
          category: "network",
          summary: "Keep the UniFi control surface reachable and trustworthy.",
        },
      ],
      defaultAssurances: [
        {
          assuranceKey: "controller-http-reachability",
          workloadKey: "controller-availability",
          displayName: "Controller HTTP reachability",
          criticality: "high",
          checkIntervalSec: 60,
          monitorType: "http_reachability",
          requiredProtocols: ["http-api"],
          rationale: "Most UniFi management and diagnostics flow through the controller API surface.",
        },
      ],
    }];
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

const GENERIC_MQTT_DEVICE_ADAPTER_SOURCE = `
function hasMqttPort(services) {
  return services.some((svc) => Number(svc.port) === 1883 || Number(svc.port) === 8883 || /mqtt/i.test(String(svc.name || "")));
}

module.exports = {
  match(device, context) {
    if (!hasMqttPort(device.services || []) && !(Array.isArray(device.protocols) && device.protocols.includes("mqtt"))) {
      return [];
    }

    let confidence = 0.34;
    if (hasMqttPort(device.services || [])) confidence += 0.22;
    if (Array.isArray(device.protocols) && device.protocols.includes("mqtt")) confidence += 0.12;

    return [{
      profileId: "steward.generic-mqtt-device",
      name: "Generic MQTT Device",
      kind: "fallback",
      confidence: Math.min(0.82, confidence),
      summary: "Generic profile for devices exposing MQTT telemetry or command topics.",
      evidence: {
        protocols: device.protocols,
      },
      requiredAccessMethods: ["mqtt"],
      requiredCredentialProtocols: ["mqtt"],
      defaultWorkloads: [
        {
          workloadKey: "mqtt-availability",
          displayName: "MQTT availability",
          criticality: "medium",
          category: "telemetry",
          summary: "Keep the MQTT management path alive and track topic freshness.",
        },
      ],
      defaultAssurances: [
        {
          assuranceKey: "mqtt-reachability",
          workloadKey: "mqtt-availability",
          displayName: "MQTT reachability",
          criticality: "medium",
          checkIntervalSec: 90,
          monitorType: "mqtt_reachability",
          requiredProtocols: ["mqtt"],
          rationale: "Steward can only reason about this class of device if the MQTT surface remains reachable.",
        },
      ],
    }];
  },
};
`;

const GENERIC_PRINTER_ADAPTER_SOURCE = `
function hasPrintingSurface(services) {
  return services.some((svc) =>
    [515, 631, 9100].includes(Number(svc.port)) || /printer|ipp|jetdirect|lpd/i.test(String(svc.name || "")));
}

module.exports = {
  match(device, context) {
    const printerLike = String(device.type || "").toLowerCase() === "printer" || hasPrintingSurface(device.services || []);
    if (!printerLike) {
      return [];
    }

    let confidence = 0.42;
    if (String(device.type || "").toLowerCase() === "printer") confidence += 0.22;
    if (hasPrintingSurface(device.services || [])) confidence += 0.14;

    return [{
      profileId: "steward.generic-printer",
      name: "Generic Printer",
      kind: "fallback",
      confidence: Math.min(0.88, confidence),
      summary: "Generic network printer profile for availability, queue, and supply monitoring.",
      evidence: {
        type: device.type,
      },
      requiredAccessMethods: ["printing"],
      requiredCredentialProtocols: [],
      defaultWorkloads: [
        {
          workloadKey: "printer-availability",
          displayName: "Printer availability",
          criticality: "medium",
          category: "perimeter",
          summary: "Keep the printer reachable and visible as a dependable shared device.",
        },
      ],
      defaultAssurances: [
        {
          assuranceKey: "printer-reachability",
          workloadKey: "printer-availability",
          displayName: "Printer reachability",
          criticality: "medium",
          checkIntervalSec: 120,
          monitorType: "printer_reachability",
          requiredProtocols: ["printing"],
          rationale: "Steward should detect printer disappearance or queue surface drift quickly.",
        },
      ],
    }];
  },
};
`;

const BAMBU_PRINTER_ADAPTER_SOURCE = `
function hasMqttPort(services) {
  return services.some((svc) => Number(svc.port) === 1883 || Number(svc.port) === 8883 || /mqtt/i.test(String(svc.name || "")));
}

function hasHttpPort(services) {
  return services.some((svc) => [80, 443, 8080, 8443].includes(Number(svc.port)) || /http|https|web/i.test(String(svc.name || "")));
}

function hasPrintingSurface(services) {
  return services.some((svc) =>
    [515, 631, 9100].includes(Number(svc.port)) || /printer|ipp|jetdirect|lpd/i.test(String(svc.name || "")));
}

function identityText(device) {
  const fingerprint = typeof device.metadata?.fingerprint === "object" && device.metadata.fingerprint !== null
    ? device.metadata.fingerprint
    : {};
  const browser = typeof device.metadata?.browserObservation === "object" && device.metadata.browserObservation !== null
    ? device.metadata.browserObservation
    : {};
  const browserTitles = Array.isArray(browser.endpoints)
    ? browser.endpoints
      .filter((value) => value && typeof value === "object")
      .map((value) => String(value.title || ""))
      .filter((value) => value.trim().length > 0)
    : [];
  return [
    device.name,
    device.hostname,
    device.vendor,
    device.os,
    device.role,
    String(fingerprint.inferredProduct || ""),
    ...browserTitles,
  ].filter(Boolean).join(" ").toLowerCase();
}

function hasBambuHint(device) {
  return /(bambu|bbl technologies|x1 carbon|x1c|p1s|p1p|a1 mini|a1 |a1$|h2d|\\bbbl\\b)/i.test(identityText(device));
}

module.exports = {
  match(device, context) {
    const services = device.services || [];
    const mqtt = hasMqttPort(services);
    const http = hasHttpPort(services);
    const printing = hasPrintingSurface(services);
    const bambu = hasBambuHint(device);

    if (!bambu && !(mqtt && printing)) {
      return [];
    }

    let confidence = 0.38;
    if (bambu) confidence += 0.38;
    if (mqtt) confidence += 0.14;
    if (http) confidence += 0.06;
    if (printing) confidence += 0.08;
    if (String(device.type || "").toLowerCase() === "printer") confidence += 0.06;

    return [{
      profileId: "steward.bambu-printer",
      name: "Bambu Printer",
      kind: "primary",
      confidence: Math.min(0.99, confidence),
      summary: "Bambu Lab printer with native MQTT telemetry and printer-specific responsibilities.",
      evidence: {
        mqtt,
        http,
        printing,
        bambu,
      },
      requiredAccessMethods: mqtt ? ["mqtt"] : ["printing"],
      requiredCredentialProtocols: mqtt ? ["mqtt"] : [],
      defaultWorkloads: [
        {
          workloadKey: "printer-availability",
          displayName: "Printer availability",
          criticality: "high",
          category: "perimeter",
          summary: "Keep the printer reachable and ready for jobs.",
        },
        {
          workloadKey: "print-telemetry",
          displayName: "Print telemetry and job state",
          criticality: "medium",
          category: "telemetry",
          summary: "Track job state, telemetry freshness, and unusual drift from normal behavior.",
        },
        {
          workloadKey: "firmware-posture",
          displayName: "Firmware posture",
          criticality: "low",
          category: "platform",
          summary: "Watch firmware version and update posture for known issues and lifecycle drift.",
        },
      ],
      defaultAssurances: [
        {
          assuranceKey: "bambu-mqtt-reachability",
          workloadKey: "print-telemetry",
          displayName: "MQTT reachability",
          criticality: "high",
          checkIntervalSec: 60,
          monitorType: "mqtt_reachability",
          requiredProtocols: ["mqtt"],
          rationale: "Bambu printers expose their richest live state through MQTT and Steward should keep that path healthy.",
        },
        {
          assuranceKey: "printer-http-reachability",
          workloadKey: "printer-availability",
          displayName: "Printer web reachability",
          criticality: "medium",
          checkIntervalSec: 120,
          monitorType: "http_reachability",
          requiredProtocols: http ? ["http-api"] : [],
          rationale: "A secondary HTTP reachability check helps Steward detect management surface drift early.",
        },
      ],
    }];
  },

  capabilities(device, context) {
    const matches = this.match(device, context) || [];
    if (!Array.isArray(matches) || matches.length === 0) {
      return [];
    }

    return [
      {
        id: "capability.bambu-printer",
        title: "Bambu Printer Operations",
        protocol: "mqtt",
        actions: [
          "Subscribe to printer telemetry",
          "Track job state and printer availability",
          "Stage firmware and maintenance posture checks",
        ],
      },
    ];
  },
};
`;

const ADVANCED_NETWORK_INTEL_ADAPTER_SOURCE = `
function hasManagedSurface(candidate) {
  const services = Array.isArray(candidate.services) ? candidate.services : [];
  return services.some((svc) => {
    const port = Number(svc.port);
    return [80, 443, 8080, 8443, 5000, 5001, 22, 161, 445, 5985, 5986].includes(port);
  });
}

module.exports = {
  enrich(candidate, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return candidate;
    }
    if (!hasManagedSurface(candidate)) {
      return candidate;
    }
    return {
      ...candidate,
      metadata: {
        ...(candidate.metadata || {}),
        advancedNetworkIntel: {
          managedBy: "steward.advanced-network-intel",
          scriptPreset: String(config.nmapScriptPreset || "banner,http-title,http-headers,ssl-cert,upnp-info"),
        },
      },
    };
  },

  capabilities(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }
    if (!hasManagedSurface(device)) {
      return [];
    }
    return [
      {
        id: "capability.advanced-network-intel",
        title: "Advanced Network Intel",
        protocol: "http",
        actions: [
          "Nmap NSE fingerprinting (banner/title/headers/SSL)",
          "Favicon hashing and appliance signature hints",
          "HTTP/HTTPS management surface contract analysis",
        ],
      },
    ];
  },
};
`;

const ROUTER_LEASE_INTEL_ADAPTER_SOURCE = `
function hasRouterHint(candidate) {
  const typeHint = String(candidate.typeHint || "").toLowerCase();
  const host = String(candidate.hostname || "").toLowerCase();
  const vendor = String(candidate.vendor || "").toLowerCase();
  const services = Array.isArray(candidate.services) ? candidate.services : [];
  const ports = services.map((svc) => Number(svc.port));
  return typeHint === "router"
    || host.includes("router")
    || host.includes("gateway")
    || vendor.includes("mikrotik")
    || vendor.includes("ubiquiti")
    || ((ports.includes(53) || ports.includes(67)) && (ports.includes(80) || ports.includes(443)));
}

module.exports = {
  enrich(candidate, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return candidate;
    }
    if (!hasRouterHint(candidate)) {
      return candidate;
    }
    return {
      ...candidate,
      typeHint: candidate.typeHint && candidate.typeHint !== "unknown" ? candidate.typeHint : "router",
      metadata: {
        ...(candidate.metadata || {}),
        routerLeaseIntel: {
          managedBy: "steward.router-lease-intel",
          preferredLeaseEndpoint: String(config.preferredLeaseEndpoint || "/"),
        },
      },
    };
  },

  capabilities(device, context) {
    const config = context.getConfig();
    if (config.enabled === false) {
      return [];
    }
    if (!hasRouterHint(device)) {
      return [];
    }
    return [
      {
        id: "capability.router-lease-intel",
        title: "Router Lease Intelligence",
        protocol: "http",
        actions: [
          "Collect DHCP lease snapshots from router APIs",
          "Track client inventory drift and unknown clients",
          "Correlate lease hostnames with discovered devices",
        ],
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
      version: "1.0.1",
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
    dirName: "steward-advanced-network-intel",
    manifest: {
      id: "steward.advanced-network-intel",
      name: "Advanced Network Intel",
      description: "Deep network fingerprinting adapter with nmap NSE, favicon signatures, and web-surface contract checks.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["enrichment", "protocol"],
      docsUrl: "https://steward.local/docs/adapters/advanced-network-intel",
      configSchema: [
        {
          key: "enabled",
          label: "Enabled",
          type: "boolean",
          default: true,
        },
        {
          key: "nmapScriptPreset",
          label: "Nmap Script Preset",
          type: "string",
          default: "banner,http-title,http-headers,ssl-cert,upnp-info",
        },
      ],
      defaultConfig: {
        enabled: true,
        nmapScriptPreset: "banner,http-title,http-headers,ssl-cert,upnp-info",
      },
      toolSkills: [
        {
          id: "skill.advanced.nmap-nse",
          name: "Nmap NSE Fingerprint",
          description: "Run deep service and script fingerprinting against a managed endpoint.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          toolCall: {
            name: "steward_nmap_fingerprint",
            description: "Run nmap NSE fingerprinting for an attached device.",
            parameters: {
              type: "object",
              properties: {
                device_id: { type: "string" },
                input: {
                  type: "object",
                  properties: {
                    timeout_ms: { type: "number" },
                  },
                  additionalProperties: true,
                },
              },
              required: ["device_id"],
              additionalProperties: false,
            },
          },
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "shell",
            timeoutMs: 90000,
            commandTemplate: "nmap -Pn -n --open -sV --version-light --script \"banner,http-title,http-headers,ssl-cert,upnp-info\" -p 80,443,135,139,445,3389,5985,5986,554,8080,8443,5000,5001,22,161,1883,2375 {{host}}",
            expectedSemanticTarget: "network:intel:nmap",
          },
        },
        {
          id: "skill.advanced.favicon-hash",
          name: "Favicon Fingerprint",
          description: "Hash /favicon.ico to identify appliance families and web-console lineage.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          toolCall: {
            name: "steward_favicon_fingerprint",
            description: "Compute favicon hash on a target device.",
            parameters: {
              type: "object",
              properties: {
                device_id: { type: "string" },
              },
              required: ["device_id"],
              additionalProperties: false,
            },
          },
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "shell",
            timeoutMs: 15000,
            commandTemplate: `node -e "const http=require('node:http');const https=require('node:https');const crypto=require('node:crypto');const urls=['http://{{host}}/favicon.ico','https://{{host}}/favicon.ico'];const fetchIcon=(url)=>new Promise((resolve,reject)=>{const client=url.startsWith('https:')?https:http;const req=client.get(url,{rejectUnauthorized:false,timeout:8000},(response)=>{const status=response.statusCode??0;if(status>=300&&status<400&&response.headers.location){const redirect=new URL(response.headers.location,url).toString();response.resume();fetchIcon(redirect).then(resolve,reject);return;}if(status!==200){response.resume();reject(new Error('HTTP '+status));return;}const chunks=[];response.on('data',(chunk)=>chunks.push(chunk));response.on('end',()=>resolve(Buffer.concat(chunks)));});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',reject);});(async()=>{let lastError;for(const url of urls){try{const body=await fetchIcon(url);process.stdout.write(crypto.createHash('sha256').update(body).digest('hex')+'  favicon.ico\\n');return;}catch(error){lastError=error;}}console.error(lastError instanceof Error?lastError.message:String(lastError));process.exit(1);})();"`,
            expectedSemanticTarget: "network:intel:favicon",
          },
        },
        {
          id: "skill.advanced.http-contract",
          name: "HTTP Contract Audit",
          description: "Profile headers, title, redirects, and auth surface for appliance-style endpoints.",
          category: "operations",
          operationKinds: ["http.request"],
          enabledByDefault: true,
          toolCall: {
            name: "steward_http_contract_audit",
            description: "Run HTTP contract probe against the target device.",
            parameters: {
              type: "object",
              properties: {
                device_id: { type: "string" },
                input: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    port: { type: "number" },
                    secure: { type: "boolean" },
                    timeout_ms: { type: "number" },
                  },
                  additionalProperties: true,
                },
              },
              required: ["device_id"],
              additionalProperties: false,
            },
          },
          execution: {
            kind: "http.request",
            mode: "read",
            adapterId: "http-api",
            timeoutMs: 12000,
            expectedSemanticTarget: "network:intel:http-contract",
          },
        },
        {
          id: "skill.advanced.rtsp-probe",
          name: "RTSP Probe",
          description: "Verify whether a device speaks RTSP on a target port without assuming an HTTP surface.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          toolCall: {
            name: "steward_rtsp_probe",
            description: "Probe an attached device for an RTSP control surface.",
            parameters: {
              type: "object",
              properties: {
                device_id: { type: "string" },
                port: { type: "number", description: "Optional RTSP port override. Defaults to 554." },
                timeout_ms: { type: "number", description: "Optional probe timeout in milliseconds." },
              },
              required: ["device_id"],
              additionalProperties: false,
            },
          },
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "shell",
            timeoutMs: 15000,
            commandTemplate: `node -e "const net=require('node:net');const host='{{host}}';const port=Number('{{port}}')||554;const socket=net.createConnection({host,port});let settled=false;let data='';const finish=(code,message)=>{if(settled)return;settled=true;try{socket.destroy();}catch{}const text=(message||'').trim();if(text){(code===0?process.stdout:process.stderr).write(text+'\\n');}process.exit(code);};socket.setTimeout(5000,()=>finish(1,'RTSP probe timed out'));socket.on('error',(error)=>finish(1,error instanceof Error?error.message:String(error)));socket.on('connect',()=>{socket.write('OPTIONS * RTSP/1.0\\r\\nCSeq: 1\\r\\nUser-Agent: Steward\\r\\n\\r\\n');});socket.on('data',(chunk)=>{data+=chunk.toString('utf8');if(!data.includes('\\r\\n\\r\\n')){return;}const lines=data.split(/\\r?\\n/).map((line)=>line.trim()).filter(Boolean);const status=lines[0]??'';const publicHeader=lines.find((line)=>/^Public:/i.test(line))??'';if(/^RTSP\\/1\\.0\\s+\\d+/.test(status)){finish(0,[status,publicHeader].filter(Boolean).join(' | ')||'RTSP response received');return;}finish(1,status||'Non-RTSP response received');});"`,
            expectedSemanticTarget: "network:intel:rtsp",
          },
        },
      ],
      defaultToolConfig: {
        "skill.advanced.nmap-nse": { enabled: true },
        "skill.advanced.favicon-hash": { enabled: true },
        "skill.advanced.http-contract": { enabled: true },
        "skill.advanced.rtsp-probe": { enabled: true },
      },
    },
    entrySource: ADVANCED_NETWORK_INTEL_ADAPTER_SOURCE,
  },
  {
    dirName: "steward-router-lease-intel",
    manifest: {
      id: "steward.router-lease-intel",
      name: "Router Lease Intel",
      description: "Router-focused adapter for DHCP lease polling and client inventory correlation.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["enrichment", "protocol"],
      docsUrl: "https://steward.local/docs/adapters/router-lease-intel",
      configSchema: [
        { key: "enabled", label: "Enabled", type: "boolean", default: true },
        {
          key: "preferredLeaseEndpoint",
          label: "Preferred Lease Endpoint",
          type: "string",
          default: "/api/v1/status/dhcp_server/leases",
        },
        {
          key: "fallbackLeaseEndpoint",
          label: "Fallback Lease Endpoint",
          type: "string",
          default: "/proxy/network/api/s/default/stat/sta",
        },
      ],
      defaultConfig: {
        enabled: true,
        preferredLeaseEndpoint: "/api/v1/status/dhcp_server/leases",
        fallbackLeaseEndpoint: "/proxy/network/api/s/default/stat/sta",
      },
      toolSkills: [
        {
          id: "skill.router.lease-snapshot",
          name: "Lease Snapshot",
          description: "Fetch DHCP lease/client inventory snapshots from router APIs.",
          category: "operations",
          operationKinds: ["http.request"],
          enabledByDefault: true,
          toolCall: {
            name: "steward_router_lease_snapshot",
            description: "Collect a lease snapshot from the target router.",
            parameters: {
              type: "object",
              properties: {
                device_id: { type: "string" },
                input: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    port: { type: "number" },
                    secure: { type: "boolean" },
                    timeout_ms: { type: "number" },
                  },
                  additionalProperties: true,
                },
              },
              required: ["device_id"],
              additionalProperties: false,
            },
          },
          execution: {
            kind: "http.request",
            mode: "read",
            adapterId: "http-api",
            timeoutMs: 15000,
            expectedSemanticTarget: "router:leases",
          },
        },
        {
          id: "skill.router.client-drift",
          name: "Client Drift Detection",
          description: "Compare active clients/leases over time and surface new unknown endpoints.",
          category: "diagnostics",
          operationKinds: ["http.request"],
          enabledByDefault: true,
          toolCall: {
            name: "steward_router_client_drift",
            description: "Probe router client inventory for drift analysis.",
            parameters: {
              type: "object",
              properties: {
                device_id: { type: "string" },
                input: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    port: { type: "number" },
                    secure: { type: "boolean" },
                    timeout_ms: { type: "number" },
                  },
                  additionalProperties: true,
                },
              },
              required: ["device_id"],
              additionalProperties: false,
            },
          },
          execution: {
            kind: "http.request",
            mode: "read",
            adapterId: "http-api",
            timeoutMs: 15000,
            expectedSemanticTarget: "router:clients",
          },
        },
      ],
      defaultToolConfig: {
        "skill.router.lease-snapshot": { enabled: true },
        "skill.router.client-drift": { enabled: true },
      },
    },
    entrySource: ROUTER_LEASE_INTEL_ADAPTER_SOURCE,
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
      provides: ["enrichment", "protocol", "playbooks", "profile"],
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
          description: "Inspect running responsibilities and identify stale container services.",
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
      version: "1.0.1",
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
          execution: {
            adapterId: "snmp",
            mode: "read",
          },
          enabledByDefault: true,
        },
        {
          id: "skill.snmp.firmware-posture",
          name: "Firmware Posture",
          description: "Track sysDescr and firmware drift on network devices.",
          category: "security",
          operationKinds: ["shell.command"],
          execution: {
            adapterId: "snmp",
            mode: "read",
          },
          enabledByDefault: true,
        },
        {
          id: "skill.snmp.port-errors",
          name: "Port Error Analysis",
          description: "Track CRC/error/discard trends and surface degraded interfaces.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          execution: {
            adapterId: "snmp",
            mode: "read",
          },
          enabledByDefault: true,
        },
        {
          id: "skill.snmp.topology-hints",
          name: "Topology Hints",
          description: "Build L2/L3 relationship hints from SNMP metadata and neighbor signals.",
          category: "operations",
          operationKinds: ["shell.command"],
          execution: {
            adapterId: "snmp",
            mode: "read",
          },
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
      provides: ["enrichment", "protocol", "playbooks", "profile"],
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
      description: "Remote Windows server adapter with WinRM-based classification and operational skills.",
      version: "1.1.1",
      author: "Steward",
      entry: "index.js",
      provides: ["enrichment", "protocol", "playbooks", "profile"],
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
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "winrm",
            timeoutMs: 45000,
            commandTemplate:
              "Get-Service | Sort-Object Status,DisplayName | Select-Object -First 40 Status,Name,DisplayName,StartType",
            expectedSemanticTarget: "windows:service-audit",
          },
        },
        {
          id: "skill.windows.patch-posture",
          name: "Windows Patch Posture",
          description: "Track Windows Update and patch-ring readiness.",
          category: "security",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "winrm",
            timeoutMs: 45000,
            commandTemplate:
              "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' | Select-Object ProductName,DisplayVersion,CurrentBuild,UBR; Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 12 HotFixID,InstalledOn,Description",
            expectedSemanticTarget: "windows:patch-posture",
          },
        },
        {
          id: "skill.windows.eventlog-watch",
          name: "Event Log Watch",
          description: "Review critical event logs and detect recurring fault signatures.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "winrm",
            timeoutMs: 45000,
            commandTemplate:
              "Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=(Get-Date).AddHours(-24)} -MaxEvents 20 | Select-Object TimeCreated,Id,ProviderName,LevelDisplayName,Message",
            expectedSemanticTarget: "windows:eventlog-watch",
          },
        },
        {
          id: "skill.windows.rdp-posture",
          name: "RDP Posture",
          description: "Assess remote desktop exposure and hardening posture.",
          category: "security",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "winrm",
            timeoutMs: 45000,
            commandTemplate:
              "$ts='HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server'; $rdp='HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp'; Get-ItemProperty $ts | Select-Object fDenyTSConnections,AllowTSConnections; Get-ItemProperty $rdp | Select-Object PortNumber,SecurityLayer,UserAuthentication",
            expectedSemanticTarget: "windows:rdp-posture",
          },
        },
        {
          id: "skill.windows.powershell-ssh-posture",
          name: "PowerShell SSH Posture",
          description: "Inspect Windows server posture over PowerShell over SSH.",
          category: "operations",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "powershell-ssh",
            timeoutMs: 45000,
            commandTemplate:
              "Get-CimInstance Win32_OperatingSystem | Select-Object CSName,Caption,Version,LastBootUpTime; Get-Service | Sort-Object Status,DisplayName | Select-Object -First 20 Status,Name,DisplayName",
            expectedSemanticTarget: "windows:powershell-ssh-posture",
          },
        },
        {
          id: "skill.windows.wmi-inventory",
          name: "WMI Inventory",
          description: "Collect Windows server inventory and service posture over WMI/CIM.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "wmi",
            timeoutMs: 45000,
            commandTemplate:
              "Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem | Select-Object CSName,Caption,Version,LastBootUpTime; Get-CimInstance -CimSession $session -ClassName Win32_Service | Select-Object -First 20 Name,State,StartMode",
            expectedSemanticTarget: "windows:wmi-inventory",
          },
        },
        {
          id: "skill.windows.smb-share-audit",
          name: "SMB Share Audit",
          description: "Inspect administrative-share contents relevant to Windows server operations.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "smb",
            timeoutMs: 45000,
            commandTemplate:
              "Get-ChildItem $sharePath\\Windows\\System32 | Select-Object -First 25 Name,Length,LastWriteTime",
            expectedSemanticTarget: "windows:smb-share-audit",
          },
        },
      ],
      webFlows: [
        {
          id: "generic.web-console-login",
          name: "Generic Web Console Login",
          description: "Open the device web UI, authenticate with stored HTTP credentials, and persist the session for reuse across turns.",
          startUrl: "/",
          requiresAuth: true,
          postLoginWaitMs: 3000,
          successAssertions: [
            { selector: "body" },
          ],
          steps: [],
        },
        {
          id: "generic.web-console-home",
          name: "Generic Web Console Home",
          description: "Open the device web UI home or landing page using an existing managed session and capture the current state.",
          startUrl: "/",
          requiresAuth: false,
          successAssertions: [
            { selector: "body" },
          ],
          steps: [
            {
              action: "extract_text",
              label: "page_body",
            },
          ],
        },
      ],
      defaultToolConfig: {
        "skill.windows.service-audit": { enabled: true, includeDisabled: false },
        "skill.windows.patch-posture": { enabled: true, maxAgeDays: 30 },
        "skill.windows.eventlog-watch": { enabled: true, lookbackHours: 24 },
        "skill.windows.rdp-posture": { enabled: true, requireNla: true },
        "skill.windows.powershell-ssh-posture": { enabled: true },
        "skill.windows.wmi-inventory": { enabled: true },
        "skill.windows.smb-share-audit": { enabled: true },
      },
    },
    entrySource: WINDOWS_SERVER_ADAPTER_SOURCE,
  },
  {
    dirName: "steward-windows-workstation",
    manifest: {
      id: "steward.windows-workstation",
      name: "Windows Workstation",
      description: "Desktop/laptop adapter for Windows workstations, gaming PCs, and RDP-exposed personal machines.",
      version: "1.0.2",
      author: "Steward",
      entry: "index.js",
      provides: ["enrichment", "protocol", "playbooks", "profile"],
      docsUrl: "https://steward.local/docs/adapters/windows-workstation",
      configSchema: [
        { key: "enabled", label: "Enabled", type: "boolean", default: true },
        {
          key: "profile",
          label: "Usage Profile",
          type: "select",
          default: "personal",
          options: [
            { label: "Personal", value: "personal" },
            { label: "Developer", value: "developer" },
            { label: "Gaming", value: "gaming" },
            { label: "Shared", value: "shared" },
          ],
        },
        {
          key: "enableSnapshotPlaybook",
          label: "Enable Snapshot Playbook",
          type: "boolean",
          default: true,
        },
      ],
      defaultConfig: {
        enabled: true,
        profile: "personal",
        enableSnapshotPlaybook: true,
      },
      toolSkills: [
        {
          id: "skill.windows-workstation.snapshot",
          name: "Workstation Snapshot",
          description: "Collect Windows desktop health, hardware identity, and last boot posture.",
          category: "operations",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "winrm",
            timeoutMs: 45000,
            commandTemplate:
              "Get-CimInstance Win32_OperatingSystem | Select-Object CSName,Caption,Version,LastBootUpTime; Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,UserName,TotalPhysicalMemory",
            expectedSemanticTarget: "windows:workstation-snapshot",
          },
        },
        {
          id: "skill.windows-workstation.user-session",
          name: "Interactive Session Audit",
          description: "Inspect signed-in users and the most active foreground processes on a Windows workstation.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "winrm",
            timeoutMs: 45000,
            commandTemplate:
              "quser 2>$null; Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 ProcessName,Id,CPU,WS",
            expectedSemanticTarget: "windows:interactive-session",
          },
        },
        {
          id: "skill.windows-workstation.gpu-posture",
          name: "GPU / Display Posture",
          description: "Inspect GPU, monitor, and graphics driver posture for a Windows workstation.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "winrm",
            timeoutMs: 45000,
            commandTemplate:
              "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM,VideoProcessor; Get-CimInstance Win32_DesktopMonitor | Select-Object Name,ScreenWidth,ScreenHeight,PNPDeviceID",
            expectedSemanticTarget: "windows:gpu-posture",
          },
        },
        {
          id: "skill.windows-workstation.startup-posture",
          name: "Startup Posture",
          description: "Review startup commands and scheduled tasks that affect workstation boot hygiene.",
          category: "security",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "winrm",
            timeoutMs: 45000,
            commandTemplate:
              "Get-CimInstance Win32_StartupCommand | Select-Object -First 30 Name,Location,User,Command; Get-ScheduledTask | Select-Object -First 20 TaskName,TaskPath,State",
            expectedSemanticTarget: "windows:startup-posture",
          },
        },
        {
          id: "skill.windows-workstation.powershell-ssh-snapshot",
          name: "PowerShell SSH Snapshot",
          description: "Collect workstation posture over PowerShell over SSH.",
          category: "operations",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "powershell-ssh",
            timeoutMs: 45000,
            commandTemplate:
              "Get-CimInstance Win32_OperatingSystem | Select-Object CSName,Caption,Version,LastBootUpTime; quser 2>$null",
            expectedSemanticTarget: "windows:powershell-ssh-workstation-snapshot",
          },
        },
        {
          id: "skill.windows-workstation.wmi-hardware",
          name: "WMI Hardware Audit",
          description: "Inspect workstation hardware and session posture over WMI/CIM.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "wmi",
            timeoutMs: 45000,
            commandTemplate:
              "Get-CimInstance -CimSession $session -ClassName Win32_ComputerSystem | Select-Object Manufacturer,Model,UserName,TotalPhysicalMemory; Get-CimInstance -CimSession $session -ClassName Win32_VideoController | Select-Object Name,DriverVersion",
            expectedSemanticTarget: "windows:wmi-hardware-audit",
          },
        },
        {
          id: "skill.windows-workstation.smb-profile-audit",
          name: "SMB Profile Audit",
          description: "Inspect workstation user-profile directories over SMB administrative shares.",
          category: "diagnostics",
          operationKinds: ["shell.command"],
          enabledByDefault: true,
          execution: {
            kind: "shell.command",
            mode: "read",
            adapterId: "smb",
            timeoutMs: 45000,
            commandTemplate:
              "Get-ChildItem $sharePath\\Users | Select-Object -First 20 Name,LastWriteTime",
            expectedSemanticTarget: "windows:smb-profile-audit",
          },
        },
      ],
      defaultToolConfig: {
        "skill.windows-workstation.snapshot": { enabled: true },
        "skill.windows-workstation.user-session": { enabled: true },
        "skill.windows-workstation.gpu-posture": { enabled: true },
        "skill.windows-workstation.startup-posture": { enabled: true },
        "skill.windows-workstation.powershell-ssh-snapshot": { enabled: true },
        "skill.windows-workstation.wmi-hardware": { enabled: true },
        "skill.windows-workstation.smb-profile-audit": { enabled: true },
      },
    },
    entrySource: WINDOWS_WORKSTATION_ADAPTER_SOURCE,
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
      provides: ["enrichment", "protocol", "playbooks", "profile"],
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
  {
    dirName: "steward-generic-mqtt-device",
    manifest: {
      id: "steward.generic-mqtt-device",
      name: "Generic MQTT Device",
      description: "Fallback profile for devices that expose MQTT telemetry or commands but do not yet match a richer product profile.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["profile"],
      docsUrl: "https://steward.local/docs/adapters/generic-mqtt-device",
      configSchema: [
        { key: "enabled", label: "Enabled", type: "boolean", default: true },
      ],
      defaultConfig: {
        enabled: true,
      },
      toolSkills: [],
      defaultToolConfig: {},
    },
    entrySource: GENERIC_MQTT_DEVICE_ADAPTER_SOURCE,
  },
  {
    dirName: "steward-generic-printer",
    manifest: {
      id: "steward.generic-printer",
      name: "Generic Printer",
      description: "Fallback profile for shared printers and print appliances when no richer vendor profile has matched yet.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["profile"],
      docsUrl: "https://steward.local/docs/adapters/generic-printer",
      configSchema: [
        { key: "enabled", label: "Enabled", type: "boolean", default: true },
      ],
      defaultConfig: {
        enabled: true,
      },
      toolSkills: [],
      defaultToolConfig: {},
    },
    entrySource: GENERIC_PRINTER_ADAPTER_SOURCE,
  },
  {
    dirName: "steward-bambu-printer",
    manifest: {
      id: "steward.bambu-printer",
      name: "Bambu Printer",
      description: "First-party Bambu Lab printer profile with native MQTT and printer responsibility modeling.",
      version: "1.0.0",
      author: "Steward",
      entry: "index.js",
      provides: ["profile", "protocol"],
      docsUrl: "https://steward.local/docs/adapters/bambu-printer",
      configSchema: [
        { key: "enabled", label: "Enabled", type: "boolean", default: true },
      ],
      defaultConfig: {
        enabled: true,
      },
      toolSkills: [],
      defaultToolConfig: {},
    },
    entrySource: BAMBU_PRINTER_ADAPTER_SOURCE,
  },
];
