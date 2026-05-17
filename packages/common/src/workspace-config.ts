import { z } from "zod/v4";
import { WORKSPACE_REPOS_ROOT, isPathWithin } from "./paths.js";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { createLogger, logWarn } from "./logger.js";

// --- Schema ---

const OwnerConfigSchema = z.object({
  github_app_installation_id: z.number().int().positive(),
});

const MitmproxyRuleSchema = z
  .object({
    host: z.string().min(1).optional(),
    host_suffix: z.string().min(2).startsWith(".").optional(),
    path_prefix: z.string().min(1).startsWith("/").optional(),
    path_suffix: z.string().min(1).startsWith("/").optional(),
    headers: z
      .record(z.string(), z.string())
      .refine(
        (headers) => Object.keys(headers).length > 0,
        '"headers" must contain at least one entry',
      ),
    readonly: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasHost = typeof value.host === "string";
    const hasHostSuffix = typeof value.host_suffix === "string";
    if (hasHost === hasHostSuffix) {
      ctx.addIssue({
        code: "custom",
        message: 'Exactly one of "host" or "host_suffix" is required',
        path: ["host"],
      });
    }
  });

const MitmproxyPassthroughHostSchema = z.string().refine((value) => {
  if (value.startsWith(".")) {
    return value.length > 1;
  }
  return !value.includes("/") && !value.includes(":") && value.length > 0;
}, "Passthrough entries must be an exact host or a suffix starting with '.'");

export const WorkspaceConfigSchema = z
  .object({
    owners: z.record(z.string(), OwnerConfigSchema).optional(),
    mitmproxy: z.array(MitmproxyRuleSchema).optional(),
    mitmproxy_passthrough: z.array(MitmproxyPassthroughHostSchema).optional(),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type OwnerConfig = z.infer<typeof OwnerConfigSchema>;

export interface ProxyUpstream {
  url: string;
  headers?: Record<string, string>;
}

export interface ProxyConfig {
  upstream: ProxyUpstream;
  allow: string[];
  approve: string[];
}

// --- Validator ---

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; data: WorkspaceConfig }
  | { ok: false; issues: ValidationIssue[] };

export function validateWorkspaceConfig(parsed: unknown): ValidationResult {
  const result = WorkspaceConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({
        path: i.path.length > 0 ? i.path.join(".") : "(root)",
        message: i.message,
      })),
    };
  }
  return { ok: true, data: result.data };
}

// --- Loader ---

const REPOS_PREFIX = "/workspace/repos";
export const SLACK_CHANNEL_REPO_MEMORY_ROOT = "/workspace/memory/thor/repo-by-slack-channel";

/**
 * Load and validate workspace config from a JSON file.
 * Throws on: missing file, invalid JSON, schema violation.
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

  const result = validateWorkspaceConfig(parsed);
  if (!result.ok) {
    const lines = result.issues.map((i) => `  - ${i.path}: ${i.message}`);
    throw new Error(`Invalid workspace config at ${path}:\n${lines.join("\n")}`);
  }
  return result.data;
}

export const WORKSPACE_CONFIG_PATH = "/workspace/config.json";

// --- Dynamic loader ---

export type ConfigLoader = () => WorkspaceConfig;

const configLog = createLogger("config-loader");

/**
 * Create a config loader that re-reads config.json on every access.
 * The file is tiny (<1KB) so there's no need for caching — changes
 * take effect immediately.
 */
export function createConfigLoader(path: string): ConfigLoader {
  let lastGood: WorkspaceConfig | null = null;

  return () => {
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
  };
}

// --- Helpers ---

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

function isFilenameOnly(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function resolveSafeRepoDirectory(
  repoName: string,
  resolveRepoDirectoryFn: (repoName: string) => string | undefined = resolveRepoDirectory,
): { directory?: string; reason?: string } {
  if (!isFilenameOnly(repoName)) return { reason: "repo name must be a repo name only" };
  const directory = resolveRepoDirectoryFn(repoName);
  if (!directory) return { reason: `repo directory not found for ${repoName}` };
  if (!isAllowedDirectory(directory)) {
    return { reason: `repo directory for ${repoName} is outside ${WORKSPACE_REPOS_ROOT}` };
  }
  return { directory };
}

export function resolveSlackChannelRepoDirectory(
  channelId: string,
  defaultRepoName: string,
  memoryRoot = SLACK_CHANNEL_REPO_MEMORY_ROOT,
  resolveRepoDirectoryFn: (repoName: string) => string | undefined = resolveRepoDirectory,
): {
  directory?: string;
  repoName?: string;
  source?: "override" | "default";
  fallbackReason?: string;
  reason?: string;
} {
  let overrideRepo: string | undefined;
  let invalidReason: string | undefined;

  if (!isFilenameOnly(channelId)) {
    invalidReason = "invalid channel id";
  } else {
    try {
      overrideRepo =
        readFileSync(join(memoryRoot, `${channelId}.txt`), "utf-8").trim() || undefined;
    } catch (err) {
      if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) {
        invalidReason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (overrideRepo) {
    const r = resolveSafeRepoDirectory(overrideRepo, resolveRepoDirectoryFn);
    if (r.directory) {
      return { directory: r.directory, repoName: overrideRepo, source: "override" };
    }
    invalidReason = r.reason;
  }

  const fb = resolveSafeRepoDirectory(defaultRepoName, resolveRepoDirectoryFn);
  if (!fb.directory) return { reason: fb.reason };
  return {
    directory: fb.directory,
    repoName: defaultRepoName,
    source: "default",
    fallbackReason: invalidReason,
  };
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
 * Lookup GitHub App installation ID for a configured owner.
 */
export function getInstallationIdForOwner(
  config: WorkspaceConfig,
  owner: string,
): number | undefined {
  return config.owners?.[owner]?.github_app_installation_id;
}

const ALLOWED_PREFIXES = [WORKSPACE_REPOS_ROOT];

/**
 * Check that a directory path is under an allowed workspace prefix.
 * Normalizes to prevent traversal (e.g. `/workspace/repos/../../etc`).
 * Returns true if the path is allowed, false otherwise.
 */
export function isAllowedDirectory(directory: string): boolean {
  const normalized = normalize(resolve("/", directory));
  return ALLOWED_PREFIXES.some(
    (prefix) => isPathWithin(prefix, normalized) && normalized.length > prefix.length,
  );
}
