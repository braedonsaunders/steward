import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { executeBrokerOperation } from "@/lib/adapters/protocol-broker";
import { isAuthorized } from "@/lib/auth/guard";
import { normalizeCredentialProtocol } from "@/lib/protocols/catalog";
import { stateStore } from "@/lib/state/store";
import type { Device, OperationSpec, ProtocolBrokerRequest } from "@/lib/state/types";

export const runtime = "nodejs";

type TerminalTransport = "ssh" | "winrm" | "powershell-ssh";

const COMMAND_TIMEOUT_MS = 45_000;
const CWD_MARKER = "__STEWARD_CWD__";

const terminalCommandSchema = z.object({
  command: z.string().min(1).max(8_000),
  cwd: z.string().max(1_024).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
});

function nowIso(): string {
  return new Date().toISOString();
}

function escapeShellSingleQuoted(value: string): string {
  return value.replace(/'/g, `'\"'\"'`);
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function transportLabel(transport: TerminalTransport): string {
  if (transport === "ssh") return "SSH";
  if (transport === "winrm") return "WinRM";
  return "PowerShell over SSH";
}

function deviceLooksWindows(device: Device): boolean {
  const signatures = [device.os, device.type, device.role, device.name, device.hostname]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  return /windows|server\s+20\d{2}|domain\s+controller/i.test(signatures);
}

function observedPort(device: Device, protocols: string[], servicePorts: number[]): number | undefined {
  const accessMethod = stateStore.getAccessMethods(device.id).find((method) => {
    const kind = normalizeCredentialProtocol(method.kind);
    const protocol = normalizeCredentialProtocol(method.protocol);
    return protocols.includes(kind) || protocols.includes(protocol);
  });
  if (typeof accessMethod?.port === "number" && accessMethod.port > 0) {
    return accessMethod.port;
  }

  return device.services.find((service) =>
    service.transport === "tcp" && servicePorts.includes(service.port),
  )?.port;
}

function hasObservedProtocol(device: Device, protocols: string[], servicePorts: number[]): boolean {
  if (device.protocols.some((value) => protocols.includes(normalizeCredentialProtocol(value)))) {
    return true;
  }

  if (stateStore.getAccessMethods(device.id).some((method) => {
    const kind = normalizeCredentialProtocol(method.kind);
    const protocol = normalizeCredentialProtocol(method.protocol);
    return protocols.includes(kind) || protocols.includes(protocol);
  })) {
    return true;
  }

  return device.services.some((service) =>
    service.transport === "tcp" && servicePorts.includes(service.port),
  );
}

function hasStoredCredential(device: Device, protocols: string[]): boolean {
  return stateStore.getDeviceCredentials(device.id).some((credential) =>
    protocols.includes(normalizeCredentialProtocol(credential.protocol)),
  );
}

function selectTerminalTransport(device: Device): {
  available: boolean;
  transport?: TerminalTransport;
  transportLabel?: string;
  port?: number;
  reason: string;
} {
  const windows = deviceLooksWindows(device);
  const hasSshSurface = hasObservedProtocol(device, ["ssh"], [22, 2222]);
  const hasWinrmSurface = hasObservedProtocol(device, ["winrm"], [5985, 5986]);
  const hasSshCredential = hasStoredCredential(device, ["ssh", "powershell-ssh"]);
  const hasWinrmCredential = hasStoredCredential(device, ["winrm"]);

  if (windows) {
    if (hasWinrmSurface && hasWinrmCredential) {
      return {
        available: true,
        transport: "winrm",
        transportLabel: transportLabel("winrm"),
        port: observedPort(device, ["winrm"], [5985, 5986]),
        reason: "Using the stored WinRM credential for this Windows host.",
      };
    }
    if (hasSshSurface && hasSshCredential) {
      return {
        available: true,
        transport: "powershell-ssh",
        transportLabel: transportLabel("powershell-ssh"),
        port: observedPort(device, ["ssh"], [22, 2222]),
        reason: "Using PowerShell over the observed SSH surface for this Windows host.",
      };
    }
    if (hasWinrmSurface) {
      return {
        available: true,
        transport: "winrm",
        transportLabel: transportLabel("winrm"),
        port: observedPort(device, ["winrm"], [5985, 5986]),
        reason: "WinRM is the best observed terminal surface for this Windows host.",
      };
    }
    if (hasSshSurface) {
      return {
        available: true,
        transport: "powershell-ssh",
        transportLabel: transportLabel("powershell-ssh"),
        port: observedPort(device, ["ssh"], [22, 2222]),
        reason: "SSH is available, so Steward will use PowerShell over SSH for this Windows host.",
      };
    }
  } else {
    if (hasSshSurface) {
      return {
        available: true,
        transport: "ssh",
        transportLabel: transportLabel("ssh"),
        port: observedPort(device, ["ssh"], [22, 2222]),
        reason: "SSH is the best observed terminal surface for this device.",
      };
    }
    if (hasWinrmSurface) {
      return {
        available: true,
        transport: "winrm",
        transportLabel: transportLabel("winrm"),
        port: observedPort(device, ["winrm"], [5985, 5986]),
        reason: "WinRM is the only observed terminal surface available for this device.",
      };
    }
  }

  return {
    available: false,
    reason: "No SSH or WinRM management surface has been observed for this device yet.",
  };
}

function wrapCommandForTransport(transport: TerminalTransport, command: string, cwd?: string): string {
  const normalizedCwd = cwd?.trim();

  if (transport === "ssh") {
    const steps = [
      normalizedCwd && normalizedCwd.length > 0
        ? `cd '${escapeShellSingleQuoted(normalizedCwd)}' || exit $?`
        : null,
      command,
      `printf '\\n${CWD_MARKER}%s\\n' "$PWD"`,
    ].filter((value): value is string => Boolean(value));
    return steps.join(" ; ");
  }

  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    normalizedCwd && normalizedCwd.length > 0
      ? `Set-Location -LiteralPath '${escapePowerShellSingleQuoted(normalizedCwd)}'`
      : null,
    command,
    `Write-Output ('${CWD_MARKER}' + (Get-Location).Path)`,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function stripCwdMarker(output: string): { output: string; cwd?: string } {
  const normalized = output.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith(CWD_MARKER)) {
      continue;
    }
    const cwd = line.slice(CWD_MARKER.length).trim();
    lines.splice(index, 1);
    return {
      output: lines.join("\n").trim(),
      ...(cwd.length > 0 ? { cwd } : {}),
    };
  }

  return { output: normalized.trim() };
}

function buildTerminalBrokerRequest(
  transport: TerminalTransport,
  command: string,
  port?: number,
): ProtocolBrokerRequest {
  if (transport === "ssh") {
    return {
      protocol: "ssh",
      command,
      ...(typeof port === "number" ? { port } : {}),
    };
  }

  if (transport === "winrm") {
    return {
      protocol: "winrm",
      command,
      ...(typeof port === "number" ? { port } : {}),
    };
  }

  return {
    protocol: "powershell-ssh",
    command,
    ...(typeof port === "number" ? { port } : {}),
  };
}

function buildTerminalOperation(
  device: Device,
  transport: TerminalTransport,
  command: string,
  timeoutMs: number,
  port?: number,
): OperationSpec {
  return {
    id: `remote-terminal-${randomUUID()}`,
    adapterId: transport,
    kind: "shell.command",
    mode: "mutate",
    timeoutMs,
    brokerRequest: buildTerminalBrokerRequest(transport, command, port),
    expectedSemanticTarget: device.name,
    safety: {
      dryRunSupported: false,
      requiresConfirmedRevert: false,
      criticality: "medium",
    },
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const selection = selectTerminalTransport(device);
  return NextResponse.json(selection);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const parsed = terminalCommandSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const selection = selectTerminalTransport(device);
  if (!selection.available || !selection.transport) {
    return NextResponse.json(
      { error: selection.reason, available: false },
      { status: 409 },
    );
  }

  const startedAt = nowIso();
  const wrappedCommand = wrapCommandForTransport(
    selection.transport,
    parsed.data.command,
    parsed.data.cwd,
  );
  const operation = buildTerminalOperation(
    device,
    selection.transport,
    wrappedCommand,
    parsed.data.timeoutMs ?? COMMAND_TIMEOUT_MS,
    selection.port,
  );

  const result = await executeBrokerOperation(
    operation,
    device,
    {
      host: device.ip,
      ip: device.ip,
      device_id: device.id,
      deviceId: device.id,
      name: device.name,
    },
    {
      actor: "user",
      allowProvidedCredentials: true,
    },
  );
  const completedAt = nowIso();
  const normalized = stripCwdMarker(result.output);

  await stateStore.addAction({
    actor: "user",
    kind: "diagnose",
    message: `Remote terminal command ${result.ok ? "completed" : "failed"} on ${device.name} via ${selection.transportLabel ?? transportLabel(selection.transport)}`,
    context: {
      deviceId: device.id,
      transport: selection.transport,
      ok: result.ok,
      status: result.status,
      summary: result.summary,
      cwd: normalized.cwd ?? parsed.data.cwd ?? null,
    },
  });

  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    summary: result.summary,
    output: normalized.output,
    cwd: normalized.cwd ?? parsed.data.cwd,
    transport: selection.transport,
    transportLabel: selection.transportLabel ?? transportLabel(selection.transport),
    startedAt,
    completedAt,
  });
}
