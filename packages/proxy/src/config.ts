/**
 * Proxy configuration types.
 *
 * Config file supports ${ENV_VAR} interpolation in string values.
 */

export interface UpstreamConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface PolicyRule {
  upstream: string;
  toolPattern: string; // glob-like: "*" matches all, "list_*" matches prefix
  action: "allow" | "block";
}

export interface PolicyConfig {
  rules: PolicyRule[];
}

export interface ProxyConfig {
  upstreams: Record<string, UpstreamConfig>;
  policy: PolicyConfig;
}

/**
 * Interpolate ${ENV_VAR} in a string value.
 */
function interpolate(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      throw new Error(`Environment variable ${name} is not set`);
    }
    return envVal;
  });
}

/**
 * Deep-interpolate all string values in an object.
 */
function interpolateDeep<T>(obj: T): T {
  if (typeof obj === "string") {
    return interpolate(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateDeep) as T;
  }
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
