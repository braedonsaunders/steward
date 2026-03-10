import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface PlaywrightChromiumRuntime {
  launch: (options: Record<string, unknown>) => Promise<unknown>;
  executablePath?: () => string;
}

function resolveChromiumCandidate(mod: unknown): PlaywrightChromiumRuntime | null {
  if (!mod || typeof mod !== "object") {
    return null;
  }

  const record = mod as Record<string, unknown>;
  const chromium = record.chromium
    ?? ((record.default as Record<string, unknown> | undefined)?.chromium);
  if (!chromium || typeof chromium !== "object" || !("launch" in chromium)) {
    return null;
  }

  const runtime = chromium as PlaywrightChromiumRuntime;
  if (typeof runtime.executablePath === "function") {
    const executablePath = runtime.executablePath();
    if (typeof executablePath !== "string" || executablePath.length === 0 || !existsSync(executablePath)) {
      return null;
    }
  }

  return runtime;
}

export async function loadPlaywrightChromiumRuntime(): Promise<PlaywrightChromiumRuntime | null> {
  try {
    const runtime = resolveChromiumCandidate(require("playwright"));
    if (runtime) {
      return runtime;
    }
  } catch {
    // Fall through to dynamic import.
  }

  try {
    const runtime = resolveChromiumCandidate(await import("playwright"));
    if (runtime) {
      return runtime;
    }
  } catch {
    // Playwright may be unavailable on minimal installs.
  }

  return null;
}
