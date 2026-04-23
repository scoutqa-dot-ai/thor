import {
  createLogger,
  ExecResultSchema,
  logInfo,
  logWarn,
  logError,
  truncate,
  ProgressEventSchema,
  resolveRepoDirectory,
} from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import { getSlackThreadTs, type SlackThreadEvent } from "./slack.js";
import type { CronPayload } from "./cron.js";
import {
  buildApprovalButtonValue,
  buildInlineApprovalBlocks,
  formatApprovalArgs,
} from "./approval.js";
import { addReaction, updateMessage, postMessage, type SlackDeps } from "./slack-api.js";
import { handleProgressEvent } from "./progress-manager.js";

const log = createLogger("gateway-service");

export interface RunnerDeps {
  runnerUrl: string;
  fetchImpl?: typeof fetch;
}

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

export interface TriggerResult {
  busy: boolean;
}

export interface ApprovalOutcomeEventPayload {
  actionId: string;
  decision: "approved" | "rejected";
  reviewer: string;
  channel: string;
  threadTs: string;
  upstreamName?: string;
  tool?: string;
  messageTs?: string;
  resolutionStatus?: string;
  resolutionSummary?: string;
}

function buildSlackPrompt(
  events: SlackThreadEvent[],
  approvalOutcomes: ApprovalOutcomeEventPayload[] = [],
): string {
  const slackSection =
    events.length === 1
      ? `Slack event:\n\n${JSON.stringify(events[0])}`
      : `Slack events:\n\n${JSON.stringify(events)}`;

  if (approvalOutcomes.length === 0) return slackSection;

  return `${slackSection}\n\n${buildApprovalOutcomePrompt(approvalOutcomes)}`;
}

export function buildApprovalOutcomePrompt(events: ApprovalOutcomeEventPayload[]): string {
  const lines = events.map((event, index) => {
    const target = [event.upstreamName, event.tool].filter(Boolean).join("/") || "unknown tool";
    const guidance =
      event.decision === "approved"
        ? `human approved action \`${event.actionId}\`; continue the workflow, fetch approval status if needed, and finish the next safe step`
        : `human rejected action \`${event.actionId}\`; do not retry the same write blindly, explain the implication, and choose the next safe action`;

    const summary = event.resolutionSummary
      ? `\nResolution summary: ${event.resolutionSummary}`
      : "";

    return `${index + 1}. ${guidance}.\nReviewer: <@${event.reviewer}>\nTarget: ${target}\nThread: ${event.threadTs}${summary}`;
  });

  return `Approval outcome event${events.length > 1 ? "s" : ""}:\n\n${lines.join("\n\n")}`;
}

export async function triggerRunnerSlack(
  events: SlackThreadEvent[],
  correlationKey: string,
  deps: RunnerDeps,
  slackDeps: SlackDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  channelRepos?: Map<string, string>,
  onRejected?: (reason: string) => void,
  approvalOutcomes?: ApprovalOutcomeEventPayload[],
): Promise<TriggerResult> {
  if (events.length === 0) return { busy: false };

  const prompt = buildSlackPrompt(events, approvalOutcomes);
  const last = events[events.length - 1];
  const repo = channelRepos?.get(last.channel);
  if (!repo) {
    logWarn(log, "channel_has_no_repo", { channel: last.channel });
    onRejected?.(`channel ${last.channel} has no repo mapping`);
    return { busy: false };
  }
  const directory = resolveRepoDirectory(repo);
  if (!directory) {
    logWarn(log, "repo_directory_not_found", { repo, channel: last.channel });
    onRejected?.(`repo directory not found for ${repo}`);
    return { busy: false };
  }
  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, correlationKey, interrupt, directory }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as Record<string, unknown>;
    if (json.busy === true) {
      return { busy: true };
    }
  }

  onAccepted?.();

  const channel = last.channel;
  const threadTs = getSlackThreadTs(last);
  const triggerTs = last.ts;

  void consumeNdjsonStream(response, channel, threadTs, triggerTs, slackDeps).catch(async (err) => {
    logError(log, "stream_consume_error", err instanceof Error ? err.message : String(err));
    await forwardProgressEvent(
      channel,
      threadTs,
      { type: "error", error: err instanceof Error ? err.message : "stream error" },
      slackDeps,
      triggerTs,
    ).catch(() => {});
  });

  return { busy: false };
}

async function consumeNdjsonStream(
  response: Response,
  channel: string,
  threadTs: string,
  triggerTs: string,
  slackDeps: SlackDeps,
): Promise<void> {
  const body = response.body;
  if (!body) return;

  const lines = body.pipeThrough(new TextDecoderStream()).pipeThrough(newlineStream());
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = ProgressEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const event = parsed.data;
      if (event.type === "heartbeat") continue;

      logInfo(log, "progress_relay", {
        channel,
        threadTs,
        type: event.type,
        ...(event.type === "tool" ? { tool: event.tool } : {}),
        ...(event.type === "done" ? { status: event.status } : {}),
        ts: Date.now(),
      });

      if (event.type === "approval_required") {
        await forwardApprovalNotification(channel, threadTs, event, slackDeps);
        continue;
      }
      await forwardProgressEvent(channel, threadTs, event, slackDeps, triggerTs);
    } catch (err) {
      logWarn(log, "ndjson_parse_skip", {
        line: truncate(line, 200),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

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
  deps: SlackDeps,
  sourceTs: string,
): Promise<void> {
  try {
    await handleProgressEvent(channel, threadTs, event, deps, sourceTs);
  } catch (err) {
    logError(log, "progress_forward_error", err instanceof Error ? err.message : String(err));
  }
}

export async function triggerRunnerCron(
  payload: CronPayload,
  correlationKey: string,
  deps: RunnerDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  onRejected?: (reason: string) => void,
): Promise<TriggerResult> {
  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: payload.prompt,
      correlationKey,
      interrupt,
      directory: payload.directory,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status >= 400 && response.status < 500) {
      onRejected?.(`Runner returned ${response.status}: ${text}`);
      return { busy: false };
    }
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as Record<string, unknown>;
    if (json.busy === true) {
      return { busy: true };
    }
  }

  onAccepted?.();

  const body = response.body;
  if (body) {
    for await (const _ of body) {
      // discard
    }
  }

  return { busy: false };
}

export async function triggerRunnerApprovalOutcomes(
  events: ApprovalOutcomeEventPayload[],
  correlationKey: string,
  deps: RunnerDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  channelRepos?: Map<string, string>,
  onRejected?: (reason: string) => void,
): Promise<TriggerResult> {
  if (events.length === 0) return { busy: false };

  const last = events[events.length - 1];
  const repo = channelRepos?.get(last.channel);
  if (!repo) {
    logWarn(log, "channel_has_no_repo", { channel: last.channel });
    onRejected?.(`channel ${last.channel} has no repo mapping`);
    return { busy: false };
  }

  const directory = resolveRepoDirectory(repo);
  if (!directory) {
    logWarn(log, "repo_directory_not_found", { repo, channel: last.channel });
    onRejected?.(`repo directory not found for ${repo}`);
    return { busy: false };
  }

  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: buildApprovalOutcomePrompt(events),
      correlationKey,
      interrupt,
      directory,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status >= 400 && response.status < 500) {
      onRejected?.(`Runner returned ${response.status}: ${text}`);
      return { busy: false };
    }
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as Record<string, unknown>;
    if (json.busy === true) {
      return { busy: true };
    }
  }

  onAccepted?.();

  const body = response.body;
  if (body) {
    for await (const _ of body) {
      // discard
    }
  }

  return { busy: false };
}

async function forwardApprovalNotification(
  channel: string,
  threadTs: string,
  event: { actionId: string; tool: string; args: Record<string, unknown>; proxyName?: string },
  deps: SlackDeps,
): Promise<void> {
  try {
    const argsJson = formatApprovalArgs(event.args);
    const buttonValue = buildApprovalButtonValue({
      actionId: event.actionId,
      upstreamName: event.proxyName,
      threadTs,
    });

    await postMessage(
      channel,
      `Approval required for \`${event.tool}\``,
      threadTs,
      deps,
      buildInlineApprovalBlocks(event.tool, argsJson, buttonValue),
    );
  } catch (err) {
    logError(log, "approval_forward_error", err instanceof Error ? err.message : String(err));
  }
}

export async function resolveApproval(
  actionId: string,
  decision: "approved" | "rejected",
  reviewer: string,
  remoteCliUrl: string,
  resolveSecret: string | undefined,
  fetchImpl?: typeof fetch,
  reason?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> {
  const fetchFn = getFetch(fetchImpl);
  const args = ["resolve", actionId, decision, reviewer];
  if (reason) args.push(reason);

  try {
    const response = await fetchFn(`${remoteCliUrl}/exec/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(resolveSecret ? { "x-thor-resolve-secret": resolveSecret } : {}),
      },
      body: JSON.stringify({ args }),
    });
    const body = ExecResultSchema.parse(await response.json());
    if (!response.ok || body.exitCode !== 0) {
      logError(
        log,
        "approval_resolve_error",
        `remote-cli returned ${response.status}: ${body.stderr || body.stdout || "unknown error"}`,
        { remoteCliUrl },
      );
      return undefined;
    }
    return body;
  } catch (err) {
    logError(log, "approval_resolve_error", err instanceof Error ? err.message : String(err), {
      remoteCliUrl,
    });
    return undefined;
  }
}

export async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string,
  deps: SlackDeps,
): Promise<void> {
  try {
    await updateMessage(channel, ts, text, deps);
  } catch (err) {
    logError(log, "message_update_error", err instanceof Error ? err.message : String(err));
  }
}

export async function addSlackReaction(
  channel: string,
  timestamp: string,
  reaction: string,
  deps: SlackDeps,
): Promise<void> {
  try {
    await addReaction(channel, timestamp, reaction, deps);
  } catch (err) {
    logError(log, "reaction_forward_error", err instanceof Error ? err.message : String(err));
  }
}
