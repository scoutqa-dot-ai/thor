import { createLogger, logWarn } from "@thor/common";

const log = createLogger("gateway-slack-api");

const DEFAULT_SLACK_API_BASE_URL = "https://slack.com/api";

export type SlackBlock = Record<string, unknown>;

export interface SlackDeps {
  botToken: string;
  fetchImpl?: typeof fetch;
  slackApiBaseUrl?: string;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

function getApiBaseUrl(slackApiBaseUrl?: string): string {
  return (slackApiBaseUrl ?? DEFAULT_SLACK_API_BASE_URL).replace(/\/$/, "");
}

async function callSlackApi<T extends SlackApiResponse>(
  method: string,
  payload: Record<string, unknown>,
  deps: SlackDeps,
): Promise<T> {
  if (!deps.botToken.trim()) {
    throw new Error(`Slack API ${method} failed: bot token not configured`);
  }

  const response = await getFetch(deps.fetchImpl)(
    `${getApiBaseUrl(deps.slackApiBaseUrl)}/${method}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(`Slack API ${method} failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as T;
  if (body.ok !== true) {
    throw new Error(`Slack API ${method} failed: ${body.error ?? "unknown_error"}`);
  }
  return body;
}

export async function postMessage(
  channel: string,
  text: string,
  threadTs: string | undefined,
  deps: SlackDeps,
  blocks?: SlackBlock[],
): Promise<{ ts: string; channel: string }> {
  const body = await callSlackApi<{ ok: true; ts?: string; channel?: string }>(
    "chat.postMessage",
    {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(blocks ? { blocks } : {}),
    },
    deps,
  );

  return { ts: body.ts ?? "", channel: body.channel ?? channel };
}

export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  deps: SlackDeps,
  blocks?: SlackBlock[],
): Promise<void> {
  await callSlackApi("chat.update", { channel, ts, text, ...(blocks ? { blocks } : {}) }, deps);
}

export async function deleteMessage(channel: string, ts: string, deps: SlackDeps): Promise<void> {
  await callSlackApi("chat.delete", { channel, ts }, deps);
}

export async function addReaction(
  channel: string,
  timestamp: string,
  name: string,
  deps: SlackDeps,
): Promise<void> {
  try {
    await callSlackApi("reactions.add", { channel, timestamp, name }, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already_reacted")) {
      logWarn(log, "reaction_already_exists", { channel, timestamp, name });
      return;
    }
    throw error;
  }
}
