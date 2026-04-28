import express, { type Express, type Request, type Response } from "express";
import {
  appendJsonlWorklog,
  createLogger,
  findNotesFile,
  logError,
  logInfo,
  resolveCorrelationKeys,
  hasSlackReply,
  getAllowedChannelIds,
  getChannelRepoMap,
  resolveRepoDirectory,
  writeInboundWebhookHistory,
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
  type BatchLogPrefix,
  type BatchSource,
  type InternalExecClient,
  type RunnerDeps,
  type SlackMcpDeps,
} from "./service.js";
import { verifyThorAuthoredSha } from "./github-gate.js";
import { deepHealthCheck } from "./healthcheck.js";
import {
  getSlackCorrelationKey,
  parseSlackTs,
  SlackEventEnvelopeSchema,
  SlackInteractivityPayloadSchema,
  SlackUrlVerificationSchema,
  verifySlackSignature,
  type SlackThreadEvent,
} from "./slack.js";
import { CronRequestSchema, deriveCronCorrelationKey, type CronPayload } from "./cron.js";
import {
  buildCorrelationKey,
  buildPendingBranchResolveKey,
  getGitHubEventBranch,
  getGitHubEventNumber,
  getGitHubEventSourceTs,
  getGitHubEventType,
  GitHubWebhookEnvelopeSchema,
  isPendingBranchResolveKey,
  isCheckSuiteCompletedEvent,
  shouldIgnoreGitHubEvent,
  type GitHubQueuedPayload,
  verifyGitHubSignature,
} from "./github.js";

interface SlackQueuedEvent extends QueuedEvent<SlackThreadEvent> {
  source: "slack";
}

interface CronQueuedEvent extends QueuedEvent<CronPayload> {
  source: "cron";
}

interface GitHubQueuedEvent extends QueuedEvent<GitHubQueuedPayload> {
  source: "github";
}

function isSlackEvent(e: QueuedEvent): e is SlackQueuedEvent {
  return e.source === "slack";
}

function isCronEvent(e: QueuedEvent): e is CronQueuedEvent {
  return e.source === "cron";
}

function isGitHubEvent(e: QueuedEvent): e is GitHubQueuedEvent {
  return e.source === "github";
}

function isGitHubQueuedPayload(payload: unknown): payload is GitHubQueuedPayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as {
    v?: unknown;
    event?: unknown;
    deliveryId?: unknown;
    localRepo?: unknown;
    resolvedBranch?: unknown;
  };
  return (
    candidate.v === 2 &&
    typeof candidate.deliveryId === "string" &&
    typeof candidate.localRepo === "string" &&
    (candidate.resolvedBranch === undefined || typeof candidate.resolvedBranch === "string") &&
    GitHubWebhookEnvelopeSchema.safeParse(candidate.event).success
  );
}

const log = createLogger("gateway");

interface RawBodyRequest extends Request {
  rawBody?: string;
  rawBodyBuffer?: Buffer;
}

type HeaderValue = string | string[] | undefined;

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

function buildRawBodyFields(
  rawBodyBuffer: Buffer,
): Pick<InboundWebhookHistoryEntry, "rawBodyUtf8" | "rawBodyBase64"> {
  return {
    rawBodyUtf8: rawBodyBuffer.toString("utf8"),
    rawBodyBase64: rawBodyBuffer.toString("base64"),
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
  "check_suite",
]);

type GitHubIgnoreReason =
  | "signature_invalid"
  | "event_unsupported"
  | "json_parse_error"
  | "schema_validation_failed"
  | "repo_not_mapped"
  | "pure_issue_comment_unsupported"
  | "fork_pr_unsupported"
  | "self_sender"
  | "empty_review_body"
  | "non_mention_comment"
  | "check_suite_branch_missing"
  | "correlation_key_unresolved"
  | "check_suite_gate_failed";

const GITHUB_WEBHOOK_INGESTED_STREAM = "github-webhook-ingested";
const GITHUB_WEBHOOK_IGNORED_STREAM = "github-webhook-ignored";

export interface GatewayAppConfig extends RunnerDeps {
  signingSecret: string;
  slackMcpUrl: string;
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
  return SlackInteractivityPayloadSchema.safeParse(JSON.parse(parsed.data.payload));
}

export interface GatewayApp {
  app: Express;
  queue: EventQueue;
}

export function createGatewayApp(config: GatewayAppConfig): GatewayApp {
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

  const writeGitHubWebhookHistory = (
    stream: "ingested" | "ignored",
    entry: InboundWebhookHistoryEntry,
  ) => {
    appendJsonlWorklog(
      stream === "ingested" ? GITHUB_WEBHOOK_INGESTED_STREAM : GITHUB_WEBHOOK_IGNORED_STREAM,
      entry,
    );
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
  const slackMcpDeps: SlackMcpDeps = {
    slackMcpUrl: config.slackMcpUrl,
    fetchImpl: config.fetchImpl,
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
        if (githubEvents.some((event) => !isGitHubQueuedPayload(event.payload))) {
          reject("legacy_payload_shape");
          logTrigger(logPrefix, "dropped", "legacy_payload_shape");
          return;
        }

        const plan = await planBatchDispatch({
          slackEvents: slackEvents.map((event) => event.payload),
          cronEvents: cronEvents.map((event) => event.payload),
          githubEvents: githubEvents.map((event) => event.payload),
          correlationKey: correlationKey ?? "",
          deps: runnerDeps,
          slackMcpDeps,
          remoteCliUrl,
          internalSecret: config.internalSecret,
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
      slackMcpUrl: config.slackMcpUrl,
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
      configured: Boolean(config.signingSecret),
    });
  });

  app.post("/slack/events", webhookRawParser, (req: Request, res: Response) => {
    const rawBodyBuffer = getRawBufferFromBody(req.body);
    const { rawBodyUtf8, rawBodyBase64 } = buildRawBodyFields(rawBodyBuffer);
    const signature = req.header("x-slack-signature");
    const timestamp = req.header("x-slack-request-timestamp");
    const headers = getHeaderSnapshot(req, [
      "content-type",
      "user-agent",
      "x-request-id",
      "x-slack-request-id",
      "x-slack-request-timestamp",
      "x-slack-signature",
      "x-slack-retry-num",
      "x-slack-retry-reason",
    ]);

    const verified = verifySlackSignature({
      signingSecret: config.signingSecret,
      rawBody: rawBodyUtf8,
      signature,
      timestamp,
      toleranceSeconds: config.timestampToleranceSeconds,
    });

    if (!verified) {
      writeInboundWebhookHistory({
        timestamp: new Date().toISOString(),
        route: "/slack/events",
        provider: "slack",
        signatureVerified: false,
        parseStatus: "not_parsed",
        requestId:
          (typeof headers["x-slack-request-id"] === "string" && headers["x-slack-request-id"]) ||
          (typeof headers["x-request-id"] === "string" && headers["x-request-id"]) ||
          undefined,
        reason: "signature_invalid",
        headers,
        rawBodyUtf8,
        rawBodyBase64,
      });
      res.status(401).json({ error: "Invalid Slack signature" });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBodyUtf8);
    } catch {
      writeInboundWebhookHistory({
        timestamp: new Date().toISOString(),
        route: "/slack/events",
        provider: "slack",
        signatureVerified: true,
        parseStatus: "json_invalid",
        requestId:
          (typeof headers["x-slack-request-id"] === "string" && headers["x-slack-request-id"]) ||
          (typeof headers["x-request-id"] === "string" && headers["x-request-id"]) ||
          undefined,
        reason: "json_parse_error",
        headers,
        rawBodyUtf8,
        rawBodyBase64,
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const urlVerification = SlackUrlVerificationSchema.safeParse(parsedBody);
    if (urlVerification.success) {
      writeInboundWebhookHistory({
        timestamp: new Date().toISOString(),
        route: "/slack/events",
        provider: "slack",
        signatureVerified: true,
        parseStatus: "url_verification",
        requestId:
          (typeof headers["x-slack-request-id"] === "string" && headers["x-slack-request-id"]) ||
          (typeof headers["x-request-id"] === "string" && headers["x-request-id"]) ||
          undefined,
        eventType: "url_verification",
        headers,
        rawBodyUtf8,
        rawBodyBase64,
      });
      res.json({ challenge: urlVerification.data.challenge });
      return;
    }

    const envelope = SlackEventEnvelopeSchema.safeParse(parsedBody);
    if (!envelope.success) {
      writeInboundWebhookHistory({
        timestamp: new Date().toISOString(),
        route: "/slack/events",
        provider: "slack",
        signatureVerified: true,
        parseStatus: "schema_invalid",
        requestId:
          (typeof headers["x-slack-request-id"] === "string" && headers["x-slack-request-id"]) ||
          (typeof headers["x-request-id"] === "string" && headers["x-request-id"]) ||
          undefined,
        reason: "schema_validation_failed",
        headers,
        rawBodyUtf8,
        rawBodyBase64,
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const event = envelope.data.event;
    const eventId = envelope.data.event_id;
    const requestId =
      (typeof headers["x-slack-request-id"] === "string" && headers["x-slack-request-id"]) ||
      (typeof headers["x-request-id"] === "string" && headers["x-request-id"]) ||
      eventId;

    writeInboundWebhookHistory({
      timestamp: new Date().toISOString(),
      route: "/slack/events",
      provider: "slack",
      signatureVerified: true,
      parseStatus: "schema_valid",
      requestId,
      eventType: event.type,
      reason: "received",
      headers,
      rawBodyUtf8,
      rawBodyBase64,
      metadata: {
        eventId,
        teamId: envelope.data.team_id,
      },
    });

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
      void addSlackReaction(event.channel, event.ts, "eyes", slackMcpDeps).catch((err) =>
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

    // Handle approval button clicks
    if (result.success && result.data.type === "block_actions" && result.data.actions) {
      const payload = result.data;
      for (const action of payload.actions!) {
        if (
          (action.action_id === "approval_approve" || action.action_id === "approval_reject") &&
          action.value
        ) {
          const decision = action.action_id === "approval_approve" ? "approved" : "rejected";
          const reviewer = payload.user?.id ?? "unknown";
          const channel = payload.channel?.id;
          const messageTs = payload.message?.ts;

          // Button value format:
          //   v2:{actionId}:{upstreamName}
          const parts = action.value.split(":");
          let actionId: string;
          let upstreamName: string;

          if (parts[0] === "v2" && parts.length >= 3) {
            actionId = parts[1];
            upstreamName = parts[2];
          } else {
            logError(log, "approval_resolve_failed", "Unrecognized button value format", {
              value: action.value,
            });
            res.status(200).json({ ok: true });
            return;
          }

          logInfo(log, "approval_action", {
            actionId,
            upstreamName,
            decision,
            reviewer,
            remoteCliUrl,
          });

          // Respond immediately to Slack (must reply within 3s)
          res.status(200).json({ ok: true });
          void (async () => {
            const resolved = await resolveApproval(
              actionId,
              decision,
              reviewer,
              remoteCliUrl,
              config.internalSecret,
              config.fetchImpl,
            );
            if (!resolved) {
              logError(log, "approval_resolve_failed", "remote-cli returned error", { actionId });
              return;
            }
            if (channel && messageTs) {
              const statusEmoji = decision === "approved" ? "✅" : "❌";
              const decisionLabel = decision.charAt(0).toUpperCase() + decision.slice(1);
              const text = `${statusEmoji} *${decisionLabel}* by <@${reviewer}>`;
              await updateSlackMessage(channel, messageTs, text, slackMcpDeps);
            }
          })();
          return;
        }
      }
    }

    res.status(200).json({ ok: true, ignored: true, interactionType });
  });

  // --- GitHub webhook ---

  app.post("/github/webhook", webhookRawParser, async (req: Request, res: Response) => {
    const rawBodyBuffer = getRawBufferFromBody(req.body);
    const { rawBodyUtf8, rawBodyBase64 } = buildRawBodyFields(rawBodyBuffer);
    const deliveryId = req.header("x-github-delivery") ?? "unknown";
    const eventTypeHeader = (req.header("x-github-event") ?? "").toLowerCase();
    const signature = req.header("x-hub-signature-256");
    const headers = getHeaderSnapshot(req, [
      "content-type",
      "user-agent",
      "x-request-id",
      "x-github-delivery",
      "x-github-event",
      "x-hub-signature-256",
      "x-github-hook-id",
      "x-github-hook-installation-target-id",
      "x-github-hook-installation-target-type",
    ]);
    const baseEntry = {
      timestamp: new Date().toISOString(),
      route: "/github/webhook",
      provider: "github",
      requestId: deliveryId,
      eventType: eventTypeHeader || undefined,
      headers,
      rawBodyUtf8,
      rawBodyBase64,
    } satisfies Pick<
      InboundWebhookHistoryEntry,
      | "timestamp"
      | "route"
      | "provider"
      | "requestId"
      | "eventType"
      | "headers"
      | "rawBodyUtf8"
      | "rawBodyBase64"
    >;

    const verified = verifyGitHubSignature({
      secret: config.githubWebhookSecret ?? "",
      rawBody: rawBodyBuffer,
      header: signature,
    });
    if (!verified) {
      writeGitHubWebhookHistory("ignored", {
        ...baseEntry,
        signatureVerified: false,
        parseStatus: "not_parsed",
        reason: "signature_invalid",
      });
      logGitHubIgnored({
        deliveryId,
        eventType: eventTypeHeader || undefined,
        reason: "signature_invalid",
      });
      res.status(401).json({ error: "Invalid GitHub signature" });
      return;
    }

    if (!GITHUB_SUPPORTED_EVENTS.has(eventTypeHeader)) {
      writeGitHubWebhookHistory("ignored", {
        ...baseEntry,
        signatureVerified: true,
        parseStatus: "not_parsed",
        reason: "event_unsupported",
      });
      logGitHubIgnored({
        deliveryId,
        eventType: eventTypeHeader || undefined,
        reason: "event_unsupported",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBodyUtf8);
    } catch {
      writeGitHubWebhookHistory("ignored", {
        ...baseEntry,
        signatureVerified: true,
        parseStatus: "json_invalid",
        reason: "json_parse_error",
      });
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
      writeGitHubWebhookHistory("ignored", {
        ...baseEntry,
        signatureVerified: true,
        parseStatus: "schema_invalid",
        reason: "schema_validation_failed",
      });
      logGitHubIgnored({
        deliveryId,
        eventType: eventTypeHeader || undefined,
        reason: "schema_validation_failed",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const repoFullName = parsed.data.repository.full_name;
    const parts = repoFullName.split("/");
    const localRepo = parts[parts.length - 1];
    if (!localRepo || !resolveRepoDirectory(localRepo)) {
      writeGitHubWebhookHistory("ignored", {
        ...baseEntry,
        signatureVerified: true,
        parseStatus: "schema_valid",
        action: parsed.data.action,
        reason: "repo_not_mapped",
        metadata: {
          repoFullName,
          localRepo,
        },
      });
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

    const eventType = getGitHubEventType(parsed.data);
    if (eventType !== eventTypeHeader) {
      writeGitHubWebhookHistory("ignored", {
        ...baseEntry,
        signatureVerified: true,
        parseStatus: "schema_valid",
        action: parsed.data.action,
        reason: "event_unsupported",
        metadata: {
          repoFullName,
          localRepo,
        },
      });
      logGitHubIgnored({
        deliveryId,
        repoFullName,
        eventType: eventTypeHeader,
        action: parsed.data.action,
        reason: "event_unsupported",
      });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const ignoreReason = shouldIgnoreGitHubEvent(parsed.data, {
      mentionLogins: githubMentionLogins,
      botId: githubAppBotId,
    });
    if (ignoreReason) {
      writeGitHubWebhookHistory("ignored", {
        ...baseEntry,
        signatureVerified: true,
        parseStatus: "schema_valid",
        action: parsed.data.action,
        reason: ignoreReason,
        metadata: {
          repoFullName,
          localRepo,
        },
      });
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

    if (isCheckSuiteCompletedEvent(parsed.data)) {
      if (!branch) {
        writeGitHubWebhookHistory("ignored", {
          ...baseEntry,
          signatureVerified: true,
          parseStatus: "schema_valid",
          action: parsed.data.action,
          reason: "check_suite_branch_missing",
          metadata: {
            repoFullName,
            localRepo,
            headSha: parsed.data.check_suite.head_sha,
          },
        });
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
      if (!findNotesFile(resolvedKey)) {
        writeGitHubWebhookHistory("ignored", {
          ...baseEntry,
          signatureVerified: true,
          parseStatus: "schema_valid",
          action: parsed.data.action,
          reason: "correlation_key_unresolved",
          metadata: {
            repoFullName,
            localRepo,
            rawKey,
            resolvedKey,
            headSha: parsed.data.check_suite.head_sha,
          },
        });
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
        writeGitHubWebhookHistory("ignored", {
          ...baseEntry,
          signatureVerified: true,
          parseStatus: "schema_valid",
          action: parsed.data.action,
          reason: "check_suite_gate_failed",
          metadata: {
            repoFullName,
            localRepo,
            rawKey,
            resolvedKey,
            headSha: parsed.data.check_suite.head_sha,
            gateReason: gate.reason,
          },
        });
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
    } else {
      correlationKey = branch
        ? resolveCorrelationKeys([buildCorrelationKey(localRepo, branch)])
        : buildPendingBranchResolveKey(localRepo, getGitHubEventNumber(parsed.data));
    }

    const sourceTs = getGitHubEventSourceTs(parsed.data);

    queue.enqueue({
      id: deliveryId,
      source: "github",
      correlationKey,
      payload: { v: 2, event: parsed.data, deliveryId, localRepo },
      receivedAt: new Date().toISOString(),
      sourceTs,
      readyAt: sourceTs + delayMs,
      delayMs,
      interrupt,
    });

    writeGitHubWebhookHistory("ingested", {
      ...baseEntry,
      signatureVerified: true,
      parseStatus: "schema_valid",
      action: parsed.data.action,
      reason: "accepted",
      metadata: {
        repoFullName,
        localRepo,
        correlationKey,
      },
    });

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
