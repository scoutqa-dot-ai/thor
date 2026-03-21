import { z } from "zod/v4";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, normalize } from "node:path";

// --- Schema ---

const RepoConfigSchema = z.object({
  channels: z.array(z.string()).optional(),
});

export const WorkspaceConfigSchema = z.object({
  repos: z.record(z.string(), RepoConfigSchema),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

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

const ALLOWED_PREFIXES = ["/workspace/repos/", "/workspace/worktrees/"];

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
