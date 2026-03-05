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
import { buildOnboardingSystemPrompt, isOnboardingSession } from "@/lib/adoption/conversation";
import { getDefaultProvider } from "@/lib/llm/config";
import { buildLanguageModel } from "@/lib/llm/providers";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import type { LLMProvider } from "@/lib/state/types";

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

function ndjsonStreamFromEvents(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
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
      reason: `Finish onboarding for ${device.name} first so Steward has profile context and credentials.`,
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

  const adoption = getAdoptionRecord(device);
  const requiredProtocols = Array.isArray(adoption.requiredCredentials)
    ? adoption.requiredCredentials
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase())
    : [];

  if (requiredProtocols.length > 0) {
    const provided = new Set(
      stateStore.getValidatedCredentialProtocols(device.id).map((value) => value.trim().toLowerCase()),
    );
    const missing = Array.from(new Set(requiredProtocols)).filter((protocol) => !provided.has(protocol));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Chat actions for ${device.name} are blocked until credentials are added for: ${missing.join(", ")}.`,
      };
    }
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
  if (sessionId) {
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

    const deviceAction = onboardingSession
      ? { handled: false as const, response: "", metadata: {} }
      : await tryHandleDeviceChatAction({
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
    const systemPrompt = onboardingSession && attachedDevice
      ? buildOnboardingSystemPrompt(attachedDevice)
      : attachedDevice
        ? `${buildStewardSystemPrompt(context)}\n\nAttached conversation device:\n- ${attachedDevice.name} (${attachedDevice.ip}) id=${attachedDevice.id} type=${attachedDevice.type} status=${attachedDevice.status}${operatorNotes.trim().length > 0 ? `\n- Operator notes: ${operatorNotes}` : ""}${structuredMemory.trim().length > 0 ? `\n- Structured memory: ${structuredMemory}` : ""}\nPrioritize this device when the user's question is ambiguous.`
        : buildStewardSystemPrompt(context);

    // Build conversation history from DB for multi-turn context
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (sessionId) {
      const history = stateStore.getChatMessages(sessionId);
      // Include up to last 20 messages for context (excluding the one we just added)
      const relevant = history.slice(-21, -1);
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
    });
    const maxOutputTokens = onboardingSession
      ? ONBOARDING_MAX_OUTPUT_TOKENS
      : CHAT_MAX_OUTPUT_TOKENS;

    if (payload.data.stream) {
      const encoder = new TextEncoder();
      let assistantText = "";
      let reasoningText = "";

      const result = streamText({
        model,
        system: systemPrompt,
        messages,
        tools,
        stopWhen: stepCountIs(CHAT_MAX_STEPS),
        temperature: 0.2,
        maxOutputTokens,
      });

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };

          send({ type: "start", provider });

          try {
            for await (const part of result.fullStream) {
              if (part.type === "text-delta") {
                assistantText += part.text;
                send({ type: "text-delta", text: part.text });
              } else if (part.type === "reasoning-delta") {
                reasoningText += part.text;
                send({ type: "reasoning-delta", text: part.text });
              } else if (part.type === "tool-call") {
                const line = `[tool] ${part.toolName} called\n`;
                reasoningText += line;
                send({ type: "reasoning-delta", text: line });
              } else if (part.type === "tool-result") {
                const summary = isRecord(part.output)
                  ? String(part.output.error ?? part.output.output ?? "tool execution completed")
                  : "tool execution completed";
                const line = `[tool] ${part.toolName}: ${summary}\n`;
                reasoningText += line;
                send({ type: "reasoning-delta", text: line });
              } else if (part.type === "tool-error") {
                const line = `[tool] ${part.toolName} failed: ${String(part.error)}\n`;
                reasoningText += line;
                send({ type: "reasoning-delta", text: line });
              } else if (part.type === "tool-input-start") {
                const line = `[tool] running ${part.toolName}...\n`;
                reasoningText += line;
                send({ type: "reasoning-delta", text: line });
              }
            }

            if (assistantText.trim().length === 0) {
              throw new Error("No output generated. Check the stream for errors.");
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

            if (sessionId) {
              stateStore.addChatMessage({
                id: randomUUID(),
                sessionId,
                role: "assistant",
                content: assistantText,
                provider,
                error: false,
                createdAt: new Date().toISOString(),
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
              });
            }

            send({
              type: "finish",
              provider,
              text: assistantText,
              reasoning: reasoningText,
              usage,
            });
          } catch (error) {
            const rawMessage = error instanceof Error ? error.message : String(error);
            const friendlyMessage = toFriendlyChatError(rawMessage, provider);

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

            send({ type: "error", error: friendlyMessage, provider });
          } finally {
            controller.close();
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

    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(CHAT_MAX_STEPS),
      temperature: 0.2,
      maxOutputTokens,
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
    });

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
      });
    }

    return NextResponse.json({
      provider,
      response: finalText,
      usage: result.usage,
    });
  } catch (error) {
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
