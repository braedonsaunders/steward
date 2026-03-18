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
  loadAnthropicOAuthSession,
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
 *     - Refreshes the token when the backend rejects it
 *  3. Use the Responses API (sdk.responses or sdk(model))
 */
const buildOpenAICodexOAuth = async (model: string): Promise<LanguageModelV3> => {
  const oauthTokenSecret = "llm.oauth.openai.access_token";

  // Load all tokens from vault upfront
  let accessToken = await vault.getSecret(oauthTokenSecret);
  let refreshToken = await vault.getSecret("llm.oauth.openai.refresh_token");
  let accountId: string | undefined =
    (await vault.getSecret("llm.oauth.openai.account_id")) ?? undefined;

  const refreshStoredOpenAIAccessToken = async (): Promise<boolean> => {
    if (!refreshToken) {
      return false;
    }

    try {
      const tokens = await refreshOpenAIToken(refreshToken);
      accessToken = tokens.access_token;
      if (tokens.refresh_token) {
        refreshToken = tokens.refresh_token;
      }

      const nextExpiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
      const newAccountId = extractChatGPTAccountId(tokens.access_token);
      if (newAccountId) {
        accountId = newAccountId;
      }

      vault.setSecret(oauthTokenSecret, accessToken).catch(() => {});
      vault.setSecret("llm.oauth.openai.expires_at", String(nextExpiresAt)).catch(() => {});
      if (tokens.refresh_token) {
        vault.setSecret("llm.oauth.openai.refresh_token", tokens.refresh_token).catch(() => {});
      }
      if (newAccountId) {
        vault.setSecret("llm.oauth.openai.account_id", newAccountId).catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  };

  if (!accessToken) {
    await refreshStoredOpenAIAccessToken();
  }

  if (!accessToken) {
    throw new Error(
      "OpenAI provider requires credentials. Add an API key or connect via OAuth in Settings.",
    );
  }

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
    if (!accessToken) {
      await refreshStoredOpenAIAccessToken();
    }

    if (!accessToken) {
      throw new Error(
        "OpenAI provider requires credentials. Add an API key or connect via OAuth in Settings.",
      );
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

    const performFetch = async (token: string): Promise<Response> => {
      headers.set("Authorization", `Bearer ${token}`);
      return globalThis.fetch(targetUrl, { ...init, headers, body });
    };

    let response = await performFetch(accessToken);

    if (response.status === 401 && await refreshStoredOpenAIAccessToken() && accessToken) {
      response = await performFetch(accessToken);
    }

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
 * Mirrored from opencode's published opencode-anthropic-auth plugin.
 */
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const ANTHROPIC_OAUTH_TOOL_PREFIX = "mcp_";

function sanitizeAnthropicOAuthSystemText(text: string): string {
  return text
    .replace(/OpenCode/g, "Claude Code")
    .replace(/opencode/gi, "Claude");
}

function rewriteAnthropicOAuthBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (!body || typeof body !== "string") {
    return body;
  }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;

    if (typeof parsed.system === "string") {
      parsed.system = sanitizeAnthropicOAuthSystemText(
        `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${parsed.system}`,
      );
    } else if (Array.isArray(parsed.system)) {
      const systemBlocks = parsed.system.map((item, index) => {
        if (!item || typeof item !== "object") {
          return item;
        }

        const block = item as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          return {
            ...block,
            text: sanitizeAnthropicOAuthSystemText(
              index === 0
                ? `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${block.text}`
                : block.text,
            ),
          };
        }
        return block;
      });

      if (systemBlocks.length === 0) {
        systemBlocks.push({
          type: "text",
          text: CLAUDE_CODE_SYSTEM_PREFIX,
        });
      }

      parsed.system = systemBlocks;
    }

    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((item) => {
        if (!item || typeof item !== "object") {
          return item;
        }

        const tool = item as Record<string, unknown>;
        return {
          ...tool,
          name: typeof tool.name === "string"
            ? `${ANTHROPIC_OAUTH_TOOL_PREFIX}${tool.name}`
            : tool.name,
        };
      });
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((item) => {
        if (!item || typeof item !== "object") {
          return item;
        }

        const message = item as Record<string, unknown>;
        if (!Array.isArray(message.content)) {
          return message;
        }

        return {
          ...message,
          content: message.content.map((block) => {
            if (!block || typeof block !== "object") {
              return block;
            }

            const contentBlock = block as Record<string, unknown>;
            if (contentBlock.type === "tool_use" && typeof contentBlock.name === "string") {
              return {
                ...contentBlock,
                name: `${ANTHROPIC_OAUTH_TOOL_PREFIX}${contentBlock.name}`,
              };
            }
            return contentBlock;
          }),
        };
      });
    }

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

async function rewriteAnthropicOAuthStream(response: Response): Promise<Response> {
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      let text = decoder.decode(value, { stream: true });
      text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, "\"name\": \"$1\"");
      controller.enqueue(encoder.encode(text));
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const buildAnthropicOAuth = async (model: string): Promise<LanguageModelV3> => {
  const session = await loadAnthropicOAuthSession();
  let accessToken = session.accessToken;
  if (!accessToken && session.refreshToken) {
    const refreshed = await refreshStoredAnthropicAccessToken(session.refreshToken);
    accessToken = refreshed.accessToken;
  }
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
    if (!accessToken && refreshToken) {
      const refreshed = await refreshStoredAnthropicAccessToken(refreshToken);
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
    }

    if (!accessToken) {
      throw new Error(
        "Anthropic provider requires credentials. Add an API key or connect via OAuth in Settings.",
      );
    }

    const requestInit = init ?? {};
    const requestHeaders = new Headers();
    if (requestInput instanceof Request) {
      requestInput.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    }
    if (requestInit.headers) {
      if (requestInit.headers instanceof Headers) {
        requestInit.headers.forEach((value, key) => {
          requestHeaders.set(key, value);
        });
      } else if (Array.isArray(requestInit.headers)) {
        for (const [key, value] of requestInit.headers) {
          if (value !== undefined) {
            requestHeaders.set(key, String(value));
          }
        }
      } else {
        for (const [key, value] of Object.entries(requestInit.headers)) {
          if (value !== undefined) {
            requestHeaders.set(key, String(value));
          }
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

    requestHeaders.set("authorization", `Bearer ${accessToken}`);
    requestHeaders.set("anthropic-beta", mergedBetas);
    requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)");
    requestHeaders.delete("x-api-key");

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
      finalInput = requestInput instanceof Request
        ? new Request(requestUrl.toString(), requestInput.clone())
        : requestUrl;
    }

    const rewrittenBody = rewriteAnthropicOAuthBody(requestInit.body);

    const performFetch = async (token: string): Promise<Response> => {
      requestHeaders.set("authorization", `Bearer ${token}`);
      return globalThis.fetch(finalInput, {
        ...requestInit,
        body: rewrittenBody,
        headers: requestHeaders,
      });
    };

    let response = await performFetch(accessToken);

    if (response.status === 401 && refreshToken) {
      const refreshed = await refreshStoredAnthropicAccessToken(refreshToken);
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
      if (accessToken) {
        response = await performFetch(accessToken);
      }
    }

    return rewriteAnthropicOAuthStream(response);
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
      const apiKey = await vault.getSecret("llm.api.anthropic.key");
      if (apiKey) {
        const client = createAnthropic({ apiKey });
        return withModelCapabilityGuards("anthropic", anthropicModel, client(anthropicModel));
      }

      const anthropicOauthTokenSecret = config?.oauthTokenSecret;
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
