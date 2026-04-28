import {
  createLogger,
  deriveGitHubAppBotIdentity,
  logError,
  logInfo,
  createConfigLoader,
  getAllowedChannelIds,
  requireEnv,
  WORKSPACE_CONFIG_PATH,
} from "@thor/common";
import { createGatewayApp } from "./app.js";
import { validateGatewayGitHubEnv } from "./env.js";
import { buildMentionLogins } from "./github.js";

const log = createLogger("gateway");

const PORT = parseInt(process.env.PORT || "3002", 10);
const RUNNER_URL = (process.env.RUNNER_URL || "http://runner:3000").replace(/\/$/, "");
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_API_BASE_URL = (process.env.SLACK_API_BASE_URL || "https://slack.com/api").replace(
  /\/$/,
  "",
);
const SLACK_TIMESTAMP_TOLERANCE_SECONDS = parseInt(
  process.env.SLACK_TIMESTAMP_TOLERANCE_SECONDS || "300",
  10,
);
const QUEUE_DIR = process.env.QUEUE_DIR || "data/queue";
const SLACK_BOT_USER_ID = process.env.SLACK_BOT_USER_ID || "";
const CRON_SECRET = process.env.CRON_SECRET || "";
const REMOTE_CLI_HOST = process.env.REMOTE_CLI_HOST || "remote-cli";
const REMOTE_CLI_PORT = parseInt(process.env.REMOTE_CLI_PORT || "3004", 10);
const THOR_INTERNAL_SECRET = requireEnv("THOR_INTERNAL_SECRET");
const OPENAI_AUTH_PATH = process.env.OPENAI_AUTH_PATH || "";
const githubEnv = validateGatewayGitHubEnv();
const githubMentionLogins = buildMentionLogins(githubEnv.githubAppSlug);
const githubAppBotIdentity = deriveGitHubAppBotIdentity({
  slug: githubEnv.githubAppSlug,
  botId: githubEnv.githubAppBotId,
});
const getConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

if (!SLACK_BOT_TOKEN.trim()) {
  logError(log, "missing_env", "SLACK_BOT_TOKEN is required");
  process.exit(1);
}

const { app } = createGatewayApp({
  runnerUrl: RUNNER_URL,
  signingSecret: SLACK_SIGNING_SECRET,
  slackBotToken: SLACK_BOT_TOKEN,
  slackApiBaseUrl: SLACK_API_BASE_URL,
  slackBotUserId: SLACK_BOT_USER_ID,
  remoteCliHost: REMOTE_CLI_HOST,
  remoteCliPort: REMOTE_CLI_PORT,
  internalSecret: THOR_INTERNAL_SECRET,
  timestampToleranceSeconds: SLACK_TIMESTAMP_TOLERANCE_SECONDS,
  queueDir: QUEUE_DIR,
  cronSecret: CRON_SECRET || undefined,
  getConfig,
  openaiAuthPath: OPENAI_AUTH_PATH || undefined,
  githubWebhookSecret: githubEnv.githubWebhookSecret,
  githubMentionLogins,
  githubAppBotId: githubEnv.githubAppBotId,
  githubAppBotEmail: githubAppBotIdentity.email,
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
    slackApiBaseUrl: SLACK_API_BASE_URL,
    remoteCliHost: REMOTE_CLI_HOST,
    queueDir: QUEUE_DIR,
    configured: Boolean(SLACK_SIGNING_SECRET && SLACK_BOT_TOKEN),
    githubAppSlug: githubEnv.githubAppSlug,
    githubAppBotId: githubEnv.githubAppBotId,
    githubMentionLogins,
    ...configSummary,
  });
});
