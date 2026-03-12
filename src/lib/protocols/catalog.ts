import type { Device } from "@/lib/state/types";

export const SUPPORTED_CREDENTIAL_PROTOCOLS = [
  "ssh",
  "telnet",
  "winrm",
  "powershell-ssh",
  "wmi",
  "smb",
  "rdp",
  "vnc",
  "snmp",
  "http-api",
  "docker",
  "kubernetes",
  "mqtt",
  "rtsp",
  "printing",
] as const;

export type SupportedCredentialProtocol = (typeof SUPPORTED_CREDENTIAL_PROTOCOLS)[number];

const LINUX_PLATFORM_HINT =
  /(ubuntu|debian|linux|unix|centos|rhel|rocky|almalinux|fedora|openssh_.*ubuntu)/i;

export function normalizeCredentialProtocol(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "http" || normalized === "https") return "http-api";
  if (normalized === "mqtts") return "mqtt";
  if (normalized === "rfb") return "vnc";
  if (normalized === "ipp" || normalized === "printer" || normalized === "lpd") return "printing";
  return normalized;
}

export function protocolDisplayLabel(protocol: string): string {
  switch (normalizeCredentialProtocol(protocol)) {
    case "web-session":
      return "Managed Web UI Session";
    case "ssh":
      return "SSH";
    case "telnet":
      return "Telnet";
    case "winrm":
      return "WinRM";
    case "powershell-ssh":
      return "PowerShell over SSH";
    case "wmi":
      return "WMI";
    case "smb":
      return "SMB";
    case "rdp":
      return "Remote Desktop";
    case "vnc":
      return "VNC Remote Desktop";
    case "snmp":
      return "SNMP";
    case "http-api":
      return "HTTP / Web UI";
    case "docker":
      return "Docker API";
    case "kubernetes":
      return "Kubernetes API";
    case "mqtt":
      return "MQTT";
    case "rtsp":
      return "RTSP";
    case "printing":
      return "Printing";
    default:
      return protocol;
  }
}

export function isSupportedCredentialProtocol(value: string): value is SupportedCredentialProtocol {
  return (SUPPORTED_CREDENTIAL_PROTOCOLS as readonly string[]).includes(normalizeCredentialProtocol(value));
}

export function isWindowsPlatformDevice(device: Pick<Device, "name" | "hostname" | "os" | "role" | "vendor" | "protocols" | "services">): boolean {
  const text = [device.name, device.hostname, device.os, device.role]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const serviceText = (device.services ?? [])
    .map((service) => [service.name, service.product, service.banner].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase();
  const combinedText = `${text} ${serviceText}`.trim();
  const protocols = new Set(
    (device.protocols ?? []).map((protocol) => normalizeCredentialProtocol(protocol)),
  );
  const vendor = String(device.vendor ?? "").toLowerCase();
  const ports = new Set((device.services ?? []).map((service) => Number(service.port)));
  const explicitWindowsText =
    /(windows|active directory|domain controller|hyper-v|exchange|sql server)/.test(combinedText);
  const strongWindowsTransport =
    protocols.has("winrm")
    || protocols.has("powershell-ssh")
    || protocols.has("wmi")
    || ports.has(5985)
    || ports.has(5986)
    || ports.has(3389);
  const windowsServiceCluster =
    (ports.has(135) && ports.has(445))
    || (ports.has(88) && ports.has(389));

  if (explicitWindowsText || strongWindowsTransport || windowsServiceCluster) {
    return true;
  }

  if (LINUX_PLATFORM_HINT.test(combinedText)) {
    return false;
  }

  return vendor.includes("microsoft") && (strongWindowsTransport || windowsServiceCluster);
}

