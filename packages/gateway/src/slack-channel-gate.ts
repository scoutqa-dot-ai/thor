import {
  createLogger,
  isSlackChannelInProfile,
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
} from "./slack-api.js";

const log = createLogger("gateway-slack-channel-gate");

export { SLACK_GATE_DROP_REASON };

export type SlackChannelGateDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: typeof SLACK_GATE_DROP_REASON;
      workspaceConfigLoadFailed?: boolean;
    };

function evaluateProfileGate(input: {
  event: SlackChannelGateInput;
  workspaceConfigLoader?: ConfigLoader;
  logContext?: Record<string, unknown>;
}): SlackChannelGateDecision {
  try {
    const workspaceConfig = input.workspaceConfigLoader?.();
    if (workspaceConfig && isSlackChannelInProfile(workspaceConfig, input.event.channel)) {
      return { allowed: true };
    }
  } catch (error) {
    logError(log, "profile_gate_config_load_failed", error, {
      channel: input.event.channel,
      ...(input.logContext ?? {}),
    });
    return {
      allowed: false,
      reason: SLACK_GATE_DROP_REASON,
      workspaceConfigLoadFailed: true,
    };
  }

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
  return evaluateProfileGate(input);
}

export async function evaluateSlackChannelGate(input: {
  event: SlackChannelGateInput;
  slackDeps: SlackDeps;
  workspaceConfigLoader?: ConfigLoader;
  logContext?: Record<string, unknown>;
}): Promise<SlackChannelGateDecision> {
  const gated = await isSlackEventGated(input.event, input.slackDeps);
  if (!gated) return { allowed: true };

  return evaluateProfileGate(input);
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
