/**
 * Proxy configuration — one upstream per instance.
 * Config file supports ${ENV_VAR} interpolation in string values.
 */

export interface ProxyConfig {
  upstream: {
    url: string;
    headers?: Record<string, string>;
  };
  /** Glob patterns for allowed tools. Everything else is blocked. */
  allow: string[];
}

function interpolate(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      throw new Error(`Environment variable ${name} is not set`);
    }
    return envVal;
  });
}

function interpolateDeep<T>(obj: T): T {
  if (typeof obj === "string") return interpolate(obj) as T;
  if (Array.isArray(obj)) return obj.map(interpolateDeep) as T;
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateDeep(value);
    }
    return result as T;
  }
  return obj;
}

export function loadConfig(raw: ProxyConfig): ProxyConfig {
  return interpolateDeep(raw);
}
