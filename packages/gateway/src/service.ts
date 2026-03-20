import { createLogger, logInfo, logError, ProgressEventSchema } from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import { type GitHubEvent } from "./github.js";
import { getSlackCorrelationKey, getSlackThreadTs, type SlackThreadEvent } from "./slack.js";
import type { CronPayload } from "./cron.js";

const log = createLogger("gateway-service");

// --- Runner deps (internal HTTP, testable via fetchImpl) ---

export interface RunnerDeps {
  runnerUrl: string;
  fetchImpl?: typeof fetch;
}

// --- Slack MCP deps (HTTP calls to slack-mcp service) ---

export interface SlackMcpDeps {
  slackMcpUrl: string;
  fetchImpl?: typeof fetch;
}

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

/**
 * Trigger the runner and consume its NDJSON progress stream.
 * Forwards progress events to slack-mcp for Slack updates.
 */
export async function triggerRunnerSlack(
  events: SlackThreadEvent[],
  correlationKey: string,
  deps: RunnerDeps,
  slackMcpDeps: SlackMcpDeps,
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

  // Consume NDJSON stream and forward progress events to slack-mcp
  const last = events[events.length - 1];
  const channel = last.channel;
  const threadTs = getSlackThreadTs(last);

  try {
    await consumeNdjsonStream(response, channel, threadTs, slackMcpDeps);
  } catch (err) {
    logError(log, "stream_consume_error", err instanceof Error ? err.message : String(err));
    await forwardProgressEvent(
      channel,
      threadTs,
      { type: "error", error: err instanceof Error ? err.message : "stream error" },
      slackMcpDeps,
    );
  }
}

/**
 * Reads an NDJSON response body line by line and forwards events to slack-mcp.
 */
async function consumeNdjsonStream(
  response: Response,
  channel: string,
  threadTs: string,
  slackMcpDeps: SlackMcpDeps,
): Promise<void> {
  const body = response.body;
  if (!body) return;

  const lines = body.pipeThrough(new TextDecoderStream()).pipeThrough(newlineStream());
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = ProgressEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;

      if (parsed.data.type === "approval_required") {
        await forwardApprovalNotification(channel, threadTs, parsed.data, slackMcpDeps);
      } else {
        await forwardProgressEvent(channel, threadTs, parsed.data, slackMcpDeps);
      }
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

async function forwardProgressEvent(
  channel: string,
  threadTs: string,
  event: ProgressEvent,
  deps: SlackMcpDeps,
): Promise<void> {
  try {
    await getFetch(deps.fetchImpl)(`${deps.slackMcpUrl}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, threadTs, event }),
    });
  } catch (err) {
    logError(log, "progress_forward_error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Trigger the runner with a batch of GitHub events.
 * Combines multiple events into a single prompt, like the Slack handler.
 */
export async function triggerRunnerGitHub(
  events: GitHubEvent[],
  correlationKey: string,
  deps: RunnerDeps,
): Promise<void> {
  if (events.length === 0) return;

  const prompt =
    events.length === 1
      ? `GitHub ${events[0].event} event:\n\n${JSON.stringify(events[0].payload)}`
      : `GitHub events:\n\n${JSON.stringify(events.map((e) => ({ event: e.event, payload: e.payload })))}`;

  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, correlationKey }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }
}

/**
 * Trigger the runner with a cron job payload.
 * Consumes the response stream silently — the prompt itself should
 * instruct the agent where to post results (Slack, Linear, etc.).
 */
export async function triggerRunnerCron(
  payload: CronPayload,
  correlationKey: string,
  deps: RunnerDeps,
): Promise<void> {
  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: payload.prompt,
      correlationKey,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }

  // Consume stream silently to avoid backpressure
  const body = response.body;
  if (body) {
    for await (const _ of body) {
      // discard
    }
  }
}

async function forwardApprovalNotification(
  channel: string,
  threadTs: string,
  event: { actionId: string; tool: string; args: Record<string, unknown>; proxyPort?: number },
  deps: SlackMcpDeps,
): Promise<void> {
  try {
    await getFetch(deps.fetchImpl)(`${deps.slackMcpUrl}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel,
        threadTs,
        actionId: event.actionId,
        tool: event.tool,
        args: event.args,
        proxyPort: event.proxyPort,
      }),
    });
  } catch (err) {
    logError(log, "approval_forward_error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Resolve an approval action on a specific proxy instance.
 */
export async function resolveApproval(
  actionId: string,
  decision: "approved" | "rejected",
  reviewer: string,
  proxyUrl: string,
  fetchImpl?: typeof fetch,
  reason?: string,
): Promise<Record<string, unknown> | undefined> {
  const fetchFn = getFetch(fetchImpl);
  const body = JSON.stringify({ decision, reviewer, ...(reason ? { reason } : {}) });

  try {
    const response = await fetchFn(`${proxyUrl}/approval/${actionId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      logError(log, "approval_resolve_error", `Proxy returned ${response.status}: ${text}`, {
        proxyUrl,
      });
      return undefined;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (err) {
    logError(log, "approval_resolve_error", err instanceof Error ? err.message : String(err), {
      proxyUrl,
    });
    return undefined;
  }
}

export async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string,
  deps: SlackMcpDeps,
): Promise<void> {
  try {
    await getFetch(deps.fetchImpl)(`${deps.slackMcpUrl}/update-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, ts, text }),
    });
  } catch (err) {
    logError(log, "message_update_error", err instanceof Error ? err.message : String(err));
  }
}

export async function addSlackReaction(
  channel: string,
  timestamp: string,
  reaction: string,
  deps: SlackMcpDeps,
): Promise<void> {
  try {
    await getFetch(deps.fetchImpl)(`${deps.slackMcpUrl}/reaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, timestamp, reaction }),
    });
  } catch (err) {
    logError(log, "reaction_forward_error", err instanceof Error ? err.message : String(err));
  }
}
