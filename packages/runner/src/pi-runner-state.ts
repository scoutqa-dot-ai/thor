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
  SlackReplyAdmissionSchema,
} from "@thor/common";

const triggerFieldsSchema = z.object({
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
  slackReplyAdmission: SlackReplyAdmissionSchema.optional(),
  triggerGithubLogin: z.string().trim().min(1).optional(),
  interrupt: z.boolean().default(false),
  directory: z.string().min(1),
  stream: z.boolean().default(false),
});
function hasExclusivePiModelOverride(
  value: Pick<z.infer<typeof triggerFieldsSchema>, "modelProfile" | "modelId">,
): boolean {
  return value.modelProfile === undefined || value.modelId === undefined;
}

/** Validated trigger request; stream delivery is not part of durable work identity. */
export const piTriggerRequestSchema = triggerFieldsSchema.refine(
  hasExclusivePiModelOverride,
  "Pi model routing overrides cannot combine modelProfile and modelId",
);
/** Neo trigger input retained inside the conversation for admission recovery. */
export type PiTriggerRequest = z.infer<typeof piTriggerRequestSchema>;

const legacyReceiptSchema = z
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
    request: triggerFieldsSchema
      .omit({ slackReplyAdmission: true })
      .strict()
      .refine(hasExclusivePiModelOverride),
    slackTeamId: z.string().optional(),
    googleAuthWaiting: z.boolean().optional(),
    googleAuthSource: GoogleAuthContinuationSchema.safeExtend({
      originalRequestId: z.string(),
    }).optional(),
    status: z.enum(["accepted", "completed", "error", "aborted"]),
  })
  .strict();
function refineEscalationEvidence(
  value: Pick<z.infer<typeof legacyReceiptSchema>, "modelSelection" | "escalationCalls">,
  ctx: z.RefinementCtx,
) {
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
}
const legacyMetadataSchema = z.strictObject({
  anchorId: z.string().regex(UUID_V7_RE),
  directory: z.string(),
  correlationKey: z.string().optional(),
  activeRequestId: z.string().optional(),
  receipts: z.array(legacyReceiptSchema.superRefine(refineEscalationEvidence)),
});
const version2ReceiptSchema = legacyReceiptSchema
  .omit({
    status: true,
    googleAuthWaiting: true,
    request: true,
  })
  .safeExtend({
    request: triggerFieldsSchema
      .omit({ prompt: true, routingTask: true, slackReplyAdmission: true })
      .strict()
      .refine(hasExclusivePiModelOverride),
    admission: z.discriminatedUnion("state", [
      z.strictObject({ state: z.literal("intent"), prompt: z.string() }),
      z.strictObject({ state: z.literal("submitted") }),
      z.strictObject({ state: z.literal("withdrawn"), at: z.number().finite() }),
    ]),
    // Completion observation fixes duration; it never decides native execution status.
    observation: z
      .strictObject({
        settledAt: z.number().finite(),
        historyEnd: z.number().int().positive().optional(),
      })
      .optional(),
    authorization: z.enum(["waiting", "waiting_unconfirmed", "unavailable", "clear"]).optional(),
  })
  .strict()
  .superRefine(refineEscalationEvidence);
const deliveryPolicySchema = z.discriminatedUnion("owner", [
  z.strictObject({ owner: z.literal("tool") }),
  z.strictObject({ owner: z.literal("host"), target: SlackReplyAdmissionSchema }),
]);
const dispositionSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending") }),
  z.strictObject({ state: z.literal("confirmed"), ts: SlackMessageTsSchema }),
  z.strictObject({ state: z.literal("uncertain") }),
  z.strictObject({ state: z.literal("rejected") }),
]);
const publicationSchema = z
  .strictObject({
    answerEntry: z.number().int().positive(),
    target: SlackReplyAdmissionSchema,
    disposition: dispositionSchema,
    chunks: z.array(dispositionSchema).max(64),
  })
  .superRefine((publication, ctx) => {
    const last = publication.chunks.at(-1);
    if (
      (publication.disposition.state === "confirmed" &&
        (!publication.chunks.length ||
          publication.chunks.some((chunk) => chunk.state !== "confirmed") ||
          last?.state !== "confirmed" ||
          last.ts !== publication.disposition.ts)) ||
      (publication.disposition.state === "rejected" &&
        publication.chunks.some((chunk) => chunk.state === "confirmed"))
    )
      ctx.addIssue({ code: "custom", message: "Pi publication disposition invalid" });
  });
const receiptSchema = version2ReceiptSchema
  .safeExtend({
    delivery: deliveryPolicySchema,
    publication: publicationSchema.optional(),
    slackFooterTs: z.string().min(1).optional(),
  })
  .superRefine((receipt, ctx) => {
    const target = receipt.delivery.owner === "host" ? receipt.delivery.target : undefined;
    if (
      (target &&
        (!receipt.request.triggerSlackId ||
          !receipt.request.messageTs ||
          receipt.request.triggerGithubLogin ||
          target.teamId !== receipt.slackTeamId ||
          !receipt.request.correlationKey ||
          (receipt.request.correlationKey.startsWith("slack:thread:") &&
            receipt.request.correlationKey !==
              `slack:thread:${target.channel}/${target.threadTs}`))) ||
      (receipt.publication &&
        (!target || JSON.stringify(target) !== JSON.stringify(receipt.publication.target)))
    )
      ctx.addIssue({ code: "custom", message: "Pi Slack delivery binding invalid" });
  });
/** Admission and publication evidence; native state remains the execution authority. */
export type PiAdmissionReceipt = z.infer<typeof receiptSchema>;

/** Versioned Neo metadata rejects hybrid lifecycle authority instead of dropping malformed fields. */
export const piConversationMetadataSchema = z
  .strictObject({
    version: z.literal(3),
    anchorId: z.string().regex(UUID_V7_RE),
    directory: z.string(),
    correlationKey: z.string().optional(),
    activeRequestId: z.string().optional(),
    receipts: z.array(receiptSchema),
  })
  .superRefine((value, ctx) => {
    if (
      value.receipts.some((receipt) => receipt.request.directory !== value.directory) ||
      new Set(value.receipts.map((receipt) => receipt.requestId)).size !== value.receipts.length ||
      (value.activeRequestId &&
        !value.receipts.some((receipt) => receipt.requestId === value.activeRequestId))
    )
      ctx.addIssue({ code: "custom", message: "Pi request binding is invalid" });
  });
/** Persistent identity and admissions; no credential or provider error enters this document. */
export const piConversationMetadataDoc = defineDoc<z.infer<typeof piConversationMetadataSchema>>({
  kind: "thor.pi.conversation",
  version: 3,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ version: 3, anchorId: "", directory: "", receipts: [] }),
  migrate: (value, fromVersion) => {
    if (fromVersion === 2) {
      const legacy = z
        .strictObject({
          version: z.literal(2),
          anchorId: z.string().regex(UUID_V7_RE),
          directory: z.string(),
          correlationKey: z.string().optional(),
          activeRequestId: z.string().optional(),
          receipts: z.array(version2ReceiptSchema),
        })
        .parse(value);
      return piConversationMetadataSchema.parse({
        ...legacy,
        version: 3,
        receipts: legacy.receipts.map((receipt) => ({ ...receipt, delivery: { owner: "tool" } })),
      });
    }
    if (fromVersion !== 1 || "version" in value)
      throw new Error("Pi metadata migration version invalid");
    const legacy = legacyMetadataSchema.parse(value);
    return piConversationMetadataSchema.parse({
      ...legacy,
      version: 3,
      receipts: legacy.receipts.map(({ status, googleAuthWaiting, request, ...receipt }) => {
        const { prompt, routingTask: _routingTask, ...authority } = request;
        return {
          ...receipt,
          request: authority,
          delivery: { owner: "tool" },
          // Legacy terminal fields are not execution evidence, including aborted. Startup must validate
          // any live native input before committing this provisional pre-submit withdrawal.
          admission:
            status === "aborted"
              ? { state: "withdrawn", at: receipt.startedAt }
              : status === "accepted"
                ? { state: "intent", prompt }
                : { state: "submitted" },
          ...(googleAuthWaiting ? { authorization: "waiting" } : {}),
        };
      }),
    });
  },
});
