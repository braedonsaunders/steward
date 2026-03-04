import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getProviderConfig } from "@/lib/llm/config";
import { vault } from "@/lib/security/vault";
import type { LLMProvider } from "@/lib/state/types";

const fromEnv = (name?: string): string | undefined => {
  if (!name) {
    return undefined;
  }

  return process.env[name];
};

const resolveCredential = async (provider: LLMProvider): Promise<string | undefined> => {
  const config = await getProviderConfig(provider);
  if (!config) {
    return undefined;
  }

  const apiKeyFromEnv = fromEnv(config.apiKeyEnvVar);
  if (apiKeyFromEnv) {
    return apiKeyFromEnv;
  }

  const apiKeySecret = await vault.getSecret(`llm.api.${provider}.key`);
  if (apiKeySecret) {
    return apiKeySecret;
  }

  if (config.oauthTokenSecret) {
    return vault.getSecret(config.oauthTokenSecret);
  }

  return undefined;
};

const openRouterModel = async (model: string): Promise<LanguageModel> => {
  const config = await getProviderConfig("openrouter");
  const token = await resolveCredential("openrouter");

  const provider = createOpenAI({
    name: "openrouter",
    apiKey: token,
    baseURL: config?.baseUrl ?? "https://openrouter.ai/api/v1",
    headers: {
      ...config?.extraHeaders,
    },
  });

  return provider(model);
};

export const buildLanguageModel = async (
  provider: LLMProvider,
  modelOverride?: string,
): Promise<LanguageModel> => {
  const config = await getProviderConfig(provider);
  const model = modelOverride ?? config?.model;

  if (!model) {
    throw new Error(`Missing model for provider ${provider}`);
  }

  switch (provider) {
    case "openai": {
      const token = await resolveCredential("openai");
      if (token) {
        const client = createOpenAI({ apiKey: token });
        return client(model);
      }

      return openai(model);
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
    case "openrouter": {
      return openRouterModel(model);
    }
    default: {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }
};

export const hasProviderCredential = async (provider: LLMProvider): Promise<boolean> => {
  const token = await resolveCredential(provider);
  return Boolean(token);
};
