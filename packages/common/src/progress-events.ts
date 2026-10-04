import { z } from "zod/v4";
import { PiThinkingLevelSchema } from "./pi-model-routing.js";

/** Slack message timestamp metadata is optional for historical requests, never parsed from prompts. */
export const SlackMessageTsSchema = z
  .string()
  .regex(/^\d+\.\d+$/)
  .max(32);

// Optional scope preserves historical callers; Pi supplies both on every event.
const progressScopeFields = {
  requestId: z.string().min(1).optional(),
  sessionId: z.string().optional(),
};

// --- Individual event schemas ---

export const ProgressStartSchema = z.object({
  ...progressScopeFields,
  type: z.literal("start"),
  sessionId: z.string(),
  correlationKey: z.string().optional(),
  resumed: z.boolean(),
});

export const ProgressToolSchema = z.object({
  ...progressScopeFields,
  type: z.literal("tool"),
  toolCallId: z.string().optional(),
  tool: z.string(),
  status: z.enum(["running", "completed", "error"]),
});

export const ProgressMemorySchema = z.object({
  ...progressScopeFields,
  type: z.literal("memory"),
  action: z.enum(["read", "write"]),
  path: z.string(),
  source: z.enum(["bootstrap", "tool"]),
});

export const ProgressDelegateSchema = z.object({
  ...progressScopeFields,
  type: z.literal("delegate"),
  agent: z.string(),
});

export const ProgressContextSchema = z.object({
  ...progressScopeFields,
  type: z.literal("context"),
  providerID: z.string(),
  modelID: z.string(),
  tokens: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  usagePercent: z.number().int().nonnegative(),
});

export const ProgressDoneSchema = z.object({
  ...progressScopeFields,
  type: z.literal("done"),
  sessionId: z.string(),
  correlationKey: z.string().optional(),
  resumed: z.boolean(),
  status: z.enum(["completed", "error"]),
  authWait: z.enum(["google", "approval", "unconfirmed"]).optional(),
  error: z.string().optional(),
  response: z.string(),
  toolCalls: z.array(z.object({ tool: z.string(), state: z.string() })),
  messageId: z.string().optional(),
  durationMs: z.number(),
});

export const ProgressErrorSchema = z.object({
  ...progressScopeFields,
  type: z.literal("error"),
  error: z.string(),
});

export const ProgressHeartbeatSchema = z.object({
  ...progressScopeFields,
  type: z.literal("heartbeat"),
});

/** Selected task model observation; never contains provider settings or reasoning content. */
export const ProgressModelSchema = z.object({
  ...progressScopeFields,
  type: z.literal("model"),
  modelId: z.string().min(1),
  thinkingLevel: PiThinkingLevelSchema.or(z.literal("off")),
});

/** Rebuild factual tool accounting after native attach/overflow; not new tool completion events. */
export const ProgressToolsSnapshotSchema = z.object({
  ...progressScopeFields,
  type: z.literal("tools_snapshot"),
  tools: z.array(z.object({ tool: z.string(), toolCallId: z.string() })),
});

// --- Discriminated union ---

/** Observable phase only: never carries model reasoning or text deltas. */
export const ProgressActivitySchema = z.object({
  ...progressScopeFields,
  type: z.literal("activity"),
  activity: z.enum(["thinking", "working", "responding"]),
});

export const ProgressEventSchema = z.union([
  ProgressToolsSnapshotSchema,
  ProgressModelSchema,
  ProgressActivitySchema,
  ProgressStartSchema,
  ProgressToolSchema,
  ProgressMemorySchema,
  ProgressDelegateSchema,
  ProgressContextSchema,
  ProgressDoneSchema,
  ProgressErrorSchema,
  ProgressHeartbeatSchema,
]);

// --- Inferred types ---

export type ProgressStart = z.infer<typeof ProgressStartSchema>;
/** Model and reasoning effort selected for this task, scoped like other progress events. */
export type ProgressModel = z.infer<typeof ProgressModelSchema>;
export type ProgressTool = z.infer<typeof ProgressToolSchema>;
export type ProgressMemory = z.infer<typeof ProgressMemorySchema>;
export type ProgressDelegate = z.infer<typeof ProgressDelegateSchema>;
export type ProgressContext = z.infer<typeof ProgressContextSchema>;
export type ProgressDone = z.infer<typeof ProgressDoneSchema>;
export type ProgressError = z.infer<typeof ProgressErrorSchema>;
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
