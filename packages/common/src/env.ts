export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}
