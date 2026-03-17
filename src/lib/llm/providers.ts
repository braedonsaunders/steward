import { createAnthropic } from "@ai-sdk/anthropic";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";
import { createXai } from "@ai-sdk/xai";
import {
  defaultSettingsMiddleware,
  type LanguageModel,
  wrapLanguageModel,
} from "ai";
import {
  extractChatGPTAccountId,
  refreshOpenAIToken,
} from "@/lib/auth/oauth";
import {
  ensureFreshAnthropicOAuthSession,
  refreshStoredAnthropicAccessToken,
} from "@/lib/llm/anthropic-oauth";
import { getProviderConfig } from "@/lib/llm/config";
import {
  modelSupportsTemperature,
  normalizeProviderModel,
  resolveCallableAnthropicOAuthModel,
} from "@/lib/llm/models";
import {
  DEFAULT_OPENAI_OAUTH_MODEL,
  OPENAI_OAUTH_CODEX_MODEL_SET,
} from "@/lib/llm/openai-oauth-models";
import { getProviderMeta } from "@/lib/llm/registry";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import type { LLMProvider } from "@/lib/state/types";

// ---------------------------------------------------------------------------
// OpenAI Codex OAuth endpoint — same as oneshot/opencode codex.ts
// ---------------------------------------------------------------------------
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractCodexInstructionText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      const text = item.text;
      return typeof text === "string" && text.trim().length > 0
        ? [text.trim()]
        : [];
    })
    .join("\n\n");
}

function translateOpenAICodexRequestBody(rawBody: string): {
  body: string;
  upgradedToStream: boolean;
} {
  let upgradedToStream = false;

  try {
    const payload = JSON.parse(rawBody) as unknown;
    if (!isRecord(payload)) {
      return { body: rawBody, upgradedToStream };
    }

    const instructionSegments: string[] = [];
    const existingInstructions = payload.instructions;
    if (typeof existingInstructions === "string" && existingInstructions.trim().length > 0) {
      instructionSegments.push(existingInstructions.trim());
    }

    if (Array.isArray(payload.input)) {
      payload.input = payload.input.filter((item) => {
        if (!isRecord(item)) {
          return true;
        }

        const role = item.role;
        if (role !== "developer" && role !== "system") {
          return true;
        }

        const text = extractCodexInstructionText(item.content);
        if (text.length > 0) {
          instructionSegments.push(text);
        }
        return false;
      });
    }

    if (instructionSegments.length > 0) {
      payload.instructions = instructionSegments.join("\n\n");
    }

    payload.store = false;

    if ("max_output_tokens" in payload) {
      delete payload.max_output_tokens;
    }

    if (payload.stream !== true) {
      payload.stream = true;
      upgradedToStream = true;
    }

    return { body: JSON.stringify(payload), upgradedToStream };
  } catch {
    return { body: rawBody, upgradedToStream };
  }
}

function buildCodexJsonResponseFromSse(
  rawSse: string,
  response: Response,
): Response {
  let finalResponse: Record<string, unknown> | null = null;
  let streamErrorMessage: string | null = null;

  for (const line of rawSse.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }

      if (
        (parsed.type === "response.completed" || parsed.type === "response.incomplete") &&
        isRecord(parsed.response)
      ) {
        finalResponse = parsed.response;
      } else if (parsed.type === "error") {
        if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
          streamErrorMessage = parsed.message.trim();
        } else if (
          isRecord(parsed.error) &&
          typeof parsed.error.message === "string" &&
          parsed.error.message.trim().length > 0
        ) {
          streamErrorMessage = parsed.error.message.trim();
        }
      }
    } catch {
      // Ignore malformed SSE chunks and keep scanning for the final response.
    }
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");

  if (finalResponse) {
    return new Response(JSON.stringify(finalResponse), {
      status: response.status,
      headers,
    });
  }

  const errorMessage =
    streamErrorMessage ?? "Failed to convert Codex stream response into JSON.";

  return new Response(
    JSON.stringify({
      error: {
        message: errorMessage,
        type: "api_error",
        code: "codex_stream_conversion_failed",
      },
    }),
    {
      status: 502,
      headers,
    },
  );
}

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

function withModelCapabilityGuards(
  provider: LLMProvider,
  modelId: string,
  model: LanguageModelV3,
): LanguageModelV3 {
  if (modelSupportsTemperature(provider, modelId)) {
    return model;
  }

  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      if (params.temperature === undefined) {
        return params;
      }

      const nextParams = { ...params };
      delete nextParams.temperature;
      return nextParams;
    },
  };

  return wrapLanguageModel({
    model,
    middleware,
    modelId,
    providerId: provider,
  });
}

/** Build model using createOpenAI with custom baseURL (for OpenAI-compatible providers) */
const buildOpenAICompatible = async (
  provider: LLMProvider,
  model: string,
): Promise<LanguageModelV3> => {
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
  return withModelCapabilityGuards(provider, model, client.chat(model));
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
const buildOpenAICodexOAuth = async (model: string): Promise<LanguageModelV3> => {
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

    let body = init?.body;
    let upgradedToStream = false;
    if (targetUrl.toString() === CODEX_API_ENDPOINT && typeof body === "string") {
      const translated = translateOpenAICodexRequestBody(body);
      body = translated.body;
      upgradedToStream = translated.upgradedToStream;
    }

    const response = await globalThis.fetch(targetUrl, { ...init, headers, body });

    if (!upgradedToStream || !response.ok || targetUrl.toString() !== CODEX_API_ENDPOINT) {
      return response;
    }

    const rawSse = await response.text();
    return buildCodexJsonResponseFromSse(rawSse, response);
  };

  const resolvedModel = OPENAI_OAUTH_CODEX_MODEL_SET.has(model)
    ? model
    : DEFAULT_OPENAI_OAUTH_MODEL;

  const client = createOpenAI({
    apiKey: "steward-oauth-dummy-key",
    fetch: codexFetch,
  });

  // Tell the SDK the conversation is non-persistent so it serializes tool loops
  // inline instead of emitting item_reference entries that Codex rejects.
  const wrappedModel = wrapLanguageModel({
    model: client(resolvedModel),
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          openai: {
            store: false,
          },
        },
      },
    }),
  });

  return withModelCapabilityGuards("openai", resolvedModel, wrappedModel);
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
const buildAnthropicOAuth = async (model: string): Promise<LanguageModelV3> => {
  const session = await ensureFreshAnthropicOAuthSession();
  let accessToken = session.accessToken;
  if (!accessToken) {
    throw new Error(
      "Anthropic provider requires credentials. Add an API key or connect via OAuth in Settings.",
    );
  }

  let refreshToken = session.refreshToken;

  // Custom fetch interceptor (matches oneshot opencode-anthropic-auth plugin)
  const anthropicOAuthFetch = async (
    requestInput: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Refresh proactively when the in-memory token is missing.
    if (!accessToken && refreshToken) {
      try {
        const refreshed = await refreshStoredAnthropicAccessToken(refreshToken);
        accessToken = refreshed.accessToken;
        refreshToken = refreshed.refreshToken;
      } catch {
        // Use existing token
      }
    }

    if (!accessToken) {
      throw new Error(
        "Anthropic provider requires credentials. Add an API key or connect via OAuth in Settings.",
      );
    }

    const originalRequestInput = requestInput instanceof Request ? requestInput.clone() : requestInput;

    const buildAnthropicRequest = (token: string): {
      input: RequestInfo | URL;
      headers: Headers;
      target: string;
    } => {
      const requestHeaders = new Headers();

      if (originalRequestInput instanceof Request) {
        originalRequestInput.headers.forEach((value, key) => {
          requestHeaders.set(key, value);
        });
      }

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

      const incomingBeta = requestHeaders.get("anthropic-beta") || "";
      const incomingBetasList = incomingBeta
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean);

      const requiredBetas = [
        "oauth-2025-04-20",
        "interleaved-thinking-2025-05-14",
      ];
      const mergedBetas = [...new Set([...requiredBetas, ...incomingBetasList])].join(",");

      requestHeaders.set("authorization", `Bearer ${token}`);
      requestHeaders.set("anthropic-beta", mergedBetas);
      requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)");
      requestHeaders.delete("x-api-key");

      let finalInput: RequestInfo | URL = originalRequestInput;
      let requestUrl: URL | null = null;
      try {
        if (typeof originalRequestInput === "string" || originalRequestInput instanceof URL) {
          requestUrl = new URL(originalRequestInput.toString());
        } else if (originalRequestInput instanceof Request) {
          requestUrl = new URL(originalRequestInput.url);
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
          originalRequestInput instanceof Request
            ? new Request(requestUrl.toString(), originalRequestInput.clone())
            : requestUrl;
      } else if (originalRequestInput instanceof Request) {
        finalInput = originalRequestInput.clone();
      }

      const target = requestUrl?.toString()
        ?? (typeof finalInput === "string" || finalInput instanceof URL
          ? finalInput.toString()
          : finalInput instanceof Request
            ? finalInput.url
            : "Anthropic request");

      return {
        input: finalInput,
        headers: requestHeaders,
        target,
      };
    };

    const sendAnthropicRequest = async (token: string): Promise<{
      response: Response;
      body: string;
      target: string;
    }> => {
      const request = buildAnthropicRequest(token);
      const response = await globalThis.fetch(request.input, {
        ...init,
        headers: request.headers,
      });
      const body = response.ok ? "" : await response.clone().text().catch(() => "");

      return {
        response,
        body,
        target: request.target,
      };
    };

    let attempt = await sendAnthropicRequest(accessToken);
    if (!attempt.response.ok && attempt.response.status === 401 && refreshToken) {
      try {
        const refreshed = await refreshStoredAnthropicAccessToken(refreshToken);
        accessToken = refreshed.accessToken;
        refreshToken = refreshed.refreshToken;
        if (accessToken) {
          attempt = await sendAnthropicRequest(accessToken);
        }
      } catch {
        // Fall through and report the original auth failure.
      }
    }

    if (!attempt.response.ok) {
      throw new Error(
        `Anthropic OAuth request failed (${attempt.response.status} ${attempt.response.statusText}) for ${attempt.target}${attempt.body ? `: ${attempt.body}` : ""}`,
      );
    }

    return attempt.response;
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
        return withModelCapabilityGuards("openai", model, client(model));
      }

      // Priority 2: OAuth access token → ChatGPT backend via custom fetch
      // (exact same pattern as oneshot's codex.ts plugin)
      const openaiConfig = await getProviderConfig("openai");
      const oauthTokenSecret =
        openaiConfig?.oauthTokenSecret ?? "llm.oauth.openai.access_token";
      const hasToken = await vault.getSecret(oauthTokenSecret);
      if (hasToken) {
        return buildOpenAICodexOAuth(model);
      }

      throw new Error(
        "OpenAI provider requires credentials. Add an API key or connect via OAuth in Settings.",
      );
    }
    case "anthropic": {
      const anthropicModel = normalizeProviderModel("anthropic", model) ?? model;
      const anthropicOauthTokenSecret = config?.oauthTokenSecret;

      // If Anthropic OAuth is configured, keep requests on that Bearer-token path.
      const anthropicOAuthToken = await vault.getSecret(
        anthropicOauthTokenSecret ?? "llm.oauth.anthropic.access_token",
      );
      if (anthropicOAuthToken) {
        const resolvedModel = await resolveCallableAnthropicOAuthModel(anthropicModel);
        if (!modelOverride && resolvedModel.fallbackFrom && config?.model !== resolvedModel.model) {
          await stateStore.setProviderConfig({
            ...(config ?? {
              provider: "anthropic",
              enabled: true,
              model: resolvedModel.model,
            }),
            provider: "anthropic",
            model: resolvedModel.model,
            oauthTokenSecret: anthropicOauthTokenSecret ?? "llm.oauth.anthropic.access_token",
            updatedAt: new Date().toISOString(),
          });
        }
        return withModelCapabilityGuards(
          "anthropic",
          resolvedModel.model,
          await buildAnthropicOAuth(resolvedModel.model),
        );
      }

      // Priority 2: Real API key (from manual entry)
      const apiKey = await vault.getSecret("llm.api.anthropic.key");
      if (apiKey) {
        const client = createAnthropic({ apiKey });
        return withModelCapabilityGuards("anthropic", anthropicModel, client(anthropicModel));
      }

      throw new Error(
        "Anthropic provider requires credentials. Add an API key or connect via OAuth in Settings.",
      );
    }
    case "google": {
      const token = await resolveCredential("google");
      const client = createGoogleGenerativeAI({ apiKey: token });
      return withModelCapabilityGuards("google", model, client(model));
    }
    case "mistral": {
      const token = await resolveCredential("mistral");
      const client = createMistral({ apiKey: token });
      return withModelCapabilityGuards("mistral", model, client(model));
    }
    case "groq": {
      const token = await resolveCredential("groq");
      const client = createGroq({ apiKey: token });
      return withModelCapabilityGuards("groq", model, client(model));
    }
    case "xai": {
      const token = await resolveCredential("xai");
      const client = createXai({ apiKey: token });
      return withModelCapabilityGuards("xai", model, client(model));
    }
    case "cohere": {
      const token = await resolveCredential("cohere");
      const client = createCohere({ apiKey: token });
      return withModelCapabilityGuards("cohere", model, client(model));
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
    const oauthTokenSecret =
      config?.oauthTokenSecret ?? "llm.oauth.openai.access_token";
    const oauthToken = await vault.getSecret(oauthTokenSecret);
    if (oauthToken) return true;
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
