import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";

const SLACK_SIGNATURE_VERSION = "v0";

const SlackAppMentionEventSchema = z
  .object({
    type: z.literal("app_mention"),
    user: z.string(),
    text: z.string(),
    ts: z.string(),
    channel: z.string(),
    thread_ts: z.string().optional(),
    bot_id: z.string().optional(),
  })
  .passthrough();

export const SUPPORTED_SLACK_MESSAGE_SUBTYPES = ["file_share", "thread_broadcast"] as const;

const nullableStringField = z.string().nullable().optional();
const nullableNumberField = z.number().nullable().optional();

const SlackFileMetadataSchema = z
  .object({
    id: nullableStringField,
    name: nullableStringField,
    title: nullableStringField,
    mimetype: nullableStringField,
    filetype: nullableStringField,
    url_private: nullableStringField,
    permalink: nullableStringField,
    size: nullableNumberField,
  })
  .passthrough();

const SlackMessageEventSchema = z
  .object({
    type: z.literal("message"),
    user: z.string().optional(),
    text: z.string().optional(),
    ts: z.string(),
    channel: z.string(),
    thread_ts: z.string().optional(),
    channel_type: z.enum(["channel", "im", "group", "mpim"]).optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    files: z.array(SlackFileMetadataSchema).optional(),
  })
  .passthrough();

const SlackReactionEventSchema = z.object({
  type: z.enum(["reaction_added", "reaction_removed"]),
  user: z.string(),
  reaction: z.string(),
  item: z.object({
    type: z.string(),
    channel: z.string().optional(),
    ts: z.string().optional(),
  }),
  event_ts: z.string(),
  item_user: z.string().optional(),
});

const SlackBotEventSchema = z.union([
  SlackAppMentionEventSchema,
  SlackMessageEventSchema,
  SlackReactionEventSchema,
]);

export const SlackEventEnvelopeSchema = z.object({
  type: z.literal("event_callback"),
  event_id: z.string(),
  team_id: z.string(),
  event: SlackBotEventSchema,
});

export const SlackUrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string(),
});

export const SlackInteractivityPayloadSchema = z.object({
  type: z.string().optional(),
  user: z
    .object({
      id: z.string(),
      username: z.string().optional(),
    })
    .optional(),
  actions: z
    .array(
      z.object({
        action_id: z.string(),
        value: z.string().optional(),
      }),
    )
    .optional(),
  channel: z
    .object({
      id: z.string(),
    })
    .optional(),
  message: z
    .object({
      ts: z.string(),
      thread_ts: z.string().optional(),
    })
    .optional(),
  container: z
    .object({
      type: z.string().optional(),
      message_ts: z.string().optional(),
      thread_ts: z.string().optional(),
      channel_id: z.string().optional(),
    })
    .optional(),
});

export type SlackAppMentionEvent = z.infer<typeof SlackAppMentionEventSchema>;
export type SlackMessageEvent = z.infer<typeof SlackMessageEventSchema>;
export type SlackReactionEvent = z.infer<typeof SlackReactionEventSchema>;
export type SlackBotEvent = z.infer<typeof SlackBotEventSchema>;
export type SlackEventEnvelope = z.infer<typeof SlackEventEnvelopeSchema>;
export type SlackUrlVerification = z.infer<typeof SlackUrlVerificationSchema>;
export type SlackInteractivityPayload = z.infer<typeof SlackInteractivityPayloadSchema>;
export type SlackInteractivityAction = NonNullable<SlackInteractivityPayload["actions"]>[number];

export function verifySlackSignature(input: {
  signingSecret: string;
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const { signingSecret, rawBody, signature, timestamp } = input;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = input.toleranceSeconds ?? 60 * 5;

  if (!signingSecret || !signature || !timestamp) {
    return false;
  }

  const requestTimestamp = Number(timestamp);
  if (!Number.isFinite(requestTimestamp)) {
    return false;
  }

  if (Math.abs(nowSeconds - requestTimestamp) > toleranceSeconds) {
    return false;
  }

  const basestring = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  const expected = `${SLACK_SIGNATURE_VERSION}=${createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;

  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export type SlackThreadEvent = SlackAppMentionEvent | SlackMessageEvent;

export function getSlackThreadTs(event: SlackThreadEvent): string {
  return event.thread_ts || event.ts;
}

export function getSlackCorrelationKey(event: SlackThreadEvent): string {
  return `slack:thread:${getSlackThreadTs(event)}`;
}

export function isSupportedSlackMessageSubtype(
  subtype: string | undefined,
): subtype is (typeof SUPPORTED_SLACK_MESSAGE_SUBTYPES)[number] {
  return (
    subtype !== undefined &&
    (SUPPORTED_SLACK_MESSAGE_SUBTYPES as readonly string[]).includes(subtype)
  );
}

export function isForwardableSlackMessage(event: SlackMessageEvent): boolean {
  return event.subtype === undefined || isSupportedSlackMessageSubtype(event.subtype);
}

export function parseSlackTs(ts: string): number {
  return Math.floor(parseFloat(ts) * 1000);
}

export function isSupportedSlackBotEvent(event: unknown): event is SlackBotEvent {
  return SlackBotEventSchema.safeParse(event).success;
}
