import { generateText } from "ai";
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
});

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = schema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const provider = (payload.data.provider ?? (await getDefaultProvider())) as LLMProvider;

  try {
    const context = await buildAssistantContext();
    const model = await buildLanguageModel(provider, payload.data.model);

    const result = await generateText({
      model,
      system: buildStewardSystemPrompt(context),
      prompt: payload.data.input,
      temperature: 0.2,
      maxOutputTokens: 600,
    });

    await stateStore.addAction({
      actor: "user",
      kind: "diagnose",
      message: `Conversational query handled by ${provider}`,
      context: {
        provider,
        model: payload.data.model,
      },
    });

    return NextResponse.json({
      provider,
      response: result.text,
      usage: result.usage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      provider === "openai" &&
      /missing scopes:\s*api\.responses\.write/i.test(message)
    ) {
      return NextResponse.json(
        {
          error:
            "OpenAI token is missing required API permissions. Configure an OpenAI Platform API key (OPENAI_API_KEY or Settings > Providers > API Key) and retry chat.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
