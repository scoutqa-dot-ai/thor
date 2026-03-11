import { WebClient } from "@slack/web-api";

export type SlackDeps = {
  client: WebClient;
};

export async function postMessage(
  channel: string,
  text: string,
  threadTs: string | undefined,
  deps: SlackDeps,
): Promise<{ ts: string; channel: string }> {
  const result = await deps.client.chat.postMessage({
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  return { ts: result.ts ?? "", channel: result.channel ?? channel };
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  type?: string;
}

export async function readThread(
  channel: string,
  threadTs: string,
  limit: number,
  deps: SlackDeps,
): Promise<SlackMessage[]> {
  const result = await deps.client.conversations.replies({
    channel,
    ts: threadTs,
    limit,
  });
  return (result.messages ?? []) as SlackMessage[];
}

export async function getChannelHistory(
  channel: string,
  limit: number,
  deps: SlackDeps,
): Promise<SlackMessage[]> {
  const result = await deps.client.conversations.history({
    channel,
    limit,
  });
  return (result.messages ?? []) as SlackMessage[];
}
