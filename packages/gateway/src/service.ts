import {
  createLogger,
  ExecResultSchema,
  extractApprovalFailureCategory,
  hasSessionForCorrelationKey,
  logInfo,
  logWarn,
  logError,
  resolveRepoDirectory,
} from "@thor/common";
import type { ExecResult } from "@thor/common";
import type { SlackThreadEvent } from "./slack.js";
import type { CronPayload } from "./cron.js";
import {
  buildCorrelationKey,
  getGitHubEventLocalRepo,
  isCheckSuiteCompletedEvent,
  isIssueCommentEvent,
  isPendingBranchResolveKey,
  type GitHubWebhookEvent,
  type IssueCommentEvent,
} from "./github.js";
import type { WebClient } from "@slack/web-api";
import { addReaction, updateMessage, type SlackDeps } from "./slack-api.js";
import {
  resolvePrChecksTerminalState,
  verifyThorAuthoredSha,
  type PrCheckSummary,
  type PrChecksAggregateOutput,
} from "./github-gate.js";

/** SlackDeps stub for triggers that never post to Slack (cron, github). */
const NOOP_SLACK_DEPS: SlackDeps = { client: {} as WebClient };

const log = createLogger("gateway-service");
const INTERNAL_EXEC_TIMEOUT_MS = 5000;
const GITHUB_PR_CHECKS_RETRY_DELAY_MS = 30_000;

// --- Runner deps (internal HTTP, testable via fetchImpl) ---

export interface RunnerDeps {
  runnerUrl: string;
  fetchImpl?: typeof fetch;
}

export type BatchSource = "slack" | "cron" | "github" | "approval";
export type BatchLogPrefix = BatchSource | "mixed";

export interface RunnerTriggerOptions {
  prompt: string;
  correlationKey: string;
  triggerSlackId?: string;
  triggerGithubLogin?: string;
  directory: string;
  deps: RunnerDeps;
  interrupt?: boolean;
  onAccepted?: () => void;
  onRejected?: (reason: string) => void;
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
  githubEvents: GitHubWebhookEvent[];
  approvalOutcomes: ApprovalOutcomeEventPayload[];
  correlationKey: string;
  deps: RunnerDeps;
  slackDeps?: SlackDeps;
  remoteCliUrl?: string;
  internalSecret?: string;
  internalExec?: InternalExecClient;
  githubAppBotEmail?: string;
  githubPrChecksRetryDelayMs?: number;
  triggerSlackId?: string;
  triggerGithubLogin?: string;
  interrupt?: boolean;
  onAccepted?: () => void;
  onRejected?: (reason: string) => void;
  slackDirectoryForChannel?: (channel: string) => SlackRoutingInfo;
}

export interface SlackRoutingInfo {
  directory?: string;
  reason?: string;
  repoName?: string;
  source?: "default" | "override";
  overridePath?: string;
  fallbackReason?: string;
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
    }
  | {
      kind: "defer";
      logPrefix: BatchLogPrefix;
      reason: string;
      delayMs: number;
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

type TerminalGitHubRejectReason = "installation_gone" | "branch_not_found" | "branch_lookup_failed";

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

type DistilledSlackFile = {
  id?: string;
  file_access?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
};

type DistilledSlackEvent = {
  event_type: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  files?: DistilledSlackFile[];
  block_tags?: string[];
};

const SLACK_BLOCK_TAG_LIMIT = 50;
const SLACK_STRUCTURAL_BLOCK_TYPES = new Set([
  "rich_text",
  "rich_text_section",
  "rich_text_list",
  "rich_text_quote",
  "rich_text_preformatted",
  "section",
  "context",
]);

function addSlackBlockTag(tags: string[], seen: Set<string>, tag: string): void {
  if (tags.length >= SLACK_BLOCK_TAG_LIMIT || seen.has(tag)) return;
  seen.add(tag);
  tags.push(tag);
}

function extractSlackBlockTags(blocks: unknown): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  function walk(value: unknown): void {
    if (tags.length >= SLACK_BLOCK_TAG_LIMIT || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (tags.length >= SLACK_BLOCK_TAG_LIMIT) break;
        walk(item);
      }
      return;
    }
    if (typeof value !== "object") return;

    const node = value as Record<string, unknown>;
    const type = typeof node.type === "string" ? node.type : undefined;
    if (type !== undefined && SLACK_STRUCTURAL_BLOCK_TYPES.has(type)) {
      addSlackBlockTag(tags, seen, type);
    }

    if (type === "user" && typeof node.user_id === "string") {
      addSlackBlockTag(tags, seen, `user:${node.user_id}`);
    } else if (type === "channel" && typeof node.channel_id === "string") {
      addSlackBlockTag(tags, seen, `channel:${node.channel_id}`);
    } else if (type === "usergroup" && typeof node.usergroup_id === "string") {
      addSlackBlockTag(tags, seen, `usergroup:${node.usergroup_id}`);
    } else if (type === "broadcast" && typeof node.range === "string") {
      addSlackBlockTag(tags, seen, `broadcast:${node.range}`);
    } else if (type === "emoji" && typeof node.name === "string") {
      addSlackBlockTag(tags, seen, `emoji:${node.name}`);
    } else if (type === "link") {
      addSlackBlockTag(tags, seen, "link");
    } else if (type === "date") {
      addSlackBlockTag(tags, seen, "date");
    } else if (type === "file") {
      addSlackBlockTag(tags, seen, "file");
    }

    for (const child of Object.values(node)) {
      if (tags.length >= SLACK_BLOCK_TAG_LIMIT) break;
      walk(child);
    }
  }

  walk(blocks);
  return tags;
}

function distillSlackFiles(files: unknown): DistilledSlackFile[] | undefined {
  if (!Array.isArray(files)) return undefined;
  const distilled = files.flatMap((file): DistilledSlackFile[] => {
    if (file === null || typeof file !== "object") return [];
    const source = file as Record<string, unknown>;
    const output: DistilledSlackFile = {};
    if (typeof source.id === "string") output.id = source.id;
    if (typeof source.file_access === "string") output.file_access = source.file_access;
    if (typeof source.name === "string") output.name = source.name;
    if (typeof source.mimetype === "string") output.mimetype = source.mimetype;
    if (typeof source.filetype === "string") output.filetype = source.filetype;
    if (typeof source.size === "number") output.size = source.size;
    return Object.keys(output).length > 0 ? [output] : [];
  });
  return distilled.length > 0 ? distilled : undefined;
}

function distillSlackEvent(event: SlackThreadEvent): DistilledSlackEvent {
  const source = event as SlackThreadEvent & Record<string, unknown>;
  const distilled: DistilledSlackEvent = { event_type: event.type };
  if (typeof source.channel === "string") distilled.channel = source.channel;
  if (typeof source.ts === "string") distilled.ts = source.ts;
  if (typeof source.thread_ts === "string") distilled.thread_ts = source.thread_ts;
  if (typeof source.user === "string") distilled.user = source.user;
  if (typeof source.text === "string") distilled.text = source.text;

  const files = distillSlackFiles(source.files);
  if (files !== undefined) distilled.files = files;

  const blockTags = extractSlackBlockTags(source.blocks);
  if (blockTags.length > 0) distilled.block_tags = blockTags;

  return distilled;
}

function renderSlackRoutingSection(event: DistilledSlackEvent, routing: SlackRoutingInfo): string {
  if (!event.channel) return "";

  const lines = ["[Slack routing]"];
  if (routing.source === "override" && routing.overridePath) {
    lines.push(
      `Channel ${event.channel} routed to repo \`${routing.repoName}\` via override file \`${routing.overridePath}\`.`,
    );
    lines.push(
      `To route this channel to a different repo, replace the contents of \`${routing.overridePath}\` with that repo's directory name under /workspace/repos.`,
    );
  } else {
    lines.push(`Channel ${event.channel} routed to default repo \`${routing.repoName}\`.`);
    if (routing.fallbackReason) {
      lines.push(`A channel override was ignored because: ${routing.fallbackReason}.`);
    }
    if (routing.overridePath) {
      const verb = routing.fallbackReason ? "fix" : "set";
      lines.push(
        `To ${verb} a per-channel override, write directory name of an existing repo under /workspace/repos to \`${routing.overridePath}\`.`,
      );
    }
  }
  return lines.join("\n");
}

function renderSlackPrompt(
  events: SlackThreadEvent[],
  routing: SlackRoutingInfo,
  correlationKey: string,
): string {
  const distilledEvents = events.map(distillSlackEvent);
  const routingSection = hasSessionForCorrelationKey(correlationKey)
    ? ""
    : renderSlackRoutingSection(distilledEvents[0]!, routing);
  const eventSection = renderHeadedSection(
    "Slack",
    events,
    JSON.stringify(events.length === 1 ? distilledEvents[0] : distilledEvents),
  );
  return routingSection ? `${routingSection}\n\n${eventSection}` : eventSection;
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

export function buildApprovalOutcomePrompt(events: ApprovalOutcomeEventPayload[]): string {
  const lines = events.map((event, index) => {
    const target = [event.upstreamName, event.tool].filter(Boolean).join("/") || "unknown tool";
    const resolutionFailed =
      typeof event.resolutionExitCode === "number" && event.resolutionExitCode !== 0;
    const guidance = resolutionFailed
      ? event.decision === "approved"
        ? `human approved action \`${event.actionId}\`, but approval resolution reported a failure after the approval resolver already attempted the approved side effect; do not replay or re-run the same write/tool call, inspect approval status/output, explain the implication, and choose only a distinct safe recovery action`
        : `human rejected action \`${event.actionId}\`, but approval resolution reported a failure; inspect approval status/output, explain the implication, and choose the next safe action`
      : event.decision === "approved"
        ? `human approved action \`${event.actionId}\`; the approval resolver already executed or attempted the approved side effect, so do not replay or re-run the same write/tool call; inspect approval status/output if needed, report the result in-thread, and continue only with later distinct safe work`
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

function triggerActorFromSlackEvents(
  events: SlackThreadEvent[],
): Pick<RunnerTriggerOptions, "triggerSlackId"> {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const user = events[i]?.user;
    if (user) return { triggerSlackId: user };
  }
  return {};
}

function triggerActorFromGitHubEvents(
  events: GitHubWebhookEvent[],
): Pick<RunnerTriggerOptions, "triggerGithubLogin"> {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const login = events[i]?.sender.login;
    if (login) return { triggerGithubLogin: login };
  }
  return {};
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
  slackDirectoryForChannel?: (channel: string) => SlackRoutingInfo,
): SlackRoutingInfo {
  if (events.length === 0) return {};

  const resolveOne = (event: SlackThreadEvent): SlackRoutingInfo => {
    if (!slackDirectoryForChannel) {
      return { reason: `channel ${event.channel} has no repo mapping` };
    }
    return slackDirectoryForChannel(event.channel);
  };

  const first = resolveOne(events[0]!);
  if (first.reason) return { reason: first.reason };

  const directories = new Set<string>([first.directory!]);
  for (const event of events.slice(1)) {
    const result = resolveOne(event);
    if (result.reason) return { reason: result.reason };
    directories.add(result.directory!);
  }

  if (directories.size > 1) {
    return {
      reason: `Slack events for one correlation key resolved to multiple directories: ${[...directories].join(", ")}`,
    };
  }

  return first;
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

function resolveInternalExecClient(input: {
  internalExec?: InternalExecClient;
  remoteCliUrl?: string;
  internalSecret?: string;
  deps: RunnerDeps;
}): InternalExecClient | undefined {
  return (
    input.internalExec ??
    (input.remoteCliUrl
      ? createInternalExecClient({
          remoteCliUrl: input.remoteCliUrl,
          internalSecret: input.internalSecret,
          fetchImpl: input.deps.fetchImpl,
        })
      : undefined)
  );
}

async function prepareGitHubCheckSuiteEvents(input: {
  events: GitHubWebhookEvent[];
  internalExec: InternalExecClient;
  githubAppBotEmail: string;
  retryDelayMs: number;
}): Promise<
  | { ok: true; events: GitHubWebhookEvent[] }
  | { ok: false; kind: "drop"; reason: string }
  | { ok: false; kind: "defer"; reason: string; delayMs: number }
> {
  const prepared: GitHubWebhookEvent[] = [];

  for (const event of input.events) {
    if (!isCheckSuiteCompletedEvent(event)) {
      prepared.push(event);
      continue;
    }

    const localRepo = getGitHubEventLocalRepo(event);
    const directory = localRepo ? resolveRepoDirectory(localRepo) : undefined;
    if (!localRepo || !directory) {
      return { ok: false, kind: "drop", reason: "repo_not_mapped" };
    }

    const pullRequests = event.check_suite.pull_requests;
    if (pullRequests.length !== 1) {
      return {
        ok: false,
        kind: "drop",
        reason: pullRequests.length === 0 ? "check_suite_pr_missing" : "check_suite_pr_ambiguous",
      };
    }

    const gate = await verifyThorAuthoredSha({
      internalExec: input.internalExec,
      directory,
      sha: event.check_suite.head_sha,
      expectedEmail: input.githubAppBotEmail,
    });
    if (!gate.ok) {
      return { ok: false, kind: "drop", reason: "check_suite_gate_failed" };
    }

    const prChecks = await resolvePrChecksTerminalState({
      internalExec: input.internalExec,
      directory,
      prNumber: pullRequests[0]!.number,
    });
    if (!prChecks.ok) {
      if (prChecks.reason === "pr_checks_pending") {
        return {
          ok: false,
          kind: "defer",
          reason: "check_suite_pr_checks_pending",
          delayMs: input.retryDelayMs,
        };
      }
      return { ok: false, kind: "drop", reason: "check_suite_pr_checks_lookup_failed" };
    }

    prepared.push({
      ...event,
      thor: {
        pr_checks: prChecks.aggregate,
        pr_checks_summary: prChecks.checks,
      },
    } as GitHubWebhookEvent & {
      thor: {
        pr_checks: PrChecksAggregateOutput;
        pr_checks_summary: PrCheckSummary[];
      };
    });
  }

  return { ok: true, events: prepared };
}

function resolveApprovalBatchDirectory(
  events: ApprovalOutcomeEventPayload[],
  slackDirectoryForChannel?: (channel: string) => SlackRoutingInfo,
): { directory?: string; reason?: string } {
  return collectBatchDirectory("Approval", events, (event) => {
    if (!slackDirectoryForChannel) {
      return { reason: `channel ${event.channel} has no repo mapping` };
    }
    return slackDirectoryForChannel(event.channel);
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
      ...(options.triggerSlackId ? { triggerSlackId: options.triggerSlackId } : {}),
      ...(options.triggerGithubLogin ? { triggerGithubLogin: options.triggerGithubLogin } : {}),
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

  const json = (await response.json()) as Record<string, unknown>;
  if (json.busy === true) {
    return { busy: true };
  }
  options.onAccepted?.();
  return { busy: false };
}

export async function planBatchDispatch(input: BatchDispatchInput): Promise<BatchDispatchPlan> {
  const sources = getBatchSources(input);
  const logPrefix = getBatchLogPrefix(sources);
  let githubEvents = input.githubEvents;

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
    const internalExec = resolveInternalExecClient(input);
    if (!internalExec) {
      throw new Error(
        "internalExec or remoteCliUrl is required for pending GitHub branch resolution",
      );
    }
    try {
      const branchInfo = await resolveGitHubPrHead(latest, directory, internalExec);
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

  if (githubEvents.some(isCheckSuiteCompletedEvent)) {
    const internalExec = resolveInternalExecClient(input);
    if (!internalExec) {
      throw new Error("internalExec or remoteCliUrl is required for GitHub check_suite gating");
    }
    const prepared = await prepareGitHubCheckSuiteEvents({
      events: githubEvents,
      internalExec,
      githubAppBotEmail: input.githubAppBotEmail ?? "",
      retryDelayMs: input.githubPrChecksRetryDelayMs ?? GITHUB_PR_CHECKS_RETRY_DELAY_MS,
    });
    if (!prepared.ok) {
      if (prepared.kind === "defer") {
        return {
          kind: "defer",
          logPrefix,
          reason: prepared.reason,
          delayMs: prepared.delayMs,
        };
      }
      return { kind: "drop", logPrefix, reason: prepared.reason };
    }
    githubEvents = prepared.events;
  }

  const parts: DispatchPart[] = [];

  if (input.slackEvents.length > 0) {
    const slackDirectory = resolveSlackBatchDirectory(
      input.slackEvents,
      input.slackDirectoryForChannel,
    );
    if (slackDirectory.reason) {
      return { kind: "drop", logPrefix, reason: slackDirectory.reason };
    }
    const prompt = renderSlackPrompt(input.slackEvents, slackDirectory, input.correlationKey);
    parts.push({
      directory: slackDirectory.directory!,
      singlePrompt: prompt,
      mixedPrompt: prompt,
    });
  }

  if (githubEvents.length > 0) {
    const githubDirectory = resolveGitHubBatchDirectory(githubEvents);
    if (githubDirectory.reason) {
      return { kind: "drop", logPrefix, reason: githubDirectory.reason };
    }
    parts.push({
      directory: githubDirectory.directory!,
      singlePrompt: renderGitHubPrompt(githubEvents),
      mixedPrompt: renderGitHubPromptSection(githubEvents),
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
      input.slackDirectoryForChannel,
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

  const prompt =
    parts.length === 1 ? parts[0].singlePrompt : parts.map((part) => part.mixedPrompt).join("\n\n");

  return {
    kind: "dispatch",
    logPrefix,
    options: {
      prompt,
      correlationKey: input.correlationKey,
      ...(input.triggerSlackId ? { triggerSlackId: input.triggerSlackId } : {}),
      ...(input.triggerGithubLogin ? { triggerGithubLogin: input.triggerGithubLogin } : {}),
      directory: directories[0],
      deps: input.deps,
      interrupt: input.interrupt,
      onAccepted: input.onAccepted,
      onRejected: input.onRejected,
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
    if (plan.kind === "defer") {
      return { busy: true };
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
  slackDirectoryForChannel?: (channel: string) => SlackRoutingInfo,
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
    ...triggerActorFromSlackEvents(events),
    deps,
    slackDeps,
    interrupt,
    onAccepted,
    onRejected: handleRejected,
    slackDirectoryForChannel,
  });
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
    approvalOutcomes: [],
    correlationKey,
    ...triggerActorFromGitHubEvents(events),
    deps,
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

export async function triggerRunnerApprovalOutcomes(
  events: ApprovalOutcomeEventPayload[],
  correlationKey: string,
  deps: RunnerDeps,
  slackDeps: SlackDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  slackDirectoryForChannel?: (channel: string) => SlackRoutingInfo,
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
    slackDirectoryForChannel,
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
  internalSecret: string | undefined,
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
          ...(internalSecret ? { "x-thor-internal-secret": internalSecret } : {}),
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
  return body.exitCode !== 0 && extractApprovalFailureCategory(body.stderr) !== undefined;
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
