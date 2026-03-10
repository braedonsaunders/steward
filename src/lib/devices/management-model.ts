import type { AccessMethod, Device, DeviceCredential } from "@/lib/state/types";
import { isWindowsPlatformDevice, normalizeCredentialProtocol, protocolDisplayLabel } from "@/lib/protocols/catalog";

const HTTP_PORTS = new Set([80, 443, 8080, 8443, 5000, 5001, 7443, 9000, 9443]);
const PRINTING_PORTS = new Set([515, 631, 9100]);

function nowIso(): string {
  return new Date().toISOString();
}

function inferCredentialProtocol(kind: string): string | undefined {
  switch (kind) {
    case "web-session":
      return "http-api";
    case "ssh":
    case "winrm":
    case "powershell-ssh":
    case "wmi":
    case "smb":
    case "rdp":
    case "vnc":
    case "snmp":
    case "http-api":
    case "docker":
    case "kubernetes":
    case "mqtt":
    case "printing":
      return kind;
    default:
      return undefined;
  }
}

function inferTitle(kind: string, port?: number): string {
  const label = protocolDisplayLabel(kind);
  return port ? `${label} :${port}` : label;
}

function credentialStatus(
  kind: string,
  credentials: DeviceCredential[],
): AccessMethod["status"] {
  const protocol = inferCredentialProtocol(kind);
  if (!protocol) {
    return "observed";
  }

  const matching = credentials.filter((credential) => normalizeCredentialProtocol(credential.protocol) === protocol);
  if (matching.some((credential) => credential.status === "validated")) {
    return "validated";
  }
  if (matching.some((credential) => credential.status === "invalid")) {
    return "rejected";
  }
  if (matching.length > 0) {
    return "credentialed";
  }
  return "observed";
}

function accessMethodKey(kind: string, port?: number): string {
  return port ? `${kind}:${port}` : kind;
}

function hasDeviceProtocol(device: Device, protocol: string): boolean {
  const normalized = normalizeCredentialProtocol(protocol);
  return device.protocols.some((candidate) => normalizeCredentialProtocol(candidate) === normalized);
}

function hasMethodOfKind(methods: Map<string, AccessMethod>, kind: AccessMethod["kind"]): boolean {
  return Array.from(methods.values()).some((method) => method.kind === kind);
}

function secureFallbackForKind(kind: AccessMethod["kind"]): boolean {
  switch (kind) {
    case "ssh":
    case "powershell-ssh":
    case "http-api":
    case "web-session":
    case "kubernetes":
    case "mqtt":
    case "rdp":
    case "vnc":
      return true;
    default:
      return false;
  }
}

function credentialFallbackKinds(protocol: string): AccessMethod["kind"][] {
  const normalized = normalizeCredentialProtocol(protocol);
  switch (normalized) {
    case "http-api":
      return ["http-api", "web-session"];
    default:
      return [normalized as AccessMethod["kind"]];
  }
}

export function buildObservedAccessMethods(args: {
  device: Device;
  credentials: DeviceCredential[];
  existing: AccessMethod[];
  selectedKeys?: string[];
}): AccessMethod[] {
  const now = nowIso();
  const existingByKey = new Map(args.existing.map((method) => [method.key, method]));
  const explicitSelection = new Set((args.selectedKeys ?? []).map((value) => value.trim()).filter(Boolean));
  const methods = new Map<string, AccessMethod>();

  const addMethod = (input: {
    kind: AccessMethod["kind"];
    protocol?: string;
    port?: number;
    secure?: boolean;
    summary?: string;
    metadata?: Record<string, unknown>;
  }) => {
    const key = accessMethodKey(input.kind, input.port);
    const existing = existingByKey.get(key);
    const status = credentialStatus(input.kind, args.credentials);
    const selected = explicitSelection.size > 0
      ? explicitSelection.has(key)
      : Boolean(existing?.selected);

    methods.set(key, {
      id: existing?.id ?? `access-method-${args.device.id}-${key.replace(/[^a-z0-9:-]+/gi, "-")}`,
      deviceId: args.device.id,
      key,
      kind: input.kind,
      title: inferTitle(input.kind, input.port),
      protocol: input.protocol ?? input.kind,
      port: input.port,
      secure: Boolean(input.secure),
      selected,
      status,
      credentialProtocol: inferCredentialProtocol(input.kind),
      summary: input.summary ?? existing?.summary,
      metadataJson: {
        ...(existing?.metadataJson ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  };

  for (const service of args.device.services) {
    const port = Number(service.port);
    const name = String(service.name ?? "").toLowerCase();
    const metadata = {
      serviceName: service.name,
      product: service.product ?? null,
      transport: service.transport,
      source: "service",
    };

    if (port === 22 || port === 2222 || name.includes("ssh")) {
      addMethod({
        kind: "ssh",
        port,
        secure: true,
        summary: service.product ?? "Remote shell access",
        metadata,
      });
      if (isWindowsPlatformDevice(args.device)) {
        addMethod({
          kind: "powershell-ssh",
          port,
          secure: true,
          summary: service.product ?? "Windows PowerShell remoting over SSH",
          metadata,
        });
      }
      continue;
    }

    if (port === 5985 || port === 5986 || name.includes("winrm")) {
      addMethod({
        kind: "winrm",
        port,
        secure: port === 5986 || service.secure,
        summary: service.product ?? "Windows remote management",
        metadata,
      });
      continue;
    }

    if (port === 161 || name.includes("snmp")) {
      addMethod({
        kind: "snmp",
        port,
        secure: false,
        summary: service.product ?? "SNMP telemetry surface",
        metadata,
      });
      continue;
    }

    if (port === 1883 || port === 8883 || name.includes("mqtt")) {
      addMethod({
        kind: "mqtt",
        port,
        secure: port === 8883 || service.secure,
        summary: service.product ?? "Native MQTT telemetry or command bus",
        metadata,
      });
      continue;
    }

    if (port === 2375 || port === 2376 || name.includes("docker")) {
      addMethod({
        kind: "docker",
        port,
        secure: port === 2376 || service.secure,
        summary: service.product ?? "Docker daemon API",
        metadata,
      });
      continue;
    }

    if (port === 6443 || name.includes("kubernetes") || name.includes("k8s")) {
      addMethod({
        kind: "kubernetes",
        port,
        secure: true,
        summary: service.product ?? "Kubernetes control plane API",
        metadata,
      });
      continue;
    }

    if (PRINTING_PORTS.has(port) || name.includes("ipp") || name.includes("printer") || name.includes("lpd")) {
      addMethod({
        kind: "printing",
        port,
        secure: port === 631 && service.secure,
        summary: service.product ?? "Printer or queue surface",
        metadata,
      });
      continue;
    }

    if (port === 3389 || name.includes("rdp")) {
      addMethod({
        kind: "rdp",
        port,
        secure: true,
        summary: service.product ?? "Remote desktop exposure",
        metadata,
      });
      continue;
    }

    if (port === 5900 || port === 5901 || name.includes("vnc") || name.includes("rfb")) {
      addMethod({
        kind: "vnc",
        port,
        secure: false,
        summary: service.product ?? "VNC remote desktop exposure",
        metadata,
      });
      continue;
    }

    if (port === 445 || name.includes("smb") || name.includes("cifs") || name.includes("microsoft-ds")) {
      addMethod({
        kind: "smb",
        port,
        secure: false,
        summary: service.product ?? "SMB file and administrative share access",
        metadata,
      });
      continue;
    }

    if (port === 135 || name.includes("msrpc") || name.includes("wmi")) {
      addMethod({
        kind: "wmi",
        port,
        secure: false,
        summary: service.product ?? "WMI / RPC management surface",
        metadata,
      });
      continue;
    }

    if (HTTP_PORTS.has(port) || name.includes("http") || name.includes("https") || name.includes("web")) {
      addMethod({
        kind: "http-api",
        port,
        secure: service.secure || port === 443 || port === 8443 || port === 5001 || port === 9443,
        summary: service.product ?? "Web console or HTTP API",
        metadata,
      });
      addMethod({
        kind: "web-session",
        port,
        secure: service.secure || port === 443 || port === 8443 || port === 5001 || port === 9443,
        summary: service.product ?? "Managed browser-backed web session",
        metadata: {
          ...metadata,
          managementPath: "web-ui",
        },
      });
    }
  }

  const protocolFallbacks: Array<{ kind: AccessMethod["kind"] }> = [
    { kind: "ssh" },
    { kind: "winrm" },
    { kind: "powershell-ssh" },
    { kind: "wmi" },
    { kind: "smb" },
    { kind: "snmp" },
    { kind: "http-api" },
    { kind: "web-session" },
    { kind: "docker" },
    { kind: "kubernetes" },
    { kind: "mqtt" },
    { kind: "printing" },
    { kind: "rdp" },
    { kind: "vnc" },
  ];

  for (const fallback of protocolFallbacks) {
    if (!hasDeviceProtocol(args.device, fallback.kind) || hasMethodOfKind(methods, fallback.kind)) {
      continue;
    }
    addMethod({
      kind: fallback.kind,
      secure: secureFallbackForKind(fallback.kind),
      summary: "Observed protocol hint",
      metadata: { source: "protocol" },
    });
  }

  for (const credential of args.credentials) {
    for (const kind of credentialFallbackKinds(credential.protocol)) {
      if (hasMethodOfKind(methods, kind)) {
        continue;
      }
      addMethod({
        kind,
        secure: secureFallbackForKind(kind),
        summary: kind === "web-session"
          ? "Managed browser session available from stored HTTP credential"
          : "Stored credential available",
        metadata: {
          source: "credential",
          credentialId: credential.id,
          credentialStatus: credential.status,
          adapterId: credential.adapterId ?? null,
        },
      });
    }
  }

  const statusRank = (status: AccessMethod["status"]): number => {
    switch (status) {
      case "validated":
        return 0;
      case "credentialed":
        return 1;
      case "observed":
        return 2;
      case "rejected":
        return 3;
      default:
        return 9;
    }
  };

  return Array.from(methods.values()).sort((left, right) => {
    if (left.selected !== right.selected) {
      return left.selected ? -1 : 1;
    }
    if (left.status !== right.status) {
      return statusRank(left.status) - statusRank(right.status);
    }
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }
    return (left.port ?? 0) - (right.port ?? 0);
  });
}

export function summarizeDeviceIdentity(device: Device): string {
  const browserObservation = typeof device.metadata.browserObservation === "object" && device.metadata.browserObservation !== null
    ? device.metadata.browserObservation as Record<string, unknown>
    : {};
  const fingerprint = typeof device.metadata.fingerprint === "object" && device.metadata.fingerprint !== null
    ? device.metadata.fingerprint as Record<string, unknown>
    : {};
  const browserTitles = Array.isArray(browserObservation.endpoints)
    ? browserObservation.endpoints
      .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
      .map((value) => String(value.title ?? ""))
      .filter((value) => value.trim().length > 0)
    : [];

  return [
    device.name,
    device.hostname,
    device.vendor,
    device.os,
    device.role,
    String(fingerprint.inferredProduct ?? ""),
    ...browserTitles,
    ...device.services.map((service) => [service.name, service.product, service.version].filter(Boolean).join(" ")),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

