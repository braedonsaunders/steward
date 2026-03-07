import { exec, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

function buildShellEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return baseEnv;
  }

  const toolDirs = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Nmap") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Nmap") : "",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Wireshark") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Wireshark") : "",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Net-SNMP", "bin") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Net-SNMP", "bin") : "",
    "C:\\usr\\bin",
    "C:\\usr\\sbin",
    "C:\\ProgramData\\chocolatey\\bin",
  ].filter((candidate) => candidate.length > 0 && existsSync(candidate));

  const currentPath = baseEnv.PATH ?? "";
  const existing = new Set(currentPath.split(path.delimiter).map((entry) => entry.toLowerCase()));
  const missing = toolDirs.filter((entry) => !existing.has(entry.toLowerCase()));
  if (missing.length === 0) {
    return baseEnv;
  }

  return {
    ...baseEnv,
    PATH: `${currentPath}${currentPath.length > 0 ? path.delimiter : ""}${missing.join(path.delimiter)}`,
  };
}

export const runShell = (
  command: string,
  timeoutMs = 15_000,
): Promise<ShellResult> => {
  const env = buildShellEnv(process.env);
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, env }, (error, stdout, stderr) => {
      if (!error) {
        resolve({
          ok: true,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code: 0,
        });
        return;
      }

      const code = typeof error.code === "number" ? error.code : 1;
      resolve({
        ok: false,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
      });
    });
  });
};

export const runCommand = (
  file: string,
  args: string[],
  timeoutMs = 15_000,
  cwd?: string,
): Promise<ShellResult> => {
  const env = buildShellEnv(process.env);
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env, cwd }, (error, stdout, stderr) => {
      if (!error) {
        resolve({
          ok: true,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code: 0,
        });
        return;
      }

      const errnoCode = typeof error.code === "number"
        ? error.code
        : error.code === "ENOENT"
          ? 127
          : 1;
      const missingCommandStderr = error.code === "ENOENT"
        ? `${file}: command not found`
        : stderr.trim();

      resolve({
        ok: false,
        stdout: stdout.trim(),
        stderr: missingCommandStderr,
        code: errnoCode,
      });
    });
  });
};
