import express, { type Express, type Request, type Response } from "express";
import {
  appendJsonlWorklog,
  buildSlackCorrelationKeys,
  createLogger,
  errorToMetadata,
  getWorkspaceWorktreesRoot,
  hasSessionForCorrelationKey,
  logError,
  logInfo,
  resolveExistingDirectoryWithinRoot,
  resolveCorrelationKeys,
  getAllowedChannelIds,
  getChannelRepoMap,
  truncate,
  resolveRepoDirectory,
  type ConfigLoader,
  type InboundWebhookHistoryEntry,
} from "@thor/common";
import { z } from "zod/v4";
import { EventQueue, type QueuedEvent } from "./queue.js";
import {
  addSlackReaction,
  buildDispatchLogContext,
  executeBatchDispatchPlan,
  getBatchLogPrefix,
  planBatchDispatch,
  resolveApproval,
  createInternalExecClient,
  updateSlackMessage,
  type ApprovalOutcomeEventPayload,
  type BatchLogPrefix,
  type BatchSource,
  type InternalExecClient,
  type RunnerDeps,
} from "./service.js";
import { createSlackClient, type SlackDeps } from "./slack-api.js";
import { verifyThorAuthoredSha } from "./github-gate.js";
import { deepHealthCheck } from "./healthcheck.js";
import {
  getSlackCorrelationKeys,
  isForwardableSlackMessage,
  isSupportedSlackMessageSubtype,
  parseSlackTs,
  SlackEventEnvelopeSchema,
  SlackInteractivityPayloadSchema,
  SlackUrlVerificationSchema,
  verifySlackSignature,
  type SlackInteractivityAction,
  type SlackInteractivityPayload,
  type SlackThreadEvent,
} from "./slack.js";
import { CronRequestSchema, deriveCronCorrelationKey, type CronPayload } from "./cron.js";
import {
  extractApprovalFailureCategory,
  parseApprovalButtonValue,
  type ApprovalButtonRoute,
} from "./approval.js";
import {
  buildCorrelationKey,
  buildIssueCorrelationKey,
  buildPendingBranchResolveKey,
  getGitHubEventBranch,
  getGitHubEventLocalRepo,
  getGitHubEventNumber,
  getGitHubEventSourceTs,
  getGitHubEventType,
  GitHubWebhookEnvelopeSchema,
  isPendingBranchResolveKey,
  isCheckSuiteCompletedEvent,
  isPullRequestClosedEvent,
  isPushEvent,
  isIssueCommentEvent,
  shouldIgnoreGitHubEvent,
  type GitHubWebhookEvent,
  type PushEvent,
  verifyGitHubSignature,
} from "./github.js";

interface SlackQueuedEvent extends QueuedEvent<SlackThreadEvent> {
  source: "slack";
}

interface CronQueuedEvent extends QueuedEvent<CronPayload> {
  source: "cron";
}

interface GitHubQueuedEvent extends QueuedEvent<GitHubWebhookEvent> {
  source: "github";
}

interface ApprovalQueuedEvent extends QueuedEvent<ApprovalOutcomeEventPayload> {
  source: "approval";
}

function isSlackEvent(e: QueuedEvent): e is SlackQueuedEvent {
  return e.source === "slack";
}

function isCronEvent(e: QueuedEvent): e is CronQueuedEvent {
  return e.source === "cron";
}

function isApprovalEvent(e: QueuedEvent): e is ApprovalQueuedEvent {
  return e.source === "approval";
}

function isGitHubEvent(e: QueuedEvent): e is GitHubQueuedEvent {
  return e.source === "github";
}

function summarizeResolutionOutput(
  stdout: string,
  stderr: string,
): {
  status?: string;
  summary?: string;
  tool?: string;
  upstream?: string;
} {
  let status: string | undefined;
  let summary: string | undefined;
  let tool: string | undefined;
  let upstream: string | undefined;

  // Avoid echoing raw stdout/stderr — both can contain upstream tool response
  // data, which the approval card must not leak. Only surface structured fields
  // and a sanitized failure category.
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.status === "string") status = parsed.status;
    if (typeof parsed.tool === "string") tool = parsed.tool;
    if (typeof parsed.upstream === "string") upstream = parsed.upstream;
    if (typeof parsed.error === "string" && parsed.error) {
      summary = parsed.error;
    } else if (typeof parsed.reason === "string" && parsed.reason) {
      summary = parsed.reason;
    }
  } catch {
    // non-JSON stdout: drop, do not surface
  }

  if (!summary) {
    summary = extractApprovalFailureCategory(stderr);
  }

  return { status, summary, tool, upstream };
}

const log = createLogger("gateway");

interface RawBodyRequest extends Request {
  rawBody?: string;
  rawBodyBuffer?: Buffer;
}

type HeaderValue = string | string[] | undefined;

function slackMessageHasFilesMetadata(event: { files?: unknown[] }): boolean {
  return Array.isArray(event.files) && event.files.length > 0;
}

function getHeaderSnapshot(req: Request, names: string[]): Record<string, HeaderValue> {
  const headers: Record<string, HeaderValue> = {};
  for (const name of names) {
    headers[name] = req.headers[name] as HeaderValue;
  }
  return headers;
}

function getRawBufferFromBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.alloc(0);
}

function buildJsonPayloadField(payload: unknown): Pick<InboundWebhookHistoryEntry, "payload"> {
  return { payload };
}

function buildNonJsonBodyField(
  rawBodyBuffer: Buffer,
): Pick<InboundWebhookHistoryEntry, "rawBodyBase64"> {
  return { rawBodyBase64: rawBodyBuffer.toString("base64") };
}

function buildUnsupportedGitHubBodyFields(
  rawBodyBuffer: Buffer,
): Pick<InboundWebhookHistoryEntry, "rawBodyUtf8" | "rawBodyBase64"> {
  const rawBodyUtf8 = rawBodyBuffer.toString("utf8");
  try {
    JSON.parse(rawBodyUtf8);
    return { rawBodyUtf8 };
  } catch {
    return buildNonJsonBodyField(rawBodyBuffer);
  }
}

type WebhookBodyPolicy =
  | { kind: "json"; payload: unknown }
  | { kind: "none" }
  | { kind: "base64"; rawBodyBuffer: Buffer }
  | { kind: "unsupported_github"; rawBodyBuffer: Buffer };

interface WebhookHistoryState {
  provider: "slack" | "github";
  route: "/slack/events" | "/github/webhook";
  headers: Record<string, HeaderValue>;
  rawBodyBuffer: Buffer;
  parsedPayload?: unknown;
  signatureVerified: boolean;
  parseStatus: string;
  requestId?: string;
  eventType?: string;
  action?: string;
  reason?: string;
  githubStream?: "ingested" | "ignored";
  bodyPolicy?: "default" | "unsupported_github";
  metadata?: Record<string, unknown>;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled webhook history outcome: ${JSON.stringify(value)}`);
}

function resolveWebhookBodyFields(
  body: WebhookBodyPolicy,
): Pick<InboundWebhookHistoryEntry, "payload" | "rawBodyUtf8" | "rawBodyBase64"> {
  switch (body.kind) {
    case "json":
      return buildJsonPayloadField(body.payload);
    case "none":
      return {};
    case "base64":
      return buildNonJsonBodyField(body.rawBodyBuffer);
    case "unsupported_github":
      return buildUnsupportedGitHubBodyFields(body.rawBodyBuffer);
    default:
      return assertNever(body);
  }
}

function resolveWebhookBodyPolicy(state: WebhookHistoryState): WebhookBodyPolicy {
  if (state.bodyPolicy === "unsupported_github") {
    return { kind: "unsupported_github", rawBodyBuffer: state.rawBodyBuffer };
  }
  if (state.parsedPayload !== undefined) {
    return { kind: "json", payload: state.parsedPayload };
  }
  if (!state.signatureVerified) {
    return { kind: "none" };
  }
  return { kind: "base64", rawBodyBuffer: state.rawBodyBuffer };
}

function resolveWebhookHistoryWrite(state: WebhookHistoryState): {
  stream: string;
  entry: InboundWebhookHistoryEntry;
} {
  const stream = (() => {
    switch (state.provider) {
      case "slack":
        return "slack-webhook";
      case "github":
        return state.githubStream === "ingested"
          ? GITHUB_WEBHOOK_INGESTED_STREAM
          : GITHUB_WEBHOOK_IGNORED_STREAM;
      default:
        return assertNever(state.provider);
    }
  })();

  return {
    stream,
    entry: {
      timestamp: new Date().toISOString(),
      route: state.route,
      provider: state.provider,
      signatureVerified: state.signatureVerified,
      parseStatus: state.parseStatus,
      requestId: state.requestId,
      eventType: state.eventType,
      action: state.action,
      reason: state.reason,
      headers: state.headers,
      ...resolveWebhookBodyFields(resolveWebhookBodyPolicy(state)),
      metadata: state.metadata,
    },
  };
}

function writeWebhookHistory(state: WebhookHistoryState): void {
  const { stream, entry } = resolveWebhookHistoryWrite(state);
  appendJsonlWorklog(stream, entry);
}

function parseRawJson(rawBodyBuffer: Buffer): { ok: true; payload: unknown } | { ok: false } {
  try {
    return { ok: true, payload: JSON.parse(rawBodyBuffer.toString("utf8")) };
  } catch {
    return { ok: false };
  }
}

function parseWebhookJson(history: WebhookHistoryState): unknown | undefined {
  const parsed = parseRawJson(history.rawBodyBuffer);
  if (!parsed.ok) return undefined;
  history.parsedPayload = parsed.payload;
  return parsed.payload;
}

function withWebhookHistory(
  provider: "slack" | "github",
  route: "/slack/events" | "/github/webhook",
  headerNames: string[],
  handler: (req: Request, res: Response, history: WebhookHistoryState) => void | Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    const rawBodyBuffer = getRawBufferFromBody(req.body);
    const history: WebhookHistoryState = {
      provider,
      route,
      headers: getHeaderSnapshot(req, headerNames),
      rawBodyBuffer,
      signatureVerified: false,
      parseStatus: "not_parsed",
      reason: "handled",
      githubStream: provider === "github" ? "ignored" : undefined,
      bodyPolicy: "default",
    };

    try {
      await handler(req, res, history);
    } catch (error) {
      history.reason = "handler_exception";
      history.metadata = { ...history.metadata, ...errorToMetadata(error) };
      throw error;
    } finally {
      writeWebhookHistory(history);
    }
  };
}

function isRawWebhookRoute(path: string): boolean {
  return /^\/(?:slack\/events|github\/webhook)\/?$/.test(path);
}

/** Short debounce delay for mentions and engaged threads (ms). */
const SHORT_DELAY_MS = 3000;
const GITHUB_MENTION_DELAY_MS = 3000;
const GITHUB_SUPPORTED_EVENTS = new Set([
  "issue_comment",
  "pull_request_review_comment",
  "pull_request_review",
  "pull_request",
  "check_suite",
  "push",
]);

type GitHubIgnoreReason =
  | "signature_invalid"
  | "event_unsupported"
  | "json_parse_error"
  | "schema_validation_failed"
  | "repo_not_mapped"
  | "self_sender"
  | "empty_review_body"
  | "non_mention_comment"
  | "check_suite_branch_missing"
  | "correlation_key_unresolved"
  | "check_suite_gate_failed";

const GITHUB_WEBHOOK_INGESTED_STREAM = "github-webhook-ingested";
const GITHUB_WEBHOOK_IGNORED_STREAM = "github-webhook-ignored";

async function resolveExistingWorktreePath(
  localRepo: string,
  branch: string,
): Promise<string | null> {
  return resolveExistingDirectoryWithinRoot(getWorkspaceWorktreesRoot(), `${localRepo}/${branch}`);
}

type PushStatus =
  | "push_sync_already_up_to_date"
  | "push_sync_default_branch_fast_forwarded"
  | "push_sync_default_branch_reset"
  | "push_sync_worktree_fast_forwarded"
  | "push_sync_worktree_reset"
  | "push_sync_worktree_missing"
  | "push_sync_non_branch_ref_ignored"
  | "push_sync_failed"
  | "push_wake_triggered"
  | "push_wake_skipped_no_session"
  | "push_delete_worktree_removed"
  | "push_delete_worktree_dirty"
  | "push_delete_worktree_missing"
  | "push_delete_default_branch_ignored"
  | "push_delete_non_branch_ref_ignored"
  | "push_delete_cleanup_failed";

const IGNORED_PUSH_STATUSES = new Set<PushStatus>([
  "push_sync_already_up_to_date",
  "push_sync_worktree_missing",
  "push_sync_non_branch_ref_ignored",
  "push_sync_failed",
  "push_delete_worktree_dirty",
  "push_delete_worktree_missing",
  "push_delete_default_branch_ignored",
  "push_delete_non_branch_ref_ignored",
  "push_delete_cleanup_failed",
]);

function isInternalExecResult(value: unknown): value is Awaited<ReturnType<InternalExecClient>> {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    typeof result.exitCode === "number"
  );
}

export interface GatewayAppConfig extends RunnerDeps {
  signingSecret: string;
  /** Slack bot token. Either this or `slackClient` is required. */
  slackBotToken: string;
  /** Pre-built Slack WebClient (used by tests to inject a mock). */
  slackClient?: SlackDeps["client"];
  /** Override Slack API base URL (used by tests; ignored if `slackClient` is set). */
  slackApiBaseUrl?: string;
  /** Our bot's Slack user ID — used to ignore our own messages. */
  slackBotUserId: string;
  /** Remote CLI hostname for approval resolution. Default: "remote-cli". */
  remoteCliHost?: string;
  /** Remote CLI port for approval resolution. Default: 3004. */
  remoteCliPort?: number;
  /** Shared secret for gateway→remote-cli internal endpoints. */
  internalSecret?: string;
  timestampToleranceSeconds?: number;
  /** Directory for the event queue. Default: "data/queue". */
  queueDir?: string;
  /** Disable the queue polling interval (for tests). Default: false. */
  disableQueueInterval?: boolean;
  /** Short debounce delay for mentions and engaged threads (ms). Default: 3000. */
  shortDelayMs?: number;
  /** Long debounce delay for non-mentions (ms). Default: 60000. */
  longDelayMs?: number;
  /** Shared secret for cron endpoint auth. If unset, auth is skipped. */
  cronSecret?: string;
  /** Dynamic workspace config loader — re-reads config.json on each request. */
  getConfig?: ConfigLoader;
  /** Path to opencode auth.json for Codex usage check. */
  openaiAuthPath?: string;
  /** GitHub webhook HMAC secret. */
  githubWebhookSecret?: string;
  /** Allowlisted mention logins used for GitHub mention detection. */
  githubMentionLogins?: string[];
  /** Numeric GitHub user ID of our App's bot user. Used as the canonical self-identity check. */
  githubAppBotId?: number;
  /** Git author email derived from the GitHub App bot identity. */
  githubAppBotEmail?: string;
  /** Internal exec client override for tests. */
  internalExec?: InternalExecClient;
  /** GitHub mention debounce delay in ms. Default: 3000. */
  githubMentionDelayMs?: number;
}

const InteractivityBodySchema = z.object({
  payload: z.string(),
});

function parseInteractivityPayload(body: unknown) {
  const parsed = InteractivityBodySchema.safeParse(body);
  if (!parsed.success) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(parsed.data.payload);
  } catch {
    return undefined;
  }
  return SlackInteractivityPayloadSchema.safeParse(raw);
}

export interface GatewayApp {
  app: Express;
  queue: EventQueue;
}

type ApprovalDecision = "approved" | "rejected";

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  approved: "Approved",
  rejected: "Rejected",
};

type ApprovalAction = SlackInteractivityAction & { value: string };

interface ApprovalDeps {
  slackDeps: SlackDeps;
  remoteCliUrl: string;
  internalSecret: string | undefined;
  fetchImpl: typeof fetch | undefined;
  queue: EventQueue;
}

interface ApprovalActionContext extends ApprovalDeps {
  res: Response;
  action: ApprovalAction;
  payload: SlackInteractivityPayload;
}

interface ApprovalReentryContext extends ApprovalDeps {
  route: ApprovalButtonRoute;
  decision: ApprovalDecision;
  reviewer: string;
  channel: string | undefined;
  messageTs: string | undefined;
  threadTs: string;
}

function handleApprovalAction(ctx: ApprovalActionContext): void {
  const { res, action, payload } = ctx;
  const decision: ApprovalDecision =
    action.action_id === "approval_approve" ? "approved" : "rejected";
  const reviewer = payload.user?.id ?? "unknown";
  const route = parseApprovalButtonValue(action.value);
  const channel = payload.channel?.id ?? payload.container?.channel_id;
  const messageTs = payload.message?.ts ?? payload.container?.message_ts;
  const threadTs = route?.threadTs ?? payload.message?.thread_ts ?? payload.container?.thread_ts;

  if (!route) {
    logError(log, "approval_resolve_failed", "Unrecognized button value format", {
      value: action.value,
    });
    res.status(200).json({ ok: true });
    return;
  }

  if (!threadTs) {
    logError(log, "approval_resolve_failed", "Unable to determine originating thread", {
      actionId: route.actionId,
      value: action.value,
    });
    res.status(200).json({ ok: true });
    return;
  }

  logInfo(log, "approval_action", {
    actionId: route.actionId,
    upstreamName: route.upstreamName,
    decision,
    reviewer,
    threadTs,
    remoteCliUrl: ctx.remoteCliUrl,
  });

  // Slack requires the interactivity ack within 3s; finish in the background.
  res.status(200).json({ ok: true });

  void resolveApprovalAndReenter({
    ...ctx,
    route,
    decision,
    reviewer,
    channel,
    messageTs,
    threadTs,
  }).catch((error) => {
    logError(log, "approval_background_error", error, { actionId: route.actionId });
  });
}

async function resolveApprovalAndReenter(ctx: ApprovalReentryContext): Promise<void> {
  const {
    route,
    decision,
    reviewer,
    channel,
    messageTs,
    threadTs,
    slackDeps,
    remoteCliUrl,
    internalSecret,
    fetchImpl,
    queue,
  } = ctx;

  const resolved = await resolveApproval(
    route.actionId,
    decision,
    reviewer,
    remoteCliUrl,
    internalSecret,
    fetchImpl,
  );
  if (!resolved) {
    logError(log, "approval_resolve_failed", "remote-cli returned error", {
      actionId: route.actionId,
    });
    if (channel && messageTs) {
      const failureText = `⚠️ *${DECISION_LABEL[decision]}, but resolution failed* by <@${reviewer}> · \`${route.actionId}\`\n>remote-cli did not respond after retries; please retry the approval action`;
      await updateSlackMessage(channel, messageTs, failureText, slackDeps);
    }
    return;
  }

  const resolution = summarizeResolutionOutput(resolved.stdout, resolved.stderr);
  const resolutionFailed = resolved.exitCode !== 0;
  const statusEmoji = resolutionFailed ? "⚠️" : decision === "approved" ? "✅" : "❌";
  const decisionLabel = resolutionFailed
    ? `${DECISION_LABEL[decision]}, resolution failed`
    : DECISION_LABEL[decision];
  const target = [route.upstreamName ?? resolution.upstream, resolution.tool]
    .filter(Boolean)
    .join("/");
  const summarySuffix = resolution.summary ? `\n>${truncate(resolution.summary, 180)}` : "";
  const text = `${statusEmoji} *${decisionLabel}* by <@${reviewer}> · \`${route.actionId}\`${target ? ` (${target})` : ""}${summarySuffix}`;

  if (!channel) {
    logError(log, "approval_reentry_enqueue_failed", "Missing channel for approval outcome", {
      actionId: route.actionId,
      threadTs,
    });
    return;
  }

  const outcomePayload: ApprovalOutcomeEventPayload = {
    actionId: route.actionId,
    decision,
    reviewer,
    channel,
    threadTs,
    upstreamName: route.upstreamName ?? resolution.upstream,
    tool: resolution.tool,
    messageTs,
    resolutionStatus: resolutionFailed ? "error" : resolution.status,
    resolutionSummary: resolution.summary,
    resolutionExitCode: resolved.exitCode,
  };

  const rawCorrelationKeys = buildSlackCorrelationKeys(channel, threadTs);
  const outcomeCorrelationKey = resolveCorrelationKeys(rawCorrelationKeys);
  if (outcomeCorrelationKey !== rawCorrelationKeys[0]) {
    logInfo(log, "corr_key_resolved", {
      rawKey: rawCorrelationKeys[0],
      correlationKey: outcomeCorrelationKey,
    });
  }

  // Enqueue before the Slack card update — re-entering the runner is the
  // load-bearing operation; a failed chat.update must not block it.
  await queue.enqueue({
    id: `approval-${route.actionId}-${decision}-${Date.now()}`,
    source: "approval",
    correlationKey: outcomeCorrelationKey,
    payload: outcomePayload,
    receivedAt: new Date().toISOString(),
    sourceTs: Date.now(),
    readyAt: Date.now(),
    delayMs: 0,
    interrupt: false,
  });

  logInfo(log, "approval_outcome_enqueued", {
    actionId: route.actionId,
    decision,
    channel,
    threadTs,
    correlationKey: outcomeCorrelationKey,
  });

  if (messageTs) {
    await updateSlackMessage(channel, messageTs, text, slackDeps);
  }
}

export function createGatewayApp(config: GatewayAppConfig): GatewayApp {
  if (!config.slackBotToken.trim()) {
    throw new Error("SLACK_BOT_TOKEN is required");
  }

  // --- Event queue with handler ---

  const selfUserId = config.slackBotUserId;
  const shortDelay = config.shortDelayMs ?? SHORT_DELAY_MS;
  const githubMentionDelay = config.githubMentionDelayMs ?? GITHUB_MENTION_DELAY_MS;
  const githubMentionLogins = config.githubMentionLogins ?? [];
  const githubAppBotId = config.githubAppBotId ?? 0;

  const logGitHubIgnored = (input: {
    deliveryId: string;
    repoFullName?: string;
    eventType?: string;
    action?: string;
    reason: GitHubIgnoreReason | string;
  }) => {
    logInfo(log, "github_event_ignored", {
      deliveryId: input.deliveryId,
      repoFullName: input.repoFullName,
      eventType: input.eventType,
      action: input.action,
      reason: input.reason,
    });
  };

  const handleGitHubPushEvent = async (input: {
    event: PushEvent;
    deliveryId: string;
    repoFullName: string;
    localRepo: string;
    repoDir: string;
    history: WebhookHistoryState;
  }): Promise<{ status: PushStatus; ignored?: boolean }> => {
    const { event, deliveryId, repoFullName, localRepo, repoDir, history } = input;
    const branch = getGitHubEventBranch(event);
    const commonMeta = {
      deliveryId,
      repoFullName,
      localRepo,
      branch,
      ref: event.ref,
      after: event.after,
      forced: event.forced,
    };
    const record = (status: PushStatus, metadata: Record<string, unknown> = {}) => {
      history.githubStream = IGNORED_PUSH_STATUSES.has(status) ? "ignored" : "ingested";
      history.signatureVerified = true;
      history.parseStatus = "schema_valid";
      history.reason = status;
      history.metadata = { ...commonMeta, ...metadata };
      logInfo(log, "github_push_event_handled", { status, ...commonMeta, ...metadata });
    };
    const execGit = async (
      request: Parameters<InternalExecClient>[0],
    ): Promise<Awaited<ReturnType<InternalExecClient>>> => {
      const result = await internalExec(request);
      if (!isInternalExecResult(result)) {
        throw new Error("internalExec returned invalid result");
      }
      return result;
    };

    if (!branch) {
      const status = event.deleted
        ? "push_delete_non_branch_ref_ignored"
        : "push_sync_non_branch_ref_ignored";
      record(status);
      return { status, ignored: true };
    }

    if (event.deleted === true) {
      if (branch === event.repository.default_branch) {
        record("push_delete_default_branch_ignored");
        return { status: "push_delete_default_branch_ignored", ignored: true };
      }

      const targetDir = await resolveExistingWorktreePath(localRepo, branch);
      if (!targetDir) {
        record("push_delete_worktree_missing");
        return { status: "push_delete_worktree_missing", ignored: true };
      }

      let statusResult: Awaited<ReturnType<InternalExecClient>>;
      try {
        statusResult = await execGit({
          bin: "git",
          args: ["status", "--porcelain"],
          cwd: targetDir,
        });
      } catch (error) {
        record("push_delete_cleanup_failed", { targetDir, ...errorToMetadata(error) });
        return { status: "push_delete_cleanup_failed", ignored: true };
      }
      if (statusResult.exitCode !== 0) {
        record("push_delete_cleanup_failed", { targetDir, exitCode: statusResult.exitCode });
        return { status: "push_delete_cleanup_failed", ignored: true };
      }
      if (statusResult.stdout.trim()) {
        record("push_delete_worktree_dirty", { targetDir });
        return { status: "push_delete_worktree_dirty", ignored: true };
      }

      let removeResult: Awaited<ReturnType<InternalExecClient>>;
      try {
        removeResult = await execGit({
          bin: "git",
          args: ["worktree", "remove", targetDir],
          cwd: repoDir,
        });
      } catch (error) {
        record("push_delete_cleanup_failed", { targetDir, ...errorToMetadata(error) });
        return { status: "push_delete_cleanup_failed", ignored: true };
      }
      if (removeResult.exitCode !== 0) {
        record("push_delete_cleanup_failed", { targetDir, exitCode: removeResult.exitCode });
        return { status: "push_delete_cleanup_failed", ignored: true };
      }
      record("push_delete_worktree_removed", { targetDir });
      return { status: "push_delete_worktree_removed" };
    }

    const isDefaultBranch = branch === event.repository.default_branch;
    const targetDir = isDefaultBranch
      ? repoDir
      : await resolveExistingWorktreePath(localRepo, branch);
    if (!targetDir) {
      record("push_sync_worktree_missing");
      return { status: "push_sync_worktree_missing", ignored: true };
    }

    let headBefore: string;
    try {
      const headResult = await execGit({
        bin: "git",
        args: ["rev-parse", "HEAD"],
        cwd: targetDir,
      });
      if (headResult.exitCode !== 0) {
        record("push_sync_failed", { targetDir, exitCode: headResult.exitCode });
        return { status: "push_sync_failed", ignored: true };
      }
      headBefore = headResult.stdout.trim();
    } catch (error) {
      record("push_sync_failed", { targetDir, ...errorToMetadata(error) });
      return { status: "push_sync_failed", ignored: true };
    }

    if (headBefore && headBefore === event.after) {
      record("push_sync_already_up_to_date", { targetDir, head: headBefore });
      return { status: "push_sync_already_up_to_date", ignored: true };
    }

    let fetchResult: Awaited<ReturnType<InternalExecClient>>;
    try {
      fetchResult = await execGit({
        bin: "git",
        args: ["fetch", "origin", `refs/heads/${branch}`],
        cwd: targetDir,
      });
    } catch (error) {
      record("push_sync_failed", { targetDir, ...errorToMetadata(error) });
      return { status: "push_sync_failed", ignored: true };
    }
    if (fetchResult.exitCode !== 0) {
      record("push_sync_failed", { targetDir, exitCode: fetchResult.exitCode });
      return { status: "push_sync_failed", ignored: true };
    }

    let canFastForward: boolean;
    try {
      const ancestorResult = await execGit({
        bin: "git",
        args: ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"],
        cwd: targetDir,
      });
      if (ancestorResult.exitCode === 0) {
        canFastForward = true;
      } else if (ancestorResult.exitCode === 1) {
        canFastForward = false;
      } else {
        record("push_sync_failed", { targetDir, exitCode: ancestorResult.exitCode });
        return { status: "push_sync_failed", ignored: true };
      }
    } catch (error) {
      record("push_sync_failed", { targetDir, ...errorToMetadata(error) });
      return { status: "push_sync_failed", ignored: true };
    }

    let resetResult: Awaited<ReturnType<InternalExecClient>>;
    try {
      resetResult = await execGit({
        bin: "git",
        args: ["reset", "--hard", "FETCH_HEAD"],
        cwd: targetDir,
      });
    } catch (error) {
      record("push_sync_failed", { targetDir, ...errorToMetadata(error) });
      return { status: "push_sync_failed", ignored: true };
    }
    if (resetResult.exitCode !== 0) {
      record("push_sync_failed", { targetDir, exitCode: resetResult.exitCode });
      return { status: "push_sync_failed", ignored: true };
    }

    const syncStatus: PushStatus = isDefaultBranch
      ? canFastForward
        ? "push_sync_default_branch_fast_forwarded"
        : "push_sync_default_branch_reset"
      : canFastForward
        ? "push_sync_worktree_fast_forwarded"
        : "push_sync_worktree_reset";
    record(syncStatus, { targetDir, fastForward: canFastForward, headBefore });

    if (isDefaultBranch) {
      return { status: syncStatus };
    }

    const rawKey = buildCorrelationKey(localRepo, branch);
    const correlationKey = resolveCorrelationKeys([rawKey]);
    if (!hasSessionForCorrelationKey(rawKey)) {
      record("push_wake_skipped_no_session", { targetDir, rawKey, correlationKey });
      return { status: "push_wake_skipped_no_session" };
    }

    const sourceTs = getGitHubEventSourceTs(event);
    await queue.enqueue({
      id: deliveryId,
      source: "github",
      correlationKey,
      payload: event,
      receivedAt: new Date().toISOString(),
      sourceTs,
      readyAt: sourceTs,
      delayMs: 0,
      interrupt: !canFastForward,
    });
    record("push_wake_triggered", {
      targetDir,
      rawKey,
      correlationKey,
      interrupt: !canFastForward,
    });
    return { status: "push_wake_triggered" };
  };

  /** Read allowed channels dynamically from config on each call. */
  const isChannelAllowed = (channel: string): boolean => {
    if (!config.getConfig) return true; // no config = allow all
    return getAllowedChannelIds(config.getConfig()).has(channel);
  };
  /** Read channel→repo map dynamically from config on each call. */
  const getChannelRepos = (): Map<string, string> | undefined => {
    if (!config.getConfig) return undefined;
    return getChannelRepoMap(config.getConfig());
  };

  const runnerDeps: RunnerDeps = {
    runnerUrl: config.runnerUrl,
    fetchImpl: config.fetchImpl,
  };
  const slackDeps: SlackDeps = {
    client: config.slackClient ?? createSlackClient(config.slackBotToken, config.slackApiBaseUrl),
  };
  const remoteCliHost = config.remoteCliHost ?? "remote-cli";
  const remoteCliUrl = `http://${remoteCliHost}:${config.remoteCliPort ?? 3004}`;
  const internalExec =
    config.internalExec ??
    createInternalExecClient({
      remoteCliUrl,
      internalSecret: config.internalSecret,
      fetchImpl: config.fetchImpl,
    });

  const queue = new EventQueue({
    dir: config.queueDir ?? "data/queue",
    disableInterval: config.disableQueueInterval === true,
    handler: async (events: QueuedEvent[], ack: () => void, reject: (reason: string) => void) => {
      const slackEvents = events.filter(isSlackEvent);
      const cronEvents = events.filter(isCronEvent);
      const githubEvents = events.filter(isGitHubEvent);
      const approvalEvents = events.filter(isApprovalEvent);
      const sources = [...new Set(events.map((event) => event.source))].sort() as BatchSource[];
      const logPrefix = getBatchLogPrefix(sources);
      const correlationKey = events[events.length - 1]?.correlationKey;
      const hasInterrupt = events.some((event) => event.interrupt);
      const logTrigger = (
        prefix: BatchLogPrefix,
        outcome: "busy" | "dropped" | "fired",
        reason?: string,
      ) => {
        logInfo(
          log,
          `${prefix}_trigger_${outcome}`,
          buildDispatchLogContext({
            logPrefix: prefix,
            correlationKey,
            batchSize: events.length,
            interrupt: hasInterrupt,
            sources,
            reason,
          }),
        );
      };

      try {
        const plan = await planBatchDispatch({
          slackEvents: slackEvents.map((event) => event.payload),
          cronEvents: cronEvents.map((event) => event.payload),
          githubEvents: githubEvents.map((event) => event.payload),
          approvalOutcomes: approvalEvents.map((event) => event.payload),
          correlationKey: correlationKey ?? "",
          deps: runnerDeps,
          slackDeps,
          remoteCliUrl,
          internalSecret: config.internalSecret,
          internalExec,
          interrupt: hasInterrupt,
          onAccepted: ack,
          onRejected: reject,
          channelRepos: getChannelRepos(),
        });

        if (plan.kind === "reroute") {
          const now = Date.now();
          const resolvedKey = resolveCorrelationKeys([plan.toCorrelationKey]);
          for (const [index, event] of githubEvents.entries()) {
            await queue.enqueue({
              ...event,
              id: `${event.id}:resolved`,
              correlationKey: resolvedKey,
              payload: plan.githubEvents[index],
              readyAt: now,
              delayMs: 0,
            });
          }
          ack();
          logInfo(log, "github_events_rerouted", {
            fromCorrelationKey: plan.fromCorrelationKey,
            toCorrelationKey: resolvedKey,
            batchSize: githubEvents.length,
          });
          return;
        }

        if (plan.kind === "drop") {
          reject(plan.reason);
          logTrigger(plan.logPrefix, "dropped", plan.reason);
          return;
        }

        const result = await executeBatchDispatchPlan(plan);
        if (result.busy) {
          logTrigger(plan.logPrefix, "busy");
        } else if (result.rejected) {
          logTrigger(plan.logPrefix, "dropped", result.reason);
        } else {
          logTrigger(plan.logPrefix, "fired");
        }
      } catch (error) {
        if (logPrefix === "github" && correlationKey && isPendingBranchResolveKey(correlationKey)) {
          logError(log, "github_branch_resolution_retryable", error, {
            correlationKey,
            batchSize: githubEvents.length,
          });
          return;
        }

        logError(
          log,
          `${logPrefix}_trigger_failed`,
          error,
          buildDispatchLogContext({
            logPrefix,
            correlationKey,
            batchSize: events.length,
            interrupt: hasInterrupt,
            sources,
          }),
        );
      }
    },
  });

  // --- Express app ---

  const app = express();
  const webhookRawParser = express.raw({
    // GitHub webhook payloads can be up to 25 MB
    // https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap
    limit: "25mb",
    type: "*/*",
  });
  const jsonParser = express.json({
    // GitHub webhook payloads can be up to 25 MB
    // https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap
    limit: "25mb",
    verify: (request, _response, buf) => {
      (request as RawBodyRequest).rawBody = buf.toString("utf8");
      (request as RawBodyRequest).rawBodyBuffer = Buffer.from(buf);
    },
  });
  const urlencodedParser = express.urlencoded({
    extended: false,
    verify: (request, _response, buf) => {
      (request as RawBodyRequest).rawBody = buf.toString("utf8");
      (request as RawBodyRequest).rawBodyBuffer = Buffer.from(buf);
    },
  });
  app.use((req, res, next) => {
    if (isRawWebhookRoute(req.path)) {
      next();
      return;
    }

    jsonParser(req, res, next);
  });
  app.use((req, res, next) => {
    if (isRawWebhookRoute(req.path)) {
      next();
      return;
    }

    urlencodedParser(req, res, next);
  });

  app.get("/health", async (_req, res) => {
    const result = await deepHealthCheck({
      runnerUrl: config.runnerUrl,
      remoteCliHost,
      remoteCliPort: config.remoteCliPort ?? 3004,
      openaiAuthPath: config.openaiAuthPath,
      fetchImpl: config.fetchImpl,
      queueSnapshot: queue.snapshotPending(),
    });
    const statusCode = result.queue?.status === "error" ? 503 : 200;
    res.status(statusCode).json({
      ...result,
      runnerUrl: config.runnerUrl,
      configured: Boolean(config.signingSecret && config.slackBotToken),
    });
  });

  const handleSlackEventsWebhook = async (
    req: Request,
    res: Response,
    history: WebhookHistoryState,
  ): Promise<void> => {
    const rawBodyUtf8 = history.rawBodyBuffer.toString("utf8");
    const signature = req.header("x-slack-signature");
    const timestamp = req.header("x-slack-request-timestamp");
    const slackRequestId =
      (typeof history.headers["x-slack-request-id"] === "string" &&
        history.headers["x-slack-request-id"]) ||
      (typeof history.headers["x-request-id"] === "string" && history.headers["x-request-id"]) ||
      undefined;
    history.requestId = slackRequestId;

    const verified = verifySlackSignature({
      signingSecret: config.signingSecret,
      rawBody: rawBodyUtf8,
      signature,
      timestamp,
      toleranceSeconds: config.timestampToleranceSeconds,
    });
    history.signatureVerified = verified;

    if (!verified) {
      history.parseStatus = "not_parsed";
      history.reason = "signature_invalid";
      res.status(401).json({ error: "Invalid Slack signature" });
      return;
    }

    const parsedBody = parseWebhookJson(history);
    if (parsedBody === undefined) {
      history.parseStatus = "json_invalid";
      history.reason = "json_parse_error";
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const urlVerification = SlackUrlVerificationSchema.safeParse(parsedBody);
    if (urlVerification.success) {
      history.parseStatus = "url_verification";
      history.eventType = "url_verification";
      res.status(200).json({ challenge: urlVerification.data.challenge });
      return;
    }

    const envelope = SlackEventEnvelopeSchema.safeParse(parsedBody);
    if (!envelope.success) {
      history.parseStatus = "schema_invalid";
      history.reason = "schema_validation_failed";
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const event = envelope.data.event;
    const eventId = envelope.data.event_id;
    const requestId = slackRequestId || eventId;

    history.requestId = requestId;
    history.parseStatus = "schema_valid";
    history.eventType = event.type;
    history.reason = "received";
    history.metadata = {
      eventId,
      teamId: envelope.data.team_id,
      subtype: event.type === "message" ? event.subtype : undefined,
    };

    // Skip all Slack events when bot user ID is not configured
    if (!selfUserId) {
      logInfo(log, "event_ignored_no_bot_user_id", { eventId });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Ignore empty messages (e.g. bot messages with attachments only), except
    // user file shares where file metadata is the meaningful payload.
    if (
      "text" in event &&
      event.text === "" &&
      !(
        event.type === "message" &&
        event.subtype === "file_share" &&
        slackMessageHasFilesMetadata(event)
      )
    ) {
      logInfo(log, "event_ignored_empty_text", {
        eventId,
        subtype: event.type === "message" ? event.subtype : undefined,
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Ignore our own messages
    if (event.user === selfUserId) {
      logInfo(log, "event_ignored_self", { eventId });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Block non-allowlisted channels
    if (
      "channel" in event &&
      typeof event.channel === "string" &&
      !isChannelAllowed(event.channel)
    ) {
      logInfo(log, "event_ignored_channel_not_allowed", { eventId, channel: event.channel });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // app_mention — always forward
    if (event.type === "app_mention") {
      void addSlackReaction(event.channel, event.ts, "eyes", slackDeps).catch((err) =>
        logError(log, "reaction_failed", err, { eventId }),
      );
      const rawKeys = getSlackCorrelationKeys(event);
      const correlationKey = resolveCorrelationKeys(rawKeys);
      if (correlationKey !== rawKeys[0]) {
        logInfo(log, "corr_key_resolved", { rawKey: rawKeys[0], correlationKey });
      }
      logInfo(log, "event_accepted", {
        eventId,
        teamId: envelope.data.team_id,
        eventType: event.type,
        channel: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        correlationKey,
      });
      await queue.enqueue({
        id: eventId,
        source: "slack",
        correlationKey,
        payload: event,
        receivedAt: new Date().toISOString(),
        sourceTs: parseSlackTs(event.ts),
        readyAt: Date.now(),
        delayMs: 0,
        interrupt: true,
      });
      res.status(200).json({ ok: true });
      return;
    }

    // Skip if it's a duplicate of an app_mention (Slack sends both events)
    if (
      event.type === "message" &&
      isForwardableSlackMessage(event) &&
      event.text?.includes(`<@${selfUserId}>`)
    ) {
      logInfo(log, "event_ignored_mention_duplicate", { eventId, subtype: event.subtype });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Message continuations. Supported subtypes are user-authored messages;
    // unsupported/system subtypes remain ignored below.
    if (event.type === "message" && isForwardableSlackMessage(event)) {
      const rawKeys = getSlackCorrelationKeys(event);
      const correlationKey = resolveCorrelationKeys(rawKeys);
      if (correlationKey !== rawKeys[0]) {
        logInfo(log, "corr_key_resolved", { rawKey: rawKeys[0], correlationKey });
      }

      // Only forward if Thor is engaged in this thread via the JSONL alias index.
      // Users must @mention to start new conversations.
      const engaged = hasSessionForCorrelationKey(rawKeys);
      if (!engaged) {
        logInfo(log, "event_ignored_not_engaged", {
          eventId,
          correlationKey,
          subtype: event.subtype,
        });
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      logInfo(log, "event_accepted", {
        eventId,
        teamId: envelope.data.team_id,
        eventType: event.type,
        subtype: event.subtype,
        channel: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        correlationKey,
      });
      await queue.enqueue({
        id: eventId,
        source: "slack",
        correlationKey,
        payload: event,
        receivedAt: new Date().toISOString(),
        sourceTs: parseSlackTs(event.ts),
        readyAt: Date.now() + shortDelay,
        delayMs: shortDelay,
      });
      res.status(200).json({ ok: true });
      return;
    }

    logInfo(log, "event_ignored", {
      eventId,
      teamId: envelope.data.team_id,
      eventType: event.type,
      subtype: event.type === "message" ? event.subtype : undefined,
      supportedSubtype:
        event.type === "message" ? isSupportedSlackMessageSubtype(event.subtype) : undefined,
    });
    res.status(200).json({ ok: true, ignored: true, eventType: event.type });
  };

  // Rate limiting for public webhook ingestion is intentionally enforced at the
  // infrastructure edge (API gateway/CDN), not in the app process.
  // codeql[js/missing-rate-limiting]
  // lgtm[js/missing-rate-limiting]
  app.post(
    "/slack/events",
    // codeql[js/missing-rate-limiting]
    // lgtm[js/missing-rate-limiting]
    webhookRawParser,
    withWebhookHistory(
      "slack",
      "/slack/events",
      [
        "content-type",
        "user-agent",
        "x-request-id",
        "x-slack-request-id",
        "x-slack-request-timestamp",
        "x-slack-signature",
        "x-slack-retry-num",
        "x-slack-retry-reason",
      ],
      handleSlackEventsWebhook,
    ),
  );

  app.post("/slack/interactivity", (req: Request, res: Response) => {
    const rawRequest = req as RawBodyRequest;
    const signature = req.header("x-slack-signature");
    const timestamp = req.header("x-slack-request-timestamp");

    const verified = verifySlackSignature({
      signingSecret: config.signingSecret,
      rawBody: rawRequest.rawBody || "",
      signature,
      timestamp,
      toleranceSeconds: config.timestampToleranceSeconds,
    });

    if (!verified) {
      res.status(401).json({ error: "Invalid Slack signature" });
      return;
    }

    const result = parseInteractivityPayload(req.body);
    if (!result) {
      res.status(400).json({ error: "Invalid Slack interactivity payload" });
      return;
    }

    const interactionType = result.success ? (result.data.type ?? "unknown") : "unknown";
    logInfo(log, "interactivity_received", { interactionType });

    if (result.success && result.data.type === "block_actions") {
      const payload = result.data;
      const approvalAction = (payload.actions ?? []).find(
        (a): a is ApprovalAction =>
          (a.action_id === "approval_approve" || a.action_id === "approval_reject") &&
          typeof a.value === "string" &&
          a.value.length > 0,
      );
      if (approvalAction) {
        handleApprovalAction({
          res,
          action: approvalAction,
          payload,
          slackDeps,
          remoteCliUrl,
          internalSecret: config.internalSecret,
          fetchImpl: config.fetchImpl,
          queue,
        });
        return;
      }
    }
    res.status(200).json({ ok: true, ignored: true, interactionType });
  });

  // --- GitHub webhook ---

  const handleGitHubWebhook = async (
    req: Request,
    res: Response,
    history: WebhookHistoryState,
  ): Promise<void> => {
    const deliveryId = req.header("x-github-delivery") ?? "unknown";
    const eventTypeHeader = (req.header("x-github-event") ?? "").toLowerCase();
    const signature = req.header("x-hub-signature-256");
    history.requestId = deliveryId;
    history.eventType = eventTypeHeader || undefined;

    const verified = verifyGitHubSignature({
      secret: config.githubWebhookSecret ?? "",
      rawBody: history.rawBodyBuffer,
      header: signature,
    });
    history.signatureVerified = verified;
    if (!verified) {
      history.githubStream = "ignored";
      history.parseStatus = "not_parsed";
      history.reason = "signature_invalid";
      logGitHubIgnored({
        deliveryId,
        eventType: eventTypeHeader || undefined,
        reason: "signature_invalid",
      });
      res.status(401).json({ error: "Invalid GitHub signature" });
      return;
    }

    if (!GITHUB_SUPPORTED_EVENTS.has(eventTypeHeader)) {
      history.githubStream = "ignored";
      history.parseStatus = "not_parsed";
      history.reason = "event_unsupported";
      history.bodyPolicy = "unsupported_github";
      logGitHubIgnored({
        deliveryId,
        eventType: eventTypeHeader || undefined,
        reason: "event_unsupported",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const parsedBody = parseWebhookJson(history);
    if (parsedBody === undefined) {
      history.githubStream = "ignored";
      history.parseStatus = "json_invalid";
      history.reason = "json_parse_error";
      logGitHubIgnored({
        deliveryId,
        eventType: eventTypeHeader || undefined,
        reason: "json_parse_error",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const parsed = GitHubWebhookEnvelopeSchema.safeParse(parsedBody);
    if (!parsed.success) {
      history.githubStream = "ignored";
      history.parseStatus = "schema_invalid";
      history.reason = "schema_validation_failed";
      logGitHubIgnored({
        deliveryId,
        eventType: eventTypeHeader || undefined,
        reason: "schema_validation_failed",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const repoFullName = parsed.data.repository.full_name;
    const localRepo = getGitHubEventLocalRepo(parsed.data);
    const repoDir = localRepo ? resolveRepoDirectory(localRepo) : undefined;
    const action = "action" in parsed.data ? parsed.data.action : undefined;
    if (!localRepo || !repoDir) {
      history.githubStream = "ignored";
      history.parseStatus = "schema_valid";
      history.action = action;
      history.reason = "repo_not_mapped";
      history.metadata = { repoFullName, localRepo };
      logGitHubIgnored({
        deliveryId,
        repoFullName,
        eventType: eventTypeHeader,
        action,
        reason: "repo_not_mapped",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const eventType = getGitHubEventType(parsed.data);
    if (eventType !== eventTypeHeader) {
      history.githubStream = "ignored";
      history.parseStatus = "schema_valid";
      history.action = action;
      history.reason = "event_unsupported";
      history.metadata = { repoFullName, localRepo };
      logGitHubIgnored({
        deliveryId,
        repoFullName,
        eventType: eventTypeHeader,
        action,
        reason: "event_unsupported",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    if (isPushEvent(parsed.data)) {
      const pushResult = await handleGitHubPushEvent({
        event: parsed.data,
        deliveryId,
        repoFullName,
        localRepo,
        repoDir,
        history,
      });
      res.status(200).json({ ok: true, ignored: pushResult.ignored, status: pushResult.status });
      return;
    }

    const pureIssueRawKey =
      isIssueCommentEvent(parsed.data) && !parsed.data.issue.pull_request
        ? buildIssueCorrelationKey(localRepo, repoFullName, parsed.data.issue.number)
        : undefined;
    const ignoreReason = shouldIgnoreGitHubEvent(parsed.data, {
      mentionLogins: githubMentionLogins,
      botId: githubAppBotId,
    });
    const shouldAcceptEngagedIssueComment =
      ignoreReason === "non_mention_comment" &&
      pureIssueRawKey !== undefined &&
      hasSessionForCorrelationKey(pureIssueRawKey);
    if (ignoreReason && !shouldAcceptEngagedIssueComment) {
      history.githubStream = "ignored";
      history.parseStatus = "schema_valid";
      history.action = parsed.data.action;
      history.reason = ignoreReason;
      history.metadata = { repoFullName, localRepo };
      logGitHubIgnored({
        deliveryId,
        repoFullName,
        eventType: eventTypeHeader,
        action: parsed.data.action,
        reason: ignoreReason,
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const branch = getGitHubEventBranch(parsed.data);
    let correlationKey: string;
    let delayMs = githubMentionDelay;
    let interrupt = true;

    if (isPullRequestClosedEvent(parsed.data)) {
      const rawKey = buildCorrelationKey(localRepo, parsed.data.pull_request.head.ref);
      const resolvedKey = resolveCorrelationKeys([rawKey]);
      if (!hasSessionForCorrelationKey(rawKey)) {
        history.githubStream = "ignored";
        history.parseStatus = "schema_valid";
        history.action = parsed.data.action;
        history.reason = "correlation_key_unresolved";
        history.metadata = {
          repoFullName,
          localRepo,
          rawKey,
          resolvedKey,
          headSha: parsed.data.pull_request.head.sha,
        };
        logGitHubIgnored({
          deliveryId,
          repoFullName,
          eventType: eventTypeHeader,
          action: parsed.data.action,
          reason: "correlation_key_unresolved",
        });
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      correlationKey = resolvedKey;
      delayMs = 0;
      interrupt = false;
    } else if (isCheckSuiteCompletedEvent(parsed.data)) {
      if (!branch) {
        history.githubStream = "ignored";
        history.parseStatus = "schema_valid";
        history.action = parsed.data.action;
        history.reason = "check_suite_branch_missing";
        history.metadata = { repoFullName, localRepo, headSha: parsed.data.check_suite.head_sha };
        logGitHubIgnored({
          deliveryId,
          repoFullName,
          eventType: eventTypeHeader,
          action: parsed.data.action,
          reason: "check_suite_branch_missing",
        });
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      const rawKey = buildCorrelationKey(localRepo, branch);
      const resolvedKey = resolveCorrelationKeys([rawKey]);
      if (!hasSessionForCorrelationKey(rawKey)) {
        history.githubStream = "ignored";
        history.parseStatus = "schema_valid";
        history.action = parsed.data.action;
        history.reason = "correlation_key_unresolved";
        history.metadata = {
          repoFullName,
          localRepo,
          rawKey,
          resolvedKey,
          headSha: parsed.data.check_suite.head_sha,
        };
        logGitHubIgnored({
          deliveryId,
          repoFullName,
          eventType: eventTypeHeader,
          action: parsed.data.action,
          reason: "correlation_key_unresolved",
        });
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      const directory = resolveRepoDirectory(localRepo);
      const gate = directory
        ? await verifyThorAuthoredSha({
            internalExec,
            directory,
            sha: parsed.data.check_suite.head_sha,
            expectedEmail: config.githubAppBotEmail ?? "",
          })
        : { ok: false as const, reason: "exec_failed" as const };
      if (!gate.ok) {
        history.githubStream = "ignored";
        history.parseStatus = "schema_valid";
        history.action = parsed.data.action;
        history.reason = "check_suite_gate_failed";
        history.metadata = {
          repoFullName,
          localRepo,
          rawKey,
          resolvedKey,
          headSha: parsed.data.check_suite.head_sha,
          gateReason: gate.reason,
        };
        logGitHubIgnored({
          deliveryId,
          repoFullName,
          eventType: eventTypeHeader,
          action: parsed.data.action,
          reason: "check_suite_gate_failed",
        });
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      correlationKey = resolvedKey;
      delayMs = 0;
      interrupt = false;
    } else if (branch) {
      correlationKey = resolveCorrelationKeys([buildCorrelationKey(localRepo, branch)]);
    } else if (pureIssueRawKey) {
      correlationKey = resolveCorrelationKeys([pureIssueRawKey]);
    } else {
      correlationKey = buildPendingBranchResolveKey(localRepo, getGitHubEventNumber(parsed.data));
    }

    const sourceTs = getGitHubEventSourceTs(parsed.data);

    await queue.enqueue({
      id: deliveryId,
      source: "github",
      correlationKey,
      payload: parsed.data,
      receivedAt: new Date().toISOString(),
      sourceTs,
      readyAt: sourceTs + delayMs,
      delayMs,
      interrupt,
    });

    history.githubStream = "ingested";
    history.signatureVerified = true;
    history.parseStatus = "schema_valid";
    history.action = parsed.data.action;
    history.reason = "accepted";
    history.metadata = { repoFullName, localRepo, correlationKey };

    logInfo(log, "github_event_accepted", {
      deliveryId,
      repoFullName,
      localRepo,
      eventType,
      action: parsed.data.action,
      correlationKey,
      interrupt,
      delayMs,
    });

    res.status(200).json({ ok: true });
  };

  // Rate limiting for public webhook ingestion is intentionally enforced at the
  // infrastructure edge (API gateway/CDN), not in the app process.
  // codeql[js/missing-rate-limiting]
  // lgtm[js/missing-rate-limiting]
  app.post(
    "/github/webhook",
    // codeql[js/missing-rate-limiting]
    // lgtm[js/missing-rate-limiting]
    webhookRawParser,
    withWebhookHistory(
      "github",
      "/github/webhook",
      [
        "content-type",
        "user-agent",
        "x-request-id",
        "x-github-delivery",
        "x-github-event",
        "x-hub-signature-256",
        "x-github-hook-id",
        "x-github-hook-installation-target-id",
        "x-github-hook-installation-target-type",
      ],
      handleGitHubWebhook,
    ),
  );

  // --- Cron trigger ---

  app.post("/cron", async (req: Request, res: Response) => {
    // Auth required — CRON_SECRET must be configured
    if (!config.cronSecret) {
      res.status(401).json({ error: "CRON_SECRET not configured" });
      return;
    }

    const auth = req.header("authorization");
    if (auth !== `Bearer ${config.cronSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = CronRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const { prompt, correlationKey: providedKey, directory } = parsed.data;
    const rawKey = providedKey ?? deriveCronCorrelationKey(prompt);
    const correlationKey = resolveCorrelationKeys([rawKey]);
    if (correlationKey !== rawKey) {
      logInfo(log, "corr_key_resolved", { rawKey, correlationKey });
    }

    const payload: CronPayload = { prompt, directory };

    await queue.enqueue({
      id: `cron-${Date.now()}`,
      source: "cron",
      correlationKey,
      payload,
      receivedAt: new Date().toISOString(),
      sourceTs: Date.now(),
      readyAt: Date.now(),
      delayMs: 0,
      interrupt: false,
    });

    logInfo(log, "cron_event_accepted", { correlationKey });
    res.status(200).json({ ok: true, correlationKey });
  });

  // --- Slack OAuth redirect ---

  app.get("/slack/redirect", (req: Request, res: Response) => {
    res.status(501).json({
      error: "Slack OAuth redirect is configured but not implemented yet.",
      code: typeof req.query.code === "string" ? req.query.code : undefined,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
    });
  });

  return { app, queue };
}
