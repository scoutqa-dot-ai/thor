import { z } from "zod/v4";

// --- Individual event schemas ---

export const ProgressStartSchema = z.object({
  type: z.literal("start"),
  sessionId: z.string(),
  correlationKey: z.string().optional(),
  resumed: z.boolean(),
});

export const ProgressToolSchema = z.object({
  type: z.literal("tool"),
  tool: z.string(),
  status: z.enum(["completed", "error"]),
});

export const ProgressDoneSchema = z.object({
  type: z.literal("done"),
  sessionId: z.string(),
  correlationKey: z.string().optional(),
  resumed: z.boolean(),
  status: z.enum(["completed", "error"]),
  error: z.string().optional(),
  response: z.string(),
  toolCalls: z.array(z.object({ tool: z.string(), state: z.string() })),
  messageId: z.string().optional(),
  durationMs: z.number(),
});

export const ProgressErrorSchema = z.object({
  type: z.literal("error"),
  error: z.string(),
});

// --- Discriminated union ---

export const ProgressEventSchema = z.discriminatedUnion("type", [
  ProgressStartSchema,
  ProgressToolSchema,
  ProgressDoneSchema,
  ProgressErrorSchema,
]);

// --- Inferred types ---

export type ProgressStart = z.infer<typeof ProgressStartSchema>;
export type ProgressTool = z.infer<typeof ProgressToolSchema>;
export type ProgressDone = z.infer<typeof ProgressDoneSchema>;
export type ProgressError = z.infer<typeof ProgressErrorSchema>;
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
