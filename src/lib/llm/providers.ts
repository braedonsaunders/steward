import { createAnthropic } from "@ai-sdk/anthropic";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { getProviderConfig } from "@/lib/llm/config";
import { getProviderMeta } from "@/lib/llm/registry";
import { vault } from "@/lib/security/vault";
import type { LLMProvider } from "@/lib/state/types";

const fromEnv = (name?: string): string | undefined => {
  if (!name) return undefined;
  return process.env[name];
};

const looksLikeJwt = (value: string): boolean =>
  /^eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(value);

const resolveCredential = async (provider: LLMProvider): Promise<string | undefined> => {
  const config = await getProviderConfig(provider);
  if (!config) return undefined;

  const apiKeyFromEnv = fromEnv(config.apiKeyEnvVar);
  if (apiKeyFromEnv) return apiKeyFromEnv;

  const apiKeySecret = await vault.getSecret(`llm.api.${provider}.key`);
  if (apiKeySecret) {
    if (provider === "openai" && looksLikeJwt(apiKeySecret)) {
      return undefined;
    }
    return apiKeySecret;
  }

  if (config.oauthTokenSecret) {
    const oauthToken = await vault.getSecret(config.oauthTokenSecret);
    if (provider === "openai" && oauthToken && looksLikeJwt(oauthToken)) {
      return undefined;
    }
    return oauthToken;
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

  return client(model);
};

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
      const token = await resolveCredential("openai");
      if (!token) {
        throw new Error(
          "OpenAI provider requires a Platform API key. Set OPENAI_API_KEY or add an API key in Settings.",
        );
      }
      const client = createOpenAI({ apiKey: token });
      return client(model);
    }
    case "anthropic": {
      const token = await resolveCredential("anthropic");
      const client = createAnthropic({ apiKey: token });
      return client(model);
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
      // Fallback: try OpenAI-compatible
      return buildOpenAICompatible(provider, model);
    }
  }
};

export const hasProviderCredential = async (provider: LLMProvider): Promise<boolean> => {
  const meta = getProviderMeta(provider);
  if (meta && !meta.requiresApiKey) return true;
  const token = await resolveCredential(provider);
  return Boolean(token);
};
