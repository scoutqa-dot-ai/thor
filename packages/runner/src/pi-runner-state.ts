import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";
import { UUID_V7_RE } from "@thor/common";

/** Validated trigger request; stream delivery is not part of durable work identity. */
export const piTriggerRequestSchema = z.object({
  prompt: z.string(),
  requestId: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !/[\x00-\x1f]/.test(value))
    .optional(),
  correlationKey: z.string().min(1).max(512).optional(),
  sessionId: z.string().min(1).optional(),
  triggerSlackId: z.string().trim().min(1).optional(),
  triggerGithubLogin: z.string().trim().min(1).optional(),
  interrupt: z.boolean().default(false),
  directory: z.string().min(1),
  stream: z.boolean().default(false),
});
/** Neo trigger input retained inside the conversation for admission recovery. */
export type PiTriggerRequest = z.infer<typeof piTriggerRequestSchema>;

const receiptSchema = z.object({
  requestId: z.string(),
  fingerprint: z.string(),
  triggerId: z.string().regex(UUID_V7_RE),
  startedAt: z.number(),
  resumed: z.boolean(),
  request: piTriggerRequestSchema,
  status: z.enum(["accepted", "completed", "error", "aborted"]),
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
