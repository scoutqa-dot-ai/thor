#!/usr/bin/env node
/**
 * Auth helper for Thor git/gh wrappers.
 *
 * Usage:
 *   node auth-helper.js <binary> [args...]
 *     Resolves owner from args or git remote, prints {"token":"...","owner":"..."}.
 *     Used by the gh wrapper.
 *
 *   node auth-helper.js git-askpass "<prompt>"
 *     Called by git via GIT_ASKPASS. Parses the URL out of git's prompt
 *     and prints the raw token for git to read as the password.
 *
 * If owner resolution fails or no installation is configured, prints nothing
 * so the caller can deny the authenticated operation.
 */

import { fileURLToPath } from "node:url";
import {
  getInstallationToken,
  parseOwnerFromRemoteUrl,
  resolveOwner,
  resolveOwnerFromRemote,
} from "./github-app-auth.js";
import { formatAuthHelperError } from "./auth-helper-format.js";

const TAG = "[thor-github-app]";

export function parseRemoteUrlFromAskpassPrompt(prompt: string): string | undefined {
  const match = prompt.match(/'([^']+)'/);
  return match?.[1];
}

export function resolveOwnerFromAskpassPrompt(prompt: string, cwd: string): string | undefined {
  const remoteUrl = parseRemoteUrlFromAskpassPrompt(prompt);
  const fromPrompt = remoteUrl ? parseOwnerFromRemoteUrl(remoteUrl) : undefined;
  return fromPrompt ?? resolveOwnerFromRemote(cwd);
}

async function main(): Promise<void> {
  const [, , binary, ...args] = process.argv;
  const cwd = process.cwd();

  const askpassMode = binary === "git-askpass";
  const owner = askpassMode
    ? resolveOwnerFromAskpassPrompt(args[0] ?? "", cwd)
    : resolveOwner(args, cwd);

  if (!owner) {
    // Cannot determine owner; let the caller decide whether the command can run.
    return;
  }

  try {
    const result = await getInstallationToken(owner);
    if (askpassMode) {
      process.stdout.write(result.token);
    } else {
      process.stdout.write(JSON.stringify(result));
    }
  } catch (err) {
    // Log error to stderr for debugging; callers treat empty stdout as no token.
    process.stderr.write(`${formatAuthHelperError(err, TAG)}\n`);
  }
}

const executedAsScript = process.argv[1] === fileURLToPath(import.meta.url);

if (executedAsScript) {
  main().catch((err) => {
    process.stderr.write(`${formatAuthHelperError(`Unexpected error: ${err}`, TAG)}\n`);
  });
}
