import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  refreshAnthropicToken: vi.fn(),
}));

vi.mock("@/lib/security/vault", () => ({
  vault: {
    getSecret: mocks.getSecret,
    setSecret: mocks.setSecret,
    deleteSecret: mocks.deleteSecret,
  },
}));

vi.mock("@/lib/auth/oauth", () => ({
  refreshAnthropicToken: mocks.refreshAnthropicToken,
}));

import {
  ensureFreshAnthropicOAuthSession,
  persistAnthropicOAuthTokens,
  refreshStoredAnthropicAccessToken,
} from "@/lib/llm/anthropic-oauth";

describe("anthropic oauth session helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T15:00:00.000Z"));
    vi.clearAllMocks();
    mocks.setSecret.mockResolvedValue(undefined);
    mocks.deleteSecret.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the existing refresh token when a refresh response omits one", async () => {
    mocks.refreshAnthropicToken.mockResolvedValue({
      access_token: "fresh-access-token",
      expires_in: 3600,
    });

    const session = await refreshStoredAnthropicAccessToken("existing-refresh-token");

    expect(mocks.refreshAnthropicToken).toHaveBeenCalledWith("existing-refresh-token");
    expect(mocks.setSecret).toHaveBeenCalledWith(
      "llm.oauth.anthropic.access_token",
      "fresh-access-token",
    );
    expect(mocks.setSecret).toHaveBeenCalledWith(
      "llm.oauth.anthropic.refresh_token",
      "existing-refresh-token",
    );
    expect(session.accessToken).toBe("fresh-access-token");
    expect(session.refreshToken).toBe("existing-refresh-token");
    expect(session.expiresAt).toBe(Date.now() + 3600 * 1000);
  });

  it("clears stale expires_at metadata when Anthropic does not return an expiry", async () => {
    const session = await persistAnthropicOAuthTokens(
      { access_token: "fresh-access-token" },
      { fallbackRefreshToken: "existing-refresh-token" },
    );

    expect(mocks.setSecret).toHaveBeenCalledWith(
      "llm.oauth.anthropic.access_token",
      "fresh-access-token",
    );
    expect(mocks.setSecret).toHaveBeenCalledWith(
      "llm.oauth.anthropic.refresh_token",
      "existing-refresh-token",
    );
    expect(mocks.deleteSecret).toHaveBeenCalledWith("llm.oauth.anthropic.expires_at");
    expect(session.expiresAt).toBe(0);
  });

  it("refreshes an expired stored session before returning it", async () => {
    mocks.getSecret.mockImplementation(async (key: string) => {
      switch (key) {
        case "llm.oauth.anthropic.access_token":
          return "expired-access-token";
        case "llm.oauth.anthropic.refresh_token":
          return "refresh-token";
        case "llm.oauth.anthropic.expires_at":
          return String(Date.now() - 60_000);
        default:
          return undefined;
      }
    });
    mocks.refreshAnthropicToken.mockResolvedValue({
      access_token: "fresh-access-token",
      expires_in: 1800,
    });

    const session = await ensureFreshAnthropicOAuthSession();

    expect(mocks.refreshAnthropicToken).toHaveBeenCalledWith("refresh-token");
    expect(session.accessToken).toBe("fresh-access-token");
    expect(session.refreshToken).toBe("refresh-token");
    expect(session.expiresAt).toBe(Date.now() + 1800 * 1000);
  });
});
