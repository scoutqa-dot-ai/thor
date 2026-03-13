/**
 * Git command execution.
 *
 * Credentials are configured at the container level via entrypoint.sh
 * (GIT_ASKPASS + GIT_CONFIG_*), so every process — including interactive
 * `docker exec` shells — can authenticate over HTTPS.
 */

import { execFile } from "node:child_process";

const MAX_OUTPUT = 1024 * 256; // 256 KB

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function execGit(args: string[], cwd: string): Promise<GitExecResult> {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: err
          ? (err as NodeJS.ErrnoException & { code?: number }).code === undefined
            ? 1
            : ((err as { status?: number }).status ?? 1)
          : 0,
      });
    });

    // Safety: kill after 60 seconds
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("exit", () => clearTimeout(timeout));
  });
}
