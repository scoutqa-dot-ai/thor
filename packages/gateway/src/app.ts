import express, { type Express, type Request, type Response } from "express";
import {
  createChannelFilter,
  createLogger,
  logError,
  logInfo,
  resolveCorrelationKey,
  resolveCorrelationKeys,
} from "@thor/common";
import { z } from "zod/v4";
import { EventQueue, type QueuedEvent } from "./queue.js";
import {
  addSlackReaction,
  hasRunnerSession,
  triggerRunnerSlack,
  triggerRunnerGitHub,
  triggerRunnerCron,
  resolveApproval,
  updateSlackMessage,
  type RunnerDeps,
  type SlackMcpDeps,
} from "./service.js";
import { getGitHubCorrelationKeys, parseGitHubEvent, type GitHubEvent } from "./github.js";
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

interface SlackQueuedEvent extends QueuedEvent<SlackThreadEvent> {
  source: "slack";
}

interface GitHubQueuedEvent extends QueuedEvent<GitHubEvent> {
  source: "github";
}

interface CronQueuedEvent extends QueuedEvent<CronPayload> {
  source: "cron";
}

function isSlackEvent(e: QueuedEvent): e is SlackQueuedEvent {
  return e.source === "slack";
}

function isGitHubEvent(e: QueuedEvent): e is GitHubQueuedEvent {
  return e.source === "github";
}

function isCronEvent(e: QueuedEvent): e is CronQueuedEvent {
  return e.source === "cron";
}

const log = createLogger("gateway");

interface RawBodyRequest extends Request {
  rawBody?: string;
}

/** Default batch delay for Slack events (ms). */
const SLACK_ACTIVE_DELAY_MS = 3000;

/** Delay for unaddressed messages — hope someone else handles it first (ms). */
const SLACK_UNADDRESSED_DELAY_MS = 60_000;

/** Batch delay for GitHub events (ms). */
const GITHUB_DELAY_MS = 60_000;

export interface GatewayAppConfig extends RunnerDeps {
  signingSecret: string;
  slackMcpUrl: string;
  /** Our bot's Slack user ID — used to ignore our own messages. */
  slackBotUserId: string;
  /** Proxy hostname for approval resolution. Default: "proxy". */
  proxyHost?: string;
  timestampToleranceSeconds?: number;
  /** Directory for the event queue. Default: "data/queue". */
  queueDir?: string;
  /** Disable the queue polling interval (for tests). Default: false. */
  disableQueueInterval?: boolean;
  /** Delay for mentions and active-session events in ms. Default: 3000. */
  slackActiveDelayMs?: number;
  /** Delay for unaddressed messages in ms. Default: 60000. */
  slackUnaddressedDelayMs?: number;
  /** Delay for GitHub events in ms. Default: 60000. */
  githubDelayMs?: number;
  /** Slack channel IDs the bot is allowed to respond in. Empty = allow all. */
  allowedChannelIds?: string[];
  /** Shared secret for cron endpoint auth. If unset, auth is skipped. */
  cronSecret?: string;
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
  const batchDelay = config.slackActiveDelayMs ?? SLACK_ACTIVE_DELAY_MS;
  const unaddressedDelay = config.slackUnaddressedDelayMs ?? SLACK_UNADDRESSED_DELAY_MS;
  const githubDelay = config.githubDelayMs ?? GITHUB_DELAY_MS;
  const isChannelAllowed = createChannelFilter(new Set(config.allowedChannelIds ?? []));

  const runnerDeps: RunnerDeps = {
    runnerUrl: config.runnerUrl,
    fetchImpl: config.fetchImpl,
  };
  const slackMcpDeps: SlackMcpDeps = {
    slackMcpUrl: config.slackMcpUrl,
    fetchImpl: config.fetchImpl,
  };
  const proxyHost = config.proxyHost ?? "proxy";

  const queue = new EventQueue({
    dir: config.queueDir ?? "data/queue",
    disableInterval: config.disableQueueInterval === true,
    handler: async (events: QueuedEvent[]) => {
      const slackEvents = events.filter(isSlackEvent);
      const githubEvents = events.filter(isGitHubEvent);

      if (slackEvents.length > 0) {
        const lastEvent = slackEvents[slackEvents.length - 1];

        triggerRunnerSlack(
          slackEvents.map((e) => e.payload),
          lastEvent.correlationKey,
          runnerDeps,
          slackMcpDeps,
        )
          .then(() =>
            logInfo(log, "slack_trigger_fired", {
              correlationKey: lastEvent.correlationKey,
              batchSize: slackEvents.length,
            }),
          )
          .catch((error) =>
            logError(log, "slack_trigger_failed", error, {
              correlationKey: lastEvent.correlationKey,
            }),
          );
      }

      if (githubEvents.length > 0) {
        const lastEvent = githubEvents[githubEvents.length - 1];

        triggerRunnerGitHub(
          githubEvents.map((e) => e.payload),
          lastEvent.correlationKey,
          runnerDeps,
        )
          .then(() =>
            logInfo(log, "github_trigger_fired", {
              correlationKey: lastEvent.correlationKey,
              batchSize: githubEvents.length,
            }),
          )
          .catch((error) =>
            logError(log, "github_trigger_failed", error, {
              correlationKey: lastEvent.correlationKey,
            }),
          );
      }

      const cronEvents = events.filter(isCronEvent);
      if (cronEvents.length > 0) {
        const lastEvent = cronEvents[cronEvents.length - 1];

        triggerRunnerCron(lastEvent.payload, lastEvent.correlationKey, runnerDeps)
          .then(() =>
            logInfo(log, "cron_trigger_fired", {
              correlationKey: lastEvent.correlationKey,
            }),
          )
          .catch((error) =>
            logError(log, "cron_trigger_failed", error, {
              correlationKey: lastEvent.correlationKey,
            }),
          );
      }
    },
  });

  // --- Express app ---

  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use(
    express.urlencoded({
      extended: false,
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString("utf8");
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "gateway",
      runnerUrl: config.runnerUrl,
      configured: Boolean(config.signingSecret),
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

    // Ignore our own messages
    if (event.user === selfUserId) {
      logInfo(log, "event_ignored_self", { eventId });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Block DMs and non-allowlisted channels
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
      const correlationKey = resolveCorrelationKey(rawKey);
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
        readyAt: Date.now() + batchDelay,
        delayMs: batchDelay,
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
      res.status(200).json({ ok: true });
      const rawKey = getSlackCorrelationKey(event);
      const correlationKey = resolveCorrelationKey(rawKey);
      if (correlationKey !== rawKey) {
        logInfo(log, "corr_key_resolved", { rawKey, correlationKey });
      }

      void (async () => {
        // Thread reply with existing session → short batch delay
        // New message or thread without session → long delay, hope someone else handles it
        const hasSession = event.thread_ts
          ? await hasRunnerSession(correlationKey, runnerDeps)
          : false;
        const delay = hasSession ? batchDelay : unaddressedDelay;

        logInfo(log, "event_accepted", {
          eventId,
          teamId: envelope.data.team_id,
          eventType: event.type,
          channel: event.channel,
          ts: event.ts,
          threadTs: event.thread_ts,
          correlationKey,
          delay,
        });
        queue.enqueue({
          id: eventId,
          source: "slack",
          correlationKey,
          payload: event,
          receivedAt: new Date().toISOString(),
          sourceTs: parseSlackTs(event.ts),
          readyAt: Date.now() + delay,
          delayMs: delay,
        });
      })();
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

          // Button value format: "v1:{actionId}:{proxyPort}" (versioned)
          // Legacy (no version prefix) is rejected.
          const parts = action.value.split(":");
          if (parts[0] !== "v1" || parts.length < 3) {
            logError(log, "approval_resolve_failed", "Unrecognized button value format", {
              value: action.value,
            });
            res.status(200).json({ ok: true });
            return;
          }
          const actionId = parts[1];
          const proxyPort = parseInt(parts[2], 10);

          logInfo(log, "approval_action", { actionId, decision, reviewer, proxyPort });

          if (!proxyPort) {
            logError(log, "approval_resolve_failed", "No proxy port in button value", {
              actionId,
            });
            res.status(200).json({ ok: true });
            return;
          }

          // Respond immediately to Slack (must reply within 3s)
          res.status(200).json({ ok: true });

          // Resolve asynchronously
          const proxyUrl = `http://${proxyHost}:${proxyPort}`;
          void (async () => {
            const resolved = await resolveApproval(
              actionId,
              decision,
              reviewer,
              proxyUrl,
              config.fetchImpl,
            );
            if (channel && messageTs) {
              const statusEmoji = decision === "approved" ? "✅" : "❌";
              const text = `${statusEmoji} *${decision.charAt(0).toUpperCase() + decision.slice(1)}* by <@${reviewer}>`;
              await updateSlackMessage(channel, messageTs, text, slackMcpDeps);
            }
            if (!resolved) {
              logError(log, "approval_resolve_failed", "Proxy returned error", { actionId });
            }
          })();
          return;
        }
      }
    }

    res.status(200).json({ ok: true, ignored: true, interactionType });
  });

  // --- GitHub events ---

  app.post("/github/events", (req: Request, res: Response) => {
    const event = parseGitHubEvent(req.body);
    if (!event) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const rawKeys = getGitHubCorrelationKeys(event);
    const correlationKey = resolveCorrelationKeys(rawKeys);
    if (correlationKey !== rawKeys[0]) {
      logInfo(log, "corr_key_resolved", { rawKeys, correlationKey });
    }

    logInfo(log, "github_event_accepted", {
      event: event.event,
      correlationKey,
    });

    queue.enqueue({
      id: crypto.randomUUID(),
      source: "github",
      correlationKey,
      payload: event,
      receivedAt: new Date().toISOString(),
      sourceTs: Date.now(),
      readyAt: Date.now() + githubDelay,
      delayMs: githubDelay,
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

    const { prompt, correlationKey: providedKey } = parsed.data;
    const correlationKey = providedKey ?? deriveCronCorrelationKey(prompt);

    const payload: CronPayload = { prompt };

    queue.enqueue({
      id: `cron-${Date.now()}`,
      source: "cron",
      correlationKey,
      payload,
      receivedAt: new Date().toISOString(),
      sourceTs: Date.now(),
      readyAt: Date.now(),
      delayMs: 0,
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
