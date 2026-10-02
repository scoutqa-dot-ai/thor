import { z } from "zod";

const ArgsSchema = z.array(z.string().refine((arg) => !arg.includes("\0")));
const JsonSchema = z.json();
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** An API operation on the configured Drata origin, with an optional JSON payload. */
export type DrataApiRequest = {
  readonly method: string;
  readonly path: string;
  readonly json?: z.infer<typeof JsonSchema>;
};

type DrataCommand =
  | { readonly kind: "help" }
  | { readonly kind: "api"; readonly request: DrataApiRequest };

/** Invalid CLI syntax or credential destination, not an API authorization decision. */
export class DrataArgsError extends Error {
  /** Stable classification for invalid command input. */
  readonly _tag = "DrataArgsError" as const;

  constructor(reason: string) {
    super(`drata arguments: ${reason}`);
  }
}

type ParseResult =
  | { readonly ok: true; readonly command: DrataCommand }
  | { readonly ok: false; readonly error: DrataArgsError };

function invalid(reason: string): ParseResult {
  return { ok: false, error: new DrataArgsError(reason) };
}

/** Parse any HTTP method and API path; restrict destinations to relative API paths. */
export function parseDrataArgs(input: unknown): ParseResult {
  const parsed = ArgsSchema.safeParse(input);
  if (!parsed.success) return invalid("args must be a string array without NUL bytes");
  const args = parsed.data;
  if (
    !args.length ||
    (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) ||
    (args.length === 2 && args[0] === "api" && ["--help", "-h"].includes(args[1] ?? ""))
  ) {
    return { ok: true, command: { kind: "help" } };
  }
  const method = args[1];
  const path = args[2];
  if (args[0] !== "api" || !method || !HTTP_TOKEN.test(method) || !path) {
    return invalid("Usage: drata api METHOD /path [--json JSON]");
  }
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#\x00-\x20\x7f]/.test(path)) {
    return invalid("use an absolute API path such as /public/v2/users, not another host or URL");
  }
  const request = { method: method.toUpperCase(), path };
  if (args.length === 3) return { ok: true, command: { kind: "api", request } };
  const flag = args[3];
  const rawJson =
    args.length === 5 && flag === "--json"
      ? args[4]
      : args.length === 4 && flag?.startsWith("--json=")
        ? flag.slice(7)
        : undefined;
  if (rawJson === undefined) return invalid("Usage: drata api METHOD /path [--json JSON]");
  try {
    const value: unknown = JSON.parse(rawJson);
    const json = JsonSchema.safeParse(value);
    if (!json.success) return invalid("--json requires a JSON value");
    return { ok: true, command: { kind: "api", request: { ...request, json: json.data } } };
  } catch {
    return invalid("--json requires inline JSON, not a file reference");
  }
}
