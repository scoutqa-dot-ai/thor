import { z } from "zod/v4";

/** Buffered response from remote-cli exec endpoints. */
export const ExecResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

/** A single event from a streaming exec response (scoutqa/sandbox). */
export const ExecStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdout"), data: z.string() }),
  z.object({ type: z.literal("stderr"), data: z.string() }),
  z.object({ type: z.literal("exit"), exitCode: z.number() }),
  z.object({ type: z.literal("heartbeat") }),
]);
export type ExecStreamEvent = z.infer<typeof ExecStreamEventSchema>;
