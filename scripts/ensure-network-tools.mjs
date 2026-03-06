#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const BEST_EFFORT = process.argv.includes("--best-effort");

const TOOL_SPECS = [
  {
    command: "nmap",
    windowsFallbacks: (programFiles) => [
      ...programFiles.map((base) => path.join(base, "Nmap", "nmap.exe")),
    ],
    install: {
      darwin: ["nmap"],
      apt: ["nmap"],
      dnf: ["nmap"],
      yum: ["nmap"],
      pacman: ["nmap"],
      apk: ["nmap"],
      choco: ["nmap"],
      winget: ["Insecure.Nmap"],
    },
  },
  {
    command: "tshark",
    windowsFallbacks: (programFiles) => [
      ...programFiles.map((base) => path.join(base, "Wireshark", "tshark.exe")),
    ],
    install: {
      darwin: ["wireshark"],
      apt: ["tshark"],
      dnf: ["wireshark-cli"],
      yum: ["wireshark"],
      pacman: ["wireshark-cli"],
      apk: ["tshark"],
      choco: ["wireshark"],
      winget: ["WiresharkFoundation.Wireshark"],
    },
  },
  {
    command: "snmpget",
    windowsFallbacks: (programFiles) => [
      ...programFiles.map((base) => path.join(base, "Net-SNMP", "bin", "snmpget.exe")),
      "C:\\usr\\bin\\snmpget.exe",
      "C:\\msys64\\mingw64\\bin\\snmpget.exe",
      "C:\\msys64\\usr\\bin\\snmpget.exe",
      "C:\\ProgramData\\chocolatey\\bin\\snmpget.exe",
    ],
    install: {
      darwin: ["net-snmp"],
      apt: ["snmp"],
      dnf: ["net-snmp-utils"],
      yum: ["net-snmp-utils"],
      pacman: ["net-snmp"],
      apk: ["net-snmp-tools"],
    },
  },
  {
    command: "snmpwalk",
    windowsFallbacks: (programFiles) => [
      ...programFiles.map((base) => path.join(base, "Net-SNMP", "bin", "snmpwalk.exe")),
      "C:\\usr\\bin\\snmpwalk.exe",
      "C:\\msys64\\mingw64\\bin\\snmpwalk.exe",
      "C:\\msys64\\usr\\bin\\snmpwalk.exe",
      "C:\\ProgramData\\chocolatey\\bin\\snmpwalk.exe",
    ],
    install: {
      darwin: ["net-snmp"],
      apt: ["snmp"],
      dnf: ["net-snmp-utils"],
      yum: ["net-snmp-utils"],
      pacman: ["net-snmp"],
      apk: ["net-snmp-tools"],
    },
  },
];

const NET_SNMP_WINDOWS_INSTALLER_URL = "https://downloads.sourceforge.net/project/net-snmp/net-snmp%20binaries/5.7-binaries/net-snmp-5.7.0-1.x86.exe";

const REQUIRED_COMMANDS = TOOL_SPECS.map((spec) => spec.command);

function isWindowsExecutable(filePath) {
  try {
    const bytes = readFileSync(filePath);
    return bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
  } catch {
    return false;
  }
}

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

    if (cmd === "choco") {
      return existsSync("C:\\ProgramData\\chocolatey\\bin\\choco.exe");
    }

    const spec = TOOL_SPECS.find((item) => item.command === cmd);
    const fallbackPaths = spec?.windowsFallbacks?.(programFiles) ?? [];
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

function getSudoMode() {
  if (process.platform === "win32") {
    return "none";
  }
  if (!commandExists("sudo")) {
    return "none";
  }
  if (canUseSudoNonInteractive()) {
    return "noninteractive";
  }

  const canPrompt =
    !BEST_EFFORT
    && Boolean(process.stdin.isTTY)
    && Boolean(process.stdout.isTTY)
    && Boolean(process.stderr.isTTY);

  return canPrompt ? "interactive" : "none";
}

function packageNamesFor(installer, missingCommands) {
  const names = new Set();
  for (const command of missingCommands) {
    const spec = TOOL_SPECS.find((item) => item.command === command);
    if (!spec) continue;
    for (const pkg of spec.install?.[installer] ?? []) {
      names.add(pkg);
    }
  }
  return Array.from(names);
}

function tryInstallUnix(missingCommands) {
  if (missingCommands.length === 0) {
    return false;
  }

  const installers = [
    {
      name: "apt",
      exists: () => commandExists("apt-get"),
      install: (packages) => {
        if (packages.length === 0) return false;
        const sudoMode = getSudoMode();
        const useSudo = sudoMode !== "none";
        if (!useSudo && process.getuid && process.getuid() !== 0) {
          return false;
        }
        const sudoArgs = sudoMode === "noninteractive" ? ["-n"] : [];
        const update = useSudo
          ? run("sudo", [...sudoArgs, "apt-get", "update"])
          : run("apt-get", ["update"]);
        if ((update.status ?? 1) !== 0) return false;
        const install = useSudo
          ? run("sudo", [...sudoArgs, "apt-get", "install", "-y", ...packages])
          : run("apt-get", ["install", "-y", ...packages]);
        return (install.status ?? 1) === 0;
      },
    },
    {
      name: "dnf",
      exists: () => commandExists("dnf"),
      install: (packages) => {
        if (packages.length === 0) return false;
        const sudoMode = getSudoMode();
        const useSudo = sudoMode !== "none";
        if (!useSudo && process.getuid && process.getuid() !== 0) return false;
        const sudoArgs = sudoMode === "noninteractive" ? ["-n"] : [];
        const args = useSudo
          ? [...sudoArgs, "dnf", "install", "-y", ...packages]
          : ["install", "-y", ...packages];
        const res = run(useSudo ? "sudo" : "dnf", args);
        return (res.status ?? 1) === 0;
      },
    },
    {
      name: "yum",
      exists: () => commandExists("yum"),
      install: (packages) => {
        if (packages.length === 0) return false;
        const sudoMode = getSudoMode();
        const useSudo = sudoMode !== "none";
        if (!useSudo && process.getuid && process.getuid() !== 0) return false;
        const sudoArgs = sudoMode === "noninteractive" ? ["-n"] : [];
        const args = useSudo
          ? [...sudoArgs, "yum", "install", "-y", ...packages]
          : ["install", "-y", ...packages];
        const res = run(useSudo ? "sudo" : "yum", args);
        return (res.status ?? 1) === 0;
      },
    },
    {
      name: "pacman",
      exists: () => commandExists("pacman"),
      install: (packages) => {
        if (packages.length === 0) return false;
        const sudoMode = getSudoMode();
        const useSudo = sudoMode !== "none";
        if (!useSudo && process.getuid && process.getuid() !== 0) return false;
        const sudoArgs = sudoMode === "noninteractive" ? ["-n"] : [];
        const args = useSudo
          ? [...sudoArgs, "pacman", "-Sy", "--noconfirm", ...packages]
          : ["-Sy", "--noconfirm", ...packages];
        const res = run(useSudo ? "sudo" : "pacman", args);
        return (res.status ?? 1) === 0;
      },
    },
    {
      name: "apk",
      exists: () => commandExists("apk"),
      install: (packages) => {
        if (packages.length === 0) return false;
        const sudoMode = getSudoMode();
        const useSudo = sudoMode !== "none";
        if (!useSudo && process.getuid && process.getuid() !== 0) return false;
        const sudoArgs = sudoMode === "noninteractive" ? ["-n"] : [];
        const res = useSudo
          ? run("sudo", [...sudoArgs, "apk", "add", "--no-cache", ...packages])
          : run("apk", ["add", "--no-cache", ...packages]);
        return (res.status ?? 1) === 0;
      },
    },
  ];

  for (const installer of installers) {
    if (!installer.exists()) continue;
    const packages = packageNamesFor(installer.name, missingCommands);
    if (packages.length === 0) continue;
    console.log(`Attempting to install network tools via ${installer.name}: ${packages.join(", ")}...`);
    if (installer.install(packages)) {
      return true;
    }
  }

  return false;
}

function tryInstallDarwin(missingCommands) {
  if (!commandExists("brew")) {
    return false;
  }
  const packages = packageNamesFor("darwin", missingCommands);
  if (packages.length === 0) {
    return false;
  }
  console.log(`Attempting to install network tools via Homebrew: ${packages.join(", ")}...`);
  const res = run("brew", ["install", ...packages]);
  return (res.status ?? 1) === 0;
}

function tryInstallWindows(missingCommands) {
  let attempted = false;

  if (!commandExists("choco") && commandExists("winget")) {
    console.log("Chocolatey not found. Attempting to install Chocolatey via winget...");
    const installChoco = run("winget", [
      "install",
      "--id",
      "Chocolatey.Chocolatey",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--silent",
    ]);

    if ((installChoco.status ?? 1) === 0) {
      process.env.PATH = `${process.env.PATH || ""};C:\\ProgramData\\chocolatey\\bin`;
    }
  }

  if (commandExists("choco")) {
    const packages = packageNamesFor("choco", missingCommands);
    if (packages.length > 0) {
      attempted = true;
      console.log(`Attempting to install network tools via Chocolatey: ${packages.join(", ")}...`);
      const res = run("choco", ["install", "-y", "--limit-output", ...packages]);
      if ((res.status ?? 1) === 0) {
        return true;
      }
    }
  }

  if (commandExists("winget")) {
    const packageIds = packageNamesFor("winget", missingCommands);
    if (packageIds.length > 0) {
      attempted = true;
      let allSucceeded = true;
      for (const packageId of packageIds) {
        const res = run("winget", [
          "install",
          "--id",
          packageId,
          "--accept-package-agreements",
          "--accept-source-agreements",
        ]);
        if ((res.status ?? 1) !== 0) {
          allSucceeded = false;
        }
      }
      if (allSucceeded) {
        return true;
      }
    }
  }

  const needsSnmp = missingCommands.some((cmd) => cmd === "snmpget" || cmd === "snmpwalk");
  if (needsSnmp) {
    const msysBash = "C:\\msys64\\usr\\bin\\bash.exe";
    if (!existsSync(msysBash) && commandExists("winget")) {
      console.log("Attempting to install MSYS2 (x64 SNMP toolchain) via winget...");
      run("winget", [
        "install",
        "--id",
        "MSYS2.MSYS2",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
      ]);
    }

    if (existsSync(msysBash)) {
      attempted = true;
      console.log("Attempting to install 64-bit Net-SNMP tools via MSYS2 pacman...");
      const msysInstall = run(msysBash, [
        "-lc",
        "pacman -Sy --noconfirm mingw-w64-x86_64-net-snmp",
      ]);
      if ((msysInstall.status ?? 1) === 0) {
        return true;
      }
    }

    const tempDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
    const installerPath = path.join(tempDir, "steward-net-snmp-5.7.0-1.x86.exe");
    attempted = true;

    console.log("Attempting SourceForge Net-SNMP installer fallback (x86)...");
    let downloadedExecutable = false;

    if (commandExists("curl")) {
      const curlDownload = run("curl", ["-fL", NET_SNMP_WINDOWS_INSTALLER_URL, "-o", installerPath]);
      downloadedExecutable = (curlDownload.status ?? 1) === 0 && isWindowsExecutable(installerPath);
    }

    if (!downloadedExecutable) {
      const download = run("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${NET_SNMP_WINDOWS_INSTALLER_URL}' -OutFile '${installerPath}'; if (!(Test-Path '${installerPath}')) { exit 1 }`,
      ]);
      downloadedExecutable = (download.status ?? 1) === 0 && isWindowsExecutable(installerPath);
    }

    if (!downloadedExecutable) {
      console.log("Net-SNMP download did not produce a valid Windows installer.");
      return attempted;
    }

    if (existsSync(installerPath)) {
      const silentInstall = run(installerPath, ["/S"]);
      if ((silentInstall.status ?? 1) === 0) {
        return true;
      }

      console.log("Retrying Net-SNMP install with elevation prompt...");
      const elevatedInstall = run("powershell", [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath '${installerPath}' -ArgumentList '/S' -Verb RunAs -Wait`,
      ]);
      if ((elevatedInstall.status ?? 1) === 0) {
        return true;
      }
    }
  }

  return attempted;
}

function manualHelp(missing) {
  if (process.platform === "darwin") {
    return `Install required tools manually: brew install nmap wireshark net-snmp (missing: ${missing.join(", ")})`;
  }
  if (process.platform === "win32") {
    return `Install required tools manually: choco install nmap wireshark -y (missing: ${missing.join(", ")}). Preferred x64 path: install MSYS2 and run pacman -Sy --noconfirm mingw-w64-x86_64-net-snmp. Legacy fallback: ${NET_SNMP_WINDOWS_INSTALLER_URL}.`;
  }
  return `Install required tools manually (example Debian/Ubuntu): sudo apt-get update && sudo apt-get install -y nmap tshark snmp (missing: ${missing.join(", ")})`;
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
    console.log(`Required network tools already installed (${REQUIRED_COMMANDS.join(", ")}).`);
    return;
  }

  console.log(`Missing required network tools: ${missing.join(", ")}`);
  let installed = false;
  if (process.platform === "darwin") {
    installed = tryInstallDarwin(missing);
  } else if (process.platform === "win32") {
    installed = tryInstallWindows(missing);
  } else {
    installed = tryInstallUnix(missing);
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
