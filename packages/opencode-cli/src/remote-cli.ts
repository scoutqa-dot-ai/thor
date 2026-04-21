/**
 * Shared HTTP client for git/gh/scoutqa wrapper scripts.
 *
 * Usage: node remote-cli.mjs <endpoint> <arg1> <arg2> ...
 *   endpoint: "git", "gh", "scoutqa", "langfuse", "ldcli", "metabase", "mcp", or "approval"
 *
 * Env:
 *   THOR_REMOTE_CLI_URL — base URL of the remote-cli service (e.g. http://remote-cli:3004)
 *
 * git/gh endpoints return buffered JSON: { stdout, stderr, exitCode }
 * scoutqa endpoint streams NDJSON: { stream, data } chunks + { exitCode } final line
 */

import { ExecResultSchema, ExecStreamEventSchema, type ExecStreamEvent } from "@thor/common";

const [endpoint, ...args] = process.argv.slice(2);

if (!endpoint) {
  process.stderr.write(
    "Usage: remote-cli.mjs <git|gh|scoutqa|langfuse|ldcli|metabase|mcp|approval> [args...]\n",
  );
  process.exit(1);
}

const baseUrl = process.env.THOR_REMOTE_CLI_URL;
if (!baseUrl) {
  process.stderr.write("THOR_REMOTE_CLI_URL is not set\n");
  process.exit(1);
}

const url = `${baseUrl}/exec/${endpoint}`;
const cwd = process.cwd();
const sessionDirectory = process.env.THOR_OPENCODE_DIRECTORY || cwd;
const sessionId = process.env.THOR_OPENCODE_SESSION_ID || "";
const callId = process.env.THOR_OPENCODE_CALL_ID || "";
const nonRepoScopedEndpoints = new Set(["langfuse", "ldcli", "metabase", "approval"]);

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId && { "x-thor-session-id": sessionId }),
      ...(callId && { "x-thor-call-id": callId }),
    },
    body: JSON.stringify(
      endpoint === "mcp"
        ? { args, cwd, directory: sessionDirectory }
        : nonRepoScopedEndpoints.has(endpoint)
          ? { args }
          : { args, cwd },
    ),
  });

  const contentType = res.headers.get("content-type") || "";

  // NDJSON streaming response (scoutqa)
  if (contentType.includes("application/x-ndjson")) {
    let exitCode = 1;
    const decoder = new TextDecoder();
    let buffer = "";

    const handleEvent = (msg: ExecStreamEvent) => {
      switch (msg.type) {
        case "stdout":
          process.stdout.write(msg.data);
          break;
        case "stderr":
          process.stderr.write(msg.data);
          break;
        case "exit":
          exitCode = msg.exitCode;
          break;
        case "heartbeat":
          break;
      }
    };

    for await (const chunk of res.body!) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line in buffer
      for (const line of lines) {
        if (!line) continue;
        handleEvent(ExecStreamEventSchema.parse(JSON.parse(line)));
      }
    }
    // flush remaining buffer
    if (buffer.trim()) {
      handleEvent(ExecStreamEventSchema.parse(JSON.parse(buffer)));
    }
    process.exit(exitCode);
  }

  // Buffered JSON response (git/gh)
  if (!res.ok && contentType.includes("application/json")) {
    const body = ExecResultSchema.parse(await res.json());
    if (body.stderr) process.stderr.write(body.stderr);
    if (body.stdout) process.stdout.write(body.stdout);
    process.exit(body.exitCode ?? 1);
  }

  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status}: ${await res.text()}\n`);
    process.exit(1);
  }

  const body = ExecResultSchema.parse(await res.json());
  if (body.stdout) process.stdout.write(body.stdout);
  if (body.stderr) process.stderr.write(body.stderr);

  process.exit(body.exitCode ?? 0);
} catch (err) {
  process.stderr.write(`Failed to reach remote-cli: ${(err as Error).message}\n`);
  process.exit(1);
}
