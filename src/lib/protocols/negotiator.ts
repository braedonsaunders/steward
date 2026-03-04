import type { Device } from "@/lib/state/types";

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

  if (hasPort(device, 5985) || hasPort(device, 5986) || hasPort(device, 3389)) {
    capabilities.push({
      id: "winrm-core",
      title: "Windows Host Management",
      protocol: "winrm",
      actions: [
        "Update state",
        "Scheduled task inventory",
        "Firewall policy review",
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

  const preferredProtocol = capabilities[0]?.protocol;

  return {
    deviceId: device.id,
    preferredProtocol,
    capabilities,
  };
};
