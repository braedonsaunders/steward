import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { buildObservation, dedupeObservations } from "@/lib/discovery/evidence";
import { loadPlaywrightChromiumRuntime } from "@/lib/runtime/playwright";
import { getDataDir } from "@/lib/state/db";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { DiscoveryObservationInput, ServiceFingerprint } from "@/lib/state/types";

interface BrowserProbeTarget {
  ip: string;
  port: number;
  secure: boolean;
}

interface BrowserProbeResult {
  ip: string;
  services: ServiceFingerprint[];
  observations: DiscoveryObservationInput[];
  metadata: {
    collectedAt: string;
    endpoints: Array<{
      url: string;
    finalUrl?: string;
    title?: string;
    statusCode?: number;
    serverHeader?: string;
    poweredBy?: string;
    hasLoginForm: boolean;
    frameworkHints: string[];
    vendorHints: string[];
    screenshotPath?: string;
    faviconHash?: string;
    }>;
  };
}

export interface BrowserObservationOptions {
  timeoutMs?: number;
  maxTargets?: number;
  captureScreenshots?: boolean;
  maxConcurrency?: number;
}

const HTTP_PORT_HINTS = [80, 8080, 8000, 9000, 5000];
const HTTPS_PORT_HINTS = [443, 8443, 7443, 9443, 5001];

const makeUrl = (target: BrowserProbeTarget): string =>
  `${target.secure ? "https" : "http"}://${target.ip}:${target.port}/`;

const htmlTitle = (raw: string): string | undefined => {
  const match = raw.match(/<title[^>]*>([^<]{1,220})<\/title>/i);
  return match?.[1]?.trim();
};

const hasLoginForm = (raw: string): boolean => {
  if (!raw) {
    return false;
  }
  if (/type=["']password["']/i.test(raw)) {
    return true;
  }
  return /login|sign in|username|password/i.test(raw);
};

const frameworkHintsFromHtml = (raw: string): string[] => {
  const hints = new Set<string>();
  const lower = raw.toLowerCase();
  if (lower.includes("react")) hints.add("react");
  if (lower.includes("vue")) hints.add("vue");
  if (lower.includes("angular")) hints.add("angular");
  if (lower.includes("svelte")) hints.add("svelte");
  if (lower.includes("polymer")) hints.add("polymer");
  if (lower.includes("webpack")) hints.add("webpack");
  if (lower.includes("vite")) hints.add("vite");
  return Array.from(hints).slice(0, 8);
};

const vendorHintsFromText = (raw: string): string[] => {
  const hints = new Set<string>();
  const lower = raw.toLowerCase();
  if (/google nest|google home|chromecast/.test(lower)) hints.add("google-nest");
  if (/home assistant/.test(lower)) hints.add("home-assistant");
  if (/synology|diskstation/.test(lower)) hints.add("synology");
  if (/qnap/.test(lower)) hints.add("qnap");
  if (/unifi|ubiquiti/.test(lower)) hints.add("ubiquiti");
  if (/openwrt/.test(lower)) hints.add("openwrt");
  if (/pfsense/.test(lower)) hints.add("pfsense");
  if (/opnsense/.test(lower)) hints.add("opnsense");
  if (/mikrotik|routeros/.test(lower)) hints.add("mikrotik");
  if (/truenas/.test(lower)) hints.add("truenas");
  return Array.from(hints).slice(0, 8);
};

const screenshotDir = (): string => {
  const dir = path.join(getDataDir(), "artifacts", "browser-observer");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const sanitizeFileStem = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "host";

const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Steward/1.0 (Browser Observation)",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchFaviconHash = async (baseUrl: string, timeoutMs: number): Promise<string | undefined> => {
  try {
    const faviconUrl = new URL("/favicon.ico", baseUrl).toString();
    const response = await fetchWithTimeout(faviconUrl, timeoutMs);
    if (!response.ok) {
      return undefined;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      return undefined;
    }
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
  }
};

const loadPlaywright = async (): Promise<{ chromium: { launch: (options: Record<string, unknown>) => Promise<unknown> } } | null> => {
  const chromium = await loadPlaywrightChromiumRuntime();
  return chromium ? { chromium: chromium as { launch: (options: Record<string, unknown>) => Promise<unknown> } } : null;
};

const webTargetsForCandidate = (candidate: DiscoveryCandidate): BrowserProbeTarget[] => {
  const targets: BrowserProbeTarget[] = [];
  for (const service of candidate.services) {
    if (service.transport !== "tcp") continue;
    if (HTTP_PORT_HINTS.includes(service.port) || HTTPS_PORT_HINTS.includes(service.port) || /http/i.test(service.name)) {
      targets.push({ ip: candidate.ip, port: service.port, secure: Boolean(service.secure || HTTPS_PORT_HINTS.includes(service.port)) });
    }
  }

  if (targets.length === 0) {
    targets.push({ ip: candidate.ip, port: 80, secure: false });
    targets.push({ ip: candidate.ip, port: 443, secure: true });
  }

  const deduped = new Map<string, BrowserProbeTarget>();
  for (const target of targets) {
    deduped.set(`${target.port}:${target.secure}`, target);
  }

  return Array.from(deduped.values())
    .sort((a, b) => a.port - b.port)
    .slice(0, 3);
};

const updateService = (
  services: ServiceFingerprint[],
  patch: ServiceFingerprint,
): void => {
  const idx = services.findIndex((service) => service.port === patch.port && service.transport === patch.transport);
  if (idx === -1) {
    services.push(patch);
    return;
  }
  services[idx] = {
    ...services[idx],
    ...patch,
    id: services[idx].id,
  };
};

const runFallbackProbe = async (
  target: BrowserProbeTarget,
  timeoutMs: number,
): Promise<{
  url: string;
  finalUrl?: string;
  statusCode?: number;
  serverHeader?: string;
  poweredBy?: string;
  title?: string;
  hasLoginForm: boolean;
  frameworkHints: string[];
  vendorHints: string[];
}> => {
  const url = makeUrl(target);
  try {
    const response = await fetchWithTimeout(url, timeoutMs);
    const statusCode = response.status;
    const finalUrl = response.url;
    const serverHeader = response.headers.get("server") ?? undefined;
    const poweredBy = response.headers.get("x-powered-by") ?? undefined;
    const html = (await response.text()).slice(0, 200_000);
    const title = htmlTitle(html);
    return {
      url,
      finalUrl,
      statusCode,
      serverHeader,
      poweredBy,
      title,
      hasLoginForm: hasLoginForm(html),
      frameworkHints: frameworkHintsFromHtml(html),
      vendorHints: vendorHintsFromText(`${title ?? ""}\n${html.slice(0, 40_000)}`),
    };
  } catch {
    return {
      url,
      hasLoginForm: false,
      frameworkHints: [],
      vendorHints: [],
    };
  }
};

export async function observeBrowserSurfaces(
  candidates: DiscoveryCandidate[],
  options: BrowserObservationOptions = {},
): Promise<BrowserProbeResult[]> {
  if (candidates.length === 0) {
    return [];
  }

  const timeoutMs = Math.max(2_000, Math.min(120_000, Math.floor(options.timeoutMs ?? 12_000)));
  const maxTargets = Math.max(1, Math.min(512, Math.floor(options.maxTargets ?? candidates.length)));
  const maxConcurrency = Math.max(1, Math.min(4, Math.floor(options.maxConcurrency ?? 2)));
  const captureScreenshots = options.captureScreenshots === true;
  const observedAt = new Date().toISOString();
  const selected = candidates.slice(0, maxTargets);

  const playwright = await loadPlaywright();
  let browser: unknown = null;
  if (playwright) {
    try {
      browser = await playwright.chromium.launch({
        headless: true,
      });
    } catch {
      browser = null;
    }
  }

  const results: BrowserProbeResult[] = [];
  const screenshotRoot = captureScreenshots ? screenshotDir() : "";

  try {
    for (let idx = 0; idx < selected.length; idx += maxConcurrency) {
      const batch = selected.slice(idx, idx + maxConcurrency);
      const batchResults = await Promise.all(batch.map(async (candidate) => {
        const services = [...candidate.services];
        const observations: DiscoveryObservationInput[] = [];
        const endpoints: BrowserProbeResult["metadata"]["endpoints"] = [];
        const targets = webTargetsForCandidate(candidate);

        for (const target of targets) {
          let details = await runFallbackProbe(target, timeoutMs);
          const url = details.url;

          if (browser && typeof browser === "object" && browser !== null) {
            const browserObj = browser as {
              newContext: (opts: Record<string, unknown>) => Promise<{
                newPage: () => Promise<{
                  goto: (nextUrl: string, opts: Record<string, unknown>) => Promise<{ status: () => number | null } | null>;
                  title: () => Promise<string>;
                  content: () => Promise<string>;
                  url: () => string;
                  screenshot: (opts: Record<string, unknown>) => Promise<unknown>;
                  close: () => Promise<void>;
                }>;
                close: () => Promise<void>;
              }>;
            };

            try {
              const context = await browserObj.newContext({
                ignoreHTTPSErrors: true,
              });
              const page = await context.newPage();
              const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
              const title = (await page.title()).trim() || undefined;
              const html = (await page.content()).slice(0, 220_000);
              const finalUrl = page.url();

              let screenshotPath: string | undefined;
              if (captureScreenshots) {
                const fileName = `${sanitizeFileStem(candidate.ip)}-${target.port}-${Date.now()}.png`;
                const filePath = path.join(screenshotRoot, fileName);
                await page.screenshot({ path: filePath, fullPage: true });
                screenshotPath = filePath;
              }

              await page.close();
              await context.close();

              details = {
                ...details,
                finalUrl,
                statusCode: response?.status() ?? details.statusCode,
                title: title ?? details.title,
                hasLoginForm: details.hasLoginForm || hasLoginForm(html),
                frameworkHints: Array.from(new Set([
                  ...details.frameworkHints,
                  ...frameworkHintsFromHtml(html),
                ])).slice(0, 8),
                vendorHints: Array.from(new Set([
                  ...details.vendorHints,
                  ...vendorHintsFromText(`${title ?? ""}\n${html.slice(0, 40_000)}`),
                ])).slice(0, 8),
              };

              if (screenshotPath) {
                endpoints.push({
                  ...details,
                  screenshotPath,
                });
              }
            } catch {
              // Fall back to plain HTTP probe result.
            }
          }

          const faviconHash = await fetchFaviconHash(details.finalUrl ?? details.url, timeoutMs);
          const endpointDetails = {
            ...details,
            ...(faviconHash ? { faviconHash } : {}),
          };
          if (!endpoints.some((endpoint) => endpoint.url === endpointDetails.url && endpoint.finalUrl === endpointDetails.finalUrl)) {
            endpoints.push(endpointDetails);
          }

          const servicePatch: ServiceFingerprint = {
            id: randomUUID(),
            port: target.port,
            transport: "tcp",
            name: target.secure ? "https" : "http",
            secure: target.secure,
            httpInfo: {
              statusCode: details.statusCode,
              serverHeader: details.serverHeader,
              poweredBy: details.poweredBy,
              title: details.title,
            },
            product: details.vendorHints[0],
            lastSeenAt: observedAt,
          };
          updateService(services, servicePatch);

          observations.push(buildObservation({
            ip: candidate.ip,
            source: "fingerprint",
            evidenceType: "browser_observation",
            confidence: 0.77,
            observedAt,
            ttlMs: 6 * 60 * 60_000,
            details: endpointDetails,
          }));

          if (faviconHash) {
            observations.push(buildObservation({
              ip: candidate.ip,
              source: "fingerprint",
              evidenceType: "favicon_hash",
              confidence: 0.78,
              observedAt,
              ttlMs: 24 * 60 * 60_000,
              details: {
                url: details.url,
                hash: faviconHash,
              },
            }));
          }
        }

        if (observations.length === 0) {
          return null;
        }

        return {
          ip: candidate.ip,
          services,
          observations: dedupeObservations(observations),
          metadata: {
            collectedAt: observedAt,
            endpoints,
          },
        } satisfies BrowserProbeResult;
      }));

      for (const result of batchResults) {
        if (result) {
          results.push(result);
        }
      }
    }
  } finally {
    if (browser && typeof browser === "object" && browser !== null && "close" in browser) {
      try {
        await (browser as { close: () => Promise<void> }).close();
      } catch {
        // no-op
      }
    }
  }

  return results;
}
