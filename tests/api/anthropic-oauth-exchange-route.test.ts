import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorized: vi.fn(),
  ensureVaultReadyForProviders: vi.fn(),
  exchangeAnthropicCode: vi.fn(),
  createAnthropicApiKey: vi.fn(),
  getProviderConfig: vi.fn(),
  persistAnthropicOAuthTokens: vi.fn(),
  clearAnthropicOAuthTokens: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  listProviderModelsFromApi: vi.fn(),
  normalizeProviderModel: vi.fn(),
  getProviderMeta: vi.fn(),
  setProviderConfig: vi.fn(),
  addAction: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  isAuthorized: mocks.isAuthorized,
}));

vi.mock("@/lib/security/vault-gate", () => ({
  ensureVaultReadyForProviders: mocks.ensureVaultReadyForProviders,
}));

vi.mock("@/lib/auth/oauth", () => ({
  exchangeAnthropicCode: mocks.exchangeAnthropicCode,
  createAnthropicApiKey: mocks.createAnthropicApiKey,
}));

vi.mock("@/lib/llm/config", () => ({
  getProviderConfig: mocks.getProviderConfig,
}));

vi.mock("@/lib/llm/anthropic-oauth", () => ({
  persistAnthropicOAuthTokens: mocks.persistAnthropicOAuthTokens,
  clearAnthropicOAuthTokens: mocks.clearAnthropicOAuthTokens,
}));

vi.mock("@/lib/llm/models", () => ({
  listProviderModelsFromApi: mocks.listProviderModelsFromApi,
  normalizeProviderModel: mocks.normalizeProviderModel,
}));

vi.mock("@/lib/security/vault", () => ({
  vault: {
    setSecret: mocks.setSecret,
    deleteSecret: mocks.deleteSecret,
  },
}));

vi.mock("@/lib/llm/registry", () => ({
  getProviderMeta: mocks.getProviderMeta,
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    setProviderConfig: mocks.setProviderConfig,
    addAction: mocks.addAction,
  },
}));

import { POST as anthropicOAuthExchange } from "@/app/api/providers/oauth/anthropic/exchange/route";

describe("anthropic oauth exchange route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthorized.mockReturnValue(true);
    mocks.ensureVaultReadyForProviders.mockResolvedValue({ ok: true });
    mocks.exchangeAnthropicCode.mockResolvedValue({
      access_token: "oauth-access-token",
      refresh_token: "oauth-refresh-token",
      expires_in: 3600,
    });
    mocks.createAnthropicApiKey.mockResolvedValue("sk-ant-created");
    mocks.persistAnthropicOAuthTokens.mockResolvedValue(undefined);
    mocks.clearAnthropicOAuthTokens.mockResolvedValue(undefined);
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
    mocks.normalizeProviderModel.mockImplementation((_provider: string, model?: string) => model);
    mocks.listProviderModelsFromApi.mockResolvedValue(["claude-opus-4-6"]);
    mocks.setSecret.mockResolvedValue(undefined);
    mocks.deleteSecret.mockResolvedValue(undefined);
    mocks.setProviderConfig.mockResolvedValue(undefined);
    mocks.addAction.mockResolvedValue(undefined);
  });

  it("stores an Anthropic OAuth session for the Claude Pro/Max flow", async () => {
    const response = await anthropicOAuthExchange(
      new Request("http://localhost/api/providers/oauth/anthropic/exchange", {
        method: "POST",
        body: JSON.stringify({ code: "auth-code#pkce-verifier", mode: "max" }),
        headers: {
          "content-type": "application/json",
        },
      }) as never,
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.credentialMode).toBe("oauth-session");
    expect(mocks.createAnthropicApiKey).not.toHaveBeenCalled();
    expect(mocks.deleteSecret).toHaveBeenCalledWith("llm.api.anthropic.key");
    expect(mocks.persistAnthropicOAuthTokens).toHaveBeenCalled();
    expect(mocks.clearAnthropicOAuthTokens).not.toHaveBeenCalled();
    expect(mocks.listProviderModelsFromApi).toHaveBeenCalledWith("anthropic", {
      forceRefresh: true,
      oauthTokenOverride: "oauth-access-token",
    });
    expect(mocks.setProviderConfig).toHaveBeenCalledWith({
      provider: "anthropic",
      enabled: true,
      model: "claude-opus-4-6",
      oauthTokenSecret: "llm.oauth.anthropic.access_token",
      updatedAt: expect.any(String),
    });
    expect(mocks.addAction).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          credentialMode: "oauth-session",
          mode: "max",
          provider: "anthropic",
          selectedModel: "claude-opus-4-6",
        }),
      }),
    );
    expect(body.model).toBe("claude-opus-4-6");
  });

  it("creates and stores an Anthropic API key for the console flow", async () => {
    const response = await anthropicOAuthExchange(
      new Request("http://localhost/api/providers/oauth/anthropic/exchange", {
        method: "POST",
        body: JSON.stringify({ code: "auth-code#pkce-verifier", mode: "console" }),
        headers: {
          "content-type": "application/json",
        },
      }) as never,
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.credentialMode).toBe("api-key");
    expect(mocks.createAnthropicApiKey).toHaveBeenCalledWith("oauth-access-token");
    expect(mocks.clearAnthropicOAuthTokens).toHaveBeenCalled();
    expect(mocks.persistAnthropicOAuthTokens).not.toHaveBeenCalled();
    expect(mocks.setSecret).toHaveBeenCalledWith("llm.api.anthropic.key", "sk-ant-created");
    expect(mocks.listProviderModelsFromApi).toHaveBeenCalledWith("anthropic", {
      forceRefresh: true,
      tokenOverride: "sk-ant-created",
    });
    expect(mocks.setProviderConfig).toHaveBeenCalledWith({
      provider: "anthropic",
      enabled: true,
      model: "claude-opus-4-6",
      oauthTokenSecret: undefined,
      updatedAt: expect.any(String),
    });
    expect(mocks.addAction).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          credentialMode: "api-key",
          provider: "anthropic",
          selectedModel: "claude-opus-4-6",
        }),
      }),
    );
  });
});
