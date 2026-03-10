import { createLogger, logInfo } from "@thor/common";
import { createGatewayApp } from "./app.js";

const log = createLogger("gateway");

const PORT = parseInt(process.env.PORT || "3002", 10);
const RUNNER_URL = (process.env.RUNNER_URL || "http://runner:3000").replace(/\/$/, "");
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_TIMESTAMP_TOLERANCE_SECONDS = parseInt(
  process.env.SLACK_TIMESTAMP_TOLERANCE_SECONDS || "300",
  10,
);
const QUEUE_DIR = process.env.QUEUE_DIR || "data/queue";

const { app } = createGatewayApp({
  runnerUrl: RUNNER_URL,
  signingSecret: SLACK_SIGNING_SECRET,
  slackBotToken: SLACK_BOT_TOKEN,
  timestampToleranceSeconds: SLACK_TIMESTAMP_TOLERANCE_SECONDS,
  queueDir: QUEUE_DIR,
});

app.listen(PORT, () => {
  logInfo(log, "gateway_started", {
    port: PORT,
    runnerUrl: RUNNER_URL,
    queueDir: QUEUE_DIR,
    configured: Boolean(SLACK_SIGNING_SECRET && SLACK_BOT_TOKEN),
  });
});
