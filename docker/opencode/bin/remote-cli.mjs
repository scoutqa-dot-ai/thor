#!/usr/bin/env node
/**
 * Shared HTTP client for git/gh/scoutqa wrapper scripts.
 *
 * Usage: node remote-cli.mjs <endpoint> <arg1> <arg2> ...
 *   endpoint: "git", "gh", or "scoutqa"
 *
 * Env:
 *   THOR_REMOTE_CLI_URL — base URL of the remote-cli service (e.g. http://remote-cli:3004)
 *
 * git/gh endpoints return buffered JSON: { stdout, stderr, exitCode }
 * scoutqa endpoint streams NDJSON: { stream, data } chunks + { exitCode } final line
 */

const [endpoint, ...args] = process.argv.slice(2);

if (!endpoint) {
  process.stderr.write("Usage: remote-cli.mjs <git|gh|scoutqa> [args...]\n");
  process.exit(1);
}

const baseUrl = process.env.THOR_REMOTE_CLI_URL;
if (!baseUrl) {
  process.stderr.write("THOR_REMOTE_CLI_URL is not set\n");
  process.exit(1);
}

const url = `${baseUrl}/exec/${endpoint}`;
const cwd = process.cwd();
const sessionId = process.env.THOR_OPENCODE_SESSION_ID || "";
const callId = process.env.THOR_OPENCODE_CALL_ID || "";

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId && { "x-thor-session-id": sessionId }),
      ...(callId && { "x-thor-call-id": callId }),
    },
    body: JSON.stringify({ args, cwd }),
  });

  const contentType = res.headers.get("content-type") || "";

  // NDJSON streaming response (scoutqa)
  if (contentType.includes("application/x-ndjson")) {
    let exitCode = 1;
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.stream === "stdout") process.stdout.write(msg.data);
        else if (msg.stream === "stderr") process.stderr.write(msg.data);
        if (msg.exitCode !== undefined) exitCode = msg.exitCode;
      }
    }
    // flush remaining buffer
    if (buffer.trim()) {
      const msg = JSON.parse(buffer);
      if (msg.stream === "stdout") process.stdout.write(msg.data);
      else if (msg.stream === "stderr") process.stderr.write(msg.data);
      if (msg.exitCode !== undefined) exitCode = msg.exitCode;
    }
    process.exit(exitCode);
  }

  // Buffered JSON response (git/gh)
  if (!res.ok && contentType.includes("application/json")) {
    const body = await res.json();
    if (body.stderr) process.stderr.write(body.stderr);
    if (body.stdout) process.stdout.write(body.stdout);
    process.exit(body.exitCode ?? 1);
  }

  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status}: ${await res.text()}\n`);
    process.exit(1);
  }

  const body = await res.json();
  if (body.stdout) process.stdout.write(body.stdout);
  if (body.stderr) process.stderr.write(body.stderr);

  // Emit [thor:meta] for the runner to extract aliases. Shape: ThorMeta from @thor/common.
  if ((endpoint === "git" || endpoint === "gh") && (body.exitCode ?? 0) === 0) {
    const meta = JSON.stringify({ cmd: endpoint, args, cwd });
    process.stderr.write(`\n[thor:meta] ${meta}\n`);
  }

  process.exit(body.exitCode ?? 0);
} catch (err) {
  process.stderr.write(`Failed to reach remote-cli: ${err.message}\n`);
  process.exit(1);
}
