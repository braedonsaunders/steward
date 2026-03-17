import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorized: vi.fn(),
  ensureVaultReadyForProviders: vi.fn(),
  exchangeAnthropicCode: vi.fn(),
  createAnthropicApiKey: vi.fn(),
  getProviderConfig: vi.fn(),
  persistAnthropicOAuthTokens: vi.fn(),
  listProviderModelsFromApi: vi.fn(),
  normalizeProviderModel: vi.fn(),
  getProviderMeta: vi.fn(),
  setSecret: vi.fn(),
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
}));

vi.mock("@/lib/llm/models", () => ({
  listProviderModelsFromApi: mocks.listProviderModelsFromApi,
  normalizeProviderModel: mocks.normalizeProviderModel,
}));

vi.mock("@/lib/llm/registry", () => ({
  getProviderMeta: mocks.getProviderMeta,
}));

vi.mock("@/lib/security/vault", () => ({
  vault: {
    setSecret: mocks.setSecret,
  },
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
    mocks.persistAnthropicOAuthTokens.mockResolvedValue(undefined);
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
    mocks.setProviderConfig.mockResolvedValue(undefined);
    mocks.addAction.mockResolvedValue(undefined);
    mocks.setSecret.mockResolvedValue(undefined);
  });

  it("falls back to OAuth-only connection when api-key minting lacks org:create_api_key", async () => {
    mocks.createAnthropicApiKey.mockRejectedValue(
      new Error(
        'Anthropic API key creation failed (403): {"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement org:create_api_key"}}',
      ),
    );

    const response = await anthropicOAuthExchange(
      new Request("http://localhost/api/providers/oauth/anthropic/exchange", {
        method: "POST",
        body: JSON.stringify({ code: "auth-code#pkce-verifier" }),
        headers: {
          "content-type": "application/json",
        },
      }) as never,
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.warning).toContain("org:create_api_key");
    expect(mocks.persistAnthropicOAuthTokens).toHaveBeenCalled();
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.setProviderConfig).toHaveBeenCalledWith({
      provider: "anthropic",
      enabled: true,
      model: "claude-opus-4-6",
      oauthTokenSecret: "llm.oauth.anthropic.access_token",
    });
    expect(mocks.addAction).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          provider: "anthropic",
          apiKeyMinted: false,
        }),
      }),
    );
  });
});
