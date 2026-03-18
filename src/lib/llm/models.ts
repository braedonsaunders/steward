import { createHash } from "node:crypto";
import { getProviderConfig } from "@/lib/llm/config";
import {
  type AnthropicOAuthSession,
  ensureFreshAnthropicOAuthSession,
  refreshStoredAnthropicAccessToken,
} from "@/lib/llm/anthropic-oauth";
import { listOpenAIOAuthModels } from "@/lib/llm/openai-oauth-models";
import { getProviderMeta } from "@/lib/llm/registry";
import { vault } from "@/lib/security/vault";
import type { LLMProvider } from "@/lib/state/types";

const MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_CACHE_TTL_MS = 60_000;
const ANTHROPIC_MODEL_SMOKE_TIMEOUT_MS = 12_000;
const ANTHROPIC_CALLABLE_MODEL_CACHE_TTL_MS = 10 * 60_000;

const modelCache = new Map<string, { fetchedAt: number; models: string[] }>();
const anthropicCallableModelCache = new Map<string, { fetchedAt: number; model: string }>();

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean))).sort();
}

function uniqueStable(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as Record<string, unknown>;

  // OpenAI-style: { data: [{ id: "..." }] }
  if (Array.isArray(data.data)) {
    return uniqueSorted(
      data.data.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (!item || typeof item !== "object") return [];
        const id = (item as Record<string, unknown>).id;
        return typeof id === "string" ? [id] : [];
      }),
    );
  }

  // Cohere-style: { models: [{ name: "..." }] }
  if (Array.isArray(data.models)) {
    return uniqueSorted(
      data.models.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        const name = entry.name;
        const id = entry.id;
        if (typeof name === "string") return [name];
        if (typeof id === "string") return [id];
        return [];
      }),
    );
  }

  return [];
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Model list request failed (${res.status} ${res.statusText}) for ${url}${body ? `: ${body}` : ""}`,
    );
  }

  const json = (await res.json()) as unknown;
  if (!json || typeof json !== "object") {
    throw new Error(`Invalid model list response from ${url}`);
  }
  return json as Record<string, unknown>;
}

async function resolveProviderToken(
  provider: LLMProvider,
  tokenOverride?: string,
): Promise<string | undefined> {
  if (tokenOverride) {
    return tokenOverride;
  }

  const config = await getProviderConfig(provider);
  const apiKey = await vault.getSecret(`llm.api.${provider}.key`);
  if (apiKey) return apiKey;
  if (config?.oauthTokenSecret) {
    const oauthToken = await vault.getSecret(config.oauthTokenSecret);
    if (oauthToken) return oauthToken;
  }
  return undefined;
}

function modelCacheKey(provider: LLMProvider, baseUrl?: string): string {
  return `${provider}:${baseUrl ?? ""}`;
}

function looksLikeJwtToken(token: string): boolean {
  return token.split(".").length === 3;
}

async function fetchOpenAICompatibleModels(
  provider: LLMProvider,
  baseUrl: string,
  token?: string,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const payload = await fetchJson(url, { headers });
  return parseModelIds(payload);
}

async function fetchOpenAIModels(options?: {
  tokenOverride?: string;
  baseUrl?: string;
}): Promise<string[]> {
  const explicitToken = options?.tokenOverride?.trim();
  const apiKey = explicitToken
    ? (looksLikeJwtToken(explicitToken) ? undefined : explicitToken)
    : await vault.getSecret("llm.api.openai.key");

  if (apiKey) {
    return fetchOpenAICompatibleModels(
      "openai",
      options?.baseUrl ?? "https://api.openai.com/v1",
      apiKey,
    );
  }

  const oauthToken = explicitToken
    ? (looksLikeJwtToken(explicitToken) ? explicitToken : undefined)
    : await vault.getSecret("llm.oauth.openai.access_token");

  if (oauthToken) {
    return listOpenAIOAuthModels();
  }

  throw new Error("OpenAI credentials are required to retrieve models.");
}

async function resolveOpenAIModelCacheMode(
  tokenOverride?: string,
): Promise<"api-key" | "oauth" | "missing"> {
  const explicitToken = tokenOverride?.trim();
  if (explicitToken) {
    return looksLikeJwtToken(explicitToken) ? "oauth" : "api-key";
  }

  const apiKey = await vault.getSecret("llm.api.openai.key");
  if (apiKey) {
    return "api-key";
  }

  const oauthToken = await vault.getSecret("llm.oauth.openai.access_token");
  if (oauthToken) {
    return "oauth";
  }

  return "missing";
}

async function fetchGoogleModels(options?: {
  apiKeyOverride?: string;
  bearerToken?: string;
}): Promise<string[]> {
  const models: string[] = [];
  let pageToken: string | undefined;
  const apiKey = options?.apiKeyOverride ?? await vault.getSecret("llm.api.google.key");

  for (let i = 0; i < 5; i++) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    if (apiKey) {
      url.searchParams.set("key", apiKey);
    }
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const headers: Record<string, string> = {};
    if (!apiKey && options?.bearerToken) {
      headers.Authorization = `Bearer ${options.bearerToken}`;
    }

    const payload = await fetchJson(url.toString(), { headers });
    const pageModels = Array.isArray(payload.models)
      ? payload.models as Array<Record<string, unknown>>
      : [];

    for (const model of pageModels) {
      const rawName = typeof model.name === "string" ? model.name : "";
      const methods = Array.isArray(model.supportedGenerationMethods)
        ? model.supportedGenerationMethods.filter((m): m is string => typeof m === "string")
        : [];
      if (!rawName) continue;
      if (methods.length > 0 && !methods.includes("generateContent")) continue;
      models.push(rawName.replace(/^models\//, ""));
    }

    const next = payload.nextPageToken;
    if (typeof next === "string" && next.length > 0) {
      pageToken = next;
      continue;
    }
    break;
  }

  return uniqueSorted(models);
}

async function fetchAnthropicModels(options?: {
  apiKeyOverride?: string;
  oauthTokenOverride?: string;
}): Promise<string[]> {
  let apiKey: string | undefined;
  let oauthSession: AnthropicOAuthSession | undefined;
  let oauthToken = options?.oauthTokenOverride;

  if (oauthToken) {
    apiKey = undefined;
  } else if (options?.apiKeyOverride) {
    apiKey = options.apiKeyOverride;
  } else {
    apiKey = await vault.getSecret("llm.api.anthropic.key");
  }

  if (!apiKey && !oauthToken) {
    oauthSession = await ensureFreshAnthropicOAuthSession();
    oauthToken = oauthSession.accessToken;
  }

  if (!apiKey && !oauthToken) {
    throw new Error("Anthropic credentials are required to retrieve models.");
  }

  const sendRequest = async (token?: string): Promise<Response> => {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };

    if (apiKey) {
      headers["x-api-key"] = apiKey;
    } else if (token) {
      headers.authorization = `Bearer ${token}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    }

    return fetch("https://api.anthropic.com/v1/models", {
      headers,
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
  };

  let response = await sendRequest(oauthToken);
  if (!response.ok && response.status === 401 && oauthSession?.refreshToken) {
    oauthSession = await refreshStoredAnthropicAccessToken(oauthSession.refreshToken);
    oauthToken = oauthSession.accessToken;
    if (oauthToken) {
      response = await sendRequest(oauthToken);
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Model list request failed (${response.status} ${response.statusText}) for https://api.anthropic.com/v1/models${body ? `: ${body}` : ""}`,
    );
  }

  const payload = await response.json() as Record<string, unknown>;
  return parseModelIds(payload);
}

export interface AnthropicOAuthModelResolution {
  model: string;
  fallbackFrom?: string;
}

function anthropicFallbackRank(model: string): number {
  if (/^claude-3-/i.test(model)) return 1;
  return 0;
}

function sortAnthropicFallbackModels(models: string[]): string[] {
  return [...models].sort((a, b) => {
    const rankDiff = anthropicFallbackRank(a) - anthropicFallbackRank(b);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return b.localeCompare(a);
  });
}

function anthropicCallableModelCacheKey(accessToken: string, preferredModel?: string): string {
  const accessTokenHash = createHash("sha256").update(accessToken).digest("hex");
  return `${accessTokenHash}:${preferredModel ?? ""}`;
}

async function probeAnthropicOAuthModel(
  model: string,
  accessToken: string,
): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.2 (external, cli)",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "Reply with OK only." }],
    }),
    signal: AbortSignal.timeout(ANTHROPIC_MODEL_SMOKE_TIMEOUT_MS),
  });
}

export async function resolveCallableAnthropicOAuthModel(
  preferredModel?: string,
  options?: { models?: string[]; oauthTokenOverride?: string },
): Promise<AnthropicOAuthModelResolution> {
  const normalizedPreferred = normalizeProviderModel("anthropic", preferredModel) ?? preferredModel?.trim();
  const session = options?.oauthTokenOverride
    ? { accessToken: options.oauthTokenOverride, refreshToken: undefined, expiresAt: 0 }
    : await ensureFreshAnthropicOAuthSession();
  let accessToken = session.accessToken;
  let refreshToken = session.refreshToken;

  if (!accessToken) {
    throw new Error("Anthropic OAuth credentials are required to validate callable models.");
  }

  const cacheKey = anthropicCallableModelCacheKey(accessToken, normalizedPreferred);
  const cached = anthropicCallableModelCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ANTHROPIC_CALLABLE_MODEL_CACHE_TTL_MS) {
    return {
      model: cached.model,
      ...(normalizedPreferred && cached.model !== normalizedPreferred
        ? { fallbackFrom: normalizedPreferred }
        : {}),
    };
  }

  const probeCandidate = async (model: string): Promise<boolean> => {
    const currentAccessToken = accessToken;
    if (!currentAccessToken) {
      throw new Error("Anthropic OAuth access token is unavailable during model validation.");
    }

    let response = await probeAnthropicOAuthModel(model, currentAccessToken);

    if (!options?.oauthTokenOverride && response.status === 401 && refreshToken) {
      const refreshed = await refreshStoredAnthropicAccessToken(refreshToken);
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
      if (accessToken) {
        response = await probeAnthropicOAuthModel(model, accessToken);
      }
    }

    if (response.ok) {
      return true;
    }

    if (response.status === 429 || response.status >= 500) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Anthropic model validation failed (${response.status} ${response.statusText}) for ${model}${body ? `: ${body}` : ""}`,
      );
    }

    return false;
  };

  const availableModels = options?.models
    ? uniqueStable(options.models.map((model) => normalizeProviderModel("anthropic", model) ?? model))
    : await fetchAnthropicModels({ oauthTokenOverride: accessToken });
  const fallbackCandidates = sortAnthropicFallbackModels(
    availableModels.filter((model) => model !== normalizedPreferred),
  );
  const candidates = uniqueStable([normalizedPreferred, ...fallbackCandidates]);

  for (const candidate of candidates) {
    if (await probeCandidate(candidate)) {
      anthropicCallableModelCache.set(cacheKey, {
        fetchedAt: Date.now(),
        model: candidate,
      });
      return {
        model: candidate,
        ...(normalizedPreferred && candidate !== normalizedPreferred
          ? { fallbackFrom: normalizedPreferred }
          : {}),
      };
    }
  }

  throw new Error(
    `Anthropic OAuth session could list models but none accepted a minimal /v1/messages request. Tried: ${candidates.join(", ")}`,
  );
}

async function fetchCohereModels(token: string): Promise<string[]> {
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const payload = await fetchJson("https://api.cohere.com/v1/models", { headers });
    const models = parseModelIds(payload);
    if (models.length > 0) return models;
  } catch {
    // Try v2 endpoint below.
  }

  const payload = await fetchJson("https://api.cohere.com/v2/models", { headers });
  return parseModelIds(payload);
}

export function normalizeProviderModel(provider: LLMProvider, model?: string): string | undefined {
  if (!model) return model;
  if (provider !== "anthropic") return model.trim();

  const semverAliasMatch = /^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)$/i.exec(model.trim());
  if (!semverAliasMatch) return model.trim();
  const [, family, major, minor] = semverAliasMatch;
  return `claude-${family.toLowerCase()}-${major}-${minor}`;
}

const OPENAI_REASONING_MODEL_PATTERN = /^(gpt-5(?:[.-]|$)|o1(?:[.-]|$)|o3(?:[.-]|$)|o4(?:[.-]|$))/i;
const DEEPSEEK_REASONING_MODEL_PATTERN = /^deepseek-reasoner$/i;

export function modelSupportsTemperature(provider: LLMProvider, model?: string): boolean {
  const normalizedModel = normalizeProviderModel(provider, model)?.toLowerCase() ?? "";
  if (!normalizedModel) {
    return true;
  }

  switch (provider) {
    case "openai":
      return !OPENAI_REASONING_MODEL_PATTERN.test(normalizedModel);
    case "deepseek":
      return !DEEPSEEK_REASONING_MODEL_PATTERN.test(normalizedModel);
    default:
      return true;
  }
}

export async function listProviderModelsFromApi(
  provider: LLMProvider,
  options?: {
    forceRefresh?: boolean;
    tokenOverride?: string;
    oauthTokenOverride?: string;
    baseUrlOverride?: string;
  },
): Promise<string[]> {
  const config = await getProviderConfig(provider);
  const meta = getProviderMeta(provider);
  const token = await resolveProviderToken(provider, options?.tokenOverride);
  const baseUrl = options?.baseUrlOverride ?? config?.baseUrl ?? meta?.defaultBaseUrl;
  const cacheMode = provider === "openai"
    ? await resolveOpenAIModelCacheMode(options?.tokenOverride)
    : undefined;
  const cacheKey = modelCacheKey(
    provider,
    cacheMode ? `${baseUrl ?? ""}:${cacheMode}` : baseUrl,
  );
  const forceRefresh = options?.forceRefresh === true;

  if (!forceRefresh) {
    const cached = modelCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < MODEL_LIST_CACHE_TTL_MS) {
      return cached.models;
    }
  }

  let models: string[] = [];

  switch (provider) {
    case "anthropic": {
      models = await fetchAnthropicModels({
        apiKeyOverride: options?.tokenOverride,
        oauthTokenOverride: options?.oauthTokenOverride,
      });
      break;
    }
    case "google": {
      const googleApiKey = options?.tokenOverride ?? await vault.getSecret("llm.api.google.key");
      const googleOAuthToken = googleApiKey ? undefined : token;
      if (!googleApiKey && !googleOAuthToken) {
        throw new Error("Google credentials are required to retrieve models.");
      }
      models = await fetchGoogleModels({
        apiKeyOverride: googleApiKey,
        bearerToken: googleOAuthToken,
      });
      break;
    }
    case "cohere": {
      if (!token) {
        throw new Error("Cohere API key is required to retrieve models.");
      }
      models = await fetchCohereModels(token);
      break;
    }
    case "openai": {
      models = await fetchOpenAIModels({
        tokenOverride: options?.tokenOverride ?? token,
        baseUrl: baseUrl ?? "https://api.openai.com/v1",
      });
      break;
    }
    case "mistral": {
      if (!token) {
        throw new Error("Mistral API key is required to retrieve models.");
      }
      models = await fetchOpenAICompatibleModels(provider, baseUrl ?? "https://api.mistral.ai/v1", token);
      break;
    }
    case "groq": {
      if (!token) {
        throw new Error("Groq API key is required to retrieve models.");
      }
      models = await fetchOpenAICompatibleModels(provider, baseUrl ?? "https://api.groq.com/openai/v1", token);
      break;
    }
    case "xai": {
      if (!token) {
        throw new Error("xAI API key is required to retrieve models.");
      }
      models = await fetchOpenAICompatibleModels(provider, baseUrl ?? "https://api.x.ai/v1", token);
      break;
    }
    case "deepseek":
    case "perplexity":
    case "fireworks":
    case "togetherai":
    case "openrouter": {
      if (!token) {
        throw new Error(`${provider} credentials are required to retrieve models.`);
      }
      if (!baseUrl) {
        throw new Error(`No base URL configured for provider ${provider}.`);
      }
      models = await fetchOpenAICompatibleModels(provider, baseUrl, token);
      break;
    }
    case "ollama":
    case "lmstudio":
    case "custom": {
      if (!baseUrl) {
        throw new Error(`No base URL configured for provider ${provider}.`);
      }
      models = await fetchOpenAICompatibleModels(provider, baseUrl, token);
      break;
    }
    default: {
      throw new Error(`Provider ${provider} does not support model listing.`);
    }
  }

  const normalized = uniqueSorted(models.map((model) => normalizeProviderModel(provider, model) ?? model));
  modelCache.set(cacheKey, { fetchedAt: Date.now(), models: normalized });
  return normalized;
}
