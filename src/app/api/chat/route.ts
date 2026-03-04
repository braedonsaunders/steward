import { randomUUID } from "node:crypto";
import { generateText, streamText } from "ai";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { buildAssistantContext } from "@/lib/assistant/context";
import { buildStewardSystemPrompt } from "@/lib/assistant/prompt";
import { getDefaultProvider } from "@/lib/llm/config";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import type { LLMProvider } from "@/lib/state/types";

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
    const context = await buildAssistantContext();
    const model = await buildLanguageModel(provider, payload.data.model);
    const systemPrompt = attachedDevice
      ? `${buildStewardSystemPrompt(context)}\n\nAttached conversation device:\n- ${attachedDevice.name} (${attachedDevice.ip}) id=${attachedDevice.id} type=${attachedDevice.type} status=${attachedDevice.status}\nPrioritize this device when the user's question is ambiguous.`
      : buildStewardSystemPrompt(context);

    // Build conversation history from DB for multi-turn context
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (sessionId) {
      const history = stateStore.getChatMessages(sessionId);
      // Include up to last 20 messages for context (excluding the one we just added)
      const relevant = history.slice(-21, -1);
      for (const msg of relevant) {
        if (!msg.error) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }
    // Add the current user message
    messages.push({ role: "user", content: payload.data.input });

    if (payload.data.stream) {
      const encoder = new TextEncoder();
      let assistantText = "";
      let reasoningText = "";

      const result = streamText({
        model,
        system: systemPrompt,
        messages,
        temperature: 0.2,
        maxOutputTokens: 600,
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
              }
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
      temperature: 0.2,
      maxOutputTokens: 600,
    });

    // Persist the assistant response
    if (sessionId) {
      stateStore.addChatMessage({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: result.text,
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

    return NextResponse.json({
      provider,
      response: result.text,
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
