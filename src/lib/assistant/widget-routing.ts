import { generateObject } from "ai";
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

export async function planWidgetRoute(args: {
  provider: LLMProvider;
  model?: string;
  attachedDevice: Device;
  history: ChatMessage[];
  userInput: string;
}): Promise<WidgetRoutePlan> {
  const model = await buildLanguageModel(args.provider, args.model);
  const widgets = summarizeWidgets(args.attachedDevice.id);
  const recentWidgetToolEvents = summarizeRecentWidgetToolEvents(args.history);

  try {
    const result = await generateObject({
      model,
      temperature: 0,
      maxOutputTokens: 900,
      schema: WidgetRoutePlanSchema,
      schemaName: "widget_route_plan",
      schemaDescription: "Model-routed widget management plan for an attached-device Steward chat turn.",
      prompt: [
        "You route Steward device-attached chat turns into explicit widget management plans.",
        "Return JSON only. No markdown. No code fences.",
        "Decide based on the conversation and current message, not pattern matching shortcuts.",
        "Only route to widget management when the user explicitly asks for widget work, or when a short follow-up clearly continues a recent widget conversation.",
        "Widget work includes creating, revising, fixing, restyling, inspecting, listing, or deleting a persistent device widget, remote, dashboard, panel, or control surface for the attached device.",
        "A device's web UI, login page, admin console, browser session, or vendor management interface is not a Steward widget.",
        "Requests to log into, explore, or learn a device's web UI must return {\"route\":\"none\",\"reason\":\"...\"}.",
        "If the turn is not widget work, return {\"route\":\"none\",\"reason\":\"...\"}.",
        "If the turn is widget work:",
        "- Prefer toolArgs.action='generate' for create or revise requests.",
        "- Use toolArgs.action='get' only for explicit inspection or debug requests.",
        "- Use toolArgs.action='list' only when the user is explicitly asking what widgets exist.",
        "- generate already persists the widget. Never plan a separate save step.",
        "- Never invent widget ids or slugs. Only use values present in the supplied widget inventory.",
        "- If revising an existing widget, prefer the most recently updated relevant widget from inventory.",
        "- If widget inventory already contains a relevant widget, revise or inspect it instead of creating a duplicate unless the user explicitly asks for a new, separate, or additional widget.",
        "- If the user clearly wants a new separate widget, omit widget_id and widget_slug.",
        "- toolArgs.prompt must be a concrete instruction Steward can hand to steward_manage_widget.",
        "",
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
        "",
        "Valid JSON shapes:",
        "{\"route\":\"none\",\"reason\":\"text\"}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"list\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"get\",\"widget_id\":\"...\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"get\",\"widget_slug\":\"...\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"generate\",\"prompt\":\"...\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"generate\",\"widget_id\":\"...\",\"prompt\":\"...\"}}",
        "{\"route\":\"widget\",\"reason\":\"text\",\"toolArgs\":{\"action\":\"generate\",\"widget_slug\":\"...\",\"prompt\":\"...\"}}",
      ].join("\n"),
    });

    return result.object;
  } catch {
    return {
      route: "none",
      reason: "Widget route planning failed.",
    };
  }
}
