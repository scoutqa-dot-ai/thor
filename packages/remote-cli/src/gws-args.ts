import { z } from "zod";
import { GoogleDriveFileIdSchema, type GoogleDriveFileId } from "@thor/common";

const MAX_GWS_ARGS = 256;
const MAX_GWS_ARG_BYTES = 64 * 1024;
const MAX_GWS_ARGV_BYTES = 256 * 1024;

const LOCAL_FILE_FLAG_RE =
  /^--(?:[^=]*-)?(?:file|upload|output|credential|credentials|token|key|secret|oauth|auth|config|attachment|input)(?:[=-]|$)/i;
const LOCAL_FILE_HELPER_RE = /^\+(?:upload|download|export|import|send)$/i;

const ArgsSchema = z
  .array(
    z
      .string()
      .refine((arg) => !arg.includes("\0"))
      .refine((arg) => Buffer.byteLength(arg, "utf8") <= MAX_GWS_ARG_BYTES),
  )
  .max(MAX_GWS_ARGS)
  .refine(
    (args) =>
      args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= MAX_GWS_ARGV_BYTES,
  );

/** Malformed process arguments, not an upstream operation permission denial. */
export class GwsArgsError extends Error {
  /** Stable classification for invalid argv. */
  readonly _tag = "GwsArgsError" as const;

  constructor() {
    super("gws args must be a bounded string array without NUL bytes");
  }
}

/** Agent-facing authentication commands are owned by Neo's OAuth broker. */
export class GwsAuthCommandDenied extends Error {
  readonly _tag = "GwsAuthCommandDenied" as const;

  constructor() {
    super(
      "gws auth commands are disabled; connect Google Workspace through the private Slack link",
    );
  }
}

/** Local file access is excluded from the credential-bearing gws boundary. */
export class GwsLocalFileCommandDenied extends Error {
  readonly _tag = "GwsLocalFileCommandDenied" as const;

  constructor() {
    super(
      "gws local file input/output commands are disabled; use API JSON arguments or the exact Drive download command",
    );
  }
}

/** Only the broker-owned Drive download command can cross the local-output denial boundary. */
export function parseGwsDriveDownloadCommand(
  args: readonly string[],
): GoogleDriveFileId | undefined {
  if (
    args.length !== 4 ||
    args[0] !== "drive" ||
    args[1] !== "+download" ||
    args[2] !== "--file-id"
  )
    return undefined;
  const fileId = GoogleDriveFileIdSchema.safeParse(args[3]);
  return fileId.success ? fileId.data : undefined;
}

/** Preserve API argv while rejecting malformed, auth, and local-file input. */
export function parseGwsArgs(input: unknown):
  | { readonly ok: true; readonly args: string[] }
  | {
      readonly ok: false;
      readonly error: GwsArgsError | GwsAuthCommandDenied | GwsLocalFileCommandDenied;
    } {
  const parsed = ArgsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: new GwsArgsError() };
  if (parseGwsDriveDownloadCommand(parsed.data)) return { ok: true, args: parsed.data };
  if (parsed.data[0] === "auth") {
    return { ok: false, error: new GwsAuthCommandDenied() };
  }
  if (
    parsed.data.some(
      (arg) =>
        LOCAL_FILE_FLAG_RE.test(arg) ||
        LOCAL_FILE_HELPER_RE.test(arg) ||
        arg.startsWith("/") ||
        arg.startsWith("./") ||
        arg.startsWith("../") ||
        arg.startsWith("~") ||
        arg.includes("/../") ||
        arg.startsWith("file://") ||
        arg.startsWith("@"),
    )
  ) {
    return { ok: false, error: new GwsLocalFileCommandDenied() };
  }
  return { ok: true, args: parsed.data };
}

/** Public CLI discovery shapes cannot execute a Google account operation. */
export function isGwsPublicDiscoveryCommand(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  if (args.length === 1 && ["--help", "-h", "--version", "-V"].includes(args[0])) return true;
  if (
    args[0] === "schema" &&
    /^[a-z][a-z0-9]*\.[A-Za-z0-9_.]+$/.test(args[1] ?? "") &&
    (args.length === 2 || (args.length === 3 && args[2] === "--resolve-refs"))
  )
    return true;
  return (
    args.length >= 2 &&
    args.length <= 5 &&
    ["--help", "-h"].includes(args.at(-1) ?? "") &&
    args.slice(0, -1).every((arg) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(arg))
  );
}
