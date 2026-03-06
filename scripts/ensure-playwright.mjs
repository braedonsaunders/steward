#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const BEST_EFFORT = process.argv.includes("--best-effort");
const NPX_COMMAND = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args) {
  return spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
}

async function browserInstalled() {
  const mod = await import("playwright");
  const executable = mod.chromium?.executablePath?.();
  return typeof executable === "string" && executable.length > 0 && existsSync(executable);
}

async function main() {
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
  const install = run(NPX_COMMAND, ["playwright", "install", "chromium"]);
  if ((install.status ?? 1) !== 0) {
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
