import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: generateTextMock,
  };
});

import { InvalidToolInputError } from "ai";
import { repairMalformedToolCall } from "@/lib/llm/tool-call-repair";

describe("tool call repair", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it("unwraps stringified JSON tool arguments into an object", async () => {
    const result = await repairMalformedToolCall({
      model: {} as never,
      toolCall: {
        toolCallId: "toolu_test",
        toolName: "steward_complete_onboarding",
        input: "\"{\\\"device_id\\\":\\\"dev-1\\\",\\\"profile_ids\\\":[\\\"profile-1\\\"]}\"",
      },
      inputSchema: {
        type: "object",
        properties: {
          device_id: { type: "string" },
          profile_ids: { type: "array", items: { type: "string" } },
        },
      },
      messages: [],
      error: new InvalidToolInputError({
        toolName: "steward_complete_onboarding",
        toolInput: "\"{\\\"device_id\\\":\\\"dev-1\\\",\\\"profile_ids\\\":[\\\"profile-1\\\"]}\"",
        cause: new Error("Input should be a valid dictionary"),
      }),
    });

    expect(result).toEqual({
      toolCallId: "toolu_test",
      toolName: "steward_complete_onboarding",
      input: "{\"device_id\":\"dev-1\",\"profile_ids\":[\"profile-1\"]}",
    });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("falls back to a repair model call when the nested JSON is malformed", async () => {
    generateTextMock.mockResolvedValue({
      text: "{\"device_id\":\"dev-1\",\"summary\":\"fixed summary\"}",
    });

    const malformedInput = "\"{\\\"device_id\\\":\\\"dev-1\\\",\\\"summary\\\":\\\"broken\\\",,}\"";
    const result = await repairMalformedToolCall({
      model: {} as never,
      toolCall: {
        toolCallId: "toolu_test",
        toolName: "steward_complete_onboarding",
        input: malformedInput,
      },
      inputSchema: {
        type: "object",
        properties: {
          device_id: { type: "string" },
          summary: { type: "string" },
        },
      },
      messages: [],
      error: new InvalidToolInputError({
        toolName: "steward_complete_onboarding",
        toolInput: malformedInput,
        cause: new Error("Input should be a valid dictionary"),
      }),
    });

    expect(result).toEqual({
      toolCallId: "toolu_test",
      toolName: "steward_complete_onboarding",
      input: "{\"device_id\":\"dev-1\",\"summary\":\"fixed summary\"}",
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});
