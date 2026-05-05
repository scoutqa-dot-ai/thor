/**
 * Shared HTTP client for remote-cli wrapper scripts.
 *
 * Usage: node remote-cli.mjs <endpoint> [args...]
 *
 * Env:
 *   THOR_REMOTE_CLI_URL — base URL of the remote-cli service
 */

import { ExecResultSchema, ExecStreamEventSchema, type ExecStreamEvent } from "@thor/common";

const [endpoint, ...args] = process.argv.slice(2);

if (!endpoint) {
  process.stderr.write("Usage: remote-cli.mjs <endpoint> [args...]\n");
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
const body: Record<string, unknown> = { args, cwd, directory: sessionDirectory };

if (endpoint === "slack-post-message") {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  body.stdin = Buffer.concat(chunks).toString("utf8");
}

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId && { "x-thor-session-id": sessionId }),
      ...(callId && { "x-thor-call-id": callId }),
    },
    body: JSON.stringify(body),
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
    const result = ExecResultSchema.parse(await res.json());
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.exitCode ?? 1);
  }

  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status}: ${await res.text()}\n`);
    process.exit(1);
  }

  const result = ExecResultSchema.parse(await res.json());
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  process.exit(result.exitCode ?? 0);
} catch (err) {
  process.stderr.write(`Failed to reach remote-cli: ${(err as Error).message}\n`);
  process.exit(1);
}
