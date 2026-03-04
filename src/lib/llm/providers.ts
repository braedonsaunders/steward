import { createAnthropic } from "@ai-sdk/anthropic";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import {
  extractChatGPTAccountId,
  refreshAnthropicToken,
  refreshOpenAIToken,
} from "@/lib/auth/oauth";
import { getProviderConfig } from "@/lib/llm/config";
import { getProviderMeta } from "@/lib/llm/registry";
import { vault } from "@/lib/security/vault";
import type { LLMProvider } from "@/lib/state/types";

// ---------------------------------------------------------------------------
// OpenAI Codex OAuth endpoint — same as oneshot/opencode codex.ts
// ---------------------------------------------------------------------------
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_OAUTH_CODEX_MODELS = new Set([
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
]);
const DEFAULT_OPENAI_OAUTH_MODEL = "gpt-5.3-codex";

// ---------------------------------------------------------------------------
// Anthropic OAuth constants — same as oneshot opencode-anthropic-auth
// ---------------------------------------------------------------------------
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

const resolveCredential = async (provider: LLMProvider): Promise<string | undefined> => {
  const config = await getProviderConfig(provider);
  if (!config) return undefined;

  // 1. API key stored in vault (manual entry or created via OAuth)
  const apiKeySecret = await vault.getSecret(`llm.api.${provider}.key`);
  if (apiKeySecret) return apiKeySecret;

  // 2. OAuth access token from vault
  if (config.oauthTokenSecret) {
    const oauthToken = await vault.getSecret(config.oauthTokenSecret);
    if (oauthToken) return oauthToken;
  }

  return undefined;
};

/** Build model using createOpenAI with custom baseURL (for OpenAI-compatible providers) */
const buildOpenAICompatible = async (
  provider: LLMProvider,
  model: string,
): Promise<LanguageModel> => {
  const config = await getProviderConfig(provider);
  const meta = getProviderMeta(provider);
  const token = await resolveCredential(provider);

  const client = createOpenAI({
    name: provider,
    apiKey: token || "no-key",
    baseURL: config?.baseUrl ?? meta?.defaultBaseUrl,
    headers: config?.extraHeaders,
  });

  // Use .chat() to explicitly use Chat Completions API (not Responses API)
  return client.chat(model);
};

// ---------------------------------------------------------------------------
// OpenAI OAuth → ChatGPT backend (mirrors oneshot codex.ts exactly)
// ---------------------------------------------------------------------------

/**
 * Build an OpenAI model that routes through the ChatGPT backend API using
 * OAuth tokens. This is the exact same approach used by oneshot/opencode's
 * Codex plugin (codex.ts):
 *
 *  1. Pass a dummy API key to createOpenAI so the SDK doesn't complain
 *  2. Supply a custom `fetch` that:
 *     - Strips the dummy Authorization header
 *     - Sets the real OAuth Bearer token
 *     - Adds `ChatGPT-Account-Id` header
 *     - Rewrites any /v1/responses or /chat/completions URL to CODEX_API_ENDPOINT
 *     - Refreshes the token when expired
 *  3. Use the Responses API (sdk.responses or sdk(model))
 */
const buildOpenAICodexOAuth = async (model: string): Promise<LanguageModel> => {
  const oauthTokenSecret = "llm.oauth.openai.access_token";

  // Load all tokens from vault upfront
  let accessToken = await vault.getSecret(oauthTokenSecret);
  if (!accessToken) {
    throw new Error(
      "OpenAI provider requires credentials. Add an API key or connect via OAuth in Settings.",
    );
  }

  const refreshToken = await vault.getSecret("llm.oauth.openai.refresh_token");
  let accountId: string | undefined =
    (await vault.getSecret("llm.oauth.openai.account_id")) ?? undefined;
  const expiresAtStr = await vault.getSecret("llm.oauth.openai.expires_at");
  let expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;

  // If we never stored an account ID, try to extract it from the JWT now
  if (!accountId) {
    accountId = extractChatGPTAccountId(accessToken);
    if (accountId) {
      vault.setSecret("llm.oauth.openai.account_id", accountId).catch(() => {});
    }
  }

  // Custom fetch interceptor (matches oneshot codex.ts loader.fetch)
  const codexFetch = async (
    requestInput: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // ── Token refresh (same as oneshot codex.ts) ──────────────────────
    if (refreshToken && expiresAt > 0 && Date.now() >= expiresAt) {
      try {
        const tokens = await refreshOpenAIToken(refreshToken);
        accessToken = tokens.access_token;
        expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

        const newAccountId = extractChatGPTAccountId(tokens.access_token);
        if (newAccountId) accountId = newAccountId;

        vault.setSecret(oauthTokenSecret, accessToken).catch(() => {});
        vault.setSecret("llm.oauth.openai.expires_at", String(expiresAt)).catch(() => {});
        if (newAccountId) {
          vault.setSecret("llm.oauth.openai.account_id", newAccountId).catch(() => {});
        }
      } catch {
        // Use existing token
      }
    }

    // ── Strip dummy Authorization header set by SDK ───────────────────
    const headers = new Headers();
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => headers.set(key, value));
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          if (value !== undefined) headers.set(key, String(value));
        }
      } else {
        for (const [key, value] of Object.entries(init.headers)) {
          if (value !== undefined) headers.set(key, String(value));
        }
      }
    }
    headers.delete("authorization");
    headers.delete("Authorization");

    // ── Set real OAuth Bearer token ───────────────────────────────────
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("originator", "steward");
    headers.set("user-agent", "steward/0.1.0");
    if (!headers.get("session_id")) {
      headers.set("session_id", crypto.randomUUID());
    }

    // ── Set ChatGPT-Account-Id for organization subscriptions ─────────
    if (accountId) {
      headers.set("ChatGPT-Account-Id", accountId);
    }

    // ── Rewrite URL to Codex endpoint (same as oneshot codex.ts) ──────
    const parsed =
      requestInput instanceof URL
        ? requestInput
        : new URL(
            typeof requestInput === "string"
              ? requestInput
              : requestInput.url,
          );

    const targetUrl =
      parsed.pathname.includes("/v1/responses") ||
      parsed.pathname.includes("/chat/completions")
        ? new URL(CODEX_API_ENDPOINT)
        : parsed;

    return globalThis.fetch(targetUrl, { ...init, headers });
  };

  const resolvedModel = OPENAI_OAUTH_CODEX_MODELS.has(model)
    ? model
    : DEFAULT_OPENAI_OAUTH_MODEL;

  const client = createOpenAI({
    apiKey: "steward-oauth-dummy-key",
    fetch: codexFetch,
  });

  // Use Responses API (same as oneshot: sdk.responses(modelID))
  return client(resolvedModel);
};

// ---------------------------------------------------------------------------
// Anthropic OAuth → Claude Pro/Max (mirrors oneshot opencode-anthropic-auth)
// ---------------------------------------------------------------------------

/**
 * Build an Anthropic model that uses OAuth tokens from Claude Pro/Max.
 * Copied from oneshot's opencode-anthropic-auth plugin:
 *
 *  1. Pass an empty apiKey so the SDK doesn't complain
 *  2. Supply a custom `fetch` that:
 *     - Replaces x-api-key with Bearer token authorization
 *     - Sets required anthropic-beta headers (oauth-2025-04-20, etc.)
 *     - Sets user-agent to claude-cli
 *     - Adds ?beta=true to /v1/messages URLs
 *     - Refreshes the token when expired
 */
const buildAnthropicOAuth = async (model: string): Promise<LanguageModel> => {
  let accessToken = await vault.getSecret("llm.oauth.anthropic.access_token");
  if (!accessToken) {
    throw new Error(
      "Anthropic provider requires credentials. Add an API key or connect via OAuth in Settings.",
    );
  }

  const refreshToken = await vault.getSecret("llm.oauth.anthropic.refresh_token");
  const expiresAtStr = await vault.getSecret("llm.oauth.anthropic.expires_at");
  let expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;

  // Custom fetch interceptor (matches oneshot opencode-anthropic-auth plugin)
  const anthropicOAuthFetch = async (
    requestInput: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // ── Token refresh (same as oneshot anthropic auth plugin) ─────────
    if (refreshToken && (!accessToken || (expiresAt > 0 && Date.now() >= expiresAt))) {
      try {
        const tokens = await refreshAnthropicToken(refreshToken);
        accessToken = tokens.access_token;
        if (tokens.expires_in) {
          expiresAt = Date.now() + tokens.expires_in * 1000;
        }
        if (tokens.refresh_token) {
          vault.setSecret("llm.oauth.anthropic.refresh_token", tokens.refresh_token).catch(() => {});
        }
        vault.setSecret("llm.oauth.anthropic.access_token", accessToken).catch(() => {});
        vault.setSecret("llm.oauth.anthropic.expires_at", String(expiresAt)).catch(() => {});
      } catch {
        // Use existing token
      }
    }

    // ── Build headers from init (preserving existing headers) ─────────
    const requestHeaders = new Headers();

    // Copy headers from Request object if applicable
    if (requestInput instanceof Request) {
      requestInput.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    }

    // Copy headers from init
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          requestHeaders.set(key, value);
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          if (value !== undefined) requestHeaders.set(key, String(value));
        }
      } else {
        for (const [key, value] of Object.entries(init.headers)) {
          if (value !== undefined) requestHeaders.set(key, String(value));
        }
      }
    }

    // ── Merge required OAuth beta headers (same as oneshot) ───────────
    const incomingBeta = requestHeaders.get("anthropic-beta") || "";
    const incomingBetasList = incomingBeta
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);

    const requiredBetas = [
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
    ];
    const mergedBetas = [...new Set([...requiredBetas, ...incomingBetasList])].join(",");

    // ── Set authorization with OAuth Bearer token ─────────────────────
    requestHeaders.set("authorization", `Bearer ${accessToken}`);
    requestHeaders.set("anthropic-beta", mergedBetas);
    requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)");
    // Remove SDK's x-api-key header — we use Bearer token instead
    requestHeaders.delete("x-api-key");

    // ── Add ?beta=true to /v1/messages URL (same as oneshot) ──────────
    let finalInput: RequestInfo | URL = requestInput;
    let requestUrl: URL | null = null;
    try {
      if (typeof requestInput === "string" || requestInput instanceof URL) {
        requestUrl = new URL(requestInput.toString());
      } else if (requestInput instanceof Request) {
        requestUrl = new URL(requestInput.url);
      }
    } catch {
      requestUrl = null;
    }

    if (
      requestUrl &&
      requestUrl.pathname === "/v1/messages" &&
      !requestUrl.searchParams.has("beta")
    ) {
      requestUrl.searchParams.set("beta", "true");
      finalInput =
        requestInput instanceof Request
          ? new Request(requestUrl.toString(), requestInput)
          : requestUrl;
    }

    return globalThis.fetch(finalInput, {
      ...init,
      headers: requestHeaders,
    });
  };

  const client = createAnthropic({
    apiKey: "", // Empty — replaced by custom fetch with Bearer token
    fetch: anthropicOAuthFetch,
  });

  return client(model);
};

// ---------------------------------------------------------------------------
// Main model builder
// ---------------------------------------------------------------------------

export const buildLanguageModel = async (
  provider: LLMProvider,
  modelOverride?: string,
): Promise<LanguageModel> => {
  const config = await getProviderConfig(provider);
  const meta = getProviderMeta(provider);
  const model = modelOverride ?? config?.model ?? meta?.defaultModel;

  if (!model) {
    throw new Error(`Missing model for provider ${provider}`);
  }

  switch (provider) {
    case "openai": {
      // Priority 1: Real API key (from manual entry or token-exchange during OAuth)
      const apiKey = await vault.getSecret("llm.api.openai.key");
      if (apiKey) {
        const client = createOpenAI({ apiKey });
        // Use Responses API for API keys (same as oneshot: sdk.responses(modelID))
        return client(model);
      }

      // Priority 2: OAuth access token → ChatGPT backend via custom fetch
      // (exact same pattern as oneshot's codex.ts plugin)
      const openaiConfig = await getProviderConfig("openai");
      if (openaiConfig?.oauthTokenSecret) {
        const hasToken = await vault.getSecret(openaiConfig.oauthTokenSecret);
        if (hasToken) {
          return buildOpenAICodexOAuth(model);
        }
      }

      throw new Error(
        "OpenAI provider requires credentials. Add an API key or connect via OAuth in Settings.",
      );
    }
    case "anthropic": {
      // Priority 1: Real API key (from manual entry)
      const apiKey = await vault.getSecret("llm.api.anthropic.key");
      if (apiKey) {
        const client = createAnthropic({ apiKey });
        return client(model);
      }

      // Priority 2: OAuth access token → custom fetch with Bearer + anthropic-beta
      // (exact same pattern as oneshot's opencode-anthropic-auth plugin)
      const anthropicOAuthToken = await vault.getSecret("llm.oauth.anthropic.access_token");
      if (anthropicOAuthToken) {
        return buildAnthropicOAuth(model);
      }

      throw new Error(
        "Anthropic provider requires credentials. Add an API key or connect via OAuth in Settings.",
      );
    }
    case "google": {
      const token = await resolveCredential("google");
      const client = createGoogleGenerativeAI({ apiKey: token });
      return client(model);
    }
    case "mistral": {
      const token = await resolveCredential("mistral");
      const client = createMistral({ apiKey: token });
      return client(model);
    }
    case "groq": {
      const token = await resolveCredential("groq");
      const client = createGroq({ apiKey: token });
      return client(model);
    }
    case "xai": {
      const token = await resolveCredential("xai");
      const client = createXai({ apiKey: token });
      return client(model);
    }
    case "cohere": {
      const token = await resolveCredential("cohere");
      const client = createCohere({ apiKey: token });
      return client(model);
    }
    // OpenAI-compatible providers
    case "deepseek":
    case "perplexity":
    case "fireworks":
    case "togetherai":
    case "openrouter":
    case "ollama":
    case "lmstudio":
    case "custom": {
      return buildOpenAICompatible(provider, model);
    }
    default: {
      return buildOpenAICompatible(provider, model);
    }
  }
};

export const hasProviderCredential = async (provider: LLMProvider): Promise<boolean> => {
  const meta = getProviderMeta(provider);
  if (meta && !meta.requiresApiKey) return true;

  // For OpenAI, also check for OAuth token (ChatGPT backend path)
  if (provider === "openai") {
    const apiKey = await vault.getSecret("llm.api.openai.key");
    if (apiKey) return true;
    const config = await getProviderConfig(provider);
    if (config?.oauthTokenSecret) {
      const oauthToken = await vault.getSecret(config.oauthTokenSecret);
      if (oauthToken) return true;
    }
    return false;
  }

  // For Anthropic, also check for OAuth token (Pro/Max flow)
  if (provider === "anthropic") {
    const apiKey = await vault.getSecret("llm.api.anthropic.key");
    if (apiKey) return true;
    const oauthToken = await vault.getSecret("llm.oauth.anthropic.access_token");
    if (oauthToken) return true;
    return false;
  }

  const token = await resolveCredential(provider);
  return Boolean(token);
};
