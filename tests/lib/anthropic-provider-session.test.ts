import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAnthropic: vi.fn(),
  getProviderConfig: vi.fn(),
  getProviderMeta: vi.fn(),
  getSecret: vi.fn(),
  loadAnthropicOAuthSession: vi.fn(),
  refreshStoredAnthropicAccessToken: vi.fn(),
  resolveCallableAnthropicOAuthModel: vi.fn(),
  setProviderConfig: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mocks.createAnthropic,
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

vi.mock("@/lib/llm/models", () => ({
  modelSupportsTemperature: vi.fn(() => true),
  normalizeProviderModel: vi.fn((provider: string, model?: string) => model),
  resolveCallableAnthropicOAuthModel: mocks.resolveCallableAnthropicOAuthModel,
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    setProviderConfig: mocks.setProviderConfig,
  },
}));

import { buildLanguageModel } from "@/lib/llm/providers";

describe("anthropic oauth provider runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConfig.mockResolvedValue({
      provider: "anthropic",
      enabled: true,
      model: "claude-opus-4-6",
      oauthTokenSecret: "llm.oauth.anthropic.access_token",
    });
    mocks.getProviderMeta.mockReturnValue({
      id: "anthropic",
      defaultModel: "claude-opus-4-6",
    });
    mocks.getSecret.mockImplementation(async (key: string) => {
      switch (key) {
        case "llm.api.anthropic.key":
          return undefined;
        case "llm.oauth.anthropic.access_token":
          return "stored-access-token";
        default:
          return undefined;
      }
    });
    mocks.loadAnthropicOAuthSession.mockResolvedValue({
      accessToken: "stored-access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 60_000,
    });
    mocks.refreshStoredAnthropicAccessToken.mockResolvedValue({
      accessToken: "refreshed-access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
    });
    mocks.resolveCallableAnthropicOAuthModel.mockResolvedValue({
      model: "claude-opus-4-6",
    });
    mocks.createAnthropic.mockImplementation(({ fetch }: { fetch: typeof global.fetch }) => {
      return vi.fn().mockReturnValue({ __fetch: fetch });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "OK" }],
            model: "claude-opus-4-6",
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  });

  it("uses the stored access token before attempting a refresh on the first Anthropic request", async () => {
    const model = await buildLanguageModel("anthropic");
    const providerModel = model as unknown as { __fetch: typeof global.fetch };

    await providerModel.__fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply with OK only." }],
      }),
    });

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://api.anthropic.com/v1/messages?beta=true");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer stored-access-token");
    expect(mocks.refreshStoredAnthropicAccessToken).not.toHaveBeenCalled();
  });
});
