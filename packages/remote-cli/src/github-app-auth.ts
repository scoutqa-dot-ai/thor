// Cache is disk-backed because wrapper binaries run as separate processes
// that cannot share memory.

import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  getInstallationIdForOwner,
  loadGitHubAppAuthEnv,
  loadWorkspaceConfig,
  WORKSPACE_CONFIG_PATH,
} from "@thor/common";

// ── Constants ────────────────────────────────────────────────────────────────

/** Refresh token when less than this many seconds remain. */
const EARLY_REFRESH_SECONDS = 300; // 5 minutes
/** Stale lock timeout in milliseconds. */
const STALE_LOCK_MS = 30_000;

const TAG = "[thor-github-app]";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenResult {
  token: string;
  owner: string;
}

export interface OwnerRepo {
  host: string;
  owner: string;
  repo: string;
}

interface CachedToken {
  token: string;
  expires_at: string; // ISO 8601
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

// ── Owner resolution ─────────────────────────────────────────────────────────

export function resolveOwnerFromRemote(cwd: string): string | undefined {
  return resolveOwnerRepoFromRemote(cwd)?.owner;
}

export function resolveOwnerRepoFromRemote(cwd: string): OwnerRepo | undefined {
  let remoteUrl: string;
  try {
    remoteUrl = execFileSync("/usr/bin/git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return undefined;
  }
  return parseOwnerRepoFromRemoteUrl(remoteUrl);
}

export function parseOwnerFromRemoteUrl(url: string): string | undefined {
  return parseOwnerRepoFromRemoteUrl(url)?.owner;
}

export function parseOwnerRepoFromRemoteUrl(url: string): OwnerRepo | undefined {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/]+)\/?$/);
  if (sshMatch) return normalizeOwnerRepo(sshMatch[1], sshMatch[2], sshMatch[3]);

  // HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 2) return normalizeOwnerRepo(parsed.hostname, parts[0], parts[1]);
  } catch {
    // Not a valid URL
  }

  return undefined;
}

function normalizeOwnerRepo(
  host: string | undefined,
  owner: string | undefined,
  repoWithSuffix: string | undefined,
): OwnerRepo | undefined {
  if (!host || !owner || !repoWithSuffix) return undefined;
  const repo = repoWithSuffix.endsWith(".git") ? repoWithSuffix.slice(0, -".git".length) : repoWithSuffix;
  const normalizedHost = host.toLowerCase();
  const safeSegment = /^[A-Za-z0-9._-]+$/;
  if (!safeSegment.test(normalizedHost) || !safeSegment.test(owner) || !safeSegment.test(repo)) return undefined;
  return { host: normalizedHost, owner, repo };
}

// GH repo-targeting flags are denied at policy level, so auth always resolves
// from the current repo/worktree context.
export function resolveOwner(_args: string[], cwd?: string): string | undefined {
  if (cwd) return resolveOwnerFromRemote(cwd);
  return undefined;
}

// ── Config lookup ────────────────────────────────────────────────────────────

export function getInstallationIdFromWorkspace(owner: string): number {
  const config = loadWorkspaceConfig(WORKSPACE_CONFIG_PATH);
  const installationId = getInstallationIdForOwner(config, owner);
  if (installationId !== undefined) {
    return installationId;
  }

  const configuredOwners = Object.keys(config.owners ?? {}).sort();
  const configured = configuredOwners.length > 0 ? configuredOwners.join(", ") : "(none)";
  throw new Error(
    `${TAG} No GitHub App installation configured for owner "${owner}". ` +
      `Configured owners: ${configured}. ` +
      `Add owners.${owner}.github_app_installation_id in ${WORKSPACE_CONFIG_PATH}.`,
  );
}

function resolveGitHubAppEnv(): { appId: string; privateKeyPath: string; apiUrl: string } {
  const config = loadGitHubAppAuthEnv();
  return { appId: config.appId, privateKeyPath: config.privateKeyPath, apiUrl: config.apiUrl };
}

// ── JWT generation ───────────────────────────────────────────────────────────

// Valid for up to 10 minutes — we use 9 to allow clock skew.
export function generateAppJWT(appId: string, privateKeyPath: string): string {
  let privateKey: string;
  try {
    privateKey = readFileSync(privateKeyPath, "utf8");
  } catch (err) {
    throw new Error(
      `${TAG} Cannot read private key at ${privateKeyPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60, // issued 60s ago to allow clock drift
    exp: now + 540, // expires in 9 minutes
    iss: appId,
  };

  const segments = [base64url(JSON.stringify(header)), base64url(JSON.stringify(payload))];

  const sign = createSign("RSA-SHA256");
  sign.update(segments.join("."));
  const signature = sign.sign(privateKey, "base64url");

  return `${segments.join(".")}.${signature}`;
}

function base64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}

// ── Token minting ────────────────────────────────────────────────────────────

export async function mintInstallationToken(
  installationId: number,
  appJwt: string,
  apiUrl: string,
): Promise<CachedToken> {
  const url = `${apiUrl}/app/installations/${installationId}/access_tokens`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GitHubApiError(
      response.status,
      `${TAG} GitHub API ${response.status} minting token for installation ${installationId}: ${body}`,
    );
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  return { token: data.token, expires_at: data.expires_at };
}

// ── Disk cache ───────────────────────────────────────────────────────────────

// Sanitize owner name for use as a filename (defense in depth).
function safeOwnerName(owner: string): string {
  return owner.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function cachePath(owner: string): string {
  return join(getCacheDir(), `${safeOwnerName(owner)}.json`);
}

function lockPath(owner: string): string {
  return join(getCacheDir(), `${safeOwnerName(owner)}.lock`);
}

function getGitHubAppDir(): string {
  return loadGitHubAppAuthEnv().appDir;
}

function getCacheDir(): string {
  return join(getGitHubAppDir(), "cache");
}

function ensureCacheDir(): void {
  try {
    mkdirSync(getCacheDir(), { recursive: true, mode: 0o700 });
  } catch {
    // Ignore if exists
  }
}

function readCache(owner: string): CachedToken | null {
  try {
    const raw = readFileSync(cachePath(owner), "utf8");
    const cached = JSON.parse(raw) as CachedToken;
    if (!cached.token || !cached.expires_at) return null;

    const expiresAt = new Date(cached.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < EARLY_REFRESH_SECONDS * 1000) {
      return null; // expired or about to expire
    }
    return cached;
  } catch {
    return null;
  }
}

function writeCache(owner: string, cached: CachedToken): void {
  try {
    ensureCacheDir();
    writeFileSync(cachePath(owner), JSON.stringify(cached), { mode: 0o600 });
  } catch (err) {
    // Graceful degradation: log but don't fail
    process.stderr.write(
      `${TAG} Warning: failed to write token cache for ${owner}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// Returns true if we acquired the lock, false if another process holds it.
function acquireLock(owner: string): boolean {
  ensureCacheDir();
  const lp = lockPath(owner);
  try {
    // Check for stale lock
    try {
      const stat = statSync(lp);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        unlinkSync(lp);
      }
    } catch {
      // No existing lock
    }

    // O_EXCL: fail if file exists
    writeFileSync(lp, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(owner: string): void {
  try {
    unlinkSync(lockPath(owner));
  } catch {
    // Ignore
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getInstallationToken(owner: string): Promise<TokenResult> {
  const installationId = getInstallationIdFromWorkspace(owner);
  const { appId, privateKeyPath, apiUrl } = resolveGitHubAppEnv();

  // Check cache first
  const cached = readCache(owner);
  if (cached) {
    return { token: cached.token, owner };
  }

  // Acquire lock for this owner
  const locked = acquireLock(owner);
  if (!locked) {
    // Another process is minting. Wait briefly and check cache again.
    await new Promise((r) => setTimeout(r, 2000));
    const recheck = readCache(owner);
    if (recheck) return { token: recheck.token, owner };
    // If still no cache, mint anyway (lock may be stale)
  }

  try {
    process.stderr.write(`${TAG} Minting installation token for owner "${owner}"...\n`);
    const jwt = generateAppJWT(appId, privateKeyPath);
    const token = await mintInstallationToken(installationId, jwt, apiUrl);
    writeCache(owner, token);
    process.stderr.write(
      `${TAG} Token cached for owner "${owner}" (expires ${token.expires_at})\n`,
    );
    return { token: token.token, owner };
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
      try {
        unlinkSync(cachePath(owner));
      } catch {
        // Ignore missing/unlink errors during eviction.
      }
      throw new Error(`${TAG} installation_gone for owner "${owner}"`);
    }
    throw error;
  } finally {
    if (locked) releaseLock(owner);
  }
}
