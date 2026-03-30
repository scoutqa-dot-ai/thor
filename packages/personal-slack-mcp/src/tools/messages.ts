import { z } from "zod";
import type { SlackDeps } from "../slack-client.js";

export const SearchMessagesInput = z.object({
  query: z.string().describe("Slack search query (supports from:, in:, has: modifiers)"),
  count: z.number().min(1).max(100).default(20).describe("Max results to return"),
  sort: z.enum(["score", "timestamp"]).default("timestamp").describe("Sort order"),
});

export const GetThreadRepliesInput = z.object({
  channel: z.string().describe("Channel ID"),
  ts: z.string().describe("Thread parent message timestamp"),
  limit: z.number().min(1).max(200).default(50).describe("Max replies to return"),
});

export async function searchMessages(
  args: z.infer<typeof SearchMessagesInput>,
  deps: SlackDeps,
) {
  const result = await deps.client.search.messages({
    query: args.query,
    count: args.count,
    sort: args.sort,
  });
  const matches = result.messages?.matches ?? [];
  return {
    total: result.messages?.total ?? 0,
    messages: matches.map((m) => ({
      text: m.text,
      user: m.user,
      ts: m.ts,
      channel: m.channel ? { id: m.channel.id, name: m.channel.name } : undefined,
      permalink: m.permalink,
    })),
  };
}

export async function getThreadReplies(
  args: z.infer<typeof GetThreadRepliesInput>,
  deps: SlackDeps,
) {
  const result = await deps.client.conversations.replies({
    channel: args.channel,
    ts: args.ts,
    limit: args.limit,
  });
  return {
    messages: (result.messages ?? []).map((msg) => ({
      user: msg.user,
      text: msg.text,
      ts: msg.ts,
      reactions: msg.reactions,
    })),
    has_more: result.has_more,
  };
}
