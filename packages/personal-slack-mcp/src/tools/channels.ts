import { z } from "zod";
import type { SlackDeps } from "../slack-client.js";

export const ListChannelsInput = z.object({
  types: z
    .string()
    .default("public_channel,private_channel")
    .describe("Comma-separated channel types: public_channel, private_channel"),
  limit: z.number().min(1).max(200).default(100).describe("Max channels to return"),
  cursor: z.string().optional().describe("Pagination cursor"),
});

export const GetChannelHistoryInput = z.object({
  channel: z.string().describe("Channel ID (e.g. C0123456789)"),
  limit: z.number().min(1).max(100).default(50).describe("Max messages to return"),
  oldest: z.string().optional().describe("Only messages after this timestamp (Unix ts or ISO)"),
});

export async function listChannels(
  args: z.infer<typeof ListChannelsInput>,
  deps: SlackDeps,
) {
  const result = await deps.client.conversations.list({
    types: args.types,
    limit: args.limit,
    cursor: args.cursor,
    exclude_archived: true,
  });
  return {
    channels: (result.channels ?? []).map((ch) => ({
      id: ch.id,
      name: ch.name,
      is_private: ch.is_private,
      is_member: ch.is_member,
      topic: ch.topic?.value,
      purpose: ch.purpose?.value,
      num_members: ch.num_members,
    })),
    next_cursor: result.response_metadata?.next_cursor || undefined,
  };
}

export async function getChannelHistory(
  args: z.infer<typeof GetChannelHistoryInput>,
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
      reactions: msg.reactions,
    })),
    has_more: result.has_more,
  };
}
