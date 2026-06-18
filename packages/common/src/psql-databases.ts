/**
 * Per-profile Postgres connection targets for the `psql` passthrough.
 *
 * Operators provide one JSON bundle per profile in `PSQL_DATABASES_<PROFILE>`
 * (falling back to the global `PSQL_DATABASES`), keyed by a stable database
 * alias. The agent selects a target by alias; remote-cli resolves the alias to
 * the full connection tuple and injects it via PG* env, so the host, username,
 * and password never reach the agent.
 *
 * Engine is implicit (Postgres). A future MySQL surface would use its own
 * `MYSQL_DATABASES_<PROFILE>` bundle behind a separate wrapper, so there is no
 * per-target engine field here.
 */

import { errorMessage } from "./errors.ts";

const ALIAS_RE = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_PORT = 5432;
const DEFAULT_SSLMODE = "require";

export interface PsqlDatabaseTarget {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslmode: string;
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function requireString(alias: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    return throwTargetError(alias, `"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function throwTargetError(alias: string, detail: string): never {
  throw new Error(`psql database "${alias}": ${detail}`);
}

function resolvePort(alias: string, value: unknown): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = typeof value === "string" ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return throwTargetError(alias, `"port" must be an integer between 1 and 65535`);
  }
  return port;
}

function validateTarget(alias: string, value: unknown): PsqlDatabaseTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return throwTargetError(alias, "must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  return {
    host: requireString(alias, "host", record.host),
    port: resolvePort(alias, record.port),
    database: requireString(alias, "database", record.database),
    username: requireString(alias, "username", record.username),
    password: requireString(alias, "password", record.password),
    sslmode:
      record.sslmode === undefined
        ? DEFAULT_SSLMODE
        : requireString(alias, "sslmode", record.sslmode),
  };
}

/**
 * Resolve the database alias → connection target map for a profile.
 *
 * The profile-scoped `PSQL_DATABASES_<PROFILE>` bundle wins when present;
 * otherwise the global `PSQL_DATABASES` bundle applies. Returns an empty map
 * when neither is configured. Throws on a malformed bundle (invalid JSON, a
 * non-object value, an invalid alias, or a missing/invalid field) so a broken
 * bundle fails closed instead of silently exposing fewer targets.
 */
export function resolvePsqlDatabases(
  profile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, PsqlDatabaseTarget> {
  const scopedName = profile ? `PSQL_DATABASES_${profile}` : undefined;
  const scopedRaw = scopedName ? trimmed(env[scopedName]) : undefined;
  const sourceName = scopedRaw ? scopedName! : "PSQL_DATABASES";
  const raw = scopedRaw ?? trimmed(env.PSQL_DATABASES);
  if (!raw) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${sourceName} is not valid JSON: ${errorMessage(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${sourceName} must be a JSON object keyed by database alias`);
  }

  const targets = new Map<string, PsqlDatabaseTarget>();
  for (const [alias, value] of Object.entries(parsed)) {
    if (!ALIAS_RE.test(alias)) {
      throw new Error(
        `${sourceName} has invalid database alias "${alias}": use letters, digits, hyphen, or underscore`,
      );
    }
    targets.set(alias, validateTarget(alias, value));
  }
  return targets;
}
