import {
  createLogger,
  logError,
  logInfo,
  createConfigLoader,
  loadGatewayEnv,
  WORKSPACE_CONFIG_PATH,
} from "@thor/common";
import { createGatewayApp } from "./app.js";
import { buildMentionLogins } from "./github.js";

const log = createLogger("gateway");

const config = loadGatewayEnv();
const githubMentionLogins = buildMentionLogins(config.githubAppSlug);
const getConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

if (!config.slackBotToken.trim()) {
  logError(log, "missing_env", "SLACK_BOT_TOKEN is required");
  process.exit(1);
}

const { app } = createGatewayApp({
  runnerUrl: config.runnerUrl,
  signingSecret: config.slackSigningSecret,
  slackBotToken: config.slackBotToken,
  slackApiBaseUrl: config.slackApiBaseUrl,
  slackBotUserId: config.slackBotUserId,
  slackDefaultRepo: config.slackDefaultRepo,
  remoteCliHost: config.remoteCliHost,
  remoteCliPort: config.remoteCliPort,
  internalSecret: config.thorInternalSecret,
  timestampToleranceSeconds: config.slackTimestampToleranceSeconds,
  queueDir: config.queueDir,
  cronSecret: config.cronSecret || undefined,
  getConfig,
  openaiAuthPath: config.openaiAuthPath || undefined,
  githubWebhookSecret: config.githubWebhookSecret,
  githubMentionLogins,
  githubAppBotId: config.githubAppBotId,
  githubAppBotEmail: config.githubAppBotEmail,
});

app.listen(config.port, () => {
  let configSummary: Record<string, unknown> = {};
  try {
    const workspaceConfig = getConfig();
    configSummary = {
      repos: Object.keys(workspaceConfig.repos),
      slackDefaultRepo: config.slackDefaultRepo,
    };
  } catch {
    configSummary = { config: "not available yet" };
  }
  logInfo(log, "gateway_started", {
    port: config.port,
    runnerUrl: config.runnerUrl,
    slackApiBaseUrl: config.slackApiBaseUrl,
    remoteCliHost: config.remoteCliHost,
    queueDir: config.queueDir,
    configured: Boolean(config.slackSigningSecret && config.slackBotToken),
    githubAppSlug: config.githubAppSlug,
    githubAppBotId: config.githubAppBotId,
    githubMentionLogins,
    ...configSummary,
  });
});
