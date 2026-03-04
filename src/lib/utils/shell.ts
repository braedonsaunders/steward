import { exec } from "node:child_process";

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
