import { createConfigLoader, createLogger, logError, logInfo, loadGatewayEnv } from "@thor/common";
import { createGatewayApp } from "./app.js";
import { buildMentionLogins } from "./github.js";

const log = createLogger("gateway");

const config = loadGatewayEnv();
const githubMentionLogins = buildMentionLogins(config.githubAppSlug);
const workspaceConfigLoader = createConfigLoader(config.configPath);

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
  githubWebhookSecret: config.githubWebhookSecret,
  githubMentionLogins,
  githubAppBotId: config.githubAppBotId,
  githubAppBotEmail: config.githubAppBotEmail,
  workspaceConfigLoader,
});

app.listen(config.port, () => {
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
    slackDefaultRepo: config.slackDefaultRepo,
    configPath: config.configPath,
  });
});
