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
  buildCorrelationKey,
  getGitHubEventLocalRepo,
  isIssueCommentEvent,
  isPendingBranchResolveKey,
  type GitHubWebhookEvent,
  type IssueCommentEvent,
} from "./github.js";

const log = createLogger("gateway-service");
const INTERNAL_EXEC_TIMEOUT_MS = 5000;

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

export type BatchSource = "slack" | "cron" | "github";
export type BatchLogPrefix = BatchSource | "mixed";

export interface ProgressRelayTarget {
  channel: string;
  threadTs: string;
  triggerTs: string;
  slackMcpDeps: SlackMcpDeps;
}

export interface RunnerTriggerOptions {
  prompt: string;
  correlationKey: string;
  directory: string;
  deps: RunnerDeps;
  interrupt?: boolean;
  onAccepted?: () => void;
  onRejected?: (reason: string) => void;
  progressTarget?: ProgressRelayTarget;
  backgroundDrain?: boolean;
  backgroundDrainLogEvent?: string;
}

export interface BatchDispatchInput {
  slackEvents: SlackThreadEvent[];
  cronEvents: CronPayload[];
  githubEvents: GitHubWebhookEvent[];
  correlationKey: string;
  deps: RunnerDeps;
  slackMcpDeps: SlackMcpDeps;
  remoteCliUrl?: string;
  internalSecret?: string;
  internalExec?: InternalExecClient;
  interrupt?: boolean;
  onAccepted?: () => void;
  onRejected?: (reason: string) => void;
  channelRepos?: Map<string, string>;
}

export type BatchDispatchPlan =
  | {
      kind: "dispatch";
      logPrefix: BatchLogPrefix;
      options: RunnerTriggerOptions;
    }
  | {
      kind: "drop";
      logPrefix: BatchLogPrefix;
      reason: string;
    }
  | {
      kind: "reroute";
      logPrefix: "github";
      fromCorrelationKey: string;
      toCorrelationKey: string;
      githubEvents: GitHubWebhookEvent[];
    };

interface DispatchPart {
  directory: string;
  singlePrompt: string;
  mixedPrompt: string;
}

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

export interface TriggerResult {
  /** True when the runner reported session busy and interrupt was false. */
  busy: boolean;
  /** True when the batch was terminally rejected (dead-lettered). */
  rejected?: boolean;
  /** Human-readable rejection reason; set when `rejected` is true. */
  reason?: string;
}

export interface GitHubPrHeadResult {
  ref: string;
  headRepoFullName: string;
}

export interface InternalExecRequest {
  bin: string;
  args: string[];
  cwd: string;
}

export type InternalExecClient = (request: InternalExecRequest) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

type TerminalGitHubRejectReason =
  | "installation_gone"
  | "branch_not_found"
  | "branch_lookup_failed"
  | "fork_pr_unsupported";

class TerminalGitHubDispatchError extends Error {
  constructor(
    readonly reason: TerminalGitHubRejectReason,
    message: string,
  ) {
    super(message);
    this.name = "TerminalGitHubDispatchError";
  }
}

function parseGhPrHead(stdout: string): GitHubPrHeadResult | null {
  const parsed = JSON.parse(stdout) as {
    headRefName?: unknown;
    headRepositoryOwner?: { login?: unknown } | null;
    headRepository?: { name?: unknown } | null;
  };
  const ref = typeof parsed.headRefName === "string" ? parsed.headRefName.trim() : "";
  const owner =
    typeof parsed.headRepositoryOwner?.login === "string"
      ? parsed.headRepositoryOwner.login.trim()
      : "";
  const repo =
    typeof parsed.headRepository?.name === "string" ? parsed.headRepository.name.trim() : "";
  if (!ref || !owner || !repo) return null;
  return { ref, headRepoFullName: `${owner}/${repo}` };
}

function classifyGhPrViewFailure(stderr: string): TerminalGitHubRejectReason {
  if (/http\s+40[13]|authentication|not logged in|forbidden|unauthorized/i.test(stderr)) {
    return "installation_gone";
  }
  if (/http\s+404|not found|could not resolve/i.test(stderr)) {
    return "branch_not_found";
  }
  return "branch_lookup_failed";
}

function renderHeadedSection(label: string, events: unknown[], body: string): string {
  const heading = events.length === 1 ? `${label} event` : `${label} events`;
  return `${heading}:\n\n${body}`;
}

function renderSlackPrompt(events: SlackThreadEvent[]): string {
  return renderHeadedSection(
    "Slack",
    events,
    JSON.stringify(events.length === 1 ? events[0] : events),
  );
}

function renderCronPrompt(events: CronPayload[]): string {
  return renderHeadedSection(
    "Cron",
    events,
    events.length === 1 ? events[0].prompt : events.map((event) => event.prompt).join("\n\n"),
  );
}

function renderGitHubPromptSection(events: GitHubWebhookEvent[]): string {
  return renderHeadedSection("GitHub", events, renderGitHubPrompt(events));
}

function getBatchSources(input: BatchDispatchInput): BatchSource[] {
  const sources: BatchSource[] = [];
  if (input.slackEvents.length > 0) sources.push("slack");
  if (input.githubEvents.length > 0) sources.push("github");
  if (input.cronEvents.length > 0) sources.push("cron");
  return sources;
}

export function getBatchLogPrefix(sources: BatchSource[]): BatchLogPrefix {
  return sources.length === 1 ? sources[0] : "mixed";
}

export function buildDispatchLogContext(input: {
  logPrefix: BatchLogPrefix;
  correlationKey?: string;
  batchSize: number;
  interrupt: boolean;
  sources: BatchSource[];
  reason?: string;
}): Record<string, unknown> {
  const context: Record<string, unknown> = {
    correlationKey: input.correlationKey,
    batchSize: input.batchSize,
  };
  if (input.logPrefix === "github" || input.logPrefix === "mixed") {
    context.interrupt = input.interrupt;
  }
  if (input.logPrefix === "mixed") {
    context.sources = input.sources;
  }
  if (input.reason) {
    context.reason = input.reason;
  }
  return context;
}

function buildProgressTarget(
  slackEvents: SlackThreadEvent[],
  slackMcpDeps: SlackMcpDeps,
): ProgressRelayTarget | undefined {
  const lastSlackEvent = slackEvents[slackEvents.length - 1];
  if (!lastSlackEvent) return undefined;
  return {
    channel: lastSlackEvent.channel,
    threadTs: getSlackThreadTs(lastSlackEvent),
    triggerTs: lastSlackEvent.ts,
    slackMcpDeps,
  };
}

function collectBatchDirectory<T>(
  label: string,
  events: T[],
  resolveOne: (event: T) => { directory?: string; reason?: string },
): { directory?: string; reason?: string } {
  if (events.length === 0) return {};

  const directories = new Set<string>();
  for (const event of events) {
    const result = resolveOne(event);
    if (result.reason) return { reason: result.reason };
    directories.add(result.directory!);
  }

  if (directories.size > 1) {
    return {
      reason: `${label} events for one correlation key resolved to multiple directories: ${[...directories].join(", ")}`,
    };
  }

  return { directory: [...directories][0] };
}

function resolveSlackBatchDirectory(
  events: SlackThreadEvent[],
  channelRepos?: Map<string, string>,
): { directory?: string; reason?: string } {
  return collectBatchDirectory("Slack", events, (event) => {
    const repo = channelRepos?.get(event.channel);
    if (!repo) return { reason: `channel ${event.channel} has no repo mapping` };
    const directory = resolveRepoDirectory(repo);
    if (!directory) return { reason: `repo directory not found for ${repo}` };
    return { directory };
  });
}

function resolveGitHubBatchDirectory(events: GitHubWebhookEvent[]): {
  directory?: string;
  reason?: string;
} {
  return collectBatchDirectory("GitHub", events, (event) => {
    const localRepo = getGitHubEventLocalRepo(event);
    if (!localRepo) return { reason: `repo directory not found for ${event.repository.full_name}` };
    const directory = resolveRepoDirectory(localRepo);
    if (!directory) return { reason: `repo directory not found for ${localRepo}` };
    return { directory };
  });
}

function resolveCronBatchDirectory(events: CronPayload[]): { directory?: string; reason?: string } {
  return collectBatchDirectory("Cron", events, (event) => ({ directory: event.directory }));
}

async function triggerRunnerPrompt(options: RunnerTriggerOptions): Promise<TriggerResult> {
  const response = await getFetch(options.deps.fetchImpl)(`${options.deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: options.prompt,
      correlationKey: options.correlationKey,
      interrupt: options.interrupt,
      directory: options.directory,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status >= 400 && response.status < 500) {
      const reason = `Runner returned ${response.status}: ${text}`;
      options.onRejected?.(reason);
      return { busy: false, rejected: true, reason };
    }
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  // JSON response means the runner returned a final status, not a stream.
  // Body is fully consumed by response.json() — skip the drain/stream paths
  // below, which would otherwise hit "ReadableStream is locked".
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as Record<string, unknown>;
    if (json.busy === true) {
      return { busy: true };
    }
    options.onAccepted?.();
    return { busy: false };
  }

  options.onAccepted?.();

  if (options.progressTarget) {
    const { channel, threadTs, triggerTs, slackMcpDeps } = options.progressTarget;
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

  if (options.backgroundDrain) {
    void drainResponseBody(response).catch((err) => {
      logWarn(log, options.backgroundDrainLogEvent ?? "runner_response_drain_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { busy: false };
  }

  await drainResponseBody(response);
  return { busy: false };
}

export async function planBatchDispatch(input: BatchDispatchInput): Promise<BatchDispatchPlan> {
  const sources = getBatchSources(input);
  const logPrefix = getBatchLogPrefix(sources);

  if (input.githubEvents.length > 0 && isPendingBranchResolveKey(input.correlationKey)) {
    const latest = input.githubEvents[input.githubEvents.length - 1];
    if (!latest || !isIssueCommentEvent(latest)) {
      return { kind: "drop", logPrefix, reason: "branch_lookup_failed" };
    }
    const localRepo = getGitHubEventLocalRepo(latest);
    if (!localRepo) {
      return { kind: "drop", logPrefix, reason: "branch_lookup_failed" };
    }
    const directory = resolveRepoDirectory(localRepo);
    if (!directory) {
      return { kind: "drop", logPrefix, reason: `repo directory not found for ${localRepo}` };
    }
    const internalExec =
      input.internalExec ??
      (input.remoteCliUrl
        ? createInternalExecClient({
            remoteCliUrl: input.remoteCliUrl,
            internalSecret: input.internalSecret,
            fetchImpl: input.deps.fetchImpl,
          })
        : undefined);
    if (!internalExec) {
      throw new Error(
        "internalExec or remoteCliUrl is required for pending GitHub branch resolution",
      );
    }
    try {
      const branchInfo = await resolveGitHubPrHead(latest, directory, internalExec);
      if (branchInfo.headRepoFullName !== latest.repository.full_name) {
        return { kind: "drop", logPrefix, reason: "fork_pr_unsupported" };
      }

      return {
        kind: "reroute",
        logPrefix: "github",
        fromCorrelationKey: input.correlationKey,
        toCorrelationKey: buildCorrelationKey(localRepo, branchInfo.ref),
        githubEvents: input.githubEvents,
      };
    } catch (error) {
      if (error instanceof TerminalGitHubDispatchError) {
        return { kind: "drop", logPrefix, reason: error.reason };
      }
      throw error;
    }
  }

  const parts: DispatchPart[] = [];

  if (input.slackEvents.length > 0) {
    const slackDirectory = resolveSlackBatchDirectory(input.slackEvents, input.channelRepos);
    if (slackDirectory.reason) {
      return { kind: "drop", logPrefix, reason: slackDirectory.reason };
    }
    const prompt = renderSlackPrompt(input.slackEvents);
    parts.push({
      directory: slackDirectory.directory!,
      singlePrompt: prompt,
      mixedPrompt: prompt,
    });
  }

  if (input.githubEvents.length > 0) {
    const githubDirectory = resolveGitHubBatchDirectory(input.githubEvents);
    if (githubDirectory.reason) {
      return { kind: "drop", logPrefix, reason: githubDirectory.reason };
    }
    parts.push({
      directory: githubDirectory.directory!,
      singlePrompt: renderGitHubPrompt(input.githubEvents),
      mixedPrompt: renderGitHubPromptSection(input.githubEvents),
    });
  }

  if (input.cronEvents.length > 0) {
    const cronDirectory = resolveCronBatchDirectory(input.cronEvents);
    if (cronDirectory.reason) {
      return { kind: "drop", logPrefix, reason: cronDirectory.reason };
    }
    parts.push({
      directory: cronDirectory.directory!,
      singlePrompt:
        input.cronEvents.length === 1
          ? input.cronEvents[0].prompt
          : renderCronPrompt(input.cronEvents),
      mixedPrompt: renderCronPrompt(input.cronEvents),
    });
  }

  const directories = [...new Set(parts.map((part) => part.directory))];
  if (directories.length === 0) {
    return { kind: "drop", logPrefix, reason: "no directory resolved for batch" };
  }
  if (directories.length > 1) {
    const reason =
      logPrefix === "mixed"
        ? `mixed-source batch resolved to multiple directories: ${directories.join(", ")}`
        : `${logPrefix} events for one correlation key resolved to multiple directories: ${directories.join(", ")}`;
    return { kind: "drop", logPrefix, reason };
  }

  const progressTarget = buildProgressTarget(input.slackEvents, input.slackMcpDeps);
  const isCronOnly = sources.length === 1 && sources[0] === "cron";
  const backgroundDrain = !progressTarget && !isCronOnly;
  const prompt =
    parts.length === 1 ? parts[0].singlePrompt : parts.map((part) => part.mixedPrompt).join("\n\n");

  return {
    kind: "dispatch",
    logPrefix,
    options: {
      prompt,
      correlationKey: input.correlationKey,
      directory: directories[0],
      deps: input.deps,
      interrupt: input.interrupt,
      onAccepted: input.onAccepted,
      onRejected: input.onRejected,
      progressTarget,
      backgroundDrain,
      backgroundDrainLogEvent: backgroundDrain ? `${logPrefix}_response_drain_error` : undefined,
    },
  };
}

export async function executeBatchDispatchPlan(
  plan: Extract<BatchDispatchPlan, { kind: "dispatch" }>,
): Promise<TriggerResult> {
  return triggerRunnerPrompt(plan.options);
}

async function dispatchBatch(input: BatchDispatchInput): Promise<TriggerResult> {
  let currentInput = input;

  for (;;) {
    const plan = await planBatchDispatch(currentInput);
    if (plan.kind === "drop") {
      currentInput.onRejected?.(plan.reason);
      return { busy: false, rejected: true, reason: plan.reason };
    }
    if (plan.kind === "reroute") {
      currentInput = {
        ...currentInput,
        correlationKey: plan.toCorrelationKey,
        githubEvents: plan.githubEvents,
      };
      continue;
    }
    return executeBatchDispatchPlan(plan);
  }
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

  const handleRejected = (reason: string) => {
    const last = events[events.length - 1];
    logWarn(
      log,
      reason.includes("no repo mapping") ? "channel_has_no_repo" : "repo_directory_not_found",
      { channel: last.channel },
    );
    onRejected?.(reason);
  };

  return dispatchBatch({
    slackEvents: events,
    cronEvents: [],
    githubEvents: [],
    correlationKey,
    deps,
    slackMcpDeps,
    interrupt,
    onAccepted,
    onRejected: handleRejected,
    channelRepos,
  });
}

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
  payload: CronPayload | CronPayload[],
  correlationKey: string,
  deps: RunnerDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  onRejected?: (reason: string) => void,
): Promise<TriggerResult> {
  return dispatchBatch({
    slackEvents: [],
    cronEvents: Array.isArray(payload) ? payload : [payload],
    githubEvents: [],
    correlationKey,
    deps,
    slackMcpDeps: { slackMcpUrl: "", fetchImpl: deps.fetchImpl },
    interrupt,
    onAccepted,
    onRejected,
  });
}

export async function triggerRunnerGitHub(
  events: GitHubWebhookEvent[],
  correlationKey: string,
  deps: RunnerDeps,
  remoteCliUrl: string,
  internalSecret?: string,
  interrupt?: boolean,
  onAccepted?: () => void,
  onRejected?: (reason: string) => void,
): Promise<TriggerResult> {
  if (events.length === 0) return { busy: false };

  return dispatchBatch({
    slackEvents: [],
    cronEvents: [],
    githubEvents: events,
    correlationKey,
    deps,
    slackMcpDeps: { slackMcpUrl: "", fetchImpl: deps.fetchImpl },
    remoteCliUrl,
    internalSecret,
    internalExec: createInternalExecClient({
      remoteCliUrl,
      internalSecret,
      fetchImpl: deps.fetchImpl,
    }),
    interrupt,
    onAccepted,
    onRejected,
  });
}

export async function resolveGitHubPrHead(
  event: IssueCommentEvent,
  directory: string,
  internalExec: InternalExecClient,
): Promise<GitHubPrHeadResult> {
  try {
    const result = await internalExec({
      bin: "gh",
      args: [
        "pr",
        "view",
        String(event.issue.number),
        "--repo",
        event.repository.full_name,
        "--json",
        "headRefName,headRepository,headRepositoryOwner",
      ],
      cwd: directory,
    });
    if (result.exitCode !== 0) {
      throw new TerminalGitHubDispatchError(
        classifyGhPrViewFailure(result.stderr),
        `gh pr view failed: ${result.stderr}`,
      );
    }
    const parsed = parseGhPrHead(result.stdout);
    if (!parsed) {
      throw new TerminalGitHubDispatchError(
        "branch_lookup_failed",
        "gh pr view returned incomplete PR head info",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof TerminalGitHubDispatchError) throw error;
    throw new TerminalGitHubDispatchError(
      "branch_lookup_failed",
      error instanceof Error ? error.message : "gh pr view failed",
    );
  }
}

export function createInternalExecClient(input: {
  remoteCliUrl: string;
  internalSecret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): InternalExecClient {
  const fetchFn = getFetch(input.fetchImpl);
  const timeoutMs = input.timeoutMs ?? INTERNAL_EXEC_TIMEOUT_MS;

  return async (request) => {
    const response = await fetchFn(`${input.remoteCliUrl}/internal/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.internalSecret ? { "x-thor-internal-secret": input.internalSecret } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Remote-cli /internal/exec returned ${response.status}`);
    }

    return ExecResultSchema.parse(await response.json());
  };
}

function renderGitHubPrompt(events: GitHubWebhookEvent[]): string {
  return JSON.stringify(events.length === 1 ? events[0] : events);
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
  internalSecret: string | undefined,
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
        ...(internalSecret ? { "x-thor-internal-secret": internalSecret } : {}),
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
