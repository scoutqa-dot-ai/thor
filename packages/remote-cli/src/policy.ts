/**
 * Server-side command policy for the binaries exposed through remote-cli's
 * `POST /exec/*` endpoints.
 *
 * All validation happens here — the OpenCode wrapper scripts are untrusted.
 *
 * Git and gh policy live in policy-git.ts and policy-gh.ts respectively, each
 * an explicit allowlist of supported workflows that share a small token-scanning
 * helper in policy-args.ts. The smaller per-command validators stay inline below.
 */

export { resolveGitArgs, validateGitArgs } from "./policy-git.ts";
export { validateGhArgs } from "./policy-gh.ts";

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

// ── psql policy ────────────────────────────────────────────────────────────
//
// The agent runs `psql <alias> [options]`, where the lone positional is a
// server-side connection alias (not a real dbname). remote-cli resolves the
// alias to host/port/database/user/password and injects them via PG* env, so
// the agent never supplies a network target or credentials.
//
// psql is not just a SQL runner: meta-commands (\!, \copy, \o, \i) and the
// -f/-o/-L file flags run shell commands and read/write files ON the remote-cli
// container — independent of the database's read-only role. That container holds
// the GitHub App key and other secrets, so this surface MUST fail closed. We use
// an ALLOWLIST (like git/gh/ldcli/metabase), not a denylist: only the alias,
// -c "<sql>", and a small set of output-format flags pass; everything else —
// connection flags, file flags, and any flag we haven't enumerated — is rejected
// by default. A -c value that is itself a meta-command (starts with "\") is
// rejected so it cannot smuggle \! / \copy. Read-only SQL is enforced at
// execution by the read-only DB role.

const PSQL_ALIAS_RE = /^[a-zA-Z0-9_-]+$/;

// Allowed boolean (no-value) flags: listing + output formatting only.
const PSQL_ALLOWED_BOOL_SHORT: ReadonlySet<string> = new Set([
  "l", // --list
  "A", // --no-align
  "t", // --tuples-only
  "x", // --expanded
  "q", // --quiet
  "X", // --no-psqlrc
  "n", // --no-readline
  "z", // --field-separator-zero
  "0", // --record-separator-zero
]);
const PSQL_ALLOWED_BOOL_LONG: ReadonlySet<string> = new Set([
  "--list",
  "--no-align",
  "--tuples-only",
  "--expanded",
  "--quiet",
  "--no-psqlrc",
  "--no-readline",
  "--csv",
  "--field-separator-zero",
  "--record-separator-zero",
]);

// Allowed value-taking flags: the SQL command, variables, and output separators.
const PSQL_ALLOWED_VALUE_SHORT: ReadonlySet<string> = new Set([
  "c", // --command
  "v", // --set / --variable
  "F", // --field-separator
  "R", // --record-separator
  "P", // --pset
]);
const PSQL_ALLOWED_VALUE_LONG: ReadonlySet<string> = new Set([
  "--command",
  "--set",
  "--variable",
  "--field-separator",
  "--record-separator",
  "--pset",
]);

export interface PsqlInvocation {
  alias: string;
  passthroughArgs: string[];
}

function psqlNotAllowedError(flag: string): string {
  return `flag "${flag}" is not allowed — psql access supports only the database alias, -c "<sql>", and output-format flags (e.g. psql <alias> -c "select 1")`;
}

const PSQL_META_COMMAND_ERROR =
  'psql meta-commands are not allowed in -c (they run shell/file operations on the server); pass SQL, e.g. -c "select ..."';

function isPsqlMetaCommand(value: string | undefined): boolean {
  return typeof value === "string" && value.trimStart().startsWith("\\");
}

/**
 * Parse a psql argv into its connection alias and the args to forward to psql.
 *
 * Allowlist-based: returns `{ error }` for any flag outside the allowed set, a
 * -c value that is a meta-command, an alias that is not a clean token, or the
 * wrong number of positionals. Connection flags (-h/-U/-d/...), file flags
 * (-f/-o/-L), URIs, and conninfo strings are all rejected by being absent from
 * the allowlist (or failing the alias token check).
 */
export function parsePsqlInvocation(args: unknown): PsqlInvocation | { error: string } {
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === "string")) {
    return { error: "args must be a non-empty string array" };
  }

  const positionals: number[] = [];
  let sawDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (sawDoubleDash) {
      positionals.push(i);
      continue;
    }
    if (token === "--") {
      sawDoubleDash = true;
      continue;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      if (PSQL_ALLOWED_VALUE_LONG.has(name)) {
        const value = eq === -1 ? args[i + 1] : token.slice(eq + 1);
        if (name === "--command" && isPsqlMetaCommand(value)) {
          return { error: PSQL_META_COMMAND_ERROR };
        }
        if (eq === -1) i += 1; // consume the value token
        continue;
      }
      if (PSQL_ALLOWED_BOOL_LONG.has(name)) {
        if (eq !== -1) return { error: `flag "${name}" does not take a value` };
        continue;
      }
      return { error: psqlNotAllowedError(name) };
    }

    if (token.startsWith("-") && token.length > 1) {
      const chars = token.slice(1);
      for (let j = 0; j < chars.length; j += 1) {
        const ch = chars[j];
        if (PSQL_ALLOWED_VALUE_SHORT.has(ch)) {
          // Value-taking: when it is the last char of the cluster, the value is
          // the next token; otherwise the value is attached (e.g. -cSELECT).
          const value = j === chars.length - 1 ? args[i + 1] : chars.slice(j + 1);
          if (ch === "c" && isPsqlMetaCommand(value)) return { error: PSQL_META_COMMAND_ERROR };
          if (j === chars.length - 1) i += 1;
          break; // rest of the cluster is this option's attached value
        }
        if (PSQL_ALLOWED_BOOL_SHORT.has(ch)) continue;
        return { error: psqlNotAllowedError(`-${ch}`) };
      }
      continue;
    }

    positionals.push(i);
  }

  if (positionals.length === 0) {
    return { error: 'specify a database alias, e.g. psql <alias> -c "select 1"' };
  }
  if (positionals.length > 1) {
    return {
      error: "only one database alias is allowed; pass SQL with -c, not as extra arguments",
    };
  }

  const aliasIndex = positionals[0];
  const alias = args[aliasIndex];
  if (!PSQL_ALIAS_RE.test(alias)) {
    return {
      error: `invalid database alias "${alias}": use letters, digits, hyphen, or underscore`,
    };
  }

  return { alias, passthroughArgs: args.filter((_, idx) => idx !== aliasIndex) };
}

// ── aws policy ─────────────────────────────────────────────────────────────
//
// The aws endpoint is a generic passthrough — any AWS CLI command is forwarded
// to the remote-cli container, which executes it with the credentials in its
// own environment (IAM role / AWS_* env). Scope is governed by those IAM
// credentials, not by an in-process allowlist. If a future plan needs to
// restrict which services/subcommands agents can reach, add the allowlist here.
//
// Mutating ("write-alike") commands are additionally gated behind human
// approval (see awsCommandRequiresApproval). validateAwsArgs only checks the
// request is well-formed; the read/write split decides the execution path.

export function validateAwsArgs(args: unknown): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }
  if (!args.every((arg) => typeof arg === "string")) {
    return "args must be a string array";
  }

  return null;
}

// Global options that consume the following token as their value. Used to skip
// option values when locating the positional service/operation tokens (e.g.
// `aws --region us-east-1 ec2 run-instances` → service "ec2", op "run-instances").
const AWS_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--region",
  "--profile",
  "--output",
  "--endpoint-url",
  "--query",
  "--color",
  "--ca-bundle",
  "--cli-read-timeout",
  "--cli-connect-timeout",
  "--cli-binary-format",
]);

// Operation verb prefixes that only read state. A command counts as read-only
// when its operation token equals one of these or starts with "<verb>-"
// (e.g. describe-instances, list-buckets, get-object, batch-get-item).
const AWS_READ_ONLY_VERBS: readonly string[] = [
  "describe",
  "list",
  "get",
  "lookup",
  "search",
  "scan",
  "query",
  "head",
  "select",
  "view",
  "preview",
  "estimate",
  "batch-get",
  "wait",
];

// Read-only operations whose names are not verb-prefixed: s3 high-level `ls`,
// the local `presign` URL helper, and `help`.
const AWS_READ_ONLY_EXACT: ReadonlySet<string> = new Set(["ls", "presign", "help"]);

// Credential/token-adjacent reads expose sensitive auth material or IAM shape.
// Check these before the read-only verb allowlist so `get-*` token helpers do
// not bypass approval.
const AWS_APPROVAL_KEYWORDS: readonly string[] = [
  "api-key",
  "credential",
  "password",
  "role",
  "secret",
  "ssm",
  "sts",
  "token",
];

// Extract positional tokens (service, operation), skipping global flags and
// their values. Keep indexes so help can be recognized only when it follows the
// operation token, not when it is merely an option value.
function awsPositionals(args: string[]): Array<{ token: string; index: number }> {
  const positionals: Array<{ token: string; index: number }> = [];
  for (let i = 0; i < args.length && positionals.length < 2; i += 1) {
    const token = args[i];
    if (token.startsWith("-")) {
      // "--opt=value" carries its own value; a bare value-option consumes the
      // next token, so skip it to avoid treating the value as a positional.
      if (!token.includes("=") && AWS_GLOBAL_VALUE_OPTIONS.has(token)) {
        i += 1;
      }
      continue;
    }
    positionals.push({ token, index: i });
  }
  return positionals;
}

function isReadOnlyAwsOperation(operation: string): boolean {
  if (AWS_READ_ONLY_EXACT.has(operation)) return true;
  return AWS_READ_ONLY_VERBS.some((verb) => operation === verb || operation.startsWith(`${verb}-`));
}

function isAwsHelpRequest(args: string[], operationIndex: number): boolean {
  return args[operationIndex + 1] === "help" && operationIndex + 2 === args.length;
}

function hasAwsApprovalKeyword(service: string, operation: string): boolean {
  const command = `${service} ${operation}`;
  return AWS_APPROVAL_KEYWORDS.some((keyword) => command.includes(keyword));
}

/**
 * Whether an aws command mutates state and must be gated behind human approval.
 *
 * Fail-closed: a command skips approval only when it requests help/version or
 * its operation is a recognized read-only verb. Any other (or unrecognized)
 * operation — create-*, delete-*, put-*, run-*, s3 cp/mv/rm/sync, etc. — is
 * treated as a write and requires approval.
 */
export function awsCommandRequiresApproval(args: string[]): boolean {
  if (!Array.isArray(args) || args.length === 0) return false;
  if (args.includes("--version")) return false;

  const [servicePositional, operationPositional] = awsPositionals(args);
  // No operation token (bare `aws s3`, or only global flags): nothing to
  // mutate — aws just prints usage/help.
  if (!servicePositional || !operationPositional) return false;

  if (isAwsHelpRequest(args, operationPositional.index)) return false;
  if (hasAwsApprovalKeyword(servicePositional.token, operationPositional.token)) return true;
  return !isReadOnlyAwsOperation(operationPositional.token);
}
