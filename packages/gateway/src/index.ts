import {
  createLogger,
  logInfo,
  createConfigLoader,
  getAllowedChannelIds,
  WORKSPACE_CONFIG_PATH,
} from "@thor/common";
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
const SLACK_BOT_USER_ID = process.env.SLACK_BOT_USER_ID || "";
const CRON_SECRET = process.env.CRON_SECRET || "";
const PROXY_HOST = process.env.PROXY_HOST || "proxy";
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "3001", 10);
const getConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

const { app } = createGatewayApp({
  runnerUrl: RUNNER_URL,
  signingSecret: SLACK_SIGNING_SECRET,
  slackMcpUrl: SLACK_MCP_URL,
  slackBotUserId: SLACK_BOT_USER_ID,
  proxyHost: PROXY_HOST,
  proxyPort: PROXY_PORT,
  timestampToleranceSeconds: SLACK_TIMESTAMP_TOLERANCE_SECONDS,
  queueDir: QUEUE_DIR,
  cronSecret: CRON_SECRET || undefined,
  getConfig,
});

app.listen(PORT, () => {
  let configSummary: Record<string, unknown> = {};
  try {
    const config = getConfig();
    configSummary = {
      allowedChannels: [...getAllowedChannelIds(config)],
      repos: Object.keys(config.repos),
    };
  } catch {
    configSummary = { config: "not available yet" };
  }
  logInfo(log, "gateway_started", {
    port: PORT,
    runnerUrl: RUNNER_URL,
    slackMcpUrl: SLACK_MCP_URL,
    proxyHost: PROXY_HOST,
    queueDir: QUEUE_DIR,
    configured: Boolean(SLACK_SIGNING_SECRET),
    ...configSummary,
  });
});
