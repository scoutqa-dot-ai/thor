/**
 * git policy — explicit allowlist of Thor-supported workflows.
 *
 * This module intentionally supports a small set of command shapes. Anything
 * outside that allowlist is denied with a pointer to the `using-git` skill,
 * which is the user-facing documentation for the supported surface.
 */

import { booleanFlagCount, scanPolicyArgs, valueFlagValues } from "./policy-args.js";
import {
  WORKSPACE_REPOS_ROOT,
  WORKSPACE_WORKTREES_ROOT,
  isPathWithin,
  realpathOrNull,
} from "@thor/common";
import { isAbsolute, normalize as normalizePosix } from "node:path/posix";

const DIGITS_ONLY = /^\d+$/;

interface ResolvedGitArgsSuccess {
  args: string[];
  // Optional rewritten cwd produced by stripping a leading `-C <path>`. When
  // present, callers must use this in place of the request cwd for both
  // execution and any further validation.
  cwd?: string;
}
interface ResolvedGitArgsFailure {
  error: string;
}
export type ResolvedGitArgs = ResolvedGitArgsSuccess | ResolvedGitArgsFailure;

interface DenyGuidance {
  reason: string;
  instead?: string;
}

const WORKTREE_ROOT = WORKSPACE_WORKTREES_ROOT;
const WORKTREE_PREFIX = `${WORKTREE_ROOT}/`;
const USING_GIT_HINT = "Load skill using-git for the supported command patterns.";

const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "shortlog",
  "merge-base",
  "branch",
  "rev-parse",
  "remote",
  "fetch",
  "ls-files",
  "ls-remote",
  "restore",
  "show-ref",
  "add",
  "commit",
  "config",
  "worktree",
  "push",
  "merge",
  "revert",
  "blame",
  "reflog",
  "grep",
  "for-each-ref",
  "cat-file",
  "name-rev",
  "describe",
  "tag",
  "stash",
]);

const PROTECTED_PUSH_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

const DEFAULT_GIT_DENY_GUIDANCE: DenyGuidance = {
  reason: "this command shape is outside Thor's allowed git workflows.",
};

const GIT_DENY_GUIDANCE: Readonly<Record<string, DenyGuidance>> = {
  "git --version": {
    reason: "git --version does not accept extra arguments in Thor.",
    instead: "git --version",
  },
  "git checkout": {
    reason: "checkout can switch branches in the current worktree, which Thor blocks.",
    instead:
      "for branch work, use git worktree add /workspace/worktrees/<repo>/<branch> <branch>; for file restore, use git restore [--source <tree>] -- <path>",
  },
  "git switch": {
    reason: "switch changes the current worktree branch, which Thor blocks.",
    instead: "git worktree add /workspace/worktrees/<repo>/<branch> <branch>",
  },
  "git merge-base": {
    reason: "merge-base is limited to explicit comparison helpers.",
    instead: "git merge-base <left> <right> or git merge-base --is-ancestor <left> <right>",
  },
  "git branch": {
    reason: "branch mutation is blocked; only read-only branch inspection is allowed.",
    instead: "git branch --show-current or git branch --list [<pattern>]",
  },
  "git remote": {
    reason: "remote mutation is blocked; Thor only allows reading the configured origin.",
    instead: "git remote -v or git remote get-url origin",
  },
  "git fetch": {
    reason: "fetch must avoid config-dependent or arbitrary remote behavior.",
    instead: "git fetch, git fetch origin <branch>, or git fetch --all",
  },
  "git config": {
    reason: "git config is read-only; mutation, --global, --system, and --file are blocked.",
    instead: "git config --get <key>, git config --get-all <key>, or git config --list",
  },
  "git -C": {
    reason: "git -C <path> is only allowed when <path> is inside an allowed workspace root.",
    instead: "use a path under /workspace/repos/<repo> or /workspace/worktrees/<repo>/<branch>",
  },
  "git restore": {
    reason: "restore must name paths after a -- separator and use only supported flags.",
    instead: "git restore [--source <tree>] [--staged] -- <path>",
  },
  "git add": {
    reason: "add is limited to explicit paths or the full-worktree -A form.",
    instead: "git add <path...> or git add -A",
  },
  "git commit": {
    reason: "commit must be non-interactive and cannot bypass hooks or amend history.",
    instead: "git commit -m <message> or git commit -F <path>",
  },
  "git worktree": {
    reason: "only Thor's worktree add/list/remove/prune workflows are allowed.",
    instead: "git worktree add /workspace/worktrees/<repo>/<branch> <branch>",
  },
  "git worktree list": {
    reason: "worktree list only supports the default output or porcelain output.",
    instead: "git worktree list or git worktree list --porcelain",
  },
  "git worktree remove": {
    reason: "worktree removal must target an existing path under /workspace/worktrees/.",
    instead: "git worktree remove /workspace/worktrees/<repo>/<branch>",
  },
  "git worktree prune": {
    reason: "worktree prune only supports the default cleanup or a dry run.",
    instead: "git worktree prune or git worktree prune --dry-run",
  },
  "git worktree add": {
    reason:
      "worktree paths must live under /workspace/worktrees/<repo>/ and (for branch shapes) end with the branch name.",
    instead:
      "git worktree add /workspace/worktrees/<repo>/<branch> <branch>, git worktree add -b <branch> /workspace/worktrees/<repo>/<branch> <start-point>, or git worktree add --detach /workspace/worktrees/<repo>/<label> <commit-ish>",
  },
  "git push": {
    reason:
      "pushes must target origin with an explicit HEAD refspec and cannot target main or master.",
    instead: "git push origin HEAD:refs/heads/<branch>",
  },
  "git merge": {
    reason: "merge is allowed except for hook-bypass flags.",
    instead: "git merge origin/<branch>",
  },
  "git ls-remote": {
    reason: "ls-remote must read from origin, not arbitrary remotes or URLs.",
    instead: "git ls-remote origin [<ref-pattern>...]",
  },
  "git tag": {
    reason: "tag creation, deletion, signing, and moving are blocked; listing is allowed.",
    instead: "git tag --list [<pattern>]",
  },
  "git stash": {
    reason: "stash mutation is blocked; only stash inspection is allowed.",
    instead: "git stash list or git stash show <stash>",
  },
  "git pull": {
    reason:
      "pull depends on local upstream/config and can silently choose merge or rebase behavior.",
    instead: "git fetch origin <branch> && git merge origin/<branch>",
  },
};

export function resolveGitArgs(args: string[], _cwd?: string): ResolvedGitArgs {
  if (!Array.isArray(args) || args.length === 0) {
    return { error: "args must be a non-empty array" };
  }

  // Optional leading `-C <path>` (or `-C=<path>`) — rewrite to a cwd override
  // when the path is inside an allowed workspace root. Anything else
  // continues to fall through to the leading-flag deny below.
  let rewrittenCwd: string | undefined;
  let workingArgs: string[] = args;
  if (args[0] === "-C" || args[0].startsWith("-C=")) {
    const stripped = stripLeadingDashC(args);
    if ("error" in stripped) return stripped;
    workingArgs = stripped.args;
    rewrittenCwd = stripped.cwd;
    if (workingArgs.length === 0) {
      return { error: "args must be a non-empty array" };
    }
  }

  const first = workingArgs[0];

  if (first === "--version") {
    return workingArgs.length === 1
      ? withCwd({ args: [...workingArgs] }, rewrittenCwd)
      : deny("git --version");
  }

  if (first.startsWith("-")) {
    return deny(`git ${first}`);
  }

  if (first === "checkout" || first === "switch") {
    return deny(`git ${first}`);
  }

  if (!ALLOWED_GIT_SUBCOMMANDS.has(first)) {
    return deny(`git ${first}`);
  }

  const resolved = resolveSubcommand(first, workingArgs);
  if ("error" in resolved) return resolved;
  return withCwd(resolved, rewrittenCwd);
}

function withCwd(resolved: ResolvedGitArgsSuccess, cwd: string | undefined): ResolvedGitArgs {
  return cwd !== undefined ? { args: resolved.args, cwd } : resolved;
}

function stripLeadingDashC(args: string[]): ResolvedGitArgs {
  let pathArg: string;
  let rest: string[];
  if (args[0] === "-C") {
    if (args.length < 2 || args[1].startsWith("-")) return deny("git -C");
    pathArg = args[1];
    rest = args.slice(2);
  } else {
    pathArg = args[0].slice("-C=".length);
    rest = args.slice(1);
  }

  if (!pathArg || !isAbsolute(pathArg)) return deny("git -C");
  const normalized = normalizePosix(pathArg);
  if (normalized !== pathArg) return deny("git -C");
  const real = realpathOrNull(pathArg);
  if (!real) return deny("git -C");
  if (!isPathWithin(WORKTREE_ROOT, real) && !isPathWithin(WORKSPACE_REPOS_ROOT, real)) {
    return deny("git -C");
  }

  return { args: rest, cwd: pathArg };
}

function resolveSubcommand(first: string, args: string[]): ResolvedGitArgs {
  switch (first) {
    case "status":
    case "log":
    case "diff":
    case "show":
    case "shortlog":
    case "ls-files":
    case "show-ref":
    case "blame":
    case "reflog":
    case "grep":
    case "for-each-ref":
    case "cat-file":
    case "name-rev":
    case "describe":
    case "rev-parse":
      return { args: [...args] };
    case "merge-base":
      return wrap(validateMergeBase(args), args);
    case "branch":
      return wrap(validateBranch(args), args);
    case "remote":
      return wrap(validateRemote(args), args);
    case "fetch":
      return wrap(validateFetch(args), args);
    case "ls-remote":
      return wrap(validateLsRemote(args), args);
    case "tag":
      return wrap(validateTag(args), args);
    case "stash":
      return wrap(validateStash(args), args);
    case "restore":
      return wrap(validateRestore(args), args);
    case "add":
      return wrap(validateAdd(args), args);
    case "commit":
      return wrap(validateCommit(args), args);
    case "config":
      return wrap(validateConfig(args), args);
    case "worktree":
      return wrap(validateWorktree(args), args);
    case "push":
      return wrap(validatePush(args), args);
    case "merge":
      return wrap(validateMerge(args), args);
    case "revert":
      return { args: [...args] };
    default:
      return deny(`git ${first}`);
  }
}

export function validateGitArgs(args: string[], cwd?: string): string | null {
  const result = resolveGitArgs(args, cwd);
  return "error" in result ? result.error : null;
}

function wrap(err: string | null, args: string[]): ResolvedGitArgs {
  return err ? { error: err } : { args: [...args] };
}

function deny(command: string, guidance?: DenyGuidance): ResolvedGitArgsFailure {
  return { error: denyMessage(command, guidance) };
}

function denyMessage(command: string, guidance?: DenyGuidance): string {
  const details = guidance ?? GIT_DENY_GUIDANCE[command] ?? DEFAULT_GIT_DENY_GUIDANCE;
  const lines = [`"${command}" is not allowed.`, `Reason: ${details.reason}`];
  if (details.instead) lines.push(`Try instead: ${details.instead}`);
  lines.push(`Details: ${USING_GIT_HINT}`);
  return lines.join("\n");
}

function validateMergeBase(args: string[]): string | null {
  // Plain: `merge-base <left> <right>`.
  if (args.length === 3 && !args[1].startsWith("-") && !args[2].startsWith("-")) {
    return null;
  }
  // `merge-base --is-ancestor <left> <right>` — exits 0/1 without output.
  if (
    args.length === 4 &&
    args[1] === "--is-ancestor" &&
    !args[2].startsWith("-") &&
    !args[3].startsWith("-")
  ) {
    return null;
  }
  // `merge-base --fork-point <ref> [<commit>]`.
  if (
    (args.length === 3 || args.length === 4) &&
    args[1] === "--fork-point" &&
    args.slice(2).every((a) => !a.startsWith("-"))
  ) {
    return null;
  }
  return denyMessage("git merge-base");
}

function validateBranch(args: string[]): string | null {
  if (matchesExactArgs(args, ["branch", "--show-current"])) {
    return null;
  }

  const parsed = scanPolicyArgs(args, 1, [
    { name: "all", kind: "boolean", aliases: ["-a", "--all"] },
    { name: "list", kind: "boolean", aliases: ["--list"] },
  ]);
  if (!parsed) {
    return denyMessage("git branch");
  }

  const allCount = booleanFlagCount(parsed, "all");
  const listCount = booleanFlagCount(parsed, "list");
  if (allCount > 1 || listCount > 1 || parsed.positionals.length > 1) {
    return denyMessage("git branch");
  }

  if (listCount === 0) {
    return parsed.positionals.length === 0 && allCount === 1 ? null : denyMessage("git branch");
  }

  return null;
}

function validateRemote(args: string[]): string | null {
  if (
    matchesExactArgs(args, ["remote"]) ||
    matchesExactArgs(args, ["remote", "-v"]) ||
    matchesExactArgs(args, ["remote", "--verbose"]) ||
    matchesExactArgs(args, ["remote", "show", "origin"]) ||
    matchesExactArgs(args, ["remote", "get-url", "origin"])
  ) {
    return null;
  }

  return denyMessage("git remote");
}

function validateFetch(args: string[]): string | null {
  const parsed = scanPolicyArgs(args, 1, [
    { name: "prune", kind: "boolean", aliases: ["--prune", "-p"] },
    { name: "tags", kind: "boolean", aliases: ["--tags", "-t"] },
    { name: "no-tags", kind: "boolean", aliases: ["--no-tags"] },
    { name: "all", kind: "boolean", aliases: ["--all"] },
    { name: "depth", kind: "value", aliases: ["--depth"] },
  ]);
  if (!parsed) return denyMessage("git fetch");

  if (booleanFlagCount(parsed, "tags") > 0 && booleanFlagCount(parsed, "no-tags") > 0) {
    return denyMessage("git fetch");
  }

  const depths = valueFlagValues(parsed, "depth");
  if (depths.length > 1 || depths.some((d) => !DIGITS_ONLY.test(d) || d === "0")) {
    return denyMessage("git fetch");
  }

  // `--all` fetches every configured remote. Accept it standalone (no positional
  // remote), and deny the combination `--all origin ...` which Git already rejects.
  if (booleanFlagCount(parsed, "all") > 0) {
    return parsed.positionals.length === 0 ? null : denyMessage("git fetch");
  }

  // No positional → defaults to origin (e.g. `git fetch`, `git fetch --prune`).
  if (parsed.positionals.length === 0) {
    return null;
  }

  // Otherwise: first positional must be `origin`; remaining positionals are refspecs.
  if (parsed.positionals[0] !== "origin") {
    return denyMessage("git fetch");
  }

  return null;
}

function validateRestore(args: string[]): string | null {
  // Approved flag pool before the `--` separator: at most one `--source[=<tree>]`
  // and any number of `--staged` / `-S` (a simple boolean toggle).
  let i = 1;
  let sawSource = false;

  while (i < args.length && args[i] !== "--") {
    const arg = args[i];
    if (arg === "--staged" || arg === "-S") {
      i += 1;
      continue;
    }
    if (arg === "--source") {
      if (sawSource || i + 1 >= args.length || args[i + 1].length === 0) {
        return denyMessage("git restore");
      }
      sawSource = true;
      i += 2;
      continue;
    }
    if (arg.startsWith("--source=")) {
      if (sawSource || arg.length <= "--source=".length) {
        return denyMessage("git restore");
      }
      sawSource = true;
      i += 1;
      continue;
    }
    return denyMessage("git restore");
  }

  if (i >= args.length || args[i] !== "--" || i + 1 >= args.length) {
    return denyMessage("git restore");
  }

  return null;
}

function validateAdd(args: string[]): string | null {
  if (matchesExactArgs(args, ["add", "-A"])) {
    return null;
  }

  if (args.length < 2) {
    return denyMessage("git add");
  }

  for (let i = 1; i < args.length; i += 1) {
    if (args[i].startsWith("-")) {
      return denyMessage("git add");
    }
  }

  return null;
}

function validateCommit(args: string[]): string | null {
  // Supported shapes (exactly one body source):
  //   `git commit -m <msg> [-m <msg>...]`     — one or more -m messages
  //   `git commit -F <path>` / `--file=<path>` — message from a file
  // The two forms are mutually exclusive. No other flags are accepted.
  const parsed = scanPolicyArgs(args, 1, [
    { name: "message", kind: "value", aliases: ["-m", "--message"] },
    { name: "file", kind: "value", aliases: ["-F", "--file"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) return denyMessage("git commit");

  const messages = valueFlagValues(parsed, "message");
  const files = valueFlagValues(parsed, "file");

  if (messages.length > 0 && files.length > 0) return denyMessage("git commit");
  if (files.length > 1) return denyMessage("git commit");
  if (messages.length === 0 && files.length === 0) return denyMessage("git commit");

  return null;
}

function validateWorktree(args: string[]): string | null {
  const sub = args[1];
  if (sub === "add") return validateWorktreeAdd(args);
  if (sub === "list") return validateWorktreeList(args);
  if (sub === "remove") return validateWorktreeRemove(args);
  if (sub === "prune") return validateWorktreePrune(args);
  return denyMessage("git worktree");
}

function validateWorktreeList(args: string[]): string | null {
  // `git worktree list [--porcelain]` — read-only.
  if (args.length === 2) return null;
  if (args.length === 3 && args[2] === "--porcelain") return null;
  return denyMessage("git worktree list");
}

function validateWorktreeRemove(args: string[]): string | null {
  // `git worktree remove <path>` — path must be under /workspace/worktrees/.
  // --force is denied: callers should handle the "has uncommitted changes" case
  // explicitly rather than nuke blindly.
  if (args.length !== 3 || args[2].startsWith("-") || !isAbsolute(args[2])) {
    return denyMessage("git worktree remove");
  }
  const realPath = realpathOrNull(args[2]);
  if (!realPath || !isPathWithin(WORKTREE_ROOT, realPath) || realPath === WORKTREE_ROOT) {
    return denyMessage("git worktree remove");
  }
  return null;
}

function validateWorktreePrune(args: string[]): string | null {
  // `git worktree prune [--dry-run]` — removes admin entries for gone worktrees.
  if (args.length === 2) return null;
  if (args.length === 3 && (args[2] === "--dry-run" || args[2] === "-n")) return null;
  return denyMessage("git worktree prune");
}

function validateWorktreeAdd(args: string[]): string | null {
  // Three supported shapes:
  //   `git worktree add -b <new-branch> <path> [<start-point>]` — create branch
  //   `git worktree add <path> <existing-branch>`                — check out existing
  //   `git worktree add --detach <path> <commit-ish>`            — detached HEAD
  //
  // In the first two cases, the path portion under /workspace/worktrees/<repo>/
  // equals the branch string verbatim. In the detached case there is no
  // branch, so only the structural prefix check applies (path must live
  // under /workspace/worktrees/<repo>/<freeform>).
  if (args.length < 4 || args.length > 6) {
    return denyMessage("git worktree add");
  }

  const parsed = scanPolicyArgs(args, 2, [
    { name: "branch", kind: "value", aliases: ["-b"] },
    { name: "detach", kind: "boolean", aliases: ["--detach"] },
  ]);
  if (!parsed) {
    return denyMessage("git worktree add");
  }

  const branchFlag = valueFlagValues(parsed, "branch");
  const detachFlag = booleanFlagCount(parsed, "detach");

  if (detachFlag > 0) {
    // --detach form: positionals are [path, commit-ish]. -b is mutually exclusive.
    if (detachFlag > 1 || branchFlag.length > 0 || parsed.positionals.length !== 2) {
      return denyMessage("git worktree add");
    }
    const path = parsed.positionals[0];
    if (!parseWorktreeAddBranchFromPath(path)) {
      return denyMessage("git worktree add");
    }
    return null;
  }

  let branch: string;
  let path: string;

  if (branchFlag.length === 1) {
    // -b form: positionals are [path] or [path, start-point].
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
      return denyMessage("git worktree add");
    }
    branch = branchFlag[0];
    path = parsed.positionals[0];
  } else if (branchFlag.length === 0) {
    // No -b: positionals are [path, existing-branch].
    if (parsed.positionals.length !== 2) {
      return denyMessage("git worktree add");
    }
    path = parsed.positionals[0];
    branch = parsed.positionals[1];
  } else {
    return denyMessage("git worktree add");
  }

  if (!branch || branch.startsWith("-") || !isValidWorktreeBranchPathPart(branch)) {
    return denyMessage("git worktree add");
  }

  const pathBranch = parseWorktreeAddBranchFromPath(path);
  if (!pathBranch || pathBranch !== branch) {
    return denyMessage("git worktree add");
  }

  return null;
}

function parseWorktreeAddBranchFromPath(path: string): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  if (path.includes("\0") || !isAbsolute(path) || !path.startsWith(WORKTREE_PREFIX)) return null;

  const normalized = normalizePosix(path);
  if (normalized !== path) return null;

  const relative = path.slice(WORKTREE_PREFIX.length);
  if (!isValidWorktreeBranchPathPart(relative)) return null;

  const segments = relative.split("/");
  if (segments.length < 2) return null;

  const repo = segments[0];
  if (!repo) return null;

  const branch = segments.slice(1).join("/");
  return isValidWorktreeBranchPathPart(branch) ? branch : null;
}

function isValidWorktreeBranchPathPart(value: string): boolean {
  if (!value) return false;
  if (value.includes("\0")) return false;
  if (isAbsolute(value)) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "..")) return false;

  return true;
}

function validatePush(args: string[]): string | null {
  const parsed = scanPolicyArgs(args, 1, [
    { name: "dry-run", kind: "boolean", aliases: ["--dry-run"] },
    { name: "upstream", kind: "boolean", aliases: ["-u", "--set-upstream"] },
  ]);
  if (!parsed) {
    return denyMessage("git push");
  }

  if (
    booleanFlagCount(parsed, "dry-run") > 1 ||
    booleanFlagCount(parsed, "upstream") > 1 ||
    parsed.positionals.length !== 2 ||
    parsed.positionals[0] !== "origin"
  ) {
    return denyMessage("git push");
  }

  return validatePushRefspec(parsed.positionals[1]);
}

function validatePushRefspec(refspec: string): string | null {
  const prefix = "HEAD:refs/heads/";
  if (!refspec.startsWith(prefix)) {
    return denyMessage("git push");
  }

  const branch = refspec.slice(prefix.length);
  if (!branch || branch.includes(":") || PROTECTED_PUSH_BRANCHES.has(branch)) {
    return denyMessage("git push");
  }

  return null;
}

function validateConfig(args: string[]): string | null {
  // Read-only forms only:
  //   git config --get <key>
  //   git config --get-all <key>
  //   git config --list / -l
  // Optional inspection modifiers: --local, --show-origin, --show-scope.
  // Mutation (--add, --unset, --replace-all, --rename-section, etc.),
  // scope overrides (--global, --system, --file), and any positional after
  // the mode flag's value are denied.
  const parsed = scanPolicyArgs(args, 1, [
    { name: "get", kind: "value", aliases: ["--get"] },
    { name: "get-all", kind: "value", aliases: ["--get-all"] },
    { name: "list", kind: "boolean", aliases: ["--list", "-l"] },
    { name: "local", kind: "boolean", aliases: ["--local"] },
    { name: "show-origin", kind: "boolean", aliases: ["--show-origin"] },
    { name: "show-scope", kind: "boolean", aliases: ["--show-scope"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) return denyMessage("git config");

  const gets = valueFlagValues(parsed, "get");
  const getAlls = valueFlagValues(parsed, "get-all");
  const list = booleanFlagCount(parsed, "list");

  const modes = (gets.length > 0 ? 1 : 0) + (getAlls.length > 0 ? 1 : 0) + (list > 0 ? 1 : 0);
  if (modes !== 1) return denyMessage("git config");
  if (gets.length > 1 || getAlls.length > 1 || list > 1) return denyMessage("git config");

  return null;
}

function validateMerge(args: string[]): string | null {
  // Passthrough: merge's own safety surface (push to protected branches, force,
  // commit hooks for non-merge commits) is already enforced elsewhere. Only
  // `--no-verify` is denied, mirroring `git commit` — repo merge hooks are the
  // last line of defense against unintended merges into release lines.
  return args.includes("--no-verify") ? denyMessage("git merge") : null;
}

function validateLsRemote(args: string[]): string | null {
  // `git ls-remote [<flags>] [origin] [<ref-pattern>...]`. Network call, so
  // the remote must be `origin` if named — matches the `validateFetch`
  // restriction. Omitted remote defaults to origin.
  let sawRepo = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("-")) continue;
    if (!sawRepo) {
      if (arg !== "origin") return denyMessage("git ls-remote");
      sawRepo = true;
      continue;
    }
    // Subsequent positionals are ref patterns; no further validation.
  }
  return null;
}

function validateTag(args: string[]): string | null {
  // List-only. `-l`/`--list` is required before any positional pattern —
  // without it, `git tag <name>` creates a tag at HEAD. List-mode also
  // accepts read-only sort/format selectors.
  const listMode = args.includes("-l") || args.includes("--list");
  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      if (!listMode) return denyMessage("git tag");
      i += 1;
      continue;
    }
    if (arg === "-l" || arg === "--list" || arg === "-n" || /^-n\d+$/.test(arg)) {
      i += 1;
      continue;
    }
    if (arg === "--sort" || arg === "--format") {
      if (i + 1 >= args.length || args[i + 1].length === 0) return denyMessage("git tag");
      i += 2;
      continue;
    }
    if (arg.startsWith("--sort=") || arg.startsWith("--format=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (value.length === 0) return denyMessage("git tag");
      i += 1;
      continue;
    }
    return denyMessage("git tag");
  }
  return null;
}

function validateStash(args: string[]): string | null {
  // Read-only only: `git stash list [...]` and `git stash show [...]`.
  // Bare `git stash` defaults to `stash push`, so we require an explicit subcommand.
  if (args.length < 2) return denyMessage("git stash");
  const sub = args[1];
  if (sub === "list" || sub === "show") return null;
  return denyMessage("git stash");
}

function matchesExactArgs(args: string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((arg, idx) => arg === expected[idx]);
}
