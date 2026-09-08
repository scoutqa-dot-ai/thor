import { z } from "zod";

const readMethods = new Set([
  "drive about get",
  "drive files get",
  "drive files list",
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
const readHelper = "sheets +read";
const ArgsSchema = z.array(z.string().refine((arg) => !arg.includes("\0"))).min(1);
const JsonObjectSchema = z.record(z.string(), z.json());

/** A denied command; messages never echo untrusted arguments or JSON payloads. */
export class GwsPolicyError extends Error {
  /** Stable classification for policy denials. */
  readonly _tag = "GwsPolicyError";

  constructor(reason: string) {
    super(`gws policy: ${reason}`);
  }
}

/** Canonical read-only argv and its safe, allowlisted audit operation. */
export type GwsCommand = {
  readonly args: string[];
  readonly operation: string;
  readonly requiresCredentials: boolean;
};

type ParseResult =
  | { readonly ok: true; readonly command: GwsCommand }
  | { readonly ok: false; readonly error: GwsPolicyError };

function denied(reason: string): ParseResult {
  return { ok: false, error: new GwsPolicyError(reason) };
}

function allowed(args: string[], operation: string, requiresCredentials = false): ParseResult {
  return { ok: true, command: { args, operation, requiresCredentials } };
}

function parseJsonObject(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    const result = JsonObjectSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Parse untrusted argv into the exact supported read surface; never forward unchecked flags. */
export function parseGwsArgs(input: unknown): ParseResult {
  const parsed = ArgsSchema.safeParse(input);
  if (!parsed.success) return denied("args must be a non-empty string array without NUL bytes");
  const args = parsed.data;
  const first = args[0];
  if (args.length === 1 && (first === "--help" || first === "-h" || first === "--version")) {
    return allowed([first], first);
  }
  if (first === "schema") {
    const method = args[1]?.split(".").join(" ");
    if (args.length !== 2 || !method || !readMethods.has(method)) {
      return denied("schema requires an allowed read method");
    }
    return allowed(["schema", method.split(" ").join(".")], `schema ${method}`);
  }

  // Help is only accepted as the sole suffix of a known command prefix.
  // A --help token embedded in a mutating command must not bypass policy.
  const last = args.at(-1);
  if (last === "--help" || last === "-h") {
    const prefix = args.slice(0, -1).join(" ");
    const known = [...readMethods, readHelper].some(
      (method) => method === prefix || method.startsWith(`${prefix} `),
    );
    if (prefix && known) return allowed([...args.slice(0, -1), "--help"], `${prefix} help`);
    return denied("help requires an allowed command prefix");
  }

  const flagIndex = args.findIndex((arg) => arg.startsWith("-"));
  const commandLength = flagIndex === -1 ? args.length : flagIndex;
  const commandParts = args.slice(0, commandLength);
  const operation = commandParts.join(" ");
  const helper = operation === readHelper;
  if (!readMethods.has(operation) && !helper)
    return denied("only allowed Drive, Docs, and Sheets reads are supported");

  const flags = new Map<string, string>();
  for (let i = commandLength; i < args.length; i++) {
    const token = args[i];
    if (!token) return denied("expected a supported flag");
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (flags.has(flag)) return denied("duplicate flags are not supported");
    if (flag === "--page-all" && !helper && equals === -1) {
      flags.set(flag, "");
      continue;
    }
    const supported = helper
      ? ["--spreadsheet", "--range", "--format"]
      : [
          "--params",
          "--format",
          "--page-limit",
          ...(operation === "sheets spreadsheets getByDataFilter" ? ["--json"] : []),
        ];
    if (!supported.includes(flag))
      return denied("unsupported flag; use help/schema and the documented read forms");
    const value = equals === -1 ? args[++i] : token.slice(equals + 1);
    if (!value || value.startsWith("-")) return denied("flags require non-empty inline values");
    flags.set(flag, value);
  }

  if (flags.has("--format") && flags.get("--format") !== "json")
    return denied("only JSON output is supported");
  if (helper) {
    const spreadsheet = flags.get("--spreadsheet");
    const range = flags.get("--range");
    if (!spreadsheet || !range || spreadsheet.startsWith("@") || range.startsWith("@")) {
      return denied("sheets +read requires --spreadsheet <id> and --range <range>");
    }
    return allowed(
      [...commandParts, "--spreadsheet", spreadsheet, "--range", range, "--format", "json"],
      operation,
      true,
    );
  }

  const finalArgs = [...commandParts];
  for (const flag of ["--params", "--json"]) {
    const raw = flags.get(flag);
    if (raw === undefined) continue;
    const value = parseJsonObject(raw);
    if (!value) return denied("params and request bodies must be inline JSON objects, not files");
    if (flag === "--params") {
      // Google query parameters can change transport/auth behavior as well as
      // select data. Keep credentials and media out of the caller's surface.
      if (
        ("alt" in value && value.alt !== "json") ||
        [
          "access_token",
          "oauth_token",
          "key",
          "callback",
          "uploadType",
          "upload_protocol",
          "$.xgafv",
        ].some((key) => key in value)
      ) {
        return denied("media, credential, and transport parameter overrides are not supported");
      }
    }
    finalArgs.push(flag, JSON.stringify(value));
  }
  const pageLimit = flags.get("--page-limit");
  if (pageLimit !== undefined && !/^(?:[1-9]|10)$/.test(pageLimit))
    return denied("page limit must be 1–10");
  if (pageLimit !== undefined && !flags.has("--page-all"))
    return denied("page limit requires --page-all");
  if (flags.has("--page-all")) {
    if (!operation.endsWith(" list"))
      return denied("auto-pagination is supported only for list methods");
    finalArgs.push("--page-all", "--page-limit", pageLimit ?? "10");
  }
  finalArgs.push("--format", "json");
  return allowed(finalArgs, operation, true);
}
