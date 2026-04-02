import { z } from "zod/v4";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { createLogger, logWarn } from "./logger.js";

// --- Schema ---

const RepoConfigSchema = z.object({
  channels: z.array(z.string()).optional(),
  proxies: z.array(z.string()).optional(),
});

const ProxyUpstreamSchema = z.object({
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

const ProxyConfigSchema = z.object({
  upstream: ProxyUpstreamSchema,
  allow: z.array(z.string()).default([]),
  approve: z.array(z.string()).default([]),
});

export const WorkspaceConfigSchema = z.object({
  repos: z.record(z.string(), RepoConfigSchema),
  proxies: z.record(z.string(), ProxyConfigSchema).optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type ProxyUpstream = z.infer<typeof ProxyUpstreamSchema>;

// --- Loader ---

const REPOS_PREFIX = "/workspace/repos";

/**
 * Load and validate workspace config from a JSON file.
 * Throws on: missing file, invalid JSON, schema violation, duplicate channel IDs.
 */
export function loadWorkspaceConfig(path: string): WorkspaceConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read workspace config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in workspace config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = WorkspaceConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid workspace config at ${path}:\n${issues.join("\n")}`);
  }

  // Validate proxy names: alphanumeric + hyphens only, no reserved names
  const RESERVED_PROXY_NAMES = new Set(["health", "tools", "approval", "approvals"]);
  const PROXY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
  for (const name of Object.keys(result.data.proxies ?? {})) {
    if (!PROXY_NAME_RE.test(name)) {
      throw new Error(
        `Invalid proxy name "${name}" in workspace config: must be lowercase alphanumeric with hyphens`,
      );
    }
    if (RESERVED_PROXY_NAMES.has(name)) {
      throw new Error(
        `Reserved proxy name "${name}" in workspace config: collides with /${name} endpoint`,
      );
    }
  }

  // Detect duplicate channel IDs across repos
  const seen = new Map<string, string>(); // channel → repo
  for (const [repo, config] of Object.entries(result.data.repos)) {
    for (const channel of config.channels ?? []) {
      const existing = seen.get(channel);
      if (existing) {
        throw new Error(
          `Duplicate channel ID "${channel}" in workspace config: mapped to both "${existing}" and "${repo}"`,
        );
      }
      seen.set(channel, repo);
    }
  }

  // Validate repo.proxies entries reference top-level proxy names
  const proxyNames = new Set(Object.keys(result.data.proxies ?? {}));
  for (const [repo, config] of Object.entries(result.data.repos)) {
    for (const proxyRef of config.proxies ?? []) {
      if (!proxyNames.has(proxyRef)) {
        throw new Error(
          `Repo "${repo}" references unknown proxy "${proxyRef}" in workspace config. Available proxies: ${[...proxyNames].join(", ") || "(none)"}`,
        );
      }
    }
  }

  return result.data;
}

export const WORKSPACE_CONFIG_PATH = "/workspace/config.json";

// --- Dynamic loader ---

export interface ConfigLoader {
  /** Returns the current workspace config, re-reading from disk if the TTL has expired. */
  (): WorkspaceConfig;
  /** Force an immediate reload on next access. */
  invalidate(): void;
}

const configLog = createLogger("config-loader");

/**
 * Create a config loader that re-reads config.json on every access.
 * The file is tiny (<1KB) so there's no need for caching — changes
 * take effect immediately.
 */
export function createConfigLoader(path: string): ConfigLoader {
  let lastGood: WorkspaceConfig | null = null;

  const loader = (() => {
    try {
      lastGood = loadWorkspaceConfig(path);
      return lastGood;
    } catch (err) {
      // If we have a previous good config, keep using it
      if (lastGood) {
        logWarn(configLog, "config_reload_failed_using_last_good", {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
        return lastGood;
      }
      throw new Error(
        `Failed to load workspace config from ${path} and no previous config available`,
      );
    }
  }) as ConfigLoader;

  loader.invalidate = () => {};

  return loader;
}

// --- Helpers ---

/**
 * Union of all channel IDs across all repos.
 */
export function getAllowedChannelIds(config: WorkspaceConfig): Set<string> {
  const ids = new Set<string>();
  for (const repo of Object.values(config.repos)) {
    for (const ch of repo.channels ?? []) {
      ids.add(ch);
    }
  }
  return ids;
}

/**
 * Map from channel ID → repo name.
 */
export function getChannelRepoMap(config: WorkspaceConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const [repo, repoConfig] of Object.entries(config.repos)) {
    for (const ch of repoConfig.channels ?? []) {
      map.set(ch, repo);
    }
  }
  return map;
}

/**
 * Get proxy config by name, or undefined if not configured.
 */
export function getProxyConfig(config: WorkspaceConfig, name: string): ProxyConfig | undefined {
  return config.proxies?.[name];
}

/**
 * Interpolate ${ENV_VAR} references in a string.
 */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      throw new Error(`Environment variable ${name} is not set`);
    }
    return envVal;
  });
}

/**
 * Interpolate all string values in a headers record.
 */
export function interpolateHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = interpolateEnv(value);
  }
  return result;
}

/**
 * Resolve a repo name to its directory on disk.
 * Returns the real path if the directory exists, `undefined` otherwise.
 * Path safety (prefix check) is enforced by the runner, not here.
 */
export function resolveRepoDirectory(repoName: string): string | undefined {
  const candidate = join(REPOS_PREFIX, repoName);
  try {
    return realpathSync(candidate);
  } catch {
    // Path does not exist on disk
    return undefined;
  }
}

/**
 * Extract repo name from a cwd path under /workspace/repos/.
 * Returns undefined if path is not under the expected prefix.
 */
export function extractRepoFromCwd(cwd: string): string | undefined {
  const normalized = normalize(resolve("/", cwd));
  if (!normalized.startsWith(REPOS_PREFIX + "/")) return undefined;
  const rest = normalized.slice(REPOS_PREFIX.length + 1);
  // Take the first path segment as the repo name
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

/**
 * Get the list of proxy names allowed for a repo.
 * Returns undefined if the repo is not in config.
 * Returns empty array if repo exists but has no proxies field.
 */
export function getRepoProxies(config: WorkspaceConfig, repoName: string): string[] | undefined {
  const repo = config.repos[repoName];
  if (!repo) return undefined;
  return repo.proxies ?? [];
}

const ALLOWED_PREFIXES = ["/workspace/repos/"];

/**
 * Check that a directory path is under an allowed workspace prefix.
 * Normalizes to prevent traversal (e.g. `/workspace/repos/../../etc`).
 * Returns true if the path is allowed, false otherwise.
 */
export function isAllowedDirectory(directory: string): boolean {
  const normalized = normalize(resolve("/", directory));
  return ALLOWED_PREFIXES.some(
    (prefix) => normalized.startsWith(prefix) && normalized.length > prefix.length,
  );
}
