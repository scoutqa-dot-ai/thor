import { z } from "zod/v4";

// --- Individual event schemas ---

export const ProgressStartSchema = z.object({
  type: z.literal("start"),
  sessionId: z.string(),
  correlationKey: z.string().optional(),
  resumed: z.boolean(),
  previousNotesPath: z.string().optional(),
});

export const ProgressToolSchema = z.object({
  type: z.literal("tool"),
  tool: z.string(),
  status: z.enum(["completed", "error"]),
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
  description: z.string().optional(),
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

export const ProgressApprovalRequiredSchema = z.object({
  type: z.literal("approval_required"),
  actionId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  proxyName: z.string().optional(),
});

export const ProgressHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
});

// --- Discriminated union ---

export const ProgressEventSchema = z.discriminatedUnion("type", [
  ProgressStartSchema,
  ProgressToolSchema,
  ProgressMemorySchema,
  ProgressDelegateSchema,
  ProgressDoneSchema,
  ProgressErrorSchema,
  ProgressApprovalRequiredSchema,
  ProgressHeartbeatSchema,
]);

// --- REST endpoint request schemas ---

export const SlackProgressRequestSchema = z.object({
  channel: z.string(),
  threadTs: z.string(),
  sourceTs: z.string(),
  event: ProgressEventSchema,
});

export const SlackReactionRequestSchema = z.object({
  channel: z.string(),
  timestamp: z.string(),
  reaction: z.string(),
});

export const SlackApprovalRequestSchema = z.object({
  channel: z.string(),
  threadTs: z.string(),
  actionId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  proxyName: z.string().optional(),
});

export type SlackProgressRequest = z.infer<typeof SlackProgressRequestSchema>;
export type SlackReactionRequest = z.infer<typeof SlackReactionRequestSchema>;
export type SlackApprovalRequest = z.infer<typeof SlackApprovalRequestSchema>;

// --- Inferred types ---

export type ProgressStart = z.infer<typeof ProgressStartSchema>;
export type ProgressTool = z.infer<typeof ProgressToolSchema>;
export type ProgressMemory = z.infer<typeof ProgressMemorySchema>;
export type ProgressDelegate = z.infer<typeof ProgressDelegateSchema>;
export type ProgressDone = z.infer<typeof ProgressDoneSchema>;
export type ProgressError = z.infer<typeof ProgressErrorSchema>;
export type ProgressApprovalRequired = z.infer<typeof ProgressApprovalRequiredSchema>;
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
