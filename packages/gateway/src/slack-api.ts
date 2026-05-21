import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { createLogger, logError, logWarn } from "@thor/common";

const log = createLogger("gateway-slack-api");

/** Hard cap for any single Slack Web API call. Slack publishes p99 latencies
 * well under 1s; we set this to 10s so a hung request cannot stall the NDJSON
 * progress consumer indefinitely. */
const SLACK_API_TIMEOUT_MS = 10_000;
const SLACK_PRIVACY_LOOKUP_TIMEOUT_MS = 1_500;

export type SlackBlock = KnownBlock;

export interface SlackDeps {
  client: WebClient;
}

export type SlackChannelType = "channel" | "im" | "group" | "mpim";

export interface SlackPrivateChannelGateInput {
  channel: string;
  channel_type?: SlackChannelType;
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

export async function isSlackEventInPrivateChannelScope(
  event: SlackPrivateChannelGateInput,
  deps: SlackDeps,
): Promise<boolean> {
  if (event.channel_type === "group") return true;
  if (["channel", "im", "mpim"].includes(event.channel_type ?? "")) return false;

  try {
    const result = await Promise.race([
      deps.client.conversations.info({ channel: event.channel }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("slack privacy lookup timed out")), SLACK_PRIVACY_LOOKUP_TIMEOUT_MS);
      }),
    ]);
    const channel = result.channel as
      | { is_private?: boolean; is_im?: boolean; is_mpim?: boolean }
      | undefined;
    if (channel?.is_im === true || channel?.is_mpim === true) return false;
    if (channel?.is_private === false) return false;
    return true;
  } catch (error) {
    logError(log, "slack_channel_privacy_lookup_failed", error, { channel: event.channel });
    return true;
  }
}

export function isSlackPrivateChannelAllowed(channel: string, allowlist: string[]): boolean {
  return allowlist.includes(channel);
}
