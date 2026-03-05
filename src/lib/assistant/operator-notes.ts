import { generateText } from "ai";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import type { Device, LLMProvider } from "@/lib/state/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]+?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getCurrentOperatorNotes(device: Device): string {
  if (typeof device.metadata.notes !== "object" || device.metadata.notes === null) {
    return "";
  }
  const notes = device.metadata.notes as Record<string, unknown>;
  return typeof notes.operatorContext === "string" ? notes.operatorContext.trim() : "";
}

export async function maybeUpdateOperatorNotes(args: {
  device: Device;
  provider: LLMProvider;
  model?: string;
  userInput: string;
  assistantOutput: string;
  sessionId?: string;
  onboarding: boolean;
}): Promise<void> {
  try {
    const currentNotes = getCurrentOperatorNotes(args.device);
    const conversationSlice = args.sessionId
      ? stateStore
        .getChatMessages(args.sessionId)
        .slice(-10)
        .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
        .join("\n\n")
      : "";

    const model = await buildLanguageModel(args.provider, args.model);
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 450,
      prompt: [
        "You maintain concise durable operator notes for a managed device.",
        "Return JSON only:",
        '{"shouldUpdate": boolean, "notes": string, "structuredContext": object, "reason": string}',
        "Rules:",
        "- Update notes only if new stable facts were learned (role, dependencies, ports, auth topology, critical caveats).",
        "- Keep notes under 1200 chars, concise and operational.",
        "- Exclude temporary probe output noise.",
        "",
        `Device: ${args.device.name} (${args.device.ip}) type=${args.device.type} os=${args.device.os ?? "unknown"}`,
        `Onboarding session: ${args.onboarding ? "yes" : "no"}`,
        `Current notes: ${currentNotes || "(empty)"}`,
        `Latest user message: ${args.userInput}`,
        `Latest assistant response: ${args.assistantOutput}`,
        `Recent conversation: ${conversationSlice || "(none)"}`,
      ].join("\n"),
    });

    const parsed = extractJsonObject(result.text);
    if (!parsed) return;

    const shouldUpdate = parsed.shouldUpdate === true;
    const nextNotes = typeof parsed.notes === "string" ? parsed.notes.trim() : "";
    const nextStructuredContext = isRecord(parsed.structuredContext)
      ? parsed.structuredContext
      : undefined;
    const currentStructuredContext =
      isRecord(args.device.metadata.notes)
      && isRecord((args.device.metadata.notes as Record<string, unknown>).structuredContext)
      ? ((args.device.metadata.notes as Record<string, unknown>).structuredContext as Record<string, unknown>)
      : {};
    const structuredChanged = nextStructuredContext
      ? JSON.stringify(nextStructuredContext) !== JSON.stringify(currentStructuredContext)
      : false;

    if (!shouldUpdate || (nextNotes.length === 0 && !structuredChanged) || (nextNotes === currentNotes && !structuredChanged)) {
      return;
    }

    const updatedDevice: Device = {
      ...args.device,
      metadata: {
        ...args.device.metadata,
        notes: {
          ...(isRecord(args.device.metadata.notes) ? args.device.metadata.notes : {}),
          operatorContext: nextNotes || currentNotes,
          operatorContextUpdatedAt: new Date().toISOString(),
          ...(nextStructuredContext
            ? {
              structuredContext: nextStructuredContext,
              structuredContextUpdatedAt: new Date().toISOString(),
            }
            : {}),
        },
      },
      lastChangedAt: new Date().toISOString(),
    };

    await stateStore.upsertDevice(updatedDevice);
    await stateStore.addAction({
      actor: "steward",
      kind: "learn",
      message: `Updated operator notes for ${args.device.name}`,
      context: {
        deviceId: args.device.id,
        sessionId: args.sessionId ?? null,
        onboarding: args.onboarding,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      },
    });
  } catch {
    // best-effort background note maintenance
  }
}
