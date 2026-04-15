/**
 * Generic command execution for git and gh.
 *
 * Credentials are configured at the container level via entrypoint.sh
 * (GIT_ASKPASS + GH_TOKEN), so every process can authenticate.
 */

import { execFile, spawn } from "node:child_process";
import type { ExecResult } from "@thor/common";

const MAX_OUTPUT = 1024 * 256; // 256 KB
const TIMEOUT_MS = 60_000;
const STREAM_TIMEOUT_MS = 300_000; // 5 minutes for streaming commands

export const MAX_OUTPUT_LARGE = 1024 * 1024; // 1 MB — for commands with large JSON responses

export function execCommand(
  binary: string,
  args: string[],
  cwd: string,
  maxBuffer: number = MAX_OUTPUT,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(binary, args, { cwd, maxBuffer }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 1
          : 0,
      });
    });

    // Safety: kill after 60 seconds
    const timeout = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("exit", () => clearTimeout(timeout));
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
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => callbacks.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => callbacks.onStderr(chunk));

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));

    const timeout = setTimeout(() => child.kill("SIGKILL"), STREAM_TIMEOUT_MS);
    child.on("close", () => clearTimeout(timeout));
  });
}
