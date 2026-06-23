import { z } from "zod/v4";

// --- Individual event schemas ---

export const ProgressToolSchema = z.object({
  type: z.literal("tool"),
  tool: z.string(),
  status: z.enum(["running", "completed", "error"]),
});

export const ProgressMemorySchema = z.object({
  type: z.literal("memory"),
  action: z.enum(["read", "write"]),
  path: z.string(),
  source: z.enum(["bootstrap", "tool"]),
});

export const ProgressDelegateSchema = z.object({
  type: z.literal("delegate"),
  agent: z.string(),
});

const ProgressContextSchema = z.object({
  type: z.literal("context"),
  providerID: z.string(),
  modelID: z.string(),
  tokens: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  usagePercent: z.number().int().nonnegative(),
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
  durationMs: z.number(),
});

const ProgressHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
});

// --- Discriminated union ---

export const ProgressEventSchema = z.union([
  ProgressToolSchema,
  ProgressMemorySchema,
  ProgressDelegateSchema,
  ProgressContextSchema,
  ProgressDoneSchema,
  ProgressHeartbeatSchema,
]);

// --- Inferred types ---

export type ProgressTool = z.infer<typeof ProgressToolSchema>;
export type ProgressMemory = z.infer<typeof ProgressMemorySchema>;
export type ProgressDelegate = z.infer<typeof ProgressDelegateSchema>;
export type ProgressDone = z.infer<typeof ProgressDoneSchema>;
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
