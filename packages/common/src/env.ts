export type EnvSource = Record<string, string | undefined>;

export interface EnvLoaderOptions {
  env?: EnvSource;
}

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

  /**
   * Compatibility parser for legacy `parseInt(process.env.X || default, 10)` paths.
   * Keeps parseInt's prefix parsing behavior for migrated service startup config.
   */
  legacyInt(name: string, options: EnvIntOptions = {}): number {
    const raw = this.env[name];
    let input: string;
    if (options.defaultValue !== undefined) {
      input = raw || String(options.defaultValue);
    } else {
      input = this.string(name);
    }
    const value = Number.parseInt(input, 10);
    if (options.min !== undefined && (!Number.isFinite(value) || value < options.min)) {
      throw new Error(`${name} must be >= ${options.min}, got: ${input}`);
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

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return createEnvLoader(env).string(name);
}

export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
