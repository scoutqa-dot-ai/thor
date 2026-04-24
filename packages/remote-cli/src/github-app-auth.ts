/**
 * GitHub App authentication for Thor git/gh wrappers.
 *
 * Resolves a target org, looks up the installation from workspace config,
 * mints (or reads from cache) an installation token, and returns it.
 *
 * Cache is disk-backed under /var/lib/remote-cli/github-app/cache/ because
 * wrapper binaries run as separate processes that cannot share memory.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  loadWorkspaceConfig,
  WORKSPACE_CONFIG_PATH,
  type GitHubAppInstallation,
} from "@thor/common";

// ── Constants ────────────────────────────────────────────────────────────────

const GITHUB_APP_DIR = process.env.GITHUB_APP_DIR ?? "/var/lib/remote-cli/github-app";
const DEFAULT_PRIVATE_KEY_PATH = join(GITHUB_APP_DIR, "private-key.pem");
const CACHE_DIR = join(GITHUB_APP_DIR, "cache");
const DEFAULT_API_URL = "https://api.github.com";

/** Refresh token when less than this many seconds remain. */
const EARLY_REFRESH_SECONDS = 300; // 5 minutes
/** Stale lock timeout in milliseconds. */
const STALE_LOCK_MS = 30_000;

const TAG = "[thor-github-app]";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenResult {
  token: string;
  org: string;
}

interface CachedToken {
  token: string;
  expires_at: string; // ISO 8601
}

// ── Org resolution ───────────────────────────────────────────────────────────

/**
 * Extract org from command args.
 * Only checks the explicit -R / --repo flag; everything else falls through
 * to resolveOrgFromRemote(cwd).  The previous "second pass" that scanned
 * positional args for owner/repo patterns was fragile — flag values like
 * --body content could be mis-identified as an org.
 */
export function resolveOrgFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-R" && i + 1 < args.length) {
      const ownerRepo = args[i + 1];
      const slash = ownerRepo.indexOf("/");
      if (slash > 0) return ownerRepo.slice(0, slash);
    }
    if (args[i]?.startsWith("--repo=")) {
      const ownerRepo = args[i].slice("--repo=".length);
      const slash = ownerRepo.indexOf("/");
      if (slash > 0) return ownerRepo.slice(0, slash);
    }
  }

  return undefined;
}

/**
 * Extract org from the git remote URL of the current repo.
 * Supports HTTPS (https://github.com/org/repo.git) and SSH (git@github.com:org/repo.git).
 */
export function resolveOrgFromRemote(cwd: string): string | undefined {
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
  return parseOrgFromRemoteUrl(remoteUrl);
}

/**
 * Parse the org (owner) from a GitHub remote URL.
 */
export function parseOrgFromRemoteUrl(url: string): string | undefined {
  // SSH: git@github.com:org/repo.git
  const sshMatch = url.match(/^git@[^:]+:([^/]+)\//);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://github.com/org/repo or https://github.com/org/repo.git
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return parts[0];
  } catch {
    // Not a valid URL
  }

  return undefined;
}

/**
 * Resolve the target org for a git/gh command.
 * Priority: explicit -R flag > git remote origin.
 * Returns undefined if org cannot be determined.
 */
export function resolveOrg(args: string[], cwd?: string): string | undefined {
  const fromArgs = resolveOrgFromArgs(args);
  if (fromArgs) return fromArgs;
  if (cwd) return resolveOrgFromRemote(cwd);
  return undefined;
}

// ── Config lookup ────────────────────────────────────────────────────────────

/**
 * Find the installation config for a given org.
 * Throws if no matching installation is found.
 */
export function findInstallation(org: string): GitHubAppInstallation {
  const config = loadWorkspaceConfig(WORKSPACE_CONFIG_PATH);
  const installations = config.github_app?.installations ?? [];
  const match = installations.find((i) => i.org === org);
  if (!match) {
    throw new Error(
      `${TAG} No GitHub App installation configured for org "${org}". ` +
        `Add it to github_app.installations in ${WORKSPACE_CONFIG_PATH}.`,
    );
  }
  return match;
}

/**
 * Resolve effective values for an installation, applying env/default fallbacks.
 */
export function resolveInstallation(inst: GitHubAppInstallation): {
  org: string;
  installationId: number;
  appId: string;
  privateKeyPath: string;
  apiUrl: string;
} {
  const appId = inst.app_id || process.env.GITHUB_APP_ID || "";
  if (!appId) {
    throw new Error(
      `${TAG} No app_id for org "${inst.org}". Set it in config.json or GITHUB_APP_ID env.`,
    );
  }

  const privateKeyPath =
    inst.private_key_path || process.env.GITHUB_APP_PRIVATE_KEY_FILE || DEFAULT_PRIVATE_KEY_PATH;

  const apiUrl = inst.api_url || process.env.GITHUB_API_URL || DEFAULT_API_URL;

  return {
    org: inst.org,
    installationId: inst.installation_id,
    appId,
    privateKeyPath,
    apiUrl,
  };
}

// ── JWT generation ───────────────────────────────────────────────────────────

/**
 * Generate a GitHub App JWT for authenticating as the app.
 * Valid for up to 10 minutes (we use 9 to allow clock skew).
 */
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

/**
 * Mint an installation token from the GitHub API.
 */
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
    throw new Error(
      `${TAG} GitHub API ${response.status} minting token for installation ${installationId}: ${body}`,
    );
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  return { token: data.token, expires_at: data.expires_at };
}

// ── Disk cache ───────────────────────────────────────────────────────────────

/** Sanitize org name for use as a filename (defense in depth). */
function safeOrgName(org: string): string {
  return org.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function cachePath(org: string): string {
  return join(CACHE_DIR, `${safeOrgName(org)}.json`);
}

function lockPath(org: string): string {
  return join(CACHE_DIR, `${safeOrgName(org)}.lock`);
}

function ensureCacheDir(): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Ignore if exists
  }
}

function readCache(org: string): CachedToken | null {
  try {
    const raw = readFileSync(cachePath(org), "utf8");
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

function writeCache(org: string, cached: CachedToken): void {
  try {
    ensureCacheDir();
    writeFileSync(cachePath(org), JSON.stringify(cached), { mode: 0o600 });
  } catch (err) {
    // Graceful degradation: log but don't fail
    process.stderr.write(
      `${TAG} Warning: failed to write token cache for ${org}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Simple file-based lock with stale detection.
 * Returns true if we acquired the lock, false if another process holds it.
 */
function acquireLock(org: string): boolean {
  ensureCacheDir();
  const lp = lockPath(org);
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

function releaseLock(org: string): void {
  try {
    unlinkSync(lockPath(org));
  } catch {
    // Ignore
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a valid installation token for the given org.
 * Reads from cache if available, mints a new one if not.
 */
export async function getInstallationToken(org: string): Promise<TokenResult> {
  const inst = findInstallation(org);
  const resolved = resolveInstallation(inst);

  // Check cache first
  const cached = readCache(org);
  if (cached) {
    return { token: cached.token, org };
  }

  // Acquire lock for this org
  const locked = acquireLock(org);
  if (!locked) {
    // Another process is minting. Wait briefly and check cache again.
    await new Promise((r) => setTimeout(r, 2000));
    const recheck = readCache(org);
    if (recheck) return { token: recheck.token, org };
    // If still no cache, mint anyway (lock may be stale)
  }

  try {
    process.stderr.write(`${TAG} Minting installation token for org "${org}"...\n`);
    const jwt = generateAppJWT(resolved.appId, resolved.privateKeyPath);
    const token = await mintInstallationToken(resolved.installationId, jwt, resolved.apiUrl);
    writeCache(org, token);
    process.stderr.write(`${TAG} Token cached for org "${org}" (expires ${token.expires_at})\n`);
    return { token: token.token, org };
  } finally {
    if (locked) releaseLock(org);
  }
}
