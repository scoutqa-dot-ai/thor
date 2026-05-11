import { z } from "zod/v4";
import { APPROVAL_TOOL_NAMES } from "./approval-events.js";

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
  actionId: z.string().min(1),
  proxyName: z.string().min(1).optional(),
  tool: z.enum(APPROVAL_TOOL_NAMES),
  args: z.record(z.string(), z.unknown()),
});

export const ProgressHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
});

// --- Discriminated union ---

export const ProgressEventSchema = z.union([
  ProgressStartSchema,
  ProgressToolSchema,
  ProgressMemorySchema,
  ProgressDelegateSchema,
  ProgressDoneSchema,
  ProgressErrorSchema,
  ProgressApprovalRequiredSchema,
  ProgressHeartbeatSchema,
]);

// --- Inferred types ---

export type ProgressStart = z.infer<typeof ProgressStartSchema>;
export type ProgressTool = z.infer<typeof ProgressToolSchema>;
export type ProgressMemory = z.infer<typeof ProgressMemorySchema>;
export type ProgressDelegate = z.infer<typeof ProgressDelegateSchema>;
export type ProgressDone = z.infer<typeof ProgressDoneSchema>;
export type ProgressError = z.infer<typeof ProgressErrorSchema>;
export type ProgressApprovalRequired = z.infer<typeof ProgressApprovalRequiredSchema>;
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
