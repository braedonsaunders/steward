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

function isIpLiteral(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) {
    return true;
  }
  return trimmed.includes(":");
}

export function isWinrmIpLiteral(value: string): boolean {
  return isIpLiteral(value);
}

function isSyntheticDiscoveryName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^unknown-\d{1,3}(?:-\d{1,3}){3}$/.test(normalized)
    || /^windows-\d{1,3}(?:-\d{1,3}){3}$/.test(normalized)
    || /^linux-\d{1,3}(?:-\d{1,3}){3}$/.test(normalized)
    || /^iot-\d{1,3}(?:-\d{1,3}){3}$/.test(normalized);
}

function isValidWinrmHostnameCandidate(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (isIpLiteral(trimmed)) {
    return true;
  }
  if (/\s/.test(trimmed)) {
    return false;
  }
  return /^[a-z0-9.-]+$/i.test(trimmed)
    && !trimmed.startsWith(".")
    && !trimmed.endsWith(".")
    && !trimmed.includes("..");
}

export function sanitizeWinrmHostCandidate(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!isValidWinrmHostnameCandidate(trimmed) || isSyntheticDiscoveryName(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function preferredWinrmHost(device: Device): string {
  const hostname = sanitizeWinrmHostCandidate(device.hostname) ?? "";
  const name = sanitizeWinrmHostCandidate(device.name) ?? "";

  const candidates = [hostname, name]
    .filter((value) => value.length > 0)
    .filter((value) => !isIpLiteral(value));

  const fqdn = candidates.find((value) => value.includes("."));
  return fqdn ?? candidates[0] ?? sanitizeWinrmHostCandidate(device.ip) ?? device.ip;
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
    return "Install PowerShell 7 (`pwsh`) on the Steward node if you need WinRM. Prefer Windows OpenSSH when available; macOS WinRM requires HTTPS with Basic authentication.";
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
  const shouldSeedTrustedHost = connection.hostPlatform === "win32"
    && !connection.useSsl
    && isIpLiteral(input.host);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$secure = ConvertTo-SecureString '${escapePowerShellSingleQuoted(input.password)}' -AsPlainText -Force`,
    `$credential = [System.Management.Automation.PSCredential]::new('${escapePowerShellSingleQuoted(input.username)}', $secure)`,
    `$invokeParams = @{ ComputerName = '${escapePowerShellSingleQuoted(input.host)}'; Credential = $credential; Authentication = '${toPowerShellAuthenticationValue(connection.authentication)}' }`,
    connection.port ? `$invokeParams.Port = ${connection.port}` : "",
    connection.useSsl ? "$invokeParams.UseSSL = $true" : "",
    "$sessionOptionArgs = @{ NoMachineProfile = $true; OpenTimeout = 15000; OperationTimeout = 180000; IdleTimeout = 240000 }",
    connection.skipCertChecks
      ? "$sessionOptionArgs.SkipCACheck = $true; $sessionOptionArgs.SkipCNCheck = $true; $sessionOptionArgs.SkipRevocationCheck = $true"
      : "",
    "$invokeParams.SessionOption = New-PSSessionOption @sessionOptionArgs",
    shouldSeedTrustedHost
      ? "$trustedHostsPath = 'WSMan:\\localhost\\Client\\TrustedHosts'"
      : "",
    shouldSeedTrustedHost
      ? `$targetHostLiteral = '${escapePowerShellSingleQuoted(input.host)}'`
      : "",
    shouldSeedTrustedHost
      ? "$trustedHostsCurrent = ''"
      : "",
    shouldSeedTrustedHost
      ? "try { $trustedHostsCurrent = (Get-Item -Path $trustedHostsPath -ErrorAction Stop).Value } catch { $trustedHostsCurrent = '' }"
      : "",
    shouldSeedTrustedHost
      ? "$trustedHostList = @()"
      : "",
    shouldSeedTrustedHost
      ? "if ($trustedHostsCurrent) { $trustedHostList = $trustedHostsCurrent -split '\\s*,\\s*' | Where-Object { $_ -and $_.Trim().Length -gt 0 } }"
      : "",
    shouldSeedTrustedHost
      ? "if ($trustedHostList -notcontains '*' -and $trustedHostList -notcontains $targetHostLiteral) {"
      : "",
    shouldSeedTrustedHost
      ? "  $trustedHostsNext = if ($trustedHostsCurrent) { \"$trustedHostsCurrent,$targetHostLiteral\" } else { $targetHostLiteral }"
      : "",
    shouldSeedTrustedHost
      ? "  try { Set-Item -Path $trustedHostsPath -Value $trustedHostsNext -Force -ErrorAction Stop | Out-Null } catch {"
      : "",
    shouldSeedTrustedHost
      ? "    $trustedHostsError = $_.Exception.Message"
      : "",
    shouldSeedTrustedHost
      ? "    throw \"Unable to add $targetHostLiteral to WSMan TrustedHosts on the Steward host. Run this process elevated or use HTTPS WinRM (5986). Details: $trustedHostsError\""
      : "",
    shouldSeedTrustedHost
      ? "}"
      : "",
    shouldSeedTrustedHost
      ? "}"
      : "",
    "$resolvedAddresses = @()",
    "try { $resolvedAddresses = [System.Net.Dns]::GetHostAddresses($invokeParams.ComputerName) | ForEach-Object { $_.IPAddressToString } } catch { $resolvedAddresses = @() }",
    "if ($resolvedAddresses.Count -gt 0) { Write-Output ('[preflight] dns-resolve=ok host=' + $invokeParams.ComputerName + ' addresses=' + ($resolvedAddresses -join ',')) } else { Write-Output ('[preflight] dns-resolve=unresolved host=' + $invokeParams.ComputerName) }",
    "$wsmanScheme = if ($invokeParams.ContainsKey('UseSSL') -and $invokeParams.UseSSL) { 'https' } else { 'http' }",
    "$wsmanUri = $wsmanScheme + '://' + $invokeParams.ComputerName + ':' + $invokeParams.Port + '/wsman'",
    "Write-Output ('[preflight] wsman-url=' + $wsmanUri + ' auth=' + $invokeParams.Authentication)",
    "$testWsmanParams = @{ ComputerName = $invokeParams.ComputerName; Credential = $credential; Authentication = $invokeParams.Authentication; Port = $invokeParams.Port; ErrorAction = 'Stop' }",
    "if ($invokeParams.ContainsKey('UseSSL') -and $invokeParams.UseSSL) { $testWsmanParams.UseSSL = $true }",
    "try { Test-WSMan @testWsmanParams | Out-Null; Write-Output '[preflight] test-wsman=ok' } catch { throw ('[stage=test_wsman] ' + $_.Exception.Message) }",
    "$scriptText = @'",
    input.command,
    "'@",
    "$scriptBlock = [ScriptBlock]::Create($scriptText)",
    "$session = $null",
    "try { $session = New-PSSession @invokeParams -ErrorAction Stop; Write-Output '[preflight] new-pssession=ok' } catch { throw ('[stage=session_create] ' + $_.Exception.Message) }",
    "try { Invoke-Command -Session $session -ScriptBlock $scriptBlock -ErrorAction Stop } catch { throw ('[stage=invoke_command] ' + $_.Exception.Message) } finally { if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue } }",
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

function decodeClixmlEncodedBreaks(value: string): string {
  return value.replace(/_x000D__x000A_/gi, "\n").replace(/_x000A_/gi, "\n").replace(/_x000D_/gi, "");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function normalizeWinrmOutput(raw: string): string {
  if (!raw) return "";
  const prepared = decodeClixmlEncodedBreaks(raw);

  if (!prepared.includes("<Objs") || !prepared.includes('xmlns="http://schemas.microsoft.com/powershell/2004/04"')) {
    return prepared;
  }

  const matches = Array.from(prepared.matchAll(/<S\s+S="Error">([\s\S]*?)<\/S>/gi));
  if (matches.length === 0) {
    return prepared;
  }

  const cleaned = matches
    .map((match) => decodeXmlEntities(match[1] ?? "").replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  return cleaned || prepared;
}

export interface WinrmFailureAnalysis {
  categories: string[];
  hints: string[];
  stage?: string;
}

export function analyzeWinrmFailure(output: string): WinrmFailureAnalysis {
  const categories = new Set<string>();
  const hints: string[] = [];
  const normalized = output.toLowerCase();
  const stageMatch = output.match(/\[stage=([^\]]+)\]/i);
  const stage = stageMatch?.[1]?.trim().toLowerCase();
  if (stage) {
    categories.add(`stage_${stage}`);
  }

  if (normalized.includes("cannotuseipaddress") || normalized.includes("default authentication may be used with an ip address")) {
    categories.add("cannot_use_ip_address");
    hints.push("IP-based WinRM over HTTP requires TrustedHosts or HTTPS (5986). Prefer hostname/FQDN when possible.");
  }

  if (normalized.includes("winrmoperationtimeout") || normalized.includes("winrm cannot complete the operation")) {
    categories.add("operation_timeout_or_firewall");
    hints.push("The WSMan listener responded, but the remote PowerShell session did not start successfully. Check firewall scope, authentication negotiation, WinRM policy, and remote shell startup health.");
  }

  if (normalized.includes("access is denied")) {
    categories.add("access_denied");
    hints.push("Credentials were accepted for transport but rejected for remote execution. Verify account rights for WinRM remote management.");
  }

  if (
    normalized.includes("kerberos")
    && (
      normalized.includes("0x80090322")
      || normalized.includes("the winrm client cannot process the request")
      || normalized.includes("cannot find the computer")
      || normalized.includes("unknown security error")
      || normalized.includes("a specified logon session does not exist")
      || normalized.includes("the kerberos client received")
      || normalized.includes("kerberos authentication failed")
    )
  ) {
    categories.add("kerberos_negotiation");
    hints.push("Kerberos negotiation failed. Confirm DNS/SPN alignment and that Steward can resolve the host FQDN.");
  }

  if (normalized.includes("dns-resolve=unresolved")) {
    categories.add("dns_resolution");
    hints.push("Steward could not resolve the target hostname locally. Verify DNS resolution for the FQDN from the Steward host.");
  }

  if (stage === "test_wsman") {
    hints.push("WSMan preflight failed before session creation. Focus on endpoint reachability, auth negotiation, and WinRM policy before shell startup.");
  }

  if (stage === "session_create") {
    hints.push("WSMan preflight succeeded, but New-PSSession failed. Focus on WinRM authorization, remoting configuration, and shell startup policy.");
  }

  if (stage === "invoke_command") {
    hints.push("Remote session was created, but command execution failed inside the session. Check PowerShell remoting rights and target-side execution policy or module availability.");
  }

  if (normalized.includes("pssessionstatebroken")) {
    categories.add("session_state_broken");
    hints.push("The remote session failed during creation. Check WinRM service health, group policy, and whether the target can start a PowerShell remoting session interactively.");
  }

  return {
    categories: Array.from(categories),
    hints,
    stage,
  };
}
