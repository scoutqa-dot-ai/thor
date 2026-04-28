export interface GitHubAppBotIdentityInput {
  slug: string;
  botId: string | number;
}

export interface GitHubAppBotIdentity {
  name: string;
  email: string;
}

export function deriveGitHubAppBotIdentity(input: GitHubAppBotIdentityInput): GitHubAppBotIdentity {
  const slug = input.slug.trim();
  const botId = String(input.botId).trim();
  return {
    name: `${slug}[bot]`,
    email: `${botId}+${slug}[bot]@users.noreply.github.com`,
  };
}
