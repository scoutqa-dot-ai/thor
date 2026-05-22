import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { createLogger, logWarn, type ProgressTarget, type ProgressTransport } from "@thor/common";

const log = createLogger("runner-slack-progress");
const SLACK_API_TIMEOUT_MS = 10_000;

export interface SlackProgressTransportTarget {
  channel: string;
  threadTs: string;
}

export function resolveSlackProgressTarget(
  correlationKey: string | undefined,
): ProgressTarget<SlackProgressTransportTarget> | undefined {
  const match = /^slack:thread:([^/]+)\/(.+)$/.exec(correlationKey ?? "");
  if (!match) return undefined;
  const [, channel, threadTs] = match;
  return {
    key: `${channel}:${threadTs}`,
    sourceTs: threadTs,
    transportTarget: { channel, threadTs },
  };
}

export function createSlackProgressTransport(opts: {
  token: string;
  slackApiUrl?: string;
}): ProgressTransport<SlackProgressTransportTarget> | undefined {
  if (!opts.token.trim()) return undefined;
  const client = new WebClient(opts.token, {
    timeout: SLACK_API_TIMEOUT_MS,
    ...(opts.slackApiUrl ? { slackApiUrl: opts.slackApiUrl } : {}),
  });
  return {
    async post(target, text, blocks) {
      const result = await client.chat.postMessage({
        channel: target.channel,
        text,
        thread_ts: target.threadTs,
        ...(blocks ? { blocks: blocks as KnownBlock[] } : {}),
      });
      return { ts: result.ts ?? "" };
    },
    async update(target, messageTs, text, blocks) {
      await client.chat.update({
        channel: target.channel,
        ts: messageTs,
        text,
        ...(blocks ? { blocks: blocks as KnownBlock[] } : {}),
      });
    },
    async delete(target, messageTs) {
      await client.chat.delete({ channel: target.channel, ts: messageTs });
    },
    async addReaction(target, timestamp, name) {
      try {
        await client.reactions.add({ channel: target.channel, timestamp, name });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already_reacted")) {
          logWarn(log, "reaction_already_exists", { channel: target.channel, timestamp, name });
          return;
        }
        throw error;
      }
    },
  };
}
