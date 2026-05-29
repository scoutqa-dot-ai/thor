import {
  createLogger,
  getSlackPrivateChannelAllowlist,
  logError,
  logWarn,
  type ConfigLoader,
} from "@thor/common";
import {
  addReaction,
  getCachedSlackChannelGate,
  isSlackEventGated,
  SLACK_GATE_DROP_REASON,
  type SlackChannelGateInput,
  type SlackDeps,
} from "./slack-api.ts";

const log = createLogger("gateway-slack-channel-gate");

export { SLACK_GATE_DROP_REASON };

export type SlackChannelGateDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: typeof SLACK_GATE_DROP_REASON;
      workspaceConfigLoadFailed?: boolean;
    };

function evaluateAllowlist(input: {
  event: SlackChannelGateInput;
  workspaceConfigLoader?: ConfigLoader;
  logContext?: Record<string, unknown>;
}): SlackChannelGateDecision {
  let allowlist: string[] = [];
  try {
    const workspaceConfig = input.workspaceConfigLoader?.();
    allowlist = workspaceConfig ? getSlackPrivateChannelAllowlist(workspaceConfig) : [];
  } catch (error) {
    logError(log, "private_channel_allowlist_config_load_failed", error, {
      channel: input.event.channel,
      ...(input.logContext ?? {}),
    });
    return {
      allowed: false,
      reason: SLACK_GATE_DROP_REASON,
      workspaceConfigLoadFailed: true,
    };
  }

  if (allowlist.includes(input.event.channel)) return { allowed: true };
  return { allowed: false, reason: SLACK_GATE_DROP_REASON };
}

export function evaluateCachedSlackChannelGate(input: {
  event: SlackChannelGateInput;
  workspaceConfigLoader?: ConfigLoader;
  logContext?: Record<string, unknown>;
}): SlackChannelGateDecision | undefined {
  const gated = getCachedSlackChannelGate(input.event.channel);
  if (gated === undefined) return undefined;
  if (!gated) return { allowed: true };
  return evaluateAllowlist(input);
}

export async function evaluateSlackChannelGate(input: {
  event: SlackChannelGateInput;
  slackDeps: SlackDeps;
  workspaceConfigLoader?: ConfigLoader;
  logContext?: Record<string, unknown>;
}): Promise<SlackChannelGateDecision> {
  const gated = await isSlackEventGated(input.event, input.slackDeps);
  if (!gated) return { allowed: true };

  return evaluateAllowlist(input);
}

export function addSlackGateRejectedReaction(
  event: { channel: string; ts: string },
  deps: SlackDeps,
  logContext: Record<string, unknown> = {},
): void {
  void addReaction(event.channel, event.ts, "lock", deps).catch((err) =>
    logWarn(log, "slack_gate_rejected_reaction_failed", {
      channel: event.channel,
      ts: event.ts,
      error: err instanceof Error ? err.message : String(err),
      ...logContext,
    }),
  );
}
