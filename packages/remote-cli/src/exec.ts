/**
 * Generic command execution for git and gh.
 *
 * Credentials are configured at the container level via entrypoint.sh
 * (GIT_ASKPASS + GH_TOKEN), so every process can authenticate.
 */

import { execFile } from "node:child_process";

const MAX_OUTPUT = 1024 * 256; // 256 KB

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function execCommand(binary: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(binary, args, { cwd, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: err ? ((err as { status?: number }).status ?? 1) : 0,
      });
    });

    // Safety: kill after 60 seconds
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("exit", () => clearTimeout(timeout));
  });
}
