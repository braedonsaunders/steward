import type { Device } from "@/lib/state/types";
import { protocolSessionManager } from "@/lib/protocol-sessions/manager";
import { remoteDesktopManager } from "@/lib/remote-desktop/manager";
import type { RemoteDesktopControlMode, RemoteDesktopProtocol } from "@/lib/remote-desktop/types";
import { loadPlaywrightChromiumRuntime } from "@/lib/runtime/playwright";

export interface RemoteDesktopFlowStepInput {
  action: "snapshot" | "click" | "double_click" | "drag" | "scroll" | "type" | "key" | "wait";
  label?: string;
  x?: number;
  y?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  text?: string;
  key?: string;
  direction?: "up" | "down";
  amount?: number;
  duration_ms?: number;
  timeout_ms?: number;
}

export interface RemoteDesktopFlowArgs {
  device: Device;
  protocol?: RemoteDesktopProtocol;
  credentialId?: string;
  holder: string;
  purpose: string;
  mode?: RemoteDesktopControlMode;
  keepSessionOpen?: boolean;
  steps?: RemoteDesktopFlowStepInput[];
}

interface PlaywrightChromium {
  launch: (options: Record<string, unknown>) => Promise<PlaywrightBrowser>;
}

interface PlaywrightBrowser {
  newPage: (options?: Record<string, unknown>) => Promise<PlaywrightPage>;
  close: () => Promise<void>;
}

interface PlaywrightPage {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  waitForTimeout: (timeout: number) => Promise<void>;
  waitForFunction: (pageFunction: string | ((...args: unknown[]) => unknown), arg?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  evaluate: <T>(pageFunction: ((arg: unknown) => T) | (() => T), arg?: unknown) => Promise<T>;
}

interface RemoteDesktopStepResult {
  action: string;
  ok: boolean;
  label?: string;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  text?: string;
  key?: string;
  direction?: string;
  amount?: number;
  result?: string;
  screenshotBase64?: string;
  mimeType?: string;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}


async function waitForRemoteDesktopReady(page: PlaywrightPage): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (globalThis as { __stewardRemoteDesktop?: { getStatus?: () => { connected?: boolean } } }).__stewardRemoteDesktop;
      return Boolean(api?.getStatus?.().connected);
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function captureSnapshot(page: PlaywrightPage): Promise<{ mimeType: string; screenshotBase64: string } | null> {
  const dataUrl = await page.evaluate(() => {
    const api = (globalThis as {
      __stewardRemoteDesktop?: { captureSnapshot?: () => string | null | Promise<string | null> };
    }).__stewardRemoteDesktop;
    if (!api?.captureSnapshot) {
      return null;
    }
    return api.captureSnapshot();
  });

  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return null;
  }

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    screenshotBase64: match[2],
  };
}

async function performStep(page: PlaywrightPage, step: RemoteDesktopFlowStepInput): Promise<void> {
  const timeoutMs = clampInt(step.timeout_ms, 0, 30_000, 250);
  if (step.action === "wait") {
    await page.waitForTimeout(clampInt(step.timeout_ms, 0, 60_000, 1_000));
    return;
  }

  if (step.action === "snapshot") {
    await page.waitForTimeout(timeoutMs);
    return;
  }

  if (step.action === "click" || step.action === "double_click") {
    await page.evaluate((input) => {
      const api = (globalThis as {
        __stewardRemoteDesktop?: { clickAt?: (args: { x: number; y: number; clickCount?: number }) => Promise<void> | void };
      }).__stewardRemoteDesktop;
      if (!api?.clickAt) {
        throw new Error("Remote desktop click API is unavailable.");
      }
      const payload = input as { x?: number; y?: number; doubleClick?: boolean };
      if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) {
        throw new Error("click requires x and y coordinates.");
      }
      return api.clickAt({
        x: Math.floor(Number(payload.x)),
        y: Math.floor(Number(payload.y)),
        clickCount: payload.doubleClick ? 2 : 1,
      });
    }, {
      x: step.x,
      y: step.y,
      doubleClick: step.action === "double_click",
    });
    await page.waitForTimeout(timeoutMs);
    return;
  }

  if (step.action === "drag") {
    await page.evaluate((input) => {
      const api = (globalThis as {
        __stewardRemoteDesktop?: { drag?: (args: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }) => Promise<void> | void };
      }).__stewardRemoteDesktop;
      if (!api?.drag) {
        throw new Error("Remote desktop drag API is unavailable.");
      }
      const payload = input as { fromX?: number; fromY?: number; toX?: number; toY?: number; durationMs?: number };
      if (
        !Number.isFinite(payload.fromX)
        || !Number.isFinite(payload.fromY)
        || !Number.isFinite(payload.toX)
        || !Number.isFinite(payload.toY)
      ) {
        throw new Error("drag requires from_x, from_y, to_x, and to_y.");
      }
      return api.drag({
        fromX: Math.floor(Number(payload.fromX)),
        fromY: Math.floor(Number(payload.fromY)),
        toX: Math.floor(Number(payload.toX)),
        toY: Math.floor(Number(payload.toY)),
        durationMs: Number.isFinite(Number(payload.durationMs)) ? Math.floor(Number(payload.durationMs)) : 320,
      });
    }, {
      fromX: step.from_x,
      fromY: step.from_y,
      toX: step.to_x,
      toY: step.to_y,
      durationMs: step.duration_ms,
    });
    await page.waitForTimeout(timeoutMs);
    return;
  }

  if (step.action === "scroll") {
    await page.evaluate((input) => {
      const api = (globalThis as {
        __stewardRemoteDesktop?: { scrollAt?: (args: { x: number; y: number; direction: "up" | "down"; amount?: number }) => Promise<void> | void };
      }).__stewardRemoteDesktop;
      if (!api?.scrollAt) {
        throw new Error("Remote desktop scroll API is unavailable.");
      }
      const payload = input as { x?: number; y?: number; direction?: "up" | "down"; amount?: number };
      if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) {
        throw new Error("scroll requires x and y coordinates.");
      }
      return api.scrollAt({
        x: Math.floor(Number(payload.x)),
        y: Math.floor(Number(payload.y)),
        direction: payload.direction === "up" ? "up" : "down",
        amount: Number.isFinite(Number(payload.amount)) ? Math.max(1, Math.floor(Number(payload.amount))) : 3,
      });
    }, {
      x: step.x,
      y: step.y,
      direction: step.direction,
      amount: step.amount,
    });
    await page.waitForTimeout(timeoutMs);
    return;
  }

  if (step.action === "type") {
    await page.evaluate((input) => {
      const api = (globalThis as {
        __stewardRemoteDesktop?: { typeText?: (text: string) => Promise<void> | void };
      }).__stewardRemoteDesktop;
      if (!api?.typeText) {
        throw new Error("Remote desktop typing API is unavailable.");
      }
      const payload = input as { text?: string };
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text) {
        throw new Error("type requires text.");
      }
      return api.typeText(text);
    }, {
      text: step.text,
    });
    await page.waitForTimeout(timeoutMs);
    return;
  }

  if (step.action === "key") {
    await page.evaluate((input) => {
      const api = (globalThis as {
        __stewardRemoteDesktop?: { pressKey?: (key: string) => Promise<void> | void };
      }).__stewardRemoteDesktop;
      if (!api?.pressKey) {
        throw new Error("Remote desktop key API is unavailable.");
      }
      const payload = input as { key?: string };
      const key = typeof payload.key === "string" ? payload.key : "";
      if (!key) {
        throw new Error("key requires a key value.");
      }
      return api.pressKey(key);
    }, {
      key: step.key,
    });
    await page.waitForTimeout(timeoutMs);
    return;
  }

  throw new Error(`Unsupported remote desktop step action: ${step.action}`);
}

function normalizeStepResult(step: RemoteDesktopFlowStepInput): RemoteDesktopStepResult {
  return {
    action: step.action,
    ok: true,
    label: step.label,
    x: typeof step.x === "number" ? Math.floor(step.x) : undefined,
    y: typeof step.y === "number" ? Math.floor(step.y) : undefined,
    fromX: typeof step.from_x === "number" ? Math.floor(step.from_x) : undefined,
    fromY: typeof step.from_y === "number" ? Math.floor(step.from_y) : undefined,
    toX: typeof step.to_x === "number" ? Math.floor(step.to_x) : undefined,
    toY: typeof step.to_y === "number" ? Math.floor(step.to_y) : undefined,
    text: typeof step.text === "string" && step.text.length > 0 ? step.text : undefined,
    key: typeof step.key === "string" && step.key.length > 0 ? step.key : undefined,
    direction: step.direction,
    amount: typeof step.amount === "number" ? step.amount : undefined,
  };
}

export async function runRemoteDesktopFlow(args: RemoteDesktopFlowArgs): Promise<Record<string, unknown>> {
  const chromium = await loadPlaywrightChromiumRuntime() as PlaywrightChromium | null;
  if (!chromium) {
    return {
      ok: false,
      error: "Playwright is unavailable on this Steward host.",
    };
  }

  const access = await remoteDesktopManager.openSession({
    device: args.device,
    protocol: args.protocol,
    credentialId: args.credentialId,
    holder: args.holder,
    purpose: args.purpose,
    mode: args.mode ?? "command",
    exclusive: (args.mode ?? "command") !== "observe",
  });

  const absoluteViewerUrl = remoteDesktopManager.buildAbsoluteUrl(
    remoteDesktopManager.localStewardOrigin(),
    access.viewerPath,
  );

  const steps = Array.isArray(args.steps) && args.steps.length > 0
    ? args.steps
    : [{ action: "snapshot", label: "Initial snapshot" } as RemoteDesktopFlowStepInput];

  let browser: PlaywrightBrowser | null = null;
  let page: PlaywrightPage | null = null;
  const stepResults: RemoteDesktopStepResult[] = [];
  let lastSnapshot: { mimeType: string; screenshotBase64: string } | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await page.goto(absoluteViewerUrl, { waitUntil: "networkidle", timeout: 45_000 });
    await waitForRemoteDesktopReady(page);

    for (const step of steps) {
      const result = normalizeStepResult(step);
      try {
        await performStep(page, step);
        lastSnapshot = await captureSnapshot(page);
        if (lastSnapshot) {
          result.mimeType = lastSnapshot.mimeType;
          result.screenshotBase64 = lastSnapshot.screenshotBase64;
        }
        stepResults.push(result);
      } catch (error) {
        const failure = normalizeStepResult(step);
        failure.ok = false;
        failure.result = error instanceof Error ? error.message : String(error);
        lastSnapshot = await captureSnapshot(page);
        if (lastSnapshot) {
          failure.mimeType = lastSnapshot.mimeType;
          failure.screenshotBase64 = lastSnapshot.screenshotBase64;
        }
        stepResults.push(failure);
        return {
          ok: false,
          error: failure.result,
          sessionId: access.session.id,
          deviceId: args.device.id,
          deviceName: args.device.name,
          protocol: access.session.protocol,
          viewerPath: access.viewerPath,
          stepsExecuted: stepResults.length,
          stepResults,
        };
      }
    }

    return {
      ok: true,
      sessionId: access.session.id,
      deviceId: args.device.id,
      deviceName: args.device.name,
      protocol: access.session.protocol,
      viewerPath: access.viewerPath,
      stepsExecuted: stepResults.length,
      stepResults,
      screenshotBase64: lastSnapshot?.screenshotBase64,
      mimeType: lastSnapshot?.mimeType,
    };
  } finally {
    if (!args.keepSessionOpen) {
      protocolSessionManager.releaseLease(access.lease.id);
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

