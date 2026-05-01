import { createEnvLoader, deriveGitHubAppBotIdentity } from "@thor/common";

export interface GatewayConfig {
  port: number;
  runnerUrl: string;
  slackSigningSecret: string;
  slackBotToken: string;
  slackApiBaseUrl: string;
  slackTimestampToleranceSeconds: number;
  queueDir: string;
  slackBotUserId: string;
  cronSecret: string;
  remoteCliHost: string;
  remoteCliPort: number;
  thorInternalSecret: string;
  openaiAuthPath: string;
  githubAppSlug: string;
  githubAppBotId: number;
  githubAppBotEmail: string;
  githubWebhookSecret: string;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const loader = createEnvLoader(env);
  const githubEnv = validateGatewayGitHubEnv(env);
  const githubAppBotIdentity = deriveGitHubAppBotIdentity({
    slug: githubEnv.githubAppSlug,
    botId: githubEnv.githubAppBotId,
  });

  return {
    port: loader.int("PORT", { defaultValue: 3002 }),
    runnerUrl: loader.string("RUNNER_URL", {
      defaultValue: "http://runner:3000",
      normalizeTrailingSlash: true,
    }),
    slackSigningSecret: loader.optionalString("SLACK_SIGNING_SECRET", { defaultValue: "" }) ?? "",
    slackBotToken: loader.optionalString("SLACK_BOT_TOKEN", { defaultValue: "" }) ?? "",
    slackApiBaseUrl: loader.string("SLACK_API_BASE_URL", {
      defaultValue: "https://slack.com/api",
      normalizeTrailingSlash: true,
    }),
    slackTimestampToleranceSeconds: loader.int("SLACK_TIMESTAMP_TOLERANCE_SECONDS", {
      defaultValue: 300,
    }),
    queueDir: loader.string("QUEUE_DIR", { defaultValue: "data/queue" }),
    slackBotUserId: loader.optionalString("SLACK_BOT_USER_ID", { defaultValue: "" }) ?? "",
    cronSecret: loader.optionalString("CRON_SECRET", { defaultValue: "" }) ?? "",
    remoteCliHost: loader.string("REMOTE_CLI_HOST", { defaultValue: "remote-cli" }),
    remoteCliPort: loader.int("REMOTE_CLI_PORT", { defaultValue: 3004 }),
    thorInternalSecret: loader.string("THOR_INTERNAL_SECRET"),
    openaiAuthPath: loader.optionalString("OPENAI_AUTH_PATH", { defaultValue: "" }) ?? "",
    ...githubEnv,
    githubAppBotEmail: githubAppBotIdentity.email,
  };
}

export function validateGatewayGitHubEnv(env: NodeJS.ProcessEnv = process.env): {
  githubAppSlug: string;
  githubAppBotId: number;
  githubWebhookSecret: string;
} {
  const loader = createEnvLoader(env);
  const rawBotId = loader.string("GITHUB_APP_BOT_ID");
  let githubAppBotId: number;
  try {
    githubAppBotId = loader.int("GITHUB_APP_BOT_ID", { min: 1 });
  } catch {
    throw new Error(`GITHUB_APP_BOT_ID must be a positive integer, got: ${rawBotId}`);
  }
  return {
    githubAppSlug: loader.string("GITHUB_APP_SLUG"),
    githubAppBotId,
    githubWebhookSecret: loader.string("GITHUB_WEBHOOK_SECRET"),
  };
}
