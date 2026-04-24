/**
 * gh policy — explicit allowlist of Thor-supported workflows.
 *
 * The policy is intentionally small: read-only commands are allowed by command
 * tuple, mutating commands must match exact non-interactive templates, and
 * every denied shape points the user at the `using-gh` skill.
 */

import { booleanFlagCount, scanPolicyArgs, valueFlagValues } from "./policy-args.js";
import { isPathUnderCwd } from "./policy-paths.js";

const USING_GH_HINT = "Load skill using-gh for the supported command patterns.";
const DIGITS_ONLY = /^\d+$/;

const ALLOWED_GH_COMMANDS: ReadonlySet<string> = new Set([
  "api",
  "auth status",
  "cache list",
  "search prs",
  "search issues",
  "search repos",
  "search code",
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

export function validateGhArgs(args: string[], cwd?: string): string | null {
  if (!Array.isArray(args)) return "args must be an array";
  if (args.length === 0) return null;

  if (matchesExactArgs(args, ["--version"])) return null;
  if (isHelpRequest(args)) return null;

  const command = ghCommandLabel(args);
  if (hasRepoOverride(args)) return denyMessage(command);

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
      return validateGhCommentArgs(args, "gh pr comment", { supportBodyFile: true, cwd });
    case "pr review":
      return validateGhPrReviewArgs(args);
    case "issue view":
      return validateRequiredNumericSelector(args, "gh issue view");
    case "issue comment":
      return validateGhCommentArgs(args, "gh issue comment", { supportBodyFile: false });
    case "issue create":
      return validateGhIssueCreateArgs(args);
    case "run view":
      return validateRequiredNumericSelector(args, "gh run view");
    case "run watch":
      return validateRequiredNumericSelector(args, "gh run watch");
    case "run rerun":
      return validateGhRunRerunArgs(args);
    case "run download":
      return validateGhRunDownloadArgs(args, cwd);
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

function denyMessage(command: string): string {
  return `"${command}" is not allowed. ${USING_GH_HINT}`;
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

function validateGhPrCreateArgs(args: string[], cwd: string | undefined): string | null {
  const parsed = scanPolicyArgs(args, 2, [
    { name: "draft", kind: "boolean", aliases: ["--draft"] },
    { name: "fill", kind: "boolean", aliases: ["--fill"] },
    { name: "title", kind: "value", aliases: ["-t", "--title"] },
    { name: "body", kind: "value", aliases: ["-b", "--body"] },
    { name: "body-file", kind: "value", aliases: ["-F", "--body-file"] },
    { name: "base", kind: "value", aliases: ["-B", "--base"] },
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
  const fill = booleanFlagCount(parsed, "fill") > 0;

  // --fill is mutually exclusive with explicit title/body/-F.
  if (fill && (titles.length > 0 || bodies.length > 0 || bodyFiles.length > 0)) {
    return denyMessage("gh pr create");
  }
  // --body and -F are mutually exclusive.
  if (bodies.length > 0 && bodyFiles.length > 0) {
    return denyMessage("gh pr create");
  }
  if (bodyFiles.length > 1) return denyMessage("gh pr create");
  if (bodyFiles.length === 1 && !isPathUnderCwd(bodyFiles[0], cwd)) {
    return denyMessage("gh pr create");
  }

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

type CommentOpts = { supportBodyFile: false } | { supportBodyFile: true; cwd: string | undefined };

function validateGhCommentArgs(
  args: string[],
  command: "gh pr comment" | "gh issue comment",
  opts: CommentOpts,
): string | null {
  const selector = args[2];
  if (!selector || !DIGITS_ONLY.test(selector)) {
    return denyMessage(command);
  }

  const flags: Parameters<typeof scanPolicyArgs>[2] = opts.supportBodyFile
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
  const bodyFiles = opts.supportBodyFile ? valueFlagValues(parsed, "body-file") : [];

  if (bodies.length > 0 && bodyFiles.length > 0) return denyMessage(command);
  if (bodyFiles.length > 1) return denyMessage(command);
  if (opts.supportBodyFile && bodyFiles.length === 1 && !isPathUnderCwd(bodyFiles[0], opts.cwd)) {
    return denyMessage(command);
  }

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

function validateGhRunDownloadArgs(args: string[], cwd: string | undefined): string | null {
  // `gh run download <id> [--dir <path>] [--name <n>]... [--pattern <p>]...`.
  // --dir must resolve under cwd; --name / --pattern / -p are repeatable filters.
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
  const dirs = valueFlagValues(parsed, "dir");
  if (dirs.length > 1) return denyMessage("gh run download");
  if (dirs.length === 1 && !isPathUnderCwd(dirs[0], cwd)) {
    return denyMessage("gh run download");
  }
  return null;
}

function validateGhWorkflowRunArgs(args: string[]): string | null {
  // `gh workflow run <selector> [--ref <branch>] [-f key=value]...`. The selector
  // is a workflow file name or numeric ID — no flags, no URLs. `-F name=@file` is
  // not allowed (it would read from a local file); only string-value `-f` pairs.
  if (args.length < 3 || args[2].startsWith("-")) {
    return denyMessage("gh workflow run");
  }
  const parsed = scanPolicyArgs(args, 3, [
    { name: "ref", kind: "value", aliases: ["--ref", "-r"] },
    { name: "field", kind: "value", aliases: ["-f", "--raw-field"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage("gh workflow run");
  }
  if (valueFlagValues(parsed, "ref").length > 1) return denyMessage("gh workflow run");
  for (const kv of valueFlagValues(parsed, "field")) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*=/.test(kv) || kv.includes("=@")) {
      return denyMessage("gh workflow run");
    }
  }
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
