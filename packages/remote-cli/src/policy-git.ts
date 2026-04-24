/**
 * git policy, driven by declarative command specs.
 *
 * Most subcommands are `passthrough: true` — the allowlist is the spec
 * *table*, not per-subcommand flag parsing. A small number of commands
 * (push, config, check-ignore, symbolic-ref) have structured flag shapes
 * and get real spec definitions. A few (checkout, worktree, remote) keep
 * dedicated helpers because their sub-subcommand logic doesn't fit the
 * generic flag grammar.
 */

import { execFileSync } from "node:child_process";

import {
  findSpec,
  parseAgainstSpec,
  type CommandSpec,
  type ParsedArgs,
  type ParseContext,
} from "./policy-spec.js";

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

const USING_GIT_HINT = "Load skill using-git for the full allowed surface.";
const WORKTREE_HINT =
  "use 'git worktree add <path> <ref>' to work on another branch without leaving this worktree";
const WORKTREE_PREFIX = "/workspace/worktrees/";
const PROTECTED_PUSH_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

type GitCommandSpec = CommandSpec & { noPagerSafe?: boolean };

function passthrough(name: string, opts: { noPagerSafe?: boolean } = {}): GitCommandSpec {
  return { path: [name], passthrough: true, noPagerSafe: opts.noPagerSafe };
}

// Read-only subcommands that are safe behind --no-pager.
const NO_PAGER_READ_SUBCOMMANDS = [
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
  "check-ref-format",
];

// Other allowlisted subcommands — not safe under --no-pager (writes or
// commands that don't paginate). Must stay in sync with the previous
// ALLOWED_GIT_SUBCOMMANDS surface.
const OTHER_PASSTHROUGH_SUBCOMMANDS = [
  "branch",
  "tag",
  "stash",
  "submodule",
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
  "fetch",
  "pull",
  "version",
];

// ── specialized specs ──────────────────────────────────────────────────────

const PUSH_SPEC: GitCommandSpec = {
  path: ["push"],
  flags: {
    "--set-upstream": { kind: "bool" },
    "--no-verify": { kind: "bool" },
    "--dry-run": { kind: "bool" },
    "--verbose": { kind: "bool" },
    "--quiet": { kind: "bool" },
  },
  aliases: { "-u": "--set-upstream", "-n": "--dry-run", "-v": "--verbose", "-q": "--quiet" },
  positional: { min: 0, max: 10 },
  unknownFlagHint: (flag) => `"git push ${flag}" is not allowed — unrecognized flag`,
  rewrite: (parsed, originalArgs, ctx) => resolvePushRewrite(parsed, originalArgs, ctx),
};

const CONFIG_SPEC: GitCommandSpec = {
  path: ["config"],
  noPagerSafe: true,
  flags: {
    "--get": { kind: "bool" },
    "--get-all": { kind: "bool" },
    "--get-regexp": { kind: "bool" },
    "--show-origin": { kind: "bool" },
  },
  requireOneOf: {
    flags: ["--get", "--get-all", "--get-regexp"],
    hint: '"git config" is not allowed — only read-only --get lookups are permitted',
  },
  positional: {
    min: 1,
    max: 2, // key + optional value-regex (e.g. --get-regexp pattern value-pattern)
  },
  missingPositionalHint: '"git config" requires a key or pattern',
  unknownFlagHint: (flag) =>
    `"git config ${flag}" is not allowed — only read-only --get lookups are permitted`,
};

const CHECK_IGNORE_SPEC: GitCommandSpec = {
  path: ["check-ignore"],
  noPagerSafe: true,
  flags: {
    "--quiet": { kind: "bool" },
    "--verbose": { kind: "bool" },
    "--non-matching": { kind: "bool" },
  },
  aliases: { "-q": "--quiet", "-v": "--verbose", "-n": "--non-matching" },
  positional: { min: 1, max: 1000 },
  missingPositionalHint: '"git check-ignore" requires at least one path',
  unknownFlagHint: (flag) =>
    `"git check-ignore ${flag}" is not allowed — only direct path lookups are permitted`,
};

const SYMBOLIC_REF_SPEC: GitCommandSpec = {
  path: ["symbolic-ref"],
  noPagerSafe: true,
  flags: {
    "--short": { kind: "bool" },
    "--quiet": { kind: "bool" },
  },
  aliases: { "-q": "--quiet" },
  positional: { min: 1, max: 1 },
  missingPositionalHint: '"git symbolic-ref" only allows reading a single symbolic ref',
  extraPositionalHint: '"git symbolic-ref" only allows reading a single symbolic ref',
  unknownFlagHint: (flag) =>
    `"git symbolic-ref ${flag}" is not allowed — only read-only ref lookups are permitted`,
};

const WORKTREE_SPEC: GitCommandSpec = {
  path: ["worktree"],
  passthrough: true,
  postValidate: (parsed) => {
    const subSub = parsed.positional[0];
    if (subSub === "add") {
      const path = findWorktreePath(parsed.positional.slice(1));
      if (!path) return '"git worktree add" requires a path';
      const normalized = normalizePath(path);
      if (!normalized.startsWith(WORKTREE_PREFIX)) {
        return `worktree path must be under ${WORKTREE_PREFIX}`;
      }
    }
    return null;
  },
};

const REMOTE_SPEC: GitCommandSpec = {
  path: ["remote"],
  noPagerSafe: true,
  passthrough: true,
  postValidate: (parsed) => {
    const subSub = parsed.positional[0];
    if (!subSub) return null; // bare "git remote" is OK
    const ALLOWED: ReadonlySet<string> = new Set(["show", "get-url", "-v", "--verbose"]);
    if (!ALLOWED.has(subSub)) {
      return `"git remote ${subSub}" is not allowed — only read-only operations (show, get-url, -v) are permitted`;
    }
    return null;
  },
};

// ── spec table ─────────────────────────────────────────────────────────────

export const GIT_SPECS: readonly GitCommandSpec[] = [
  ...NO_PAGER_READ_SUBCOMMANDS.map((n) => passthrough(n, { noPagerSafe: true })),
  ...OTHER_PASSTHROUGH_SUBCOMMANDS.map((n) => passthrough(n)),
  PUSH_SPEC,
  CONFIG_SPEC,
  CHECK_IGNORE_SPEC,
  SYMBOLIC_REF_SPEC,
  WORKTREE_SPEC,
  REMOTE_SPEC,
];

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

  // Inline worktree-redirect hints for the miss patterns every agent hits.
  // Targeted hints stay in prose so the first round-trip gets actionable
  // guidance; everything else points at the skill.
  if (first === "switch") {
    return { error: `"git switch" is not allowed — ${WORKTREE_HINT}` };
  }
  if (first === "checkout") {
    const err = validateGitCheckoutRestore(args);
    return err ? { error: err } : { args: [...args] };
  }

  const spec = findSpec(GIT_SPECS, args);
  if (!spec) {
    return { error: `"git ${first}" is not allowed. ${USING_GIT_HINT}` };
  }

  const afterPath = args.slice(spec.path.length);
  const ctx: ParseContext = { cwd };
  const parsed = parseAgainstSpec(afterPath, spec, ctx);
  if (!parsed.ok) return { error: parsed.error };

  if (spec.rewrite) {
    const r = spec.rewrite(parsed.parsed, args, ctx);
    if (!Array.isArray(r)) return r;
    return { args: r };
  }

  return { args: [...args] };
}

export function validateGitArgs(args: string[], cwd?: string): string | null {
  const resolved = resolveGitArgs(args, cwd);
  return "error" in resolved ? resolved.error : null;
}

// ── --no-pager handling ────────────────────────────────────────────────────

function resolveNoPager(args: string[], cwd?: string): ResolvedGitArgs {
  const inner = args.slice(1);
  if (inner.length === 0) {
    return { error: '"git --no-pager" requires a subcommand' };
  }

  const sub = inner[0];
  const spec = findSpec(GIT_SPECS, inner) as GitCommandSpec | undefined;

  if (!spec || !spec.noPagerSafe) {
    return {
      error: `"git --no-pager ${sub}" is not allowed — only read-only commands may use --no-pager`,
    };
  }

  const innerResolved = resolveGitArgs(inner, cwd);
  if ("error" in innerResolved) return innerResolved;
  return { args: ["--no-pager", ...innerResolved.args] };
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
    // After `--`, git grammar guarantees every remaining token is a pathspec.
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

// ── worktree / push helpers ────────────────────────────────────────────────

function findWorktreePath(tokens: string[]): string | null {
  const flagsWithValue = new Set(["-b", "-B"]);
  let i = 0;
  while (i < tokens.length) {
    const arg = tokens[i];
    if (flagsWithValue.has(arg)) {
      i += 2;
    } else if (arg.startsWith("-")) {
      i += 1;
    } else {
      return arg;
    }
  }
  return null;
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

function resolvePushRewrite(
  parsed: ParsedArgs,
  originalArgs: string[],
  ctx: ParseContext,
): string[] | { error: string } {
  const positional = parsed.positional;
  let remote: string | undefined = positional[0];
  const refspecs: string[] = positional.slice(1);

  if (remote === undefined) {
    const implicit = resolveImplicitPushTarget(ctx.cwd, "git push");
    if ("error" in implicit) return implicit;
    remote = implicit.remote;
    refspecs.push(implicit.refspec);
  } else if (remote !== "origin") {
    return { error: `"git push ${remote}" is not allowed — only pushing to "origin" is permitted` };
  }

  if (refspecs.length === 0) {
    const implicit = resolveImplicitPushTarget(ctx.cwd, "git push origin");
    if ("error" in implicit) return implicit;
    refspecs.push(implicit.refspec);
  }

  for (const refspec of refspecs) {
    const err = validatePushRefspec(refspec);
    if (err) return { error: err };
  }

  // Preserve the user's original flag tokens (order and canonical form) by
  // walking originalArgs and keeping only tokens that look like flags.
  const flagTokens: string[] = [];
  for (let i = 1; i < originalArgs.length; i += 1) {
    const t = originalArgs[i];
    if (t.startsWith("-")) flagTokens.push(t);
  }

  return ["push", ...flagTokens, remote, ...refspecs];
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
