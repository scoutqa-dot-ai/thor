export type EnvSource = Record<string, string | undefined>;

export interface EnvValueOptions<T> {
  defaultValue?: T;
}

export interface EnvStringOptions extends EnvValueOptions<string> {
  trim?: boolean;
  normalizeTrailingSlash?: boolean;
}

export interface EnvIntOptions extends EnvValueOptions<number> {
  min?: number;
}

export class EnvLoader {
  constructor(private readonly env: EnvSource = process.env) {}

  optionalString(name: string, options: EnvStringOptions = {}): string | undefined {
    const { trim = true, normalizeTrailingSlash = false } = options;
    const raw = this.env[name];
    const value = raw === undefined ? undefined : trim ? raw.trim() : raw;
    const withDefault = value && value.length > 0 ? value : options.defaultValue;
    if (withDefault === undefined) return undefined;
    return normalizeTrailingSlash ? stripTrailingSlashes(withDefault) : withDefault;
  }

  string(name: string, options: EnvStringOptions = {}): string {
    const value = this.optionalString(name, options);
    if (value === undefined) {
      throw new Error(`Missing required env var ${name}`);
    }
    return value;
  }

  int(name: string, options: EnvIntOptions = {}): number {
    const raw = this.optionalString(name, {
      defaultValue: options.defaultValue === undefined ? undefined : String(options.defaultValue),
    });
    if (raw === undefined) {
      throw new Error(`Missing required env var ${name}`);
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || String(value) !== raw) {
      throw new Error(`${name} must be an integer, got: ${raw}`);
    }
    if (options.min !== undefined && value < options.min) {
      throw new Error(`${name} must be >= ${options.min}, got: ${raw}`);
    }
    return value;
  }

  bool(name: string, options: EnvValueOptions<boolean> = {}): boolean {
    const raw = this.optionalString(name);
    if (raw === undefined) {
      if (options.defaultValue !== undefined) return options.defaultValue;
      throw new Error(`Missing required env var ${name}`);
    }
    if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
    throw new Error(`${name} must be a boolean, got: ${raw}`);
  }

  csv(name: string, options: EnvValueOptions<string[]> = {}): string[] {
    const raw = this.optionalString(name);
    if (raw === undefined) {
      if (options.defaultValue !== undefined) return options.defaultValue;
      throw new Error(`Missing required env var ${name}`);
    }
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
}

export function createEnvLoader(env: EnvSource = process.env): EnvLoader {
  return new EnvLoader(env);
}

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}
