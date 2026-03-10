import type { Device } from "@/lib/state/types";
import { adapterRegistry } from "@/lib/adapters/registry";

export interface ManagementCapability {
  id: string;
  title: string;
  protocol: string;
  actions: string[];
}

export interface DeviceManagementSurface {
  deviceId: string;
  preferredProtocol?: string;
  capabilities: ManagementCapability[];
}

const hasPort = (device: Device, port: number): boolean =>
  device.services.some((service) => service.port === port);

export const buildManagementSurface = (device: Device): DeviceManagementSurface => {
  const capabilities: ManagementCapability[] = [];

  if (hasPort(device, 22)) {
    capabilities.push({
      id: "ssh-core",
      title: "Shell Management",
      protocol: "ssh",
      actions: [
        "Patch status audit",
        "Service health checks",
        "Disk and SMART inspection",
        "Log analysis",
      ],
    });
  }

  if (hasPort(device, 5985) || hasPort(device, 5986)) {
    capabilities.push({
      id: "winrm-core",
      title: "Windows Remote Management",
      protocol: "winrm",
      actions: [
        "Update state",
        "Scheduled task inventory",
        "Firewall policy review",
      ],
    });
  }

  if (hasPort(device, 22) && /(windows|microsoft|active directory|domain controller)/i.test([device.name, device.hostname, device.os, device.role, device.vendor].filter(Boolean).join(" "))) {
    capabilities.push({
      id: "powershell-ssh-core",
      title: "PowerShell over SSH",
      protocol: "powershell-ssh",
      actions: [
        "Remote PowerShell commands",
        "Fallback automation when WinRM is unavailable",
        "Scripted diagnostics and service control",
      ],
    });
  }

  if (hasPort(device, 135)) {
    capabilities.push({
      id: "wmi-core",
      title: "WMI / RPC Management",
      protocol: "wmi",
      actions: [
        "System inventory",
        "Process and service interrogation",
        "RPC/DCOM management workflows",
      ],
    });
  }

  if (hasPort(device, 445)) {
    capabilities.push({
      id: "smb-core",
      title: "SMB Share Access",
      protocol: "smb",
      actions: [
        "File staging and retrieval",
        "Administrative share access",
        "Artifact collection",
      ],
    });
  }

  if (hasPort(device, 3389)) {
    capabilities.push({
      id: "rdp-core",
      title: "Remote Desktop Surface",
      protocol: "rdp",
      actions: [
        "RDP reachability checks",
        "Exposure review",
        "Session access posture",
      ],
    });
  }

  if (hasPort(device, 161)) {
    capabilities.push({
      id: "snmp-core",
      title: "SNMP Telemetry",
      protocol: "snmp",
      actions: [
        "Interface health",
        "Traffic trend analysis",
        "Firmware inventory",
      ],
    });
  }

  if (hasPort(device, 1883) || hasPort(device, 8883)) {
    capabilities.push({
      id: "mqtt-core",
      title: "MQTT Device Bus",
      protocol: "mqtt",
      actions: [
        "Subscribe to live device telemetry",
        "Publish native device commands",
        "Verify protocol-level acknowledgements",
      ],
    });
  }

  if (hasPort(device, 2375) || hasPort(device, 2376)) {
    capabilities.push({
      id: "docker-core",
      title: "Container Runtime",
      protocol: "docker",
      actions: [
        "Container inventory",
        "Image update checks",
        "Restart failed workloads",
      ],
    });
  }

  if (hasPort(device, 6443)) {
    capabilities.push({
      id: "k8s-core",
      title: "Kubernetes API",
      protocol: "kubernetes",
      actions: [
        "Workload health",
        "Node pressure checks",
        "Rolling update orchestration",
      ],
    });
  }

  if (hasPort(device, 80) || hasPort(device, 443)) {
    capabilities.push({
      id: "web-session-core",
      title: "Managed Web UI Session",
      protocol: "web-session",
      actions: [
        "Persist browser-authenticated management sessions",
        "Replay web-management flows across turns",
        "Promote UI-discovered contracts into managed operations",
      ],
    });
    capabilities.push({
      id: "http-core",
      title: "API / Web Console",
      protocol: "http",
      actions: [
        "Session auth",
        "Config backup",
        "Version tracking",
      ],
    });
  }

  // Adapter capabilities
  capabilities.push(...adapterRegistry.getAdapterCapabilities(device));

  const preferredProtocol = capabilities[0]?.protocol;

  return {
    deviceId: device.id,
    preferredProtocol,
    capabilities,
  };
};

