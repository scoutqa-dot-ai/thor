import express, { type Express, type Request, type Response } from "express";
import {
  createLogger,
  logError,
  logInfo,
  resolveCorrelationKeys,
  hasSlackReply,
  getAllowedChannelIds,
  getChannelRepoMap,
  truncate,
  resolveRepoDirectory,
  type ConfigLoader,
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
  updateSlackMessage,
  type ApprovalOutcomeEventPayload,
  type BatchLogPrefix,
  type BatchSource,
  type RunnerDeps,
} from "./service.js";
import type { SlackDeps } from "./slack-api.js";
import { deepHealthCheck } from "./healthcheck.js";
import {
  getSlackCorrelationKey,
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
  buildPendingBranchResolveKey,
  getGitHubEventSourceTs,
  GitHubWebhookEnvelopeSchema,
  isPendingBranchResolveKey,
  type NormalizedGitHubEvent,
  normalizeGitHubEvent,
  verifyGitHubSignature,
} from "./github.js";

interface SlackQueuedEvent extends QueuedEvent<SlackThreadEvent> {
  source: "slack";
}

interface CronQueuedEvent extends QueuedEvent<CronPayload> {
  source: "cron";
}

interface ApprovalQueuedEvent extends QueuedEvent<ApprovalOutcomeEventPayload> {
  source: "approval";
}

interface GitHubQueuedEvent extends QueuedEvent<NormalizedGitHubEvent> {
  source: "github";
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

/** Short debounce delay for mentions and engaged threads (ms). */
const SHORT_DELAY_MS = 3000;
const GITHUB_MENTION_DELAY_MS = 3000;
const GITHUB_SUPPORTED_EVENTS = new Set([
  "issue_comment",
  "pull_request_review_comment",
  "pull_request_review",
]);

type GitHubIgnoreReason =
  | "signature_invalid"
  | "event_unsupported"
  | "repo_not_mapped"
  | "pure_issue_comment_unsupported"
  | "fork_pr_unsupported"
  | "self_sender"
  | "empty_review_body"
  | "non_mention_comment";

export interface GatewayAppConfig extends RunnerDeps {
  signingSecret: string;
  slackBotToken: string;
  slackApiBaseUrl?: string;
  /** Our bot's Slack user ID — used to ignore our own messages. */
  slackBotUserId: string;
  /** Remote CLI hostname for approval resolution. Default: "remote-cli". */
  remoteCliHost?: string;
  /** Remote CLI port for approval resolution. Default: 3004. */
  remoteCliPort?: number;
  /** Shared secret for MCP approval resolution. */
  resolveSecret?: string;
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
  resolveSecret: string | undefined;
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
    resolveSecret,
    fetchImpl,
    queue,
  } = ctx;

  const resolved = await resolveApproval(
    route.actionId,
    decision,
    reviewer,
    remoteCliUrl,
    resolveSecret,
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

  const rawCorrelationKey = `slack:thread:${threadTs}`;
  const outcomeCorrelationKey = resolveCorrelationKeys([rawCorrelationKey]);
  if (outcomeCorrelationKey !== rawCorrelationKey) {
    logInfo(log, "corr_key_resolved", {
      rawKey: rawCorrelationKey,
      correlationKey: outcomeCorrelationKey,
    });
  }

  // Enqueue before the Slack card update — re-entering the runner is the
  // load-bearing operation; a failed chat.update must not block it.
  queue.enqueue({
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
    reason: GitHubIgnoreReason;
  }) => {
    logInfo(log, "github_event_ignored", {
      deliveryId: input.deliveryId,
      repoFullName: input.repoFullName,
      eventType: input.eventType,
      action: input.action,
      reason: input.reason,
    });
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
    botToken: config.slackBotToken,
    fetchImpl: config.fetchImpl,
    slackApiBaseUrl: config.slackApiBaseUrl,
  };
  const remoteCliHost = config.remoteCliHost ?? "remote-cli";
  const remoteCliUrl = `http://${remoteCliHost}:${config.remoteCliPort ?? 3004}`;

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
          interrupt: hasInterrupt,
          onAccepted: ack,
          onRejected: reject,
          channelRepos: getChannelRepos(),
        });

        if (plan.kind === "reroute") {
          const now = Date.now();
          const resolvedKey = resolveCorrelationKeys([plan.toCorrelationKey]);
          for (const [index, event] of githubEvents.entries()) {
            queue.enqueue({
              ...event,
              id: `${event.id}:resolved`,
              correlationKey: resolvedKey,
              payload: plan.githubEvents[index],
              receivedAt: new Date(now).toISOString(),
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

  app.use(
    express.json({
      // GitHub webhook payloads can be up to 25 MB
      // https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap
      limit: "25mb",
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString("utf8");
        (req as RawBodyRequest).rawBodyBuffer = Buffer.from(buf);
      },
    }),
  );
  app.use(
    express.urlencoded({
      extended: false,
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString("utf8");
        (req as RawBodyRequest).rawBodyBuffer = Buffer.from(buf);
      },
    }),
  );

  app.get("/health", async (_req, res) => {
    const result = await deepHealthCheck({
      runnerUrl: config.runnerUrl,
      remoteCliHost,
      remoteCliPort: config.remoteCliPort ?? 3004,
      openaiAuthPath: config.openaiAuthPath,
      fetchImpl: config.fetchImpl,
    });
    res.json({
      ...result,
      runnerUrl: config.runnerUrl,
      configured: Boolean(config.signingSecret && config.slackBotToken),
    });
  });

  app.post("/slack/events", (req: Request, res: Response) => {
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

    const urlVerification = SlackUrlVerificationSchema.safeParse(req.body);
    if (urlVerification.success) {
      res.json({ challenge: urlVerification.data.challenge });
      return;
    }

    const envelope = SlackEventEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const event = envelope.data.event;
    const eventId = envelope.data.event_id;

    // Skip all Slack events when bot user ID is not configured
    if (!selfUserId) {
      logInfo(log, "event_ignored_no_bot_user_id", { eventId });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Ignore empty messages (e.g. bot messages with attachments only)
    if ("text" in event && event.text === "") {
      logInfo(log, "event_ignored_empty_text", { eventId });
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
      res.status(200).json({ ok: true });
      void addSlackReaction(event.channel, event.ts, "eyes", slackDeps).catch((err) =>
        logError(log, "reaction_failed", err, { eventId }),
      );
      const rawKey = getSlackCorrelationKey(event);
      const correlationKey = resolveCorrelationKeys([rawKey]);
      if (correlationKey !== rawKey) {
        logInfo(log, "corr_key_resolved", { rawKey, correlationKey });
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
      queue.enqueue({
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
      return;
    }

    // Skip if it's a duplicate of an app_mention (Slack sends both events)
    if (event.type === "message" && !event.subtype && event.text?.includes(`<@${selfUserId}>`)) {
      logInfo(log, "event_ignored_mention_duplicate", { eventId });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Message (no subtype — excludes system events like channel_join)
    if (event.type === "message" && !event.subtype) {
      const rawKey = getSlackCorrelationKey(event);
      const correlationKey = resolveCorrelationKeys([rawKey]);
      if (correlationKey !== rawKey) {
        logInfo(log, "corr_key_resolved", { rawKey, correlationKey });
      }

      // Only forward if Thor is engaged in this thread (has notes with a
      // slack:thread canonical or alias). Users must @mention to start new conversations.
      const engaged = hasSlackReply(correlationKey);
      if (!engaged) {
        logInfo(log, "event_ignored_not_engaged", { eventId, correlationKey });
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      res.status(200).json({ ok: true });
      logInfo(log, "event_accepted", {
        eventId,
        teamId: envelope.data.team_id,
        eventType: event.type,
        channel: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        correlationKey,
      });
      queue.enqueue({
        id: eventId,
        source: "slack",
        correlationKey,
        payload: event,
        receivedAt: new Date().toISOString(),
        sourceTs: parseSlackTs(event.ts),
        readyAt: Date.now() + shortDelay,
        delayMs: shortDelay,
      });
      return;
    }

    logInfo(log, "event_ignored", {
      eventId,
      teamId: envelope.data.team_id,
      eventType: event.type,
    });
    res.status(200).json({ ok: true, ignored: true, eventType: event.type });
  });

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
          resolveSecret: config.resolveSecret,
          fetchImpl: config.fetchImpl,
          queue,
        });
        return;
      }
    }
    res.status(200).json({ ok: true, ignored: true, interactionType });
  });

  // --- GitHub webhook ---

  app.post("/github/webhook", (req: Request, res: Response) => {
    const rawRequest = req as RawBodyRequest;
    const deliveryId = req.header("x-github-delivery") ?? "unknown";
    const eventTypeHeader = (req.header("x-github-event") ?? "").toLowerCase();
    const signature = req.header("x-hub-signature-256");

    const verified = verifyGitHubSignature({
      secret: config.githubWebhookSecret ?? "",
      rawBody: rawRequest.rawBodyBuffer ?? Buffer.from(""),
      header: signature,
    });
    if (!verified) {
      logGitHubIgnored({
        deliveryId,
        eventType: eventTypeHeader || undefined,
        reason: "signature_invalid",
      });
      res.status(401).json({ error: "Invalid GitHub signature" });
      return;
    }

    if (!GITHUB_SUPPORTED_EVENTS.has(eventTypeHeader)) {
      logGitHubIgnored({
        deliveryId,
        eventType: eventTypeHeader || undefined,
        reason: "event_unsupported",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const parsed = GitHubWebhookEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      logGitHubIgnored({ deliveryId, eventType: eventTypeHeader, reason: "event_unsupported" });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const repoFullName = parsed.data.repository.full_name;
    const parts = repoFullName.split("/");
    const localRepo = parts[parts.length - 1];
    if (!localRepo || !resolveRepoDirectory(localRepo)) {
      logGitHubIgnored({
        deliveryId,
        repoFullName,
        eventType: eventTypeHeader,
        action: parsed.data.action,
        reason: "repo_not_mapped",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const normalized = normalizeGitHubEvent(parsed.data, {
      localRepo,
      mentionLogins: githubMentionLogins,
      botId: githubAppBotId,
    });
    if ("ignored" in normalized) {
      logGitHubIgnored({
        deliveryId,
        repoFullName,
        eventType: eventTypeHeader,
        action: parsed.data.action,
        reason: normalized.reason,
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    if (normalized.eventType !== eventTypeHeader) {
      logGitHubIgnored({
        deliveryId,
        repoFullName,
        eventType: eventTypeHeader,
        action: normalized.action,
        reason: "event_unsupported",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const sourceTs = getGitHubEventSourceTs(parsed.data);
    const delayMs = githubMentionDelay;
    const correlationKey = normalized.branch
      ? resolveCorrelationKeys([buildCorrelationKey(normalized.localRepo, normalized.branch)])
      : buildPendingBranchResolveKey(normalized.localRepo, normalized.number);

    queue.enqueue({
      id: deliveryId,
      source: "github",
      correlationKey,
      payload: normalized,
      receivedAt: new Date().toISOString(),
      sourceTs,
      readyAt: sourceTs + delayMs,
      delayMs,
      interrupt: true,
    });

    logInfo(log, "github_event_accepted", {
      deliveryId,
      repoFullName: normalized.repoFullName,
      localRepo: normalized.localRepo,
      eventType: normalized.eventType,
      action: normalized.action,
      correlationKey,
      interrupt: true,
      delayMs,
    });

    res.status(200).json({ ok: true });
  });

  // --- Cron trigger ---

  app.post("/cron", (req: Request, res: Response) => {
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

    queue.enqueue({
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
