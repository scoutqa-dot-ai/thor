#!/usr/bin/env node
/**
 * Shared HTTP client for git/gh wrapper scripts.
 *
 * Usage: node remote-cli.mjs <endpoint> <arg1> <arg2> ...
 *   endpoint: "git" or "gh"
 *
 * Env:
 *   THOR_REMOTE_CLI_URL — base URL of the remote-cli service (e.g. http://remote-cli:3004)
 */

const [endpoint, ...args] = process.argv.slice(2);

if (!endpoint) {
  process.stderr.write("Usage: remote-cli.mjs <git|gh> [args...]\n");
  process.exit(1);
}

const baseUrl = process.env.THOR_REMOTE_CLI_URL;
if (!baseUrl) {
  process.stderr.write("THOR_REMOTE_CLI_URL is not set\n");
  process.exit(1);
}

const url = `${baseUrl}/exec/${endpoint}`;
const cwd = process.cwd();

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args, cwd }),
  });

  if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
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
  process.exit(body.exitCode ?? 0);
} catch (err) {
  process.stderr.write(`Failed to reach remote-cli: ${err.message}\n`);
  process.exit(1);
}
