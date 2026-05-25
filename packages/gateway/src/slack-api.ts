import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { createLogger, logError, logWarn } from "@thor/common";

const log = createLogger("gateway-slack-api");

/** Hard cap for any single Slack Web API call. Slack publishes p99 latencies
 * well under 1s; we set this to 10s so a hung request cannot stall the NDJSON
 * progress consumer indefinitely. */
const SLACK_API_TIMEOUT_MS = 10_000;

export type SlackBlock = KnownBlock;

export interface SlackDeps {
  client: WebClient;
}

export interface SlackChannelGateInput {
  channel: string;
  /**
   * Slack-supplied channel surface. Known values are `"channel"`, `"im"`,
   * `"group"`, `"mpim"`, but we accept any string so future Slack surfaces
   * (e.g. shared-channel envelopes) flow through the gate instead of being
   * rejected at schema validation. Only `"channel"` admits without a check;
   * anything else is gated.
   */
  channel_type?: string;
}

// Predates a scope broadening (now fires for DMs and MPIMs too); retained for log-grep continuity.
export const SLACK_GATE_DROP_REASON = "private_channel_not_allowlisted";

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

// Cache successful `conversations.info` results forever. The Slack workspace
// is configured to forbid creating new private channels, so private→public
// conversions are rare; a server restart is acceptable as the invalidation
// mechanism. Failures are not cached so a transient Slack outage doesn't
// permanently pin a channel as gated.
const channelGateCache = new Map<string, boolean>();

// Test hook: drops the in-memory channel gate cache so tests reusing channel ids
// across cases do not see leaked state. Not exported for production use.
export function __resetSlackChannelGateCacheForTests(): void {
  channelGateCache.clear();
}

// Returns true when the event must pass the allowlist to be admitted.
// Only `channel_type === "channel"` is admitted ungated; missing types are
// resolved via `conversations.info` and fail closed on any error.
export async function isSlackEventGated(
  event: SlackChannelGateInput,
  deps: SlackDeps,
): Promise<boolean> {
  if (event.channel_type === "channel") return false;
  if (event.channel_type !== undefined) return true;

  const cached = channelGateCache.get(event.channel);
  if (cached !== undefined) return cached;

  try {
    const result = await deps.client.conversations.info({ channel: event.channel });
    const channel = result.channel as
      | { is_private?: boolean; is_im?: boolean; is_mpim?: boolean }
      | undefined;
    const gated = !(
      channel?.is_private === false &&
      channel?.is_im !== true &&
      channel?.is_mpim !== true
    );
    channelGateCache.set(event.channel, gated);
    return gated;
  } catch (error) {
    logError(log, "slack_channel_privacy_lookup_failed", error, { channel: event.channel });
    return true;
  }
}
