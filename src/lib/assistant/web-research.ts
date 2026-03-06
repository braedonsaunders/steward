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
  engine: "brave";
  query: string;
  resultCount: number;
  consultedCount: number;
  summary: string;
  results: WebResearchHit[];
  consultedPages: WebResearchPage[];
  warnings: string[];
}

export interface WebResearchOptions {
  timeoutMs?: number;
  maxResults?: number;
  deepReadPages?: number;
}

const BRAVE_SEARCH_URL = "https://search.brave.com/search";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Steward/1.0";
const MAX_RESULT_HTML_CHARS = 600_000;
const MAX_PAGE_HTML_CHARS = 450_000;
const SEARCH_RESULT_SNIPPET_CHARS = 320;
const PAGE_EXCERPT_CHARS = 1_800;
const MIN_DIRECT_FETCH_TEXT_CHARS = 280;
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

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    const moduleName = "playwright";
    const mod = await import(moduleName);
    const chromium = (mod as Record<string, unknown>).chromium;
    if (chromium && typeof chromium === "object" && "launch" in chromium) {
      return { chromium: chromium as PlaywrightModule["chromium"] };
    }
  } catch {
    // Playwright is optional for rendered page fallback.
  }
  return null;
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
  const timeoutMs = clampInt(options.timeoutMs, 3_000, 60_000, 18_000);
  const maxResults = clampInt(options.maxResults, 1, 10, 5);
  const deepReadPages = clampInt(options.deepReadPages, 0, 5, 2);

  if (!trimmedQuery) {
    return {
      ok: false,
      engine: "brave",
      query: "",
      resultCount: 0,
      consultedCount: 0,
      summary: "Web research query was empty.",
      results: [],
      consultedPages: [],
      warnings: ["Empty query."],
    };
  }

  const searchUrl = new URL(BRAVE_SEARCH_URL);
  searchUrl.searchParams.set("q", trimmedQuery);
  searchUrl.searchParams.set("source", "web");
  searchUrl.searchParams.set("summary", "0");

  const searchResponse = await fetchText(searchUrl.toString(), timeoutMs);
  if (!searchResponse.ok) {
    return {
      ok: false,
      engine: "brave",
      query: trimmedQuery,
      resultCount: 0,
      consultedCount: 0,
      summary: searchResponse.error
        ? `Web search failed: ${searchResponse.error}`
        : `Web search failed with status ${searchResponse.status}.`,
      results: [],
      consultedPages: [],
      warnings: ["Search request failed."],
    };
  }

  const results = parseBraveSearchResults(searchResponse.text.slice(0, MAX_RESULT_HTML_CHARS), maxResults);
  if (results.length === 0) {
    return {
      ok: false,
      engine: "brave",
      query: trimmedQuery,
      resultCount: 0,
      consultedCount: 0,
      summary: "Search completed but no usable public-web results were parsed.",
      results: [],
      consultedPages: [],
      warnings: ["No usable public search results."],
    };
  }

  const consultedPages: WebResearchPage[] = [];
  const warnings: string[] = [];

  for (const result of results.slice(0, deepReadPages)) {
    const page = await readPublicPage(result.url, timeoutMs);
    if (!page) {
      warnings.push(`Could not read ${result.url}`);
      continue;
    }
    consultedPages.push({
      ...page,
      position: result.position,
      title: page.title || result.title,
    });
  }

  return {
    ok: true,
    engine: "brave",
    query: trimmedQuery,
    resultCount: results.length,
    consultedCount: consultedPages.length,
    summary: `Found ${results.length} public web result${results.length === 1 ? "" : "s"} and read ${consultedPages.length} page${consultedPages.length === 1 ? "" : "s"}.`,
    results,
    consultedPages,
    warnings,
  };
}
