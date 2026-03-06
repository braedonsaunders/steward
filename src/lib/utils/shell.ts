import { exec, execFile } from "node:child_process";

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export const runShell = (
  command: string,
  timeoutMs = 15_000,
): Promise<ShellResult> => {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs }, (error, stdout, stderr) => {
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
): Promise<ShellResult> => {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
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
