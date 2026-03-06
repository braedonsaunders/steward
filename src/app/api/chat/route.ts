import { randomUUID } from "node:crypto";
import { generateText, stepCountIs, streamText } from "ai";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { buildAssistantContext } from "@/lib/assistant/context";
import { tryHandleDeviceChatAction } from "@/lib/assistant/device-actions";
import { tryExecuteGraphQuery } from "@/lib/assistant/graph-query";
import { maybeUpdateOperatorNotes } from "@/lib/assistant/operator-notes";
import { buildStewardSystemPrompt } from "@/lib/assistant/prompt";
import { buildAdapterSkillTools } from "@/lib/assistant/tool-skills";
import { planWidgetRoute, type WidgetRoutePlan } from "@/lib/assistant/widget-routing";
import { buildOnboardingSystemPrompt, isOnboardingSession } from "@/lib/adoption/conversation";
import { getDefaultProvider } from "@/lib/llm/config";
import { buildLanguageModel } from "@/lib/llm/providers";
import { getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import type { ChatMessageMetadata, ChatToolEvent, ChatToolEventKind, LLMProvider } from "@/lib/state/types";

const CHAT_MAX_OUTPUT_TOKENS = 8_000;
const ONBOARDING_MAX_OUTPUT_TOKENS = 12_000;
const CHAT_MAX_STEPS = 16;
const CHAT_MAX_AUTO_CONTINUATIONS = 3;

export const runtime = "nodejs";

const schema = z.object({
  input: z.string().min(1),
  provider: z.string().min(1).optional(),
  model: z.string().optional(),
  sessionId: z.string().optional(),
  stream: z.boolean().optional(),
  suppressUserMessage: z.boolean().optional(),
});

function toFriendlyChatError(rawMessage: string, provider: LLMProvider): string {
  if (
    provider === "openai" &&
    /missing scopes|insufficient permissions/i.test(rawMessage)
  ) {
    return "OpenAI authentication issue. Try disconnecting and reconnecting via OAuth in Settings, or add a Platform API key directly.";
  }
  return rawMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStreamClosureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /controller is already closed|stream is not in a writable state|invalid state/i.test(message);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error) {
    return error.name === "AbortError" || /aborted|aborterror/i.test(error.message);
  }

  return false;
}

function clampText(value: string, maxChars = 1200): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function humanizeToolName(toolName: string): string {
  return toolName
    .replace(/^steward[_-]/, "")
    .replace(/^skill[_-]/, "")
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function buildAttachedDeviceWidgetPrompt(deviceId: string): string {
  const widgets = stateStore.getDeviceWidgets(deviceId).slice(0, 8);
  if (widgets.length === 0) {
    return "Attached device widgets:\n- none";
  }

  const lines = widgets.map(
    (widget) =>
      `- id=${widget.id} slug=${widget.slug} name=${widget.name} revision=${widget.revision} updatedAt=${widget.updatedAt}`,
  );
  const latest = widgets[0];

  return [
    "Attached device widgets (newest first):",
    ...lines,
    `Default revision target: id=${latest.id} slug=${latest.slug} name=${latest.name}`,
  ].join("\n");
}

function buildWidgetToolDirective(plan: WidgetRoutePlan | null, attachedDeviceId: string | undefined): string {
  if (!plan || plan.route !== "widget" || !attachedDeviceId) {
    return "";
  }

  const toolArgs = {
    ...plan.toolArgs,
    device_id: attachedDeviceId,
  };

  return [
    "Widget tool execution is required for this turn.",
    "On the first step, call steward_manage_widget with the exact JSON below before any prose.",
    "After the tool result, summarize only what actually happened.",
    "If the tool creates a new widget when a revision was expected, say that explicitly.",
    "Forced tool call JSON:",
    JSON.stringify(toolArgs, null, 2),
  ].join("\n");
}

function previewValue(value: unknown, maxChars = 900): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? clampText(trimmed, maxChars) : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value) || isRecord(value)) {
    try {
      const json = JSON.stringify(value, null, 2);
      return json ? clampText(json, maxChars) : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function inferToolKind(toolName: string, inputPreview?: string, outputPreview?: string): ChatToolEventKind {
  const combined = `${toolName}\n${inputPreview ?? ""}\n${outputPreview ?? ""}`.toLowerCase();
  if (/shell|terminal|nmap|curl|ssh|shasum|ping|traceroute/.test(combined)) {
    return "terminal";
  }
  if (/probe|fingerprint|router|http|favicon|browser|packet/.test(combined)) {
    return "probe";
  }
  return "tool";
}

function summarizeToolExecution(output: unknown): {
  status: ChatToolEvent["status"];
  summary: string;
  outputPreview?: string;
} {
  if (isRecord(output)) {
    const widgetRecord = isRecord(output.widget) ? output.widget : null;
    const widgetName = widgetRecord && typeof widgetRecord.name === "string"
      ? widgetRecord.name.trim()
      : "";
    if (widgetName) {
      let summary = `Saved widget ${widgetName}`;
      if (typeof output.updatedExisting === "boolean") {
        summary = `${output.updatedExisting ? "Updated" : "Created"} widget ${widgetName}`;
      } else if (isRecord(output.runtimeState) || Array.isArray(output.recentOperationRuns)) {
        summary = `Loaded widget ${widgetName}`;
      }

      return {
        status: "completed",
        summary,
        outputPreview: previewValue(output, 1200),
      };
    }

    if (Array.isArray(output.widgets)) {
      return {
        status: "completed",
        summary: `Listed ${output.widgets.length} widget${output.widgets.length === 1 ? "" : "s"}.`,
        outputPreview: previewValue(output, 1200),
      };
    }

    if (typeof output.deletedWidgetId === "string") {
      const deletedName = typeof output.deletedWidgetSlug === "string" && output.deletedWidgetSlug.trim().length > 0
        ? output.deletedWidgetSlug.trim()
        : output.deletedWidgetId;
      return {
        status: output.ok === false ? "failed" : "completed",
        summary: `${output.ok === false ? "Failed to delete" : "Deleted"} widget ${deletedName}`,
        outputPreview: previewValue(output, 1200),
      };
    }

    const errorText = typeof output.error === "string" ? output.error.trim() : "";
    if (errorText) {
      return {
        status: "failed",
        summary: errorText,
        outputPreview: previewValue(output.output ?? output, 1200),
      };
    }

    const explicitOk = typeof output.ok === "boolean" ? output.ok : undefined;
    const preview = previewValue(
      typeof output.output === "string" || isRecord(output.output) || Array.isArray(output.output)
        ? output.output
        : output.summary ?? output,
      1200,
    );

    if (explicitOk === false) {
      return {
        status: "failed",
        summary: typeof output.reason === "string" && output.reason.trim().length > 0
          ? output.reason.trim()
          : "Tool execution failed.",
        outputPreview: preview,
      };
    }

    const summaryParts: string[] = [];
    if (typeof output.deviceName === "string" && output.deviceName.trim().length > 0) {
      summaryParts.push(output.deviceName.trim());
    }
    if (typeof output.observations === "number") {
      summaryParts.push(`${output.observations} observation${output.observations === 1 ? "" : "s"}`);
    }
    if (Array.isArray(output.services) && output.services.length > 0) {
      summaryParts.push(`${output.services.length} service${output.services.length === 1 ? "" : "s"}`);
    }

    return {
      status: "completed",
      summary: summaryParts.join(" • ") || "Tool completed.",
      outputPreview: preview,
    };
  }

  if (typeof output === "string" && output.trim().length > 0) {
    return {
      status: "completed",
      summary: "Tool completed.",
      outputPreview: clampText(output.trim(), 1200),
    };
  }

  return {
    status: "completed",
    summary: "Tool completed.",
  };
}

function upsertToolEvent(
  toolEvents: ChatToolEvent[],
  toolEventIndex: Map<string, number>,
  patch: ChatToolEvent,
): ChatToolEvent {
  const existingIndex = toolEventIndex.get(patch.id);
  if (existingIndex === undefined) {
    toolEventIndex.set(patch.id, toolEvents.length);
    toolEvents.push(patch);
    return patch;
  }

  const merged = {
    ...toolEvents[existingIndex],
    ...patch,
    anchorOffset: patch.anchorOffset ?? toolEvents[existingIndex].anchorOffset,
  };
  toolEvents[existingIndex] = merged;
  return merged;
}

function buildToolOnlyFallback(toolEvents: ChatToolEvent[]): string {
  const lines = toolEvents.map((event) => {
    const status = event.status === "failed" ? "failed" : event.status === "running" ? "running" : "completed";
    const summary = event.error ?? event.summary ?? "No summary returned.";
    return `- ${event.label}: ${status}. ${summary}`;
  });

  return [
    "The tool run finished, but the model did not return a final narrative summary.",
    "",
    ...lines,
  ].join("\n");
}

function ndjsonStreamFromEvents(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch (error) {
          if (!isStreamClosureError(error)) {
            throw error;
          }
          return;
        }
      }
      try {
        controller.close();
      } catch (error) {
        if (!isStreamClosureError(error)) {
          throw error;
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function validateAttachedDeviceChatReadiness(deviceId: string): { ok: true } | { ok: false; reason: string } {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    return { ok: false, reason: "Attached device no longer exists. Pick a valid device and retry." };
  }

  const adoptionStatus = getDeviceAdoptionStatus(device);
  if (adoptionStatus !== "adopted") {
    return { ok: false, reason: `Adopt ${device.name} before using device-attached chat actions.` };
  }

  const run = stateStore.getLatestAdoptionRun(device.id);
  if (!run || run.status !== "completed") {
    return {
      ok: false,
      reason: `Finish onboarding for ${device.name} first so Steward has workload context, assurance intent, and access surfaces.`,
    };
  }

  const unresolvedRequired = stateStore
    .getAdoptionQuestions(device.id, { runId: run.id, unresolvedOnly: true })
    .filter((question) => question.required)
    .length;
  if (unresolvedRequired > 0) {
    return {
      ok: false,
      reason: `Onboarding for ${device.name} still has ${unresolvedRequired} required question(s) pending.`,
    };
  }

  return { ok: true };
}

async function autoContinueIfTruncated(args: {
  model: Awaited<ReturnType<typeof buildLanguageModel>>;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: Awaited<ReturnType<typeof buildAdapterSkillTools>>;
  maxOutputTokens: number;
  initialText: string;
  initialFinishReason: unknown;
  abortSignal?: AbortSignal;
}): Promise<{ text: string; truncated: boolean }> {
  let text = args.initialText;
  let finishReason = args.initialFinishReason;

  for (let i = 0; i < CHAT_MAX_AUTO_CONTINUATIONS; i++) {
    if (finishReason !== "length") {
      return { text, truncated: false };
    }

    const continuation = await generateText({
      model: args.model,
      system: args.systemPrompt,
      messages: [
        ...args.messages,
        { role: "assistant", content: text },
        {
          role: "user",
          content: "Continue exactly where you left off. Do not repeat prior content. Return only the continuation.",
        },
      ],
      tools: args.tools,
      stopWhen: stepCountIs(CHAT_MAX_STEPS),
      temperature: 0.2,
      maxOutputTokens: args.maxOutputTokens,
      abortSignal: args.abortSignal,
    });

    const chunk = continuation.text.trim();
    if (chunk.length === 0) {
      return { text, truncated: true };
    }
    text += `\n${chunk}`;
    finishReason = await Promise.resolve((continuation as { finishReason?: unknown }).finishReason);
  }

  return { text, truncated: finishReason === "length" };
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = schema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const provider = (payload.data.provider ?? (await getDefaultProvider())) as LLMProvider;
  const sessionId = payload.data.sessionId;
  const session = sessionId ? stateStore.getChatSessionById(sessionId) : null;
  const attachedDevice = session?.deviceId ? stateStore.getDeviceById(session.deviceId) : null;
  const onboardingSession = isOnboardingSession(session);

  if (session?.deviceId && !onboardingSession) {
    const readiness = validateAttachedDeviceChatReadiness(session.deviceId);
    if (!readiness.ok) {
      if (payload.data.stream) {
        return ndjsonStreamFromEvents([
          { type: "start", provider },
          { type: "error", error: readiness.reason, provider },
        ]);
      }
      return NextResponse.json({ error: readiness.reason }, { status: 409 });
    }
  }

  // Persist the user message if we have a session
  if (sessionId && !payload.data.suppressUserMessage) {
    stateStore.addChatMessage({
      id: randomUUID(),
      sessionId,
      role: "user",
      content: payload.data.input,
      error: false,
      createdAt: new Date().toISOString(),
    });
  }

  try {
    const graphQuery = onboardingSession
      ? { handled: false as const, response: "" }
      : await tryExecuteGraphQuery(payload.data.input, attachedDevice);
    if (graphQuery.handled && graphQuery.response) {
      if (sessionId) {
        stateStore.addChatMessage({
          id: randomUUID(),
          sessionId,
          role: "assistant",
          content: graphQuery.response,
          provider: "custom",
          error: false,
          createdAt: new Date().toISOString(),
        });
      }

      await stateStore.addAction({
        actor: "user",
        kind: "diagnose",
        message: "Graph query handled deterministically",
        context: {
          sessionId,
          ...graphQuery.metadata,
        },
      });

      if (attachedDevice) {
        await maybeUpdateOperatorNotes({
          device: attachedDevice,
          provider,
          model: payload.data.model,
          userInput: payload.data.input,
          assistantOutput: graphQuery.response,
          sessionId,
          onboarding: onboardingSession,
          toolEvents: undefined,
        });
      }

      if (payload.data.stream) {
        return ndjsonStreamFromEvents([
          { type: "start", provider: "graph" },
          { type: "finish", provider: "graph", text: graphQuery.response, reasoning: "" },
        ]);
      }

      return NextResponse.json({
        provider: "graph",
        response: graphQuery.response,
      });
    }

    const deviceAction = await tryHandleDeviceChatAction({
      input: payload.data.input,
      provider,
      model: payload.data.model,
      attachedDevice,
      sessionId: sessionId ?? undefined,
    });
    if (deviceAction.handled && deviceAction.response) {
      if (sessionId) {
        stateStore.addChatMessage({
          id: randomUUID(),
          sessionId,
          role: "assistant",
          content: deviceAction.response,
          provider: "custom",
          error: false,
          createdAt: new Date().toISOString(),
        });
      }

      if (attachedDevice) {
        await maybeUpdateOperatorNotes({
          device: attachedDevice,
          provider,
          model: payload.data.model,
          userInput: payload.data.input,
          assistantOutput: deviceAction.response,
          sessionId,
          onboarding: onboardingSession,
          toolEvents: undefined,
        });
      }

      if (payload.data.stream) {
        return ndjsonStreamFromEvents([
          { type: "start", provider: "steward-action" },
          { type: "finish", provider: "steward-action", text: deviceAction.response, reasoning: "" },
        ]);
      }

      return NextResponse.json({
        provider: "steward-action",
        response: deviceAction.response,
        metadata: deviceAction.metadata ?? {},
      });
    }

    const persistedHistory = sessionId ? stateStore.getChatMessages(sessionId) : [];
    const historyExcludingCurrent = sessionId && !payload.data.suppressUserMessage
      ? persistedHistory.slice(0, -1)
      : persistedHistory;

    const context = await buildAssistantContext();
    const model = await buildLanguageModel(provider, payload.data.model);
    const operatorNotes = attachedDevice
      && typeof attachedDevice.metadata.notes === "object"
      && attachedDevice.metadata.notes !== null
      && typeof (attachedDevice.metadata.notes as Record<string, unknown>).operatorContext === "string"
      ? String((attachedDevice.metadata.notes as Record<string, unknown>).operatorContext)
      : "";
    const structuredMemory = attachedDevice
      && typeof attachedDevice.metadata.notes === "object"
      && attachedDevice.metadata.notes !== null
      && typeof (attachedDevice.metadata.notes as Record<string, unknown>).structuredContext === "object"
      && (attachedDevice.metadata.notes as Record<string, unknown>).structuredContext !== null
      ? JSON.stringify((attachedDevice.metadata.notes as Record<string, unknown>).structuredContext)
      : "";
    const attachedDeviceWidgetPrompt = attachedDevice
      ? buildAttachedDeviceWidgetPrompt(attachedDevice.id)
      : "";
    const widgetRoutePlan = attachedDevice && !onboardingSession
      ? await planWidgetRoute({
        provider,
        model: payload.data.model,
        attachedDevice,
        history: historyExcludingCurrent,
        userInput: payload.data.input,
      })
      : null;
    const widgetToolDirective = buildWidgetToolDirective(widgetRoutePlan, attachedDevice?.id);
    const systemPrompt = onboardingSession && attachedDevice
      ? buildOnboardingSystemPrompt(attachedDevice)
      : attachedDevice
        ? `${buildStewardSystemPrompt(context)}\n\nAttached conversation device:\n- ${attachedDevice.name} (${attachedDevice.ip}) id=${attachedDevice.id} type=${attachedDevice.type} status=${attachedDevice.status}${operatorNotes.trim().length > 0 ? `\n- Operator notes: ${operatorNotes}` : ""}${structuredMemory.trim().length > 0 ? `\n- Structured memory: ${structuredMemory}` : ""}\n${attachedDeviceWidgetPrompt}${widgetToolDirective.trim().length > 0 ? `\n\n${widgetToolDirective}` : ""}\nPrioritize this device when the user's question is ambiguous.`
        : buildStewardSystemPrompt(context);

    // Build conversation history from DB for multi-turn context
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (historyExcludingCurrent.length > 0) {
      const relevant = historyExcludingCurrent.slice(-20);
      for (const msg of relevant) {
        if (!msg.error && msg.content.trim().length > 0) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }
    // Add the current user message
    messages.push({ role: "user", content: payload.data.input });

    const tools = await buildAdapterSkillTools({
      attachedDeviceId: attachedDevice?.id,
      allowPreOnboardingExecution: onboardingSession,
      provider,
      model: payload.data.model,
    });
    const maxOutputTokens = onboardingSession
      ? ONBOARDING_MAX_OUTPUT_TOKENS
      : CHAT_MAX_OUTPUT_TOKENS;
    const widgetPrepareStep = widgetRoutePlan?.route === "widget"
      ? ({ stepNumber }: { stepNumber: number }) => {
        if (stepNumber === 1) {
          return {
            system: systemPrompt,
            activeTools: ["steward_manage_widget"],
            toolChoice: { type: "tool" as const, toolName: "steward_manage_widget" },
          };
        }
        return { system: systemPrompt };
      }
      : undefined;

    if (payload.data.stream) {
      const encoder = new TextEncoder();
      let assistantText = "";
      let reasoningText = "";
      let interrupted = request.signal.aborted;
      const toolEvents: ChatToolEvent[] = [];
      const toolEventIndex = new Map<string, number>();
      const currentToolEvent = (id: string): ChatToolEvent | undefined => {
        const index = toolEventIndex.get(id);
        return index === undefined ? undefined : toolEvents[index];
      };

      const result = streamText({
        model,
        system: systemPrompt,
        messages,
        tools,
        prepareStep: widgetPrepareStep,
        stopWhen: stepCountIs(CHAT_MAX_STEPS),
        temperature: 0.2,
        maxOutputTokens,
        abortSignal: request.signal,
        onAbort() {
          interrupted = true;
        },
      });

      let streamClosed = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {

          const send = (event: Record<string, unknown>) => {
            if (streamClosed) {
              return;
            }

            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch (error) {
              if (isStreamClosureError(error)) {
                streamClosed = true;
                return;
              }
              throw error;
            }
          };

          const close = () => {
            if (streamClosed) {
              return;
            }

            streamClosed = true;
            try {
              controller.close();
            } catch (error) {
              if (!isStreamClosureError(error)) {
                throw error;
              }
            }
          };

          const appendAssistantText = (text: string) => {
            if (text.length === 0) {
              return;
            }
            assistantText += text;
            send({ type: "text-delta", text });
          };

          const emitToolEvent = (event: ChatToolEvent) => {
            send({ type: "tool-event", event });
          };

          send({ type: "start", provider });

          try {
            for await (const part of result.fullStream) {
              if (part.type === "text-start") {
                if (assistantText.trim().length > 0 && !assistantText.endsWith("\n")) {
                  appendAssistantText(assistantText.endsWith("\n") ? "\n" : "\n\n");
                }
              } else if (part.type === "text-delta") {
                appendAssistantText(part.text);
              } else if (part.type === "reasoning-delta") {
                reasoningText += part.text;
                send({ type: "reasoning-delta", text: part.text });
              } else if (part.type === "tool-input-start") {
                const current = currentToolEvent(part.id);
                const label = current?.label
                  ?? (typeof part.title === "string" && part.title.trim().length > 0
                    ? part.title.trim()
                    : humanizeToolName(part.toolName));
                const event = upsertToolEvent(toolEvents, toolEventIndex, {
                  id: part.id,
                  toolName: current?.toolName ?? part.toolName,
                  label,
                  kind: current?.kind ?? inferToolKind(part.toolName),
                  status: current?.status ?? "running",
                  startedAt: current?.startedAt ?? new Date().toISOString(),
                  anchorOffset: current?.anchorOffset ?? assistantText.length,
                  summary: "Running live...",
                });
                emitToolEvent(event);
              } else if (part.type === "tool-input-delta") {
                const current = currentToolEvent(part.id);
                const inputPreview = clampText(`${current?.inputPreview ?? ""}${part.delta}`, 700);
                const event = upsertToolEvent(toolEvents, toolEventIndex, {
                  id: part.id,
                  toolName: current?.toolName ?? "tool",
                  label: current?.label ?? "Tool",
                  kind: current?.kind ?? "tool",
                  status: current?.status ?? "running",
                  startedAt: current?.startedAt ?? new Date().toISOString(),
                  anchorOffset: current?.anchorOffset ?? assistantText.length,
                  inputPreview,
                  summary: current?.summary ?? "Preparing tool input...",
                });
                emitToolEvent(event);
              } else if (part.type === "tool-call") {
                const inputPreview = previewValue(part.input, 700);
                const current = currentToolEvent(part.toolCallId);
                const label = current?.label
                  ?? (typeof part.title === "string" && part.title.trim().length > 0
                    ? part.title.trim()
                    : humanizeToolName(part.toolName));
                const event = upsertToolEvent(toolEvents, toolEventIndex, {
                  id: part.toolCallId,
                  toolName: part.toolName,
                  label,
                  kind: current?.kind ?? inferToolKind(part.toolName, inputPreview),
                  status: current?.status ?? "running",
                  startedAt: current?.startedAt ?? new Date().toISOString(),
                  anchorOffset: current?.anchorOffset ?? assistantText.length,
                  inputPreview,
                  summary: "Tool input ready.",
                });
                emitToolEvent(event);
                const line = `[tool] ${part.toolName} called\n`;
                reasoningText += line;
                send({ type: "reasoning-delta", text: line });
              } else if (part.type === "tool-result") {
                const execution = summarizeToolExecution(part.output);
                const inputPreview = previewValue(part.input, 700);
                const current = currentToolEvent(part.toolCallId);
                const label = current?.label
                  ?? (typeof part.title === "string" && part.title.trim().length > 0
                    ? part.title.trim()
                    : humanizeToolName(part.toolName));
                const event = upsertToolEvent(toolEvents, toolEventIndex, {
                  id: part.toolCallId,
                  toolName: part.toolName,
                  label,
                  kind: current?.kind ?? inferToolKind(part.toolName, inputPreview, execution.outputPreview),
                  status: execution.status,
                  startedAt: current?.startedAt ?? new Date().toISOString(),
                  finishedAt: new Date().toISOString(),
                  anchorOffset: current?.anchorOffset ?? assistantText.length,
                  inputPreview: current?.inputPreview ?? inputPreview,
                  summary: execution.summary,
                  outputPreview: execution.outputPreview,
                  error: execution.status === "failed" ? execution.summary : undefined,
                });
                emitToolEvent(event);
                const summary = execution.summary;
                const line = `[tool] ${part.toolName}: ${summary}\n`;
                reasoningText += line;
                send({ type: "reasoning-delta", text: line });
              } else if (part.type === "tool-error") {
                const errorMessage = clampText(
                  part.error instanceof Error ? part.error.message : String(part.error),
                  700,
                );
                const inputPreview = previewValue(part.input, 700);
                const current = currentToolEvent(part.toolCallId);
                const label = current?.label
                  ?? (typeof part.title === "string" && part.title.trim().length > 0
                    ? part.title.trim()
                    : humanizeToolName(part.toolName));
                const event = upsertToolEvent(toolEvents, toolEventIndex, {
                  id: part.toolCallId,
                  toolName: part.toolName,
                  label,
                  kind: current?.kind ?? inferToolKind(part.toolName, inputPreview, errorMessage),
                  status: "failed",
                  startedAt: current?.startedAt ?? new Date().toISOString(),
                  finishedAt: new Date().toISOString(),
                  anchorOffset: current?.anchorOffset ?? assistantText.length,
                  inputPreview: current?.inputPreview ?? inputPreview,
                  summary: errorMessage,
                  error: errorMessage,
                });
                emitToolEvent(event);
                const line = `[tool] ${part.toolName} failed: ${errorMessage}\n`;
                reasoningText += line;
                send({ type: "reasoning-delta", text: line });
              }
            }

            if (assistantText.trim().length === 0) {
              if (toolEvents.length === 0) {
                throw new Error("No output generated. Check the stream for errors.");
              }
              assistantText = buildToolOnlyFallback(toolEvents);
              send({ type: "text-delta", text: assistantText });
            }

            const finishReasonValue = await Promise.resolve(
              (result as { finishReason?: unknown }).finishReason,
            );

            const autoContinued = await autoContinueIfTruncated({
              model,
              systemPrompt,
              messages,
              tools,
              maxOutputTokens,
              initialText: assistantText,
              initialFinishReason: finishReasonValue,
              abortSignal: request.signal,
            });
            if (autoContinued.text !== assistantText) {
              const extra = autoContinued.text.slice(assistantText.length);
              if (extra.trim().length > 0) {
                send({ type: "text-delta", text: extra });
              }
              assistantText = autoContinued.text;
            }
            if (autoContinued.truncated) {
              const continuationHint = "\n\n_Output truncated by response length. Ask 'continue' and I will pick up exactly where I left off._";
              assistantText += continuationHint;
              send({ type: "text-delta", text: continuationHint });
            }

            if (interrupted || request.signal.aborted) {
              return;
            }

            if (sessionId) {
              const metadata: ChatMessageMetadata | undefined = toolEvents.length > 0
                ? { toolEvents }
                : undefined;
              stateStore.addChatMessage({
                id: randomUUID(),
                sessionId,
                role: "assistant",
                content: assistantText,
                provider,
                error: false,
                createdAt: new Date().toISOString(),
                metadata,
              });
            }

            const usage = await result.usage;

            await stateStore.addAction({
              actor: "user",
              kind: "diagnose",
              message: `Conversational query handled by ${provider}`,
              context: {
                provider,
                model: payload.data.model,
                sessionId,
              },
            });

            if (attachedDevice) {
              await maybeUpdateOperatorNotes({
                device: attachedDevice,
                provider,
                model: payload.data.model,
                userInput: payload.data.input,
                assistantOutput: assistantText,
                sessionId,
                onboarding: onboardingSession,
                toolEvents,
              });
            }

            send({
              type: "finish",
              provider,
              text: assistantText,
              reasoning: reasoningText,
              metadata: toolEvents.length > 0 ? { toolEvents } : undefined,
              usage,
            });
          } catch (error) {
            if (interrupted || request.signal.aborted || isAbortError(error)) {
              const interruptedText = assistantText.trim().length > 0
                ? assistantText
                : toolEvents.length > 0
                  ? buildToolOnlyFallback(toolEvents)
                  : "";

              if (sessionId && interruptedText.trim().length > 0) {
                const metadata: ChatMessageMetadata = toolEvents.length > 0
                  ? { toolEvents, interrupted: true }
                  : { interrupted: true };
                stateStore.addChatMessage({
                  id: randomUUID(),
                  sessionId,
                  role: "assistant",
                  content: interruptedText,
                  provider,
                  error: false,
                  createdAt: new Date().toISOString(),
                  metadata,
                });
              }

              return;
            }

            const rawMessage = error instanceof Error ? error.message : String(error);
            const friendlyMessage = toFriendlyChatError(rawMessage, provider);

            if (sessionId) {
              const metadata: ChatMessageMetadata | undefined = toolEvents.length > 0
                ? { toolEvents, interrupted: false }
                : undefined;
              stateStore.addChatMessage({
                id: randomUUID(),
                sessionId,
                role: "assistant",
                content: friendlyMessage,
                provider,
                error: true,
                createdAt: new Date().toISOString(),
                metadata,
              });
            }

            send({ type: "error", error: friendlyMessage, provider });
          } finally {
            close();
          }
        },
        cancel() {
          // The response stream was closed; request.signal drives actual model
          // cancellation and the catch path handles interrupted persistence.
          streamClosed = true;
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      });
    }

    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      tools,
      prepareStep: widgetPrepareStep,
      stopWhen: stepCountIs(CHAT_MAX_STEPS),
      temperature: 0.2,
      maxOutputTokens,
      abortSignal: request.signal,
    });

    const nonStreamFinishReason = await Promise.resolve(
      (result as { finishReason?: unknown }).finishReason,
    );

    const autoContinued = await autoContinueIfTruncated({
      model,
      systemPrompt,
      messages,
      tools,
      maxOutputTokens,
      initialText: result.text,
      initialFinishReason: nonStreamFinishReason,
      abortSignal: request.signal,
    });

    if (request.signal.aborted) {
      return new Response(null, { status: 204 });
    }

    const finalText = autoContinued.truncated
      ? `${autoContinued.text}\n\n_Output truncated by response length. Ask 'continue' and I will pick up exactly where I left off._`
      : autoContinued.text;

    if (finalText.trim().length === 0) {
      throw new Error("No output generated. Check the stream for errors.");
    }

    // Persist the assistant response
    if (sessionId) {
      stateStore.addChatMessage({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: finalText,
        provider,
        error: false,
        createdAt: new Date().toISOString(),
      });
    }

    await stateStore.addAction({
      actor: "user",
      kind: "diagnose",
      message: `Conversational query handled by ${provider}`,
      context: {
        provider,
        model: payload.data.model,
        sessionId,
      },
    });

    if (attachedDevice) {
      await maybeUpdateOperatorNotes({
        device: attachedDevice,
        provider,
        model: payload.data.model,
        userInput: payload.data.input,
        assistantOutput: finalText,
        sessionId,
        onboarding: onboardingSession,
        toolEvents: undefined,
      });
    }

    return NextResponse.json({
      provider,
      response: finalText,
      usage: result.usage,
    });
  } catch (error) {
    if (request.signal.aborted || isAbortError(error)) {
      return new Response(null, { status: 204 });
    }

    const rawMessage = error instanceof Error ? error.message : String(error);
    const friendlyMessage = toFriendlyChatError(rawMessage, provider);

    // Persist the friendly error message to the session
    if (sessionId) {
      stateStore.addChatMessage({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: friendlyMessage,
        provider,
        error: true,
        createdAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({ error: friendlyMessage }, { status: 500 });
  }
}
