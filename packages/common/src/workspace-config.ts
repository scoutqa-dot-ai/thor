import { z } from "zod/v4";
import { readFileSync, existsSync } from "node:fs";
import { resolve, normalize } from "node:path";

// --- Schema ---

const RepoConfigSchema = z.object({
  channels: z.array(z.string()).optional(),
});

export const WorkspaceConfigSchema = z.object({
  defaultDirectory: z.string().optional(),
  repos: z.record(z.string(), RepoConfigSchema),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

// --- Loader ---

const DEFAULT_DIRECTORY = "/workspace";
const REPOS_PREFIX = "/workspace/repos";
const ALLOWED_PREFIXES = ["/workspace/repos/", "/workspace/worktrees/"];

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

  return result.data;
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
 * Get the expected directory path for a repo.
 * Sanitizes the repo name to prevent path traversal.
 */
export function getRepoDirectory(repoName: string): string {
  const sanitized = repoName.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!sanitized || sanitized !== repoName) {
    throw new Error(`Invalid repo name: "${repoName}"`);
  }
  return `${REPOS_PREFIX}/${sanitized}`;
}

/**
 * Resolve a repo's directory, returning the path if it exists on disk,
 * `undefined` if not. Path is constructed from the repo name — never from
 * user/webhook input — so path traversal is not possible.
 */
export function resolveRepoDirectory(repoName: string): string | undefined {
  const dir = getRepoDirectory(repoName);
  return existsSync(dir) ? dir : undefined;
}

/**
 * Validate that a directory string is under an allowed workspace prefix.
 * Normalizes the path to prevent traversal attacks (e.g. `/workspace/repos/../../..`).
 * Returns the normalized path if valid, `undefined` if not.
 */
export function isAllowedDirectory(directory: string): string | undefined {
  const normalized = normalize(resolve("/", directory));
  for (const prefix of ALLOWED_PREFIXES) {
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
      return normalized;
    }
  }
  return undefined;
}

/**
 * Get the default directory from config, falling back to /workspace.
 */
export function getDefaultDirectory(config: WorkspaceConfig): string {
  return config.defaultDirectory ?? DEFAULT_DIRECTORY;
}
