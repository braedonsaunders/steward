#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DEFAULT_PORT = 3010;
const rawPorts = process.argv.slice(2);
const ports = rawPorts.length > 0 ? rawPorts : [String(DEFAULT_PORT)];

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[dev] Invalid port: ${value}`);
    process.exit(1);
  }
  return port;
}

function parsePidList(text) {
  return Array.from(
    new Set(
      text
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  );
}

function listListeningPidsUnix(targetPort) {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${targetPort}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return parsePidList(output);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 1) {
      return [];
    }
    throw error;
  }
}

function listListeningPidsWindows(targetPort) {
  try {
    const output = execFileSync(
      "netstat",
      ["-ano", "-p", "tcp"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return Array.from(
      new Set(
        output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith("TCP"))
          .map((line) => line.split(/\s+/))
          .filter((parts) => {
            const localAddress = parts[1] ?? "";
            const state = parts[3] ?? "";
            return localAddress.endsWith(`:${targetPort}`) && state === "LISTENING";
          })
          .map((parts) => Number.parseInt(parts[4] ?? "", 10))
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      ),
    );
  } catch {
    return [];
  }
}

function listListeningPids(targetPort) {
  if (process.platform === "win32") {
    return listListeningPidsWindows(targetPort);
  }
  return listListeningPidsUnix(targetPort);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.filter((pid) => isProcessAlive(pid));
    if (alive.length === 0) {
      return [];
    }
    await sleep(125);
  }
  return pids.filter((pid) => isProcessAlive(pid));
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = error.code;
      if (code === "ESRCH") {
        return false;
      }
      if (code === "EPERM") {
        console.error(`[dev] Permission denied sending ${signal} to PID ${pid}`);
        return false;
      }
    }
    throw error;
  }
}

async function freePort(port) {
  const pids = listListeningPids(port).filter((pid) => pid !== process.pid);

  if (pids.length === 0) {
    return;
  }

  console.log(`[dev] Port ${port} is in use by PID(s): ${pids.join(", ")}. Attempting cleanup...`);

  for (const pid of pids) {
    signalProcess(pid, "SIGTERM");
  }

  let remaining = await waitForExit(pids, 2500);
  if (remaining.length > 0) {
    for (const pid of remaining) {
      signalProcess(pid, "SIGKILL");
    }
    remaining = await waitForExit(remaining, 1000);
  }

  if (remaining.length > 0) {
    console.error(`[dev] Unable to free port ${port}. Remaining PID(s): ${remaining.join(", ")}`);
    process.exit(1);
  }

  console.log(`[dev] Freed port ${port}.`);
}

for (const port of ports.map(parsePort)) {
  await freePort(port);
}
