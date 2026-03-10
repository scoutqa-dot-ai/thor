import { z } from "zod/v4";
import {
  formatSlackReply,
  getSlackCorrelationKey,
  getSlackThreadTs,
  normalizeSlackPrompt,
  type SlackThreadEvent,
} from "./slack.js";

type FetchImpl = typeof fetch;

export interface SlackAppServiceDeps {
  runnerUrl: string;
  slackBotToken: string;
  fetchImpl?: FetchImpl;
}

const RunnerTriggerResponseSchema = z.object({
  sessionId: z.string().optional(),
  correlationKey: z.string().optional(),
  resumed: z.boolean().optional(),
  response: z.string().optional(),
  error: z.string().optional(),
});

export type RunnerTriggerResponse = z.infer<typeof RunnerTriggerResponseSchema>;

const SlackApiResponseSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
});

function getFetch(fetchImpl?: FetchImpl): FetchImpl {
  return fetchImpl ?? fetch;
}

export async function triggerRunner(
  event: SlackThreadEvent,
  deps: SlackAppServiceDeps,
  promptOverride?: string,
): Promise<RunnerTriggerResponse> {
  const prompt = promptOverride ?? normalizeSlackPrompt(event.text ?? "");
  if (!prompt) {
    return { error: "Received event with no actionable text." };
  }

  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      correlationKey: getSlackCorrelationKey(event),
    }),
  });

  const responseText = await response.text();
  const parsed = responseText
    ? RunnerTriggerResponseSchema.safeParse(JSON.parse(responseText))
    : undefined;
  const data = parsed?.success ? parsed.data : {};

  if (!response.ok) {
    throw new Error(data.error || `Runner returned ${response.status}`);
  }

  return data;
}

export async function postSlackReply(
  event: SlackThreadEvent,
  text: string,
  deps: SlackAppServiceDeps,
): Promise<void> {
  const response = await getFetch(deps.fetchImpl)("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: event.channel,
      thread_ts: getSlackThreadTs(event),
      text: formatSlackReply(text),
    }),
  });

  const raw = await response.json();
  const payload = SlackApiResponseSchema.parse(raw);

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Slack API returned ${response.status}`);
  }
}

export async function addSlackReaction(
  channel: string,
  timestamp: string,
  reaction: string,
  deps: SlackAppServiceDeps,
): Promise<void> {
  const response = await getFetch(deps.fetchImpl)("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, timestamp, name: reaction }),
  });

  const raw = await response.json();
  const payload = SlackApiResponseSchema.parse(raw);

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Slack API returned ${response.status}`);
  }
}

export async function hasRunnerSession(
  correlationKey: string,
  deps: SlackAppServiceDeps,
): Promise<boolean> {
  try {
    const response = await getFetch(deps.fetchImpl)(
      `${deps.runnerUrl}/sessions?correlationKey=${encodeURIComponent(correlationKey)}`,
    );
    return response.ok;
  } catch {
    return false;
  }
}
