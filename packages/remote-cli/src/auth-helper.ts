#!/usr/bin/env node
/**
 * Auth helper for Thor git/gh wrappers.
 *
 * Usage: node auth-helper.js <binary> [args...]
 *
 * Resolves the target org from command args or git remote, looks up the
 * installation in config.json, and prints {"token":"...","org":"..."} to stdout.
 *
 * If org resolution fails or no installation is configured, exits silently
 * (exit 0, no stdout) so the shell wrapper falls through to PAT auth.
 */

import { resolveOrg, getInstallationToken } from "./github-app-auth.js";

const TAG = "[thor-github-app]";

async function main(): Promise<void> {
  const [, , _binary, ...args] = process.argv;

  // Determine cwd: use the actual working directory
  const cwd = process.cwd();

  const org = resolveOrg(args, cwd);
  if (!org) {
    // Cannot determine org — silent exit, wrapper falls back to PAT
    return;
  }

  try {
    const result = await getInstallationToken(org);
    // Print token JSON to stdout for the shell wrapper to consume
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    // Log error to stderr for debugging, but don't fail the wrapper
    process.stderr.write(`${TAG} ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${TAG} Unexpected error: ${err}\n`);
});
