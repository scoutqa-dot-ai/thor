import { createLogger, logError } from "@thor/common";
import type { SlackDeps } from "./slack-api.js";

const log = createLogger("gateway-slack-channel-allowlist");

export interface SlackChannelPrivacyInput {
  channel: string;
  channel_type?: string;
}

export async function isSlackEventChannelPrivate(
  event: SlackChannelPrivacyInput,
  deps: SlackDeps,
): Promise<boolean> {
  if (event.channel_type === "group") return true;
  if (["channel", "im", "mpim"].includes(event.channel_type ?? "")) return false;

  try {
    const result = await deps.client.conversations.info({ channel: event.channel });
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
