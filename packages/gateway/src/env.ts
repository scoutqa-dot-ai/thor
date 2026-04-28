import { requireEnv } from "@thor/common";

export function validateGatewayGitHubEnv(env: NodeJS.ProcessEnv = process.env): {
  githubAppSlug: string;
  githubAppBotId: number;
  githubWebhookSecret: string;
} {
  const rawBotId = requireEnv("GITHUB_APP_BOT_ID", env);
  const githubAppBotId = Number.parseInt(rawBotId, 10);
  if (!Number.isFinite(githubAppBotId) || githubAppBotId <= 0) {
    throw new Error(`GITHUB_APP_BOT_ID must be a positive integer, got: ${rawBotId}`);
  }
  return {
    githubAppSlug: requireEnv("GITHUB_APP_SLUG", env),
    githubAppBotId,
    githubWebhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET", env),
  };
}
