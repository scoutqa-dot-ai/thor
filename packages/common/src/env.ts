import { timingSafeEqual } from "node:crypto";

export type EnvSource = Record<string, string | undefined>;

export function envOptionalString(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function envString(env: EnvSource, name: string, defaultValue?: string): string {
  const value = envOptionalString(env, name) ?? defaultValue;
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export function envInt(env: EnvSource, name: string, defaultValue?: number, min?: number): number {
  const raw =
    envOptionalString(env, name) ?? (defaultValue === undefined ? undefined : String(defaultValue));
  if (raw === undefined) {
    throw new Error(`Missing required env var ${name}`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || String(value) !== raw) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be >= ${min}, got: ${raw}`);
  }
  return value;
}

export function envCsv(env: EnvSource, name: string): string[] {
  return envString(env, name)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export function getRunnerBaseUrl(env: EnvSource = process.env): string {
  return stripTrailingSlashes(envString(env, "RUNNER_BASE_URL"));
}

export function matchesInternalSecret(
  expectedSecret: string,
  providedSecret: string | undefined,
): boolean {
  if (!expectedSecret || !providedSecret) return false;
  if (expectedSecret.length !== providedSecret.length) return false;
  return timingSafeEqual(Buffer.from(expectedSecret), Buffer.from(providedSecret));
}
