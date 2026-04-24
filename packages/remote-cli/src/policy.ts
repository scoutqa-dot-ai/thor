import { execFileSync } from "node:child_process";

/**
 * Server-side command policy for git and gh.
 *
 * All validation happens here — the OpenCode wrapper scripts are untrusted.
 *
 * Git policy lives in policy-git.ts and is re-exported below. Gh policy
 * remains inline here until Phase 3 of the declarative-command-policy
 * refactor ports it to the spec engine too.
 */

export { resolveGitArgs, validateGitArgs, type ResolvedGitArgs } from "./policy-git.js";

// ── cwd validation ──────────────────────────────────────────────────────────

const ALLOWED_CWD_PREFIXES = ["/workspace/repos", "/workspace/worktrees"];

export function validateCwd(cwd: string): string | null {
  if (!cwd || !cwd.startsWith("/")) {
    return "cwd must be an absolute path";
  }

  // Normalize to prevent traversal via /workspace/repos/../../etc
  const normalized = normalizePath(cwd);

  const allowed = ALLOWED_CWD_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix + "/"),
  );

  if (!allowed) {
    return `cwd must be under ${ALLOWED_CWD_PREFIXES.join(" or ")}`;
  }

  return null;
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") {
      parts.pop();
    } else if (seg !== "" && seg !== ".") {
      parts.push(seg);
    }
  }
  return "/" + parts.join("/");
}

// ── scoutqa policy ──────────────────────────────────────────────────────────

const ALLOWED_SCOUTQA_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "create-execution",
  "send-message",
  "list-executions",
  "complete-execution",
  "auth",
]);

export function validateScoutqaArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  const subcommand = args[0];
  if (!ALLOWED_SCOUTQA_SUBCOMMANDS.has(subcommand)) {
    return `"scoutqa ${subcommand}" is not allowed`;
  }

  // auth subcommand: only allow "status"
  if (subcommand === "auth") {
    const sub = args[1];
    if (sub !== "status") {
      return `"scoutqa auth ${sub || ""}" is not allowed — only "scoutqa auth status" is permitted`;
    }
  }

  return null;
}

// ── langfuse policy ────────────────────────────────────────────────────────

const ALLOWED_LANGFUSE_RESOURCES: ReadonlySet<string> = new Set([
  "traces",
  "sessions",
  "observations",
  "metrics",
  "models",
  "prompts",
]);

const ALLOWED_LANGFUSE_ACTIONS: ReadonlySet<string> = new Set(["list", "get", "--help"]);

const DENIED_LANGFUSE_FLAGS: ReadonlySet<string> = new Set([
  "--config",
  "--output",
  "--output-file",
  "--curl",
  "--env",
  "--public-key",
  "--secret-key",
  "--host",
]);

export function validateLangfuseArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  // First arg must be "api"
  if (args[0] !== "api") {
    return `"langfuse ${args[0]}" is not allowed — only "langfuse api" is permitted`;
  }

  if (args.length < 2) {
    return '"langfuse api" requires a resource';
  }

  const resource = args[1];

  // __schema is a special case: no action required, no additional args
  if (resource === "__schema") {
    if (args.length > 2) {
      return '"langfuse api __schema" does not accept additional arguments';
    }
    return null;
  }

  if (!ALLOWED_LANGFUSE_RESOURCES.has(resource)) {
    return `"langfuse api ${resource}" is not allowed`;
  }

  if (args.length < 3) {
    return `"langfuse api ${resource}" requires an action (list, get, or --help)`;
  }

  const action = args[2];
  if (!ALLOWED_LANGFUSE_ACTIONS.has(action)) {
    return `"langfuse api ${resource} ${action}" is not allowed — only list, get, and --help are permitted`;
  }

  // Check for denied flags (handles both --flag value and --flag=value forms)
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (DENIED_LANGFUSE_FLAGS.has(flag)) {
      return `flag "${flag}" is not allowed`;
    }
  }

  return null;
}

// ── launchdarkly policy ────────────────────────────────────────────────────

const ALLOWED_LDCLI_RESOURCES: ReadonlySet<string> = new Set([
  "flags",
  "environments",
  "projects",
  "segments",
  "metrics",
]);

const ALLOWED_LDCLI_ACTIONS: ReadonlySet<string> = new Set(["list", "get", "--help"]);

const PROJECT_SCOPED_LDCLI_RESOURCES: ReadonlySet<string> = new Set([
  "flags",
  "environments",
  "segments",
  "metrics",
]);

const DENIED_LDCLI_FLAGS: ReadonlySet<string> = new Set([
  "--access-token",
  "--config",
  "--data",
  "--data-file",
  "--output-file",
  "--curl",
]);

export function validateLdcliArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  const resource = args[0];
  if (!ALLOWED_LDCLI_RESOURCES.has(resource)) {
    return `"ldcli ${resource}" is not allowed`;
  }

  if (args.length < 2) {
    return `"ldcli ${resource}" requires an action (list, get, or --help)`;
  }

  const action = args[1];
  if (!ALLOWED_LDCLI_ACTIONS.has(action)) {
    return `"ldcli ${resource} ${action}" is not allowed — only list, get, and --help are permitted`;
  }

  if (resource === "metrics" && action === "get") {
    return '"ldcli metrics get" is not allowed — only "ldcli metrics list" is permitted';
  }

  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (DENIED_LDCLI_FLAGS.has(flag)) {
      return `flag "${flag}" is not allowed`;
    }
  }

  const isHelpRequest = args.includes("--help") || args.includes("-h");
  if (
    !isHelpRequest &&
    PROJECT_SCOPED_LDCLI_RESOURCES.has(resource) &&
    !hasOptionValue(args, "--project")
  ) {
    return `"ldcli ${resource} ${action}" requires "--project <key>"`;
  }

  return null;
}

function hasOptionValue(args: string[], option: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === option) {
      return Boolean(args[i + 1] && !args[i + 1].startsWith("-"));
    }

    if (arg.startsWith(`${option}=`)) {
      return arg.slice(option.length + 1).length > 0;
    }
  }

  return false;
}

// ── metabase policy ────────────────────────────────────────────────────────

const ALLOWED_METABASE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "schemas",
  "tables",
  "columns",
  "query",
]);

export function validateMetabaseArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  const subcommand = args[0];
  if (!ALLOWED_METABASE_SUBCOMMANDS.has(subcommand)) {
    return `"metabase ${subcommand}" is not allowed — valid subcommands: schemas, tables, columns, query`;
  }

  const allowedSchemas = getMetabaseAllowedSchemas();

  if (subcommand === "schemas") {
    if (args.length > 1) return '"metabase schemas" takes no arguments';
    return null;
  }

  if (subcommand === "tables") {
    if (args.length !== 2) return '"metabase tables" requires exactly 1 argument: <schema>';
    const schema = args[1];
    if (allowedSchemas.size > 0 && !allowedSchemas.has(schema)) {
      return `schema "${schema}" is not in the allowed list`;
    }
    return null;
  }

  if (subcommand === "columns") {
    if (args.length !== 3)
      return '"metabase columns" requires exactly 2 arguments: <schema> <table>';
    const schema = args[1];
    if (allowedSchemas.size > 0 && !allowedSchemas.has(schema)) {
      return `schema "${schema}" is not in the allowed list`;
    }
    return null;
  }

  if (subcommand === "query") {
    if (args.length !== 2) return '"metabase query" requires exactly 1 argument: <sql>';
    return null;
  }

  return null;
}

function getMetabaseAllowedSchemas(): Set<string> {
  const raw = process.env.METABASE_ALLOWED_SCHEMAS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
// ── gh policy ───────────────────────────────────────────────────────────────

/**
 * Allowed gh CLI command groups and subcommands.
 * Format: "group subcommand" — e.g. "pr view", "issue list".
 */
const ALLOWED_GH_COMMANDS: ReadonlySet<string> = new Set([
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

export function validateGhArgs(args: string[], cwd?: string): string | null {
  if (!Array.isArray(args)) {
    return "args must be an array";
  }

  if (args.length === 0) {
    return null;
  }

  if (args[0] === "--version") {
    return args.length === 1 ? null : '"gh --version" does not accept additional arguments';
  }

  if (isGhHelpRequest(args)) {
    return validateGhHelpArgs(args);
  }

  const group = args[0];

  // gh api is blocked entirely — use specific gh commands instead
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
      return `"gh ${key}" is not allowed — use 'git fetch origin pull/<N>/head:pr-<N>' then 'git worktree add <path> pr-<N>' to inspect a PR without leaving this worktree`;
    }
    return `"gh ${key}" is not allowed`;
  }

  if (key === "pr create") {
    return validateGhPrCreateArgs(args);
  }

  if (key === "pr comment" || key === "issue comment") {
    return validateGhAppendOnlyCommentArgs(args, key, cwd);
  }

  if (key === "pr review") {
    return validateGhPrReviewArgs(args, cwd);
  }

  return null;
}

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
  // Only treat --help/-h as a help request when it's in a flag position.
  // Skip tokens that are values of known value-taking flags so a comment body
  // of "-h" or "--help" doesn't silently route every mutation to the help
  // validator.
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
  const topic = resolveGhHelpTopic(args);
  if (topic === "api") {
    return '"gh api --help" is not allowed — gh api remains blocked';
  }

  return null;
}

function resolveGhHelpTopic(args: string[]): string | undefined {
  if (args[0] === "help") {
    return args[1];
  }

  return args[0];
}

function validateGhPrCreateArgs(args: string[]): string | null {
  const key = "pr create";
  const allowedFlagsWithValue: ReadonlySet<string> = new Set([
    "-t",
    "--title",
    "-b",
    "--body",
    "-B",
    "--base",
    "-H",
    "--head",
  ]);

  const allowedBooleanFlags: ReadonlySet<string> = new Set(["--draft"]);

  const blockedFlags: ReadonlySet<string> = new Set([
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
    if (!arg.startsWith("-")) {
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

    if (blockedFlags.has(flag)) {
      return `"gh ${key} ${flag}" is not allowed — interactive and file-based modes are blocked`;
    }

    if (allowedBooleanFlags.has(flag)) {
      continue;
    }

    if (!allowedFlagsWithValue.has(flag)) {
      return `"gh ${key} ${arg}" is not allowed — only --title/--body with optional --base/--head/--draft are permitted`;
    }

    if (flag === "-t" || flag === "--title") {
      hasTitle = true;
    }
    if (flag === "-b" || flag === "--body") {
      hasBody = true;
    }

    let value: string | undefined;

    if (eqIdx < 0) {
      if (i + 1 >= args.length) {
        return `"gh ${key} ${flag}" requires a value`;
      }
      value = args[i + 1];
      i += 1;
    } else {
      value = arg.slice(eqIdx + 1);
    }

    if ((flag === "-H" || flag === "--head") && !isValidLocalBranchSelector(value ?? "")) {
      return `"gh ${key} ${flag}" is not allowed — --head must be a branch in the current repo`;
    }
  }

  if (!hasTitle || !hasBody) {
    return '"gh pr create" requires both --title and --body';
  }

  return null;
}

function validateGhAppendOnlyCommentArgs(args: string[], key: string, cwd?: string): string | null {
  const allowedFlagsWithValue: ReadonlySet<string> = new Set(["-b", "--body"]);

  const blockedMutationFlags: ReadonlySet<string> = new Set([
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

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

    if (blockedMutationFlags.has(flag)) {
      return `"gh ${key} ${flag}" is not allowed — append-only comment creation only`;
    }

    if (!allowedFlagsWithValue.has(flag)) {
      return `"gh ${key} ${arg}" is not allowed — only --body is permitted`;
    }

    if (flag === "-b" || flag === "--body") {
      hasBody = true;
    }

    if (eqIdx < 0) {
      if (i + 1 >= args.length) {
        return `"gh ${key} ${flag}" requires a value`;
      }
      i += 1;
    }
  }

  if (!hasBody) {
    return `"gh ${key}" requires --body`;
  }

  if (key === "pr comment") {
    return validateOptionalPrSelector(key, selectors, cwd);
  }

  return validateRequiredIssueSelector(key, selectors, cwd);
}

function validateOptionalPrSelector(key: string, selectors: string[], cwd?: string): string | null {
  if (selectors.length > 1) {
    return `"gh ${key}" allows at most one positional PR selector`;
  }

  if (selectors.length === 0) {
    return null;
  }

  return validatePrSelector(key, selectors[0], cwd);
}

function validateRequiredIssueSelector(
  key: string,
  selectors: string[],
  cwd?: string,
): string | null {
  if (selectors.length !== 1) {
    return `"gh ${key}" requires exactly one positional issue selector`;
  }

  return validateIssueSelector(key, selectors[0], cwd);
}

function validatePrSelector(key: string, selector: string, cwd?: string): string | null {
  if (/^\d+$/.test(selector)) {
    return null;
  }

  if (looksLikeHttpsUrl(selector)) {
    return validateCurrentRepoUrlSelector(key, selector, "pull", cwd);
  }

  if (!isValidLocalBranchSelector(selector)) {
    return `"gh ${key}" positional selector must be a numeric PR number, current-repo PR URL, or branch name`;
  }

  return null;
}

function validateIssueSelector(key: string, selector: string, cwd?: string): string | null {
  if (/^\d+$/.test(selector)) {
    return null;
  }

  if (looksLikeHttpsUrl(selector)) {
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

function looksLikeHttpsUrl(value: string): boolean {
  return value.startsWith("https://");
}

function isValidLocalBranchSelector(selector: string): boolean {
  if (!selector || selector.includes(":") || selector.includes("#")) {
    return false;
  }

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

interface GitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}

function resolveCurrentGitHubRepo(cwd?: string): GitHubRepoRef | undefined {
  if (!cwd) {
    return undefined;
  }

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
    if (parts.length < 2) {
      return undefined;
    }

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
    if (parsed.protocol !== "https:") {
      return undefined;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 4) {
      return undefined;
    }

    const [owner, repo, resource, number] = parts;
    if (resource !== resourceType || !/^\d+$/.test(number)) {
      return undefined;
    }

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

function validateGhPrReviewArgs(args: string[], cwd?: string): string | null {
  const key = "pr review";
  const allowedFlagsWithValue: ReadonlySet<string> = new Set(["-b", "--body"]);

  const allowedModeFlags: ReadonlySet<string> = new Set([
    "-c",
    "--comment",
    "-r",
    "--request-changes",
  ]);

  let sawCommentMode = false;
  let sawRequestChangesMode = false;
  let hasBody = false;
  const selectors: string[] = [];

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      selectors.push(arg);
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

    if (flag === "-a" || flag === "--approve") {
      return '"gh pr review --approve" is not allowed — PR approval must be human';
    }

    if (
      flag === "-e" ||
      flag === "--editor" ||
      flag === "-w" ||
      flag === "--web" ||
      flag === "-F" ||
      flag === "--body-file"
    ) {
      return `"gh ${key} ${flag}" is not allowed — interactive and file-based review modes are blocked`;
    }

    if (allowedModeFlags.has(flag)) {
      if (flag === "-c" || flag === "--comment") {
        sawCommentMode = true;
      }
      if (flag === "-r" || flag === "--request-changes") {
        sawRequestChangesMode = true;
      }
      continue;
    }

    if (!allowedFlagsWithValue.has(flag)) {
      return `"gh ${key} ${arg}" is not allowed — only --comment/--request-changes with --body are permitted`;
    }

    if (flag === "-b" || flag === "--body") {
      hasBody = true;
    }

    if (eqIdx < 0) {
      if (i + 1 >= args.length) {
        return `"gh ${key} ${flag}" requires a value`;
      }
      i += 1;
    }
  }

  if (!sawCommentMode && !sawRequestChangesMode) {
    return '"gh pr review" requires exactly one of --comment or --request-changes';
  }

  if (sawCommentMode && sawRequestChangesMode) {
    return '"gh pr review" requires exactly one of --comment or --request-changes';
  }

  if (!hasBody) {
    return '"gh pr review" requires --body';
  }

  return validateOptionalPrSelector(key, selectors, cwd);
}
