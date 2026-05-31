/**
 * Generic command execution for git and gh.
 *
 * Authentication is resolved per-invocation by the Thor git/gh wrapper
 * binaries (see bin/git, bin/gh). When workspace config includes
 * `owners.<owner>.github_app_installation_id`, wrappers mint installation
 * tokens for the resolved owner.
 */

import { execFile, spawn } from "node:child_process";
import type { ExecResult } from "@thor/common";

export interface ExecCommandOptions {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export function execCommand(
  binary: string,
  args: string[],
  cwd: string,
  options: ExecCommandOptions = {},
): Promise<ExecResult> {
  // No maxBuffer cap by default — OpenCode (the caller) already truncates large
  // outputs before feeding them to the LLM context window. Specific endpoints
  // may opt into a cap when they need tighter control.
  const maxBuffer = options.maxBuffer ?? Infinity;

  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        cwd,
        maxBuffer,
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: err
            ? typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : 1
            : 0,
        });
      },
    );
  });
}

export interface StreamCallbacks {
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}

export interface ExecCommandStreamOptions {
  signal?: AbortSignal;
}

/**
 * Spawn a command and stream stdout/stderr chunks via callbacks.
 * Returns a promise that resolves with the exit code when the process ends.
 */
export function execCommandStream(
  binary: string,
  args: string[],
  cwd: string,
  callbacks: StreamCallbacks,
  options: ExecCommandStreamOptions = {},
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      resolve(exitCode);
    };

    const abort = () => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        abort();
      } else {
        options.signal.addEventListener("abort", abort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => callbacks.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => callbacks.onStderr(chunk));

    child.on("close", (code) => finish(code ?? 1));
    child.on("error", () => finish(1));
  });
}
