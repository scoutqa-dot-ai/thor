/**
 * git policy — imperative allowlist + narrow validators.
 *
 * The allowlist sets (ALLOWED_GIT_SUBCOMMANDS, NO_PAGER_SAFE_GIT_SUBCOMMANDS)
 * are exported so the skill generator can project them into `using-git`
 * without reimplementing the policy.
 */

import { execFileSync } from "node:child_process";

interface ResolvedGitArgsSuccess {
  args: string[];
}
interface ResolvedGitArgsFailure {
  error: string;
}
export type ResolvedGitArgs = ResolvedGitArgsSuccess | ResolvedGitArgsFailure;

interface ResolvedImplicitPushTarget {
  remote: "origin";
  refspec: string;
}

const WORKTREE_PREFIX = "/workspace/worktrees/";
const WORKTREE_HINT =
  "use 'git worktree add <path> <ref>' to work on another branch without leaving this worktree";
const USING_GIT_HINT = "Load skill using-git for the full allowed surface.";

export const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  // read
  "status",
  "log",
  "diff",
  "diff-tree",
  "show",
  "show-branch",
  "show-ref",
  "rev-list",
  "rev-parse",
  "branch",
  "tag",
  "stash",
  "blame",
  "shortlog",
  "describe",
  "for-each-ref",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "cat-file",
  "cherry",
  "count-objects",
  "merge-base",
  "name-rev",
  "range-diff",
  "reflog",
  "grep",
  "help",
  "submodule",
  "config",
  "check-ignore",
  "symbolic-ref",
  "check-ref-format",
  // write (local) — no checkout/switch; agent stays on its assigned branch
  "add",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "reset",
  "restore",
  "rm",
  "mv",
  "clean",
  "apply",
  "am",
  // worktree
  "worktree",
  // remote (fetch/push/pull only)
  "fetch",
  "pull",
  "push",
  "remote",
  // misc
  "version",
]);

export const NO_PAGER_SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "diff-tree",
  "show",
  "show-branch",
  "show-ref",
  "rev-list",
  "rev-parse",
  "blame",
  "shortlog",
  "describe",
  "for-each-ref",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "cat-file",
  "cherry",
  "count-objects",
  "merge-base",
  "name-rev",
  "range-diff",
  "reflog",
  "grep",
  "help",
  "config",
  "check-ignore",
  "symbolic-ref",
  "check-ref-format",
  "remote",
]);

// ── entry point ────────────────────────────────────────────────────────────

export function resolveGitArgs(args: string[], cwd?: string): ResolvedGitArgs {
  if (!Array.isArray(args) || args.length === 0) {
    return { error: "args must be a non-empty array" };
  }

  const first = args[0];

  if (first === "--version") {
    return args.length === 1
      ? { args: [...args] }
      : { error: '"git --version" does not accept additional arguments' };
  }

  if (first === "--no-pager") {
    return resolveNoPager(args, cwd);
  }

  if (first.startsWith("-")) {
    return {
      error: `"git ${first}" is not allowed — leading flags are not permitted; start with a bare subcommand`,
    };
  }

  if (first === "switch") {
    return { error: `"git switch" is not allowed — ${WORKTREE_HINT}` };
  }
  if (first === "checkout") {
    const err = validateGitCheckoutRestore(args);
    return err ? { error: err } : { args: [...args] };
  }

  if (!ALLOWED_GIT_SUBCOMMANDS.has(first)) {
    return { error: `"git ${first}" is not allowed. ${USING_GIT_HINT}` };
  }

  if (first === "worktree") return wrap(validateGitWorktree(args), args);
  if (first === "remote") return wrap(validateGitRemote(args), args);
  if (first === "config") return wrap(validateGitConfig(args), args);
  if (first === "check-ignore") return wrap(validateGitCheckIgnore(args), args);
  if (first === "symbolic-ref") return wrap(validateGitSymbolicRef(args), args);
  if (first === "push") return resolveGitPushArgs(args, cwd);

  return { args: [...args] };
}

export function validateGitArgs(args: string[], cwd?: string): string | null {
  const r = resolveGitArgs(args, cwd);
  return "error" in r ? r.error : null;
}

function wrap(err: string | null, args: string[]): ResolvedGitArgs {
  return err ? { error: err } : { args: [...args] };
}

// ── --no-pager ─────────────────────────────────────────────────────────────

function resolveNoPager(args: string[], cwd?: string): ResolvedGitArgs {
  if (args.length < 2) return { error: '"git --no-pager" requires a subcommand' };
  const sub = args[1];
  if (!NO_PAGER_SAFE_GIT_SUBCOMMANDS.has(sub)) {
    return {
      error: `"git --no-pager ${sub}" is not allowed — only read-only commands may use --no-pager`,
    };
  }
  const inner = resolveGitArgs(args.slice(1), cwd);
  if ("error" in inner) return inner;
  return { args: ["--no-pager", ...inner.args] };
}

// ── checkout restore ───────────────────────────────────────────────────────

const RESTORE_CHECKOUT_HINT = `"git checkout" is not allowed — ${WORKTREE_HINT}`;

const CHECKOUT_PATHSPEC_SUFFIXES = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".dart",
  ".xml",
  ".yaml",
  ".yml",
  ".kt",
  ".kts",
  ".java",
  ".py",
  ".go",
  ".sh",
  ".sql",
  ".css",
  ".scss",
  ".html",
  ".txt",
  ".lock",
  ".toml",
  ".gradle",
  ".properties",
  ".prisma",
];

function validateGitCheckoutRestore(args: string[]): string | null {
  const beforeSeparator: string[] = [];
  const afterSeparator: string[] = [];
  let sawSeparator = false;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      if (sawSeparator) return RESTORE_CHECKOUT_HINT;
      sawSeparator = true;
      continue;
    }
    if (arg === "--ours" || arg === "--theirs") {
      if (sawSeparator) return RESTORE_CHECKOUT_HINT;
      continue;
    }
    if (arg.startsWith("-")) return RESTORE_CHECKOUT_HINT;
    if (sawSeparator) afterSeparator.push(arg);
    else beforeSeparator.push(arg);
  }

  if (sawSeparator) {
    if (afterSeparator.length === 0 || beforeSeparator.length > 1) {
      return RESTORE_CHECKOUT_HINT;
    }
    // After `--`, git grammar guarantees pathspec.
    return null;
  }

  if (beforeSeparator.length === 0) return RESTORE_CHECKOUT_HINT;
  return beforeSeparator.every(looksLikeCheckoutPathspec) ? null : RESTORE_CHECKOUT_HINT;
}

function looksLikeCheckoutPathspec(value: string): boolean {
  if (!value) return false;
  if (value === "." || value === "./." || value.endsWith("/")) return true;
  if (value.startsWith(":(") || value.includes("*") || value.includes("?")) return true;
  const normalized = value.toLowerCase();
  if (normalized === ".gitignore" || normalized === ".metadata") return true;
  const parts = normalized.split("/");
  const last = parts[parts.length - 1];
  return CHECKOUT_PATHSPEC_SUFFIXES.some((suffix) => last.endsWith(suffix));
}

// ── worktree ───────────────────────────────────────────────────────────────

function validateGitWorktree(args: string[]): string | null {
  const wtIdx = args.indexOf("worktree");
  const subSub = args[wtIdx + 1];
  if (subSub !== "add") return null;

  const flagsWithValue = new Set(["-b", "-B"]);
  let i = wtIdx + 2;
  while (i < args.length) {
    const arg = args[i];
    if (flagsWithValue.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    const normalized = normalizePath(arg);
    if (!normalized.startsWith(WORKTREE_PREFIX)) {
      return `worktree path must be under ${WORKTREE_PREFIX}`;
    }
    return null;
  }
  return '"git worktree add" requires a path';
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

// ── remote ─────────────────────────────────────────────────────────────────

const ALLOWED_REMOTE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "show",
  "get-url",
  "-v",
  "--verbose",
]);

function validateGitRemote(args: string[]): string | null {
  const subSub = args[args.indexOf("remote") + 1];
  if (!subSub) return null;
  if (!ALLOWED_REMOTE_SUBCOMMANDS.has(subSub)) {
    return `"git remote ${subSub}" is not allowed — only read-only operations (show, get-url, -v) are permitted`;
  }
  return null;
}

// ── config ─────────────────────────────────────────────────────────────────

const ALLOWED_GIT_CONFIG_READ_MODES: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
]);

function validateGitConfig(args: string[]): string | null {
  let i = 1;
  let mode: string | undefined;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith("-")) break;
    if (arg === "--show-origin") {
      i += 1;
      continue;
    }
    if (ALLOWED_GIT_CONFIG_READ_MODES.has(arg)) {
      mode = arg;
      i += 1;
      break;
    }
    return `"git config ${arg}" is not allowed — only read-only --get lookups are permitted`;
  }
  if (!mode) {
    return '"git config" is not allowed — only read-only --get lookups are permitted';
  }
  if (i >= args.length) return `"git config ${mode}" requires a key or pattern`;
  for (; i < args.length; i += 1) {
    if (args[i].startsWith("-")) {
      return `"git config ${args[i]}" is not allowed — only read-only --get lookups are permitted`;
    }
  }
  return null;
}

// ── check-ignore ───────────────────────────────────────────────────────────

const ALLOWED_GIT_CHECK_IGNORE_FLAGS: ReadonlySet<string> = new Set([
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "-n",
  "--non-matching",
]);

function validateGitCheckIgnore(args: string[]): string | null {
  let sawPath = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (!ALLOWED_GIT_CHECK_IGNORE_FLAGS.has(arg)) {
        return `"git check-ignore ${arg}" is not allowed — only direct path lookups are permitted`;
      }
      continue;
    }
    sawPath = true;
  }
  return sawPath ? null : '"git check-ignore" requires at least one path';
}

// ── symbolic-ref ───────────────────────────────────────────────────────────

const ALLOWED_GIT_SYMBOLIC_REF_FLAGS: ReadonlySet<string> = new Set(["--short", "-q", "--quiet"]);

function validateGitSymbolicRef(args: string[]): string | null {
  const refs: string[] = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (!ALLOWED_GIT_SYMBOLIC_REF_FLAGS.has(arg)) {
        return `"git symbolic-ref ${arg}" is not allowed — only read-only ref lookups are permitted`;
      }
      continue;
    }
    refs.push(arg);
  }
  return refs.length === 1 ? null : '"git symbolic-ref" only allows reading a single symbolic ref';
}

// ── push ───────────────────────────────────────────────────────────────────

const ALLOWED_PUSH_FLAGS: ReadonlySet<string> = new Set([
  "-u",
  "--set-upstream",
  "--no-verify",
  "--dry-run",
  "-n",
  "--verbose",
  "-v",
  "--quiet",
  "-q",
]);

const PROTECTED_PUSH_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

function resolveGitPushArgs(args: string[], cwd?: string): ResolvedGitArgs {
  let i = 1; // skip "push"
  const flags: string[] = [];
  let sawRemote = false;
  let remote: string | undefined;
  const refspecs: string[] = [];
  while (i < args.length) {
    const arg = args[i];
    if (ALLOWED_PUSH_FLAGS.has(arg)) {
      flags.push(arg);
      i += 1;
    } else if (arg.startsWith("-")) {
      return { error: `"git push ${arg}" is not allowed — unrecognized flag` };
    } else if (!sawRemote) {
      sawRemote = true;
      remote = arg;
      i += 1;
    } else {
      refspecs.push(arg);
      i += 1;
    }
  }

  if (!sawRemote) {
    const implicit = resolveImplicitPushTarget(cwd, "git push");
    if ("error" in implicit) return implicit;
    remote = implicit.remote;
    refspecs.push(implicit.refspec);
  } else if (remote !== "origin") {
    return { error: `"git push ${remote}" is not allowed — only pushing to "origin" is permitted` };
  }

  if (refspecs.length === 0) {
    const implicit = resolveImplicitPushTarget(cwd, "git push origin");
    if ("error" in implicit) return implicit;
    refspecs.push(implicit.refspec);
  }

  for (const refspec of refspecs) {
    const err = validatePushRefspec(refspec);
    if (err) return { error: err };
  }

  return { args: ["push", ...flags, remote ?? "origin", ...refspecs] };
}

function validatePushRefspec(refspec: string): string | null {
  if (refspec.startsWith("+")) {
    return `"git push ${refspec}" is not allowed — leading "+" force-updates via refspec are blocked`;
  }

  const colonIdx = refspec.indexOf(":");
  if (colonIdx < 0) {
    if (refspec === "HEAD") {
      return `"git push ${refspec}" is not allowed — refspec must target an explicit destination branch`;
    }
    const branch = refspec.startsWith("refs/heads/")
      ? refspec.slice("refs/heads/".length)
      : refspec;
    if (PROTECTED_PUSH_BRANCHES.has(branch)) {
      return `"git push ${refspec}" is not allowed — pushing to protected branch "${branch}" is blocked`;
    }
    return null;
  }

  const src = refspec.slice(0, colonIdx);
  const dst = refspec.slice(colonIdx + 1);

  if (src !== "HEAD") {
    return `"git push ${refspec}" is not allowed — mapped refspec source must be "HEAD"`;
  }
  if (!dst.startsWith("refs/heads/") || dst.length <= "refs/heads/".length) {
    return `"git push ${refspec}" is not allowed — mapped refspec destination must be "refs/heads/<branch>"`;
  }
  if (dst.includes(":")) {
    return `"git push ${refspec}" is not allowed — mapped refspec destination must not contain ":"`;
  }
  const dstBranch = dst.slice("refs/heads/".length);
  if (PROTECTED_PUSH_BRANCHES.has(dstBranch)) {
    return `"git push ${refspec}" is not allowed — pushing to protected branch "${dstBranch}" is blocked`;
  }
  return null;
}

function resolveImplicitPushTarget(
  cwd: string | undefined,
  commandLabel: "git push" | "git push origin",
): ResolvedGitArgsFailure | ResolvedImplicitPushTarget {
  if (!cwd) {
    return {
      error:
        commandLabel === "git push"
          ? '"git push" is not allowed — must explicitly specify remote "origin"'
          : '"git push origin" is not allowed — must include an explicit branch or refspec',
    };
  }

  const currentBranch = readGitOutput(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    `"${commandLabel}" is not allowed — implicit push requires a checked-out branch`,
  );
  if ("error" in currentBranch) return currentBranch;

  const remote = readGitOutput(
    cwd,
    ["config", "--local", "--get", `branch.${currentBranch.value}.remote`],
    `"${commandLabel}" is not allowed — current branch must have an upstream on "origin" or specify an explicit target`,
  );
  if ("error" in remote) return remote;

  if (remote.value !== "origin") {
    return {
      error: `"${commandLabel}" is not allowed — current branch upstream must use "origin"`,
    };
  }

  const mergeRef = readGitOutput(
    cwd,
    ["config", "--local", "--get", `branch.${currentBranch.value}.merge`],
    `"${commandLabel}" is not allowed — current branch must have an upstream branch or specify an explicit target`,
  );
  if ("error" in mergeRef) return mergeRef;

  if (!mergeRef.value.startsWith("refs/heads/") || mergeRef.value.length <= "refs/heads/".length) {
    return {
      error: `"${commandLabel}" is not allowed — upstream branch must resolve to "refs/heads/<branch>"`,
    };
  }

  return { remote: "origin", refspec: `HEAD:${mergeRef.value}` };
}

function readGitOutput(
  cwd: string,
  gitArgs: string[],
  failureMessage: string,
): { value: string } | ResolvedGitArgsFailure {
  try {
    const value = execFileSync("/usr/bin/git", gitArgs, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return value ? { value } : { error: failureMessage };
  } catch {
    return { error: failureMessage };
  }
}
