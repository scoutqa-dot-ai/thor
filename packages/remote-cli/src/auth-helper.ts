#!/usr/bin/env node
/**
 * Auth helper for Thor git/gh wrappers.
 *
 * Usage:
 *   node auth-helper.js <binary> [args...]
 *     Resolves org from args or git remote, prints {"token":"...","org":"..."}.
 *     Used by the gh wrapper.
 *
 *   node auth-helper.js git-askpass "<prompt>"
 *     Called by git via GIT_ASKPASS. Parses the URL out of git's prompt
 *     and prints the raw token for git to read as the password.
 *
 * If org resolution fails or no installation is configured, exits silently
 * (exit 0, no stdout) so the caller falls back to existing auth.
 */

import { fileURLToPath } from "node:url";
import {
  getInstallationToken,
  parseOrgFromRemoteUrl,
  resolveOrg,
  resolveOrgFromRemote,
} from "./github-app-auth.js";
import { formatAuthHelperError } from "./auth-helper-format.js";

const TAG = "[thor-github-app]";

export function parseRemoteUrlFromAskpassPrompt(prompt: string): string | undefined {
  const match = prompt.match(/'([^']+)'/);
  return match?.[1];
}

export function resolveOrgFromAskpassPrompt(prompt: string, cwd: string): string | undefined {
  const remoteUrl = parseRemoteUrlFromAskpassPrompt(prompt);
  const fromPrompt = remoteUrl ? parseOrgFromRemoteUrl(remoteUrl) : undefined;
  return fromPrompt ?? resolveOrgFromRemote(cwd);
}

async function main(): Promise<void> {
  const [, , binary, ...args] = process.argv;
  const cwd = process.cwd();

  const askpassMode = binary === "git-askpass";
  const org = askpassMode ? resolveOrgFromAskpassPrompt(args[0] ?? "", cwd) : resolveOrg(args, cwd);

  if (!org) {
    // Cannot determine org — silent exit, caller falls back to existing auth
    return;
  }

  try {
    const result = await getInstallationToken(org);
    if (askpassMode) {
      process.stdout.write(result.token);
    } else {
      process.stdout.write(JSON.stringify(result));
    }
  } catch (err) {
    // Log error to stderr for debugging, but don't fail the wrapper
    process.stderr.write(`${formatAuthHelperError(err, TAG)}\n`);
  }
}

const executedAsScript = process.argv[1] === fileURLToPath(import.meta.url);

if (executedAsScript) {
  main().catch((err) => {
    process.stderr.write(`${formatAuthHelperError(`Unexpected error: ${err}`, TAG)}\n`);
  });
}
