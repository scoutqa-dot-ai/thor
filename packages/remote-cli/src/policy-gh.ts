/**
 * gh policy — explicit allowlist of Thor-supported workflows.
 *
 * The policy is intentionally small: read-only commands are allowed by command
 * tuple, mutating commands must match exact non-interactive templates, and
 * every denied shape points the user at the `using-gh` skill.
 */

import { booleanFlagCount, scanPolicyArgs, valueFlagValues } from "./policy-args.js";

const USING_GH_HINT = "Load skill using-gh for the supported command patterns.";

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

function isPathUnderCwd(path: string, cwd: string | undefined): boolean {
  if (!cwd || path.length === 0 || path === "-") return false;
  const resolved = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
  const normalized = normalizePath(resolved);
  const normalizedCwd = normalizePath(cwd);
  return normalized === normalizedCwd || normalized.startsWith(normalizedCwd + "/");
}

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
  "workflow list",
  "workflow view",
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
      return validateGhCommentArgs(args, "gh pr comment", cwd);
    case "pr review":
      return validateGhPrReviewArgs(args);
    case "issue view":
      return validateRequiredNumericSelector(args, "gh issue view");
    case "issue comment":
      return validateGhCommentArgs(args, "gh issue comment", cwd);
    case "issue create":
      return validateGhIssueCreateArgs(args);
    case "run view":
      return validateRequiredNumericSelector(args, "gh run view");
    case "run watch":
      return validateRequiredNumericSelector(args, "gh run watch");
    case "workflow view":
      return validateWorkflowViewArgs(args);
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
  return args.length >= 3 && /^\d+$/.test(args[2]) ? null : denyMessage(command);
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

function validateGhCommentArgs(
  args: string[],
  command: "gh pr comment" | "gh issue comment",
  cwd: string | undefined,
): string | null {
  const selector = args[2];
  if (!selector || !/^\d+$/.test(selector)) {
    return denyMessage(command);
  }

  // `-F` is only allowed on `gh pr comment` (user scope). `gh issue comment` keeps
  // the inline-body-only shape.
  const flags: Parameters<typeof scanPolicyArgs>[2] =
    command === "gh pr comment"
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
  const bodyFiles = command === "gh pr comment" ? valueFlagValues(parsed, "body-file") : [];

  if (bodies.length > 0 && bodyFiles.length > 0) return denyMessage(command);
  if (bodyFiles.length > 1) return denyMessage(command);
  if (bodyFiles.length === 1 && !isPathUnderCwd(bodyFiles[0], cwd)) {
    return denyMessage(command);
  }

  return bodies.length > 0 || bodyFiles.length > 0 ? null : denyMessage(command);
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
