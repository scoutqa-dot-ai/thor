import type { WebClient } from "@slack/web-api";
import { createLogger, logInfo, logError, ProgressEventSchema } from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import { getSlackCorrelationKey, getSlackThreadTs, type SlackThreadEvent } from "./slack.js";
import { SlackNotifier } from "./slack-notifier.js";

const log = createLogger("gateway-service");

// --- Runner deps (internal HTTP, testable via fetchImpl) ---

export interface RunnerDeps {
  runnerUrl: string;
  fetchImpl?: typeof fetch;
}

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

/**
 * Trigger the runner and consume its NDJSON progress stream.
 * Posts/updates a Slack progress message in the originating thread.
 */
export async function triggerRunner(
  events: SlackThreadEvent[],
  correlationKey: string,
  deps: RunnerDeps,
  slackDeps: SlackDeps,
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
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }

  // Consume NDJSON stream and drive Slack progress updates
  const last = events[events.length - 1];
  const notifier = new SlackNotifier({
    slack: slackDeps.slack,
    channel: last.channel,
    threadTs: getSlackThreadTs(last),
  });

  try {
    await consumeNdjsonStream(response, notifier);
  } catch (err) {
    logError(log, "stream_consume_error", err instanceof Error ? err.message : String(err));
    await notifier.finish("error", err instanceof Error ? err.message : "stream error");
  }
}

/**
 * Reads an NDJSON response body line by line and drives the notifier.
 */
async function consumeNdjsonStream(response: Response, notifier: SlackNotifier): Promise<void> {
  const body = response.body;
  if (!body) return;

  const lines = body.pipeThrough(new TextDecoderStream()).pipeThrough(newlineStream());
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = ProgressEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      await handleProgressEvent(parsed.data, notifier);
    } catch {
      // Skip lines that aren't valid JSON
    }
  }
}

/** TransformStream that splits chunks on newlines. */
function newlineStream(): TransformStream<string, string> {
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) controller.enqueue(part);
    },
    flush(controller) {
      if (buffer) controller.enqueue(buffer);
    },
  });
}

async function handleProgressEvent(event: ProgressEvent, notifier: SlackNotifier): Promise<void> {
  switch (event.type) {
    case "tool":
      await notifier.onToolCall(event.tool);
      break;
    case "done":
      await notifier.finish(event.status === "completed" ? "completed" : "error", event.error);
      break;
    case "error":
      await notifier.finish("error", event.error);
      break;
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
