import { z } from "zod/v4";

/** Buffered response from remote-cli (git/gh) and proxy (tool calls). */
export const ExecResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

/** A single NDJSON chunk from a streaming response (scoutqa). */
export const NdjsonChunkSchema = z.union([
  z.object({ stream: z.literal("stdout"), data: z.string() }),
  z.object({ stream: z.literal("stderr"), data: z.string() }),
  z.object({ exitCode: z.number() }),
]);
export type NdjsonChunk = z.infer<typeof NdjsonChunkSchema>;
