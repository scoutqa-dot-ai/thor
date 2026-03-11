import type { WebClient } from "@slack/web-api";
import { z } from "zod/v4";
import type { SlackThreadEvent } from "./slack.js";

// --- Runner deps (internal HTTP, testable via fetchImpl) ---

export interface RunnerDeps {
  runnerUrl: string;
  fetchImpl?: typeof fetch;
}

const RunnerTriggerResponseSchema = z.object({
  sessionId: z.string().optional(),
  correlationKey: z.string().optional(),
  error: z.string().optional(),
});

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

/**
 * Fire-and-forget trigger to the runner.
 * Sends the raw Slack event payloads as the prompt — the agent's system
 * instructions (build.md) handle interpretation and reply decisions.
 */
export async function triggerRunner(
  events: SlackThreadEvent[],
  correlationKey: string,
  deps: RunnerDeps,
): Promise<void> {
  if (events.length === 0) return;

  const prompt =
    events.length === 1
      ? `Slack event:\n\n${JSON.stringify(events[0])}`
      : `Slack events:\n\n${JSON.stringify(events)}`;
  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      correlationKey,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const parsed = text ? RunnerTriggerResponseSchema.safeParse(JSON.parse(text)) : undefined;
    const errorMsg = parsed?.success ? parsed.data.error : undefined;
    throw new Error(errorMsg || `Runner returned ${response.status}`);
  }
}

export async function hasRunnerSession(correlationKey: string, deps: RunnerDeps): Promise<boolean> {
  try {
    const response = await getFetch(deps.fetchImpl)(
      `${deps.runnerUrl}/sessions?correlationKey=${encodeURIComponent(correlationKey)}`,
    );
    return response.ok;
  } catch {
    return false;
  }
}

// --- Slack deps (uses @slack/web-api WebClient) ---

export interface SlackDeps {
  slack: WebClient;
}

export async function addSlackReaction(
  channel: string,
  timestamp: string,
  reaction: string,
  deps: SlackDeps,
): Promise<void> {
  await deps.slack.reactions.add({
    channel,
    timestamp,
    name: reaction,
  });
}
