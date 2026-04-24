/**
 * gh policy, driven by declarative command specs.
 *
 * Read-only commands are passthrough. pr create, pr comment, issue comment,
 * and pr review have structured flag shapes enforced by the generic parser.
 * Targeted hints (approval-must-be-human, worktree redirect for pr checkout,
 * interactive/file-mode denial) live on per-spec unknownFlagHint functions.
 */

import { execFileSync } from "node:child_process";

import { findSpec, parseAgainstSpec, type CommandSpec, type ParseContext } from "./policy-spec.js";

const USING_GH_HINT = "Load skill using-gh for the full allowed surface.";

// ── selector + repo helpers ────────────────────────────────────────────────

interface GitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}

function looksLikeHttpsUrl(value: string): boolean {
  return value.startsWith("https://");
}

function isValidLocalBranchSelector(selector: string): boolean {
  if (!selector || selector.includes(":") || selector.includes("#")) return false;
  try {
    execFileSync("/usr/bin/git", ["check-ref-format", "--branch", selector], {
      encoding: "utf8",
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function resolveCurrentGitHubRepo(cwd?: string): GitHubRepoRef | undefined {
  if (!cwd) return undefined;
  try {
    const remoteUrl = execFileSync("/usr/bin/git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return parseGitHubRepoFromRemoteUrl(remoteUrl);
  } catch {
    return undefined;
  }
}

function parseGitHubRepoFromRemoteUrl(url: string): GitHubRepoRef | undefined {
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      host: normalizeRepoHost(sshMatch[1]),
      owner: normalizeRepoSegment(sshMatch[2]),
      repo: normalizeRepoSegment(sshMatch[3]),
    };
  }
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    return {
      host: normalizeRepoHost(parsed.hostname),
      owner: normalizeRepoSegment(parts[0]),
      repo: normalizeRepoSegment(parts[1]),
    };
  } catch {
    return undefined;
  }
}

function parseGitHubResourceUrl(
  url: string,
  resourceType: "pull" | "issues",
): GitHubRepoRef | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 4) return undefined;
    const [owner, repo, resource, number] = parts;
    if (resource !== resourceType || !/^\d+$/.test(number)) return undefined;
    return {
      host: normalizeRepoHost(parsed.hostname),
      owner: normalizeRepoSegment(owner),
      repo: normalizeRepoSegment(repo),
    };
  } catch {
    return undefined;
  }
}

function normalizeRepoHost(host: string): string {
  return host.trim().toLowerCase();
}

function normalizeRepoSegment(value: string): string {
  return value
    .replace(/\.git$/i, "")
    .trim()
    .toLowerCase();
}

function validateCurrentRepoUrlSelector(
  key: string,
  selector: string,
  resourceType: "pull" | "issues",
  cwd?: string,
): string | null {
  const target = parseGitHubResourceUrl(selector, resourceType);
  if (!target) {
    const resourceName = resourceType === "pull" ? "PR" : "issue";
    return `"gh ${key}" positional selector must be a valid ${resourceName} URL`;
  }
  const currentRepo = resolveCurrentGitHubRepo(cwd);
  if (!currentRepo) {
    return `"gh ${key}" URL selectors require a resolvable origin remote for the current repo`;
  }
  if (
    target.host !== currentRepo.host ||
    target.owner !== currentRepo.owner ||
    target.repo !== currentRepo.repo
  ) {
    return `"gh ${key}" URL selector must target the current repo`;
  }
  return null;
}

function validatePrSelector(key: string, selector: string, cwd?: string): string | null {
  if (/^\d+$/.test(selector)) return null;
  if (looksLikeHttpsUrl(selector)) {
    return validateCurrentRepoUrlSelector(key, selector, "pull", cwd);
  }
  if (!isValidLocalBranchSelector(selector)) {
    return `"gh ${key}" positional selector must be a numeric PR number, current-repo PR URL, or branch name`;
  }
  return null;
}

function validateIssueSelector(key: string, selector: string, cwd?: string): string | null {
  if (/^\d+$/.test(selector)) return null;
  if (looksLikeHttpsUrl(selector)) {
    return validateCurrentRepoUrlSelector(key, selector, "issues", cwd);
  }
  return `"gh ${key}" positional selector must be a numeric issue number or current-repo issue URL`;
}

// ── specs ──────────────────────────────────────────────────────────────────

const PASSTHROUGH_COMMANDS: readonly (readonly [string, string])[] = [
  ["auth", "status"],
  ["pr", "view"],
  ["pr", "diff"],
  ["pr", "list"],
  ["pr", "status"],
  ["pr", "checks"],
  ["issue", "view"],
  ["issue", "list"],
  ["repo", "view"],
  ["run", "list"],
  ["run", "view"],
  ["run", "watch"],
  ["search", "issues"],
  ["search", "prs"],
  ["search", "code"],
  ["search", "repos"],
  ["workflow", "list"],
  ["workflow", "view"],
  ["label", "list"],
  ["release", "list"],
  ["release", "view"],
  ["release", "download"],
];

const PR_CREATE_BLOCKED_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "--editor",
  "-w",
  "--web",
  "-F",
  "--body-file",
]);

const PR_CREATE_SPEC: CommandSpec = {
  path: ["pr", "create"],
  flags: {
    "--title": { kind: "value" },
    "--body": { kind: "value" },
    "--base": { kind: "value" },
    "--head": {
      kind: "value",
      validate: (v) =>
        isValidLocalBranchSelector(v)
          ? null
          : '"gh pr create --head" is not allowed — --head must be a branch in the current repo',
    },
    "--draft": { kind: "bool" },
  },
  aliases: { "-t": "--title", "-b": "--body", "-B": "--base", "-H": "--head" },
  requiredFlags: ["--title", "--body"],
  missingRequiredHint: () => '"gh pr create" requires both --title and --body',
  positional: { min: 0, max: 0 },
  extraPositionalHint: '"gh pr create" does not accept positional arguments',
  unknownFlagHint: (arg) => {
    const name = arg.split("=")[0];
    if (PR_CREATE_BLOCKED_FLAGS.has(name)) {
      return `"gh pr create ${name}" is not allowed — interactive and file-based modes are blocked`;
    }
    return `"gh pr create ${arg}" is not allowed — only --title/--body with optional --base/--head/--draft are permitted`;
  },
};

const COMMENT_BLOCKED_FLAGS: ReadonlySet<string> = new Set([
  "--edit-last",
  "--delete-last",
  "--create-if-none",
  "--yes",
  "-e",
  "--editor",
  "-w",
  "--web",
  "-F",
  "--body-file",
]);

function denyCommentFlag(key: string, arg: string): string {
  const name = arg.split("=")[0];
  if (COMMENT_BLOCKED_FLAGS.has(name)) {
    return `"gh ${key} ${name}" is not allowed — append-only comment creation only`;
  }
  return `"gh ${key} ${arg}" is not allowed — only --body is permitted`;
}

const PR_COMMENT_SPEC: CommandSpec = {
  path: ["pr", "comment"],
  flags: { "--body": { kind: "value" } },
  aliases: { "-b": "--body" },
  requiredFlags: ["--body"],
  missingRequiredHint: () => '"gh pr comment" requires --body',
  unknownFlagHint: (arg) => denyCommentFlag("pr comment", arg),
  positional: { min: 0, max: 1 },
  extraPositionalHint: '"gh pr comment" allows at most one positional PR selector',
  postValidate: (parsed, ctx) => {
    if (parsed.positional.length === 1) {
      return validatePrSelector("pr comment", parsed.positional[0], ctx.cwd);
    }
    return null;
  },
};

const ISSUE_COMMENT_SPEC: CommandSpec = {
  path: ["issue", "comment"],
  flags: { "--body": { kind: "value" } },
  aliases: { "-b": "--body" },
  requiredFlags: ["--body"],
  missingRequiredHint: () => '"gh issue comment" requires --body',
  unknownFlagHint: (arg) => denyCommentFlag("issue comment", arg),
  positional: { min: 1, max: 1 },
  missingPositionalHint: '"gh issue comment" requires exactly one positional issue selector',
  extraPositionalHint: '"gh issue comment" requires exactly one positional issue selector',
  postValidate: (parsed, ctx) =>
    validateIssueSelector("issue comment", parsed.positional[0], ctx.cwd),
};

const PR_REVIEW_INTERACTIVE_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "--editor",
  "-w",
  "--web",
  "-F",
  "--body-file",
]);

const PR_REVIEW_SPEC: CommandSpec = {
  path: ["pr", "review"],
  flags: {
    "--comment": { kind: "bool" },
    "--request-changes": { kind: "bool" },
    "--body": { kind: "value" },
  },
  aliases: { "-c": "--comment", "-r": "--request-changes", "-b": "--body" },
  requiredFlags: ["--body"],
  missingRequiredHint: () => '"gh pr review" requires --body',
  requireOneOf: {
    flags: ["--comment", "--request-changes"],
    hint: '"gh pr review" requires exactly one of --comment or --request-changes',
  },
  unknownFlagHint: (arg) => {
    const name = arg.split("=")[0];
    if (name === "--approve" || name === "-a") {
      return '"gh pr review --approve" is not allowed — PR approval must be human';
    }
    if (PR_REVIEW_INTERACTIVE_FLAGS.has(name)) {
      return `"gh pr review ${name}" is not allowed — interactive and file-based review modes are blocked`;
    }
    return `"gh pr review ${arg}" is not allowed — only --comment/--request-changes with --body are permitted`;
  },
  positional: { min: 0, max: 1 },
  extraPositionalHint: '"gh pr review" allows at most one positional PR selector',
  postValidate: (parsed, ctx) => {
    if (parsed.positional.length === 1) {
      return validatePrSelector("pr review", parsed.positional[0], ctx.cwd);
    }
    return null;
  },
};

export const GH_SPECS: readonly CommandSpec[] = [
  ...PASSTHROUGH_COMMANDS.map(([group, sub]) => ({
    path: [group, sub],
    passthrough: true as const,
  })),
  PR_CREATE_SPEC,
  PR_COMMENT_SPEC,
  ISSUE_COMMENT_SPEC,
  PR_REVIEW_SPEC,
];

// ── entry point ────────────────────────────────────────────────────────────

export function validateGhArgs(args: string[], cwd?: string): string | null {
  if (!Array.isArray(args)) return "args must be an array";
  if (args.length === 0) return null;

  if (args[0] === "--version") {
    return args.length === 1 ? null : '"gh --version" does not accept additional arguments';
  }

  if (isGhHelpRequest(args)) {
    return validateGhHelpArgs(args);
  }

  const group = args[0];

  if (group === "api") {
    return '"gh api" is not allowed — use specific gh commands (e.g. gh pr create, gh issue comment)';
  }

  const subcommand = args[1];
  if (!subcommand) {
    return `"gh ${group}" is not allowed — subcommand required`;
  }

  // Inline worktree-redirect hint for the dominant gh miss pattern.
  if (group === "pr" && subcommand === "checkout") {
    return `"gh pr checkout" is not allowed — use 'git fetch origin pull/<N>/head:pr-<N>' then 'git worktree add <path> pr-<N>' to inspect a PR without leaving this worktree`;
  }

  const spec = findSpec(GH_SPECS, args);
  if (!spec) {
    return `"gh ${group} ${subcommand}" is not allowed. ${USING_GH_HINT}`;
  }

  const afterPath = args.slice(spec.path.length);
  const ctx: ParseContext = { cwd };
  const parsed = parseAgainstSpec(afterPath, spec, ctx);
  return parsed.ok ? null : parsed.error;
}

// ── help-request detection ─────────────────────────────────────────────────

// Flags that take a value — skip over their value when scanning for --help/-h
// so a comment body of "-h" or "--help" can't short-circuit mutation checks.
const GH_VALUE_TAKING_FLAGS: ReadonlySet<string> = new Set([
  "-b",
  "--body",
  "-t",
  "--title",
  "-B",
  "--base",
  "-H",
  "--head",
  "-F",
  "--body-file",
  "-R",
  "--repo",
  "--json",
  "-q",
  "--jq",
  "-L",
  "--limit",
  "--search",
]);

function isGhHelpRequest(args: string[]): boolean {
  if (args[0] === "help") return true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (GH_VALUE_TAKING_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

function validateGhHelpArgs(args: string[]): string | null {
  const topic = args[0] === "help" ? args[1] : args[0];
  if (topic === "api") {
    return '"gh api --help" is not allowed — gh api remains blocked';
  }
  return null;
}
