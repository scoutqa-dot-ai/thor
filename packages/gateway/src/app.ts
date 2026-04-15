import express, { type Express, type Request, type Response } from "express";
import {
  createLogger,
  logError,
  logInfo,
  resolveCorrelationKeys,
  hasSlackReply,
  getAllowedChannelIds,
  getChannelRepoMap,
  type ConfigLoader,
} from "@thor/common";
import { z } from "zod/v4";
import { EventQueue, type QueuedEvent } from "./queue.js";
import {
  addSlackReaction,
  triggerRunnerSlack,
  triggerRunnerCron,
  resolveApproval,
  updateSlackMessage,
  type RunnerDeps,
  type SlackMcpDeps,
} from "./service.js";
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

interface CronQueuedEvent extends QueuedEvent<CronPayload> {
  source: "cron";
}

function isSlackEvent(e: QueuedEvent): e is SlackQueuedEvent {
  return e.source === "slack";
}

function isCronEvent(e: QueuedEvent): e is CronQueuedEvent {
  return e.source === "cron";
}

const log = createLogger("gateway");

interface RawBodyRequest extends Request {
  rawBody?: string;
}

/** Short debounce delay for mentions and engaged threads (ms). */
const SHORT_DELAY_MS = 3000;

export interface GatewayAppConfig extends RunnerDeps {
  signingSecret: string;
  slackMcpUrl: string;
  /** Our bot's Slack user ID — used to ignore our own messages. */
  slackBotUserId: string;
  /** Proxy hostname for approval resolution. Default: "proxy". */
  proxyHost?: string;
  /** Proxy port for approval resolution. Default: 3001. */
  proxyPort?: number;
  timestampToleranceSeconds?: number;
  /** Directory for the event queue. Default: "data/queue". */
  queueDir?: string;
  /** Disable the queue polling interval (for tests). Default: false. */
  disableQueueInterval?: boolean;
  /** Short debounce delay for mentions and engaged threads (ms). Default: 3000. */
  shortDelayMs?: number;
  /** Shared secret for cron endpoint auth. If unset, auth is skipped. */
  cronSecret?: string;
  /** Dynamic workspace config loader — re-reads config.json on each request. */
  getConfig?: ConfigLoader;
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
  const proxyHost = config.proxyHost ?? "proxy";

  const queue = new EventQueue({
    dir: config.queueDir ?? "data/queue",
    disableInterval: config.disableQueueInterval === true,
    handler: async (events: QueuedEvent[], ack: () => void, reject: (reason: string) => void) => {
      const slackEvents = events.filter(isSlackEvent);

      if (slackEvents.length > 0) {
        const lastEvent = slackEvents[slackEvents.length - 1];
        const hasInterrupt = events.some((e) => e.interrupt);

        // Await the trigger so the queue keeps the per-key processing lock
        // until the runner responds. triggerRunnerSlack returns as soon as
        // the runner accepts (NDJSON stream is consumed in the background).
        try {
          const result = await triggerRunnerSlack(
            slackEvents.map((e) => e.payload),
            lastEvent.correlationKey,
            runnerDeps,
            slackMcpDeps,
            hasInterrupt,
            ack,
            getChannelRepos(),
            reject,
          );
          if (result.busy) {
            logInfo(log, "slack_trigger_busy", {
              correlationKey: lastEvent.correlationKey,
              batchSize: slackEvents.length,
            });
          } else {
            logInfo(log, "slack_trigger_fired", {
              correlationKey: lastEvent.correlationKey,
              batchSize: slackEvents.length,
            });
          }
        } catch (error) {
          logError(log, "slack_trigger_failed", error, {
            correlationKey: lastEvent.correlationKey,
          });
        }
        return;
      }

      const cronEvents = events.filter(isCronEvent);
      if (cronEvents.length > 0) {
        const lastEvent = cronEvents[cronEvents.length - 1];

        try {
          const result = await triggerRunnerCron(
            lastEvent.payload,
            lastEvent.correlationKey,
            runnerDeps,
            false,
            ack,
            reject,
          );
          if (result.busy) {
            logInfo(log, "cron_trigger_busy", {
              correlationKey: lastEvent.correlationKey,
            });
          } else {
            logInfo(log, "cron_trigger_fired", {
              correlationKey: lastEvent.correlationKey,
            });
          }
        } catch (error) {
          logError(log, "cron_trigger_failed", error, {
            correlationKey: lastEvent.correlationKey,
          });
        }
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
        readyAt: Date.now() + shortDelay,
        delayMs: shortDelay,
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

          // Button value formats:
          //   v2:{actionId}:{upstreamName} — current (name-based routing)
          //   v1:{actionId}:{proxyPort}    — legacy (port-based routing)
          const parts = action.value.split(":");
          let actionId: string;
          let proxyUrl: string;

          if (parts[0] === "v2" && parts.length >= 3) {
            actionId = parts[1];
            const upstreamName = parts[2];
            proxyUrl = `http://${proxyHost}:${config.proxyPort ?? 3001}/${upstreamName}`;
          } else if (parts[0] === "v1" && parts.length >= 3) {
            // TODO: Remove v1 support once all in-flight approvals have drained (safe after 2026-05-01)
            actionId = parts[1];
            const proxyPort = parseInt(parts[2], 10);
            proxyUrl = `http://${proxyHost}:${proxyPort}`;
          } else {
            logError(log, "approval_resolve_failed", "Unrecognized button value format", {
              value: action.value,
            });
            res.status(200).json({ ok: true });
            return;
          }

          logInfo(log, "approval_action", { actionId, decision, reviewer, proxyUrl });

          // Respond immediately to Slack (must reply within 3s)
          res.status(200).json({ ok: true });
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
