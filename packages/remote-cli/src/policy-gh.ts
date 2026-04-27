/**
 * gh policy — explicit allowlist of Thor-supported workflows.
 *
 * The policy is intentionally small: read-only commands are allowed by command
 * tuple, mutating commands must match exact non-interactive templates, and
 * every denied shape points the user at the `using-gh` skill.
 */

import { normalize as normalizePosix } from "node:path/posix";
import { booleanFlagCount, scanPolicyArgs, valueFlagValues } from "./policy-args.js";

interface DenyGuidance {
  reason: string;
  instead?: string;
}

const USING_GH_HINT = "Load skill using-gh for the supported command patterns.";
const DIGITS_ONLY = /^\d+$/;
const PROTECTED_PR_HEAD_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);
const WORKTREE_PREFIX = "/workspace/worktrees/";

const ALLOWED_GH_COMMANDS: ReadonlySet<string> = new Set([
  "api",
  "auth status",
  "cache list",
  "search prs",
  "search issues",
  "search repos",
  "search code",
  "pr view",
  "pr list",
  "pr status",
  "pr checks",
  "pr create",
  "pr comment",
  "pr review",
  "issue view",
  "issue list",
  "issue comment",
  "issue create",
  "label list",
  "release list",
  "release view",
  "repo view",
  "run list",
  "run view",
  "run watch",
  "run rerun",
  "run download",
  "workflow list",
  "workflow view",
  "workflow run",
]);

const HELP_FLAGS: ReadonlySet<string> = new Set(["-h", "--help"]);

const DEFAULT_GH_DENY_GUIDANCE: DenyGuidance = {
  reason: "this command shape is outside Thor's allowed gh workflows.",
};

const REPO_OVERRIDE_DENY_GUIDANCE: DenyGuidance = {
  reason: "repo-targeting flags are blocked so writes and auth stay scoped to the current repo.",
  instead: "cd into the intended repo or worktree and rerun the command without -R or --repo",
};

const GH_DENY_GUIDANCE: Readonly<Record<string, DenyGuidance>> = {
  "gh auth status": {
    reason: "only auth status inspection is allowed; login/logout/token mutation is blocked.",
    instead: "gh auth status",
  },
  "gh pr checkout": {
    reason: "pr checkout would switch the current worktree branch.",
    instead:
      "git fetch origin pull/<N>/head:pr-<N> && git worktree add /workspace/worktrees/<repo>/pr-<N> pr-<N>",
  },
  "gh pr diff": {
    reason:
      "PR review should happen from a fetched worktree so tests and code search are available.",
    instead:
      "git fetch origin pull/<N>/head:pr-<N> && git worktree add /workspace/worktrees/<repo>/pr-<N> pr-<N>",
  },
  "gh pr create": {
    reason:
      "PR creation is limited to the current worktree branch and one non-interactive body source.",
    instead:
      "gh pr create --title <title> --body <body> or gh pr create --fill; omit --head unless it matches the current worktree branch",
  },
  "gh issue create": {
    reason: "issue creation must be non-interactive and include a title plus body.",
    instead: "gh issue create --title <title> --body <body>",
  },
  "gh pr comment": {
    reason: "PR comments must target a numeric PR and provide exactly one body source.",
    instead: "gh pr comment <number> --body <text> or gh pr comment <number> -F <path>",
  },
  "gh issue comment": {
    reason: "issue comments must target a numeric issue and provide an inline body.",
    instead: "gh issue comment <number> --body <text>",
  },
  "gh pr review": {
    reason: "reviews must be append-only comments or request-changes reviews with an inline body.",
    instead: "gh pr review <number> --comment --body <text>",
  },
  "gh run rerun": {
    reason: "run rerun requires a numeric run ID and only supports --failed and --debug.",
    instead: "gh run rerun <run-id> [--failed] [--debug]",
  },
  "gh run download": {
    reason: "run download requires a numeric run ID and only supports artifact filter flags.",
    instead: "gh run download <run-id> [--dir <path>] [--name <artifact>]",
  },
  "gh workflow view": {
    reason: "workflow view requires a workflow selector.",
    instead: "gh workflow view <workflow>",
  },
  "gh workflow run": {
    reason: "workflow dispatch requires a workflow selector and at most one ref.",
    instead: "gh workflow run <workflow> [--ref <branch>] [-f key=value]",
  },
  "gh release view": {
    reason: "release view requires a tag or latest selector.",
    instead: "gh release view <tag|latest>",
  },
  "gh release download": {
    reason:
      "release download has local filesystem side effects and is outside Thor's release surface.",
    instead: "gh release view <tag|latest>",
  },
  "gh api": {
    reason:
      "gh api is limited to implicit GET requests against REST endpoints with output-shaping flags only.",
    instead: "gh api <endpoint> --jq <filter> or use a first-class gh read command",
  },
};

export function validateGhArgs(args: string[], cwd?: string): string | null {
  if (!Array.isArray(args)) return "args must be an array";
  if (args.length === 0) return null;

  if (matchesExactArgs(args, ["--version"])) return null;
  if (isHelpRequest(args)) return null;

  const command = ghCommandLabel(args);
  if (hasRepoOverride(args)) return denyMessage(command, REPO_OVERRIDE_DENY_GUIDANCE);

  const key = ghCommandKey(args);
  if (!key || !ALLOWED_GH_COMMANDS.has(key)) {
    return denyMessage(command);
  }

  switch (key) {
    case "api":
      return validateGhApiArgs(args);
    case "auth status":
      return matchesExactArgs(args, ["auth", "status"]) ? null : denyMessage("gh auth status");
    case "pr create":
      return validateGhPrCreateArgs(args, cwd);
    case "pr comment":
      return validateGhCommentArgs(args, "gh pr comment", true);
    case "pr review":
      return validateGhPrReviewArgs(args);
    case "issue view":
      return validateRequiredNumericSelector(args, "gh issue view");
    case "issue comment":
      return validateGhCommentArgs(args, "gh issue comment", false);
    case "issue create":
      return validateGhIssueCreateArgs(args);
    case "run view":
      return validateRequiredNumericSelector(args, "gh run view");
    case "run watch":
      return validateRequiredNumericSelector(args, "gh run watch");
    case "run rerun":
      return validateGhRunRerunArgs(args);
    case "run download":
      return validateGhRunDownloadArgs(args);
    case "workflow view":
      return validateWorkflowViewArgs(args);
    case "workflow run":
      return validateGhWorkflowRunArgs(args);
    case "release view":
      return validateReleaseViewArgs(args);
    default:
      return null;
  }
}

function isHelpRequest(args: string[]): boolean {
  if (args[0] === "help") return true;
  if (args.length === 1 && HELP_FLAGS.has(args[0])) return true;
  if (args.length === 2 && HELP_FLAGS.has(args[1])) return true;
  if (args.length === 3 && HELP_FLAGS.has(args[2])) return true;
  return false;
}

function hasRepoOverride(args: string[]): boolean {
  return args.some(
    (arg) => arg === "-R" || arg.startsWith("-R") || arg === "--repo" || arg.startsWith("--repo="),
  );
}

function ghCommandKey(args: string[]): string | undefined {
  if (args[0] === "api") return "api";
  if (args.length < 2 || args[1].startsWith("-")) return undefined;
  return `${args[0]} ${args[1]}`;
}

function ghCommandLabel(args: string[]): string {
  if (args[0] === "help") {
    return args.length > 1 ? `gh help ${args[1]}` : "gh help";
  }
  if (args[0] === "api") return "gh api";
  if (args.length >= 2 && !args[1].startsWith("-")) return `gh ${args[0]} ${args[1]}`;
  return `gh ${args[0]}`;
}

function denyMessage(command: string, guidance?: DenyGuidance): string {
  const details = guidance ?? GH_DENY_GUIDANCE[command] ?? DEFAULT_GH_DENY_GUIDANCE;
  const lines = [`"${command}" is not allowed.`, `Reason: ${details.reason}`];
  if (details.instead) lines.push(`Try instead: ${details.instead}`);
  lines.push(`Details: ${USING_GH_HINT}`);
  return lines.join("\n");
}

function validateRequiredNumericSelector(args: string[], command: string): string | null {
  return args.length >= 3 && DIGITS_ONLY.test(args[2]) ? null : denyMessage(command);
}

function validateWorkflowViewArgs(args: string[]): string | null {
  if (args.length < 3 || args[2].startsWith("-")) {
    return denyMessage("gh workflow view");
  }
  return null;
}

function validateReleaseViewArgs(args: string[]): string | null {
  if (args.length < 3 || args[2].startsWith("-")) {
    return denyMessage("gh release view");
  }
  return null;
}

function validateGhPrCreateArgs(args: string[], cwd?: string): string | null {
  const parsed = scanPolicyArgs(args, 2, [
    { name: "draft", kind: "boolean", aliases: ["--draft"] },
    { name: "fill", kind: "boolean", aliases: ["--fill"] },
    { name: "title", kind: "value", aliases: ["-t", "--title"] },
    { name: "body", kind: "value", aliases: ["-b", "--body"] },
    { name: "body-file", kind: "value", aliases: ["-F", "--body-file"] },
    { name: "base", kind: "value", aliases: ["-B", "--base"] },
    { name: "head", kind: "value", aliases: ["-H", "--head"] },
    { name: "label", kind: "value", aliases: ["-l", "--label"] },
    { name: "assignee", kind: "value", aliases: ["-a", "--assignee"] },
    { name: "reviewer", kind: "value", aliases: ["-r", "--reviewer"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage("gh pr create");
  }

  const titles = valueFlagValues(parsed, "title");
  const bodies = valueFlagValues(parsed, "body");
  const bodyFiles = valueFlagValues(parsed, "body-file");
  const heads = valueFlagValues(parsed, "head");
  const fill = booleanFlagCount(parsed, "fill") > 0;

  // --head must match the branch implied by cwd. The cwd is the agent's worktree
  // (/workspace/worktrees/<repo>/<branch>), so the branch it would PR from
  // implicitly is fixed. Allowing --head only when it equals that same branch
  // makes it the explicit form of the default — no way to PR from a different
  // branch, fork, or protected branch via --head. Cross-fork (`<owner>:<branch>`)
  // and protected branches (main/master) fall out as side effects.
  if (heads.length > 1) {
    return denyMessage("gh pr create", {
      reason: "multiple --head values are ambiguous.",
      instead:
        "provide at most one --head value, or omit --head and use the current worktree branch",
    });
  }
  if (heads.length === 1) {
    const head = heads[0];
    if (!head || head.startsWith("-")) {
      return denyMessage("gh pr create", {
        reason: `--head "${head}" is not a valid branch value.`,
        instead: "omit --head and use the current worktree branch",
      });
    }
    if (PROTECTED_PR_HEAD_BRANCHES.has(head)) {
      return denyMessage("gh pr create", {
        reason: `--head "${head}" targets a protected branch.`,
        instead: "create the PR from a feature worktree branch instead",
      });
    }
    if (head.includes(":")) {
      return denyMessage("gh pr create", {
        reason: `--head "${head}" uses a cross-fork selector, which Thor blocks.`,
        instead: "cd into the local branch worktree and omit --head",
      });
    }

    const cwdBranch = branchFromCwd(cwd);
    if (!cwdBranch) {
      return denyMessage("gh pr create", {
        reason: `--head "${head}" cannot be checked because cwd is not a branch worktree.`,
        instead: "cd into /workspace/worktrees/<repo>/<branch> or omit --head",
      });
    }
    if (head !== cwdBranch) {
      return denyMessage("gh pr create", {
        reason: `--head "${head}" does not match cwd branch "${cwdBranch}".`,
        instead: `cd into /workspace/worktrees/<repo>/${head} or omit --head`,
      });
    }
  }

  // --fill is mutually exclusive with explicit title/body/-F.
  if (fill && (titles.length > 0 || bodies.length > 0 || bodyFiles.length > 0)) {
    return denyMessage("gh pr create");
  }
  // --body and -F are mutually exclusive.
  if (bodies.length > 0 && bodyFiles.length > 0) {
    return denyMessage("gh pr create");
  }
  if (bodyFiles.length > 1) return denyMessage("gh pr create");

  if (fill) return null;

  const hasBodySource = bodies.length > 0 || bodyFiles.length > 0;
  return titles.length > 0 && hasBodySource ? null : denyMessage("gh pr create");
}

function validateGhIssueCreateArgs(args: string[]): string | null {
  const parsed = scanPolicyArgs(args, 2, [
    { name: "title", kind: "value", aliases: ["-t", "--title"] },
    { name: "body", kind: "value", aliases: ["-b", "--body"] },
    { name: "label", kind: "value", aliases: ["-l", "--label"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage("gh issue create");
  }
  return valueFlagValues(parsed, "title").length > 0 && valueFlagValues(parsed, "body").length > 0
    ? null
    : denyMessage("gh issue create");
}

function validateGhCommentArgs(
  args: string[],
  command: "gh pr comment" | "gh issue comment",
  supportBodyFile: boolean,
): string | null {
  const selector = args[2];
  if (!selector || !DIGITS_ONLY.test(selector)) {
    return denyMessage(command);
  }

  const flags: Parameters<typeof scanPolicyArgs>[2] = supportBodyFile
    ? [
        { name: "body", kind: "value", aliases: ["-b", "--body"] },
        { name: "body-file", kind: "value", aliases: ["-F", "--body-file"] },
      ]
    : [{ name: "body", kind: "value", aliases: ["-b", "--body"] }];

  const parsed = scanPolicyArgs(args, 3, flags);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage(command);
  }

  const bodies = valueFlagValues(parsed, "body");
  const bodyFiles = supportBodyFile ? valueFlagValues(parsed, "body-file") : [];

  if (bodies.length > 0 && bodyFiles.length > 0) return denyMessage(command);
  if (bodyFiles.length > 1) return denyMessage(command);

  return bodies.length > 0 || bodyFiles.length > 0 ? null : denyMessage(command);
}

function validateGhPrReviewArgs(args: string[]): string | null {
  let i = 2;
  if (i < args.length && !args[i].startsWith("-")) {
    if (!DIGITS_ONLY.test(args[i])) {
      return denyMessage("gh pr review");
    }
    i += 1;
  }

  const parsed = scanPolicyArgs(args, i, [
    { name: "comment", kind: "boolean", aliases: ["-c", "--comment"] },
    { name: "request-changes", kind: "boolean", aliases: ["-r", "--request-changes"] },
    { name: "body", kind: "value", aliases: ["-b", "--body"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage("gh pr review");
  }

  const hasComment = booleanFlagCount(parsed, "comment") > 0;
  const hasRequestChanges = booleanFlagCount(parsed, "request-changes") > 0;
  const hasBody = valueFlagValues(parsed, "body").length > 0;

  if (hasComment === hasRequestChanges || !hasBody) {
    return denyMessage("gh pr review");
  }

  return null;
}

function validateGhRunRerunArgs(args: string[]): string | null {
  // `gh run rerun <id> [--failed] [--debug]`. `--job` is intentionally omitted
  // (minimal surface) but could be added later.
  if (args.length < 3 || !DIGITS_ONLY.test(args[2])) {
    return denyMessage("gh run rerun");
  }
  const parsed = scanPolicyArgs(args, 3, [
    { name: "failed", kind: "boolean", aliases: ["--failed"] },
    { name: "debug", kind: "boolean", aliases: ["--debug"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage("gh run rerun");
  }
  return null;
}

function validateGhRunDownloadArgs(args: string[]): string | null {
  // `gh run download <id> [--dir <path>] [--name <n>]... [--pattern <p>]...`.
  // --name / --pattern / -p are repeatable filters.
  if (args.length < 3 || !DIGITS_ONLY.test(args[2])) {
    return denyMessage("gh run download");
  }
  const parsed = scanPolicyArgs(args, 3, [
    { name: "dir", kind: "value", aliases: ["-D", "--dir"] },
    { name: "name", kind: "value", aliases: ["-n", "--name"] },
    { name: "pattern", kind: "value", aliases: ["-p", "--pattern"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage("gh run download");
  }
  if (valueFlagValues(parsed, "dir").length > 1) return denyMessage("gh run download");
  return null;
}

function validateGhWorkflowRunArgs(args: string[]): string | null {
  // `gh workflow run <selector> [--ref <branch>] [-f|-F key=value]...`. The
  // selector is a workflow file name or numeric ID — no flags, no URLs.
  // Workflow inputs (`-f` raw / `-F` typed, including `key=@file`) pass through:
  // the same exfil channel exists via committing a workflow that reads files
  // and posts them, so policing the dispatch flag is friction without protection.
  if (args.length < 3 || args[2].startsWith("-")) {
    return denyMessage("gh workflow run");
  }
  const parsed = scanPolicyArgs(args, 3, [
    { name: "ref", kind: "value", aliases: ["--ref", "-r"] },
    { name: "field", kind: "value", aliases: ["-f", "--raw-field", "-F", "--field"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage("gh workflow run");
  }
  if (valueFlagValues(parsed, "ref").length > 1) return denyMessage("gh workflow run");
  return null;
}

function validateGhApiArgs(args: string[]): string | null {
  const endpoint = args[1];
  if (!endpoint || endpoint.startsWith("-") || endpoint === "graphql") {
    return denyMessage("gh api");
  }

  const parsed = scanPolicyArgs(args, 2, [
    { name: "include", kind: "boolean", aliases: ["--include", "-i"] },
    { name: "silent", kind: "boolean", aliases: ["--silent"] },
    { name: "paginate", kind: "boolean", aliases: ["--paginate"] },
    { name: "jq", kind: "value", aliases: ["--jq", "-q"] },
    { name: "template", kind: "value", aliases: ["--template", "-t"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage("gh api");
  }

  return null;
}

function matchesExactArgs(args: string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((arg, idx) => arg === expected[idx]);
}

function branchFromCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const normalized = normalizePosix(cwd);
  if (!normalized.startsWith(WORKTREE_PREFIX)) return null;
  const tail = normalized.slice(WORKTREE_PREFIX.length);
  const slash = tail.indexOf("/");
  if (slash <= 0) return null;
  const branch = tail.slice(slash + 1);
  return branch.length > 0 ? branch : null;
}
