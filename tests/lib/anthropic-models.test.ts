import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConfig: vi.fn(),
  getProviderMeta: vi.fn(),
  getSecret: vi.fn(),
  loadAnthropicOAuthSession: vi.fn(),
  refreshStoredAnthropicAccessToken: vi.fn(),
}));

vi.mock("@/lib/llm/config", () => ({
  getProviderConfig: mocks.getProviderConfig,
}));

vi.mock("@/lib/llm/registry", () => ({
  getProviderMeta: mocks.getProviderMeta,
}));

vi.mock("@/lib/security/vault", () => ({
  vault: {
    getSecret: mocks.getSecret,
  },
}));

vi.mock("@/lib/llm/anthropic-oauth", () => ({
  loadAnthropicOAuthSession: mocks.loadAnthropicOAuthSession,
  refreshStoredAnthropicAccessToken: mocks.refreshStoredAnthropicAccessToken,
}));

import {
  listProviderModelsFromApi,
  resolveCallableAnthropicOAuthModel,
} from "@/lib/llm/models";

describe("anthropic model listing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConfig.mockResolvedValue(undefined);
    mocks.getProviderMeta.mockReturnValue({
      id: "anthropic",
      defaultBaseUrl: "https://api.anthropic.com/v1",
    });
    mocks.getSecret.mockResolvedValue(undefined);
    mocks.loadAnthropicOAuthSession.mockResolvedValue({
      accessToken: undefined,
      refreshToken: undefined,
      expiresAt: 0,
    });
    mocks.refreshStoredAnthropicAccessToken.mockResolvedValue({
      accessToken: "refreshed-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a Bearer token when an Anthropic OAuth token override is supplied", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const models = await listProviderModelsFromApi("anthropic", {
      forceRefresh: true,
      oauthTokenOverride: "oauth-access-token",
    });

    expect(models).toEqual(["claude-opus-4-6"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer oauth-access-token",
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });

  it("prefers a stored Anthropic API key over a configured OAuth session", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    mocks.getProviderConfig.mockResolvedValue({
      provider: "anthropic",
      oauthTokenSecret: "llm.oauth.anthropic.access_token",
    });
    mocks.getSecret.mockImplementation(async (key: string) => {
      if (key === "llm.api.anthropic.key") {
        return "api-key-that-should-not-be-used";
      }
      return undefined;
    });
    mocks.loadAnthropicOAuthSession.mockResolvedValue({
      accessToken: "oauth-session-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
    });

    const models = await listProviderModelsFromApi("anthropic", {
      forceRefresh: true,
    });

    expect(models).toEqual(["claude-sonnet-4-6"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "api-key-that-should-not-be-used",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
    expect(mocks.loadAnthropicOAuthSession).not.toHaveBeenCalled();
  });

  it("uses the stored Anthropic OAuth access token before refreshing on local expiry metadata", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    mocks.loadAnthropicOAuthSession.mockResolvedValue({
      accessToken: "stored-access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 60_000,
    });

    const models = await listProviderModelsFromApi("anthropic", {
      forceRefresh: true,
    });

    expect(models).toEqual(["claude-opus-4-6"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer stored-access-token",
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
    expect(mocks.refreshStoredAnthropicAccessToken).not.toHaveBeenCalled();
  });

  it("falls back to the newest callable Anthropic model when the preferred model returns a 400", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/v1/messages")) {
        const body = JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.body ?? "{}")) as {
          model?: string;
        };

        if (body.model === "claude-opus-4-6") {
          return new Response(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "Error" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "OK" }],
            model: body.model,
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const resolution = await resolveCallableAnthropicOAuthModel("claude-opus-4-6", {
      models: [
        "claude-opus-4-6",
        "claude-3-haiku-20240307",
        "claude-haiku-4-5-20251001",
      ],
      oauthTokenOverride: "oauth-session-token",
    });

    expect(resolution).toEqual({
      model: "claude-haiku-4-5-20251001",
      fallbackFrom: "claude-opus-4-6",
    });
  });
});
