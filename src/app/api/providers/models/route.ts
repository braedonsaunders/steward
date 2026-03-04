import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { getProviderConfig } from "@/lib/llm/config";
import { getProviderMeta } from "@/lib/llm/registry";
import { vault } from "@/lib/security/vault";
import type { LLMProvider } from "@/lib/state/types";

export const runtime = "nodejs";

const TIMEOUT_MS = 8000;

// ── AI Gateway (cloud providers) ──────────────────────────────────────────

// Provider ID mapping: our registry ID → AI Gateway "owned_by" prefix
const GATEWAY_OWNER_MAP: Partial<Record<LLMProvider, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  mistral: "mistralai",
  groq: "groq",
  xai: "xai",
  cohere: "cohere",
  deepseek: "deepseek",
  perplexity: "perplexity",
};

interface GatewayModel {
  id: string;
  type: string;
  owned_by?: string;
}

// Cache gateway response in memory (refreshed on demand)
let gatewayCache: { models: GatewayModel[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchGatewayModels(force = false): Promise<GatewayModel[]> {
  if (!force && gatewayCache && Date.now() - gatewayCache.fetchedAt < CACHE_TTL_MS) {
    return gatewayCache.models;
  }

  const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    return gatewayCache?.models ?? [];
  }

  const json = (await res.json()) as { data?: GatewayModel[] };
  const models = (json.data ?? []).filter((m) => m.type === "language");
  gatewayCache = { models, fetchedAt: Date.now() };
  return models;
}

function filterGatewayModels(models: GatewayModel[], provider: LLMProvider): string[] {
  const owner = GATEWAY_OWNER_MAP[provider];
  if (!owner) return [];

  return models
    .filter((m) => {
      // Match by owned_by field or by id prefix
      if (m.owned_by === owner) return true;
      if (m.id.startsWith(`${owner}/`)) return true;
      return false;
    })
    .map((m) => {
      // Strip provider prefix from ID (e.g. "openai/gpt-4o" → "gpt-4o")
      const prefix = `${owner}/`;
      return m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id;
    })
    .sort();
}

// ── Local providers (hit their /v1/models endpoint directly) ──────────────

async function resolveApiKey(provider: LLMProvider): Promise<string | undefined> {
  const config = await getProviderConfig(provider);
  if (!config) return undefined;

  // API key stored in vault (manual entry or created via OAuth)
  const vaultKey = await vault.getSecret(`llm.api.${provider}.key`);
  if (vaultKey) return vaultKey;

  // OAuth access token from vault
  if (config.oauthTokenSecret) {
    return vault.getSecret(config.oauthTokenSecret);
  }

  return undefined;
}

async function fetchLocalModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];

  const json = (await res.json()) as { data?: Array<{ id: string }> };
  if (!json.data || !Array.isArray(json.data)) return [];
  return json.data.map((m) => m.id).sort();
}

// ── Providers not in gateway but have OpenAI-compatible /v1/models ────────

const DIRECT_API_URLS: Partial<Record<LLMProvider, string>> = {
  fireworks: "https://api.fireworks.ai/inference/v1",
  togetherai: "https://api.together.xyz/v1",
};

const OPENAI_OAUTH_CODEX_MODELS = [
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
];

// ── Route handler ─────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const provider = request.nextUrl.searchParams.get("provider") as LLMProvider | null;
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";

  if (!provider) {
    return NextResponse.json({ error: "Missing provider parameter" }, { status: 400 });
  }

  const meta = getProviderMeta(provider);
  if (!meta) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  try {
    let models: string[] = [];

    if (provider === "openai") {
      const hasOpenAIApiKey = await vault.getSecret("llm.api.openai.key");
      const hasOpenAIOAuthToken = await vault.getSecret("llm.oauth.openai.access_token");
      if (!hasOpenAIApiKey && hasOpenAIOAuthToken) {
        return NextResponse.json({ models: OPENAI_OAUTH_CODEX_MODELS });
      }
    }

    // Local providers: hit their local endpoint directly
    if (meta.category === "local") {
      const config = await getProviderConfig(provider);
      const baseUrl = config?.baseUrl ?? meta.defaultBaseUrl;
      if (baseUrl) {
        const apiKey = await resolveApiKey(provider);
        models = await fetchLocalModels(baseUrl, apiKey);
      }
    }
    // OpenRouter: hit their API directly (they have their own model IDs)
    else if (provider === "openrouter") {
      const config = await getProviderConfig(provider);
      const baseUrl = config?.baseUrl ?? meta.defaultBaseUrl ?? "https://openrouter.ai/api/v1";
      const apiKey = await resolveApiKey(provider);
      models = await fetchLocalModels(baseUrl, apiKey);
    }
    // Providers with direct APIs not in gateway
    else if (DIRECT_API_URLS[provider]) {
      const apiKey = await resolveApiKey(provider);
      if (apiKey) {
        models = await fetchLocalModels(DIRECT_API_URLS[provider]!, apiKey);
      }
    }
    // Cloud providers: use AI Gateway (no auth needed)
    else if (GATEWAY_OWNER_MAP[provider]) {
      const gatewayModels = await fetchGatewayModels(refresh);
      models = filterGatewayModels(gatewayModels, provider);
    }

    return NextResponse.json({ models });
  } catch {
    return NextResponse.json({ models: [] });
  }
}
