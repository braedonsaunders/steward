import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/llm/config", () => ({
  getProviderConfig: vi.fn(),
}));

vi.mock("@/lib/llm/registry", () => ({
  getProviderMeta: vi.fn(),
}));

vi.mock("@/lib/security/vault", () => ({
  vault: {
    getSecret: vi.fn(),
  },
}));

import {
  buildAnthropicAuthorizeUrl,
  exchangeAnthropicCode,
  refreshAnthropicToken,
} from "@/lib/auth/oauth";

describe("anthropic oauth flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the current Claude Code Anthropic authorize URL", () => {
    const url = new URL(
      buildAnthropicAuthorizeUrl("pkce-challenge", "pkce-verifier", "max"),
    );

    expect(url.origin).toBe("https://claude.ai");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://console.anthropic.com/oauth/code/callback",
    );
    expect(url.searchParams.get("login_method")).toBeNull();
    expect(url.searchParams.get("state")).toBe("pkce-verifier");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");

    const scopes = new Set((url.searchParams.get("scope") ?? "").split(" ").filter(Boolean));
    expect(scopes).toEqual(new Set([
      "org:create_api_key",
      "user:profile",
      "user:inference",
    ]));
  });

  it("builds the Anthropic Console authorize URL for API-key creation", () => {
    const url = new URL(
      buildAnthropicAuthorizeUrl("pkce-challenge", "pkce-verifier", "console"),
    );

    expect(url.origin).toBe("https://console.anthropic.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://console.anthropic.com/oauth/code/callback",
    );
  });

  it("exchanges Anthropic codes against the platform token endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await exchangeAnthropicCode("auth-code", "oauth-state", "pkce-verifier");

    expect(tokens.access_token).toBe("fresh-access-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://console.anthropic.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(JSON.parse(String(request?.body))).toEqual({
      code: "auth-code",
      state: "oauth-state",
      grant_type: "authorization_code",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: "pkce-verifier",
    });
  });

  it("refreshes Anthropic tokens against the console token endpoint without extra scopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await refreshAnthropicToken("refresh-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://console.anthropic.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(JSON.parse(String(request?.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
  });
});
