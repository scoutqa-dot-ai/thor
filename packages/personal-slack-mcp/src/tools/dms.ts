import { z } from "zod";
import type { SlackDeps } from "../slack-client.js";

export const ListDmsInput = z.object({
  types: z
    .string()
    .default("im,mpim")
    .describe("DM types: im (1:1), mpim (group DMs)"),
  limit: z.number().min(1).max(200).default(100).describe("Max conversations to return"),
  cursor: z.string().optional().describe("Pagination cursor"),
});

export const GetDmHistoryInput = z.object({
  channel: z.string().describe("DM channel ID"),
  limit: z.number().min(1).max(100).default(50).describe("Max messages to return"),
  oldest: z.string().optional().describe("Only messages after this timestamp"),
});

export async function listDms(
  args: z.infer<typeof ListDmsInput>,
  deps: SlackDeps,
) {
  const result = await deps.client.conversations.list({
    types: args.types,
    limit: args.limit,
    cursor: args.cursor,
    exclude_archived: true,
  });
  return {
    conversations: (result.channels ?? []).map((ch) => ({
      id: ch.id,
      user: ch.user,
      is_im: ch.is_im,
      is_mpim: ch.is_mpim,

    })),
    next_cursor: result.response_metadata?.next_cursor || undefined,
  };
}

export async function getDmHistory(
  args: z.infer<typeof GetDmHistoryInput>,
  deps: SlackDeps,
) {
  const result = await deps.client.conversations.history({
    channel: args.channel,
    limit: args.limit,
    oldest: args.oldest,
  });
  return {
    messages: (result.messages ?? []).map((msg) => ({
      user: msg.user,
      text: msg.text,
      ts: msg.ts,
      thread_ts: msg.thread_ts,
      reply_count: msg.reply_count,
    })),
    has_more: result.has_more,
  };
}
