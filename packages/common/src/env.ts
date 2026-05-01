export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export function getRunnerBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return requireEnv("RUNNER_BASE_URL", env).replace(/\/$/, "");
}
