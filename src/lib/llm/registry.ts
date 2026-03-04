import type { LLMProvider } from "@/lib/state/types";

export type ProviderCategory = "cloud" | "local" | "aggregator";

export type OAuthMethod = "redirect" | "localhost" | "code-paste" | "openrouter";

export interface ProviderMeta {
  id: LLMProvider;
  label: string;
  category: ProviderCategory;
  description: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  apiKeyPlaceholder?: string;
  requiresApiKey: boolean;
  /** Supports OAuth flow via /api/providers/oauth/start */
  supportsOAuth?: boolean;
  /** Which OAuth method to use */
  oauthMethod?: OAuthMethod;
  /** URL to the provider's console/dashboard where users create API keys */
  consoleUrl?: string;
  /** Uses @ai-sdk/openai createOpenAI() with custom baseURL */
  openaiCompatible?: boolean;
}

export const PROVIDER_REGISTRY: ProviderMeta[] = [
  // ── Cloud providers ──────────────────────────────────────────────────
  {
    id: "openai",
    label: "OpenAI",
    category: "cloud",
    description: "GPT-4o, GPT-4o-mini, o1, o3 and more",
    defaultModel: "gpt-4o-mini",
    apiKeyPlaceholder: "sk-...",
    requiresApiKey: true,
    supportsOAuth: true,
    oauthMethod: "localhost",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    category: "cloud",
    description: "Claude Opus, Sonnet, Haiku",
    defaultModel: "claude-sonnet-4-20250514",
    apiKeyPlaceholder: "sk-ant-...",
    requiresApiKey: true,
    supportsOAuth: true,
    oauthMethod: "code-paste",
    consoleUrl: "https://platform.claude.com/settings/keys",
  },
  {
    id: "google",
    label: "Google",
    category: "cloud",
    description: "Gemini 2.5 Pro, Flash, and more",
    defaultModel: "gemini-2.0-flash",
    apiKeyPlaceholder: "AIza...",
    requiresApiKey: true,
    supportsOAuth: true,
    oauthMethod: "redirect",
    consoleUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "mistral",
    label: "Mistral",
    category: "cloud",
    description: "Mistral Large, Medium, Small, Codestral",
    defaultModel: "mistral-large-latest",
    apiKeyPlaceholder: "...",
    requiresApiKey: true,
    consoleUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "groq",
    label: "Groq",
    category: "cloud",
    description: "Ultra-fast inference for Llama, Mixtral, Gemma",
    defaultModel: "llama-3.3-70b-versatile",
    apiKeyPlaceholder: "gsk_...",
    requiresApiKey: true,
    consoleUrl: "https://console.groq.com/keys",
  },
  {
    id: "xai",
    label: "xAI",
    category: "cloud",
    description: "Grok models",
    defaultModel: "grok-3-mini-fast",
    apiKeyPlaceholder: "xai-...",
    requiresApiKey: true,
    consoleUrl: "https://console.x.ai",
  },
  {
    id: "cohere",
    label: "Cohere",
    category: "cloud",
    description: "Command R, Command R+, Embed",
    defaultModel: "command-r-plus",
    apiKeyPlaceholder: "...",
    requiresApiKey: true,
    consoleUrl: "https://dashboard.cohere.com/api-keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    category: "cloud",
    description: "DeepSeek V3, R1 reasoning models",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    apiKeyPlaceholder: "sk-...",
    requiresApiKey: true,
    openaiCompatible: true,
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    category: "cloud",
    description: "Sonar models with built-in search",
    defaultModel: "sonar-pro",
    defaultBaseUrl: "https://api.perplexity.ai",
    apiKeyPlaceholder: "pplx-...",
    requiresApiKey: true,
    openaiCompatible: true,
    consoleUrl: "https://www.perplexity.ai/settings/api",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    category: "cloud",
    description: "Fast inference for open models",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyPlaceholder: "fw_...",
    requiresApiKey: true,
    openaiCompatible: true,
    consoleUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "togetherai",
    label: "Together AI",
    category: "cloud",
    description: "Run open models on fast infrastructure",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
    defaultBaseUrl: "https://api.together.xyz/v1",
    apiKeyPlaceholder: "...",
    requiresApiKey: true,
    openaiCompatible: true,
    consoleUrl: "https://api.together.xyz/settings/api-keys",
  },

  // ── Aggregators ──────────────────────────────────────────────────────
  {
    id: "openrouter",
    label: "OpenRouter",
    category: "aggregator",
    description: "Unified API for 200+ models from all providers",
    defaultModel: "openai/gpt-4o-mini",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    apiKeyPlaceholder: "sk-or-...",
    requiresApiKey: true,
    supportsOAuth: true,
    oauthMethod: "openrouter",
    openaiCompatible: true,
    consoleUrl: "https://openrouter.ai/settings/keys",
  },

  // ── Local providers ──────────────────────────────────────────────────
  {
    id: "ollama",
    label: "Ollama",
    category: "local",
    description: "Run open models locally via Ollama",
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    openaiCompatible: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    category: "local",
    description: "Local model server with GUI",
    defaultModel: "loaded-model",
    defaultBaseUrl: "http://localhost:1234/v1",
    requiresApiKey: false,
    openaiCompatible: true,
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    category: "local",
    description: "Any OpenAI-compatible API endpoint",
    defaultModel: "",
    defaultBaseUrl: "http://localhost:8080/v1",
    requiresApiKey: false,
    openaiCompatible: true,
  },
];

export const PROVIDER_MAP = new Map(
  PROVIDER_REGISTRY.map((p) => [p.id, p]),
);

export const ALL_PROVIDER_IDS = PROVIDER_REGISTRY.map((p) => p.id);

export function getProviderMeta(id: LLMProvider): ProviderMeta | undefined {
  return PROVIDER_MAP.get(id);
}
