#!/usr/bin/env node
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const GUACD_PORT = 4822;
const GUACD_HOST_CANDIDATES = ["127.0.0.1", "localhost", "guacd"];
const GUACD_CONTAINER_NAME = "steward-guacd";
const GUACD_IMAGE = "guacamole/guacd:1.6.0";
const DEFAULT_WAIT_MS = 15_000;
const BEST_EFFORT = process.argv.includes("--best-effort");

function log(message) {
  console.log(`[remote-desktop] ${message}`);
}

function warn(message) {
  console.warn(`[remote-desktop] ${message}`);
}

function fail(message) {
  if (BEST_EFFORT) {
    warn(message);
    return false;
  }
  console.error(`[remote-desktop] ${message}`);
  process.exit(1);
}

function commandExists(command) {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [command], { stdio: "ignore" });
  return result.status === 0;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeHost(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function guacdReachable() {
  for (const host of GUACD_HOST_CANDIDATES) {
    if (await probeHost(host, GUACD_PORT)) {
      return true;
    }
  }
  return false;
}

async function waitForGuacd(timeoutMs = DEFAULT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await guacdReachable()) {
      return true;
    }
    await sleep(500);
  }
  return guacdReachable();
}

function dockerInstalled() {
  return commandExists("docker");
}

function dockerDaemonReady() {
  if (!dockerInstalled()) {
    return false;
  }
  return run("docker", ["info"]).status === 0;
}

async function maybeStartLocalGuacdBinary() {
  if (!commandExists("guacd")) {
    return false;
  }
  log("Starting local guacd runtime.");
  const child = spawn("guacd", ["-b", "127.0.0.1", "-p", String(GUACD_PORT)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return waitForGuacd();
}

function dockerContainerExists() {
  if (!dockerDaemonReady()) {
    return false;
  }
  const result = run("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^/${GUACD_CONTAINER_NAME}$`,
    "--format",
    "{{.ID}}",
  ]);
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function ensureDockerGuacd() {
  if (!dockerDaemonReady()) {
    return false;
  }

  const running = run("docker", [
    "ps",
    "--filter",
    `name=^/${GUACD_CONTAINER_NAME}$`,
    "--format",
    "{{.ID}}",
  ]);
  if (running.status === 0 && running.stdout.trim().length > 0) {
    log("guacd container already running.");
    return waitForGuacd();
  }

  if (dockerContainerExists()) {
    log("Starting existing guacd container.");
    const started = run("docker", ["start", GUACD_CONTAINER_NAME]);
    if (started.status !== 0) {
      warn((started.stderr || started.stdout || "Failed to start guacd container.").trim());
      return false;
    }
    return waitForGuacd();
  }

  log("Creating guacd container via Docker.");
  const created = run("docker", [
    "run",
    "-d",
    "--name",
    GUACD_CONTAINER_NAME,
    "--restart",
    "unless-stopped",
    "-p",
    `${GUACD_PORT}:${GUACD_PORT}`,
    GUACD_IMAGE,
  ]);
  if (created.status !== 0) {
    warn((created.stderr || created.stdout || "Failed to create guacd container.").trim());
    return false;
  }
  return waitForGuacd();
}

function dockerDesktopCandidates() {
  const candidates = [
    "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
  ];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Docker", "Docker", "Docker Desktop.exe"));
  }
  return candidates.filter((candidate, index, all) => all.indexOf(candidate) === index);
}

async function maybeStartDockerDesktop() {
  if (process.platform !== "win32") {
    return false;
  }
  const executable = dockerDesktopCandidates().find((candidate) => existsSync(candidate));
  if (!executable) {
    return false;
  }

  log("Starting Docker Desktop so the guacd container can run.");
  const child = spawn(executable, [], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (dockerDaemonReady()) {
      return true;
    }
    await sleep(1_000);
  }
  return false;
}

async function main() {
  if (await waitForGuacd(1_200)) {
    log("guacd is already reachable.");
    return;
  }

  if (await maybeStartLocalGuacdBinary()) {
    log("guacd started from local binary.");
    return;
  }

  if (!dockerDaemonReady() && dockerInstalled()) {
    await maybeStartDockerDesktop();
  }

  if (await ensureDockerGuacd()) {
    log("guacd is ready for browser-native remote desktop sessions.");
    return;
  }

  fail(
    process.platform === "win32"
      ? "guacd is unavailable. Install or start Docker Desktop, or run Steward through docker compose, which now includes guacd."
      : "guacd is unavailable. Install Docker or a local guacd binary, or run Steward through docker compose, which now includes guacd.",
  );
}

await main();
