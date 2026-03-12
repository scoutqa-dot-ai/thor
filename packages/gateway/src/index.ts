import { createLogger, logInfo, parseAllowedChannelIds } from "@thor/common";
import { createGatewayApp } from "./app.js";

const log = createLogger("gateway");

const PORT = parseInt(process.env.PORT || "3002", 10);
const RUNNER_URL = (process.env.RUNNER_URL || "http://runner:3000").replace(/\/$/, "");
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_MCP_URL = (process.env.SLACK_MCP_URL || "http://slack-mcp:3003").replace(/\/$/, "");
const SLACK_TIMESTAMP_TOLERANCE_SECONDS = parseInt(
  process.env.SLACK_TIMESTAMP_TOLERANCE_SECONDS || "300",
  10,
);
const QUEUE_DIR = process.env.QUEUE_DIR || "data/queue";
const SLACK_ALLOWED_CHANNEL_IDS = [
  ...parseAllowedChannelIds(process.env.SLACK_ALLOWED_CHANNEL_IDS),
];

const { app } = createGatewayApp({
  runnerUrl: RUNNER_URL,
  signingSecret: SLACK_SIGNING_SECRET,
  slackMcpUrl: SLACK_MCP_URL,
  timestampToleranceSeconds: SLACK_TIMESTAMP_TOLERANCE_SECONDS,
  queueDir: QUEUE_DIR,
  allowedChannelIds: SLACK_ALLOWED_CHANNEL_IDS,
});

app.listen(PORT, () => {
  logInfo(log, "gateway_started", {
    port: PORT,
    runnerUrl: RUNNER_URL,
    slackMcpUrl: SLACK_MCP_URL,
    queueDir: QUEUE_DIR,
    configured: Boolean(SLACK_SIGNING_SECRET),
    allowedChannels: SLACK_ALLOWED_CHANNEL_IDS.length > 0 ? SLACK_ALLOWED_CHANNEL_IDS : "all",
  });
});
