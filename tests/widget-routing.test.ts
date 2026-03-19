import { describe, expect, it } from "vitest";
import { shouldPlanWidgetRouteTurn } from "@/lib/assistant/widget-routing";
import type { ChatMessage } from "@/lib/state/types";

function assistantMessage(content: string): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId: "session-1",
    role: "assistant",
    content,
    provider: "anthropic",
    error: false,
    createdAt: "2026-03-18T19:00:00.000Z",
  };
}

describe("widget routing", () => {
  it("does not infer widget work from device web interface language", () => {
    const history = [
      assistantMessage("The API requires authentication. Let me check the version through the web interface and then review the update guidance."),
    ];

    expect(shouldPlanWidgetRouteTurn({
      history,
      userInput: "yes its ok for it to be offline, upgrade all 10, create backup",
    })).toBe(false);
  });

  it("still allows explicit widget follow-ups", () => {
    const history = [
      assistantMessage("I can update the widget for this device. Do you want me to revise it?"),
    ];

    expect(shouldPlanWidgetRouteTurn({
      history,
      userInput: "yes, update it",
    })).toBe(true);
  });
});
