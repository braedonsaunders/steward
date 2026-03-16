#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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

function cleanupOldRuntimeDirectories(buildRootDir, currentRuntimeDir) {
  if (!existsSync(buildRootDir)) {
    return;
  }

  for (const entry of readdirSync(buildRootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (!entry.name.startsWith("standalone-runtime")) {
      continue;
    }

    const candidatePath = path.resolve(buildRootDir, entry.name);
    if (candidatePath === currentRuntimeDir) {
      continue;
    }

    try {
      rmSync(candidatePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // A prior runtime may still be draining on Windows. Leave it for the next launch.
    }
  }
}

function stageStandaloneRuntime() {
  const builtStandaloneDir = path.resolve(".next/standalone");
  const buildRootDir = path.resolve("build");
  mkdirSync(buildRootDir, { recursive: true });

  const runtimeDir = path.resolve(buildRootDir, `standalone-runtime-${Date.now()}-${process.pid}`);
  cpSync(builtStandaloneDir, runtimeDir, { recursive: true });

  const repoStaticDir = path.resolve(".next/static");
  const runtimeStaticDir = path.resolve(runtimeDir, ".next/static");
  replaceDirectory(repoStaticDir, runtimeStaticDir);

  const repoPublicDir = path.resolve("public");
  if (existsSync(repoPublicDir)) {
    const runtimePublicDir = path.resolve(runtimeDir, "public");
    replaceDirectory(repoPublicDir, runtimePublicDir);
  }

  cleanupOldRuntimeDirectories(buildRootDir, runtimeDir);

  return {
    runtimeDir,
    standaloneServerPath: path.resolve(runtimeDir, "server.js"),
  };
}

const { port, hostname } = parseArgs(process.argv.slice(2));
const builtStandaloneServerPath = path.resolve(".next/standalone/server.js");

if (!existsSync(builtStandaloneServerPath)) {
  fail("[start-prod] Missing .next/standalone/server.js. Run `npm run build` first.");
}

const { runtimeDir, standaloneServerPath } = stageStandaloneRuntime();

const child = spawn(process.execPath, [standaloneServerPath], {
  stdio: "inherit",
  cwd: runtimeDir,
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
