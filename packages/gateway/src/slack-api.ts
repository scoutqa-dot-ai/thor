import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { createLogger, logWarn } from "@thor/common";

const log = createLogger("gateway-slack-api");

/** Hard cap for any single Slack Web API call. Slack publishes p99 latencies
 * well under 1s; we set this to 10s so a hung request cannot stall the NDJSON
 * progress consumer indefinitely. */
const SLACK_API_TIMEOUT_MS = 10_000;

export type SlackBlock = KnownBlock;

export interface SlackDeps {
  client: WebClient;
}

export function createSlackClient(token: string, slackApiUrl?: string): WebClient {
  if (!token.trim()) {
    throw new Error("SLACK_BOT_TOKEN is required");
  }
  return new WebClient(token, {
    timeout: SLACK_API_TIMEOUT_MS,
    ...(slackApiUrl ? { slackApiUrl } : {}),
  });
}

export async function postMessage(
  channel: string,
  text: string,
  threadTs: string | undefined,
  deps: SlackDeps,
  blocks?: SlackBlock[],
): Promise<{ ts: string; channel: string }> {
  const result = await deps.client.chat.postMessage({
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(blocks ? { blocks } : {}),
  });
  return { ts: result.ts ?? "", channel: result.channel ?? channel };
}

export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  deps: SlackDeps,
  blocks?: SlackBlock[],
): Promise<void> {
  await deps.client.chat.update({
    channel,
    ts,
    text,
    ...(blocks ? { blocks } : {}),
  });
}

export async function deleteMessage(channel: string, ts: string, deps: SlackDeps): Promise<void> {
  await deps.client.chat.delete({ channel, ts });
}

export async function addReaction(
  channel: string,
  timestamp: string,
  name: string,
  deps: SlackDeps,
): Promise<void> {
  try {
    await deps.client.reactions.add({ channel, timestamp, name });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already_reacted")) {
      logWarn(log, "reaction_already_exists", { channel, timestamp, name });
      return;
    }
    throw error;
  }
}
