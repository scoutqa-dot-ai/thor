import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  GoogleAuthContinuationSchema,
  SlackMessageTsSchema,
  UUID_V7_RE,
  PiTaskRoutingFields,
  PiModelSelectionSchema,
  PiModelProfileSchema,
  PiThinkingLevelSchema,
} from "@thor/common";

/** Validated trigger request; stream delivery is not part of durable work identity. */
export const piTriggerRequestSchema = z
  .object({
    ...PiTaskRoutingFields,
    prompt: z.string(),
    requestId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\x00-\x1f]/.test(value) && !value.startsWith("google-auth:"))
      .optional(),
    correlationKey: z.string().min(1).max(512).optional(),
    sessionId: z.string().min(1).optional(),
    triggerSlackId: z.string().trim().min(1).optional(),
    messageTs: SlackMessageTsSchema.optional(),
    triggerGithubLogin: z.string().trim().min(1).optional(),
    interrupt: z.boolean().default(false),
    directory: z.string().min(1),
    stream: z.boolean().default(false),
  })
  .refine(
    (value) => value.modelProfile === undefined || value.modelId === undefined,
    "Pi model routing overrides cannot combine modelProfile and modelId",
  );
/** Neo trigger input retained inside the conversation for admission recovery. */
export type PiTriggerRequest = z.infer<typeof piTriggerRequestSchema>;

const receiptSchema = z
  .object({
    requestId: z.string(),
    fingerprint: z.string(),
    // Native Durable documents require mutable JSON arrays; domain parsing restores readonly evidence.
    modelSelection: PiModelSelectionSchema.transform((value) => ({
      version: value.version,
      pool: {
        provider: value.pool.provider,
        profiles: value.pool.profiles,
        modelContextWindow: value.pool.modelContextWindow,
        modelSupportsImages: value.pool.modelSupportsImages,
        autoSelect: value.pool.autoSelect,
        defaultProfile: value.pool.defaultProfile,
        allowEscalation: value.pool.allowEscalation,
      },
      profile: value.profile,
      modelId: value.modelId,
      thinkingLevel: value.thinkingLevel,
      source: value.source,
      reason: value.reason,
      escalationLocked: value.escalationLocked,
      promotions: value.promotions,
      history: [...value.history],
    })).optional(),
    escalationCalls: z
      .array(
        z.strictObject({
          taskId: z.string().min(1),
          profile: PiModelProfileSchema,
          thinkingLevel: PiThinkingLevelSchema,
        }),
      )
      .max(2)
      .optional(),
    triggerId: z.string().regex(UUID_V7_RE),
    startedAt: z.number(),
    resumed: z.boolean(),
    request: piTriggerRequestSchema,
    slackTeamId: z.string().optional(),
    googleAuthWaiting: z.boolean().optional(),
    googleAuthSource: GoogleAuthContinuationSchema.safeExtend({
      originalRequestId: z.string(),
    }).optional(),
    status: z.enum(["accepted", "completed", "error", "aborted"]),
  })
  .superRefine((value, ctx) => {
    const calls = value.escalationCalls ?? [];
    if (
      calls.length !== (value.modelSelection?.promotions ?? 0) ||
      new Set(calls.map((call) => call.taskId)).size !== calls.length ||
      calls.some(
        (call, index) =>
          call.profile !== value.modelSelection?.history[index]?.to ||
          call.thinkingLevel !== value.modelSelection?.pool.profiles[call.profile].thinkingLevel,
      )
    )
      ctx.addIssue({ code: "custom", message: "Pi model escalation evidence is invalid" });
  });
/** Durable admission receipt is written before submit; the same request ID bridges the two commits. */
export type PiAdmissionReceipt = z.infer<typeof receiptSchema>;

/** Parse persisted Neo metadata before trusting it for identity or recovery. */
export const piConversationMetadataSchema = z.object({
  anchorId: z.string().regex(UUID_V7_RE),
  directory: z.string(),
  correlationKey: z.string().optional(),
  activeRequestId: z.string().optional(),
  receipts: z.array(receiptSchema),
});
/** Persistent identity and admissions; no credential or provider error enters this document. */
export const piConversationMetadataDoc = defineDoc<z.infer<typeof piConversationMetadataSchema>>({
  kind: "thor.pi.conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ anchorId: "", directory: "", receipts: [] }),
});
