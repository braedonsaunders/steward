import { generateText } from "ai";
import { z } from "zod";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import { evaluatePolicy } from "@/lib/policy/engine";
import { createApproval } from "@/lib/approvals/queue";
import { buildPlaybookRun, countRecentFamilyFailures, isFamilyQuarantined } from "@/lib/playbooks/factory";
import { getMissingCredentialProtocolsForPlaybook } from "@/lib/adoption/playbook-credentials";
import {
  buildCustomMonitorContractFromPrompt,
  getRequiredProtocolsForServiceContract,
} from "@/lib/monitoring/contracts";
import type {
  Device,
  DeviceType,
  LLMProvider,
  OperationSpec,
  PlaybookDefinition,
  PlaybookStep,
} from "@/lib/state/types";

const monitorIntentPattern = /\b(monitor|watch|track|observe|alert if|keep an eye|check every)\b/i;
const uiIntentPattern = /\b(ui|gui|desktop|screen|window|rdp|vnc)\b/i;
const uiCheckPattern = /\b(check|verify|watch|see|inspect)\b/i;
const adhocTaskPattern = /\b(install|set up|setup|deploy|provision|configure|bootstrap)\b/i;
const renameIntentPattern = /\b(rename|name\s+this|call\s+it)\b/i;
const categoryIntentPattern = /\b(category|device\s+type|type\s+to|mark\s+as)\b/i;

const DEVICE_TYPE_MAP: Record<string, DeviceType> = {
  server: "server",
  workstation: "workstation",
  desktop: "workstation",
  laptop: "workstation",
  router: "router",
  firewall: "firewall",
  switch: "switch",
  "access-point": "access-point",
  ap: "access-point",
  camera: "camera",
  nas: "nas",
  printer: "printer",
  iot: "iot",
  "container-host": "container-host",
  hypervisor: "hypervisor",
  unknown: "unknown",
};

const AdhocPlanSchema = z.object({
  family: z.string().min(1).max(80),
  rationale: z.string().min(1).max(1_200),
  requiredProtocol: z.enum(["ssh", "winrm", "docker", "http-api"]),
  mutateCommandTemplates: z.array(z.string().min(1).max(800)).min(1).max(6),
  verifyCommandTemplates: z.array(z.string().min(1).max(800)).min(1).max(6),
  rollbackCommandTemplates: z.array(z.string().min(1).max(800)).max(6).default([]),
});

type AdhocPlan = z.infer<typeof AdhocPlanSchema>;

export interface DeviceChatActionResult {
  handled: boolean;
  response?: string;
  metadata?: Record<string, unknown>;
}

interface DeviceChatActionInput {
  input: string;
  provider: LLMProvider;
  model?: string;
  attachedDevice: Device | null;
  sessionId?: string;
}

function trimTo(value: string, max = 120): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3)}...`;
}

function looksLikeMonitorIntent(input: string): boolean {
  return monitorIntentPattern.test(input) || (uiIntentPattern.test(input) && uiCheckPattern.test(input));
}

function looksLikeAdhocTaskIntent(input: string): boolean {
  return adhocTaskPattern.test(input);
}

function extractSuggestedName(input: string): string | null {
  const quoted = input.match(/["']([^"']{2,64})["']/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const direct = input.match(/\b(?:rename|call\s+it|name\s+this(?:\s+device)?)\s+(?:to\s+)?([a-zA-Z0-9._-]{2,64})/i);
  if (direct?.[1]) {
    return direct[1].trim();
  }

  return null;
}

function extractSuggestedCategory(input: string): DeviceType | null {
  const normalized = input.toLowerCase();
  for (const [key, value] of Object.entries(DEVICE_TYPE_MAP)) {
    if (normalized.includes(key)) {
      return value;
    }
  }
  return null;
}

async function handleDeviceSettingsRequest(
  input: string,
  device: Device | null,
  sessionId?: string,
): Promise<DeviceChatActionResult> {
  if (!device) {
    return {
      handled: true,
      response: "I can update device settings, but this chat is not attached to a device.",
      metadata: { action: "device_settings", blocked: "missing_device", sessionId },
    };
  }

  const suggestedName = extractSuggestedName(input);
  const suggestedType = extractSuggestedCategory(input);
  if (!suggestedName && !suggestedType) {
    return { handled: false };
  }

  const updated: Device = {
    ...device,
    name: suggestedName ?? device.name,
    type: suggestedType ?? device.type,
    lastChangedAt: new Date().toISOString(),
  };
  await stateStore.upsertDevice(updated);
  await stateStore.addAction({
    actor: "steward",
    kind: "config",
    message: `Updated device settings for ${device.name}`,
    context: {
      deviceId: device.id,
      previousName: device.name,
      nextName: updated.name,
      previousType: device.type,
      nextType: updated.type,
      sessionId: sessionId ?? null,
    },
  });

  const changes = [
    suggestedName && suggestedName !== device.name ? `name -> ${suggestedName}` : null,
    suggestedType && suggestedType !== device.type ? `category -> ${suggestedType}` : null,
  ].filter(Boolean);

  return {
    handled: true,
    response: changes.length > 0
      ? `Updated ${device.name}: ${changes.join(", ")}.`
      : `No settings changes were needed for ${device.name}.`,
    metadata: {
      action: "device_settings",
      deviceId: device.id,
      changes,
      sessionId,
    },
  };
}

function extractServiceToken(input: string): string {
  const match = input.match(/\b(?:install|setup|set up|deploy|configure)\s+([a-zA-Z0-9._-]+)/i);
  if (match && match[1]) {
    return match[1].toLowerCase();
  }
  return "custom-service";
}

function extractFirstJsonObject(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No JSON object found in model response");
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

function chooseProtocol(device: Device): AdhocPlan["requiredProtocol"] | null {
  const protocols = new Set(device.protocols.map((value) => value.toLowerCase()));
  if (protocols.has("ssh")) return "ssh";
  if (protocols.has("winrm")) return "winrm";
  if (protocols.has("docker")) return "docker";
  if (protocols.has("http-api")) return "http-api";
  return null;
}

function fallbackPlanForDevice(device: Device, input: string): AdhocPlan | null {
  const protocol = chooseProtocol(device);
  if (!protocol) {
    return null;
  }

  const service = extractServiceToken(input).replace(/[^a-z0-9._-]/gi, "").toLowerCase() || "custom-service";
  if (protocol === "ssh") {
    return {
      family: "custom-install",
      rationale: `Install and configure ${service} on ${device.name} via SSH.`,
      requiredProtocol: "ssh",
      mutateCommandTemplates: [
        `ssh {{host}} 'sudo apt-get update -y'`,
        `ssh {{host}} 'sudo apt-get install -y ${service}'`,
      ],
      verifyCommandTemplates: [
        `ssh {{host}} 'systemctl is-active ${service} || pgrep -f ${service}'`,
      ],
      rollbackCommandTemplates: [
        `ssh {{host}} 'sudo apt-get remove -y ${service}'`,
      ],
    };
  }

  if (protocol === "winrm") {
    return {
      family: "custom-install",
      rationale: `Install and configure ${service} on ${device.name} via WinRM.`,
      requiredProtocol: "winrm",
      mutateCommandTemplates: [
        `pwsh -NoLogo -NonInteractive -Command "Invoke-Command -ComputerName {{host}} -ScriptBlock { winget install --id ${service} -e --accept-package-agreements --accept-source-agreements }"`,
      ],
      verifyCommandTemplates: [
        `pwsh -NoLogo -NonInteractive -Command "Invoke-Command -ComputerName {{host}} -ScriptBlock { Get-Service -Name '${service}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status }"`,
      ],
      rollbackCommandTemplates: [],
    };
  }

  if (protocol === "docker") {
    return {
      family: "custom-install",
      rationale: `Deploy ${service} as a container workload on ${device.name}.`,
      requiredProtocol: "docker",
      mutateCommandTemplates: [
        `docker -H tcp://{{host}} pull ${service}:latest`,
        `docker -H tcp://{{host}} run -d --restart unless-stopped --name ${service} ${service}:latest`,
      ],
      verifyCommandTemplates: [
        `docker -H tcp://{{host}} ps --filter name=${service} --format '{{.Names}} {{.Status}}'`,
      ],
      rollbackCommandTemplates: [
        `docker -H tcp://{{host}} rm -f ${service}`,
      ],
    };
  }

  return {
    family: "custom-task",
    rationale: `Execute HTTP/API-oriented setup checks on ${device.name}.`,
    requiredProtocol: "http-api",
    mutateCommandTemplates: [
      `curl -fsS --max-time 15 http://{{host}}/`,
    ],
    verifyCommandTemplates: [
      `curl -fsS --max-time 15 http://{{host}}/`,
    ],
    rollbackCommandTemplates: [],
  };
}

async function llmAdhocPlanForDevice(
  device: Device,
  input: string,
  provider: LLMProvider,
  model?: string,
): Promise<AdhocPlan | null> {
  const suggestedProtocol = chooseProtocol(device);
  if (!suggestedProtocol) {
    return null;
  }

  const modelClient = await buildLanguageModel(provider, model);
  const result = await generateText({
    model: modelClient,
    temperature: 0.1,
    maxOutputTokens: 700,
    system: [
      "You generate strict JSON for Steward ad-hoc infrastructure task plans.",
      "Return JSON only. No markdown.",
      "All mutate/verify/rollback values must be shell command templates.",
      "Use {{host}} placeholder for the target host when needed.",
      "Prefer safe, reversible operations and include verification.",
      "If unsure, keep steps minimal and conservative.",
    ].join("\n"),
    prompt: [
      `Device: ${device.name} (${device.ip}) type=${device.type} os=${device.os ?? "unknown"}`,
      `Discovered protocols: ${device.protocols.join(", ") || "none"}`,
      `Preferred protocol: ${suggestedProtocol}`,
      "",
      "Return this JSON shape:",
      "{",
      '  "family": "custom-install",',
      '  "rationale": "string",',
      '  "requiredProtocol": "ssh|winrm|docker|http-api",',
      '  "mutateCommandTemplates": ["..."],',
      '  "verifyCommandTemplates": ["..."],',
      '  "rollbackCommandTemplates": ["..."]',
      "}",
      "",
      `User request: ${input}`,
    ].join("\n"),
  });

  const parsed = extractFirstJsonObject(result.text);
  const validated = AdhocPlanSchema.parse(parsed);
  return validated;
}

function operationForTemplate(
  id: string,
  adapterId: string,
  mode: OperationSpec["mode"],
  commandTemplate: string,
): PlaybookStep["operation"] {
  return {
    id: `op:${id}`,
    adapterId,
    kind: "shell.command",
    mode,
    timeoutMs: mode === "read" ? 30_000 : 180_000,
    commandTemplate,
    expectedSemanticTarget: "chat-adhoc-task",
    safety: {
      dryRunSupported: false,
      requiresConfirmedRevert: false,
      criticality: mode === "read" ? "low" : "high",
    },
  };
}

function toAdhocPlaybook(device: Device, request: string, plan: AdhocPlan): PlaybookDefinition {
  const safeFamily = plan.family.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 50) || "custom-task";
  const steps = plan.mutateCommandTemplates.map((template, idx) => ({
    id: `step:mutate:${idx + 1}`,
    label: `Mutate step ${idx + 1}`,
    operation: operationForTemplate(`mutate:${idx + 1}`, plan.requiredProtocol, "mutate", template),
  }));
  const verificationSteps = plan.verifyCommandTemplates.map((template, idx) => ({
    id: `step:verify:${idx + 1}`,
    label: `Verify step ${idx + 1}`,
    operation: operationForTemplate(`verify:${idx + 1}`, plan.requiredProtocol, "read", template),
  }));
  const rollbackSteps = plan.rollbackCommandTemplates.map((template, idx) => ({
    id: `step:rollback:${idx + 1}`,
    label: `Rollback step ${idx + 1}`,
    operation: operationForTemplate(`rollback:${idx + 1}`, plan.requiredProtocol, "mutate", template),
  }));

  return {
    id: `adhoc:${safeFamily}:${Date.now()}`,
    family: safeFamily,
    name: `Ad-hoc task on ${device.name}: ${trimTo(request, 56)}`,
    description: plan.rationale,
    actionClass: "D",
    blastRadius: "single-device",
    timeoutMs: Math.max(...steps.map((step) => step.operation.timeoutMs), 60_000),
    preconditions: {
      requiredProtocols: [plan.requiredProtocol],
    },
    steps,
    verificationSteps,
    rollbackSteps,
  };
}

async function handleMonitorRequest(
  input: string,
  device: Device | null,
  sessionId?: string,
): Promise<DeviceChatActionResult> {
  if (!device) {
    return {
      handled: true,
      response: "I can create that monitor, but this chat is not attached to a device. Attach a device in chat and resend your request.",
      metadata: { action: "monitor", blocked: "missing_device", sessionId },
    };
  }

  const draft = buildCustomMonitorContractFromPrompt(device, input);
  stateStore.upsertServiceContract(draft.contract);

  const requiredProtocols = getRequiredProtocolsForServiceContract(draft.contract);
  const validated = new Set(stateStore.getValidatedCredentialProtocols(device.id).map((item) => item.toLowerCase()));
  const missing = requiredProtocols.filter((protocol) => !validated.has(protocol));

  if (missing.length > 0) {
    stateStore.upsertDeviceFindingByDedupe({
      deviceId: device.id,
      dedupeKey: `monitor-credential-gap:${draft.contract.id}:${missing.sort().join(",")}`,
      findingType: "missing_credentials",
      severity: "warning",
      title: `${device.name} monitor missing credentials`,
      summary: `Custom monitor "${draft.contract.displayName}" needs credentials for: ${missing.join(", ")}.`,
      evidenceJson: {
        monitorContractId: draft.contract.id,
        requiredProtocols,
        missingProtocols: missing,
      },
      status: "open",
    });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Created custom monitor contract on ${device.name}`,
    context: {
      deviceId: device.id,
      monitorContractId: draft.contract.id,
      monitorType: draft.monitorType,
      requiredProtocols,
      missingProtocols: missing,
      sessionId: sessionId ?? null,
    },
  });

  const noteSuffix = draft.notes.length > 0 ? `\nNotes: ${draft.notes.join(" ")}` : "";
  const credentialSuffix = missing.length > 0
    ? `\nThis monitor is pending credentials for: ${missing.join(", ")}.`
    : "";

  return {
    handled: true,
    response: [
      `Created monitor "${draft.contract.displayName}" on ${device.name}.`,
      `Type: ${draft.monitorType}.`,
      `Interval: every ${draft.contract.checkIntervalSec}s.`,
      credentialSuffix,
      noteSuffix,
    ].join(" ").replace(/\s+\n/g, "\n").trim(),
    metadata: {
      action: "monitor",
      deviceId: device.id,
      monitorContractId: draft.contract.id,
      monitorType: draft.monitorType,
      missingProtocols: missing,
      sessionId,
    },
  };
}

async function handleAdhocTaskRequest(
  input: string,
  provider: LLMProvider,
  model: string | undefined,
  device: Device | null,
  sessionId?: string,
): Promise<DeviceChatActionResult> {
  if (!device) {
    return {
      handled: true,
      response: "I can plan that install/setup task, but this chat is not attached to a device. Attach a device in chat and retry.",
      metadata: { action: "adhoc_task", blocked: "missing_device", sessionId },
    };
  }

  let plan: AdhocPlan | null = null;
  try {
    plan = await llmAdhocPlanForDevice(device, input, provider, model);
  } catch {
    plan = null;
  }
  if (!plan) {
    plan = fallbackPlanForDevice(device, input);
  }
  if (!plan) {
    return {
      handled: true,
      response: `I couldn't build an executable plan for ${device.name}. This device needs a manageable protocol (ssh, winrm, docker, or http-api) first.`,
      metadata: { action: "adhoc_task", blocked: "no_manageable_protocol", deviceId: device.id, sessionId },
    };
  }

  const availableProtocols = new Set(device.protocols.map((protocol) => protocol.toLowerCase()));
  if (!availableProtocols.has(plan.requiredProtocol)) {
    return {
      handled: true,
      response: `I generated a plan requiring ${plan.requiredProtocol}, but ${device.name} currently exposes ${device.protocols.join(", ") || "no known management protocol"}.`,
      metadata: {
        action: "adhoc_task",
        blocked: "protocol_mismatch",
        deviceId: device.id,
        requiredProtocol: plan.requiredProtocol,
        availableProtocols: Array.from(availableProtocols),
        sessionId,
      },
    };
  }

  const playbook = toAdhocPlaybook(device, input, plan);
  const missingCredentials = getMissingCredentialProtocolsForPlaybook(device, playbook);
  if (missingCredentials.length > 0) {
    stateStore.upsertDeviceFindingByDedupe({
      deviceId: device.id,
      dedupeKey: `adhoc-missing-credentials:${plan.requiredProtocol}`,
      findingType: "missing_credentials",
      severity: "warning",
      title: `${device.name} missing credentials for ad-hoc task`,
      summary: `Ad-hoc task planning is blocked until credentials are provided for: ${missingCredentials.join(", ")}.`,
      evidenceJson: {
        requiredProtocol: plan.requiredProtocol,
        missingCredentials,
      },
      status: "open",
    });

    return {
      handled: true,
      response: `I prepared a plan, but execution is blocked until credentials are added for: ${missingCredentials.join(", ")}.`,
      metadata: {
        action: "adhoc_task",
        blocked: "missing_credentials",
        deviceId: device.id,
        requiredProtocol: plan.requiredProtocol,
        missingCredentials,
        sessionId,
      },
    };
  }

  const recentFailures = countRecentFamilyFailures(device.id, playbook.family);
  const quarantineActive = isFamilyQuarantined(device.id, playbook.family);
  const policyEvaluation = evaluatePolicy(
    playbook.actionClass,
    device,
    stateStore.getPolicyRules(),
    stateStore.getMaintenanceWindows(),
    {
      blastRadius: playbook.blastRadius,
      criticality: "high",
      lane: "A",
      recentFailures,
      quarantineActive,
    },
  );

  if (policyEvaluation.decision === "DENY") {
    await stateStore.addAction({
      actor: "steward",
      kind: "policy",
      message: `Denied ad-hoc task plan on ${device.name}`,
      context: {
        deviceId: device.id,
        policyReason: policyEvaluation.reason,
        sessionId: sessionId ?? null,
      },
    });

    return {
      handled: true,
      response: `I drafted the task but policy denied it: ${policyEvaluation.reason}`,
      metadata: {
        action: "adhoc_task",
        blocked: "policy_deny",
        deviceId: device.id,
        policyEvaluation,
        sessionId,
      },
    };
  }

  const run = buildPlaybookRun(playbook, {
    deviceId: device.id,
    policyEvaluation,
    initialStatus: policyEvaluation.decision === "ALLOW_AUTO" ? "approved" : "pending_approval",
    lane: "A",
  });

  if (policyEvaluation.decision === "REQUIRE_APPROVAL") {
    createApproval(run, device);
  } else {
    stateStore.upsertPlaybookRun(run);
  }

  await stateStore.addAction({
    actor: "steward",
    kind: "playbook",
    message: `Created ad-hoc task run ${run.id} for ${device.name}`,
    context: {
      runId: run.id,
      deviceId: device.id,
      sessionId: sessionId ?? null,
      policyDecision: policyEvaluation.decision,
      requiredProtocol: plan.requiredProtocol,
      family: playbook.family,
    },
  });

  const firstCommand = playbook.steps[0]?.operation.commandTemplate ?? "";
  const commandPreview = firstCommand.length > 140 ? `${firstCommand.slice(0, 137)}...` : firstCommand;
  const stateText = policyEvaluation.decision === "REQUIRE_APPROVAL"
    ? `pending approval (run ${run.id})`
    : `queued for execution (run ${run.id})`;

  return {
    handled: true,
    response: [
      `Created an ad-hoc task plan for ${device.name} and ${stateText}.`,
      `Protocol: ${plan.requiredProtocol}.`,
      `Policy: ${policyEvaluation.decision}.`,
      `First step: ${commandPreview}`,
    ].join(" "),
    metadata: {
      action: "adhoc_task",
      runId: run.id,
      deviceId: device.id,
      policyDecision: policyEvaluation.decision,
      requiredProtocol: plan.requiredProtocol,
      sessionId,
    },
  };
}

export async function tryHandleDeviceChatAction(
  input: DeviceChatActionInput,
): Promise<DeviceChatActionResult> {
  const text = input.input.trim();
  if (!text) {
    return { handled: false };
  }

  if (renameIntentPattern.test(text) || categoryIntentPattern.test(text)) {
    const settingsResult = await handleDeviceSettingsRequest(text, input.attachedDevice, input.sessionId);
    if (settingsResult.handled) {
      return settingsResult;
    }
  }

  if (looksLikeMonitorIntent(text)) {
    return handleMonitorRequest(text, input.attachedDevice, input.sessionId);
  }

  if (looksLikeAdhocTaskIntent(text)) {
    return handleAdhocTaskRequest(
      text,
      input.provider,
      input.model,
      input.attachedDevice,
      input.sessionId,
    );
  }

  return { handled: false };
}
