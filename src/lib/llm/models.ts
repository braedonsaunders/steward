import { getProviderConfig } from "@/lib/llm/config";
import { getProviderMeta } from "@/lib/llm/registry";
import { vault } from "@/lib/security/vault";
import type { LLMProvider } from "@/lib/state/types";

const MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_CACHE_TTL_MS = 60_000;

const modelCache = new Map<string, { fetchedAt: number; models: string[] }>();

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean))).sort();
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

async function fetchAnthropicModels(apiKeyOverride?: string): Promise<string[]> {
  const apiKey = apiKeyOverride ?? await vault.getSecret("llm.api.anthropic.key");
  const oauthToken = apiKeyOverride
    ? undefined
    : await vault.getSecret("llm.oauth.anthropic.access_token");

  if (!apiKey && !oauthToken) {
    throw new Error("Anthropic credentials are required to retrieve models.");
  }

  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  } else if (oauthToken) {
    headers.authorization = `Bearer ${oauthToken}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }

  const payload = await fetchJson("https://api.anthropic.com/v1/models", { headers });
  return parseModelIds(payload);
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

export async function listProviderModelsFromApi(
  provider: LLMProvider,
  options?: { forceRefresh?: boolean; tokenOverride?: string; baseUrlOverride?: string },
): Promise<string[]> {
  const config = await getProviderConfig(provider);
  const meta = getProviderMeta(provider);
  const token = await resolveProviderToken(provider, options?.tokenOverride);
  const baseUrl = options?.baseUrlOverride ?? config?.baseUrl ?? meta?.defaultBaseUrl;
  const cacheKey = modelCacheKey(provider, baseUrl);
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
      models = await fetchAnthropicModels(options?.tokenOverride);
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
      if (!token) {
        throw new Error("OpenAI credentials are required to retrieve models.");
      }
      models = await fetchOpenAICompatibleModels(provider, baseUrl ?? "https://api.openai.com/v1", token);
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
