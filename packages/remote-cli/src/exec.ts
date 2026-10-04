/**
 * Generic command execution for git and gh.
 *
 * Authentication is resolved per-invocation by the Neo git/gh wrapper
 * binaries (see bin/git, bin/gh). When workspace config includes
 * `owners.<owner>.github_app_installation_id`, wrappers mint installation
 * tokens for the resolved owner.
 */

import { execFile, spawn } from "node:child_process";
import type { ExecResult } from "@thor/common";
import { resolveBrokerCommand } from "./broker-command-isolation.js";

export interface ExecCommandOptions {
  env?: NodeJS.ProcessEnv;
  /** Replace the parent environment for integrations that must not inherit unrelated secrets. */
  envMode?: "merge" | "replace";
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
  const launch = resolveBrokerCommand(
    binary,
    args,
    cwd,
    options.envMode === "replace" ? (options.env ?? {}) : { ...process.env, ...options.env },
  );
  if (!launch.ok) return Promise.resolve(launch.result);

  return new Promise((resolve) => {
    const child = execFile(
      launch.binary,
      launch.args,
      {
        cwd,
        maxBuffer,
        env: launch.env,
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

/**
 * Spawn a command and stream stdout/stderr chunks via callbacks.
 * Returns a promise that resolves with the exit code when the process ends.
 */
export function execCommandStream(
  binary: string,
  args: string[],
  cwd: string,
  callbacks: StreamCallbacks,
): Promise<number> {
  return new Promise((resolve) => {
    const launch = resolveBrokerCommand(binary, args, cwd, process.env);
    if (!launch.ok) {
      callbacks.onStderr(launch.result.stderr);
      resolve(launch.result.exitCode);
      return;
    }
    const child = spawn(launch.binary, launch.args, {
      cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => callbacks.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => callbacks.onStderr(chunk));

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}
