import { generateText } from "ai";
import { z } from "zod";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import type { ChatMessage, Device, LLMProvider } from "@/lib/state/types";

interface WidgetInventoryEntry {
  id: string;
  slug: string;
  name: string;
  description?: string;
  revision: number;
  updatedAt: string;
}

const WidgetRouteNoneSchema = z.object({
  route: z.literal("none"),
  reason: z.string().min(1).max(240),
});

const WidgetGenerateToolArgsSchema = z.object({
  action: z.literal("generate"),
  widget_id: z.string().min(1).optional(),
  widget_slug: z.string().min(1).optional(),
  prompt: z.string().min(1).max(1_200),
});

const WidgetGetToolArgsSchema = z.object({
  action: z.literal("get"),
  widget_id: z.string().min(1).optional(),
  widget_slug: z.string().min(1).optional(),
}).refine((value) => Boolean(value.widget_id || value.widget_slug), {
  message: "get requires widget_id or widget_slug",
  path: ["widget_id"],
});

const WidgetListToolArgsSchema = z.object({
  action: z.literal("list"),
});

const WidgetRouteWidgetSchema = z.object({
  route: z.literal("widget"),
  reason: z.string().min(1).max(240),
  toolArgs: z.discriminatedUnion("action", [
    WidgetGenerateToolArgsSchema,
    WidgetGetToolArgsSchema,
    WidgetListToolArgsSchema,
  ]),
});

export const WidgetRoutePlanSchema = z.discriminatedUnion("route", [
  WidgetRouteNoneSchema,
  WidgetRouteWidgetSchema,
]);

export type WidgetRoutePlan = z.infer<typeof WidgetRoutePlanSchema>;

const DIRECT_WIDGET_KEYWORD_PATTERN = /\b(widget|dashboard|control panel|control surface|remote control)\b/i;
const REMOTE_PANEL_HINT_PATTERN = /\b(remote|panel|ui|interface|screen)\b/i;
const REMOTE_PANEL_ACTION_PATTERN = /\b(build|create|make|generate|design|open|show|fix|repair|update|edit|change|revise|modify|restyle|redesign|delete|remove|inspect|list|use)\b/i;
const FOLLOW_UP_CONFIRM_PATTERN = /\b(yes|yeah|yep|go ahead|do it|please do|proceed|sounds good|that works|make it|build it|create it)\b/i;
const FOLLOW_UP_STRONG_WIDGET_ACTION_PATTERN = /\b(fix|repair|debug|restyle|redesign|rename|resize|rebuild|regenerate|refresh|delete|remove)\b/i;
const FOLLOW_UP_GENERIC_WIDGET_EDIT_PATTERN = /\b(change|update|edit|modify|add|move|make|keep|reuse)\b/i;
const FOLLOW_UP_INSPECT_PATTERN = /\b(show|open|inspect|review|look at|load|list)\b/i;
const FOLLOW_UP_REFERENCE_PATTERN = /\b(it|that|this|existing|current|same|one)\b/i;
const FOLLOW_UP_WIDGET_ISSUE_PATTERN = /\b(broken|blank|empty|loading|stuck|render|layout|button|buttons|scroll|style|styling)\b/i;

function normalizeWidgetIntentText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function messageMentionsWidgetConcept(rawText: string): boolean {
  const text = normalizeWidgetIntentText(rawText);
  if (!text) {
    return false;
  }
  if (DIRECT_WIDGET_KEYWORD_PATTERN.test(text)) {
    return true;
  }
  return REMOTE_PANEL_HINT_PATTERN.test(text) && REMOTE_PANEL_ACTION_PATTERN.test(text);
}

function recentHistoryHasWidgetContext(history: ChatMessage[]): boolean {
  const recentMessages = history
    .filter((message) => !message.error && message.content.trim().length > 0)
    .slice(-6);

  if (recentMessages.some((message) => messageMentionsWidgetConcept(message.content))) {
    return true;
  }

  return history
    .slice(-10)
    .some((message) =>
      (message.metadata?.toolEvents ?? []).some((event) => event.toolName === "steward_manage_widget"),
    );
}

export function shouldPlanWidgetRouteTurn(args: {
  history: ChatMessage[];
  userInput: string;
}): boolean {
  const text = normalizeWidgetIntentText(args.userInput);
  if (!text) {
    return false;
  }

  if (messageMentionsWidgetConcept(text)) {
    return true;
  }

  if (!recentHistoryHasWidgetContext(args.history)) {
    return false;
  }

  if (FOLLOW_UP_CONFIRM_PATTERN.test(text)) {
    return true;
  }

  if (
    FOLLOW_UP_STRONG_WIDGET_ACTION_PATTERN.test(text)
    && (FOLLOW_UP_REFERENCE_PATTERN.test(text) || FOLLOW_UP_WIDGET_ISSUE_PATTERN.test(text))
  ) {
    return true;
  }

  if (
    FOLLOW_UP_GENERIC_WIDGET_EDIT_PATTERN.test(text)
    && (FOLLOW_UP_REFERENCE_PATTERN.test(text) || FOLLOW_UP_WIDGET_ISSUE_PATTERN.test(text))
  ) {
    return true;
  }

  if (
    FOLLOW_UP_INSPECT_PATTERN.test(text)
    && (FOLLOW_UP_REFERENCE_PATTERN.test(text) || FOLLOW_UP_WIDGET_ISSUE_PATTERN.test(text))
  ) {
    return true;
  }

  return FOLLOW_UP_REFERENCE_PATTERN.test(text) && FOLLOW_UP_WIDGET_ISSUE_PATTERN.test(text);
}

function summarizeRecentMessages(history: ChatMessage[]): string {
  const relevant = history
    .filter((message) => !message.error && message.content.trim().length > 0)
    .slice(-8);

  if (relevant.length === 0) {
    return "(none)";
  }

  return relevant
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
}

function summarizeRecentWidgetToolEvents(history: ChatMessage[]): Array<Record<string, string>> {
  return history
    .slice(-12)
    .flatMap((message) =>
      (message.metadata?.toolEvents ?? [])
        .filter((event) => event.toolName === "steward_manage_widget")
        .map((event) => ({
          createdAt: message.createdAt,
          summary: event.summary ?? "",
          inputPreview: event.inputPreview ?? "",
          outputPreview: event.outputPreview ?? "",
        })),
    )
    .slice(-6);
}

function summarizeWidgets(deviceId: string): WidgetInventoryEntry[] {
  return stateStore
    .getDeviceWidgets(deviceId)
    .slice(0, 8)
    .map((widget) => ({
      id: widget.id,
      slug: widget.slug,
      name: widget.name,
      description: widget.description ?? undefined,
      revision: widget.revision,
      updatedAt: widget.updatedAt,
    }));
}

function clampPrompt(value: string, maxChars = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function extractFirstJsonObject(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Widget route planner did not return JSON.");
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

function buildFallbackWidgetRoutePlan(args: {
  history: ChatMessage[];
  userInput: string;
  widgets: WidgetInventoryEntry[];
}): WidgetRoutePlan {
  const text = normalizeWidgetIntentText(args.userInput);
  const latestWidget = args.widgets[0];
  const mentionsSeparateNewWidget = /\b(new|another|separate|additional)\b/i.test(args.userInput);
  const wantsList = /\b(list|which|what)\b/.test(text) && /\bwidgets?\b/.test(text);
  const wantsInspect = FOLLOW_UP_INSPECT_PATTERN.test(text) || /\bdebug\b/.test(text);
  const wantsRevision =
    FOLLOW_UP_CONFIRM_PATTERN.test(text)
    || FOLLOW_UP_STRONG_WIDGET_ACTION_PATTERN.test(text)
    || FOLLOW_UP_GENERIC_WIDGET_EDIT_PATTERN.test(text);
  const hasRecentWidgetContext = recentHistoryHasWidgetContext(args.history);

  if (wantsList) {
    return {
      route: "widget",
      reason: "Heuristic fallback matched a widget list request.",
      toolArgs: { action: "list" },
    };
  }

  if (latestWidget && wantsInspect && (FOLLOW_UP_REFERENCE_PATTERN.test(text) || hasRecentWidgetContext)) {
    return {
      route: "widget",
      reason: "Heuristic fallback matched widget inspection.",
      toolArgs: {
        action: "get",
        widget_id: latestWidget.id,
      },
    };
  }

  if (latestWidget && !mentionsSeparateNewWidget && (wantsRevision || hasRecentWidgetContext)) {
    return {
      route: "widget",
      reason: "Heuristic fallback matched widget revision.",
      toolArgs: {
        action: "generate",
        widget_id: latestWidget.id,
        prompt: clampPrompt(args.userInput),
      },
    };
  }

  return {
    route: "widget",
    reason: "Heuristic fallback matched widget creation.",
    toolArgs: {
      action: "generate",
      prompt: clampPrompt(args.userInput),
    },
  };
}

export async function planWidgetRoute(args: {
  provider: LLMProvider;
  model?: string;
  attachedDevice: Device;
  history: ChatMessage[];
  userInput: string;
}): Promise<WidgetRoutePlan> {
  if (!shouldPlanWidgetRouteTurn({ history: args.history, userInput: args.userInput })) {
    return {
      route: "none",
      reason: "No explicit widget request in the current turn.",
    };
  }

  const model = await buildLanguageModel(args.provider, args.model);
  const widgets = summarizeWidgets(args.attachedDevice.id);
  const recentWidgetToolEvents = summarizeRecentWidgetToolEvents(args.history);

  try {
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 900,
      system: [
        "You route Steward device-attached chat turns into explicit widget management plans.",
        "Return JSON only. No markdown. No code fences.",
        "Only route to widget management when the user explicitly asks for widget work, or when a short follow-up clearly continues a recent widget conversation.",
        "Widget work includes creating, revising, fixing, restyling, inspecting, listing, or deleting a persistent device widget, remote, dashboard, panel, or control surface for the attached device.",
        "Follow-up pronouns like 'it' or 'that' can still refer to the existing widget when recent conversation/tool activity is about a widget.",
        "If a widget would simply be helpful for the device, return {\"route\":\"none\",\"reason\":\"...\"}.",
        "If the turn is not widget work, return {\"route\":\"none\",\"reason\":\"...\"}.",
        "If the turn is widget work:",
        "- Prefer toolArgs.action='generate' for create or revise requests.",
        "- Use toolArgs.action='get' only for explicit inspection/debug requests.",
        "- Use toolArgs.action='list' only when the user is explicitly asking what widgets exist.",
        "- generate already persists the widget. Never plan a separate save step.",
        "- Never invent widget ids or slugs. Only use values present in the supplied widget inventory.",
        "- If revising an existing widget, prefer the most recently updated relevant widget from inventory.",
        "- If widget inventory already contains a relevant widget, revise or inspect it instead of creating a duplicate unless the user explicitly asks for a new, separate, or additional widget.",
        "- If the user clearly wants a new separate widget, omit widget_id and widget_slug.",
        "- toolArgs.prompt must be a concrete instruction Steward can hand to steward_manage_widget.",
        "- Keep toolArgs.prompt concise: <= 500 characters, plain text, no code fences, and no escaped newlines.",
        "Valid JSON shapes:",
        "{\"route\":\"none\",\"reason\":\"text\"}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"list\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"get\",\"widget_id\":\"...\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"get\",\"widget_slug\":\"...\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"generate\",\"prompt\":\"...\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"generate\",\"widget_id\":\"...\",\"prompt\":\"...\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"generate\",\"widget_slug\":\"...\",\"prompt\":\"...\"}}",
      ].join("\n"),
      prompt: [
        `Attached device: ${args.attachedDevice.name} (${args.attachedDevice.ip}) id=${args.attachedDevice.id} type=${args.attachedDevice.type}`,
        "",
        "Attached device widget inventory (newest first):",
        JSON.stringify(widgets, null, 2),
        "",
        "Recent widget tool activity:",
        JSON.stringify(recentWidgetToolEvents, null, 2),
        "",
        "Recent conversation transcript:",
        summarizeRecentMessages(args.history),
        "",
        `Current user message: ${args.userInput}`,
      ].join("\n"),
    });

    return WidgetRoutePlanSchema.parse(extractFirstJsonObject(result.text));
  } catch {
    return buildFallbackWidgetRoutePlan({
      history: args.history,
      userInput: args.userInput,
      widgets,
    });
  }
}
