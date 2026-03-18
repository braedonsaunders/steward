import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOpenAI: vi.fn(),
  wrapLanguageModel: vi.fn(),
  defaultSettingsMiddleware: vi.fn(),
  getProviderConfig: vi.fn(),
  getProviderMeta: vi.fn(),
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  refreshOpenAIToken: vi.fn(),
  extractChatGPTAccountId: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mocks.createOpenAI,
}));

vi.mock("ai", () => ({
  defaultSettingsMiddleware: mocks.defaultSettingsMiddleware,
  wrapLanguageModel: mocks.wrapLanguageModel,
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
    setSecret: mocks.setSecret,
  },
}));

vi.mock("@/lib/auth/oauth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/oauth")>("@/lib/auth/oauth");
  return {
    ...actual,
    refreshOpenAIToken: mocks.refreshOpenAIToken,
    extractChatGPTAccountId: mocks.extractChatGPTAccountId,
  };
});

vi.mock("@/lib/llm/models", () => ({
  modelSupportsTemperature: vi.fn(() => true),
  normalizeProviderModel: vi.fn((provider: string, model?: string) => model),
  resolveCallableAnthropicOAuthModel: vi.fn(),
}));

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

function completedCodexSse(): string {
  return [
    'data: {"type":"response.completed","response":{"id":"resp_123","status":"completed","output":[]}}',
    "data: [DONE]",
    "",
  ].join("\n");
}

import { buildLanguageModel } from "@/lib/llm/providers";

describe("openai oauth provider runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.defaultSettingsMiddleware.mockReturnValue({});
    mocks.wrapLanguageModel.mockImplementation(({ model }: { model: unknown }) => model);
    mocks.getProviderConfig.mockResolvedValue({
      provider: "openai",
      enabled: true,
      model: "gpt-5.3-codex",
      oauthTokenSecret: "llm.oauth.openai.access_token",
    });
    mocks.getProviderMeta.mockReturnValue({
      id: "openai",
      defaultModel: "gpt-5.3-codex",
    });
    mocks.getSecret.mockImplementation(async (key: string) => {
      switch (key) {
        case "llm.api.openai.key":
          return undefined;
        case "llm.oauth.openai.access_token":
          return "stored-access-token";
        case "llm.oauth.openai.refresh_token":
          return "refresh-token";
        case "llm.oauth.openai.account_id":
          return "acct-stored";
        case "llm.oauth.openai.expires_at":
          return String(Date.now() - 60_000);
        default:
          return undefined;
      }
    });
    mocks.setSecret.mockResolvedValue(undefined);
    mocks.extractChatGPTAccountId.mockImplementation((token: string) => {
      if (token === "refreshed-access-token") {
        return "acct-refreshed";
      }
      if (token === "stored-access-token") {
        return "acct-stored";
      }
      return undefined;
    });
    mocks.createOpenAI.mockImplementation(({ fetch }: { fetch: typeof global.fetch }) => {
      return vi.fn().mockReturnValue({ __fetch: fetch });
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("uses the stored OpenAI OAuth access token before attempting a refresh from stale local expiry metadata", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue(
      new Response(completedCodexSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const model = await buildLanguageModel("openai");
    const providerModel = model as unknown as { __fetch: typeof global.fetch };
    const response = await providerModel.__fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        input: "Reply with OK only.",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.refreshOpenAIToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe(CODEX_API_ENDPOINT);
    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer stored-access-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct-stored");
  });

  it("refreshes and retries when the OpenAI OAuth access token is rejected with 401", async () => {
    const fetchMock = vi.mocked(global.fetch);
    const authorizationHeaders: string[] = [];
    fetchMock.mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      authorizationHeaders.push(headers.get("Authorization") ?? "");

      if (authorizationHeaders.length === 1) {
        return new Response("Unauthorized", { status: 401 });
      }

      return new Response(completedCodexSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    mocks.refreshOpenAIToken.mockResolvedValue({
      access_token: "refreshed-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
    });

    const model = await buildLanguageModel("openai");
    const providerModel = model as unknown as { __fetch: typeof global.fetch };
    const response = await providerModel.__fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        input: "Reply with OK only.",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.refreshOpenAIToken).toHaveBeenCalledWith("refresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizationHeaders).toEqual([
      "Bearer stored-access-token",
      "Bearer refreshed-access-token",
    ]);
    expect(mocks.setSecret).toHaveBeenCalledWith(
      "llm.oauth.openai.access_token",
      "refreshed-access-token",
    );
    expect(mocks.setSecret).toHaveBeenCalledWith(
      "llm.oauth.openai.refresh_token",
      "rotated-refresh-token",
    );
    expect(mocks.setSecret).toHaveBeenCalledWith(
      "llm.oauth.openai.account_id",
      "acct-refreshed",
    );
  });
});
