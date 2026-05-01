import { createEnvLoader, deriveGitHubAppBotIdentity } from "@thor/common";

export interface RemoteCliConfig {
  port: number;
  thorInternalSecret: string;
  nodeEnv: string;
  githubAppId: string;
  githubAppSlug: string;
  githubAppBotId: string;
  githubAppPrivateKeyFile: string;
  gitIdentityName: string;
  gitIdentityEmail: string;
}

export interface RemoteCliGitHubConfig {
  githubAppId: string;
  githubAppSlug: string;
  githubAppBotId: string;
  githubAppPrivateKeyFile: string;
  gitIdentityName: string;
  gitIdentityEmail: string;
}

export function loadRemoteCliGitHubConfig(
  env: NodeJS.ProcessEnv = process.env,
): RemoteCliGitHubConfig {
  const loader = createEnvLoader(env);
  const githubAppSlug = loader.string("GITHUB_APP_SLUG");
  const githubAppBotId = loader.string("GITHUB_APP_BOT_ID");
  const gitIdentity = deriveGitHubAppBotIdentity({ slug: githubAppSlug, botId: githubAppBotId });

  return {
    githubAppId: loader.string("GITHUB_APP_ID"),
    githubAppSlug,
    githubAppBotId,
    githubAppPrivateKeyFile: loader.string("GITHUB_APP_PRIVATE_KEY_FILE"),
    gitIdentityName: gitIdentity.name,
    gitIdentityEmail: gitIdentity.email,
  };
}

export interface RemoteCliInternalConfig {
  thorInternalSecret: string;
}

export function loadRemoteCliInternalConfig(
  env: NodeJS.ProcessEnv = process.env,
): RemoteCliInternalConfig {
  return { thorInternalSecret: createEnvLoader(env).string("THOR_INTERNAL_SECRET") };
}

export function loadRemoteCliConfig(env: NodeJS.ProcessEnv = process.env): RemoteCliConfig {
  const loader = createEnvLoader(env);
  const github = loadRemoteCliGitHubConfig(env);
  const internal = loadRemoteCliInternalConfig(env);

  return {
    port: loader.int("PORT", { defaultValue: 3004 }),
    thorInternalSecret: internal.thorInternalSecret,
    nodeEnv: loader.optionalString("NODE_ENV", { defaultValue: "" }) ?? "",
    ...github,
  };
}

export interface MetabaseConfig {
  url: string;
  apiKey: string;
  dbId: number;
  schemas: Set<string>;
}

export function loadMetabaseConfig(env: NodeJS.ProcessEnv = process.env): MetabaseConfig {
  const loader = createEnvLoader(env);
  return {
    url: loader.string("METABASE_URL", { normalizeTrailingSlash: true }),
    apiKey: loader.string("METABASE_API_KEY"),
    dbId: loader.int("METABASE_DATABASE_ID"),
    schemas: new Set(loader.csv("METABASE_ALLOWED_SCHEMAS")),
  };
}

export interface GitHubAppAuthConfig {
  appId: string;
  privateKeyPath: string;
  apiUrl: string;
  appDir: string;
}

export function loadGitHubAppAuthConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppAuthConfig {
  const loader = createEnvLoader(env);
  return {
    appId: loader.string("GITHUB_APP_ID"),
    privateKeyPath: loader.string("GITHUB_APP_PRIVATE_KEY_FILE"),
    apiUrl: loader.string("GITHUB_API_URL", {
      defaultValue: "https://api.github.com",
      normalizeTrailingSlash: true,
    }),
    appDir: loader.string("GITHUB_APP_DIR", { defaultValue: "/var/lib/remote-cli/github-app" }),
  };
}

export interface DaytonaConfig {
  apiKey: string;
  apiUrl: string;
  snapshot: string;
}

export function loadDaytonaConfig(env: NodeJS.ProcessEnv = process.env): DaytonaConfig {
  const loader = createEnvLoader(env);
  return {
    apiKey: loader.string("DAYTONA_API_KEY"),
    apiUrl: loader.string("DAYTONA_API_URL", { defaultValue: "https://app.daytona.io/api" }),
    snapshot: loader.string("DAYTONA_SNAPSHOT", { defaultValue: "daytona-medium" }),
  };
}
