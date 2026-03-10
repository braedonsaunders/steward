import {
  requiresWebResearchApiKey,
  WEB_RESEARCH_PROVIDER_ORDER,
} from "@/lib/assistant/web-research-config";
import { loadPlaywrightChromiumRuntime } from "@/lib/runtime/playwright";
import type { WebResearchFallbackStrategy, WebResearchProvider } from "@/lib/state/types";

interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
  finalUrl: string;
  contentType: string;
  error?: string;
}

export interface WebResearchHit {
  position: number;
  title: string;
  url: string;
  displayUrl: string;
  snippet: string;
  domain: string;
}

export interface WebResearchPage {
  position: number;
  title: string;
  url: string;
  finalUrl: string;
  excerpt: string;
  domain: string;
}

export interface WebResearchResult {
  ok: boolean;
  engine: WebResearchProvider;
  query: string;
  resultCount: number;
  consultedCount: number;
  readStartIndex: number;
  readEndIndex: number;
  hasMoreResultsToRead: boolean;
  nextReadFromResult: number | null;
  summary: string;
  results: WebResearchHit[];
  consultedPages: WebResearchPage[];
  warnings: string[];
}

interface FetchJsonResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  json: unknown;
  error?: string;
}

export interface WebResearchOptions {
  provider?: WebResearchProvider;
  apiKey?: string;
  apiKeys?: Partial<Record<WebResearchProvider, string>>;
  fallbackStrategy?: WebResearchFallbackStrategy;
  timeoutMs?: number;
  maxResults?: number;
  deepReadPages?: number;
  searchPages?: number;
  readFromResult?: number;
}

const BRAVE_SEARCH_URL = "https://search.brave.com/search";
const DUCKDUCKGO_HTML_SEARCH_URL = "https://html.duckduckgo.com/html/";
const BRAVE_API_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const SERPER_SEARCH_URL = "https://google.serper.dev/search";
const SERPAPI_SEARCH_URL = "https://serpapi.com/search.json";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Steward/1.0";
const MAX_RESULT_HTML_CHARS = 600_000;
const MAX_PAGE_HTML_CHARS = 450_000;
const SEARCH_RESULT_SNIPPET_CHARS = 320;
const PAGE_EXCERPT_CHARS = 1_800;
const MIN_DIRECT_FETCH_TEXT_CHARS = 280;
const MAX_RESULTS_LIMIT = 80;
const MAX_DEEP_READ_PAGES_LIMIT = 40;
const MAX_SEARCH_PAGES_LIMIT = 10;
const DEFAULT_RESULTS_PER_PAGE_HINT = 8;
const MAX_DEEP_READ_CONCURRENCY = 4;
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".lan", ".home", ".home.arpa"];
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

type PlaywrightModule = {
  chromium: {
    launch: (options: Record<string, unknown>) => Promise<{
      newContext: (options: Record<string, unknown>) => Promise<{
        newPage: () => Promise<{
          goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
          title: () => Promise<string>;
          url: () => string;
          evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
          close: () => Promise<void>;
        }>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
  };
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&([a-z]+);/gi, (match: string, entity: string) => NAMED_ENTITIES[entity.toLowerCase()] ?? match);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stripHtml(value: string): string {
  const withoutNoise = value
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return collapseWhitespace(decodeHtmlEntities(withoutNoise));
}

function htmlTitle(raw: string): string {
  const match = raw.match(/<title[^>]*>([\s\S]{1,240}?)<\/title>/i);
  return collapseWhitespace(stripHtml(match?.[1] ?? ""));
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isBlockedResearchHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host === "localhost.localdomain") return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":")) {
    return host === "::1"
      || host.startsWith("fe80:")
      || host.startsWith("fc")
      || host.startsWith("fd");
  }
  return false;
}

function toPublicUrl(raw: string | undefined): string | null {
  const value = decodeHtmlEntities(raw ?? "").trim();
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value, BRAVE_SEARCH_URL);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (isBlockedResearchHost(parsed.hostname)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-CA,en-US;q=0.9,en;q=0.8",
        "User-Agent": DEFAULT_USER_AGENT,
      },
      signal: controller.signal,
    });

    return {
      ok: response.ok,
      status: response.status,
      text: (await response.text()).slice(0, MAX_PAGE_HTML_CHARS),
      finalUrl: response.url,
      contentType: response.headers.get("content-type") ?? "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      finalUrl: url,
      contentType: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseBraveSearchResults(html: string, maxResults: number): WebResearchHit[] {
  const markers = Array.from(html.matchAll(/data-pos="(\d+)"\s+data-type="web"/g));
  const results: WebResearchHit[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < markers.length && results.length < maxResults; index += 1) {
    const start = markers[index].index ?? 0;
    const end = markers[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);

    const url = toPublicUrl(
      block.match(/<a href="([^"]+)"[^>]*class="[^"]*\bl1\b[^"]*"/i)?.[1]
        ?? block.match(/<a href="([^"]+)"/i)?.[1],
    );
    if (!url || seen.has(url)) {
      continue;
    }

    const title = collapseWhitespace(stripHtml(
      block.match(/<div class="title[^"]*"[^>]*title="([^"]+)"/i)?.[1]
        ?? block.match(/<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]
        ?? "",
    ));
    if (!title) {
      continue;
    }

    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch {
      continue;
    }

    const displayUrl = collapseWhitespace(stripHtml(
      block.match(/<cite class="snippet-url[^"]*"[^>]*>([\s\S]*?)<\/cite>/i)?.[1] ?? domain,
    ));
    const snippet = truncate(
      collapseWhitespace(stripHtml(
        block.match(/<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "",
      )),
      SEARCH_RESULT_SNIPPET_CHARS,
    );

    seen.add(url);
    results.push({
      position: results.length + 1,
      title,
      url,
      displayUrl: displayUrl || domain,
      snippet,
      domain,
    });
  }

  return results;
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  init?: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string },
): Promise<FetchJsonResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: init?.method ?? "GET",
      redirect: "follow",
      headers: {
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-CA,en-US;q=0.9,en;q=0.8",
        "User-Agent": DEFAULT_USER_AGENT,
        ...(init?.headers ?? {}),
      },
      body: init?.body,
      signal: controller.signal,
    });

    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    const fallbackError = truncate(stripHtml(text), 240);
    const error = response.ok ? undefined : (describeJsonError(json) ?? (fallbackError || undefined));

    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      json,
      error,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      json: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function describeJsonError(json: unknown): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }

  const messageParts: string[] = [];
  const record = json as Record<string, unknown>;

  if (typeof record.error === "string" && record.error.trim()) {
    messageParts.push(record.error.trim());
  }
  if (typeof record.message === "string" && record.message.trim()) {
    messageParts.push(record.message.trim());
  }

  const nestedError = typeof record.error === "object" && record.error
    ? record.error as Record<string, unknown>
    : null;

  if (nestedError) {
    const detail = typeof nestedError.detail === "string" ? nestedError.detail.trim() : "";
    if (detail) {
      messageParts.push(detail);
    }

    const meta = typeof nestedError.meta === "object" && nestedError.meta
      ? nestedError.meta as Record<string, unknown>
      : null;
    const errors = Array.isArray(meta?.errors) ? meta.errors : [];
    if (errors.length > 0) {
      const first = errors[0];
      if (first && typeof first === "object") {
        const firstRecord = first as Record<string, unknown>;
        const loc = Array.isArray(firstRecord.loc)
          ? firstRecord.loc.filter((part): part is string => typeof part === "string").join(".")
          : "";
        const msg = typeof firstRecord.msg === "string" ? firstRecord.msg.trim() : "";
        if (loc || msg) {
          messageParts.push([loc, msg].filter(Boolean).join(": "));
        }
      }
    }
  }

  const unique = Array.from(new Set(messageParts.filter(Boolean)));
  return unique.length > 0 ? unique.join(" | ") : undefined;
}

function toHit(raw: { title: string; url: string; snippet?: string }, position: number): WebResearchHit | null {
  const safeUrl = toPublicUrl(raw.url);
  if (!safeUrl) {
    return null;
  }
  const title = collapseWhitespace(raw.title);
  if (!title) {
    return null;
  }
  let domain = "";
  try {
    domain = new URL(safeUrl).hostname;
  } catch {
    return null;
  }
  const snippet = truncate(collapseWhitespace(raw.snippet ?? ""), SEARCH_RESULT_SNIPPET_CHARS);
  return {
    position,
    title,
    url: safeUrl,
    displayUrl: domain,
    snippet,
    domain,
  };
}

async function searchBraveApi(
  query: string,
  page: number,
  maxResults: number,
  timeoutMs: number,
  apiKey: string,
): Promise<{ ok: boolean; status: number; error?: string; results: WebResearchHit[]; hasMoreResults: boolean }> {
  const pageSize = Math.max(1, Math.min(maxResults, 20));
  const offset = Math.max(0, Math.min(9, page - 1));
  const url = new URL(BRAVE_API_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(pageSize));
  url.searchParams.set("offset", String(offset));

  const response = await fetchJson(url.toString(), timeoutMs, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: response.error,
      results: [],
      hasMoreResults: false,
    };
  }

  const payload = response.json as {
    query?: { more_results_available?: boolean };
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const items = payload.web?.results ?? [];
  const hits: WebResearchHit[] = [];
  for (const item of items) {
    const parsed = toHit(
      {
        title: item.title ?? "",
        url: item.url ?? "",
        snippet: item.description ?? "",
      },
      hits.length + 1,
    );
    if (parsed) {
      hits.push(parsed);
    }
    if (hits.length >= maxResults) {
      break;
    }
  }

  return {
    ok: true,
    status: response.status,
    results: hits,
    hasMoreResults: Boolean(payload.query?.more_results_available),
  };
}

async function searchSerperApi(
  query: string,
  page: number,
  maxResults: number,
  timeoutMs: number,
  apiKey: string,
): Promise<{ ok: boolean; status: number; error?: string; results: WebResearchHit[] }> {
  const response = await fetchJson(SERPER_SEARCH_URL, timeoutMs, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: maxResults, page }),
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: response.error,
      results: [],
    };
  }

  const payload = response.json as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  const items = payload.organic ?? [];
  const hits: WebResearchHit[] = [];
  for (const item of items) {
    const parsed = toHit(
      {
        title: item.title ?? "",
        url: item.link ?? "",
        snippet: item.snippet ?? "",
      },
      hits.length + 1,
    );
    if (parsed) {
      hits.push(parsed);
    }
    if (hits.length >= maxResults) {
      break;
    }
  }

  return { ok: true, status: response.status, results: hits };
}

async function searchSerpApi(
  query: string,
  page: number,
  maxResults: number,
  timeoutMs: number,
  apiKey: string,
): Promise<{ ok: boolean; status: number; error?: string; results: WebResearchHit[] }> {
  const start = Math.max(0, (page - 1) * maxResults);
  const url = new URL(SERPAPI_SEARCH_URL);
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(maxResults));
  url.searchParams.set("start", String(start));
  url.searchParams.set("api_key", apiKey);

  const response = await fetchJson(url.toString(), timeoutMs);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: response.error,
      results: [],
    };
  }

  const payload = response.json as {
    organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  const items = payload.organic_results ?? [];
  const hits: WebResearchHit[] = [];
  for (const item of items) {
    const parsed = toHit(
      {
        title: item.title ?? "",
        url: item.link ?? "",
        snippet: item.snippet ?? "",
      },
      hits.length + 1,
    );
    if (parsed) {
      hits.push(parsed);
    }
    if (hits.length >= maxResults) {
      break;
    }
  }

  return { ok: true, status: response.status, results: hits };
}

function parseBraveNextPageUrl(html: string): string | null {
  const nextHref =
    html.match(/<a[^>]+href="([^"]+)"[^>]*aria-label="Next"/i)?.[1]
    ?? html.match(/<a[^>]+aria-label="Next"[^>]*href="([^"]+)"/i)?.[1]
    ?? html.match(/<a[^>]+href="([^"]+)"[^>]*rel="next"/i)?.[1]
    ?? html.match(/<a[^>]+rel="next"[^>]*href="([^"]+)"/i)?.[1];
  return toPublicUrl(nextHref);
}

function buildDuckDuckGoSearchUrl(query: string, page: number): string {
  const url = new URL(DUCKDUCKGO_HTML_SEARCH_URL);
  url.searchParams.set("q", query);
  if (page > 1) {
    url.searchParams.set("s", String((page - 1) * DEFAULT_RESULTS_PER_PAGE_HINT));
  }
  return url.toString();
}

function parseDuckDuckGoResults(html: string, maxResults: number): WebResearchHit[] {
  const blocks = Array.from(html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi));
  const results: WebResearchHit[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (results.length >= maxResults) {
      break;
    }
    const url = toPublicUrl(block[1]);
    if (!url || seen.has(url)) {
      continue;
    }
    const title = collapseWhitespace(stripHtml(block[2] ?? ""));
    if (!title) {
      continue;
    }
    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch {
      continue;
    }

    const titleEscaped = block[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const snippetMatch = html.match(new RegExp(`${titleEscaped}[\\s\\S]{0,600}?<a[^>]*class=\"[^\"]*result__snippet[^\"]*\"[^>]*>([\\s\\S]*?)<\\/a>`, "i"));
    const snippet = truncate(collapseWhitespace(stripHtml(snippetMatch?.[1] ?? "")), SEARCH_RESULT_SNIPPET_CHARS);

    seen.add(url);
    results.push({
      position: results.length + 1,
      title,
      url,
      displayUrl: domain,
      snippet,
      domain,
    });
  }

  return results;
}

function buildBraveSearchUrl(query: string, page: number): string {
  const searchUrl = new URL(BRAVE_SEARCH_URL);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("source", "web");
  searchUrl.searchParams.set("summary", "0");
  if (page > 1) {
    searchUrl.searchParams.set("page", String(page));
  }
  return searchUrl.toString();
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, values.length));
  const results = new Array<R>(values.length);
  let cursor = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  const chromium = await loadPlaywrightChromiumRuntime();
  return chromium ? { chromium: chromium as PlaywrightModule["chromium"] } : null;
}

async function renderPageWithPlaywright(url: string, timeoutMs: number): Promise<WebResearchPage | null> {
  const playwright = await loadPlaywright();
  if (!playwright) {
    return null;
  }

  let browser: Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>> | null = null;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: DEFAULT_USER_AGENT,
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const finalUrl = toPublicUrl(page.url()) ?? url;
    const text = collapseWhitespace(await page.evaluate(() => document.body?.innerText ?? ""));
    const title = collapseWhitespace(await page.title());
    await page.close();
    await context.close();

    if (!text) {
      return null;
    }

    return {
      position: 0,
      title: title || finalUrl,
      url,
      finalUrl,
      excerpt: truncate(text, PAGE_EXCERPT_CHARS),
      domain: new URL(finalUrl).hostname,
    };
  } catch {
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // no-op
      }
    }
  }
}

async function readPublicPage(url: string, timeoutMs: number): Promise<WebResearchPage | null> {
  const fetched = await fetchText(url, timeoutMs);
  if (fetched.ok) {
    const finalUrl = toPublicUrl(fetched.finalUrl);
    if (finalUrl) {
      const contentType = fetched.contentType.toLowerCase();
      const title = contentType.includes("html") ? htmlTitle(fetched.text) : "";
      const excerpt = truncate(
        stripHtml(contentType.includes("html") ? fetched.text : fetched.text.slice(0, MAX_PAGE_HTML_CHARS)),
        PAGE_EXCERPT_CHARS,
      );
      if (excerpt.length >= MIN_DIRECT_FETCH_TEXT_CHARS || !contentType.includes("html")) {
        return {
          position: 0,
          title: title || finalUrl,
          url,
          finalUrl,
          excerpt,
          domain: new URL(finalUrl).hostname,
        };
      }
    }
  }

  return renderPageWithPlaywright(url, timeoutMs);
}

export async function runWebResearch(
  query: string,
  options: WebResearchOptions = {},
): Promise<WebResearchResult> {
  const trimmedQuery = query.trim();
  const provider = options.provider ?? "brave_scrape";
  const availableApiKeys: Partial<Record<WebResearchProvider, string>> = {
    brave_api: options.apiKeys?.brave_api?.trim() ?? (provider === "brave_api" ? options.apiKey?.trim() : undefined),
    serper: options.apiKeys?.serper?.trim() ?? (provider === "serper" ? options.apiKey?.trim() : undefined),
    serpapi: options.apiKeys?.serpapi?.trim() ?? (provider === "serpapi" ? options.apiKey?.trim() : undefined),
  };
  const fallbackStrategy = options.fallbackStrategy ?? "prefer_non_key";
  const timeoutMs = clampInt(options.timeoutMs, 3_000, 60_000, 18_000);
  const maxResults = clampInt(options.maxResults, 1, MAX_RESULTS_LIMIT, 5);
  const deepReadPages = clampInt(options.deepReadPages, 0, MAX_DEEP_READ_PAGES_LIMIT, 2);
  const searchPages = clampInt(
    options.searchPages,
    1,
    MAX_SEARCH_PAGES_LIMIT,
    Math.min(MAX_SEARCH_PAGES_LIMIT, Math.max(1, Math.ceil(maxResults / DEFAULT_RESULTS_PER_PAGE_HINT))),
  );
  const readFromResult = clampInt(options.readFromResult, 1, MAX_RESULTS_LIMIT, 1);

  if (!trimmedQuery) {
    return {
      ok: false,
      engine: provider,
      query: "",
      resultCount: 0,
      consultedCount: 0,
      readStartIndex: 0,
      readEndIndex: 0,
      hasMoreResultsToRead: false,
      nextReadFromResult: null,
      summary: "Web research query was empty.",
      results: [],
      consultedPages: [],
      warnings: ["Empty query."],
    };
  }

  const warnings: string[] = [];
  const providersToTry = buildProviderFallbackOrder(provider, availableApiKeys, fallbackStrategy);
  let selectedEngine = provider;
  let searchedPages = 0;
  let results: WebResearchHit[] = [];

  for (const candidateProvider of providersToTry) {
    if (requiresWebResearchApiKey(candidateProvider) && !availableApiKeys[candidateProvider]?.trim()) {
      warnings.push(`Skipped provider '${candidateProvider}' due to missing API key.`);
      continue;
    }

    const searched = await searchWithProvider(
      candidateProvider,
      trimmedQuery,
      timeoutMs,
      maxResults,
      searchPages,
      availableApiKeys,
    );

    searchedPages = searched.searchedPages;
    warnings.push(...searched.warnings.map((warning) => `[${candidateProvider}] ${warning}`));

    if (searched.ok) {
      selectedEngine = candidateProvider;
      results = searched.results;
      if (candidateProvider !== provider) {
        warnings.push(`Primary provider '${provider}' was unavailable; fell back to '${candidateProvider}'.`);
      }
      break;
    }

    if (searched.fatalSummary) {
      warnings.push(`[${candidateProvider}] ${searched.fatalSummary}`);
    }
  }

  if (results.length === 0) {
    const noResultWarnings = [...warnings];
    const selectedOnly = fallbackStrategy === "selected_only";
    if (selectedOnly) {
      noResultWarnings.push(`Fallback is disabled by runtime setting 'selected_only'; only '${provider}' was queried.`);
    } else if (providersToTry.length <= 1) {
      noResultWarnings.push("No fallback providers were available with the current key and provider configuration.");
    }

    return {
      ok: false,
      engine: selectedEngine,
      query: trimmedQuery,
      resultCount: 0,
      consultedCount: 0,
      readStartIndex: 0,
      readEndIndex: 0,
      hasMoreResultsToRead: false,
      nextReadFromResult: null,
      summary: selectedOnly
        ? `Search via '${provider}' completed but returned no usable public-web results, and fallback is disabled by runtime settings.`
        : "Search completed but no usable public-web results were parsed across available providers.",
      results: [],
      consultedPages: [],
      warnings: noResultWarnings.length > 0 ? noResultWarnings : ["No usable public search results."],
    };
  }

  const consultedPages: WebResearchPage[] = [];
  const readStartOffset = Math.min(Math.max(0, readFromResult - 1), Math.max(0, results.length - 1));
  const resultsToRead = results.slice(readStartOffset, readStartOffset + deepReadPages);
  const readOutcomes = await mapWithConcurrency(
    resultsToRead,
    Math.min(MAX_DEEP_READ_CONCURRENCY, deepReadPages || 1),
    async (result) => {
      const pageResult = await readPublicPage(result.url, timeoutMs);
      return { result, pageResult };
    },
  );

  for (const { result, pageResult } of readOutcomes) {
    if (!pageResult) {
      warnings.push(`Could not read ${result.url}`);
      continue;
    }
    consultedPages.push({
      ...pageResult,
      position: result.position,
      title: pageResult.title || result.title,
    });
  }

  const readStartIndex = resultsToRead.length > 0 ? resultsToRead[0].position : 0;
  const readEndIndex = resultsToRead.length > 0 ? resultsToRead[resultsToRead.length - 1].position : 0;
  const hasMoreResultsToRead = readEndIndex > 0 && readEndIndex < results.length;
  const nextReadFromResult = hasMoreResultsToRead ? readEndIndex + 1 : null;
  const readSummary = readStartIndex > 0
    ? `read result slots ${readStartIndex}-${readEndIndex}`
    : "did not deep-read result pages";

  return {
    ok: true,
    engine: selectedEngine,
    query: trimmedQuery,
    resultCount: results.length,
    consultedCount: consultedPages.length,
    readStartIndex,
    readEndIndex,
    hasMoreResultsToRead,
    nextReadFromResult,
    summary: `Found ${results.length} public web result${results.length === 1 ? "" : "s"} across ${searchedPages} search page${searchedPages === 1 ? "" : "s"}; ${readSummary} and extracted ${consultedPages.length} page${consultedPages.length === 1 ? "" : "s"}.`,
    results,
    consultedPages,
    warnings,
  };
}

function buildProviderFallbackOrder(
  preferred: WebResearchProvider,
  availableApiKeys: Partial<Record<WebResearchProvider, string>>,
  strategy: WebResearchFallbackStrategy,
): WebResearchProvider[] {
  const ordered = [preferred, ...WEB_RESEARCH_PROVIDER_ORDER.filter((provider) => provider !== preferred)];
  if (strategy === "selected_only") {
    return [preferred];
  }

  const fallbackPool = ordered.filter((provider) => provider !== preferred);
  const nonKeyProviders = strategy === "prefer_non_key"
    ? fallbackPool.filter((provider) => !requiresWebResearchApiKey(provider))
    : [];
  const keyedProviders = fallbackPool.filter((provider) => {
    if (!requiresWebResearchApiKey(provider)) {
      return false;
    }
    const key = availableApiKeys[provider]?.trim();
    return Boolean(key);
  });

  return [...new Set<WebResearchProvider>([preferred, ...nonKeyProviders, ...keyedProviders])];
}

async function searchWithProvider(
  provider: WebResearchProvider,
  query: string,
  timeoutMs: number,
  maxResults: number,
  searchPages: number,
  apiKeys: Partial<Record<WebResearchProvider, string>>,
): Promise<{ ok: boolean; results: WebResearchHit[]; warnings: string[]; searchedPages: number; fatalSummary?: string }> {
  const results: WebResearchHit[] = [];
  const seenUrls = new Set<string>();
  const warnings: string[] = [];
  let searchedPages = 0;
  let page = 1;
  let searchUrl = buildBraveSearchUrl(query, page);

  while (searchedPages < searchPages && results.length < maxResults) {
    let pageResults: WebResearchHit[] = [];
    let pageFailure: { status: number; error?: string } | null = null;
    let shouldStopAfterPage = false;

    if (provider === "brave_scrape") {
      const searchResponse = await fetchText(searchUrl, timeoutMs);
      if (!searchResponse.ok) {
        pageFailure = { status: searchResponse.status, error: searchResponse.error };
      } else {
        pageResults = parseBraveSearchResults(searchResponse.text.slice(0, MAX_RESULT_HTML_CHARS), maxResults);
        const hintedNext = parseBraveNextPageUrl(searchResponse.text);
        page += 1;
        searchUrl = hintedNext ?? buildBraveSearchUrl(query, page);
      }
    } else if (provider === "duckduckgo_scrape") {
      const ddgUrl = buildDuckDuckGoSearchUrl(query, page);
      const searchResponse = await fetchText(ddgUrl, timeoutMs);
      if (!searchResponse.ok) {
        pageFailure = { status: searchResponse.status, error: searchResponse.error };
      } else {
        pageResults = parseDuckDuckGoResults(searchResponse.text.slice(0, MAX_RESULT_HTML_CHARS), maxResults);
        page += 1;
      }
    } else if (provider === "brave_api") {
      const response = await searchBraveApi(query, page, maxResults, timeoutMs, apiKeys.brave_api ?? "");
      if (!response.ok) {
        pageFailure = { status: response.status, error: response.error };
      } else {
        pageResults = response.results;
        page += 1;
        shouldStopAfterPage = !response.hasMoreResults;
      }
    } else if (provider === "serper") {
      const response = await searchSerperApi(query, page, maxResults, timeoutMs, apiKeys.serper ?? "");
      if (!response.ok) {
        pageFailure = { status: response.status, error: response.error };
      } else {
        pageResults = response.results;
        page += 1;
      }
    } else {
      const response = await searchSerpApi(query, page, maxResults, timeoutMs, apiKeys.serpapi ?? "");
      if (!response.ok) {
        pageFailure = { status: response.status, error: response.error };
      } else {
        pageResults = response.results;
        page += 1;
      }
    }

    if (pageFailure) {
      if (searchedPages === 0) {
        return {
          ok: false,
          results: [],
          warnings: ["Search request failed."],
          searchedPages,
          fatalSummary: pageFailure.error
            ? `Web search failed: ${pageFailure.error}`
            : `Web search failed with status ${pageFailure.status}.`,
        };
      }
      warnings.push(
        pageFailure.error
          ? `Search page ${page} failed: ${pageFailure.error}`
          : `Search page ${page} failed with status ${pageFailure.status}.`,
      );
      break;
    }

    searchedPages += 1;
    for (const parsed of pageResults) {
      if (results.length >= maxResults) {
        break;
      }
      if (seenUrls.has(parsed.url)) {
        continue;
      }
      seenUrls.add(parsed.url);
      results.push({
        ...parsed,
        position: results.length + 1,
      });
    }

    if (shouldStopAfterPage) {
      break;
    }
  }

  return { ok: results.length > 0, results, warnings, searchedPages };
}
