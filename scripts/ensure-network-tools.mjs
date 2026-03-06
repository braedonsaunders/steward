#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const BEST_EFFORT = process.argv.includes("--best-effort");
const REQUIRED_COMMANDS = ["nmap", "tshark"];

function commandExists(cmd) {
  if (process.platform === "win32") {
    const result = spawnSync("where", [cmd], {
      stdio: "ignore",
      env: process.env,
    });
    if ((result.status ?? 1) === 0) {
      return true;
    }

    const programFiles = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ].filter((value) => typeof value === "string" && value.length > 0);

    const fallbackPaths = cmd === "tshark"
      ? programFiles.map((base) => path.join(base, "Wireshark", "tshark.exe"))
      : cmd === "nmap"
        ? programFiles.map((base) => path.join(base, "Nmap", "nmap.exe"))
        : [];

    return fallbackPaths.some((candidate) => existsSync(candidate));
  }

  const result = spawnSync("sh", ["-lc", `command -v ${cmd}`], {
    stdio: "ignore",
    env: process.env,
  });
  return (result.status ?? 1) === 0;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    stdio: "inherit",
    env: process.env,
    ...opts,
  });
}

function canUseSudoNonInteractive() {
  if (process.platform === "win32") {
    return false;
  }
  const probe = spawnSync("sudo", ["-n", "true"], {
    stdio: "ignore",
    env: process.env,
  });
  return (probe.status ?? 1) === 0;
}

function tryInstallUnix(packages) {
  if (packages.length === 0) {
    return false;
  }

  const installers = [
    {
      name: "apt-get",
      exists: () => commandExists("apt-get"),
      install: () => {
        const useSudo = canUseSudoNonInteractive();
        if (!useSudo && process.getuid && process.getuid() !== 0) {
          return false;
        }
        const update = useSudo
          ? run("sudo", ["-n", "apt-get", "update"])
          : run("apt-get", ["update"]);
        if ((update.status ?? 1) !== 0) return false;
        const install = useSudo
          ? run("sudo", ["-n", "apt-get", "install", "-y", ...packages])
          : run("apt-get", ["install", "-y", ...packages]);
        return (install.status ?? 1) === 0;
      },
    },
    {
      name: "dnf",
      exists: () => commandExists("dnf"),
      install: () => {
        const useSudo = canUseSudoNonInteractive();
        if (!useSudo && process.getuid && process.getuid() !== 0) return false;
        const args = useSudo ? ["-n", "dnf", "install", "-y", ...packages] : ["install", "-y", ...packages];
        const res = run(useSudo ? "sudo" : "dnf", args);
        return (res.status ?? 1) === 0;
      },
    },
    {
      name: "yum",
      exists: () => commandExists("yum"),
      install: () => {
        const useSudo = canUseSudoNonInteractive();
        if (!useSudo && process.getuid && process.getuid() !== 0) return false;
        const args = useSudo ? ["-n", "yum", "install", "-y", ...packages] : ["install", "-y", ...packages];
        const res = run(useSudo ? "sudo" : "yum", args);
        return (res.status ?? 1) === 0;
      },
    },
    {
      name: "pacman",
      exists: () => commandExists("pacman"),
      install: () => {
        const useSudo = canUseSudoNonInteractive();
        if (!useSudo && process.getuid && process.getuid() !== 0) return false;
        const args = useSudo ? ["-n", "pacman", "-Sy", "--noconfirm", ...packages] : ["-Sy", "--noconfirm", ...packages];
        const res = run(useSudo ? "sudo" : "pacman", args);
        return (res.status ?? 1) === 0;
      },
    },
    {
      name: "apk",
      exists: () => commandExists("apk"),
      install: () => {
        if (process.getuid && process.getuid() !== 0) return false;
        const res = run("apk", ["add", "--no-cache", ...packages]);
        return (res.status ?? 1) === 0;
      },
    },
  ];

  for (const installer of installers) {
    if (!installer.exists()) continue;
    console.log(`Attempting to install network tools via ${installer.name}...`);
    if (installer.install()) {
      return true;
    }
  }

  return false;
}

function tryInstallDarwin() {
  if (!commandExists("brew")) {
    return false;
  }
  console.log("Attempting to install network tools via Homebrew...");
  // wireshark provides tshark on macOS formula/cask variants.
  const res = run("brew", ["install", "nmap", "wireshark"]);
  return (res.status ?? 1) === 0;
}

function tryInstallWindows() {
  const hasChoco = commandExists("choco");
  if (hasChoco) {
    console.log("Attempting to install network tools via Chocolatey...");
    const nmap = run("choco", ["install", "-y", "nmap"]);
    const ws = run("choco", ["install", "-y", "wireshark"]);
    return (nmap.status ?? 1) === 0 && (ws.status ?? 1) === 0;
  }

  const hasWinget = commandExists("winget");
  if (hasWinget) {
    console.log("Attempting to install network tools via winget...");
    const nmap = run("winget", ["install", "--id", "Insecure.Nmap", "--accept-package-agreements", "--accept-source-agreements"]);
    const ws = run("winget", ["install", "--id", "WiresharkFoundation.Wireshark", "--accept-package-agreements", "--accept-source-agreements"]);
    return (nmap.status ?? 1) === 0 && (ws.status ?? 1) === 0;
  }

  return false;
}

function manualHelp(missing) {
  if (process.platform === "darwin") {
    return `Install required tools manually: brew install nmap wireshark (missing: ${missing.join(", ")})`;
  }
  if (process.platform === "win32") {
    return `Install required tools manually: choco install nmap wireshark -y (missing: ${missing.join(", ")})`;
  }
  return `Install required tools manually (example Debian/Ubuntu): sudo apt-get update && sudo apt-get install -y nmap tshark (missing: ${missing.join(", ")})`;
}

function exitOrWarn(message) {
  if (BEST_EFFORT) {
    console.warn(message);
    return;
  }
  throw new Error(message);
}

function main() {
  let missing = REQUIRED_COMMANDS.filter((cmd) => !commandExists(cmd));
  if (missing.length === 0) {
    console.log("Required network tools already installed (nmap, tshark).");
    return;
  }

  console.log(`Missing required network tools: ${missing.join(", ")}`);
  let installed = false;
  if (process.platform === "darwin") {
    installed = tryInstallDarwin();
  } else if (process.platform === "win32") {
    installed = tryInstallWindows();
  } else {
    installed = tryInstallUnix(["nmap", "tshark"]);
  }

  missing = REQUIRED_COMMANDS.filter((cmd) => !commandExists(cmd));
  if (!installed || missing.length > 0) {
    exitOrWarn(`${manualHelp(missing.length > 0 ? missing : REQUIRED_COMMANDS)}`);
    return;
  }

  console.log("Required network tools installed successfully.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
