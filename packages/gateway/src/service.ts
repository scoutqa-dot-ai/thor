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
import type { ExecResult, ProgressEvent } from "@thor/common";
import { getSlackThreadTs, type SlackThreadEvent } from "./slack.js";
import type { CronPayload } from "./cron.js";
import {
  buildCorrelationKey,
  isPendingBranchResolveKey,
  type NormalizedGitHubEvent,
} from "./github.js";
import {
  buildApprovalButtonValue,
  buildInlineApprovalBlocks,
  formatApprovalArgs,
} from "./approval.js";
import { addReaction, updateMessage, postMessage, type SlackDeps } from "./slack-api.js";
import { handleProgressEvent } from "./progress-manager.js";

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

export type BatchSource = "slack" | "cron" | "github" | "approval";
export type BatchLogPrefix = BatchSource | "mixed";

export interface ProgressRelayTarget {
  channel: string;
  threadTs: string;
  triggerTs: string;
  slackDeps: SlackDeps;
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
  resolutionExitCode?: number;
}

export interface BatchDispatchInput {
  slackEvents: SlackThreadEvent[];
  cronEvents: CronPayload[];
  githubEvents: NormalizedGitHubEvent[];
  approvalOutcomes: ApprovalOutcomeEventPayload[];
  correlationKey: string;
  deps: RunnerDeps;
  slackDeps: SlackDeps;
  remoteCliUrl?: string;
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
      githubEvents: NormalizedGitHubEvent[];
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

function renderGitHubPromptSection(events: NormalizedGitHubEvent[]): string {
  return renderHeadedSection("GitHub", events, renderGitHubPrompt(events));
}

export function buildApprovalOutcomePrompt(events: ApprovalOutcomeEventPayload[]): string {
  const lines = events.map((event, index) => {
    const target = [event.upstreamName, event.tool].filter(Boolean).join("/") || "unknown tool";
    const resolutionFailed =
      typeof event.resolutionExitCode === "number" && event.resolutionExitCode !== 0;
    const guidance = resolutionFailed
      ? `human ${event.decision} action \`${event.actionId}\`, but approval resolution reported a failure; inspect approval status/output, explain the implication, and choose the next safe action`
      : event.decision === "approved"
        ? `human approved action \`${event.actionId}\`; continue the workflow, fetch approval status if needed, and finish the next safe step`
        : `human rejected action \`${event.actionId}\`; do not retry the same write blindly, explain the implication, and choose the next safe action`;

    const summary = event.resolutionSummary
      ? `\nResolution summary: ${event.resolutionSummary}`
      : "";

    return `${index + 1}. ${guidance}.\nReviewer: <@${event.reviewer}>\nTarget: ${target}\nThread: ${event.threadTs}${summary}`;
  });

  return `Approval outcome event${events.length > 1 ? "s" : ""}:\n\n${lines.join("\n\n")}`;
}

function getBatchSources(input: BatchDispatchInput): BatchSource[] {
  const sources: BatchSource[] = [];
  if (input.slackEvents.length > 0) sources.push("slack");
  if (input.githubEvents.length > 0) sources.push("github");
  if (input.cronEvents.length > 0) sources.push("cron");
  if (input.approvalOutcomes.length > 0) sources.push("approval");
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
  approvalOutcomes: ApprovalOutcomeEventPayload[],
  slackDeps: SlackDeps,
): ProgressRelayTarget | undefined {
  const lastSlackEvent = slackEvents[slackEvents.length - 1];
  if (lastSlackEvent) {
    return {
      channel: lastSlackEvent.channel,
      threadTs: getSlackThreadTs(lastSlackEvent),
      triggerTs: lastSlackEvent.ts,
      slackDeps,
    };
  }
  // Approval-outcome batches resume an existing Slack thread session — without
  // a progress target the resumed run goes silent (no progress, no further
  // approval cards) because triggerRunnerPrompt would background-drain the
  // NDJSON instead of forwarding events to Slack.
  const lastApproval = approvalOutcomes[approvalOutcomes.length - 1];
  if (lastApproval) {
    return {
      channel: lastApproval.channel,
      threadTs: lastApproval.threadTs,
      triggerTs: lastApproval.messageTs ?? lastApproval.threadTs,
      slackDeps,
    };
  }
  return undefined;
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

function resolveGitHubBatchDirectory(events: NormalizedGitHubEvent[]): {
  directory?: string;
  reason?: string;
} {
  return collectBatchDirectory("GitHub", events, (event) => {
    const directory = resolveRepoDirectory(event.localRepo);
    if (!directory) return { reason: `repo directory not found for ${event.localRepo}` };
    return { directory };
  });
}

function resolveCronBatchDirectory(events: CronPayload[]): { directory?: string; reason?: string } {
  return collectBatchDirectory("Cron", events, (event) => ({ directory: event.directory }));
}

function resolveApprovalBatchDirectory(
  events: ApprovalOutcomeEventPayload[],
  channelRepos?: Map<string, string>,
): { directory?: string; reason?: string } {
  return collectBatchDirectory("Approval", events, (event) => {
    const repo = channelRepos?.get(event.channel);
    if (!repo) return { reason: `channel ${event.channel} has no repo mapping` };
    const directory = resolveRepoDirectory(repo);
    if (!directory) return { reason: `repo directory not found for ${repo}` };
    return { directory };
  });
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
    const { channel, threadTs, triggerTs, slackDeps } = options.progressTarget;
    void consumeNdjsonStream(response, channel, threadTs, triggerTs, slackDeps).catch(
      async (err) => {
        logError(log, "stream_consume_error", err instanceof Error ? err.message : String(err));
        await forwardProgressEvent(
          channel,
          threadTs,
          { type: "error", error: err instanceof Error ? err.message : "stream error" },
          slackDeps,
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
    if (!input.remoteCliUrl) {
      throw new Error("remoteCliUrl is required for pending GitHub branch resolution");
    }

    const latest = input.githubEvents[input.githubEvents.length - 1];
    try {
      const branchInfo = await resolveGitHubPrHead(
        latest,
        input.remoteCliUrl,
        input.deps.fetchImpl,
      );
      if (branchInfo.headRepoFullName !== latest.repoFullName) {
        return { kind: "drop", logPrefix, reason: "fork_pr_unsupported" };
      }

      return {
        kind: "reroute",
        logPrefix: "github",
        fromCorrelationKey: input.correlationKey,
        toCorrelationKey: buildCorrelationKey(latest.localRepo, branchInfo.ref),
        githubEvents: input.githubEvents.map((event) => ({ ...event, branch: branchInfo.ref })),
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

  if (input.approvalOutcomes.length > 0) {
    const approvalDirectory = resolveApprovalBatchDirectory(
      input.approvalOutcomes,
      input.channelRepos,
    );
    if (approvalDirectory.reason) {
      return { kind: "drop", logPrefix, reason: approvalDirectory.reason };
    }
    const prompt = buildApprovalOutcomePrompt(input.approvalOutcomes);
    parts.push({
      directory: approvalDirectory.directory!,
      singlePrompt: prompt,
      mixedPrompt: prompt,
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

  const progressTarget = buildProgressTarget(
    input.slackEvents,
    input.approvalOutcomes,
    input.slackDeps,
  );
  // Cron-only batches have no Slack progress relay; drain in foreground so
  // callers can rely on cleanup happening before return.
  const isSilentOnly = sources.length === 1 && sources[0] === "cron";
  const backgroundDrain = !progressTarget && !isSilentOnly;
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
  slackDeps: SlackDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  channelRepos?: Map<string, string>,
  onRejected?: (reason: string) => void,
  approvalOutcomes?: ApprovalOutcomeEventPayload[],
): Promise<TriggerResult> {
  if (events.length === 0 && (!approvalOutcomes || approvalOutcomes.length === 0)) {
    return { busy: false };
  }

  const handleRejected = (reason: string) => {
    const last = events[events.length - 1];
    if (last) {
      logWarn(
        log,
        reason.includes("no repo mapping") ? "channel_has_no_repo" : "repo_directory_not_found",
        { channel: last.channel },
      );
    }
    onRejected?.(reason);
  };

  return dispatchBatch({
    slackEvents: events,
    cronEvents: [],
    githubEvents: [],
    approvalOutcomes: approvalOutcomes ?? [],
    correlationKey,
    deps,
    slackDeps,
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

async function drainResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;

  for await (const _ of body) {
    // discard
  }
}

/** Maximum bytes the newlineStream buffer is allowed to grow before forcing
 * a flush. Caps adversarial / runaway inputs that would otherwise OOM the
 * gateway (a single multi-MB NDJSON line). 1 MiB is well above any legitimate
 * progress event payload. */
const NDJSON_LINE_BYTE_LIMIT = 1 * 1024 * 1024;

/** TransformStream that splits chunks on newlines. */
function newlineStream(): TransformStream<string, string> {
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) controller.enqueue(part);
      if (buffer.length > NDJSON_LINE_BYTE_LIMIT) {
        // Drop the oversized partial line and reset; the next newline starts
        // a fresh line. The truncated event will fail JSON.parse downstream
        // and be skipped via the existing parse-error log.
        logWarn(log, "ndjson_line_too_large", { bufferedBytes: buffer.length });
        buffer = "";
      }
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
    approvalOutcomes: [],
    correlationKey,
    deps,
    slackDeps: { botToken: "", fetchImpl: deps.fetchImpl },
    interrupt,
    onAccepted,
    onRejected,
  });
}

export async function triggerRunnerGitHub(
  events: NormalizedGitHubEvent[],
  correlationKey: string,
  deps: RunnerDeps,
  remoteCliUrl: string,
  interrupt?: boolean,
  onAccepted?: () => void,
  onRejected?: (reason: string) => void,
): Promise<TriggerResult> {
  if (events.length === 0) return { busy: false };

  return dispatchBatch({
    slackEvents: [],
    cronEvents: [],
    githubEvents: events,
    approvalOutcomes: [],
    correlationKey,
    deps,
    slackDeps: { botToken: "", fetchImpl: deps.fetchImpl },
    remoteCliUrl,
    interrupt,
    onAccepted,
    onRejected,
  });
}

export async function triggerRunnerApprovalOutcomes(
  events: ApprovalOutcomeEventPayload[],
  correlationKey: string,
  deps: RunnerDeps,
  slackDeps: SlackDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  channelRepos?: Map<string, string>,
  onRejected?: (reason: string) => void,
): Promise<TriggerResult> {
  if (events.length === 0) return { busy: false };

  const handleRejected = (reason: string) => {
    const last = events[events.length - 1];
    if (last) {
      logWarn(
        log,
        reason.includes("no repo mapping") ? "channel_has_no_repo" : "repo_directory_not_found",
        { channel: last.channel },
      );
    }
    onRejected?.(reason);
  };

  return dispatchBatch({
    slackEvents: [],
    cronEvents: [],
    githubEvents: [],
    approvalOutcomes: events,
    correlationKey,
    deps,
    slackDeps,
    interrupt,
    onAccepted,
    onRejected: handleRejected,
    channelRepos,
  });
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
      const response = await getFetch(fetchImpl)(url, {
        signal: AbortSignal.timeout(GITHUB_PR_HEAD_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { ref?: string; headRepoFullName?: string };
        const ref = body.ref?.trim();
        const headRepoFullName = body.headRepoFullName?.trim();
        if (!ref || !headRepoFullName) {
          throw new TerminalGitHubDispatchError(
            "branch_lookup_failed",
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
          "branch_not_found",
          "Remote-cli /github/pr-head returned 404",
        );
      }
      if (response.status >= 500) {
        if (attempt < GITHUB_PR_HEAD_RETRIES) {
          continue;
        }
        throw new TerminalGitHubDispatchError(
          "branch_lookup_failed",
          `Remote-cli /github/pr-head returned ${response.status} after retries`,
        );
      }
      throw new Error(`Remote-cli /github/pr-head returned ${response.status}`);
    } catch (error) {
      if (error instanceof TerminalGitHubDispatchError) {
        throw error;
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        if (attempt < GITHUB_PR_HEAD_RETRIES) {
          continue;
        }
        throw new TerminalGitHubDispatchError(
          "branch_lookup_failed",
          "Remote-cli /github/pr-head timed out after retries",
        );
      }
      if (error instanceof TypeError && attempt >= GITHUB_PR_HEAD_RETRIES) {
        throw new TerminalGitHubDispatchError(
          "branch_lookup_failed",
          `Remote-cli /github/pr-head request failed after retries: ${error.message}`,
        );
      }
      if (attempt < GITHUB_PR_HEAD_RETRIES) {
        continue;
      }
      throw error;
    }
  }

  throw new TerminalGitHubDispatchError(
    "branch_lookup_failed",
    "Remote-cli /github/pr-head failed",
  );
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
  const body = truncate(event.body.replace(/\s+/g, " ").trim(), GITHUB_PROMPT_EVENT_BODY_MAX);
  return `[${event.senderLogin}] ${event.action} on ${event.repoFullName}#${event.number} (${event.eventType}): ${body}\n${event.htmlUrl}`;
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

const APPROVAL_RESOLVE_MAX_ATTEMPTS = 3;
const APPROVAL_RESOLVE_BACKOFF_MS = [200, 800];

/**
 * Resolve an approval action through the remote-cli MCP endpoint.
 *
 * Retries on transient failures (timeouts, 5xx, network errors). Without
 * retries a single remote-cli blip silently drops the human's approval
 * click — Slack already saw 200 from /slack/interactivity, so the click
 * cannot be replayed.
 */
export async function resolveApproval(
  actionId: string,
  decision: "approved" | "rejected",
  reviewer: string,
  remoteCliUrl: string,
  resolveSecret: string | undefined,
  fetchImpl?: typeof fetch,
  reason?: string,
): Promise<ExecResult | undefined> {
  const fetchFn = getFetch(fetchImpl);
  const args = ["resolve", actionId, decision, reviewer];
  if (reason) args.push(reason);

  for (let attempt = 0; attempt < APPROVAL_RESOLVE_MAX_ATTEMPTS; attempt++) {
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
      if (!response.ok) {
        logError(
          log,
          "approval_resolve_error",
          `remote-cli returned ${response.status}: ${body.stderr || body.stdout || "unknown error"}`,
          { remoteCliUrl, attempt },
        );
        if (response.status >= 500 && attempt + 1 < APPROVAL_RESOLVE_MAX_ATTEMPTS) {
          await delay(APPROVAL_RESOLVE_BACKOFF_MS[attempt] ?? 0);
          continue;
        }
        return undefined;
      }
      if (body.exitCode !== 0) {
        logError(
          log,
          "approval_resolve_error",
          `remote-cli returned ${response.status}: ${body.stderr || body.stdout || "unknown error"}`,
          { remoteCliUrl, attempt },
        );
        return isResolvedApprovalExecutionFailure(body) ? body : undefined;
      }
      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(log, "approval_resolve_error", message, { remoteCliUrl, attempt });
      if (attempt + 1 < APPROVAL_RESOLVE_MAX_ATTEMPTS) {
        await delay(APPROVAL_RESOLVE_BACKOFF_MS[attempt] ?? 0);
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isResolvedApprovalExecutionFailure(body: ExecResult): boolean {
  return (
    body.exitCode !== 0 &&
    (/^Error calling "/m.test(body.stderr) || /^Unknown upstream "/m.test(body.stderr))
  );
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
