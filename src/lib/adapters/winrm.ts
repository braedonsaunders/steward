import { runCommand } from "@/lib/utils/shell";
import type { Device, WinrmAuthentication, WinrmBrokerRequest } from "@/lib/state/types";

const POWERSHELL_VERSION_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$PSVersionTable.PSVersion.ToString()",
];

const POWERSHELL_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> & { default: string[] } = {
  win32: ["powershell", "pwsh"],
  darwin: ["pwsh", "/opt/homebrew/bin/pwsh", "/usr/local/bin/pwsh", "powershell"],
  aix: ["pwsh", "/usr/bin/pwsh", "/usr/local/bin/pwsh", "powershell"],
  android: ["pwsh", "/usr/bin/pwsh", "/usr/local/bin/pwsh", "powershell"],
  freebsd: ["pwsh", "/usr/bin/pwsh", "/usr/local/bin/pwsh", "powershell"],
  linux: ["pwsh", "/usr/bin/pwsh", "/usr/local/bin/pwsh", "powershell"],
  openbsd: ["pwsh", "/usr/bin/pwsh", "/usr/local/bin/pwsh", "powershell"],
  sunos: ["pwsh", "/usr/bin/pwsh", "/usr/local/bin/pwsh", "powershell"],
  default: ["pwsh", "/usr/bin/pwsh", "/usr/local/bin/pwsh", "powershell"],
};

export interface PowerShellRuntimeResolution {
  available: boolean;
  executable?: string;
  version?: string;
  tried: string[];
  error?: string;
}

export interface ResolvedWinrmConnection {
  port: number;
  useSsl: boolean;
  skipCertChecks: boolean;
  authentication: WinrmAuthentication;
  hostPlatform: NodeJS.Platform;
}

let cachedRuntimePromise: Promise<PowerShellRuntimeResolution> | null = null;

function candidateList(platform: NodeJS.Platform): string[] {
  return Array.from(
    new Set([
      ...(POWERSHELL_CANDIDATES[platform] ?? []),
      ...POWERSHELL_CANDIDATES.default,
    ]),
  );
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeAuthentication(value: string | undefined): WinrmAuthentication | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized as WinrmAuthentication : undefined;
}

function toPowerShellAuthenticationValue(value: WinrmAuthentication): string {
  switch (normalizeAuthentication(String(value))) {
    case "basic":
      return "Basic";
    case "negotiate":
      return "Negotiate";
    case "kerberos":
      return "Kerberos";
    case "credssp":
      return "Credssp";
    case "digest":
      return "Digest";
    default:
      return "Default";
  }
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function unwrapPowerShellCommand(template: string): string {
  const trimmed = template.trim();
  const commandIndex = trimmed.search(/\s-Command\s+/i);
  if (commandIndex === -1) {
    return trimmed;
  }

  const afterFlag = trimmed.slice(commandIndex).replace(/^\s-Command\s+/i, "").trim();
  return stripMatchingQuotes(afterFlag);
}

function explicitUseSsl(request: Pick<WinrmBrokerRequest, "port" | "useSsl">): boolean | undefined {
  if (typeof request.useSsl === "boolean") {
    return request.useSsl;
  }
  if (request.port === 5986) return true;
  if (request.port === 5985) return false;
  return undefined;
}

function observedUseSslPreference(device: Device | undefined): boolean | undefined {
  if (!device) return undefined;
  const hasSecure = device.services.some((service) => service.transport === "tcp" && service.port === 5986);
  const hasPlain = device.services.some((service) => service.transport === "tcp" && service.port === 5985);
  if (hasSecure && !hasPlain) return true;
  if (hasPlain && !hasSecure) return false;
  return undefined;
}

function observedWinrmPort(device: Device | undefined, secure: boolean): number | undefined {
  if (!device) {
    return secure ? 5986 : 5985;
  }

  const ports = device.services
    .filter((service) => service.transport === "tcp" && (service.port === 5985 || service.port === 5986))
    .map((service) => service.port);

  if (secure && ports.includes(5986)) return 5986;
  if (!secure && ports.includes(5985)) return 5985;
  if (ports.includes(5986)) return 5986;
  if (ports.includes(5985)) return 5985;
  return secure ? 5986 : 5985;
}

export async function resolvePowerShellRuntime(forceRefresh = false): Promise<PowerShellRuntimeResolution> {
  if (!forceRefresh && cachedRuntimePromise) {
    return cachedRuntimePromise;
  }

  cachedRuntimePromise = (async () => {
    const tried: string[] = [];
    let lastError = "";
    for (const candidate of candidateList(process.platform)) {
      tried.push(candidate);
      const result = await runCommand(candidate, POWERSHELL_VERSION_ARGS, 8_000);
      if (result.ok) {
        return {
          available: true,
          executable: candidate,
          version: result.stdout.trim() || undefined,
          tried,
        };
      }
      lastError = result.stderr || result.stdout || `${candidate} exited with code ${result.code}`;
    }

    const resolution: PowerShellRuntimeResolution = {
      available: false,
      tried,
      error: lastError || "PowerShell runtime not found",
    };
    cachedRuntimePromise = null;
    return resolution;
  })();

  return cachedRuntimePromise;
}

export function powerShellInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return "Install PowerShell 7 (`pwsh`) on the Steward node. macOS WinRM requires HTTPS with Basic authentication.";
  }
  if (platform === "win32") {
    return "Install Windows PowerShell or PowerShell 7 on the Steward node.";
  }
  return "Install PowerShell 7 (`pwsh`) on the Steward node to manage Windows endpoints over WinRM.";
}

export function resolveWinrmConnection(
  device: Device | undefined,
  request: Pick<WinrmBrokerRequest, "port" | "useSsl" | "skipCertChecks" | "authentication">,
  platform: NodeJS.Platform = process.platform,
): { ok: true; value: ResolvedWinrmConnection } | { ok: false; error: string; details: Record<string, unknown> } {
  const requestedAuth = normalizeAuthentication(request.authentication);
  const requestedUseSsl = explicitUseSsl(request) ?? observedUseSslPreference(device);

  let authentication: WinrmAuthentication;
  let useSsl: boolean;

  if (platform === "darwin") {
    authentication = requestedAuth ?? "basic";
    useSsl = requestedUseSsl ?? true;
    if (normalizeAuthentication(authentication) !== "basic") {
      return {
        ok: false,
        error: "macOS WinRM requires Basic authentication.",
        details: {
          hostPlatform: platform,
          authentication,
          installHint: powerShellInstallHint(platform),
        },
      };
    }
    if (!useSsl) {
      return {
        ok: false,
        error: "macOS WinRM requires HTTPS (port 5986) for remote sessions.",
        details: {
          hostPlatform: platform,
          authentication,
          installHint: powerShellInstallHint(platform),
        },
      };
    }
  } else if (platform === "win32") {
    authentication = requestedAuth ?? "default";
    useSsl = requestedUseSsl ?? false;
  } else {
    authentication = requestedAuth ?? "negotiate";
    useSsl = requestedUseSsl ?? false;
    if (normalizeAuthentication(authentication) === "basic" && !useSsl) {
      return {
        ok: false,
        error: "Basic WinRM authentication requires HTTPS (port 5986).",
        details: {
          hostPlatform: platform,
          authentication,
          installHint: powerShellInstallHint(platform),
        },
      };
    }
  }

  const port = request.port ?? observedWinrmPort(device, useSsl) ?? (useSsl ? 5986 : 5985);
  return {
    ok: true,
    value: {
      port,
      useSsl: port === 5986 ? true : useSsl,
      skipCertChecks: request.skipCertChecks === true,
      authentication,
      hostPlatform: platform,
    },
  };
}

export function buildWinrmPowerShellScript(input: {
  host: string;
  username: string;
  password: string;
  command: string;
  connection: ResolvedWinrmConnection;
}): string {
  const { connection } = input;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$secure = ConvertTo-SecureString '${escapePowerShellSingleQuoted(input.password)}' -AsPlainText -Force`,
    `$credential = [System.Management.Automation.PSCredential]::new('${escapePowerShellSingleQuoted(input.username)}', $secure)`,
    `$invokeParams = @{ ComputerName = '${escapePowerShellSingleQuoted(input.host)}'; Credential = $credential; Authentication = '${toPowerShellAuthenticationValue(connection.authentication)}' }`,
    connection.port ? `$invokeParams.Port = ${connection.port}` : "",
    connection.useSsl ? "$invokeParams.UseSSL = $true" : "",
    connection.skipCertChecks
      ? "$invokeParams.SessionOption = New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck"
      : "",
    "$scriptText = @'",
    input.command,
    "'@",
    "$scriptBlock = [ScriptBlock]::Create($scriptText)",
    "Invoke-Command @invokeParams -ScriptBlock $scriptBlock",
  ].filter((line) => line.length > 0).join("\n");
}

export function parseWinrmCommandTemplate(template: string): WinrmBrokerRequest | null {
  const unwrapped = unwrapPowerShellCommand(template);
  if (!/^Invoke-Command\b/i.test(unwrapped)) {
    return null;
  }
  if (!/-ComputerName\s+(?:\{\{host\}\}|["'][^"']+["']|[^\s]+)/i.test(unwrapped)) {
    return null;
  }

  const scriptBlockMatch = unwrapped.match(/-ScriptBlock\s+\{([\s\S]*)\}\s*$/i);
  if (!scriptBlockMatch?.[1]) {
    return null;
  }

  const portMatch = unwrapped.match(/-Port\s+(\d{2,5})\b/i);
  const authMatch = unwrapped.match(/-Authentication\s+([A-Za-z][A-Za-z0-9-]*)\b/i);

  return {
    protocol: "winrm",
    command: scriptBlockMatch[1].trim(),
    ...(portMatch ? { port: Number(portMatch[1]) } : {}),
    ...(/-UseSSL\b/i.test(unwrapped) ? { useSsl: true } : {}),
    ...(authMatch ? { authentication: normalizeAuthentication(authMatch[1]) } : {}),
  };
}
