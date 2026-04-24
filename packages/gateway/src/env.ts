function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export function validateGatewayGitHubEnv(env: NodeJS.ProcessEnv = process.env): {
  githubAppSlug: string;
  githubWebhookSecret: string;
} {
  return {
    githubAppSlug: requireEnv("GITHUB_APP_SLUG", env),
    githubWebhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET", env),
  };
}
