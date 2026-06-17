/**
 * Server-side command policy for git, gh, scoutqa, ldcli, metabase, aws.
 *
 * All validation happens here — the OpenCode wrapper scripts are untrusted.
 *
 * Git and gh policy live in policy-git.ts and policy-gh.ts respectively, each
 * an explicit allowlist of supported workflows that share a small token-scanning
 * helper in policy-args.ts. The smaller validators (scoutqa, ldcli, metabase)
 * stay inline below.
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
// the agent never supplies a network target or credentials. This parser:
//   - rejects connection-control flags (-h/-p/-U/-d/-W and long forms), so the
//     agent cannot redirect the injected credentials at another endpoint;
//   - extracts the single alias positional (skipping value-taking option
//     values so a query like `-c "select 1"` is not mistaken for the alias);
//   - returns the remaining args verbatim for psql (query/format flags).
// Read-only is enforced at execution (read-only role + PGOPTIONS), not here.

const PSQL_ALIAS_RE = /^[a-zA-Z0-9_-]+$/;

// Connection-control flags. Their values would let the agent point the injected
// credentials at an arbitrary host/database/user, so they are denied outright.
const PSQL_DENIED_FLAGS: ReadonlySet<string> = new Set([
  "-h",
  "--host",
  "-p",
  "--port",
  "-U",
  "--username",
  "-d",
  "--dbname",
  "-W",
  "--password",
]);

// Same connection-control options as single chars, for short clusters (-Xh).
const PSQL_DENIED_SHORT: ReadonlySet<string> = new Set(["h", "p", "U", "d", "W"]);

// Short options that consume the next token as their value when not attached.
const PSQL_SHORT_VALUE_OPTS: ReadonlySet<string> = new Set([
  "c",
  "d",
  "f",
  "v",
  "o",
  "L",
  "F",
  "R",
  "P",
  "T",
  "h",
  "p",
  "U",
]);

// Long options that consume the next token as their value (when no "=value").
const PSQL_LONG_VALUE_OPTS: ReadonlySet<string> = new Set([
  "--command",
  "--dbname",
  "--file",
  "--set",
  "--variable",
  "--output",
  "--log-file",
  "--field-separator",
  "--record-separator",
  "--pset",
  "--table-attr",
  "--host",
  "--port",
  "--username",
]);

export interface PsqlInvocation {
  alias: string;
  passthroughArgs: string[];
}

function psqlDeniedFlagError(flag: string): string {
  return `flag "${flag}" is not allowed — the database alias selects the connection; pass only the alias and query flags (e.g. psql <alias> -c "select 1")`;
}

/**
 * Parse a psql argv into its connection alias and the args to forward to psql.
 *
 * Returns `{ error }` for a malformed or disallowed invocation (no alias, more
 * than one positional, a connection-control flag, or an alias that is not a
 * clean token). Connection URIs and libpq conninfo strings are rejected
 * implicitly because they fail the alias token check.
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
      const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      if (PSQL_DENIED_FLAGS.has(name)) return { error: psqlDeniedFlagError(name) };
      if (!token.includes("=") && PSQL_LONG_VALUE_OPTS.has(name)) i += 1;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const chars = token.slice(1);
      for (let j = 0; j < chars.length; j += 1) {
        const ch = chars[j];
        if (PSQL_DENIED_SHORT.has(ch)) return { error: psqlDeniedFlagError(`-${ch}`) };
        if (PSQL_SHORT_VALUE_OPTS.has(ch)) {
          // Value-taking: when it is the last char of the cluster, the value is
          // the next token; otherwise the value is attached (e.g. -cSELECT).
          if (j === chars.length - 1) i += 1;
          break;
        }
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
      error: "only one database alias is allowed; pass SQL with -c or -f, not as extra arguments",
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
