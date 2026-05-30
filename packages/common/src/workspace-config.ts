import { z } from "zod/v4";
import { WORKSPACE_REPOS_ROOT, isPathWithin } from "./paths.ts";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { createLogger, logWarn } from "./logger.ts";
import { resolveSessionAnchorId, reverseLookupAnchor } from "./event-log.ts";

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

const UserRecordSchema = z.object({
  /** Jira account email; this is also used for visible commit co-author trailers. */
  email: z.email(),
  name: z.string().min(1),
  slack: z.string().min(1).optional(),
  github: z.string().min(1).optional(),
});

const uniqueStringArray = (label: string) =>
  z.array(z.string().min(1)).refine((items) => new Set(items).size === items.length, {
    message: `Profile ${label} must not contain duplicates`,
  });

const ProfileConfigSchema = z
  .object({
    channels: uniqueStringArray("channels").optional(),
    repos: uniqueStringArray("repos").optional(),
  })
  .refine((profile) => (profile.channels?.length ?? 0) > 0 || (profile.repos?.length ?? 0) > 0, {
    message: "Profile must define at least one channel or repo",
  });

export const WorkspaceConfigSchema = z
  .object({
    owners: z.record(z.string(), OwnerConfigSchema).optional(),
    users: z.array(UserRecordSchema).optional(),
    profiles: z.record(z.string().min(1), ProfileConfigSchema).optional(),
    mitmproxy: z.array(MitmproxyRuleSchema).optional(),
    mitmproxy_passthrough: z.array(MitmproxyPassthroughHostSchema).optional(),
  })
  .superRefine((config, ctx) => {
    const seenChannels = new Map<string, string>();
    const seenRepos = new Map<string, string>();
    for (const [profileName, profile] of Object.entries(config.profiles ?? {})) {
      if (!/^[A-Z_]+$/.test(profileName)) {
        ctx.addIssue({
          code: "custom",
          message: "Profile name must contain only uppercase ASCII letters and underscores",
          path: ["profiles", profileName],
        });
      }
      (profile.channels ?? []).forEach((channel, index) => {
        const previous = seenChannels.get(channel);
        if (previous) {
          ctx.addIssue({
            code: "custom",
            message: `Slack channel ${channel} is assigned to both profiles ${previous} and ${profileName}`,
            path: ["profiles", profileName, "channels", index],
          });
        } else {
          seenChannels.set(channel, profileName);
        }
      });
      (profile.repos ?? []).forEach((repo, index) => {
        const previous = seenRepos.get(repo);
        if (previous) {
          ctx.addIssue({
            code: "custom",
            message: `Repo ${repo} is assigned to both profiles ${previous} and ${profileName}`,
            path: ["profiles", profileName, "repos", index],
          });
        } else {
          seenRepos.set(repo, profileName);
        }
      });
    }
  });

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type OwnerConfig = z.infer<typeof OwnerConfigSchema>;
export type UserRecord = z.infer<typeof UserRecordSchema>;
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;

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

export const WORKSPACE_CONFIG_PATH = "/workspace/config/thor.json";

// --- Dynamic loader ---

export type ConfigLoader = () => WorkspaceConfig;

const configLog = createLogger("config-loader");

/**
 * Create a config loader that re-reads the workspace config on every access.
 * The config is small and reloaded infrequently, so there's no need for
 * caching — changes take effect immediately.
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

export function findUserBySlack(config: WorkspaceConfig, slack: string): UserRecord | undefined {
  const normalized = slack.toUpperCase();
  return config.users?.find((user) => user.slack?.toUpperCase() === normalized);
}

export function findUserByGithub(config: WorkspaceConfig, github: string): UserRecord | undefined {
  const normalized = github.toLowerCase();
  return config.users?.find((user) => user.github?.toLowerCase() === normalized);
}

export function getProfileForSlackChannel(
  config: WorkspaceConfig,
  channelId: string,
): string | undefined {
  for (const [profileName, profile] of Object.entries(config.profiles ?? {})) {
    if (profile.channels?.includes(channelId)) return profileName;
  }
  return undefined;
}

export function getProfileForRepo(config: WorkspaceConfig, repoName: string): string | undefined {
  for (const [profileName, profile] of Object.entries(config.profiles ?? {})) {
    if (profile.repos?.includes(repoName)) return profileName;
  }
  return undefined;
}

export function isSlackChannelInProfile(config: WorkspaceConfig, channelId: string): boolean {
  return getProfileForSlackChannel(config, channelId) !== undefined;
}

export type ProfileResolution =
  | { ok: true; profile: string | undefined }
  | { ok: false; error: string };

export interface StrictProfileOptions {
  /** Session whose anchor bindings (channels, repo alias) drive resolution. */
  sessionId: string;
  /**
   * Repo the session is operating in right now, from the trusted OpenCode
   * session directory on the live MCP path. When a string it is the sole repo
   * signal and overrides any `repo` alias stamped on the anchor. The
   * approval-click path passes `undefined` (no live directory) so the repo
   * dimension falls back to the anchor's `repo` alias recorded at trigger time.
   * Required (string | undefined) so every call site declares which it is.
   */
  liveRepo: string | undefined;
}

/**
 * Strict profile resolver. Resolves a session to at most one profile by
 * combining two dimensions, each failing fast on internal ambiguity:
 *   - channels: every `slack.thread` alias on the anchor → its profile,
 *   - repos: the live repo (if provided) else the anchor's `repo` alias.
 *
 * The result is `channelProfile ?? repoProfile`: the channel is authoritative,
 * the repo fills in when the channel maps to no profile (e.g. cron sessions
 * with no Slack binding, or a public channel left out of every profile). A
 * channel and repo that map to *different* profiles is a conflict and fails.
 *
 * Failing fast defends against silent credential flips when one anchor
 * accumulates bindings that disagree about which credentials apply.
 */
export function resolveStrictProfileForSession(
  config: WorkspaceConfig,
  options: StrictProfileOptions,
): ProfileResolution {
  const { sessionId, liveRepo } = options;
  const anchorId = resolveSessionAnchorId(sessionId);
  if (!anchorId) {
    // No anchor: only a live repo can carry a profile (no channel/alias signal).
    const profile = liveRepo ? getProfileForRepo(config, liveRepo) : undefined;
    return { ok: true, profile };
  }
  return resolveStrictProfileForAnchor(config, anchorId, options, sessionId);
}

function collapseDimension(
  profiles: Set<string | undefined>,
  values: string[],
  dimension: string,
  label: string,
): ProfileResolution {
  if (profiles.size <= 1) {
    return { ok: true, profile: profiles.size === 1 ? [...profiles][0] : undefined };
  }
  const labels = [...profiles].map((p) => p ?? "<none>").sort();
  return {
    ok: false,
    error: `session ${label} is bound to ${dimension} in multiple profiles (${labels.join(", ")}): ${values.join(", ")}`,
  };
}

function resolveStrictProfileForAnchor(
  config: WorkspaceConfig,
  anchorId: string,
  options: StrictProfileOptions,
  label = anchorId,
): ProfileResolution {
  const externalKeys = reverseLookupAnchor(anchorId).externalKeys;

  const channelProfiles = new Set<string | undefined>();
  const channels: string[] = [];
  for (const key of externalKeys) {
    if (key.aliasType !== "slack.thread") continue;
    const slash = key.aliasValue.indexOf("/");
    if (slash <= 0) continue;
    const channel = key.aliasValue.slice(0, slash);
    channels.push(channel);
    channelProfiles.add(getProfileForSlackChannel(config, channel));
  }
  const channel = collapseDimension(channelProfiles, channels, "channels", label);
  if (!channel.ok) return channel;

  const repoProfiles = new Set<string | undefined>();
  const repos = options.liveRepo
    ? [options.liveRepo]
    : externalKeys.filter((key) => key.aliasType === "repo").map((key) => key.aliasValue);
  for (const repo of repos) repoProfiles.add(getProfileForRepo(config, repo));
  const repo = collapseDimension(repoProfiles, repos, "repos", label);
  if (!repo.ok) return repo;

  if (
    channel.profile !== undefined &&
    repo.profile !== undefined &&
    channel.profile !== repo.profile
  ) {
    return {
      ok: false,
      error: `session ${label} resolves to conflicting profiles (channel→${channel.profile}, repo→${repo.profile})`,
    };
  }

  return { ok: true, profile: channel.profile ?? repo.profile };
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
