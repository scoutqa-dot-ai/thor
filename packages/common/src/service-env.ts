import { dirname, join } from "node:path";
import { deriveGitHubAppBotIdentity } from "./github-identity.js";
import { envCsv, envInt, envOptionalString, envString, type EnvSource } from "./env.js";
import { WORKSPACE_CONFIG_PATH } from "./workspace-config.js";

export function loadGatewayEnv(env: EnvSource = process.env) {
  const githubAppSlug = envString(env, "GITHUB_APP_SLUG");
  const rawBotId = envString(env, "GITHUB_APP_BOT_ID");
  let githubAppBotId: number;
  try {
    githubAppBotId = envInt(env, "GITHUB_APP_BOT_ID", undefined, 1);
  } catch {
    throw new Error(`GITHUB_APP_BOT_ID must be a positive integer, got: ${rawBotId}`);
  }
  const githubAppBotIdentity = deriveGitHubAppBotIdentity({
    slug: githubAppSlug,
    botId: githubAppBotId,
  });

  return {
    port: envInt(env, "PORT", 3002),
    runnerUrl: envString(env, "RUNNER_URL", "http://runner:3000"),
    slackSigningSecret: envOptionalString(env, "SLACK_SIGNING_SECRET") ?? "",
    slackBotToken: envOptionalString(env, "SLACK_BOT_TOKEN") ?? "",
    slackApiBaseUrl: envString(env, "SLACK_API_BASE_URL", "https://slack.com/api"),
    slackTimestampToleranceSeconds: envInt(env, "SLACK_TIMESTAMP_TOLERANCE_SECONDS", 300),
    queueDir: envString(env, "QUEUE_DIR", "data/queue"),
    slackBotUserId: envOptionalString(env, "SLACK_BOT_USER_ID") ?? "",
    cronSecret: envOptionalString(env, "CRON_SECRET") ?? "",
    remoteCliHost: envString(env, "REMOTE_CLI_HOST", "remote-cli"),
    remoteCliPort: envInt(env, "REMOTE_CLI_PORT", 3004),
    thorInternalSecret: envString(env, "THOR_INTERNAL_SECRET"),
    openaiAuthPath: envOptionalString(env, "OPENAI_AUTH_PATH") ?? "",
    githubAppSlug,
    githubAppBotId,
    githubAppBotEmail: githubAppBotIdentity.email,
    githubWebhookSecret: envString(env, "GITHUB_WEBHOOK_SECRET"),
  };
}

export function loadRunnerEnv(env: EnvSource = process.env) {
  return {
    port: envInt(env, "PORT", 3000),
    opencodeUrl: envString(env, "OPENCODE_URL", "http://127.0.0.1:4096"),
    opencodeConnectTimeout: envInt(env, "OPENCODE_CONNECT_TIMEOUT", 15000),
    abortTimeout: envInt(env, "ABORT_TIMEOUT", 10000),
    sessionErrorGraceMs: envInt(env, "SESSION_ERROR_GRACE_MS", 10000),
  };
}

export function loadRemoteCliGitHubEnv(env: EnvSource = process.env) {
  const githubAppSlug = envString(env, "GITHUB_APP_SLUG");
  const githubAppBotId = envString(env, "GITHUB_APP_BOT_ID");
  const gitIdentity = deriveGitHubAppBotIdentity({ slug: githubAppSlug, botId: githubAppBotId });
  return {
    githubAppId: envString(env, "GITHUB_APP_ID"),
    githubAppSlug,
    githubAppBotId,
    githubAppPrivateKeyFile: envString(env, "GITHUB_APP_PRIVATE_KEY_FILE"),
    gitIdentityName: gitIdentity.name,
    gitIdentityEmail: gitIdentity.email,
  };
}

export function loadRemoteCliInternalEnv(env: EnvSource = process.env) {
  return { thorInternalSecret: envString(env, "THOR_INTERNAL_SECRET") };
}

export function loadRemoteCliAppEnv(env: EnvSource = process.env) {
  return {
    thorInternalSecret: envOptionalString(env, "THOR_INTERNAL_SECRET") ?? "",
    isProduction: envOptionalString(env, "NODE_ENV") === "production",
  };
}

export function loadRemoteCliEnv(env: EnvSource = process.env) {
  return {
    port: envInt(env, "PORT", 3004),
    nodeEnv: envOptionalString(env, "NODE_ENV") ?? "",
    slackBotToken: envString(env, "SLACK_BOT_TOKEN"),
    ...loadRemoteCliInternalEnv(env),
    ...loadRemoteCliGitHubEnv(env),
  };
}

export function loadAdminEnv(env: EnvSource = process.env) {
  const configPath = envString(env, "CONFIG_PATH", WORKSPACE_CONFIG_PATH);
  return {
    port: envInt(env, "PORT", 3005),
    configPath,
    auditLogPath: envString(env, "AUDIT_LOG_PATH", join(dirname(configPath), "config.audit.log")),
  };
}

export function loadMetabaseEnv(env: EnvSource = process.env) {
  return {
    url: envString(env, "METABASE_URL"),
    apiKey: envString(env, "METABASE_API_KEY"),
    dbId: envInt(env, "METABASE_DATABASE_ID"),
    schemas: new Set(envCsv(env, "METABASE_ALLOWED_SCHEMAS")),
  };
}

export function loadGitHubAppAuthEnv(env: EnvSource = process.env) {
  return {
    appId: envString(env, "GITHUB_APP_ID"),
    privateKeyPath: envString(env, "GITHUB_APP_PRIVATE_KEY_FILE"),
    apiUrl: envString(env, "GITHUB_API_URL", "https://api.github.com"),
    appDir: envString(env, "GITHUB_APP_DIR", "/var/lib/remote-cli/github-app"),
  };
}

export function loadDaytonaEnv(env: EnvSource = process.env) {
  return {
    apiKey: envString(env, "DAYTONA_API_KEY"),
    apiUrl: envString(env, "DAYTONA_API_URL", "https://app.daytona.io/api"),
    snapshot: envString(env, "DAYTONA_SNAPSHOT", "daytona-medium"),
  };
}
