/**
 * gh policy — imperative allowlist + narrow validators.
 *
 * ALLOWED_GH_COMMANDS is exported so the skill generator can project it into
 * `using-gh` without reimplementing the policy.
 */

import { execFileSync } from "node:child_process";

const USING_GH_HINT = "Load skill using-gh for the full allowed surface.";

export const ALLOWED_GH_COMMANDS: ReadonlySet<string> = new Set([
  "auth status",
  "pr view",
  "pr diff",
  "pr list",
  "pr status",
  "pr checks",
  "pr create",
  "pr comment",
  "pr review",
  "issue view",
  "issue list",
  "issue comment",
  "repo view",
  "run list",
  "run view",
  "run watch",
  "search issues",
  "search prs",
  "search code",
  "search repos",
  "workflow list",
  "workflow view",
  "label list",
  "release list",
  "release view",
  "release download",
]);

// ── entry point ────────────────────────────────────────────────────────────

export function validateGhArgs(args: string[], cwd?: string): string | null {
  if (!Array.isArray(args)) return "args must be an array";
  if (args.length === 0) return null;

  if (args[0] === "--version") {
    return args.length === 1 ? null : '"gh --version" does not accept additional arguments';
  }

  if (isGhHelpRequest(args)) return validateGhHelpArgs(args);

  const group = args[0];

  if (group === "api") {
    return '"gh api" is not allowed — use specific gh commands (e.g. gh pr create, gh issue comment)';
  }

  const subcommand = args[1];
  if (!subcommand) {
    return `"gh ${group}" is not allowed — subcommand required`;
  }

  const key = `${group} ${subcommand}`;
  if (!ALLOWED_GH_COMMANDS.has(key)) {
    if (key === "pr checkout") {
      return `"gh pr checkout" is not allowed — use 'git fetch origin pull/<N>/head:pr-<N>' then 'git worktree add <path> pr-<N>' to inspect a PR without leaving this worktree`;
    }
    return `"gh ${key}" is not allowed. ${USING_GH_HINT}`;
  }

  if (key === "pr create") return validateGhPrCreateArgs(args);
  if (key === "pr comment" || key === "issue comment") {
    return validateGhAppendOnlyCommentArgs(args, key, cwd);
  }
  if (key === "pr review") return validateGhPrReviewArgs(args, cwd);

  return null;
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

// ── pr create ──────────────────────────────────────────────────────────────

function validateGhPrCreateArgs(args: string[]): string | null {
  const key = "pr create";
  const allowedValue: ReadonlySet<string> = new Set([
    "-t",
    "--title",
    "-b",
    "--body",
    "-B",
    "--base",
    "-H",
    "--head",
  ]);
  const allowedBool: ReadonlySet<string> = new Set(["--draft"]);
  const blocked: ReadonlySet<string> = new Set([
    "-e",
    "--editor",
    "-w",
    "--web",
    "-F",
    "--body-file",
  ]);

  let hasTitle = false;
  let hasBody = false;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue;

    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);

    if (blocked.has(name)) {
      return `"gh ${key} ${name}" is not allowed — interactive and file-based modes are blocked`;
    }
    if (allowedBool.has(name)) continue;
    if (!allowedValue.has(name)) {
      return `"gh ${key} ${arg}" is not allowed — only --title/--body with optional --base/--head/--draft are permitted`;
    }

    if (name === "-t" || name === "--title") hasTitle = true;
    if (name === "-b" || name === "--body") hasBody = true;

    let value: string;
    if (eq < 0) {
      if (i + 1 >= args.length) return `"gh ${key} ${name}" requires a value`;
      value = args[i + 1];
      i += 1;
    } else {
      value = arg.slice(eq + 1);
    }

    if ((name === "-H" || name === "--head") && !isValidLocalBranchSelector(value)) {
      return `"gh ${key} ${name}" is not allowed — --head must be a branch in the current repo`;
    }
  }

  if (!hasTitle || !hasBody) return '"gh pr create" requires both --title and --body';
  return null;
}

// ── pr/issue comment ───────────────────────────────────────────────────────

function validateGhAppendOnlyCommentArgs(args: string[], key: string, cwd?: string): string | null {
  const allowedValue: ReadonlySet<string> = new Set(["-b", "--body"]);
  const blockedMutation: ReadonlySet<string> = new Set([
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

  let hasBody = false;
  const selectors: string[] = [];

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      selectors.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (blockedMutation.has(name)) {
      return `"gh ${key} ${name}" is not allowed — append-only comment creation only`;
    }
    if (!allowedValue.has(name)) {
      return `"gh ${key} ${arg}" is not allowed — only --body is permitted`;
    }
    if (name === "-b" || name === "--body") hasBody = true;
    if (eq < 0) {
      if (i + 1 >= args.length) return `"gh ${key} ${name}" requires a value`;
      i += 1;
    }
  }

  if (!hasBody) return `"gh ${key}" requires --body`;

  if (key === "pr comment") {
    if (selectors.length > 1) return `"gh ${key}" allows at most one positional PR selector`;
    if (selectors.length === 0) return null;
    return validatePrSelector(key, selectors[0], cwd);
  }

  // issue comment: exactly one positional required
  if (selectors.length !== 1) {
    return `"gh ${key}" requires exactly one positional issue selector`;
  }
  return validateIssueSelector(key, selectors[0], cwd);
}

// ── pr review ──────────────────────────────────────────────────────────────

function validateGhPrReviewArgs(args: string[], cwd?: string): string | null {
  const key = "pr review";
  const allowedValue: ReadonlySet<string> = new Set(["-b", "--body"]);
  const allowedMode: ReadonlySet<string> = new Set(["-c", "--comment", "-r", "--request-changes"]);
  const blockedInteractive: ReadonlySet<string> = new Set([
    "-e",
    "--editor",
    "-w",
    "--web",
    "-F",
    "--body-file",
  ]);

  let sawComment = false;
  let sawRequestChanges = false;
  let hasBody = false;
  const selectors: string[] = [];

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      selectors.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);

    if (name === "-a" || name === "--approve") {
      return '"gh pr review --approve" is not allowed — PR approval must be human';
    }
    if (blockedInteractive.has(name)) {
      return `"gh ${key} ${name}" is not allowed — interactive and file-based review modes are blocked`;
    }
    if (allowedMode.has(name)) {
      if (name === "-c" || name === "--comment") sawComment = true;
      if (name === "-r" || name === "--request-changes") sawRequestChanges = true;
      continue;
    }
    if (!allowedValue.has(name)) {
      return `"gh ${key} ${arg}" is not allowed — only --comment/--request-changes with --body are permitted`;
    }
    if (name === "-b" || name === "--body") hasBody = true;
    if (eq < 0) {
      if (i + 1 >= args.length) return `"gh ${key} ${name}" requires a value`;
      i += 1;
    }
  }

  if (sawComment === sawRequestChanges) {
    return '"gh pr review" requires exactly one of --comment or --request-changes';
  }
  if (!hasBody) return '"gh pr review" requires --body';

  if (selectors.length > 1) return `"gh ${key}" allows at most one positional PR selector`;
  if (selectors.length === 0) return null;
  return validatePrSelector(key, selectors[0], cwd);
}

// ── selector + repo helpers ────────────────────────────────────────────────

interface GitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}

function validatePrSelector(key: string, selector: string, cwd?: string): string | null {
  if (/^\d+$/.test(selector)) return null;
  if (selector.startsWith("https://")) {
    return validateCurrentRepoUrlSelector(key, selector, "pull", cwd);
  }
  if (!isValidLocalBranchSelector(selector)) {
    return `"gh ${key}" positional selector must be a numeric PR number, current-repo PR URL, or branch name`;
  }
  return null;
}

function validateIssueSelector(key: string, selector: string, cwd?: string): string | null {
  if (/^\d+$/.test(selector)) return null;
  if (selector.startsWith("https://")) {
    return validateCurrentRepoUrlSelector(key, selector, "issues", cwd);
  }
  return `"gh ${key}" positional selector must be a numeric issue number or current-repo issue URL`;
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
  const current = resolveCurrentGitHubRepo(cwd);
  if (!current) {
    return `"gh ${key}" URL selectors require a resolvable origin remote for the current repo`;
  }
  if (
    target.host !== current.host ||
    target.owner !== current.owner ||
    target.repo !== current.repo
  ) {
    return `"gh ${key}" URL selector must target the current repo`;
  }
  return null;
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
    const url = execFileSync("/usr/bin/git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return parseGitHubRepoFromRemoteUrl(url);
  } catch {
    return undefined;
  }
}

function parseGitHubRepoFromRemoteUrl(url: string): GitHubRepoRef | undefined {
  const ssh = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) {
    return { host: norm(ssh[1]), owner: strip(ssh[2]), repo: strip(ssh[3]) };
  }
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    return { host: norm(parsed.hostname), owner: strip(parts[0]), repo: strip(parts[1]) };
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
    return { host: norm(parsed.hostname), owner: strip(owner), repo: strip(repo) };
  } catch {
    return undefined;
  }
}

const norm = (h: string): string => h.trim().toLowerCase();
const strip = (v: string): string =>
  v
    .replace(/\.git$/i, "")
    .trim()
    .toLowerCase();
