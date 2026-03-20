import { generateObject, generateText, NoObjectGeneratedError, parsePartialJson } from "ai";
import { z } from "zod";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import { evaluatePolicy } from "@/lib/policy/engine";
import { approveAction, createApproval, denyAction } from "@/lib/approvals/queue";
import { buildPlaybookRun, countRecentFamilyFailures, isFamilyQuarantined } from "@/lib/playbooks/factory";
import { queuePlaybookExecution } from "@/lib/playbooks/orchestrator";
import { getMissingCredentialProtocolsForPlaybook } from "@/lib/adoption/playbook-credentials";
import { DEVICE_TYPE_VALUES } from "@/lib/state/types";
import {
  buildCustomMonitorContractFromPrompt,
  getRequiredProtocolsForServiceContract,
} from "@/lib/monitoring/contracts";
import type {
  ActionLog,
  ChatMessage,
  ChatMessageMetadata,
  Device,
  DeviceType,
  LLMProvider,
  OperationSpec,
  PlaybookRun,
  PlaybookDefinition,
  PlaybookStep,
} from "@/lib/state/types";

const INVALID_NAME_TOKENS = new Set([
  "this",
  "that",
  "it",
  "device",
  "host",
  "box",
  "machine",
  "appliance",
  "thing",
]);

const DEVICE_TYPE_MAP: Record<string, DeviceType> = {
  server: "server",
  workstation: "workstation",
  desktop: "workstation",
  laptop: "laptop",
  notebook: "laptop",
  smartphone: "smartphone",
  phone: "smartphone",
  tablet: "tablet",
  router: "router",
  firewall: "firewall",
  switch: "switch",
  "access-point": "access-point",
  ap: "access-point",
  modem: "modem",
  "load-balancer": "load-balancer",
  "vpn-appliance": "vpn-appliance",
  "wan-optimizer": "wan-optimizer",
  camera: "camera",
  nvr: "nvr",
  dvr: "dvr",
  nas: "nas",
  san: "san",
  printer: "printer",
  scanner: "scanner",
  pbx: "pbx",
  freepbx: "pbx",
  asterisk: "pbx",
  "voip-phone": "voip-phone",
  sip: "voip-phone",
  "conference-system": "conference-system",
  "point-of-sale": "point-of-sale",
  pos: "point-of-sale",
  "badge-reader": "badge-reader",
  "door-controller": "door-controller",
  ups: "ups",
  pdu: "pdu",
  bmc: "bmc",
  iot: "iot",
  sensor: "sensor",
  controller: "controller",
  "smart-tv": "smart-tv",
  "media-streamer": "media-streamer",
  "game-console": "game-console",
  "container-host": "container-host",
  "vm-host": "vm-host",
  "kubernetes-master": "kubernetes-master",
  "kubernetes-worker": "kubernetes-worker",
  hypervisor: "hypervisor",
  unknown: "unknown",
};

const DeviceTypeSchema = z.enum(DEVICE_TYPE_VALUES);
const DeviceSettingsIntentSchema = z.object({
  renameRequested: z.boolean().default(false),
  categoryRequested: z.boolean().default(false),
  suggestedName: z.string().trim().min(2).max(128).nullable().default(null),
  suggestedType: DeviceTypeSchema.nullable().default(null),
}).default({
  renameRequested: false,
  categoryRequested: false,
  suggestedName: null,
  suggestedType: null,
});

const DeviceChatIntentSchema = z.object({
  intent: z.enum(["none", "approval_response", "device_settings", "monitor_request", "adhoc_task"]),
  rationale: z.string().min(1).max(600),
  approvalDecision: z.enum(["approve", "deny"]).nullable().default(null),
  deviceSettings: DeviceSettingsIntentSchema,
});

type DeviceChatIntent = z.infer<typeof DeviceChatIntentSchema>;

const AdhocTaskRequestResolutionSchema = z.object({
  normalizedRequest: z.string().trim().min(1).max(2_000).nullable().default(null),
  source: z.enum(["latest_message", "conversation_context", "ambiguous"]),
  rationale: z.string().min(1).max(600),
});

type AdhocTaskRequestResolution = z.infer<typeof AdhocTaskRequestResolutionSchema>;

const AdhocPlanStepSchema = z.object({
  label: z.string().min(1).max(160),
  commandTemplate: z.string().min(1).max(1_600),
  mode: z.enum(["read", "mutate"]).optional(),
  waitForCondition: z.boolean().optional(),
  pollIntervalMs: z.number().optional(),
  maxWaitMs: z.number().optional(),
  successRegex: z.string().min(1).max(400).optional(),
  failureRegex: z.string().min(1).max(400).optional(),
}).superRefine((step, ctx) => {
  if (!step.waitForCondition) {
    return;
  }
  if (!step.pollIntervalMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pollIntervalMs"],
      message: "waitForCondition steps require pollIntervalMs.",
    });
  }
  if (!step.maxWaitMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxWaitMs"],
      message: "waitForCondition steps require maxWaitMs.",
    });
  }
});

const AdhocPlanSchema = z.object({
  family: z.string().min(1).max(80),
  rationale: z.string().min(1).max(1_200),
  actionClass: z.enum(["B", "C", "D"]),
  criticality: z.enum(["low", "medium", "high"]),
  blastRadius: z.enum(["single-service", "single-device", "multi-device"]),
  requiredProtocol: z.enum(["ssh", "winrm", "powershell-ssh", "wmi", "smb", "rdp", "vnc", "docker", "http-api"]),
  mutateSteps: z.array(AdhocPlanStepSchema).min(1),
  verifySteps: z.array(AdhocPlanStepSchema).min(1),
  rollbackSteps: z.array(AdhocPlanStepSchema).default([]),
});

type AdhocPlan = z.infer<typeof AdhocPlanSchema>;

const MAX_ADHOC_PLAN_STEPS = 16;
const MIN_WAIT_POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_POLL_INTERVAL_MS = 60 * 60 * 1000;
const MIN_WAIT_DURATION_MS = 30_000;
const MAX_WAIT_DURATION_MS = 72 * 60 * 60 * 1000;
const ADHOC_PLAN_JSON_SHAPE_LINES = [
  "{",
  '  "family": "custom-install",',
  '  "rationale": "string",',
  '  "actionClass": "B|C|D",',
  '  "criticality": "low|medium|high",',
  '  "blastRadius": "single-service|single-device|multi-device",',
  '  "requiredProtocol": "ssh|winrm|powershell-ssh|wmi|smb|rdp|vnc|docker|http-api",',
  '  "mutateSteps": [{"label":"string","commandTemplate":"string","mode":"mutate","waitForCondition":false}],',
  '  "verifySteps": [{"label":"string","commandTemplate":"string","mode":"read","waitForCondition":false}],',
  '  "rollbackSteps": [{"label":"string","commandTemplate":"string","mode":"mutate","waitForCondition":false}]',
  "}",
] as const;

export interface DeviceChatActionResult {
  handled: boolean;
  response?: string;
  metadata?: Record<string, unknown>;
  chatMessageMetadata?: ChatMessageMetadata;
  error?: boolean;
}

interface DeviceChatActionInput {
  input: string;
  provider: LLMProvider;
  model?: string;
  attachedDevice: Device | null;
  history: ChatMessage[];
  sessionId?: string;
}

const MAX_DEVICE_CHAT_CONTEXT_MESSAGES = 40;

function trimTo(value: string, max = 120): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3)}...`;
}

function trimForContext(value: string, max = 320): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  const head = Math.max(40, Math.floor(max * 0.65));
  const tail = Math.max(30, max - head - 5);
  return `${trimmed.slice(0, head)} ... ${trimmed.slice(-tail)}`;
}

function normalizeAdhocPlan(plan: AdhocPlan): AdhocPlan {
  const normalizeStep = (step: AdhocPlan["mutateSteps"][number]): AdhocPlan["mutateSteps"][number] => {
    if (!step.waitForCondition) {
      return step;
    }

    return {
      ...step,
      pollIntervalMs: typeof step.pollIntervalMs === "number"
        ? Math.min(MAX_WAIT_POLL_INTERVAL_MS, Math.max(MIN_WAIT_POLL_INTERVAL_MS, Math.floor(step.pollIntervalMs)))
        : step.pollIntervalMs,
      maxWaitMs: typeof step.maxWaitMs === "number"
        ? Math.min(MAX_WAIT_DURATION_MS, Math.max(MIN_WAIT_DURATION_MS, Math.floor(step.maxWaitMs)))
        : step.maxWaitMs,
    };
  };

  return {
    ...plan,
    mutateSteps: plan.mutateSteps.slice(0, MAX_ADHOC_PLAN_STEPS).map(normalizeStep),
    verifySteps: plan.verifySteps.slice(0, MAX_ADHOC_PLAN_STEPS).map(normalizeStep),
    rollbackSteps: plan.rollbackSteps.slice(0, MAX_ADHOC_PLAN_STEPS).map(normalizeStep),
  };
}

async function parseAdhocPlanCandidate(text: string | undefined): Promise<AdhocPlan | null> {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = await parsePartialJson(trimmed);
  const candidate = AdhocPlanSchema.safeParse(parsed.value);
  if (!candidate.success) {
    return null;
  }

  return candidate.data;
}

async function repairAdhocPlanText(args: {
  rawText: string;
  errorMessage: string;
  provider: LLMProvider;
  model?: string;
  device: Device;
  input: string;
}): Promise<AdhocPlan | null> {
  const modelClient = await buildLanguageModel(args.provider, args.model);
  const repaired = await generateText({
    model: modelClient,
    temperature: 0,
    maxOutputTokens: 2_000,
    prompt: [
      "Rewrite the raw draft below into a valid JSON object for a Steward ad-hoc execution plan.",
      "Return JSON only. No markdown. No code fences. No explanations.",
      "Preserve the requested task, target, and intent.",
      "Keep the plan conservative and executable.",
      "mutateSteps and verifySteps must be non-empty arrays.",
      "waitForCondition steps must be read-only and include pollIntervalMs and maxWaitMs.",
      "",
      `Device: ${args.device.name} (${args.device.ip}) type=${args.device.type}`,
      `Resolved execution request: ${args.input}`,
      `Parse failure: ${args.errorMessage}`,
      "",
      "Required JSON shape:",
      ...ADHOC_PLAN_JSON_SHAPE_LINES,
      "",
      "Raw draft:",
      args.rawText,
    ].join("\n"),
  });

  return parseAdhocPlanCandidate(repaired.text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeDeviceForIntent(device: Device | null): string {
  if (!device) {
    return JSON.stringify({ attached: false });
  }

  return JSON.stringify({
    attached: true,
    id: device.id,
    name: device.name,
    ip: device.ip,
    type: device.type,
    autonomyTier: device.autonomyTier,
    environmentLabel: device.environmentLabel ?? "lab",
    protocols: device.protocols,
    os: device.os ?? null,
    vendor: device.vendor ?? null,
  }, null, 2);
}

function summarizeReferencedRuns(history: ChatMessage[], deviceId?: string): Array<Record<string, unknown>> {
  const runIds = new Set<string>();
  const runs: Array<Record<string, unknown>> = [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index]?.metadata?.playbookRun;
    if (!candidate?.runId || runIds.has(candidate.runId)) {
      continue;
    }
    if (deviceId && candidate.deviceId !== deviceId) {
      continue;
    }
    const run = stateStore.getPlaybookRunById(candidate.runId);
    if (!run) {
      continue;
    }
    runIds.add(candidate.runId);
    runs.push({
      id: run.id,
      name: run.name,
      status: run.status,
      actionClass: run.actionClass,
      normalizedRequest: run.evidence.preSnapshot?.normalizedRequest ?? null,
      waiting: run.evidence.waiting ?? null,
      steps: run.steps.slice(0, 6).map((step) => ({
        label: step.label,
        status: step.status,
      })),
    });
    if (runs.length >= 3) {
      break;
    }
  }

  return runs;
}

function summarizeConversationContext(
  history: ChatMessage[],
  options?: { maxMessages?: number; maxCharsPerMessage?: number; deviceId?: string },
): string {
  const maxMessages = Math.max(1, options?.maxMessages ?? MAX_DEVICE_CHAT_CONTEXT_MESSAGES);
  const maxCharsPerMessage = Math.max(80, options?.maxCharsPerMessage ?? 320);
  const messages = history.slice(-maxMessages).map((message) => ({
    role: message.role,
    content: trimForContext(message.content, maxCharsPerMessage),
    playbookRun: message.metadata?.playbookRun ?? null,
  }));
  const referencedRuns = summarizeReferencedRuns(history, options?.deviceId);
  return JSON.stringify({
    messages,
    referencedRuns,
  }, null, 2);
}

function summarizeRecentTaskSignals(sessionId?: string, deviceId?: string): string {
  if (!sessionId && !deviceId) {
    return "[]";
  }

  const signals = stateStore.getRecentActions(400)
    .filter((action): action is ActionLog => action.kind === "playbook")
    .filter((action) => {
      const context = isRecord(action.context) ? action.context : {};
      const actionSessionId = typeof context.sessionId === "string" ? context.sessionId : null;
      const actionDeviceId = typeof context.deviceId === "string" ? context.deviceId : null;
      if (sessionId && actionSessionId !== sessionId) {
        return false;
      }
      if (deviceId && actionDeviceId !== deviceId) {
        return false;
      }
      return true;
    })
    .map((action) => {
      const context = isRecord(action.context) ? action.context : {};
      const resolution = isRecord(context.requestResolution) ? context.requestResolution : null;
      return {
        at: action.at,
        message: trimForContext(action.message, 160),
        sourceRequest: typeof context.sourceRequest === "string"
          ? trimForContext(context.sourceRequest, 160)
          : null,
        normalizedRequest: typeof context.normalizedRequest === "string"
          ? trimForContext(context.normalizedRequest, 900)
          : null,
        requestResolutionSource: resolution && typeof resolution.source === "string"
          ? resolution.source
          : null,
        requestResolutionRationale: resolution && typeof resolution.rationale === "string"
          ? trimForContext(resolution.rationale, 220)
          : null,
      };
    })
    .filter((signal) => signal.sourceRequest || signal.normalizedRequest)
    .slice(0, 6);

  return JSON.stringify(signals, null, 2);
}

function buildAdhocTaskResolutionPrompt(args: {
  input: string;
  attachedDevice: Device | null;
  history: ChatMessage[];
  sessionId?: string;
  priorResolution?: AdhocTaskRequestResolution | null;
  recoveryMode?: boolean;
}): string {
  return [
    "You resolve the latest attached-device execution request into a self-contained task brief for Steward.",
    "Return JSON only. No markdown.",
    "Use recent chat history when the latest message is shorthand or a retry/continuation request.",
    "If the latest message is something like 'try again', 'do it', 'same task', or similar shorthand, restate the concrete task from the conversation if it is clear.",
    "Do not invent tasks or targets that are not clearly grounded in the conversation.",
    "Treat the request as clear when the underlying infrastructure change is identifiable, even if approvals, maintenance windows, exact timing, backup confirmation, rollback confirmation, or exact patch numbers still need to be handled later.",
    "Those operational controls belong to policy, approvals, and plan generation, not request resolution.",
    "Only return ambiguous when the actual software/service/change Steward should perform cannot be identified from the conversation.",
    "Example: after discussing a GitLab upgrade path, 'create a job to get this done' should resolve to the GitLab upgrade request, not ambiguous.",
    ...(args.recoveryMode
      ? [
        "The previous resolution was too conservative. Recover the concrete requested change if it is identifiable from the conversation.",
        `Previous resolution: ${JSON.stringify(args.priorResolution ?? null)}`,
      ]
      : []),
    "",
    "Attached device:",
    summarizeDeviceForIntent(args.attachedDevice),
    "",
    "Recent task signals:",
    summarizeRecentTaskSignals(args.sessionId, args.attachedDevice?.id),
    "",
    "Conversation context:",
    summarizeConversationContext(args.history, {
      maxMessages: MAX_DEVICE_CHAT_CONTEXT_MESSAGES,
      maxCharsPerMessage: 900,
      deviceId: args.attachedDevice?.id,
    }),
    "",
    `Latest user message: ${args.input}`,
    "",
    "Return JSON with this exact shape:",
    "{",
    '  "normalizedRequest": "string or null",',
    '  "source": "latest_message|conversation_context|ambiguous",',
    '  "rationale": "short string"',
    "}",
  ].join("\n");
}

async function classifyDeviceChatIntent(args: {
  input: string;
  provider: LLMProvider;
  model?: string;
  attachedDevice: Device | null;
  history: ChatMessage[];
  sessionId?: string;
}): Promise<DeviceChatIntent> {
  const modelClient = await buildLanguageModel(args.provider, args.model);
  const recentTaskSignals = summarizeRecentTaskSignals(args.sessionId, args.attachedDevice?.id);
  const result = await generateObject({
    model: modelClient,
    temperature: 0,
    maxOutputTokens: 700,
    schema: DeviceChatIntentSchema,
    schemaName: "device_chat_intent",
    schemaDescription: "Structured intent classification for an attached-device Steward chat turn.",
    prompt: [
      "You classify the latest attached-device Steward chat turn into a structured intent.",
      "Return JSON only. No markdown.",
      "Intent options:",
      '- "none": informational/research/planning-only conversation. This includes version checks, latest-version questions, upgrade-path research, compatibility questions, explanations, advice, or any turn that explicitly says not to create a task/job yet.',
      '- "approval_response": the user is explicitly approving or denying an already-proposed pending run.',
      '- "device_settings": the user wants to rename the device or change its device type/category metadata.',
      '- "monitor_request": the user wants Steward to create or update an ongoing monitor/assurance/watch.',
      '- "adhoc_task": the user is delegating execution now and wants Steward to create/run a governed mutation job on the device.',
      'A "job" in Steward means a governed background execution run, not an automation, checklist, or maintenance-window draft.',
      "Be conservative: do not classify as adhoc_task unless the user clearly wants execution now.",
      "If the user is only asking for research, planning, upgrade paths, or status, choose none.",
      "If the user says not to make a task/job yet, choose none.",
      "If the latest message asks to create a job/run/task for a concrete infrastructure change already established in the thread, choose adhoc_task.",
      "Do not reinterpret a request for a job as an automation, runbook, checklist, or scheduling request unless the user explicitly asks for those.",
      "Use the recent chat history and any referenced playbook run metadata when deciding.",
      "When classifying device_settings, set renameRequested/categoryRequested plus any concrete suggestedName/suggestedType that are explicitly or clearly implied by the message.",
      "When classifying approval_response, set approvalDecision to approve or deny.",
      "",
      "Attached device:",
      summarizeDeviceForIntent(args.attachedDevice),
      "",
      "Recent task signals:",
      recentTaskSignals,
      "",
      "Conversation context:",
      summarizeConversationContext(args.history, {
        maxMessages: MAX_DEVICE_CHAT_CONTEXT_MESSAGES,
        maxCharsPerMessage: 280,
        deviceId: args.attachedDevice?.id,
      }),
      "",
      `Latest user message: ${args.input}`,
      "",
      "Return JSON with this exact shape:",
      "{",
      '  "intent": "none|approval_response|device_settings|monitor_request|adhoc_task",',
      '  "rationale": "short string",',
      '  "approvalDecision": "approve|deny|null",',
      '  "deviceSettings": {',
      '    "renameRequested": false,',
      '    "categoryRequested": false,',
      '    "suggestedName": null,',
      '    "suggestedType": null',
      "  }",
      "}",
    ].join("\n"),
  });
  const initial = result.object;
  if (initial.intent !== "none") {
    return initial;
  }

  try {
    const recovered = await generateObject({
      model: modelClient,
      temperature: 0,
      maxOutputTokens: 700,
      schema: DeviceChatIntentSchema,
      schemaName: "device_chat_intent_recovery",
      schemaDescription: "Recovery pass for overly conservative attached-device intent classification.",
      prompt: [
        "The previous classification may have been too conservative.",
        "Re-evaluate whether the latest attached-device message is delegating execution of a concrete task already established in the thread.",
        "If the latest message asks to create a job/run/task or otherwise get the previously discussed change done now, choose adhoc_task.",
        "A Steward job is a governed mutation run on the attached device. It is not an automation or a runbook unless the user explicitly asks for those.",
        `Previous classification: ${JSON.stringify(initial)}`,
        "",
        "Attached device:",
        summarizeDeviceForIntent(args.attachedDevice),
        "",
        "Recent task signals:",
        recentTaskSignals,
        "",
        "Conversation context:",
        summarizeConversationContext(args.history, {
          maxMessages: MAX_DEVICE_CHAT_CONTEXT_MESSAGES,
          maxCharsPerMessage: 280,
          deviceId: args.attachedDevice?.id,
        }),
        "",
        `Latest user message: ${args.input}`,
        "",
        "Return JSON with this exact shape:",
        "{",
        '  "intent": "none|approval_response|device_settings|monitor_request|adhoc_task",',
        '  "rationale": "short string",',
        '  "approvalDecision": "approve|deny|null",',
        '  "deviceSettings": {',
        '    "renameRequested": false,',
        '    "categoryRequested": false,',
        '    "suggestedName": null,',
        '    "suggestedType": null',
        "  }",
        "}",
      ].join("\n"),
    });
    return recovered.object;
  } catch {
    return initial;
  }
}

async function resolveAdhocTaskRequest(args: {
  input: string;
  provider: LLMProvider;
  model?: string;
  attachedDevice: Device | null;
  history: ChatMessage[];
  sessionId?: string;
}): Promise<AdhocTaskRequestResolution> {
  const modelClient = await buildLanguageModel(args.provider, args.model);
  const result = await generateObject({
    model: modelClient,
    temperature: 0,
    maxOutputTokens: 700,
    schema: AdhocTaskRequestResolutionSchema,
    schemaName: "adhoc_task_request_resolution",
    schemaDescription: "Self-contained normalized execution request for an attached-device ad-hoc task.",
    prompt: buildAdhocTaskResolutionPrompt(args),
  });
  const initial = result.object;
  if (initial.source !== "ambiguous" || initial.normalizedRequest) {
    return initial;
  }

  try {
    const recovered = await generateObject({
      model: modelClient,
      temperature: 0,
      maxOutputTokens: 700,
      schema: AdhocTaskRequestResolutionSchema,
      schemaName: "adhoc_task_request_resolution_recovery",
      schemaDescription: "Recovery pass for overly conservative ad-hoc task request resolution.",
      prompt: buildAdhocTaskResolutionPrompt({
        ...args,
        priorResolution: initial,
        recoveryMode: true,
      }),
    });
    return recovered.object;
  } catch {
    return initial;
  }
}

function normalizeDeviceName(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.?!,;:]+$/, "");
}

function isValidDeviceName(value: string): boolean {
  const normalized = normalizeDeviceName(value);
  if (normalized.length < 2 || normalized.length > 128) {
    return false;
  }
  const lowered = normalized.toLowerCase();
  if (INVALID_NAME_TOKENS.has(lowered)) {
    return false;
  }
  if (/^(?:this|that|it)(?:\s+device)?$/i.test(lowered)) {
    return false;
  }
  return true;
}

function buildPlaybookChatMetadata(run: PlaybookRun): ChatMessageMetadata {
  return {
    playbookRun: {
      runId: run.id,
      deviceId: run.deviceId,
      status: run.status,
    },
  };
}

function mostRecentReferencedRunId(history: ChatMessage[], deviceId?: string): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index]?.metadata?.playbookRun;
    if (!candidate?.runId) {
      continue;
    }
    if (deviceId && candidate.deviceId !== deviceId) {
      continue;
    }
    return candidate.runId;
  }
  return null;
}

function summarizeRunState(run: PlaybookRun): string {
  if (run.status === "pending_approval") {
    return `Run ${run.id} is pending approval.`;
  }
  if (run.status === "waiting" && run.evidence.waiting) {
    return `Run ${run.id} is waiting on ${run.evidence.waiting.label}. Next wake: ${run.evidence.waiting.nextWakeAt}.`;
  }
  return `Run ${run.id} is ${run.status.replace(/_/g, " ")}.`;
}

function identityRecord(device: Device): Record<string, unknown> {
  if (typeof device.metadata.identity === "object" && device.metadata.identity !== null) {
    return device.metadata.identity as Record<string, unknown>;
  }
  return {};
}

function inferDeviceName(device: Device): string | null {
  const identity = identityRecord(device);
  const identityName = typeof identity.name === "string" ? normalizeDeviceName(identity.name) : "";
  if (identityName && isValidDeviceName(identityName)) {
    return identityName;
  }

  const inferredProduct = (
    typeof device.metadata.fingerprint === "object"
    && device.metadata.fingerprint !== null
    && typeof (device.metadata.fingerprint as Record<string, unknown>).inferredProduct === "string"
  )
    ? normalizeDeviceName(String((device.metadata.fingerprint as Record<string, unknown>).inferredProduct))
    : "";
  if (inferredProduct && isValidDeviceName(inferredProduct)) {
    return inferredProduct;
  }

  if (device.hostname) {
    const host = normalizeDeviceName(device.hostname);
    if (isValidDeviceName(host)) {
      return host;
    }
  }

  const vendorModel = [device.vendor, device.os]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizeDeviceName(value))
    .join(" ")
    .trim();
  if (vendorModel && isValidDeviceName(vendorModel)) {
    return vendorModel;
  }

  return null;
}

function inferDeviceCategory(device: Device): DeviceType | null {
  const identity = identityRecord(device);
  const identityType = typeof identity.type === "string" ? identity.type.trim().toLowerCase() : "";
  if (identityType && identityType in DEVICE_TYPE_MAP) {
    return DEVICE_TYPE_MAP[identityType];
  }

  const hints = [
    device.name,
    device.hostname,
    device.vendor,
    device.os,
    typeof identity.description === "string" ? identity.description : "",
    typeof device.metadata.fingerprint === "object"
    && device.metadata.fingerprint !== null
    && typeof (device.metadata.fingerprint as Record<string, unknown>).inferredProduct === "string"
      ? (device.metadata.fingerprint as Record<string, unknown>).inferredProduct as string
      : "",
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (hints.includes("barracuda") && hints.includes("backup")) {
    return "nas";
  }
  if (/(firewall|pfsense|fortigate|opnsense|checkpoint)/.test(hints)) return "firewall";
  if (/(router|gateway|edge-router)/.test(hints)) return "router";
  if (/(switch|aruba|cisco catalyst)/.test(hints)) return "switch";
  if (/(access point|wireless ap|unifi ap)/.test(hints)) return "access-point";
  if (/(printer|laserjet|officejet)/.test(hints)) return "printer";
  if (/(nas|synology|qnap)/.test(hints)) return "nas";
  if (/(ups|uninterruptible power)/.test(hints)) return "ups";
  if (/(vmware|esxi|proxmox|hyper-v|hypervisor)/.test(hints)) return "hypervisor";
  if (/(server|ubuntu|debian|windows server|rhel)/.test(hints)) return "server";

  return null;
}

async function handlePendingApprovalResponse(
  decision: "approve" | "deny",
  history: ChatMessage[],
  device: Device | null,
  sessionId?: string,
): Promise<DeviceChatActionResult> {
  const runId = mostRecentReferencedRunId(history, device?.id);
  if (!runId) {
    return { handled: false };
  }

  const run = stateStore.getPlaybookRunById(runId);
  if (!run || run.status !== "pending_approval") {
    return { handled: false };
  }

  if (decision === "approve") {
    const approved = approveAction(run.id, "user_chat");
    if (!approved) {
      return {
        handled: true,
        response: `Approval could not be applied. ${summarizeRunState(run)}`,
        metadata: { action: "playbook_approval", runId: run.id, sessionId, approved: false },
      };
    }
    return {
      handled: true,
      response: `Approved ${approved.name}. Run ${approved.id} is queued and will continue in the background, including any wait checkpoints it needs.`,
      metadata: { action: "playbook_approval", runId: approved.id, sessionId, approved: true },
      chatMessageMetadata: buildPlaybookChatMetadata(approved),
    };
  }

  const denied = denyAction(run.id, "user_chat", "Denied in chat");
  if (!denied) {
    return {
      handled: true,
      response: `Denial could not be applied. ${summarizeRunState(run)}`,
      metadata: { action: "playbook_denial", runId: run.id, sessionId, denied: false },
    };
  }
  return {
    handled: true,
    response: `Denied ${denied.name}. Run ${denied.id} will not execute.`,
    metadata: { action: "playbook_denial", runId: denied.id, sessionId, denied: true },
    chatMessageMetadata: buildPlaybookChatMetadata(denied),
  };
}

async function handleDeviceSettingsRequest(
  settingsIntent: DeviceChatIntent["deviceSettings"],
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

  const suggestedName = settingsIntent.suggestedName
    ? normalizeDeviceName(settingsIntent.suggestedName)
    : null;
  const suggestedType = settingsIntent.suggestedType;
  const renameRequested = settingsIntent.renameRequested;
  const categoryRequested = settingsIntent.categoryRequested;
  const inferredName = !suggestedName && renameRequested ? inferDeviceName(device) : null;
  const inferredType = !suggestedType && categoryRequested ? inferDeviceCategory(device) : null;
  const nextName = suggestedName && isValidDeviceName(suggestedName)
    ? suggestedName
    : inferredName;
  const nextType = suggestedType ?? inferredType;

  if (!nextName && !nextType) {
    return {
      handled: true,
      response: `I couldn't determine a concrete device metadata change for ${device.name}. Tell me the new name or category you want set.`,
      metadata: { action: "device_settings", blocked: "missing_target_value", deviceId: device.id, sessionId },
    };
  }

  const updated: Device = {
    ...device,
    name: nextName ?? device.name,
    type: nextType ?? device.type,
    metadata: nextName
      ? {
        ...device.metadata,
        identity: {
          ...(typeof device.metadata.identity === "object" && device.metadata.identity !== null
            ? device.metadata.identity as Record<string, unknown>
            : {}),
          nameManuallySet: true,
          nameManuallySetAt: new Date().toISOString(),
          nameSetBy: "user_chat",
        },
      }
      : device.metadata,
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
    nextName && nextName !== device.name ? `name -> ${nextName}` : null,
    nextType && nextType !== device.type ? `category -> ${nextType}` : null,
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
      previousName: device.name,
      nextName: updated.name,
      previousType: device.type,
      nextType: updated.type,
      inferredName: Boolean(inferredName && !suggestedName),
      inferredType: Boolean(inferredType && !suggestedType),
      sessionId,
    },
  };
}

function extractServiceToken(input: string): string | null {
  const match = input.match(/\b(?:install|setup|set up|deploy|configure)\s+([a-zA-Z0-9._-]+)/i);
  if (match && match[1]) {
    return match[1].toLowerCase();
  }
  return null;
}

function chooseProtocol(device: Device): AdhocPlan["requiredProtocol"] | null {
  const protocols = new Set(device.protocols.map((value) => value.toLowerCase()));
  if (protocols.has("ssh")) return "ssh";
  if (protocols.has("winrm")) return "winrm";
  if (protocols.has("powershell-ssh")) return "powershell-ssh";
  if (protocols.has("docker")) return "docker";
  if (protocols.has("http-api")) return "http-api";
  return null;
}

function fallbackPlanForDevice(device: Device, input: string): AdhocPlan | null {
  const protocol = chooseProtocol(device);
  if (!protocol) {
    return null;
  }

  const serviceToken = extractServiceToken(input);
  if (!serviceToken) {
    return null;
  }

  const service = serviceToken.replace(/[^a-z0-9._-]/gi, "").toLowerCase();
  if (!service) {
    return null;
  }

  if (protocol === "ssh") {
    return {
      family: "custom-install",
      rationale: `Install and configure ${service} on ${device.name} via SSH.`,
      actionClass: "C",
      criticality: "medium",
      blastRadius: "single-device",
      requiredProtocol: "ssh",
      mutateSteps: [
        {
          label: "Refresh package metadata",
          commandTemplate: `ssh {{host}} 'sudo apt-get update -y'`,
        },
        {
          label: `Install ${service}`,
          commandTemplate: `ssh {{host}} 'sudo apt-get install -y ${service}'`,
        },
      ],
      verifySteps: [
        {
          label: `Verify ${service} is running`,
          commandTemplate: `ssh {{host}} 'systemctl is-active ${service} || pgrep -f ${service}'`,
          mode: "read",
        },
      ],
      rollbackSteps: [
        {
          label: `Remove ${service}`,
          commandTemplate: `ssh {{host}} 'sudo apt-get remove -y ${service}'`,
        },
      ],
    };
  }

  if (protocol === "winrm") {
    return {
      family: "custom-install",
      rationale: `Install and configure ${service} on ${device.name} via WinRM.`,
      actionClass: "C",
      criticality: "medium",
      blastRadius: "single-device",
      requiredProtocol: "winrm",
      mutateSteps: [
        {
          label: `Install ${service}`,
          commandTemplate: `pwsh -NoLogo -NonInteractive -Command "Invoke-Command -ComputerName {{host}} -ScriptBlock { winget install --id ${service} -e --accept-package-agreements --accept-source-agreements }"`,
        },
      ],
      verifySteps: [
        {
          label: `Verify ${service} service state`,
          commandTemplate: `pwsh -NoLogo -NonInteractive -Command "Invoke-Command -ComputerName {{host}} -ScriptBlock { Get-Service -Name '${service}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status }"`,
          mode: "read",
        },
      ],
      rollbackSteps: [],
    };
  }

  if (protocol === "powershell-ssh") {
    return {
      family: "custom-install",
      rationale: `Install and configure ${service} on ${device.name} via PowerShell over SSH.`,
      actionClass: "C",
      criticality: "medium",
      blastRadius: "single-device",
      requiredProtocol: "powershell-ssh",
      mutateSteps: [
        {
          label: `Install ${service}`,
          commandTemplate: `ssh {{host}} "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"winget install --id ${service} -e --accept-package-agreements --accept-source-agreements\""`,
        },
      ],
      verifySteps: [
        {
          label: `Verify ${service} service state`,
          commandTemplate: `ssh {{host}} "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"Get-Service -Name '${service}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status\""`,
          mode: "read",
        },
      ],
      rollbackSteps: [],
    };
  }

  if (protocol === "docker") {
    return {
      family: "custom-install",
      rationale: `Deploy ${service} as a container responsibility on ${device.name}.`,
      actionClass: "C",
      criticality: "medium",
      blastRadius: "single-device",
      requiredProtocol: "docker",
      mutateSteps: [
        {
          label: `Pull ${service} image`,
          commandTemplate: `docker -H tcp://{{host}} pull ${service}:latest`,
        },
        {
          label: `Start ${service} container`,
          commandTemplate: `docker -H tcp://{{host}} run -d --restart unless-stopped --name ${service} ${service}:latest`,
        },
      ],
      verifySteps: [
        {
          label: `Verify ${service} container state`,
          commandTemplate: `docker -H tcp://{{host}} ps --filter name=${service} --format '{{.Names}} {{.Status}}'`,
          mode: "read",
        },
      ],
      rollbackSteps: [
        {
          label: `Remove ${service} container`,
          commandTemplate: `docker -H tcp://{{host}} rm -f ${service}`,
        },
      ],
    };
  }

  return {
    family: "custom-task",
    rationale: `Execute HTTP/API-oriented setup checks on ${device.name}.`,
    actionClass: "C",
    criticality: "medium",
    blastRadius: "single-device",
    requiredProtocol: "http-api",
    mutateSteps: [
      {
        label: "Run API reachability check",
        commandTemplate: `curl -fsS --max-time 15 http://{{host}}/`,
      },
    ],
    verifySteps: [
      {
        label: "Verify API reachability",
        commandTemplate: `curl -fsS --max-time 15 http://{{host}}/`,
        mode: "read",
      },
    ],
    rollbackSteps: [],
  };
}

async function llmAdhocPlanForDevice(
  device: Device,
  input: string,
  provider: LLMProvider,
  history: ChatMessage[],
  model?: string,
): Promise<AdhocPlan | null> {
  const suggestedProtocol = chooseProtocol(device);
  if (!suggestedProtocol) {
    return null;
  }

  const modelClient = await buildLanguageModel(provider, model);
  const prompt = [
    "You generate strict JSON for Steward ad-hoc infrastructure task plans.",
    "Return JSON only. No markdown.",
    "All steps must use shell command templates.",
    "Use {{host}} placeholder for the target host when needed.",
    "Prefer safe, reversible operations and include verification.",
    "If the task may take a long time, add waitForCondition steps instead of sleeping inline.",
    "Wait steps must be read-only condition checks with pollIntervalMs and maxWaitMs.",
    "Choose actionClass conservatively but accurately: B for low-risk restart/retry/cleanup, C for single-device package or config maintenance, D for destructive or outage-prone high-impact changes.",
    "Choose criticality based on service impact. Most single-device maintenance is medium, not high.",
    "Use blastRadius=single-device unless the request clearly affects multiple devices or multiple services.",
    "If unsure, keep steps minimal and conservative.",
    "",
    `Device: ${device.name} (${device.ip}) type=${device.type} os=${device.os ?? "unknown"}`,
    `Discovered protocols: ${device.protocols.join(", ") || "none"}`,
    `Preferred protocol: ${suggestedProtocol}`,
    "",
    "Conversation context:",
    summarizeConversationContext(history, {
      maxMessages: MAX_DEVICE_CHAT_CONTEXT_MESSAGES,
      maxCharsPerMessage: 1_200,
      deviceId: device.id,
    }),
    "",
    "Return this JSON shape:",
    ...ADHOC_PLAN_JSON_SHAPE_LINES,
    'Use waitForCondition=true only for polling checkpoints. Example wait step: {"label":"Wait for migrations","commandTemplate":"ssh {{host}} \'sudo gitlab-rake gitlab:background_migrations:status\'","mode":"read","waitForCondition":true,"pollIntervalMs":60000,"maxWaitMs":14400000,"successRegex":"finished|no pending"}',
    "",
    `Resolved execution request: ${input}`,
  ].join("\n");

  try {
    const result = await generateObject({
      model: modelClient,
      temperature: 0.1,
      maxOutputTokens: 2_000,
      schema: AdhocPlanSchema,
      schemaName: "adhoc_playbook_plan",
      schemaDescription: "Durable Steward ad-hoc execution plan with mutate, verify, and rollback steps.",
      prompt,
    });
    return result.object;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const repairedFromRaw = await parseAdhocPlanCandidate(error.text);
      if (repairedFromRaw) {
        return repairedFromRaw;
      }
      if (typeof error.text === "string" && error.text.trim().length > 0) {
        const repaired = await repairAdhocPlanText({
          rawText: error.text,
          errorMessage: error.message,
          provider,
          model,
          device,
          input,
        });
        if (repaired) {
          return repaired;
        }
      }
    }
    throw error;
  }
}

function operationForPlannedStep(
  id: string,
  adapterId: string,
  defaultMode: OperationSpec["mode"],
  step: AdhocPlan["mutateSteps"][number],
): PlaybookStep["operation"] {
  const isWaitStep = step.waitForCondition === true;
  const mode = isWaitStep ? "read" : (step.mode ?? defaultMode);
  return {
    id: `op:${id}`,
    adapterId,
    kind: "shell.command",
    mode,
    timeoutMs: isWaitStep ? 60_000 : mode === "read" ? 30_000 : 180_000,
    commandTemplate: step.commandTemplate,
    args: isWaitStep
      ? {
        waitForCondition: true,
        ...(typeof step.pollIntervalMs === "number" ? { pollIntervalMs: step.pollIntervalMs } : {}),
        ...(typeof step.maxWaitMs === "number" ? { maxWaitMs: step.maxWaitMs } : {}),
        ...(typeof step.successRegex === "string" ? { successRegex: step.successRegex } : {}),
        ...(typeof step.failureRegex === "string" ? { failureRegex: step.failureRegex } : {}),
      }
      : undefined,
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
  const steps = plan.mutateSteps.map((step, idx) => ({
    id: `step:mutate:${idx + 1}`,
    label: step.label,
    operation: operationForPlannedStep(`mutate:${idx + 1}`, plan.requiredProtocol, "mutate", step),
  }));
  const verificationSteps = plan.verifySteps.map((step, idx) => ({
    id: `step:verify:${idx + 1}`,
    label: step.label,
    operation: operationForPlannedStep(`verify:${idx + 1}`, plan.requiredProtocol, "read", step),
  }));
  const rollbackSteps = plan.rollbackSteps.map((step, idx) => ({
    id: `step:rollback:${idx + 1}`,
    label: step.label,
    operation: operationForPlannedStep(`rollback:${idx + 1}`, plan.requiredProtocol, "mutate", step),
  }));

  return {
    id: `adhoc:${safeFamily}:${Date.now()}`,
    family: safeFamily,
    name: `Ad-hoc task on ${device.name}: ${trimTo(request, 56)}`,
    description: plan.rationale,
    actionClass: plan.actionClass,
    blastRadius: plan.blastRadius,
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
  stateStore.upsertAssurance(draft.contract);

  const requiredProtocols = getRequiredProtocolsForServiceContract(draft.contract);
  const usable = new Set(stateStore.getUsableCredentialProtocols(device.id).map((item) => item.toLowerCase()));
  const missing = requiredProtocols.filter((protocol) => !usable.has(protocol));

  if (missing.length > 0) {
    stateStore.upsertDeviceFindingByDedupe({
      deviceId: device.id,
      dedupeKey: `monitor-credential-gap:${draft.contract.id}:${missing.sort().join(",")}`,
      findingType: "missing_credentials",
      severity: "warning",
      title: `${device.name} assurance missing credentials`,
      summary: `Custom assurance "${draft.contract.displayName}" needs credentials for: ${missing.join(", ")}.`,
      evidenceJson: {
        assuranceId: draft.contract.id,
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
    message: `Created custom assurance on ${device.name}`,
    context: {
      deviceId: device.id,
      assuranceId: draft.contract.id,
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
      `Created assurance "${draft.contract.displayName}" on ${device.name}.`,
      `Type: ${draft.monitorType}.`,
      `Interval: every ${draft.contract.checkIntervalSec}s.`,
      credentialSuffix,
      noteSuffix,
    ].join(" ").replace(/\s+\n/g, "\n").trim(),
    metadata: {
      action: "monitor",
      deviceId: device.id,
      assuranceId: draft.contract.id,
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
  history: ChatMessage[],
  sessionId?: string,
): Promise<DeviceChatActionResult> {
  if (!device) {
    return {
      handled: true,
      response: "I can plan that device task, but this chat is not attached to a device. Attach a device in chat and retry.",
      metadata: { action: "adhoc_task", blocked: "missing_device", sessionId },
    };
  }

  let requestResolution: AdhocTaskRequestResolution = {
    normalizedRequest: input.trim(),
    source: "latest_message",
    rationale: "Used the latest user message verbatim.",
  };
  try {
    requestResolution = await resolveAdhocTaskRequest({
      input,
      provider,
      model,
      attachedDevice: device,
      history,
      sessionId,
    });
  } catch {
    requestResolution = {
      normalizedRequest: input.trim(),
      source: "latest_message",
      rationale: "Task request resolution failed, so Steward used the latest user message verbatim.",
    };
  }

  const planningRequest = requestResolution.normalizedRequest?.trim() ?? "";
  if (!planningRequest) {
    await stateStore.addAction({
      actor: "steward",
      kind: "playbook",
      message: `Blocked ad-hoc task planning on ${device.name}: ambiguous request`,
      context: {
        deviceId: device.id,
        sessionId: sessionId ?? null,
        sourceRequest: input,
        normalizedRequest: null,
        requestResolution,
      },
    });
    return {
      handled: true,
      response: `I couldn't safely determine which task to execute from "${trimTo(input, 80)}". Restate the concrete job you want me to run on ${device.name}.`,
      metadata: {
        action: "adhoc_task",
        blocked: "ambiguous_request",
        deviceId: device.id,
        requestResolution,
        sessionId,
      },
    };
  }

  let plan: AdhocPlan | null = null;
  let planGenerationError: string | null = null;
  try {
    plan = await llmAdhocPlanForDevice(device, planningRequest, provider, history, model);
  } catch (error) {
    planGenerationError = error instanceof Error ? error.message : String(error);
    plan = null;
  }
  if (!plan) {
    plan = fallbackPlanForDevice(device, planningRequest);
  }
  if (plan) {
    plan = normalizeAdhocPlan(plan);
  }
  if (!plan) {
    await stateStore.addAction({
      actor: "steward",
      kind: "playbook",
      message: `Failed to build ad-hoc task plan on ${device.name}`,
      context: {
        deviceId: device.id,
        sessionId: sessionId ?? null,
        sourceRequest: input,
        normalizedRequest: planningRequest,
        requestResolution,
        planGenerationError,
      },
    });
    return {
      handled: true,
      response: `I couldn't build a safe executable plan for ${device.name} from "${trimTo(planningRequest, 100)}". Restate the task with the exact change you want Steward to make.`,
      metadata: {
        action: "adhoc_task",
        blocked: "plan_generation_failed",
        deviceId: device.id,
        normalizedRequest: planningRequest,
        requestResolution,
        planGenerationError,
        sessionId,
      },
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

  const playbook = toAdhocPlaybook(device, planningRequest, plan);
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
      criticality: plan.criticality,
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

  const runBase = buildPlaybookRun(playbook, {
    deviceId: device.id,
    policyEvaluation,
    initialStatus: policyEvaluation.decision === "ALLOW_AUTO" ? "approved" : "pending_approval",
    lane: "A",
  });
  const run: PlaybookRun = {
    ...runBase,
    evidence: {
      ...runBase.evidence,
      preSnapshot: {
        ...(runBase.evidence.preSnapshot ?? {}),
        sourceRequest: input,
        normalizedRequest: planningRequest,
        requestResolutionSource: requestResolution.source,
        requestResolutionRationale: requestResolution.rationale,
        sessionId: sessionId ?? null,
      },
    },
  };

  let persistedRun = run;
  if (policyEvaluation.decision === "REQUIRE_APPROVAL") {
    persistedRun = createApproval(run, device);
  } else {
    stateStore.upsertPlaybookRun(run);
    queuePlaybookExecution(run, "auto");
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
        normalizedRequest: planningRequest,
      },
  });

  const firstStep = playbook.steps[0];
  const firstCommand = firstStep?.operation.commandTemplate ?? "";
  const commandPreview = firstCommand.length > 140 ? `${firstCommand.slice(0, 137)}...` : firstCommand;
  const stateText = policyEvaluation.decision === "REQUIRE_APPROVAL"
    ? `pending approval (run ${persistedRun.id})`
    : `queued for background execution (run ${persistedRun.id})`;
  const approvalHint = policyEvaluation.decision === "REQUIRE_APPROVAL"
    ? ` Reply "approve it" here or use Jobs > Pending.`
    : " Steward will resume automatically across wait checkpoints until the run reaches a terminal state.";

  return {
    handled: true,
      response: [
        `Created an ad-hoc task plan for ${device.name} and ${stateText}.`,
        `Protocol: ${plan.requiredProtocol}.`,
        `Policy: ${policyEvaluation.decision}.`,
        `First step: ${firstStep?.label ?? commandPreview}`,
      approvalHint,
    ].join(" ").trim(),
      metadata: {
        action: "adhoc_task",
        runId: persistedRun.id,
        deviceId: device.id,
        policyDecision: policyEvaluation.decision,
        requiredProtocol: plan.requiredProtocol,
        normalizedRequest: planningRequest,
        requestResolution,
        sessionId,
      },
      chatMessageMetadata: buildPlaybookChatMetadata(persistedRun),
  };
}

export async function tryHandleDeviceChatAction(
  input: DeviceChatActionInput,
): Promise<DeviceChatActionResult> {
  const text = input.input.trim();
  if (!text) {
    return { handled: false };
  }

  let classifiedIntent: DeviceChatIntent;
  try {
    classifiedIntent = await classifyDeviceChatIntent({
      input: text,
      provider: input.provider,
      model: input.model,
      attachedDevice: input.attachedDevice,
      history: input.history,
      sessionId: input.sessionId,
    });
  } catch {
    return { handled: false };
  }

  if (classifiedIntent.intent === "approval_response" && classifiedIntent.approvalDecision) {
    return handlePendingApprovalResponse(
      classifiedIntent.approvalDecision,
      input.history,
      input.attachedDevice,
      input.sessionId,
    );
  }

  if (classifiedIntent.intent === "device_settings") {
    return handleDeviceSettingsRequest(classifiedIntent.deviceSettings, input.attachedDevice, input.sessionId);
  }

  if (classifiedIntent.intent === "monitor_request") {
    return handleMonitorRequest(text, input.attachedDevice, input.sessionId);
  }

  if (classifiedIntent.intent === "adhoc_task") {
    return handleAdhocTaskRequest(
      text,
      input.provider,
      input.model,
      input.attachedDevice,
      input.history,
      input.sessionId,
    );
  }

  return { handled: false };
}
