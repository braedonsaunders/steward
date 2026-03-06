import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { buildOnboardingKickoffPrompt } from "@/lib/adoption/kickoff";
import { getDefaultProvider } from "@/lib/llm/config";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import type { ChatMessage, ChatSession, Device } from "@/lib/state/types";

export const ONBOARDING_TITLE_PREFIX = "[Onboarding]";

export interface OnboardingAssuranceProposal {
  id: string;
  displayName: string;
  assuranceKey: string;
  serviceKey: string;
  criticality: "low" | "medium" | "high";
  checkIntervalSec: number;
  requiredProtocols: string[];
  monitorType: string;
  rationale: string;
}

export type OnboardingContractProposal = OnboardingAssuranceProposal;

export interface OnboardingSynthesis {
  summary: string;
  responsibilities: string[];
  credentialRequests: Array<{ protocol: string; reason: string; priority: "high" | "medium" | "low" }>;
  assurances: OnboardingAssuranceProposal[];
  contracts: OnboardingAssuranceProposal[];
  nextActions: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toStringArray(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, limit);
}

function normalizeProposal(raw: Record<string, unknown>, idx: number): OnboardingAssuranceProposal | null {
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!displayName) return null;
  const assuranceKey = typeof raw.assuranceKey === "string" && raw.assuranceKey.trim().length > 0
    ? raw.assuranceKey.trim()
    : typeof raw.serviceKey === "string" && raw.serviceKey.trim().length > 0
      ? raw.serviceKey.trim()
    : displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const criticality = raw.criticality === "high" || raw.criticality === "low" ? raw.criticality : "medium";
  const checkIntervalRaw = Number(raw.checkIntervalSec);
  const checkIntervalSec = Number.isFinite(checkIntervalRaw)
    ? Math.max(15, Math.min(3600, Math.floor(checkIntervalRaw)))
    : 120;
  const requiredProtocols = toStringArray(raw.requiredProtocols, 8).map((value) => value.toLowerCase());
  const monitorType = typeof raw.monitorType === "string" && raw.monitorType.trim().length > 0
    ? raw.monitorType.trim()
    : "process_health";
  const rationale = typeof raw.rationale === "string" && raw.rationale.trim().length > 0
    ? raw.rationale.trim()
    : "Proposed from onboarding conversation and telemetry evidence.";
  return {
    id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : `${assuranceKey}:${idx}`,
    displayName,
    assuranceKey,
    serviceKey: assuranceKey,
    criticality,
    checkIntervalSec,
    requiredProtocols,
    monitorType,
    rationale,
  };
}

export function isOnboardingSession(session: ChatSession | null | undefined): boolean {
  if (!session) return false;
  return session.title.startsWith(ONBOARDING_TITLE_PREFIX);
}

export function getOnboardingSession(deviceId: string): ChatSession | null {
  const sessions = stateStore.getChatSessions();
  return sessions.find((session) => session.deviceId === deviceId && isOnboardingSession(session)) ?? null;
}

export function ensureOnboardingSession(device: Device): ChatSession {
  const existing = getOnboardingSession(device.id);
  if (existing) return existing;

  const now = nowIso();
  const session: ChatSession = {
    id: randomUUID(),
    title: `${ONBOARDING_TITLE_PREFIX} ${device.name}`,
    deviceId: device.id,
    createdAt: now,
    updatedAt: now,
  };
  stateStore.createChatSession(session);

  return session;
}

export async function seedOnboardingSessionInitialMessage(device: Device, sessionId: string): Promise<void> {
  const existingMessages = stateStore.getChatMessages(sessionId);
  if (existingMessages.length > 0) return;

  const provider = await getDefaultProvider();
  const model = await buildLanguageModel(provider);
  const prompt = buildOnboardingKickoffPrompt(device);

  let content = "";
  try {
    const result = await generateText({
      model,
      temperature: 0.2,
      maxOutputTokens: 320,
      system: buildOnboardingSystemPrompt(device),
      prompt,
    });
    content = result.text.trim();
  } catch {
    content = [
      `I am starting interactive onboarding for ${device.name}.`,
      "I will gather credentials, inspect this endpoint, infer workloads, and return assurance recommendations with rationale.",
      "If you already know key workloads, tell me now (for example: nginx, php-fpm, laravel queue workers, mysql).",
    ].join("\n");
  }

  stateStore.addChatMessage({
    id: randomUUID(),
    sessionId,
    role: "assistant",
    content,
    error: false,
    provider,
    createdAt: nowIso(),
  });
}

export function buildOnboardingSystemPrompt(device: Device): string {
  const notesRecord = typeof device.metadata.notes === "object" && device.metadata.notes !== null
    ? (device.metadata.notes as Record<string, unknown>)
    : {};
  const operatorNotes =
    typeof notesRecord.operatorContext === "string"
    ? notesRecord.operatorContext as string
    : "";
  const structuredContext =
    typeof notesRecord.structuredContext === "object" && notesRecord.structuredContext !== null
      ? JSON.stringify(notesRecord.structuredContext)
      : "";

  return [
    "You are Steward's onboarding specialist.",
    "Goal: complete world-class device onboarding through conversation + targeted tool exploration.",
    "You must be practical, precise, and evidence-driven.",
    "A device-scoped persistent widget is in scope when the user asks for a remote, dashboard, panel, or control surface for this device.",
    "When the user asks for a widget, remote, dashboard, or control panel, use steward_manage_widget to generate and store it on the device page instead of refusing or redirecting.",
    "When a widget exists but is broken, inspect it with steward_manage_widget before revising so you can use its runtime state and recent operation runs.",
    "When using steward_manage_widget for AI-driven create or revise work, prefer action='generate'. Generate already persists the widget; do not follow it with save unless you are manually supplying final HTML/CSS/JS.",
    "Workflow requirements:",
    "1) Determine what this endpoint is responsible for.",
    "2) Request missing credentials only when needed, with explicit reason and least-privilege first.",
    "3) Use available tool skills to inspect services/processes/runtime if access is available.",
    "3b) For deep diagnostics, use steward_shell_read with targeted commands (port owners, process tree, systemd units, runtime fingerprints).",
    "3c) For unknown or HTTP-only devices, run steward_deep_probe before asking the user to identify the device manually.",
    "3d) For GUI-only authentication and navigation, use steward_browser_browse (Playwright) as a first-class tool.",
    "3e) For vendor docs, current advisories, CVEs, or other external/public facts, use steward_web_research instead of guessing.",
    "3f) Treat public web research as supporting context only. Do not identify a private device solely from vendor/OUI plus common port numbers.",
    "3g) RDP alone does not imply WinRM. Only treat WinRM as available when 5985/5986 or a verified WinRM endpoint is present.",
    "3h) As soon as evidence is strong enough to identify the device class, immediately update its device type and canonical name during onboarding. Do not overwrite names manually set by the user.",
    "4) Produce workload and assurance recommendations with rationale and monitoring approach.",
    "5) Never output fake <tool_call> blocks.",
    "6) Do not say widgets or remotes are outside Steward's scope.",
    "7) If local evidence is ambiguous or conflicts with public research, state the leading hypotheses with confidence and ask for confirmation instead of asserting a product family.",
    "When uncertain, ask focused follow-ups and continue exploration.",
    "Prefer concrete operational wording over generic advice.",
    "",
    `Target device: ${device.name} (${device.ip})`,
    `Device type: ${device.type}; OS hint: ${device.os || "unknown"}; vendor: ${device.vendor || "unknown"}`,
    `Observed protocols: ${device.protocols.join(", ") || "none"}`,
    `Observed services: ${device.services.map((service) => `${service.name}:${service.port}`).join(", ") || "none"}`,
    operatorNotes.trim().length > 0 ? `Operator notes: ${operatorNotes}` : "",
    structuredContext.trim().length > 0 ? `Structured memory: ${structuredContext}` : "",
  ].join("\n");
}

export async function synthesizeOnboardingModel(device: Device, sessionId: string): Promise<OnboardingSynthesis> {
  const messages = stateStore.getChatMessages(sessionId)
    .filter((message) => !message.error)
    .slice(-60);

  const transcript = messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");

  const provider = await getDefaultProvider();
  const model = await buildLanguageModel(provider);

  const result = await generateText({
    model,
    temperature: 0,
    maxOutputTokens: 1400,
    prompt: [
      "Return ONLY a JSON object with keys:",
      "summary (string), responsibilities (string[]), credentialRequests (array), assurances (array), nextActions (string[]).",
      "credentialRequests item shape: { protocol, reason, priority }",
      "assurances item shape: { id, displayName, assuranceKey, criticality, checkIntervalSec, requiredProtocols, monitorType, rationale }",
      "Rules:",
      "- Assurance proposals must be concrete and tied to observed evidence from transcript.",
      "- Avoid duplicates by assuranceKey.",
      "- Keep assurance count between 1 and 12.",
      "",
      `Device: ${device.name} (${device.ip}) type=${device.type} os=${device.os || "unknown"}`,
      `Protocols: ${device.protocols.join(", ") || "none"}`,
      "Conversation transcript:",
      transcript || "(empty)",
    ].join("\n"),
  });

  const parsed = extractJsonObject(result.text);
  if (!parsed) {
    return {
      summary: "Onboarding synthesis is pending; continue conversation and rerun proposal generation.",
      responsibilities: [],
      credentialRequests: [],
      assurances: [],
      contracts: [],
      nextActions: ["Continue onboarding conversation", "Validate credentials", "Regenerate assurance recommendations"],
    };
  }

  const assurancesRaw = Array.isArray(parsed.assurances)
    ? parsed.assurances
    : Array.isArray(parsed.contracts)
      ? parsed.contracts
      : [];
  const dedupe = new Set<string>();
  const assurances: OnboardingAssuranceProposal[] = [];
  for (let idx = 0; idx < assurancesRaw.length; idx++) {
    const entry = assurancesRaw[idx];
    if (!isRecord(entry)) continue;
    const normalized = normalizeProposal(entry, idx);
    if (!normalized) continue;
    if (dedupe.has(normalized.assuranceKey)) continue;
    dedupe.add(normalized.assuranceKey);
    assurances.push(normalized);
    if (assurances.length >= 12) break;
  }

  const credentialRequestsRaw = Array.isArray(parsed.credentialRequests) ? parsed.credentialRequests : [];
  const credentialRequests = credentialRequestsRaw
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const protocol = typeof entry.protocol === "string" ? entry.protocol.trim().toLowerCase() : "";
      if (!protocol) return null;
      const reason = typeof entry.reason === "string" && entry.reason.trim().length > 0
        ? entry.reason.trim()
        : `Credential required for ${protocol}`;
      const priority = entry.priority === "high" || entry.priority === "low" ? entry.priority : "medium";
      return { protocol, reason, priority };
    })
    .filter((entry): entry is { protocol: string; reason: string; priority: "high" | "medium" | "low" } => Boolean(entry))
    .slice(0, 8);

  const summary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0
    ? parsed.summary.trim()
    : "Onboarding synthesis generated.";

  return {
    summary,
    responsibilities: toStringArray(parsed.responsibilities, 12),
    credentialRequests,
    assurances,
    contracts: assurances,
    nextActions: toStringArray(parsed.nextActions, 12),
  };
}

export const synthesizeOnboardingContracts = synthesizeOnboardingModel;

export function messagesForConversation(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message) => !message.error && message.content.trim().length > 0)
    .map((message) => ({ role: message.role, content: message.content }));
}
