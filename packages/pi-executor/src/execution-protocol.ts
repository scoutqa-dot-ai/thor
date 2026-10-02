import { z } from "zod";

// Private executor protocol. Never dispatch a property named by an incoming request.
const path = z.string();
const content = z.discriminatedUnion("encoding", [
  z.strictObject({ encoding: z.literal("text"), data: z.string() }),
  z.strictObject({ encoding: z.literal("base64"), data: z.base64() }),
]);
const recursive = z.strictObject({ recursive: z.boolean().optional() });
const removal = recursive.extend({ force: z.boolean().optional() });

/** Only wrapper attribution may be supplied by an individual tool invocation. */
export const piShellEnvironmentSchema = z.strictObject({
  THOR_OPENCODE_DIRECTORY: z.string().optional(),
  THOR_OPENCODE_SESSION_ID: z.string().optional(),
  THOR_OPENCODE_CALL_ID: z.string().optional(),
});

/** Exact request grammar shared by runner and executor; unknown fields and operations fail closed. */
export const piExecutionRequestSchema = z.strictObject({
  sessionId: z.uuid(),
  cwd: path,
  operation: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("absolutePath"), path }),
    z.strictObject({ type: z.literal("joinPath"), parts: z.array(path) }),
    z.strictObject({ type: z.literal("readTextFile"), path }),
    z.strictObject({ type: z.literal("openTextLineReader"), path, readerId: z.uuid() }),
    z.strictObject({ type: z.literal("readLine"), readerId: z.uuid() }),
    z.strictObject({ type: z.literal("closeReader"), readerId: z.uuid() }),
    z.strictObject({
      type: z.literal("readTextLines"),
      path,
      options: z.strictObject({ maxLines: z.number().int().optional() }).optional(),
    }),
    z.strictObject({ type: z.literal("readBinaryFile"), path }),
    z.strictObject({ type: z.literal("writeFile"), path, content }),
    z.strictObject({ type: z.literal("appendFile"), path, content }),
    z.strictObject({ type: z.literal("truncateFile"), path, size: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal("flushFile"), path }),
    z.strictObject({ type: z.literal("renameFile"), sourcePath: path, destinationPath: path }),
    z.strictObject({ type: z.literal("fileInfo"), path }),
    z.strictObject({ type: z.literal("listDir"), path }),
    z.strictObject({ type: z.literal("canonicalPath"), path }),
    z.strictObject({ type: z.literal("exists"), path }),
    z.strictObject({ type: z.literal("createDir"), path, options: recursive.optional() }),
    z.strictObject({ type: z.literal("remove"), path, options: removal.optional() }),
    z.strictObject({ type: z.literal("createTempDir"), prefix: z.string().optional() }),
    z.strictObject({
      type: z.literal("createTempFile"),
      options: z
        .strictObject({ prefix: z.string().optional(), suffix: z.string().optional() })
        .optional(),
    }),
    z.strictObject({ type: z.literal("cleanup") }),
    z.strictObject({
      type: z.literal("exec"),
      command: z.string(),
      options: z
        .strictObject({
          cwd: path.optional(),
          env: piShellEnvironmentSchema.optional(),
          inheritEnv: z.boolean().optional(),
          timeout: z.number().optional(),
          spill: z
            .strictObject({
              afterBytes: z.number().nonnegative(),
              afterLines: z.number().nonnegative(),
            })
            .optional(),
        })
        .optional(),
    }),
  ]),
});

/** Parsed private operation; callers cannot select arbitrary vendor methods. */
export type PiExecutionOperation = z.infer<typeof piExecutionRequestSchema>["operation"];
/** Parsed request with an invocation resource owner, distinct from the stable filesystem namespace. */
export type PiExecutionRequest = z.infer<typeof piExecutionRequestSchema>;

/** Sanitized file failure codes; raw vendor errors never cross the transport. */
export const piFileErrorSchema = z.strictObject({
  code: z.enum([
    "aborted",
    "not_found",
    "permission_denied",
    "not_directory",
    "is_directory",
    "invalid",
    "not_supported",
    "unknown",
  ]),
});
/** Sanitized shell failure, preserving the remote full-output spill path when available. */
export const piExecutionErrorSchema = z.strictObject({
  code: z.enum([
    "aborted",
    "timeout",
    "shell_unavailable",
    "spawn_error",
    "callback_error",
    "unknown",
  ]),
  spillPath: z.string().optional(),
});
/** File metadata returned by the remote namespace. */
export const piFileInfoSchema = z.strictObject({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory", "symlink"]),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
});
/** LF line-reader result; null encodes EOF. */
export const piTextLineSchema = z
  .strictObject({ text: z.string(), terminated: z.boolean() })
  .nullable();
/** Shell result is a terminal frame, never an output-tail buffer. */
export const piShellResultSchema = z.strictObject({
  exitCode: z.number().int(),
  spillPath: z.string().optional(),
});

/** Decode each file response with the operation's exact success schema. */
export function piFileResponseSchema<T>(
  value: z.ZodType<T>,
): z.ZodType<{ ok: true; value: T } | { ok: false; error: z.infer<typeof piFileErrorSchema> }> {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: piFileErrorSchema }),
  ]);
}
/** NDJSON frames forward raw output in order, followed by exactly one terminal result. */
export const piExecFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("output"), text: z.string() }),
  z.strictObject({
    type: z.literal("result"),
    result: z.discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), value: piShellResultSchema }),
      z.strictObject({ ok: z.literal(false), error: piExecutionErrorSchema }),
    ]),
  }),
]);
