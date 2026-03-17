import { describe, expect, it } from "vitest";
import {
  normalizeChatError,
  stringifyUnknownChatError,
  toFriendlyChatError,
} from "@/lib/chat/errors";

describe("chat error normalization", () => {
  it("extracts nested provider messages from generic SDK errors", () => {
    const error = new Error("Error");
    Object.assign(error, {
      responseBody: JSON.stringify({
        error: {
          type: "authentication_error",
          message: "invalid x-api-key",
        },
      }),
    });

    expect(stringifyUnknownChatError(error)).toBe("invalid x-api-key");
  });

  it("adds an actionable Anthropic auth hint when the provider reports auth failures", () => {
    const message = normalizeChatError(
      {
        message: "Error",
        cause: {
          error: {
            message: "OAuth token missing required scope",
          },
        },
      },
      "anthropic",
    );

    expect(message).toContain("Anthropic authentication issue:");
    expect(message).toContain("OAuth token missing required scope");
    expect(message).toContain("Reconnect Anthropic in Settings");
  });

  it("replaces bare generic provider failures with a usable fallback", () => {
    expect(toFriendlyChatError("Error", "anthropic")).toBe(
      "Anthropic request failed without a usable error message. Check the provider connection or credentials in Settings, then retry.",
    );
  });

  it("treats provider error type labels as generic placeholders", () => {
    expect(toFriendlyChatError("invalid_request_error", "anthropic")).toBe(
      "Anthropic request failed without a usable error message. Check the provider connection or credentials in Settings, then retry.",
    );
  });
});
