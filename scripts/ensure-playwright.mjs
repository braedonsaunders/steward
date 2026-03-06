#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const BEST_EFFORT = process.argv.includes("--best-effort");
const require = createRequire(import.meta.url);

function run(command, args) {
  return spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...(process.platform === "win32" && command.endsWith(".cmd") ? { shell: true } : {}),
  });
}

function reportSpawnFailure(result) {
  if (!result.error) {
    return;
  }
  console.error(`Command failed to start: ${result.error.message}`);
}

function resolvePlaywrightCli() {
  try {
    const playwrightPkg = require.resolve("playwright/package.json");
    return path.join(path.dirname(playwrightPkg), "cli.js");
  } catch {
    return null;
  }
}

async function browserInstalled() {
  const mod = await import("playwright");
  const executable = mod.chromium?.executablePath?.();
  return typeof executable === "string" && executable.length > 0 && existsSync(executable);
}

async function main() {
  const cliPath = resolvePlaywrightCli();
  if (!cliPath) {
    const message = "Playwright dependency is missing from node_modules. Run npm ci and retry.";
    if (BEST_EFFORT) {
      console.warn(message);
      return;
    }
    throw new Error(message);
  }

  let installed = false;
  try {
    installed = await browserInstalled();
  } catch {
    installed = false;
  }

  if (installed) {
    console.log("Playwright Chromium runtime already installed.");
    return;
  }

  console.log("Installing Playwright Chromium runtime...");
  const install = run(process.execPath, [cliPath, "install", "chromium"]);
  if ((install.status ?? 1) !== 0) {
    reportSpawnFailure(install);
    const message = "Failed to install Playwright Chromium runtime.";
    if (BEST_EFFORT) {
      console.warn(message);
      return;
    }
    throw new Error(message);
  }

  const verified = await browserInstalled();
  if (!verified) {
    const message = "Playwright Chromium runtime install completed but executable was not found.";
    if (BEST_EFFORT) {
      console.warn(message);
      return;
    }
    throw new Error(message);
  }

  console.log("Playwright Chromium runtime installed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (!BEST_EFFORT) {
    process.exit(1);
  }
});
