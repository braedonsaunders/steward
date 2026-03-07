#!/usr/bin/env node
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  let port = process.env.PORT ?? "3010";
  let hostname = process.env.HOSTNAME ?? "0.0.0.0";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (/^\d+$/.test(arg)) {
      port = arg;
      continue;
    }

    if (arg === "-p" || arg === "--port") {
      const value = argv[index + 1];
      if (!value) {
        fail("[start-prod] Missing value for port.");
      }
      port = value;
      index += 1;
      continue;
    }

    if (arg === "-H" || arg === "--host" || arg === "--hostname") {
      const value = argv[index + 1];
      if (!value) {
        fail("[start-prod] Missing value for hostname.");
      }
      hostname = value;
      index += 1;
      continue;
    }

    fail(`[start-prod] Unsupported argument: ${arg}`);
  }

  if (!/^\d+$/.test(String(port))) {
    fail(`[start-prod] Invalid port: ${port}`);
  }

  return { port: String(port), hostname };
}

function replaceDirectory(fromPath, toPath) {
  if (!existsSync(fromPath)) {
    fail(`[start-prod] Missing required runtime asset directory: ${fromPath}`);
  }

  rmSync(toPath, { recursive: true, force: true });
  cpSync(fromPath, toPath, { recursive: true });
}

function syncStandaloneRuntimeAssets() {
  const repoStaticDir = path.resolve(".next/static");
  const standaloneStaticDir = path.resolve(".next/standalone/.next/static");
  replaceDirectory(repoStaticDir, standaloneStaticDir);

  const repoPublicDir = path.resolve("public");
  if (existsSync(repoPublicDir)) {
    const standalonePublicDir = path.resolve(".next/standalone/public");
    replaceDirectory(repoPublicDir, standalonePublicDir);
  }
}

const { port, hostname } = parseArgs(process.argv.slice(2));
const standaloneServerPath = path.resolve(".next/standalone/server.js");

if (!existsSync(standaloneServerPath)) {
  fail("[start-prod] Missing .next/standalone/server.js. Run `npm run build` first.");
}

syncStandaloneRuntimeAssets();

const child = spawn(process.execPath, [standaloneServerPath], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: port,
    HOSTNAME: hostname,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  fail(`[start-prod] Failed to launch standalone server: ${error.message}`);
});
