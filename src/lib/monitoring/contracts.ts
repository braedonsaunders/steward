import { generateText } from "ai";
import { executeBrokerOperation } from "@/lib/adapters/protocol-broker";
import { parseWinrmCommandTemplate } from "@/lib/adapters/winrm";
import { randomUUID } from "node:crypto";
import { getDefaultProvider } from "@/lib/llm/config";
import { llmHealthController } from "@/lib/llm/health";
import { buildLanguageModel } from "@/lib/llm/providers";
import { applyPromptFirewall } from "@/lib/llm/prompt-firewall";
import { runShell } from "@/lib/utils/shell";
import type { Device, OperationSpec, ProtocolBrokerRequest, ServiceContract } from "@/lib/state/types";

export type MonitorType =
  | "service_presence"
  | "port_open"
  | "http_contains"
  | "shell_assertion"
  | "desktop_ui_assertion"
  | "semantic_assertion";

export interface MonitorContractDraft {
  contract: ServiceContract;
  monitorType: MonitorType;
  requiredProtocols: string[];
  notes: string[];
}

export interface ServiceContractEvaluation {
  status: "pass" | "fail" | "pending";
  summary: string;
  evidenceJson: Record<string, unknown>;
  updatedPolicyJson: Record<string, unknown>;
  monitorType: MonitorType;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeProtocol(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).map((item) => normalizeProtocol(item)).filter((item) => item.length > 0);
}

function clampIntervalSec(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 300;
  }
  return Math.max(15, Math.min(24 * 60 * 60, Math.floor(value)));
}

function parseIntervalSecFromPrompt(prompt: string): number {
  const match = prompt.match(/every\s+(\d+)\s*(second|sec|seconds|minute|min|minutes|hour|hr|hours|day|days)/i);
  if (!match) {
    return 300;
  }
  const count = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(count) || count <= 0) {
    return 300;
  }
  if (unit.startsWith("sec")) {
    return clampIntervalSec(count);
  }
  if (unit.startsWith("min")) {
    return clampIntervalSec(count * 60);
  }
  if (unit.startsWith("hour") || unit.startsWith("hr")) {
    return clampIntervalSec(count * 60 * 60);
  }
  return clampIntervalSec(count * 24 * 60 * 60);
}

function inferCriticality(prompt: string): ServiceContract["criticality"] {
  if (/\b(critical|urgent|security|outage|production|prod)\b/i.test(prompt)) {
    return "high";
  }
  if (/\b(low|best effort|optional)\b/i.test(prompt)) {
    return "low";
  }
  return "medium";
}

function inferMonitorType(prompt: string): MonitorType {
  if (/\b(semantic|llm|looks right|behaves correctly|works correctly|content is correct|dashboard is correct)\b/i.test(prompt)) {
    return "semantic_assertion";
  }
  if (/\b(ui|gui|desktop|screen|window|rdp|vnc|login page)\b/i.test(prompt)) {
    return "desktop_ui_assertion";
  }
  if (/\bport\s+\d{2,5}\b/i.test(prompt)) {
    return "port_open";
  }
  if (/\b(http|https|url|web|page|endpoint)\b/i.test(prompt)) {
    return "http_contains";
  }
  if (/\b(process|service|daemon|systemd|running)\b/i.test(prompt)) {
    return "shell_assertion";
  }
  return "shell_assertion";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);
}

function extractCodeBlock(prompt: string): string | undefined {
  const block = prompt.match(/```(?:bash|sh|powershell|pwsh|cmd)?\s*([\s\S]+?)```/i);
  if (block && block[1]) {
    return block[1].trim();
  }
  const inline = prompt.match(/`([^`]+)`/);
  if (inline && inline[1]) {
    return inline[1].trim();
  }
  const prefixed = prompt.match(/command\s*:\s*(.+)$/im);
  if (prefixed && prefixed[1]) {
    return prefixed[1].trim();
  }
  return undefined;
}

function extractServiceToken(prompt: string): string | undefined {
  const explicit = prompt.match(/\b(?:service|process|daemon)\s+([a-zA-Z0-9._-]+)/i);
  if (explicit && explicit[1]) {
    return explicit[1].toLowerCase();
  }

  const install = prompt.match(/\b(?:install|setup|set up|configure|deploy)\s+([a-zA-Z0-9._-]+)/i);
  if (install && install[1]) {
    return install[1].toLowerCase();
  }

  return undefined;
}

function extractUrl(prompt: string): string | undefined {
  const match = prompt.match(/\bhttps?:\/\/[^\s)]+/i);
  return match ? match[0] : undefined;
}

function extractExpectedText(prompt: string): string | undefined {
  const quoted = prompt.match(/\b(?:contains|show|shows|expect|expects)\s+["']([^"']+)["']/i);
  if (quoted && quoted[1]) {
    return quoted[1].trim();
  }
  return undefined;
}

function inferRequiredProtocols(
  monitorType: MonitorType,
  device: Device,
  explicit: string[],
): string[] {
  if (explicit.length > 0) {
    return explicit;
  }

  const present = new Set(device.protocols.map((item) => normalizeProtocol(item)));
  if (monitorType === "port_open" || monitorType === "service_presence") {
    return [];
  }
  if (monitorType === "http_contains") {
    if (present.has("http-api")) return ["http-api"];
    return ["http-api"];
  }
  if (monitorType === "semantic_assertion") {
    if (present.has("http-api")) return ["http-api"];
    if (present.has("ssh")) return ["ssh"];
    if (present.has("winrm")) return ["winrm"];
    return ["http-api"];
  }
  if (monitorType === "desktop_ui_assertion") {
    const requirements: string[] = [];
    if (present.has("winrm")) requirements.push("winrm");
    if (present.has("powershell-ssh")) requirements.push("powershell-ssh");
    if (present.has("wmi")) requirements.push("wmi");
    if (present.has("ssh")) requirements.push("ssh");
    if (present.has("rdp")) requirements.push("rdp");
    if (present.has("vnc")) requirements.push("vnc");
    if (requirements.length === 0) requirements.push("rdp");
    return requirements;
  }

  if (present.has("ssh")) return ["ssh"];
  if (present.has("winrm")) return ["winrm"];
  if (present.has("powershell-ssh")) return ["powershell-ssh"];
  if (present.has("wmi")) return ["wmi"];
  if (present.has("docker")) return ["docker"];
  return ["ssh"];
}

function buildServiceCommandTemplate(protocol: string, serviceName: string): string | undefined {
  if (protocol === "ssh") {
    return `ssh {{host}} 'systemctl is-active ${serviceName}'`;
  }
  if (protocol === "winrm") {
    return `pwsh -NoLogo -NonInteractive -Command "Invoke-Command -ComputerName {{host}} -ScriptBlock { (Get-Service -Name '${serviceName}').Status }"`;
  }
  if (protocol === "powershell-ssh") {
    return `ssh {{host}} "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"(Get-Service -Name '${serviceName}').Status\""`;
  }
  if (protocol === "wmi") {
    return `pwsh -NoLogo -NonInteractive -Command "$session=New-CimSession -ComputerName {{host}}; try { (Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter \"Name='${serviceName}'\").State } finally { if ($session) { Remove-CimSession $session } }"`;
  }
  if (protocol === "docker") {
    return `docker -H tcp://{{host}} ps --filter name=${serviceName}`;
  }
  return undefined;
}

function buildServiceBrokerRequest(protocol: string, serviceName: string): ProtocolBrokerRequest | undefined {
  if (protocol === "winrm") {
    return {
      protocol: "winrm",
      command: `(Get-Service -Name '${serviceName}').Status`,
    };
  }
  if (protocol === "powershell-ssh") {
    return {
      protocol: "powershell-ssh",
      command: `(Get-Service -Name '${serviceName}').Status`,
    };
  }
  if (protocol === "wmi") {
    return {
      protocol: "wmi",
      command: `(Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter \"Name='${serviceName}'\").State`,
    };
  }
  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function adapterIdForBroker(protocol: ProtocolBrokerRequest["protocol"]): string {
  switch (protocol) {
    case "ssh":
      return "ssh";
    case "winrm":
      return "winrm";
    case "powershell-ssh":
      return "powershell-ssh";
    case "wmi":
      return "wmi";
    case "smb":
      return "smb";
    case "rdp":
      return "rdp";
    case "http":
    case "websocket":
      return "http-api";
    case "mqtt":
      return "mqtt";
    default:
      return "ssh";
  }
}

function brokerRequestFromPolicy(policy: Record<string, unknown>, commandTemplate: string): ProtocolBrokerRequest | undefined {
  if (isRecord(policy.brokerRequest) && typeof policy.brokerRequest.protocol === "string") {
    return policy.brokerRequest as unknown as ProtocolBrokerRequest;
  }
  return parseWinrmCommandTemplate(commandTemplate) ?? undefined;
}

export function buildCustomMonitorContractFromPrompt(
  device: Device,
  prompt: string,
): MonitorContractDraft {
  const createdAt = nowIso();
  const cleanedPrompt = prompt.trim();
  const monitorType = inferMonitorType(cleanedPrompt);
  const explicitProtocols = toStringArray(
    (cleanedPrompt.match(/\b(?:using|via)\s+(ssh|winrm|powershell-ssh|wmi|smb|docker|http-api|snmp|mqtt|rdp|vnc)\b/ig) ?? [])
      .map((token) => token.replace(/\b(using|via)\s+/i, "")),
  );
  let requiredProtocols = inferRequiredProtocols(monitorType, device, explicitProtocols);
  const serviceToken = extractServiceToken(cleanedPrompt);
  const intervalSec = parseIntervalSecFromPrompt(cleanedPrompt);
  const notes: string[] = [];

  const basePolicy: Record<string, unknown> = {
    source: "chat_monitor",
    monitorType,
    instruction: cleanedPrompt,
    requiredProtocols,
  };

  if (monitorType === "port_open") {
    const portMatch = cleanedPrompt.match(/\bport\s+(\d{2,5})\b/i);
    if (portMatch) {
      basePolicy.port = Number(portMatch[1]);
    } else {
      notes.push("Could not parse a target port from the request.");
    }
  }

  if (monitorType === "http_contains") {
    const url = extractUrl(cleanedPrompt) ?? `http://${device.ip}/`;
    basePolicy.url = url;
    const expectedText = extractExpectedText(cleanedPrompt);
    if (expectedText) {
      basePolicy.expectedText = expectedText;
    } else {
      notes.push("No explicit expected response text provided; monitor will only check endpoint reachability.");
    }
  }

  if (monitorType === "shell_assertion") {
    const explicitCommand = extractCodeBlock(cleanedPrompt);
    if (explicitCommand) {
      basePolicy.commandTemplate = explicitCommand;
    } else if (serviceToken) {
      const preferredProtocol = requiredProtocols[0] ?? "ssh";
      const generatedTemplate = buildServiceCommandTemplate(preferredProtocol, serviceToken);
      const generatedBrokerRequest = buildServiceBrokerRequest(preferredProtocol, serviceToken);
      if (generatedTemplate) {
        basePolicy.commandTemplate = generatedTemplate;
        if (generatedBrokerRequest) {
          basePolicy.brokerRequest = generatedBrokerRequest;
          if (typeof basePolicy.expectedText !== "string" || basePolicy.expectedText.trim().length === 0) {
            basePolicy.expectedText = "Running";
          }
        }
      } else {
        notes.push("No executable command template could be generated for this monitor.");
      }
    } else {
      notes.push("Provide a command (for example with backticks) so Steward can evaluate this monitor.");
    }
  }

  if (monitorType === "semantic_assertion") {
    basePolicy.semanticPrompt = cleanedPrompt;
    const explicitCommand = extractCodeBlock(cleanedPrompt);
    const explicitUrl = extractUrl(cleanedPrompt);
    if (explicitUrl) {
      basePolicy.url = explicitUrl;
      basePolicy.evidenceMode = "http";
      if (explicitProtocols.length === 0) {
        requiredProtocols = ["http-api"];
      }
    } else if (explicitCommand) {
      basePolicy.commandTemplate = explicitCommand;
      basePolicy.evidenceMode = "shell";
      if (explicitProtocols.length === 0) {
        requiredProtocols = ["ssh"];
      }
    } else {
      basePolicy.url = `http://${device.ip}/`;
      basePolicy.evidenceMode = "http";
      if (explicitProtocols.length === 0) {
        requiredProtocols = ["http-api"];
      }
      notes.push("No explicit evidence source provided; semantic monitor will inspect the default HTTP endpoint.");
    }
    basePolicy.confidenceThreshold = 0.7;
    basePolicy.requiredProtocols = requiredProtocols;
  }

  if (monitorType === "desktop_ui_assertion") {
    const probeCommand = extractCodeBlock(cleanedPrompt);
    if (probeCommand) {
      basePolicy.probeCommandTemplate = probeCommand;
    } else {
      notes.push("Desktop UI monitor created in pending mode; add a probe command or UI automation adapter to execute it.");
    }
    const expectedText = extractExpectedText(cleanedPrompt);
    if (expectedText) {
      basePolicy.expectedText = expectedText;
    }
  }

  const serviceKeySeed = serviceToken
    || slugify(cleanedPrompt)
    || `custom-monitor-${Date.now().toString(36)}`;
  const serviceKey = `${serviceKeySeed}-${Date.now().toString(36)}`.slice(0, 64);
  const displayName = cleanedPrompt.length > 90
    ? `${cleanedPrompt.slice(0, 87)}...`
    : cleanedPrompt;

  const contract: ServiceContract = {
    id: randomUUID(),
    deviceId: device.id,
    assuranceKey: serviceKey,
    serviceKey,
    displayName: displayName || "Custom monitor",
    criticality: inferCriticality(cleanedPrompt),
    desiredState: "running",
    checkIntervalSec: intervalSec,
    monitorType,
    requiredProtocols,
    rationale: cleanedPrompt,
    configJson: basePolicy,
    policyJson: basePolicy,
    createdAt,
    updatedAt: createdAt,
  };

  return {
    contract,
    monitorType,
    requiredProtocols,
    notes,
  };
}

function asMonitorType(value: unknown): MonitorType {
  const monitorType = String(value ?? "").trim().toLowerCase();
  if (monitorType === "port_open") return "port_open";
  if (monitorType === "http_contains") return "http_contains";
  if (monitorType === "shell_assertion") return "shell_assertion";
  if (monitorType === "desktop_ui_assertion") return "desktop_ui_assertion";
  if (monitorType === "semantic_assertion") return "semantic_assertion";
  return "service_presence";
}

export function getMonitorType(contract: ServiceContract): MonitorType {
  return asMonitorType(contract.policyJson.monitorType);
}

export function getRequiredProtocolsForServiceContract(contract: ServiceContract): string[] {
  const fromPolicy = toStringArray(contract.policyJson.requiredProtocols);
  if (fromPolicy.length > 0) {
    return fromPolicy;
  }

  const monitorType = getMonitorType(contract);
  if (monitorType === "http_contains") return ["http-api"];
  if (monitorType === "semantic_assertion") {
    if (typeof contract.policyJson.commandTemplate === "string" && contract.policyJson.commandTemplate.trim().length > 0) {
      return ["ssh"];
    }
    if (typeof contract.policyJson.probeCommandTemplate === "string" && contract.policyJson.probeCommandTemplate.trim().length > 0) {
      return ["winrm"];
    }
    return ["http-api"];
  }
  if (monitorType === "desktop_ui_assertion") return ["winrm"];
  if (monitorType === "shell_assertion") return ["ssh"];
  return [];
}

export function isServiceContractDue(contract: ServiceContract, nowMs = Date.now()): boolean {
  const intervalSec = clampIntervalSec(contract.checkIntervalSec);
  const lastEvaluatedAtRaw = contract.policyJson.lastEvaluatedAt;
  if (typeof lastEvaluatedAtRaw !== "string" || lastEvaluatedAtRaw.trim().length === 0) {
    return true;
  }
  const lastMs = Date.parse(lastEvaluatedAtRaw);
  if (!Number.isFinite(lastMs)) {
    return true;
  }
  return nowMs - lastMs >= intervalSec * 1000;
}

function interpolateHost(template: string, device: Device): string {
  const host = device.ip.includes(":") ? `[${device.ip}]` : device.ip;
  return template.replace(/\{\{host\}\}/g, host);
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      body: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function gatherSemanticEvidence(
  device: Device,
  contract: ServiceContract,
): Promise<Record<string, unknown> | null> {
  const policy = contract.policyJson;
  const evidenceMode = typeof policy.evidenceMode === "string"
    ? policy.evidenceMode.trim().toLowerCase()
    : undefined;
  const timeoutMs = Number.isFinite(Number(policy.timeoutMs))
    ? Math.min(10 * 60_000, Math.max(2_000, Math.floor(Number(policy.timeoutMs))))
    : 20_000;

  if (
    evidenceMode === "shell"
    || typeof policy.commandTemplate === "string"
    || typeof policy.command === "string"
  ) {
    const commandTemplate = typeof policy.commandTemplate === "string"
      ? policy.commandTemplate.trim()
      : typeof policy.command === "string"
        ? policy.command.trim()
        : "";
    if (!commandTemplate) {
      return null;
    }
    const command = interpolateHost(commandTemplate, device);
    const brokerRequest = brokerRequestFromPolicy(policy, command);
    if (brokerRequest) {
      const operation: OperationSpec = {
        id: `contract:${contract.id}:semantic`,
        adapterId: adapterIdForBroker(brokerRequest.protocol),
        kind: "shell.command",
        mode: "read",
        timeoutMs,
        brokerRequest,
        expectedSemanticTarget: contract.displayName,
        safety: {
          dryRunSupported: false,
          requiresConfirmedRevert: false,
          criticality: "low",
        },
      };
      const result = await executeBrokerOperation(operation, device, {}, { actor: "steward" });
      return {
        source: "shell",
        brokerProtocol: brokerRequest.protocol,
        ok: result.ok,
        status: result.status,
        phase: result.phase,
        proof: result.proof,
        summary: result.summary,
        output: result.output.slice(0, 2_000),
        details: result.details,
      };
    }

    const result = await runShell(command, timeoutMs);
    return {
      source: "shell",
      ok: result.ok,
      exitCode: result.code,
      output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim().slice(0, 2_000),
      command,
    };
  }

  if (
    evidenceMode === "desktop"
    || typeof policy.probeCommandTemplate === "string"
    || typeof policy.probeCommand === "string"
  ) {
    const commandTemplate = typeof policy.probeCommandTemplate === "string"
      ? policy.probeCommandTemplate.trim()
      : typeof policy.probeCommand === "string"
        ? policy.probeCommand.trim()
        : "";
    if (!commandTemplate) {
      return null;
    }
    const command = interpolateHost(commandTemplate, device);
    const result = await runShell(command, timeoutMs);
    return {
      source: "desktop",
      ok: result.ok,
      exitCode: result.code,
      output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim().slice(0, 2_000),
      command,
    };
  }

  const rawUrl = typeof policy.url === "string" ? policy.url.trim() : "";
  const url = rawUrl.length > 0 ? rawUrl : `http://${device.ip}/`;
  const response = await fetchTextWithTimeout(url, timeoutMs);
  return {
    source: "http",
    ok: response.ok,
    status: response.status,
    url,
    body: response.body.slice(0, 4_000),
  };
}

async function evaluateSemanticAssertion(
  device: Device,
  contract: ServiceContract,
  defaultPolicy: Record<string, unknown>,
): Promise<ServiceContractEvaluation> {
  const semanticPrompt = typeof contract.policyJson.semanticPrompt === "string" && contract.policyJson.semanticPrompt.trim().length > 0
    ? contract.policyJson.semanticPrompt.trim()
    : typeof contract.rationale === "string" && contract.rationale.trim().length > 0
      ? contract.rationale.trim()
      : `Determine whether ${contract.displayName} is healthy and matches its expected behavior.`;
  const confidenceThreshold = Number.isFinite(Number(contract.policyJson.confidenceThreshold))
    ? Math.max(0.1, Math.min(1, Number(contract.policyJson.confidenceThreshold)))
    : 0.7;
  const evidence = await gatherSemanticEvidence(device, contract);
  if (!evidence) {
    return {
      status: "pending",
      summary: `${contract.displayName} semantic monitor is missing a usable evidence source.`,
      evidenceJson: {
        monitorType: "semantic_assertion",
        reason: "missing_evidence_source",
      },
      updatedPolicyJson: {
        ...defaultPolicy,
        lastStatus: "pending",
      },
      monitorType: "semantic_assertion",
    };
  }

  let providerForHealth = "default";
  try {
    const provider = await getDefaultProvider();
    providerForHealth = provider;
    const model = await buildLanguageModel(provider);
    const evidenceInput = JSON.stringify({
      contract: {
        displayName: contract.displayName,
        criticality: contract.criticality,
        desiredState: contract.desiredState,
      },
      semanticPrompt,
      evidence,
    });
    const firewall = applyPromptFirewall(evidenceInput);
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 500,
      prompt: [
        "You evaluate whether a semantic monitor contract is satisfied.",
        "Return ONLY a single JSON object with keys:",
        "status ('pass' | 'fail' | 'pending'), confidence (0..1), summary (string), reasoning (string).",
        "Use 'pending' if the evidence is insufficient or ambiguous.",
        "Do not invent evidence beyond the payload.",
        `Monitor: ${contract.displayName}`,
        `Semantic prompt: ${semanticPrompt}`,
        firewall.tainted
          ? `Evidence was sanitized by prompt firewall. Reasons: ${firewall.reasons.join(", ")}`
          : "Evidence passed prompt firewall.",
        firewall.sanitized,
      ].join("\n"),
    });
    llmHealthController.reportSuccess(provider);

    const parsed = extractJsonObject(result.text);
    if (!parsed) {
      return {
        status: "pending",
        summary: `${contract.displayName} semantic evaluation returned an invalid result.`,
        evidenceJson: {
          monitorType: "semantic_assertion",
          provider,
          semanticPrompt,
          evidence,
          rawModelOutput: result.text.slice(0, 2_000),
        },
        updatedPolicyJson: {
          ...defaultPolicy,
          lastStatus: "pending",
        },
        monitorType: "semantic_assertion",
      };
    }

    const proposedStatus = parsed.status === "pass" || parsed.status === "fail" || parsed.status === "pending"
      ? parsed.status
      : "pending";
    const confidence = Number.isFinite(Number(parsed.confidence))
      ? Math.max(0, Math.min(1, Number(parsed.confidence)))
      : 0.5;
    const summary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0
      ? parsed.summary.trim()
      : `${contract.displayName} semantic evaluation completed.`;
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "";
    const status = confidence >= confidenceThreshold ? proposedStatus : "pending";
    const effectiveSummary = status === proposedStatus
      ? summary
      : `${summary} (Confidence ${confidence.toFixed(2)} below threshold ${confidenceThreshold.toFixed(2)}.)`;

    return {
      status,
      summary: effectiveSummary,
      evidenceJson: {
        monitorType: "semantic_assertion",
        provider,
        confidence,
        confidenceThreshold,
        reasoning,
        semanticPrompt,
        evidence,
      },
      updatedPolicyJson: {
        ...defaultPolicy,
        lastStatus: status,
        lastConfidence: confidence,
      },
      monitorType: "semantic_assertion",
    };
  } catch (error) {
    llmHealthController.reportFailure(providerForHealth);
    return {
      status: "pending",
      summary: `${contract.displayName} semantic evaluation is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      evidenceJson: {
        monitorType: "semantic_assertion",
        semanticPrompt,
        evidence,
      },
      updatedPolicyJson: {
        ...defaultPolicy,
        lastStatus: "pending",
      },
      monitorType: "semantic_assertion",
    };
  }
}

export async function evaluateServiceContract(
  device: Device,
  contract: ServiceContract,
): Promise<ServiceContractEvaluation> {
  const monitorType = getMonitorType(contract);
  const policy = { ...contract.policyJson };
  const evaluatedAt = nowIso();
  const defaultPolicy = {
    ...policy,
    monitorType,
    lastEvaluatedAt: evaluatedAt,
  };

  if (monitorType === "service_presence") {
    const token = contract.serviceKey.toLowerCase();
    const matched = device.services.find((service) => {
      const name = service.name.toLowerCase();
      const id = service.id.toLowerCase();
      const product = service.product?.toLowerCase() ?? "";
      return name.includes(token) || id.includes(token) || product.includes(token);
    });
    const shouldBeRunning = contract.desiredState === "running";
    const passed = shouldBeRunning ? Boolean(matched) : !matched;
    return {
      status: passed ? "pass" : "fail",
      summary: passed
        ? `${contract.displayName} check passed (${shouldBeRunning ? "service present" : "service absent"}).`
        : `${contract.displayName} check failed (${shouldBeRunning ? "service not detected" : "service still detected"}).`,
      evidenceJson: {
        monitorType,
        matchedServiceId: matched?.id,
        matchedServiceName: matched?.name,
        desiredState: contract.desiredState,
      },
      updatedPolicyJson: {
        ...defaultPolicy,
        lastStatus: passed ? "pass" : "fail",
      },
      monitorType,
    };
  }

  if (monitorType === "port_open") {
    const portRaw = Number(policy.port);
    const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : null;
    if (!port) {
      return {
        status: "pending",
        summary: `${contract.displayName} monitor is missing a valid port number.`,
        evidenceJson: { monitorType, reason: "missing_port" },
        updatedPolicyJson: {
          ...defaultPolicy,
          lastStatus: "pending",
        },
        monitorType,
      };
    }

    const open = device.services.some((service) => service.port === port);
    const passed = contract.desiredState === "running" ? open : !open;
    return {
      status: passed ? "pass" : "fail",
      summary: passed
        ? `${contract.displayName} check passed (port ${port} state is expected).`
        : `${contract.displayName} check failed (port ${port} state is unexpected).`,
      evidenceJson: {
        monitorType,
        port,
        open,
      },
      updatedPolicyJson: {
        ...defaultPolicy,
        lastStatus: passed ? "pass" : "fail",
      },
      monitorType,
    };
  }

  if (monitorType === "http_contains") {
    const rawUrl = typeof policy.url === "string" ? policy.url.trim() : "";
    const url = rawUrl.length > 0 ? rawUrl : `http://${device.ip}/`;
    const expectedText = typeof policy.expectedText === "string" && policy.expectedText.trim().length > 0
      ? policy.expectedText.trim()
      : undefined;
    const timeoutMs = Number.isFinite(Number(policy.timeoutMs))
      ? Math.min(60_000, Math.max(2_000, Math.floor(Number(policy.timeoutMs))))
      : 15_000;

    const response = await fetchTextWithTimeout(url, timeoutMs);
    const containsExpected = expectedText ? response.body.includes(expectedText) : true;
    const passed = response.ok && containsExpected;

    return {
      status: passed ? "pass" : "fail",
      summary: passed
        ? `${contract.displayName} check passed (HTTP endpoint healthy).`
        : `${contract.displayName} check failed (HTTP endpoint unhealthy or content mismatch).`,
      evidenceJson: {
        monitorType,
        url,
        status: response.status,
        expectedText: expectedText ?? null,
        containsExpected,
        responseSnippet: response.body.slice(0, 400),
      },
      updatedPolicyJson: {
        ...defaultPolicy,
        lastStatus: passed ? "pass" : "fail",
      },
      monitorType,
    };
  }

  if (monitorType === "semantic_assertion") {
    return evaluateSemanticAssertion(device, contract, defaultPolicy);
  }

  if (monitorType === "shell_assertion") {
    const commandTemplate = typeof policy.commandTemplate === "string"
      ? policy.commandTemplate.trim()
      : typeof policy.command === "string"
        ? policy.command.trim()
        : "";
    if (!commandTemplate) {
      return {
        status: "pending",
        summary: `${contract.displayName} monitor has no command template.`,
        evidenceJson: {
          monitorType,
          reason: "missing_command_template",
        },
        updatedPolicyJson: {
          ...defaultPolicy,
          lastStatus: "pending",
        },
        monitorType,
      };
    }

    const timeoutMs = Number.isFinite(Number(policy.timeoutMs))
      ? Math.min(10 * 60_000, Math.max(1_000, Math.floor(Number(policy.timeoutMs))))
      : 30_000;
    const command = interpolateHost(commandTemplate, device);
    const expectedText = typeof policy.expectedText === "string" && policy.expectedText.trim().length > 0
      ? policy.expectedText.trim()
      : undefined;
    const brokerRequest = brokerRequestFromPolicy(policy, command);

    if (brokerRequest) {
      const operation: OperationSpec = {
        id: `contract:${contract.id}`,
        adapterId: adapterIdForBroker(brokerRequest.protocol),
        kind: "shell.command",
        mode: "read",
        timeoutMs,
        brokerRequest: expectedText && brokerRequest.protocol === "winrm" && !brokerRequest.expectRegex
          ? {
            ...brokerRequest,
            expectRegex: escapeRegex(expectedText),
          }
          : brokerRequest,
        expectedSemanticTarget: contract.displayName,
        safety: {
          dryRunSupported: false,
          requiresConfirmedRevert: false,
          criticality: "low",
        },
      };
      const result = await executeBrokerOperation(operation, device, {}, { actor: "steward" });
      const matchesExpectation = expectedText ? result.output.includes(expectedText) : result.ok;
      const passed = result.ok && matchesExpectation;

      return {
        status: passed ? "pass" : "fail",
        summary: passed
          ? `${contract.displayName} check passed (remote assertion satisfied).`
          : `${contract.displayName} check failed (remote assertion did not pass).`,
        evidenceJson: {
          monitorType,
          brokerProtocol: brokerRequest.protocol,
          status: result.status,
          phase: result.phase,
          proof: result.proof,
          expectedText: expectedText ?? null,
          matchesExpectation,
          summary: result.summary,
          output: result.output.slice(0, 800),
          details: result.details,
        },
        updatedPolicyJson: {
          ...defaultPolicy,
          lastStatus: passed ? "pass" : "fail",
        },
        monitorType,
      };
    }

    const result = await runShell(command, timeoutMs);
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    const matchesExpectation = expectedText ? output.includes(expectedText) : true;
    const passed = result.ok && matchesExpectation;

    return {
      status: passed ? "pass" : "fail",
      summary: passed
        ? `${contract.displayName} check passed (shell assertion satisfied).`
        : `${contract.displayName} check failed (shell assertion did not pass).`,
      evidenceJson: {
        monitorType,
        command,
        exitCode: result.code,
        expectedText: expectedText ?? null,
        matchesExpectation,
        output: output.slice(0, 800),
      },
      updatedPolicyJson: {
        ...defaultPolicy,
        lastStatus: passed ? "pass" : "fail",
      },
      monitorType,
    };
  }

  const probeTemplate = typeof policy.probeCommandTemplate === "string"
    ? policy.probeCommandTemplate.trim()
    : typeof policy.probeCommand === "string"
      ? policy.probeCommand.trim()
      : "";
  if (!probeTemplate) {
    return {
      status: "pending",
      summary: `${contract.displayName} is waiting for a UI probe command or UI adapter workflow.`,
      evidenceJson: {
        monitorType,
        reason: "missing_ui_probe",
      },
      updatedPolicyJson: {
        ...defaultPolicy,
        lastStatus: "pending",
      },
      monitorType,
    };
  }

  const timeoutMs = Number.isFinite(Number(policy.timeoutMs))
    ? Math.min(10 * 60_000, Math.max(1_000, Math.floor(Number(policy.timeoutMs))))
    : 45_000;
  const expectedText = typeof policy.expectedText === "string" && policy.expectedText.trim().length > 0
    ? policy.expectedText.trim()
    : undefined;
  const command = interpolateHost(probeTemplate, device);
  const result = await runShell(command, timeoutMs);
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  const containsExpected = expectedText ? output.includes(expectedText) : true;
  const passed = result.ok && containsExpected;

  return {
    status: passed ? "pass" : "fail",
    summary: passed
      ? `${contract.displayName} UI check passed.`
      : `${contract.displayName} UI check failed.`,
    evidenceJson: {
      monitorType,
      command,
      exitCode: result.code,
      expectedText: expectedText ?? null,
      containsExpected,
      output: output.slice(0, 800),
    },
    updatedPolicyJson: {
      ...defaultPolicy,
      lastStatus: passed ? "pass" : "fail",
    },
    monitorType,
  };
}
