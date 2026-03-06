import type { WebResearchProvider } from "@/lib/state/types";

export interface WebResearchProviderMeta {
  id: WebResearchProvider;
  label: string;
  requiresApiKey: boolean;
  description: string;
}

export const WEB_RESEARCH_PROVIDER_META: Record<WebResearchProvider, WebResearchProviderMeta> = {
  brave_scrape: {
    id: "brave_scrape",
    label: "Brave (No Key)",
    requiresApiKey: false,
    description: "Scrapes Brave public search pages. No API key required.",
  },
  duckduckgo_scrape: {
    id: "duckduckgo_scrape",
    label: "DuckDuckGo (No Key)",
    requiresApiKey: false,
    description: "Scrapes DuckDuckGo HTML results. No API key required.",
  },
  brave_api: {
    id: "brave_api",
    label: "Brave Search API",
    requiresApiKey: true,
    description: "Uses Brave Search JSON API with higher reliability.",
  },
  serper: {
    id: "serper",
    label: "Serper (Google)",
    requiresApiKey: true,
    description: "Uses Serper.dev Google search API.",
  },
  serpapi: {
    id: "serpapi",
    label: "SerpAPI (Google)",
    requiresApiKey: true,
    description: "Uses SerpAPI Google search endpoint.",
  },
};

export const WEB_RESEARCH_PROVIDER_ORDER: WebResearchProvider[] = [
  "brave_scrape",
  "duckduckgo_scrape",
  "brave_api",
  "serper",
  "serpapi",
];

export function requiresWebResearchApiKey(provider: WebResearchProvider): boolean {
  return WEB_RESEARCH_PROVIDER_META[provider].requiresApiKey;
}

export function webResearchApiKeySecretRef(provider: WebResearchProvider): string {
  return `web_research.provider.${provider}.api_key`;
}
