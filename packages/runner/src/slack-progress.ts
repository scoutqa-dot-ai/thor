import { z } from "zod";
import type { KnownBlock } from "@slack/types";
import { WebClient, ErrorCode } from "@slack/web-api";
import {
  createLogger,
  logWarn,
  SlackMessageTsSchema,
  type ProgressTarget,
  type ProgressTransport,
  type ProgressBlock,
} from "@thor/common";

const log = createLogger("runner-slack-progress");
const SLACK_API_TIMEOUT_MS = 10_000;

export interface SlackProgressTransportTarget {
  channel: string;
  threadTs: string;
}

/** Resolve a thread delivery target while retaining the current human message for reactions. */
export function resolveSlackProgressTarget(
  correlationKey: string | undefined,
  source?: { messageTs?: string; runnerBaseUrl?: string },
): ProgressTarget<SlackProgressTransportTarget> | undefined {
  const match = /^slack:thread:([^/]+)\/(.+)$/.exec(correlationKey ?? "");
  if (!match) return undefined;
  const [, channel, threadTs] = match;
  return {
    key: `${channel}:${threadTs}`,
    sourceTs: source?.messageTs ?? threadTs,
    assetBaseUrl: source?.runnerBaseUrl,
    transportTarget: { channel, threadTs },
  };
}

/** One-call receipt: a lost/malformed response is uncertain, never safe to repost. */
export type SlackAnswerReceipt =
  | { state: "confirmed"; ts: string }
  | { state: "uncertain" }
  | { state: "rejected" };
/** Native lifecycle is optional on existing transports; legacy is explicitly verified, not a fallback. */
export interface SlackProgressTransport extends ProgressTransport<SlackProgressTransportTarget> {
  setStatus?(
    target: SlackProgressTransportTarget,
    status: "processing" | "suspended" | "active",
  ): Promise<{ state: "confirmed" | "unavailable" }>;
  statusMode?: "sessions" | "verified-legacy";
  postAnswer?(
    target: SlackProgressTransportTarget,
    text: string,
    blocks: ProgressBlock[],
  ): Promise<SlackAnswerReceipt>;
}

/** Slack SDK transport; status feature denial degrades to footer, without scope or app changes. */
export function createSlackProgressTransport(opts: {
  token: string;
  slackApiUrl?: string;
  /** Select only after an operator has verified this surface's legacy compatibility. */
  statusMode?: "sessions" | "verified-legacy";
}): SlackProgressTransport | undefined {
  if (!opts.token.trim()) return undefined;
  const client = new WebClient(opts.token, {
    timeout: SLACK_API_TIMEOUT_MS,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    ...(opts.slackApiUrl ? { slackApiUrl: opts.slackApiUrl } : {}),
  });
  return {
    statusMode: opts.statusMode ?? "sessions",
    async setStatus(target, status) {
      try {
        const legacy = opts.statusMode === "verified-legacy";
        // Installed SDK predates agents.sessions; generic apiCall is its supported extension point.
        const response = await client.apiCall(
          legacy ? "assistant.threads.setStatus" : "agents.sessions.setStatus",
          {
            channel_id: target.channel,
            thread_ts: target.threadTs,
            status: legacy
              ? status === "processing"
                ? "is working on your request..."
                : ""
              : status,
            ...(legacy && status === "processing"
              ? { loading_messages: ["Working on your request"] }
              : {}),
          },
        );
        const parsed = (
          legacy
            ? z.object({ ok: z.literal(true) })
            : z.object({ ok: z.literal(true), agent_status: z.literal(status) })
        ).safeParse(response);
        return { state: parsed.success ? "confirmed" : "unavailable" };
      } catch {
        return { state: "unavailable" };
      }
    },
    async postAnswer(target, text, blocks) {
      try {
        const response = await client.chat.postMessage({
          channel: target.channel,
          // SAFETY: final-answer owner constructs section/context blocks; SDK's KnownBlock union
          // cannot retain that evidence through the legacy transport's open ProgressBlock type.
          thread_ts: target.threadTs,
          text,
          blocks: blocks as KnownBlock[],
          unfurl_links: false,
          unfurl_media: false,
        });
        const parsed = z
          .object({ ok: z.literal(true), ts: SlackMessageTsSchema })
          .safeParse(response);
        return parsed.success ? { state: "confirmed", ts: parsed.data.ts } : { state: "uncertain" };
      } catch (error) {
        // Only explicit non-effect API denials prove rejection. HTTP/timeouts/internal errors may have sent.
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === ErrorCode.PlatformError &&
          "data" in error
        ) {
          const parsed = z.object({ error: z.string() }).safeParse(error.data);
          if (
            parsed.success &&
            [
              "channel_not_found",
              "not_in_channel",
              "no_permission",
              "missing_scope",
              "invalid_auth",
              "token_revoked",
              "is_archived",
              "msg_too_long",
              "invalid_blocks",
            ].includes(parsed.data.error)
          )
            return { state: "rejected" };
        }
        return { state: "uncertain" };
      }
    },
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
    async removeReaction(target, timestamp, name) {
      try {
        await client.reactions.remove({ channel: target.channel, timestamp, name });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("no_reaction") || message.includes("message_not_found")) return;
        throw error;
      }
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
