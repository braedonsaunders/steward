import { createHash, randomUUID } from "node:crypto";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import type { Device, ProtocolSessionLease, ProtocolSessionRecord } from "@/lib/state/types";
import { markCredentialValidatedFromUse } from "@/lib/adoption/credentials";
import { loadPlaywrightChromiumRuntime } from "@/lib/runtime/playwright";

export interface BrowserFlowStepInput {
  action: string;
  selector?: string;
  value?: string;
  url?: string;
  script?: string;
  label?: string;
  full_page?: boolean;
  path?: string;
  timeout_ms?: number;
}

export interface BrowserFlowArgs {
  url: string;
  device?: Device;
  sessionId?: string;
  username?: string;
  password?: string;
  credentialId?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  waitForSelector?: string;
  postLoginWaitMs?: number;
  collectDiagnostics?: boolean;
  includeHtml?: boolean;
  steps?: BrowserFlowStepInput[];
  persistSession?: boolean;
  reuseSession?: boolean;
  resetSession?: boolean;
  sessionHolder?: string;
  purpose?: string;
  markCredentialValidated?: boolean;
  actor?: "steward" | "user";
}

interface PlaywrightChromium {
  launch: (options: Record<string, unknown>) => Promise<PlaywrightBrowser>;
}

interface PlaywrightBrowser {
  newContext: (options?: Record<string, unknown>) => Promise<PlaywrightContext>;
  close: () => Promise<void>;
}

interface PlaywrightContext {
  newPage: () => Promise<PlaywrightPage>;
  storageState: (options?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

interface PlaywrightPage {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  click: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  hover: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  fill: (selector: string, value: string, options?: Record<string, unknown>) => Promise<void>;
  press: (selector: string, key: string, options?: Record<string, unknown>) => Promise<void>;
  check: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  uncheck: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  selectOption: (selector: string, values: string | string[], options?: Record<string, unknown>) => Promise<void>;
  waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
  waitForURL: (urlOrRegex: string | RegExp, options?: Record<string, unknown>) => Promise<unknown>;
  waitForTimeout: (timeout: number) => Promise<void>;
  title: () => Promise<string>;
  url: () => string;
  content: () => Promise<string>;
  screenshot: (options?: Record<string, unknown>) => Promise<Uint8Array>;
  evaluate: <T>(fn: (...args: unknown[]) => T, arg?: unknown) => Promise<T>;
  close: () => Promise<void>;
}

interface PlaywrightResponse {
  url: () => string;
  status: () => number;
  headers: () => Record<string, string>;
  text: () => Promise<string>;
}

interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

interface PlaywrightStorageState {
  cookies?: StorageCookie[];
  origins?: Array<{
    origin: string;
    localStorage?: Array<{ name: string; value: string }>;
  }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function readBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeSessionId(deviceId: string | undefined, origin: string): string {
  const prefix = deviceId ? deviceId.slice(0, 8) : "global";
  const digest = createHash("sha256").update(`${deviceId ?? "none"}|${origin}`).digest("hex").slice(0, 16);
  return `web-${prefix}-${digest}`;
}

function storageStateSecretRef(sessionId: string): string {
  return `web.session.${sessionId}.storage_state`;
}

function parseStorageState(raw: string | undefined): PlaywrightStorageState | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as PlaywrightStorageState;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function domainMatches(hostname: string, cookieDomain: string): boolean {
  const normalized = cookieDomain.trim().toLowerCase();
  const host = hostname.trim().toLowerCase();
  if (!normalized || !host) {
    return false;
  }
  const bare = normalized.startsWith(".") ? normalized.slice(1) : normalized;
  return host === bare || host.endsWith(`.${bare}`);
}

function pathMatches(urlPath: string, cookiePath: string): boolean {
  const normalizedCookiePath = cookiePath && cookiePath.length > 0 ? cookiePath : "/";
  return urlPath.startsWith(normalizedCookiePath);
}

function cookieIsExpired(cookie: StorageCookie): boolean {
  if (typeof cookie.expires !== "number" || cookie.expires <= 0) {
    return false;
  }
  return cookie.expires * 1000 <= Date.now();
}

function summarizeStorageState(state: PlaywrightStorageState | undefined): {
  cookieCount: number;
  origins: string[];
  localStorageKeys: string[];
} {
  const origins = (state?.origins ?? [])
    .map((entry) => safeString(entry.origin))
    .filter((value): value is string => Boolean(value));
  const localStorageKeys = Array.from(new Set((state?.origins ?? [])
    .flatMap((entry) => Array.isArray(entry.localStorage) ? entry.localStorage.map((item) => item.name).filter((name): name is string => typeof name === "string" && name.length > 0) : [])))
    .slice(0, 40);
  return {
    cookieCount: Array.isArray(state?.cookies) ? state.cookies.length : 0,
    origins,
    localStorageKeys,
  };
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function extractCsrfHints(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) {
    return {};
  }
  const entries = value
    .filter(isRecord)
    .map((entry) => {
      const name = safeString(entry.name) ?? safeString(entry.id) ?? safeString(entry.key);
      const token = safeString(entry.content) ?? safeString(entry.value);
      return name && token ? [name, token] as const : null;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));
  return Object.fromEntries(entries.slice(0, 20));
}

function buildCookieHeaderFromState(state: PlaywrightStorageState | undefined, targetUrl: string): string | undefined {
  if (!state || !Array.isArray(state.cookies) || state.cookies.length === 0) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return undefined;
  }
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const cookies = state.cookies
    .filter((cookie) => !cookieIsExpired(cookie))
    .filter((cookie) => domainMatches(parsed.hostname, cookie.domain))
    .filter((cookie) => pathMatches(parsed.pathname || "/", cookie.path || "/"))
    .filter((cookie) => !cookie.secure || secure)
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return cookies.length > 0 ? cookies.join("; ") : undefined;
}

function looksLikeAuthResponse(url: string): boolean {
  return /\/auth\/|\/signin|\/login|session/i.test(url);
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function evaluatePageCsrfHints(page: PlaywrightPage): Promise<Record<string, string>> {
  try {
    const result = await page.evaluate(() => {
      const entries: Array<Record<string, string>> = [];
      for (const meta of Array.from(document.querySelectorAll("meta[name],meta[id]"))) {
        const name = meta.getAttribute("name") ?? meta.getAttribute("id") ?? "";
        const content = meta.getAttribute("content") ?? "";
        if (/csrf|xsrf|token/i.test(name) && content.trim().length > 0) {
          entries.push({ name, content });
        }
      }
      for (const input of Array.from(document.querySelectorAll("input[type='hidden'][name],input[type='hidden'][id]"))) {
        const name = input.getAttribute("name") ?? input.getAttribute("id") ?? "";
        const value = (input as HTMLInputElement).value ?? "";
        if (/csrf|xsrf|token/i.test(name) && value.trim().length > 0) {
          entries.push({ name, value });
        }
      }
      return entries;
    });
    return extractCsrfHints(result);
  } catch {
    return {};
  }
}

async function inferLoginSelectors(page: PlaywrightPage): Promise<{
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}> {
  try {
    const result = await page.evaluate(() => {
      const visible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const selectorFor = (element: Element | null): string | undefined => {
        if (!element) return undefined;
        const id = element.getAttribute("id");
        if (id) return `#${id}`;
        const name = element.getAttribute("name");
        if (name) return `${element.tagName.toLowerCase()}[name='${name.replace(/'/g, "\\'")}']`;
        return undefined;
      };
      const passwordInput = Array.from(document.querySelectorAll("input[type='password']")).find((element) => visible(element));
      const passwordForm = passwordInput?.closest("form") ?? null;
      const usernameCandidates = Array.from(document.querySelectorAll("input[type='email'], input[name='email'], input[name='username'], input[type='text']"))
        .filter((element) => visible(element) && element !== passwordInput)
        .sort((left, right) => {
          const leftSameForm = passwordForm && left.closest("form") === passwordForm ? 0 : 1;
          const rightSameForm = passwordForm && right.closest("form") === passwordForm ? 0 : 1;
          return leftSameForm - rightSameForm;
        });
      const submitCandidates = Array.from(document.querySelectorAll("button[type='submit'], input[type='submit'], button[name='submit'], #submit"))
        .filter((element) => visible(element))
        .sort((left, right) => {
          const score = (element: Element) => {
            let value = 0;
            if (passwordForm && element.closest("form") === passwordForm) value -= 20;
            const id = (element.getAttribute("id") ?? "").toLowerCase();
            const name = (element.getAttribute("name") ?? "").toLowerCase();
            const text = ((element as HTMLInputElement).value ?? element.textContent ?? "").toLowerCase();
            if (id === "submit" || name === "submit") value -= 10;
            if (/sign in|log in|login|submit/.test(text)) value -= 5;
            if (/\bgo\b/.test(text)) value += 10;
            return value;
          };
          return score(left) - score(right);
        });
      return {
        usernameSelector: selectorFor(usernameCandidates[0] ?? null),
        passwordSelector: selectorFor(passwordInput ?? null),
        submitSelector: selectorFor(submitCandidates[0] ?? null),
      };
    });
    return isRecord(result)
      ? {
        usernameSelector: safeString(result.usernameSelector),
        passwordSelector: safeString(result.passwordSelector),
        submitSelector: safeString(result.submitSelector),
      }
      : {};
  } catch {
    return {};
  }
}

async function syncCsrfFields(page: PlaywrightPage): Promise<void> {
  try {
    await page.evaluate(() => {
      const metaToken = (document.querySelector("meta#session_csrf_token") as HTMLMetaElement | null)?.content
        ?? (document.querySelector("meta[name='csrf-token']") as HTMLMetaElement | null)?.content
        ?? "";
      if (!metaToken) {
        return;
      }
      const ensureHidden = (name: string, value: string) => {
        let input = document.querySelector(`input[name='${name}']`) as HTMLInputElement | null;
        if (!input) {
          input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          document.querySelector("form")?.appendChild(input);
        }
        input.value = value;
      };
      ensureHidden("csrf_token", metaToken);
      ensureHidden("session_csrf_token", metaToken);
      const byId = document.querySelector("#csrf_token") as HTMLInputElement | null;
      if (byId) {
        byId.value = metaToken;
      }
    });
  } catch {
    // ignore csrf sync failures; submit may still work without it
  }
}

async function submitAjaxLoginForm(args: {
  page: PlaywrightPage;
  usernameSelector: string;
  passwordSelector: string;
  username: string;
  password: string;
  origin: string;
}): Promise<{ success: boolean; redirect?: string; error?: string }> {
  try {
    const result = await args.page.evaluate(async (input) => {
      const argsRecord = input as {
        usernameSelector: string;
        passwordSelector: string;
        username: string;
        password: string;
      };
      const usernameElement = document.querySelector(argsRecord.usernameSelector) as HTMLInputElement | null;
      const passwordElement = document.querySelector(argsRecord.passwordSelector) as HTMLInputElement | null;
      const form = usernameElement?.closest("form") as HTMLFormElement | null;
      if (!usernameElement || !passwordElement || !form) {
        return { success: false, error: "login form not found" };
      }
      const formData = new URLSearchParams();
      for (const element of Array.from(form.elements)) {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
          continue;
        }
        const name = element.name || element.id;
        if (!name) {
          continue;
        }
        if ((element instanceof HTMLInputElement) && ((element.type === "checkbox" || element.type === "radio") && !element.checked)) {
          continue;
        }
        formData.set(name, element.value ?? "");
      }
      formData.set(usernameElement.name || usernameElement.id || "username", argsRecord.username);
      formData.set(passwordElement.name || passwordElement.id || "password", argsRecord.password);
      const token = (document.querySelector("meta#session_csrf_token") as HTMLMetaElement | null)?.content
        ?? (document.querySelector("meta[name='csrf-token']") as HTMLMetaElement | null)?.content
        ?? "";
      if (token) {
        if (!formData.has("session_csrf_token")) {
          formData.set("session_csrf_token", token);
        }
        if (!formData.has("csrf_token")) {
          formData.set("csrf_token", "");
        }
      }
      const action = form.getAttribute("data-action") || form.action || "/auth/ajax/signin/";
      const response = await fetch(action, {
        method: (form.getAttribute("data-method") || form.method || "POST").toUpperCase(),
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
        },
        body: formData.toString(),
        credentials: "include",
      });
      const text = await response.text();
      const parsed = (() => {
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      return {
        success: parsed?.success === true,
        redirect: typeof parsed?.redirect === "string" ? parsed.redirect : undefined,
        error: typeof parsed?.message === "string"
          ? parsed.message
          : typeof parsed?.data === "object" && parsed?.data && typeof (parsed.data as Record<string, unknown>).message === "string"
            ? String((parsed.data as Record<string, unknown>).message)
            : undefined,
      };
    }, {
      usernameSelector: args.usernameSelector,
      passwordSelector: args.passwordSelector,
      username: args.username,
      password: args.password,
    });
    if (result.success && result.redirect) {
      await args.page.goto(new URL(result.redirect, args.origin).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    return {
      success: result.success === true,
      redirect: safeString(result.redirect),
      error: safeString(result.error),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function chooseLoginSelector(explicit: string | undefined, inferred: string | undefined): string | undefined {
  if (!explicit) {
    return inferred;
  }
  const normalized = explicit.toLowerCase();
  const overlyBroad = normalized.includes(",") || normalized.includes("[type=") || normalized.includes("button[") || normalized.includes("input[");
  if (overlyBroad && inferred) {
    return inferred;
  }
  return explicit;
}

function authResponseState(authResponses: Array<{ url: string; status: number; body: string }>): {
  success: boolean;
  redirect?: string;
  csrfFailure: boolean;
} {
  const latest = authResponses.length > 0 ? authResponses[authResponses.length - 1] : undefined;
  const parsed = latest ? parseJsonRecord(latest.body) : undefined;
  return {
    success: parsed?.success === true,
    redirect: safeString(parsed?.redirect),
    csrfFailure: parsed?.csrf_failure === true,
  };
}

function buildLease(session: ProtocolSessionRecord, holder: string, purpose: string): ProtocolSessionLease {
  return {
    id: randomUUID(),
    sessionId: session.id,
    holder,
    purpose,
    mode: "exchange",
    status: "active",
    exclusive: false,
    requestedAt: nowIso(),
    grantedAt: nowIso(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    metadataJson: {},
  };
}

async function runBrowserStep(page: PlaywrightPage, step: BrowserFlowStepInput): Promise<Record<string, unknown>> {
  const action = typeof step.action === "string" ? step.action : "";
  const selector = typeof step.selector === "string" ? step.selector : "";
  const value = typeof step.value === "string" ? step.value : "";
  const url = typeof step.url === "string" ? step.url : "";
  const script = typeof step.script === "string" ? step.script : "";
  const label = typeof step.label === "string" ? step.label : undefined;
  const screenshotPath = typeof step.path === "string" ? step.path : undefined;
  const fullPage = typeof step.full_page === "boolean" ? step.full_page : false;
  const stepTimeout = clampInt(step.timeout_ms, 200, 120_000, 15_000);

  if (action === "goto") {
    const destination = url || value;
    if (!destination) throw new Error("goto requires url or value");
    await page.goto(destination, { waitUntil: "domcontentloaded", timeout: stepTimeout });
    return { action, label, ok: true, url: page.url() };
  }
  if (action === "click") {
    if (!selector) throw new Error("click requires selector");
    await page.click(selector, { timeout: stepTimeout });
    return { action, label, ok: true, selector };
  }
  if (action === "hover") {
    if (!selector) throw new Error("hover requires selector");
    await page.hover(selector, { timeout: stepTimeout });
    return { action, label, ok: true, selector };
  }
  if (action === "fill") {
    if (!selector) throw new Error("fill requires selector");
    await page.fill(selector, value, { timeout: stepTimeout });
    return { action, label, ok: true, selector };
  }
  if (action === "press") {
    if (!selector) throw new Error("press requires selector");
    await page.press(selector, value || "Enter", { timeout: stepTimeout });
    return { action, label, ok: true, selector, key: value || "Enter" };
  }
  if (action === "check") {
    if (!selector) throw new Error("check requires selector");
    await page.check(selector, { timeout: stepTimeout });
    return { action, label, ok: true, selector };
  }
  if (action === "uncheck") {
    if (!selector) throw new Error("uncheck requires selector");
    await page.uncheck(selector, { timeout: stepTimeout });
    return { action, label, ok: true, selector };
  }
  if (action === "select") {
    if (!selector) throw new Error("select requires selector");
    const values = value.includes("|")
      ? value.split("|").map((item) => item.trim()).filter(Boolean)
      : value;
    await page.selectOption(selector, values, { timeout: stepTimeout });
    return { action, label, ok: true, selector, value };
  }
  if (action === "wait_for_selector") {
    if (!selector) throw new Error("wait_for_selector requires selector");
    await page.waitForSelector(selector, { timeout: stepTimeout });
    return { action, label, ok: true, selector };
  }
  if (action === "wait_for_url") {
    const destination = url || value;
    if (!destination) throw new Error("wait_for_url requires url or value");
    await page.waitForURL(destination, { timeout: stepTimeout });
    return { action, label, ok: true, url: page.url() };
  }
  if (action === "wait_for_timeout") {
    const waitMs = clampInt(step.timeout_ms, 0, 120_000, 1_000);
    await page.waitForTimeout(waitMs);
    return { action, label, ok: true, waitMs };
  }
  if (action === "extract_text") {
    const extracted = await page.evaluate((args) => {
      const s = typeof args === "object" && args !== null && "selector" in args
        ? String((args as Record<string, unknown>).selector ?? "")
        : "";
      if (!s) return document.body?.innerText ?? "";
      return document.querySelector(s)?.textContent ?? "";
    }, { selector });
    return { action, label, ok: true, selector: selector || "body", text: clampText(String(extracted).trim(), 1_000) };
  }
  if (action === "extract_html") {
    const extracted = await page.evaluate((args) => {
      const s = typeof args === "object" && args !== null && "selector" in args
        ? String((args as Record<string, unknown>).selector ?? "")
        : "";
      if (!s) return document.documentElement?.outerHTML ?? "";
      return document.querySelector(s)?.outerHTML ?? "";
    }, { selector });
    return { action, label, ok: true, selector: selector || "html", htmlPreview: clampText(String(extracted).trim(), 1_000) };
  }
  if (action === "expect_text") {
    if (!value) throw new Error("expect_text requires value");
    const matched = await page.evaluate((args) => {
      const input = args as Record<string, unknown>;
      const selectorValue = typeof input.selector === "string" ? input.selector : "";
      const expected = typeof input.expected === "string" ? input.expected : "";
      const text = selectorValue
        ? (document.querySelector(selectorValue)?.textContent ?? "")
        : (document.body?.innerText ?? "");
      return text.includes(expected);
    }, { selector, expected: value });
    if (!matched) throw new Error(`Expected text not found: ${value}`);
    return { action, label, ok: true, selector: selector || "body", expected: value };
  }
  if (action === "evaluate") {
    if (!script) throw new Error("evaluate requires script");
    const evalResult = await page.evaluate(async (source) => {
      const attempts = [
        () => new Function(`return (${source});`)(),
        () => new Function(`return (async () => (${source}))();`)(),
        () => new Function(`return (async () => {${source}\n})();`)(),
      ];
      let lastError = "Unknown evaluate failure.";
      for (const attempt of attempts) {
        try {
          const executable = attempt();
          if (typeof executable === "function") {
            return await executable();
          }
          return await executable;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      throw new Error(lastError);
    }, script);
    return {
      action,
      label,
      ok: true,
      result: typeof evalResult === "string"
        ? clampText(evalResult, 1_000)
        : clampText(JSON.stringify(evalResult ?? null) ?? "null", 1_000),
    };
  }
  if (action === "screenshot") {
    const shot = await page.screenshot(
      screenshotPath
        ? { path: screenshotPath, fullPage }
        : { fullPage, type: "jpeg", quality: 65 },
    );
    return {
      action,
      label,
      ok: true,
      ...(screenshotPath ? { path: screenshotPath } : { screenshotBase64: Buffer.from(shot).toString("base64"), mimeType: "image/jpeg" }),
      bytes: shot.byteLength,
    };
  }
  throw new Error(`Unsupported step action: ${action}`);
}

class WebSessionManager {
  listSessions(filter?: { deviceId?: string; status?: ProtocolSessionRecord["status"] }): ProtocolSessionRecord[] {
    return stateStore.getProtocolSessions({
      ...(filter?.deviceId ? { deviceId: filter.deviceId } : {}),
      protocol: "web-session",
      ...(filter?.status ? { status: filter.status } : {}),
    });
  }

  getSession(id: string): ProtocolSessionRecord | undefined {
    const session = stateStore.getProtocolSessionById(id);
    return session?.protocol === "web-session" ? session : undefined;
  }

  findReusableSession(deviceId: string | undefined, origin: string): ProtocolSessionRecord | undefined {
    const sessions = this.listSessions(deviceId ? { deviceId } : undefined);
    return sessions.find((session) => {
      const config = isRecord(session.configJson) ? session.configJson : {};
      return safeString(config.origin) === origin && session.status !== "stopped";
    });
  }

  private async readStorageState(session: ProtocolSessionRecord | undefined): Promise<PlaywrightStorageState | undefined> {
    const secretRef = session && isRecord(session.configJson)
      ? safeString(session.configJson.storageStateSecretRef)
      : undefined;
    if (!secretRef) {
      return undefined;
    }
    const raw = await vault.getSecret(secretRef);
    return parseStorageState(raw);
  }

  async buildCookieHeader(sessionId: string, targetUrl: string): Promise<string | undefined> {
    const session = this.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const state = await this.readStorageState(session);
    return buildCookieHeaderFromState(state, targetUrl);
  }

  async resolveSessionForUrl(args: {
    deviceId?: string;
    targetUrl: string;
    explicitSessionId?: string;
  }): Promise<ProtocolSessionRecord | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(args.targetUrl);
    } catch {
      return undefined;
    }
    if (args.explicitSessionId) {
      const explicit = this.getSession(args.explicitSessionId);
      if (explicit) {
        return explicit;
      }
    }
    return this.findReusableSession(args.deviceId, parsed.origin);
  }

  private async persistSessionState(args: {
    session: ProtocolSessionRecord;
    storageState: PlaywrightStorageState;
    origin: string;
    loginUrl: string;
    finalUrl: string;
    title: string;
    csrfHints: Record<string, string>;
    device?: Device;
    credentialId?: string;
  }): Promise<ProtocolSessionRecord> {
    const unlocked = await vault.ensureUnlocked();
    if (!unlocked) {
      throw new Error("Vault is unavailable for persisted web sessions.");
    }
    const secretRef = storageStateSecretRef(args.session.id);
    await vault.setSecret(secretRef, JSON.stringify(args.storageState));
    const storageSummary = summarizeStorageState(args.storageState);
    const next: ProtocolSessionRecord = {
      ...args.session,
      status: storageSummary.cookieCount > 0 || storageSummary.origins.length > 0 ? "connected" : "idle",
      summary: `${args.device?.name ?? "Web session"} @ ${args.origin}`,
      configJson: {
        ...(isRecord(args.session.configJson) ? args.session.configJson : {}),
        origin: args.origin,
        loginUrl: args.loginUrl,
        finalUrl: args.finalUrl,
        latestTitle: args.title,
        storageStateSecretRef: secretRef,
        credentialId: args.credentialId,
        cookieCount: storageSummary.cookieCount,
        origins: storageSummary.origins,
        localStorageKeys: storageSummary.localStorageKeys,
        csrfHints: args.csrfHints,
      },
      lastConnectedAt: nowIso(),
      lastError: undefined,
      updatedAt: nowIso(),
    };
    return stateStore.upsertProtocolSession(next);
  }

  async runBrowserFlow(args: BrowserFlowArgs): Promise<Record<string, unknown>> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(args.url);
    } catch {
      return { ok: false, error: "url must be an absolute URL." };
    }

    const chromium = await loadPlaywrightChromiumRuntime() as PlaywrightChromium | null;
    if (!chromium) {
      return { ok: false, error: "Playwright is not available on this Steward host." };
    }

    const reuseSession = args.reuseSession !== false;
    const existing = args.resetSession
      ? undefined
      : (args.sessionId ? this.getSession(args.sessionId) : reuseSession ? this.findReusableSession(args.device?.id, parsedUrl.origin) : undefined);
    const sessionDeviceId = args.device?.id ?? existing?.deviceId;
    const persistSession = args.persistSession !== false && Boolean(sessionDeviceId);
    const sessionId = args.sessionId ?? existing?.id ?? makeSessionId(args.device?.id, parsedUrl.origin);
    const session: ProtocolSessionRecord = existing ?? {
      id: sessionId,
      deviceId: sessionDeviceId ?? "",
      protocol: "web-session",
      desiredState: "idle",
      status: "idle",
      arbitrationMode: "shared",
      singleConnectionHint: false,
      keepaliveAllowed: false,
      summary: `${args.device?.name ?? "Web session"} @ ${parsedUrl.origin}`,
      configJson: {
        origin: parsedUrl.origin,
        loginUrl: parsedUrl.toString(),
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const storageState = args.resetSession ? undefined : await this.readStorageState(existing);
    const holder = args.sessionHolder?.trim() || `browser:${args.device?.id ?? session.id}`;
    const purpose = args.purpose?.trim() || `Browser flow for ${parsedUrl.origin}`;
    const lease = buildLease(session, holder, purpose);
    if (persistSession) {
      stateStore.upsertProtocolSession({
        ...session,
        activeLeaseId: undefined,
        status: "connecting",
        updatedAt: nowIso(),
      });
      stateStore.upsertProtocolSessionLease(lease);
      stateStore.upsertProtocolSession({
        ...session,
        activeLeaseId: lease.id,
        status: "connecting",
        updatedAt: nowIso(),
      });
    }

    let browser: PlaywrightBrowser | null = null;
    let context: PlaywrightContext | null = null;
    let page: PlaywrightPage | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        ignoreHTTPSErrors: true,
        ...(storageState ? { storageState } : {}),
      });
      page = await context.newPage();

      const consoleErrors: string[] = [];
      const requestFailures: string[] = [];
      const pageErrors: string[] = [];
      const stepResults: Array<Record<string, unknown>> = [];
      const authResponses: Array<{ url: string; status: number; body: string }> = [];
      if (readBool(args.collectDiagnostics, true)) {
        page.on("console", (...events) => {
          const message = events[0] as { type?: () => string; text?: () => string } | undefined;
          const type = message?.type?.() ?? "log";
          const text = message?.text?.() ?? "";
          if ((type === "error" || type === "warning") && text.trim().length > 0) {
            consoleErrors.push(`${type}: ${text.trim()}`);
          }
        });
        page.on("requestfailed", (...events) => {
          const request = events[0] as {
            method?: () => string;
            url?: () => string;
            failure?: () => { errorText?: string } | null;
          } | undefined;
          const method = request?.method?.() ?? "REQUEST";
          const url = request?.url?.() ?? "unknown-url";
          const failure = request?.failure?.()?.errorText ?? "request failed";
          requestFailures.push(`${method} ${url} :: ${failure}`);
        });
        page.on("pageerror", (...events) => {
          const err = events[0];
          const text = err instanceof Error ? err.message : String(err);
          if (text.trim().length > 0) {
            pageErrors.push(text.trim());
          }
        });
      }
      page.on("response", (...events) => {
        const response = events[0] as PlaywrightResponse | undefined;
        const url = response?.url?.() ?? "";
        if (!response || !url || !looksLikeAuthResponse(url)) {
          return;
        }
        void (async () => {
          try {
            const body = clampText(await response.text(), 2_000);
            authResponses.push({
              url,
              status: response.status(),
              body,
            });
            if (authResponses.length > 8) {
              authResponses.shift();
            }
          } catch {
            // ignore unreadable auth response bodies
          }
        })();
      });

      await page.goto(parsedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });

      let usedCredential = false;
      const hasLoginCredentialInput = typeof args.username === "string"
        && args.username.length > 0
        && typeof args.password === "string";
      const inferredSelectors = hasLoginCredentialInput
        ? await inferLoginSelectors(page)
        : {};
      const usernameSelector = chooseLoginSelector(args.usernameSelector, inferredSelectors.usernameSelector);
      const passwordSelector = chooseLoginSelector(args.passwordSelector, inferredSelectors.passwordSelector);
      const submitSelector = chooseLoginSelector(args.submitSelector, inferredSelectors.submitSelector);
      if (usernameSelector && passwordSelector && hasLoginCredentialInput) {
        const loginUsername = args.username;
        const loginPassword = args.password;
        if (typeof loginUsername !== "string" || typeof loginPassword !== "string") {
          throw new Error("Login credentials disappeared while preparing the browser flow.");
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (attempt > 0) {
            await page.goto(parsedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.waitForSelector(usernameSelector, { timeout: 15_000 });
          }
          await page.waitForTimeout(2500);
          authResponses.length = 0;
          await page.fill(usernameSelector, loginUsername, { timeout: 15_000 });
          await page.fill(passwordSelector, loginPassword, { timeout: 15_000 });
          await syncCsrfFields(page);
          await page.waitForTimeout(250);
          if (submitSelector) {
            await page.click(submitSelector, { timeout: 15_000 });
          } else {
            await page.press(passwordSelector, "Enter", { timeout: 15_000 });
          }
          if ((args.postLoginWaitMs ?? 0) > 0) {
            await page.waitForTimeout(clampInt(args.postLoginWaitMs, 0, 60_000, 1_000));
          }
          const authState = authResponseState(authResponses);
          if (authState.success && authState.redirect) {
            const currentUrl = page.url();
            const redirectUrl = new URL(authState.redirect, parsedUrl.origin).toString();
            if (currentUrl === parsedUrl.toString() || currentUrl.endsWith("/auth/signin/")) {
              await page.goto(redirectUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
              if ((args.postLoginWaitMs ?? 0) > 0) {
                await page.waitForTimeout(clampInt(args.postLoginWaitMs, 0, 60_000, 1_000));
              }
            }
            break;
          }
          if (!authState.success) {
            const ajaxFallback = await submitAjaxLoginForm({
              page,
              usernameSelector,
              passwordSelector,
              username: loginUsername,
              password: loginPassword,
              origin: parsedUrl.origin,
            });
            if (ajaxFallback.success) {
              if ((args.postLoginWaitMs ?? 0) > 0) {
                await page.waitForTimeout(clampInt(args.postLoginWaitMs, 0, 60_000, 1_000));
              }
              break;
            }
          }
          if (!authState.csrfFailure) {
            break;
          }
        }
        usedCredential = Boolean(args.credentialId) || typeof args.password === "string";
      }

      for (const step of args.steps ?? []) {
        try {
          stepResults.push(await runBrowserStep(page, step));
        } catch (stepError) {
          const message = stepError instanceof Error ? stepError.message : String(stepError);
          throw new Error(`Browser step failed (${step.action || "unknown"}${step.label ? `:${step.label}` : ""}): ${message}`);
        }
      }

      if (args.waitForSelector) {
        await page.waitForSelector(args.waitForSelector, { timeout: 15_000 });
      }

      const finalUrl = page.url();
      const title = await page.title();
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      const contentPreview = clampText(text.trim().replace(/\s+/g, " "), 900);
      const htmlPreview = args.includeHtml ? clampText(await page.content(), 1_800) : undefined;
      const nextStorageState = (await context.storageState()) as PlaywrightStorageState;
      const csrfHints = await evaluatePageCsrfHints(page);
      const persisted = persistSession
        ? await this.persistSessionState({
          session,
          storageState: nextStorageState,
          origin: parsedUrl.origin,
          loginUrl: parsedUrl.toString(),
          finalUrl,
          title,
          csrfHints,
          device: args.device,
          credentialId: args.credentialId,
        })
        : session;

      if (args.device && usedCredential && args.credentialId && args.markCredentialValidated !== false) {
        await markCredentialValidatedFromUse({
          deviceId: args.device.id,
          credentialId: args.credentialId,
          actor: args.actor ?? "steward",
          method: "web-session.browser",
          details: {
            sessionId: persisted.id,
            url: parsedUrl.toString(),
            finalUrl,
            title,
          },
        });
      }

      if (persistSession) {
        stateStore.addProtocolSessionMessage({
          id: randomUUID(),
          sessionId: persisted.id,
          deviceId: persisted.deviceId,
          direction: "system",
          channel: finalUrl,
          payload: contentPreview,
          metadataJson: {
            title,
            stepsExecuted: stepResults.length,
          },
          observedAt: nowIso(),
        });

        stateStore.upsertProtocolSessionLease({
          ...lease,
          status: "released",
          releasedAt: nowIso(),
        });
        stateStore.upsertProtocolSession({
          ...persisted,
          activeLeaseId: undefined,
          updatedAt: nowIso(),
        });
      }

      return {
        ok: true,
        deviceId: args.device?.id,
        deviceName: args.device?.name,
        session: persistSession ? (stateStore.getProtocolSessionById(persisted.id) ?? persisted) : persisted,
        url: parsedUrl.toString(),
        finalUrl,
        title,
        usedStoredCredential: Boolean(args.credentialId),
        credentialId: args.credentialId,
        contentPreview,
        htmlPreview,
        stepsExecuted: stepResults.length,
        stepResults,
        diagnostics: readBool(args.collectDiagnostics, true)
          ? {
            consoleErrors: consoleErrors.slice(0, 40),
            requestFailures: requestFailures.slice(0, 40),
            pageErrors: pageErrors.slice(0, 20),
            authResponses: authResponses.slice(-4),
          }
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (persistSession) {
        stateStore.upsertProtocolSessionLease({
          ...lease,
          status: "released",
          releasedAt: nowIso(),
        });
        stateStore.upsertProtocolSession({
          ...session,
          activeLeaseId: undefined,
          status: "error",
          lastError: message,
          updatedAt: nowIso(),
        });
      }
      return {
        ok: false,
        error: `Playwright browser flow failed: ${message}`,
        session: persistSession ? (stateStore.getProtocolSessionById(session.id) ?? session) : session,
        url: parsedUrl.toString(),
        deviceId: args.device?.id,
        deviceName: args.device?.name,
      };
    } finally {
      if (page) {
        try { await page.close(); } catch {}
      }
      if (context) {
        try { await context.close(); } catch {}
      }
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  }

  async sweep(): Promise<void> {
    for (const session of this.listSessions()) {
      const secretRef = isRecord(session.configJson) ? safeString(session.configJson.storageStateSecretRef) : undefined;
      if (!secretRef) {
        continue;
      }
      const raw = await vault.getSecret(secretRef);
      if (!raw) {
        stateStore.upsertProtocolSession({
          ...session,
          status: "error",
          lastError: "Persisted web session storage state is missing.",
          updatedAt: nowIso(),
        });
      }
    }
  }
}

export const webSessionManager = new WebSessionManager();
