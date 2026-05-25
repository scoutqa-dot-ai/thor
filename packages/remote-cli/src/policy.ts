/**
 * Server-side command policy for git, gh, scoutqa, langfuse, ldcli, gws, metabase.
 *
 * All validation happens here — the OpenCode wrapper scripts are untrusted.
 *
 * Git and gh policy live in policy-git.ts and policy-gh.ts respectively, each
 * an explicit allowlist of supported workflows that share a small token-scanning
 * helper in policy-args.ts. The smaller validators (scoutqa, langfuse, ldcli,
 * metabase) stay inline below.
 */

export {
  resolveGitArgs,
  validateGitArgs,
  type GitPolicyOptions,
  type ResolvedGitArgs,
} from "./policy-git.js";
export { validateGhArgs } from "./policy-gh.js";

import {
  WORKSPACE_REPOS_ROOT,
  WORKSPACE_WORKTREES_ROOT,
  isPathWithin,
  realpathOrNull,
} from "@thor/common";

// ── cwd validation ──────────────────────────────────────────────────────────

const ALLOWED_CWD_PREFIXES = [WORKSPACE_REPOS_ROOT, WORKSPACE_WORKTREES_ROOT];

export function validateCwd(cwd: string): string | null {
  if (!cwd || !cwd.startsWith("/")) {
    return "cwd must be an absolute path";
  }

  const realCwd = realpathOrNull(cwd);
  if (!realCwd) {
    return `cwd must be under ${ALLOWED_CWD_PREFIXES.join(" or ")}`;
  }

  const allowed = ALLOWED_CWD_PREFIXES.some((prefix) => isPathWithin(prefix, realCwd));

  if (!allowed) {
    return `cwd must be under ${ALLOWED_CWD_PREFIXES.join(" or ")}`;
  }

  return null;
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

// ── Google Workspace policy ───────────────────────────────────────────────

const ALLOWED_GWS_SERVICES: ReadonlySet<string> = new Set([
  "drive",
  "docs",
  "sheets",
  "calendar",
  "gmail",
]);

const ALLOWED_GWS_COMMANDS: ReadonlySet<string> = new Set([
  "drive about get",
  "drive files get",
  "drive files list",
  "drive files export",
  "drive drives get",
  "drive drives list",
  "drive permissions get",
  "drive permissions list",
  "drive comments get",
  "drive comments list",
  "drive replies get",
  "drive replies list",
  "drive revisions get",
  "drive revisions list",
  "docs documents get",
  "sheets spreadsheets get",
  "sheets spreadsheets getByDataFilter",
  "sheets spreadsheets values get",
  "sheets spreadsheets values batchGet",
]);

const ALLOWED_GWS_HELPERS: ReadonlySet<string> = new Set(["sheets +read"]);

const DENIED_GWS_FLAGS: ReadonlySet<string> = new Set([
  "--dry-run",
  "--output",
  "-o",
  "--sanitize",
  "--upload",
  "--upload-content-type",
]);

const GWS_MAX_PAGE_LIMIT = 10;

export function validateGwsArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  if (!args.every((arg) => typeof arg === "string")) {
    return "args must be a string array";
  }

  const flagError = validateGwsFlags(args);
  if (flagError) return flagError;

  if (isGwsRootHelp(args) || isGwsServiceHelp(args)) return null;

  const commandTokens = getGwsCommandTokens(args);
  if (commandTokens.length === 0) {
    return "gws command is required";
  }

  if (commandTokens[0] === "schema") {
    return validateGwsSchemaArgs(args, commandTokens);
  }

  const service = commandTokens[0];
  if (!ALLOWED_GWS_SERVICES.has(service)) {
    return `"gws ${service}" is not allowed`;
  }

  const command = commandTokens.join(" ");
  if (ALLOWED_GWS_COMMANDS.has(command) || ALLOWED_GWS_HELPERS.has(command)) {
    return null;
  }

  return `"gws ${command}" is not allowed`;
}

function validateGwsFlags(args: string[]): string | null {
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (DENIED_GWS_FLAGS.has(flag)) {
      return `flag "${flag}" is not allowed`;
    }
  }

  const format = optionValues(args, "--format");
  if (format.missing) return '"--format" requires a value';
  for (const value of format.values) {
    if (value !== "json") {
      return 'gws API calls must use "--format json"';
    }
  }

  const pageLimit = optionValues(args, "--page-limit");
  if (pageLimit.missing) return '"--page-limit" requires a value';
  for (const rawValue of pageLimit.values) {
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(value) || String(value) !== rawValue || value < 1) {
      return '"--page-limit" must be a positive integer';
    }
    if (value > GWS_MAX_PAGE_LIMIT) {
      return `"--page-limit" must be <= ${GWS_MAX_PAGE_LIMIT}`;
    }
  }

  const params = optionValues(args, "--params");
  if (params.missing) return '"--params" requires a value';
  for (const value of params.values) {
    const paramsError = validateGwsParams(value);
    if (paramsError) return paramsError;
  }

  return null;
}

function optionValues(args: string[], option: string): { values: string[]; missing: boolean } {
  const values: string[] = [];
  let missing = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === option) {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        missing = true;
      } else {
        values.push(value);
        i += 1;
      }
      continue;
    }

    if (arg.startsWith(`${option}=`)) {
      const value = arg.slice(option.length + 1);
      if (!value) missing = true;
      else values.push(value);
    }
  }

  return { values, missing };
}

function validateGwsParams(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    String((parsed as Record<string, unknown>).alt ?? "").toLowerCase() === "media"
  ) {
    return "binary Drive media downloads are not allowed";
  }

  return null;
}

function isGwsRootHelp(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h");
}

function isGwsServiceHelp(args: string[]): boolean {
  return (
    args.length === 2 &&
    ALLOWED_GWS_SERVICES.has(args[0]) &&
    (args[1] === "--help" || args[1] === "-h")
  );
}

function getGwsCommandTokens(args: string[]): string[] {
  const tokens: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    tokens.push(arg);
  }
  return tokens;
}

function validateGwsSchemaArgs(args: string[], commandTokens: string[]): string | null {
  if (commandTokens.length !== 2) {
    return '"gws schema" requires exactly 1 argument: <service.resource.method>';
  }

  const schemaRef = commandTokens[1];
  if (!ALLOWED_GWS_COMMANDS.has(schemaRef.split(".").join(" "))) {
    return `"gws schema ${schemaRef}" is not allowed`;
  }

  const flagTokens = args.slice(commandTokens.length);
  for (const arg of flagTokens) {
    if (arg !== "--resolve-refs") {
      return `flag "${arg.split("=")[0]}" is not allowed for gws schema`;
    }
  }

  return null;
}

// ── metabase policy ────────────────────────────────────────────────────────

const ALLOWED_METABASE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "schemas",
  "tables",
  "columns",
  "query",
  "question",
]);

const METABASE_QUESTION_REF_RE = /^[1-9]\d*(?:-[a-z0-9-]+)?$/;

export function validateMetabaseArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  const subcommand = args[0];
  if (!ALLOWED_METABASE_SUBCOMMANDS.has(subcommand)) {
    return `"metabase ${subcommand}" is not allowed — valid subcommands: schemas, tables, columns, query, question`;
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

  if (subcommand === "question") {
    if (args.length !== 2) return '"metabase question" requires exactly 1 argument: <question-id>';
    if (!METABASE_QUESTION_REF_RE.test(args[1]))
      return `"${args[1]}" is not a valid question ID (expected a positive integer or URL slug)`;
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
