import type { AccessMethod, Device, DeviceCredential } from "@/lib/state/types";

const HTTP_PORTS = new Set([80, 443, 8080, 8443, 5000, 5001, 7443, 9000, 9443]);
const PRINTING_PORTS = new Set([515, 631, 9100]);

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeProtocol(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "http" || normalized === "https") return "http-api";
  if (normalized === "mqtts") return "mqtt";
  if (normalized === "ipp" || normalized === "printer" || normalized === "lpd") return "printing";
  if (normalized === "windows") return "winrm";
  return normalized;
}

function inferCredentialProtocol(kind: string): string | undefined {
  switch (kind) {
    case "ssh":
    case "winrm":
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
  const label = (() => {
    switch (kind) {
      case "ssh":
        return "SSH";
      case "winrm":
        return "WinRM";
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
      case "printing":
        return "Printing";
      case "rdp":
        return "Remote Desktop";
      default:
        return kind.toUpperCase();
    }
  })();
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

  const matching = credentials.filter((credential) => normalizeProtocol(credential.protocol) === protocol);
  if (matching.some((credential) => credential.status === "validated")) {
    return "validated";
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
  const normalized = normalizeProtocol(protocol);
  return device.protocols.some((candidate) => normalizeProtocol(candidate) === normalized);
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

    if (HTTP_PORTS.has(port) || name.includes("http") || name.includes("https") || name.includes("web")) {
      addMethod({
        kind: "http-api",
        port,
        secure: service.secure || port === 443 || port === 8443 || port === 5001 || port === 9443,
        summary: service.product ?? "Web console or HTTP API",
        metadata,
      });
    }
  }

  const protocolFallbacks: Array<{ kind: AccessMethod["kind"]; secure?: boolean }> = [
    { kind: "ssh", secure: true },
    { kind: "winrm", secure: false },
    { kind: "snmp", secure: false },
    { kind: "http-api", secure: true },
    { kind: "docker", secure: false },
    { kind: "kubernetes", secure: true },
    { kind: "mqtt", secure: true },
    { kind: "printing", secure: false },
    { kind: "rdp", secure: true },
  ];

  for (const fallback of protocolFallbacks) {
    if (!hasDeviceProtocol(args.device, fallback.kind)) {
      continue;
    }
    const key = accessMethodKey(fallback.kind);
    if (methods.has(key)) {
      continue;
    }
    addMethod({
      kind: fallback.kind,
      secure: fallback.secure,
      summary: "Observed protocol hint",
      metadata: { source: "protocol" },
    });
  }

  return Array.from(methods.values()).sort((left, right) => {
    if (left.selected !== right.selected) {
      return left.selected ? -1 : 1;
    }
    if (left.status !== right.status) {
      return left.status.localeCompare(right.status);
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
