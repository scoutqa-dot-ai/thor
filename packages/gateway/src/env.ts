import { requireEnv } from "@thor/common";

export function validateGatewayGitHubEnv(env: NodeJS.ProcessEnv = process.env): {
  githubAppSlug: string;
  githubWebhookSecret: string;
} {
  return {
    githubAppSlug: requireEnv("GITHUB_APP_SLUG", env),
    githubWebhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET", env),
  };
}
