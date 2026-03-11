import express, { type Express, type Request, type Response } from "express";
import type { WebClient } from "@slack/web-api";
import { createLogger, logError, logInfo } from "@thor/common";
import { z } from "zod/v4";
import { EventQueue, type QueuedEvent } from "./queue.js";
import {
  addSlackReaction,
  hasRunnerSession,
  triggerRunner,
  type RunnerDeps,
  type SlackDeps,
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

interface SlackQueuedEvent extends QueuedEvent<SlackThreadEvent> {
  source: "slack";
}

function isSlackEvent(e: QueuedEvent): e is SlackQueuedEvent {
  return e.source === "slack";
}

const log = createLogger("gateway");

interface RawBodyRequest extends Request {
  rawBody?: string;
}

/** Default batch delay for Slack events (ms). */
const SLACK_ACTIVE_DELAY_MS = 3000;

/** Delay for unaddressed messages — hope someone else handles it first (ms). */
const SLACK_UNADDRESSED_DELAY_MS = 60_000;

/** Our bot's Slack user ID — used to ignore our own messages. */
const SELF_USER_ID = "U0BOTEXAMPLE";

export interface GatewayAppConfig extends RunnerDeps {
  signingSecret: string;
  slack: WebClient;
  timestampToleranceSeconds?: number;
  /** Directory for the event queue. Default: "data/queue". */
  queueDir?: string;
  /** Disable the queue polling interval (for tests). Default: false. */
  disableQueueInterval?: boolean;
  /** Delay for mentions and active-session events in ms. Default: 3000. */
  slackActiveDelayMs?: number;
  /** Delay for unaddressed messages in ms. Default: 60000. */
  slackUnaddressedDelayMs?: number;
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

  const batchDelay = config.slackActiveDelayMs ?? SLACK_ACTIVE_DELAY_MS;
  const unaddressedDelay = config.slackUnaddressedDelayMs ?? SLACK_UNADDRESSED_DELAY_MS;

  const runnerDeps: RunnerDeps = {
    runnerUrl: config.runnerUrl,
    fetchImpl: config.fetchImpl,
  };
  const slackDeps: SlackDeps = { slack: config.slack };

  const queue = new EventQueue({
    dir: config.queueDir ?? "data/queue",
    disableInterval: config.disableQueueInterval === true,
    handler: async (events: QueuedEvent[]) => {
      const slackEvents = events.filter(isSlackEvent);
      if (slackEvents.length === 0) return;

      const correlationKey = slackEvents[0].correlationKey;

      triggerRunner(
        slackEvents.map((e) => e.payload),
        correlationKey,
        runnerDeps,
      )
        .then(() =>
          logInfo(log, "slack_trigger_fired", {
            correlationKey,
            batchSize: slackEvents.length,
          }),
        )
        .catch((error) =>
          logError(log, "slack_trigger_failed", error, {
            correlationKey,
          }),
        );
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
      configured: Boolean(config.signingSecret && config.slack),
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

    // Ignore our own messages
    if (event.user === SELF_USER_ID) {
      logInfo(log, "event_ignored_self", { eventId });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // app_mention — always forward
    if (event.type === "app_mention") {
      res.status(200).json({ ok: true });
      void addSlackReaction(event.channel, event.ts, "eyes", slackDeps).catch((err) =>
        logError(log, "reaction_failed", err, { eventId }),
      );
      const correlationKey = getSlackCorrelationKey(event);
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
    if (event.type === "message" && !event.subtype && event.text?.includes(`<@${SELF_USER_ID}>`)) {
      logInfo(log, "event_ignored_mention_duplicate", { eventId });
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Message (no subtype — excludes system events like channel_join)
    if (event.type === "message" && !event.subtype) {
      res.status(200).json({ ok: true });
      const correlationKey = getSlackCorrelationKey(event);

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
    res.status(200).json({ ok: true, ignored: true, interactionType });
  });

  app.get("/slack/redirect", (req: Request, res: Response) => {
    res.status(501).json({
      error: "Slack OAuth redirect is configured but not implemented yet.",
      code: typeof req.query.code === "string" ? req.query.code : undefined,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
    });
  });

  return { app, queue };
}
