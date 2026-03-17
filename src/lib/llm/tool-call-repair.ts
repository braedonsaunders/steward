import {
  generateText,
  InvalidToolInputError,
  type JSONSchema7,
  type LanguageModel,
  type ModelMessage,
  type NoSuchToolError,
} from "ai";
import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObjectFromText(raw: string): Record<string, unknown> | null {
  const queue: string[] = [raw.trim()];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate) {
      continue;
    }

    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    try {
      const parsed = JSON.parse(normalized);
      if (isRecord(parsed)) {
        return parsed;
      }
      if (typeof parsed === "string" && parsed.trim().length > 0) {
        queue.push(parsed);
      }
    } catch {
      // Keep looking for a nested object payload.
    }

    const firstBrace = normalized.indexOf("{");
    const lastBrace = normalized.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      queue.push(normalized.slice(firstBrace, lastBrace + 1));
    }
  }

  return null;
}

async function repairWithModel(args: {
  model: LanguageModel;
  toolName: string;
  schema: JSONSchema7;
  malformedInput: string;
  messages: ModelMessage[];
}): Promise<Record<string, unknown> | null> {
  const conversationTail = args.messages
    .slice(-4)
    .map((message, index) => {
      const serialized = JSON.stringify(message);
      return `Message ${index + 1}: ${serialized.length > 1200 ? `${serialized.slice(0, 1200)}...` : serialized}`;
    })
    .join("\n");

  const repair = await generateText({
    model: args.model,
    temperature: 0,
    maxOutputTokens: 1200,
    prompt: [
      "Repair malformed Steward tool arguments.",
      "Return ONLY a valid JSON object. Do not wrap it in quotes. Do not use markdown fences.",
      "Do not invent fields. If part of the malformed input is unrecoverable, omit that field.",
      `Tool: ${args.toolName}`,
      `JSON Schema: ${JSON.stringify(args.schema)}`,
      `Malformed input: ${args.malformedInput}`,
      conversationTail.length > 0 ? `Recent conversation context:\n${conversationTail}` : "",
    ].filter((part) => part.length > 0).join("\n\n"),
  });

  return parseObjectFromText(repair.text);
}

export async function repairMalformedToolCall(args: {
  model: LanguageModel;
  toolCall: LanguageModelV3ToolCall;
  inputSchema: JSONSchema7;
  messages: ModelMessage[];
  error: NoSuchToolError | InvalidToolInputError;
}): Promise<LanguageModelV3ToolCall | null> {
  const rawInput = args.error instanceof InvalidToolInputError
    ? args.error.toolInput
    : args.toolCall.input;

  const locallyParsed = parseObjectFromText(rawInput);
  if (locallyParsed) {
    return {
      ...args.toolCall,
      input: JSON.stringify(locallyParsed),
    };
  }

  const repaired = await repairWithModel({
    model: args.model,
    toolName: args.toolCall.toolName,
    schema: args.inputSchema,
    malformedInput: rawInput,
    messages: args.messages,
  });

  if (!repaired) {
    return null;
  }

  return {
    ...args.toolCall,
    input: JSON.stringify(repaired),
  };
}

export function createToolCallRepair(args: {
  model: LanguageModel;
}) {
  return async ({
    toolCall,
    inputSchema,
    messages,
    error,
  }: {
    toolCall: LanguageModelV3ToolCall;
    inputSchema: (options: { toolName: string }) => PromiseLike<JSONSchema7>;
    messages: ModelMessage[];
    error: NoSuchToolError | InvalidToolInputError;
  }): Promise<LanguageModelV3ToolCall | null> => {
    return repairMalformedToolCall({
      model: args.model,
      toolCall,
      inputSchema: await inputSchema({ toolName: toolCall.toolName }),
      messages,
      error,
    });
  };
}
