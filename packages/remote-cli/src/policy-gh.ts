/**
 * gh policy — explicit allowlist of Thor-supported workflows.
 *
 * The policy is intentionally small: read-only commands are allowed by command
 * tuple, mutating commands must match exact non-interactive templates, and
 * every denied shape points the user at the `using-gh` skill.
 */

import { booleanFlagCount, scanPolicyArgs, valueFlagValues } from "./policy-args.js";

const USING_GH_HINT = "Load skill using-gh for the supported command patterns.";

const ALLOWED_GH_COMMANDS: ReadonlySet<string> = new Set([
  "api",
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
  "workflow list",
  "workflow view",
]);

const HELP_FLAGS: ReadonlySet<string> = new Set(["-h", "--help"]);

export function validateGhArgs(args: string[], _cwd?: string): string | null {
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
      return validateGhPrCreateArgs(args);
    case "pr comment":
      return validateGhCommentArgs(args, "gh pr comment");
    case "pr review":
      return validateGhPrReviewArgs(args);
    case "issue view":
      return validateRequiredNumericSelector(args, "gh issue view");
    case "issue comment":
      return validateGhCommentArgs(args, "gh issue comment");
    case "run view":
      return validateRequiredNumericSelector(args, "gh run view");
    case "run watch":
      return validateRequiredNumericSelector(args, "gh run watch");
    case "workflow view":
      return validateWorkflowViewArgs(args);
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
  return args.length >= 3 && /^\d+$/.test(args[2]) ? null : denyMessage(command);
}

function validateWorkflowViewArgs(args: string[]): string | null {
  if (args.length < 3 || args[2].startsWith("-")) {
    return denyMessage("gh workflow view");
  }
  return null;
}

function validateGhPrCreateArgs(args: string[]): string | null {
  const parsed = scanPolicyArgs(args, 2, [
    { name: "draft", kind: "boolean", aliases: ["--draft"] },
    { name: "title", kind: "value", aliases: ["-t", "--title"] },
    { name: "body", kind: "value", aliases: ["-b", "--body"] },
    { name: "base", kind: "value", aliases: ["-B", "--base"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage("gh pr create");
  }

  return valueFlagValues(parsed, "title").length > 0 && valueFlagValues(parsed, "body").length > 0
    ? null
    : denyMessage("gh pr create");
}

function validateGhCommentArgs(
  args: string[],
  command: "gh pr comment" | "gh issue comment",
): string | null {
  const selector = args[2];
  if (!selector || !/^\d+$/.test(selector)) {
    return denyMessage(command);
  }

  const parsed = scanPolicyArgs(args, 3, [
    { name: "body", kind: "value", aliases: ["-b", "--body"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) {
    return denyMessage(command);
  }

  return valueFlagValues(parsed, "body").length > 0 ? null : denyMessage(command);
}

function validateGhPrReviewArgs(args: string[]): string | null {
  let i = 2;
  if (i < args.length && !args[i].startsWith("-")) {
    if (!/^\d+$/.test(args[i])) {
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

function validateGhApiArgs(args: string[]): string | null {
  const endpoint = args[1];
  if (!endpoint || endpoint.startsWith("-") || endpoint === "graphql") {
    return denyMessage("gh api");
  }

  const parsed = scanPolicyArgs(args, 2, [
    { name: "include", kind: "boolean", aliases: ["--include", "-i"] },
    { name: "silent", kind: "boolean", aliases: ["--silent"] },
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
