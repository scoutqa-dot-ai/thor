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
import { buildCorrelationKey, type NormalizedGitHubEvent } from "./github.js";

const log = createLogger("gateway-service");
const GITHUB_PR_HEAD_TIMEOUT_MS = 3000;
const GITHUB_PR_HEAD_RETRIES = 1;
const GITHUB_PROMPT_LIMIT_BYTES = 8 * 1024;
const GITHUB_PROMPT_EVENT_BODY_MAX = 280;

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
export interface TriggerResult {
  /** True when the runner reported session busy and interrupt was false. */
  busy: boolean;
  /** True when the batch was terminally rejected (dead-lettered). */
  rejected?: boolean;
}

export interface GitHubPrHeadResult {
  ref: string;
  headRepoFullName: string;
}

type TerminalGitHubRejectReason = "installation_gone" | "branch_unresolved";

class TerminalGitHubDispatchError extends Error {
  constructor(readonly reason: TerminalGitHubRejectReason, message: string) {
    super(message);
    this.name = "TerminalGitHubDispatchError";
  }
}

export function getTerminalGitHubRejectReason(
  error: unknown,
): TerminalGitHubRejectReason | undefined {
  return error instanceof TerminalGitHubDispatchError ? error.reason : undefined;
}

export async function triggerRunnerSlack(
  events: SlackThreadEvent[],
  correlationKey: string,
  deps: RunnerDeps,
  slackMcpDeps: SlackMcpDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  channelRepos?: Map<string, string>,
  onRejected?: (reason: string) => void,
): Promise<TriggerResult> {
  if (events.length === 0) return { busy: false };

  const prompt =
    events.length === 1
      ? `Slack event:\n\n${JSON.stringify(events[0])}`
      : `Slack events:\n\n${JSON.stringify(events)}`;
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

  // Check for busy response (non-interrupt hit a running session)
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as Record<string, unknown>;
    if (json.busy === true) {
      return { busy: true };
    }
  }

  // Runner accepted — safe to delete queue files.
  onAccepted?.();

  // Consume NDJSON stream in the background so the queue handler can return
  // immediately. This keeps the per-key processing lock short (released as
  // soon as the runner accepts) while still forwarding progress events.
  const channel = last.channel;
  const threadTs = getSlackThreadTs(last);
  const triggerTs = last.ts;

  void consumeNdjsonStream(response, channel, threadTs, triggerTs, slackMcpDeps).catch(
    async (err) => {
      logError(log, "stream_consume_error", err instanceof Error ? err.message : String(err));
      await forwardProgressEvent(
        channel,
        threadTs,
        { type: "error", error: err instanceof Error ? err.message : "stream error" },
        slackMcpDeps,
        triggerTs,
      ).catch(() => {});
    },
  );

  return { busy: false };
}

/**
 * Reads an NDJSON response body line by line and forwards events to slack-mcp.
 */
async function consumeNdjsonStream(
  response: Response,
  channel: string,
  threadTs: string,
  triggerTs: string,
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
        await forwardApprovalNotification(channel, threadTs, event, slackMcpDeps);
        continue;
      }
      await forwardProgressEvent(channel, threadTs, event, slackMcpDeps, triggerTs);
    } catch (err) {
      logWarn(log, "ndjson_parse_skip", {
        line: truncate(line, 200),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function drainResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;

  for await (const _ of body) {
    // discard
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
  sourceTs: string,
): Promise<void> {
  try {
    await getFetch(deps.fetchImpl)(`${deps.slackMcpUrl}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, threadTs, sourceTs, event }),
    });
  } catch (err) {
    logError(log, "progress_forward_error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Trigger the runner with a cron job payload.
 * Consumes the response stream silently — the prompt itself should
 * instruct the agent where to post results (Slack, Atlassian, etc.).
 */
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
    // 4xx = client error (bad directory, invalid payload) — reject to dead-letter
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

  // Consume stream silently to avoid backpressure
  const body = response.body;
  if (body) {
    for await (const _ of body) {
      // discard
    }
  }

  return { busy: false };
}

export async function triggerRunnerGitHub(
  events: NormalizedGitHubEvent[],
  correlationKey: string,
  deps: RunnerDeps,
  remoteCliUrl: string,
  interrupt?: boolean,
  onAccepted?: () => void,
  _reposMap?: Map<string, string>,
  onRejected?: (reason: string) => void,
): Promise<TriggerResult> {
  if (events.length === 0) return { busy: false };

  let resolvedKey = correlationKey;
  if (resolvedKey.startsWith("pending:branch-resolve:")) {
    const latest = events[events.length - 1];
    try {
      const branchInfo = await resolveGitHubPrHead(latest, remoteCliUrl, deps.fetchImpl);
      if (branchInfo.headRepoFullName !== latest.repoFullName.toLowerCase()) {
        throw new TerminalGitHubDispatchError(
          "branch_unresolved",
          `PR head repo ${branchInfo.headRepoFullName} is not supported for ${latest.repoFullName}`,
        );
      }
      resolvedKey = buildCorrelationKey(latest.localRepo, branchInfo.ref);
    } catch (error) {
      if (error instanceof TerminalGitHubDispatchError) {
        onRejected?.(error.reason);
        return { busy: false, rejected: true };
      }
      throw error;
    }
  }

  const latest = events[events.length - 1];
  const directory = resolveRepoDirectory(latest.localRepo);
  if (!directory) {
    onRejected?.(`repo directory not found for ${latest.localRepo}`);
    return { busy: false, rejected: true };
  }

  const prompt = renderGitHubPrompt(events);
  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      correlationKey: resolvedKey,
      interrupt,
      directory,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status >= 400 && response.status < 500) {
      onRejected?.(`Runner returned ${response.status}: ${text}`);
      return { busy: false, rejected: true };
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

  void drainResponseBody(response).catch((err) => {
    logWarn(log, "github_response_drain_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { busy: false };
}

export async function resolveGitHubPrHead(
  event: NormalizedGitHubEvent,
  remoteCliUrl: string,
  fetchImpl?: typeof fetch,
): Promise<GitHubPrHeadResult> {
  const params = new URLSearchParams({
    installation: String(event.installationId),
    repo: event.repoFullName,
    number: String(event.number),
  });
  const url = `${remoteCliUrl}/github/pr-head?${params.toString()}`;

  for (let attempt = 0; attempt <= GITHUB_PR_HEAD_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(url, GITHUB_PR_HEAD_TIMEOUT_MS, fetchImpl);
      if (response.ok) {
        const body = (await response.json()) as { ref?: string; headRepoFullName?: string };
        const ref = body.ref?.trim();
        const headRepoFullName = body.headRepoFullName?.trim().toLowerCase();
        if (!ref || !headRepoFullName) {
          throw new TerminalGitHubDispatchError(
            "branch_unresolved",
            "Remote-cli /github/pr-head returned incomplete PR head info",
          );
        }
        return { ref, headRepoFullName };
      }

      if (response.status === 401 || response.status === 403) {
        throw new TerminalGitHubDispatchError(
          "installation_gone",
          `Remote-cli /github/pr-head returned ${response.status}`,
        );
      }
      if (response.status === 404) {
        throw new TerminalGitHubDispatchError(
          "branch_unresolved",
          "Remote-cli /github/pr-head returned 404",
        );
      }
      if (response.status >= 500) {
        if (attempt < GITHUB_PR_HEAD_RETRIES) {
          continue;
        }
        throw new TerminalGitHubDispatchError(
          "branch_unresolved",
          `Remote-cli /github/pr-head returned ${response.status} after retries`,
        );
      }
      throw new Error(`Remote-cli /github/pr-head returned ${response.status}`);
    } catch (error) {
      if (error instanceof TerminalGitHubDispatchError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        if (attempt < GITHUB_PR_HEAD_RETRIES) {
          continue;
        }
        throw new TerminalGitHubDispatchError(
          "branch_unresolved",
          "Remote-cli /github/pr-head timed out after retries",
        );
      }
      if (error instanceof TypeError && attempt >= GITHUB_PR_HEAD_RETRIES) {
        throw new TerminalGitHubDispatchError(
          "branch_unresolved",
          `Remote-cli /github/pr-head request failed after retries: ${error.message}`,
        );
      }
      if (attempt < GITHUB_PR_HEAD_RETRIES) {
        continue;
      }
      throw error;
    }
  }

  throw new TerminalGitHubDispatchError("branch_unresolved", "Remote-cli /github/pr-head failed");
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await getFetch(fetchImpl)(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function renderGitHubPrompt(events: NormalizedGitHubEvent[]): string {
  const lines = events.map((event) => renderGitHubPromptLine(event));
  let selected = [...lines];
  let prompt = selected.join("\n\n");

  while (selected.length > 1 && Buffer.byteLength(prompt, "utf8") > GITHUB_PROMPT_LIMIT_BYTES) {
    selected = selected.slice(1);
    prompt = selected.join("\n\n");
  }

  if (selected.length < lines.length) {
    logInfo(log, "github_prompt_truncated", {
      originalCount: lines.length,
      retainedCount: selected.length,
      droppedCount: lines.length - selected.length,
      bytes: Buffer.byteLength(prompt, "utf8"),
    });
  }

  return prompt;
}

function renderGitHubPromptLine(event: NormalizedGitHubEvent): string {
  const body = truncate(singleLine(event.body), GITHUB_PROMPT_EVENT_BODY_MAX);
  return `[${event.senderLogin}] ${event.action} on ${event.repoFullName}#${event.number} (${event.eventType}): ${body}\n${event.htmlUrl}`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function forwardApprovalNotification(
  channel: string,
  threadTs: string,
  event: { actionId: string; tool: string; args: Record<string, unknown>; proxyName?: string },
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
        proxyName: event.proxyName,
      }),
    });
  } catch (err) {
    logError(log, "approval_forward_error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Resolve an approval action through the remote-cli MCP endpoint.
 */
export async function resolveApproval(
  actionId: string,
  decision: "approved" | "rejected",
  reviewer: string,
  remoteCliUrl: string,
  resolveSecret: string | undefined,
  fetchImpl?: typeof fetch,
  reason?: string,
): Promise<Record<string, unknown> | undefined> {
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
    return body as Record<string, unknown>;
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
