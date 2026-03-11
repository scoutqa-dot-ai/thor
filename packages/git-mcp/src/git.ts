/**
 * Git command execution with credential injection.
 *
 * The PAT never leaks to callers — it's injected via GIT_ASKPASS
 * only when git needs to authenticate over HTTPS.
 */

import { execFile } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAX_OUTPUT = 1024 * 256; // 256 KB

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let askpassPath: string | undefined;

/**
 * Create a GIT_ASKPASS helper script that echoes the PAT.
 * Git calls this script when it needs a password for HTTPS auth.
 */
function getAskpassPath(token: string): string {
  if (askpassPath) return askpassPath;

  const path = join(tmpdir(), `git-askpass-${process.pid}.sh`);
  writeFileSync(path, `#!/bin/sh\necho "${token}"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  askpassPath = path;
  return path;
}

export function execGit(args: string[], cwd: string, token?: string): Promise<GitExecResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // Prevent interactive prompts
      GIT_TERMINAL_PROMPT: "0",
    };

    if (token) {
      env.GIT_ASKPASS = getAskpassPath(token);
      // Use x-access-token as the username for GitHub HTTPS auth
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "credential.username";
      env.GIT_CONFIG_VALUE_0 = "x-access-token";
    }

    const child = execFile(
      "git",
      args,
      { cwd, env, maxBuffer: MAX_OUTPUT },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: err
            ? (err as NodeJS.ErrnoException & { code?: number }).code === undefined
              ? 1
              : ((err as { status?: number }).status ?? 1)
            : 0,
        });
      },
    );

    // Safety: kill after 60 seconds
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("exit", () => clearTimeout(timeout));
  });
}
