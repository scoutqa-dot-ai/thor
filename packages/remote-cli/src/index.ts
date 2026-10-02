import { z } from "zod";
import express, { type Express } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, normalize as normalizePosix } from "node:path/posix";
import { fileURLToPath } from "node:url";
import {
  appendCorrelationAlias,
  ApprovalRequiredEventPayloadSchema,
  buildApprovalSlackMessage,
  buildThorDisclaimerForSession,
  computeGitCorrelationKey,
  createConfigLoader,
  createLogger,
  getRunnerBaseUrl,
  GoogleWorkspaceCommandApprovalArgsSchema,
  logError,
  logInfo,
  loadRemoteCliAppEnv,
  loadRemoteCliEnv,
  loadRemoteCliGitHubEnv,
  loadRemoteCliInternalEnv,
  matchesInternalSecret,
  resolveSlackThreadTargetFromTrigger,
  writeToolCallLog,
  WORKSPACE_CONFIG_PATH,
  type ExecStreamEvent,
  type ConfigLoader,
  type ToolCallLogEntry,
} from "@thor/common";
import { execCommand, execCommandStream } from "./exec.js";
import { GwsService, type IGwsService } from "./gws.js";
import { parseGwsArgs } from "./gws-args.js";
import {
  GWS_OAUTH_BROWSER_COOKIE,
  GwsOAuthService,
  type GwsOAuthServiceDeps,
} from "./gws-oauth.js";
import { resolveOwnerRepoFromRemote } from "./github-app-auth.js";
import { createMcpService, type McpExecResult, type McpServiceDeps } from "./mcp-handler.js";
import { ApprovalStore, type ApprovalAction } from "./approval-store.js";
import { sanitizeCredentialBrokerToolCallLog } from "./credential-broker-audit.js";
import {
  handleSlackPostMessage,
  parseSlackPostMessageArgs,
  postSlackMessageApi,
  type SlackPostMessageDeps,
} from "./slack-post-message.js";
import { listSchemas, listTables, getColumns, executeQuery, getQuestion } from "./metabase.js";
import { DrataService } from "./drata.js";
import { parseDrataArgs } from "./drata-args.js";
import {
  createSandbox,
  deleteSandbox,
  execInSandboxStream,
  findSandboxForCwd,
  getLastSyncedSha,
  listSandboxes,
  overlayDirtyFiles,
  pullSandboxChanges,
  SandboxError,
  shellQuote,
  syncSandbox,
  withCwdLock,
  THOR_CWD_LABEL,
  THOR_MANAGED_LABEL,
  THOR_SHA_LABEL,
} from "./sandbox.js";
import {
  resolveGitArgs,
  validateCwd,
  validateGhArgs,
  validateLdcliArgs,
  validateLangfuseArgs,
  validateMetabaseArgs,
  validateScoutqaArgs,
} from "./policy.js";
import { attributionFields, resolveTriggerUser } from "./attribution.js";
import { GwsSlackIdentityService, type GwsSlackRequester } from "./gws-slack-identity.js";

export { GwsOAuthService, GwsService };

const log = createLogger("remote-cli");

const LDCLI_MAX_OUTPUT = 1024 * 1024;
const WORKTREE_ROOT = "/workspace/worktrees";
const WORKTREE_PREFIX = `${WORKTREE_ROOT}/`;
const INTERNAL_SECRET_HEADER = "x-thor-internal-secret";
const INTERNAL_EXEC_MAX_OUTPUT = 1024 * 1024;
const APPROVALS_DIR = "/workspace/data/approvals";
const GWS_CONNECT_REQUEST_COOKIE = "thor_gws_connect_request";
const GWS_DISCONNECT_COOKIE = "thor_gws_disconnect";
const GWS_DISCONNECT_TTL_MS = 5 * 60 * 1000;
const GITHUB_ISSUE_URL_RE =
  /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/issues\/(\d+)(?:\b|[/?#])/;

export function validateRemoteCliGitHubEnv(env: NodeJS.ProcessEnv = process.env): void {
  loadRemoteCliGitHubEnv(env);
}

export function validateRemoteCliInternalEnv(env: NodeJS.ProcessEnv = process.env): void {
  loadRemoteCliInternalEnv(env);
}

function deriveBotGitIdentity(env: NodeJS.ProcessEnv = process.env): {
  name: string;
  email: string;
} {
  const config = loadRemoteCliGitHubEnv(env);
  return { name: config.gitIdentityName, email: config.gitIdentityEmail };
}

export interface RemoteCliAppConfig {
  appEnv?: ReturnType<typeof loadRemoteCliAppEnv>;
  env?: ReturnType<typeof loadRemoteCliEnv>;
  mcp?: McpServiceDeps;
  slackPostMessage?: SlackPostMessageDeps;
  configLoader?: ConfigLoader;
  gws?: IGwsService;
  gwsOAuth?: GwsOAuthService;
  gwsOAuthDeps?: GwsOAuthServiceDeps;
}

export interface RemoteCliApp {
  app: Express;
  warmUp(): Promise<void>;
  close(): Promise<void>;
}

function isGitCloneArgs(args: unknown): boolean {
  return Array.isArray(args) && args[0] === "clone";
}

function thorIds(req: express.Request): { sessionId?: string; callId?: string } {
  const sessionId = req.headers["x-thor-session-id"] as string | undefined;
  const callId = req.headers["x-thor-call-id"] as string | undefined;
  return {
    ...(sessionId && { sessionId }),
    ...(callId && { callId }),
  };
}

function registerGitCorrelationAlias(
  sessionId: string | undefined,
  args: string[],
  cwd: string,
): void {
  if (!sessionId) return;
  const correlationKey = computeGitCorrelationKey(args, cwd);
  if (!correlationKey) return;

  try {
    appendCorrelationAlias(sessionId, correlationKey);
  } catch (err) {
    logError(log, "alias_registration_error", err instanceof Error ? err.message : String(err), {
      sessionId,
      correlationKey,
    });
    return;
  }
  logInfo(log, "alias_registered", { sessionId, correlationKey, source: "git" });
}

function buildIssueCorrelationKey(owner: string, repo: string, number: string): string {
  // Gateway issue correlation uses the GitHub repo basename as the local repo
  // component. Keep producer-side aliases aligned even when the local worktree
  // parent directory is not the same as owner/repo's basename.
  return `github:issue:${repo}:${owner}/${repo}#${number}`;
}

function parseIssueUrl(
  stdout: string,
): { owner: string; repo: string; number: string } | undefined {
  const match = stdout.match(GITHUB_ISSUE_URL_RE);
  if (!match) return undefined;
  const [, owner, repo, number] = match;
  if (!owner || !repo || !number) return undefined;
  return { owner, repo, number };
}

function ownerRepoMatches(
  cwdRepo: ReturnType<typeof resolveOwnerRepoFromRemote> | undefined,
  owner: string,
  repo: string,
): boolean {
  return (
    !cwdRepo ||
    (cwdRepo.host === "github.com" &&
      cwdRepo.owner.toLowerCase() === owner.toLowerCase() &&
      cwdRepo.repo.toLowerCase() === repo.toLowerCase())
  );
}

function parseCreatedIssueCorrelationKey(stdout: string, cwd: string): string | undefined {
  const issue = parseIssueUrl(stdout);
  if (!issue) return undefined;
  const cwdRepo = resolveOwnerRepoFromRemote(cwd);
  if (!ownerRepoMatches(cwdRepo, issue.owner, issue.repo)) return undefined;
  return buildIssueCorrelationKey(issue.owner, issue.repo, issue.number);
}

function registerCreatedIssueCorrelationAlias(
  sessionId: string | undefined,
  cwd: string,
  stdout: string,
): void {
  if (!sessionId) return;
  const correlationKey = parseCreatedIssueCorrelationKey(stdout, cwd);
  if (!correlationKey) return;
  try {
    appendCorrelationAlias(sessionId, correlationKey);
  } catch (err) {
    logError(log, "alias_registration_error", err instanceof Error ? err.message : String(err), {
      sessionId,
      correlationKey,
    });
    return;
  }
  logInfo(log, "alias_registered", { sessionId, correlationKey, source: "gh" });
}

type FlagMatch = { index: number; valueIndex?: number; inlinePrefix?: string };

function rewriteValueFlag(
  args: string[],
  names: string[],
  append: string | ((value: string) => string),
  options: { valuePrefix?: string; match: "single" | "last" } = { match: "single" },
): string[] | { error: "duplicate" | "notFound" } {
  const { valuePrefix, match: mode } = options;
  const matches: FlagMatch[] = [];
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name && i + 1 < args.length) {
        if (valuePrefix && !args[i + 1].startsWith(valuePrefix)) continue;
        matches.push({ index: i, valueIndex: i + 1 });
        i += 1;
        break;
      }
      if (args[i].startsWith(`${name}=`)) {
        const value = args[i].slice(name.length + 1);
        if (valuePrefix && !value.startsWith(valuePrefix)) continue;
        matches.push({ index: i, inlinePrefix: `${name}=` });
        break;
      }
    }
  }
  if (matches.length === 0) return { error: "notFound" };
  if (matches.length > 1 && mode === "single") return { error: "duplicate" };
  const m = mode === "last" ? matches[matches.length - 1] : matches[0];
  const out = [...args];
  const rewrite = (value: string) =>
    typeof append === "function" ? append(value) : `${value}${append}`;
  if (m.valueIndex !== undefined) {
    out[m.valueIndex] = rewrite(out[m.valueIndex]);
  } else if (m.inlinePrefix) {
    out[m.index] = `${m.inlinePrefix}${rewrite(out[m.index].slice(m.inlinePrefix.length))}`;
  }
  return out;
}

function hasFlag(args: string[], names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function logAttribution(surface: string, outcome: string, extra: Record<string, unknown> = {}) {
  logInfo(log, "attribution_applied", { surface, outcome, ...extra });
}

function withGitAttribution(
  args: string[],
  sessionId: string | undefined,
  getConfig: ConfigLoader,
): string[] {
  if (args[0] !== "commit") return args;
  const resolved = resolveTriggerUser(sessionId, getConfig);
  if (!resolved.user) {
    logAttribution(
      "git",
      resolved.reason ?? "skipped_no_user_record",
      attributionFields(resolved.actor),
    );
    return args;
  }
  if (hasFlag(args, ["-F", "--file"])) {
    logAttribution(
      "git",
      "skipped_unsupported_arg_shape",
      attributionFields(resolved.actor, resolved.user),
    );
    return args;
  }
  const trailerLine = `Co-authored-by: ${resolved.user.name} <${resolved.user.email}>`;
  const attributionEmail = resolved.user.email.toLowerCase();
  let alreadyAttributed = false;
  const rewritten = rewriteValueFlag(
    args,
    ["-m", "--message"],
    (message) => {
      if (message.toLowerCase().includes(attributionEmail)) {
        alreadyAttributed = true;
        return message;
      }
      return `${message}${message.endsWith("\n") ? "\n" : "\n\n"}${trailerLine}`;
    },
    { match: "last" },
  );
  if ("error" in rewritten) {
    logAttribution(
      "git",
      "skipped_unsupported_arg_shape",
      attributionFields(resolved.actor, resolved.user),
    );
    return args;
  }
  if (alreadyAttributed) {
    logAttribution(
      "git",
      "skipped_already_attributed",
      attributionFields(resolved.actor, resolved.user),
    );
    return args;
  }
  logAttribution("git", "applied", attributionFields(resolved.actor, resolved.user));
  return rewritten;
}

function withGhAttribution(
  args: string[],
  sessionId: string | undefined,
  getConfig: ConfigLoader,
): string[] {
  if (!((args[0] === "pr" || args[0] === "issue") && args[1] === "create")) return args;
  const resolved = resolveTriggerUser(sessionId, getConfig);
  if (hasFlag(args, ["--assignee", "-a"])) {
    logAttribution(
      "gh-assignee",
      "skipped_existing_assignee",
      attributionFields(resolved.actor, resolved.user),
    );
    return args;
  }
  if (!resolved.user) {
    logAttribution(
      "gh-assignee",
      resolved.reason ?? "skipped_no_user_record",
      attributionFields(resolved.actor),
    );
    return args;
  }
  if (!resolved.user.github) {
    logAttribution("gh-assignee", "skipped_missing_identity_field", {
      field: "github",
      ...attributionFields(resolved.actor, resolved.user),
    });
    return args;
  }
  logAttribution("gh-assignee", "applied", attributionFields(resolved.actor, resolved.user));
  return [...args, "--assignee", resolved.user.github];
}

function isGhHelpRequest(args: string[]): boolean {
  if (args[0] === "help") return true;
  if (args.length === 1 && ["-h", "--help"].includes(args[0] ?? "")) return true;
  if (args.length === 2 && ["-h", "--help"].includes(args[1] ?? "")) return true;
  if (args.length === 3 && ["-h", "--help"].includes(args[2] ?? "")) return true;
  return false;
}

function withGhDisclaimer(args: string[], sessionId?: string): string[] | { error: string } {
  if (isGhHelpRequest(args)) return args;
  const eligible =
    (args[0] === "pr" && ["create", "comment", "review"].includes(args[1] ?? "")) ||
    (args[0] === "issue" && ["create", "comment"].includes(args[1] ?? "")) ||
    (args[0] === "api" && args.some((arg) => /pulls\/\d+\/comments\/\d+\/replies/.test(arg)));
  if (!eligible) return args;
  let footer: string;
  try {
    footer = `\n${buildThorDisclaimerForSession(sessionId, getRunnerBaseUrl()).footer}`;
  } catch (err) {
    return {
      error:
        err instanceof Error ? err.message : "Disclaimer required: unable to build Thor disclaimer",
    };
  }
  const result =
    args[0] === "api"
      ? rewriteValueFlag(args, ["-f", "--raw-field"], footer, {
          match: "single",
          valuePrefix: "body=",
        })
      : rewriteValueFlag(args, ["--body", "-b"], footer, { match: "single" });
  if ("error" in result) {
    return {
      error:
        result.error === "duplicate"
          ? "Disclaimer required: multiple mutable gh body fields"
          : "Disclaimer required: could not find a mutable gh body field",
    };
  }
  return result;
}

/**
 * Run `fn` while a heartbeat keeps the NDJSON response stream alive.
 * Sends a typed heartbeat chunk every 30s to prevent idle-connection
 * timeouts; the heartbeat is always cleared on exit.
 */
async function withNdjsonHeartbeat<T>(
  write: (chunk: ExecStreamEvent) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const id = setInterval(() => write({ type: "heartbeat" }), 30_000);
  try {
    return await fn();
  } finally {
    clearInterval(id);
  }
}

function parseArgs(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object" || !("args" in body)) return undefined;
  const args = (body as { args?: unknown }).args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    return undefined;
  }
  return args;
}

function getInternalSecretHeader(req: express.Request): string | undefined {
  return req.get(INTERNAL_SECRET_HEADER) ?? undefined;
}

type SandboxMode = "exec" | "create" | "stop" | "list";

function parseSandboxMode(input: unknown): SandboxMode | null {
  if (input === undefined) return "exec";
  if (input === "exec" || input === "create" || input === "stop" || input === "list") {
    return input;
  }
  return null;
}

function buildSandboxName(cwd: string): string {
  // Worktree roots are /workspace/worktrees/<repo>/<branch...> (branch may
  // contain slashes). Keep repo + full branch path in the name for readability.
  // Fallback for non-worktree paths: last two segments.
  const worktreeSegments = cwd.startsWith(WORKTREE_PREFIX)
    ? cwd.slice(WORKTREE_PREFIX.length).split("/").filter(Boolean)
    : [];
  const segments = worktreeSegments.length >= 2 ? worktreeSegments : cwd.split("/").filter(Boolean);

  const slug = segments
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `thor-${slug || "sandbox"}`.slice(0, 63);
}

interface PreparedSandbox {
  sandboxId: string;
  command: string;
}

async function resolveWorktreeRoot(cwd: string): Promise<{ root: string; subpath: string }> {
  // The cwd may be a subdirectory that only exists inside the sandbox
  // (e.g. node_modules/, build/). Find the deepest existing ancestor
  // to run git from — access() is a single syscall per level, no process spawn.
  let gitCwd = cwd;
  while (gitCwd.length > WORKTREE_ROOT.length) {
    try {
      await access(gitCwd);
      break;
    } catch {
      gitCwd = gitCwd.slice(0, gitCwd.lastIndexOf("/")) || "/";
    }
  }

  const result = await execCommand("git", ["rev-parse", "--show-toplevel"], gitCwd);
  if ((result.exitCode ?? 0) !== 0 || !result.stdout.trim()) {
    throw new SandboxError(
      "Failed to resolve worktree root",
      `git rev-parse --show-toplevel failed for ${cwd}`,
    );
  }
  const root = result.stdout.trim();
  if (!isValidWorktreeTopLevel(root)) {
    throw new SandboxError(
      "Failed to resolve worktree root",
      `git toplevel is not a valid worktree path: ${root}`,
    );
  }

  const containingRoot = await findContainingWorktreeRoot(root);
  if (containingRoot) {
    throw new SandboxError(
      "Failed to resolve worktree root",
      `git toplevel is nested under another working tree: ${root} (parent ${containingRoot})`,
    );
  }

  const subpath = cwd.startsWith(root + "/") ? cwd.slice(root.length + 1) : "";
  return { root, subpath };
}

async function findContainingWorktreeRoot(root: string): Promise<string | null> {
  let current = dirname(root);

  while (current.length > WORKTREE_ROOT.length && current.startsWith(WORKTREE_PREFIX)) {
    const result = await execCommand("git", ["rev-parse", "--show-toplevel"], current);
    if ((result.exitCode ?? 0) === 0) {
      const candidate = result.stdout.trim();
      if (
        candidate &&
        candidate !== root &&
        isValidWorktreeTopLevel(candidate) &&
        root.startsWith(candidate + "/")
      ) {
        return candidate;
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function isValidWorktreeTopLevel(root: string): boolean {
  if (!root.startsWith(WORKTREE_PREFIX) || root.includes("\0")) return false;

  const normalized = normalizePosix(root);
  if (normalized !== root) return false;

  const relative = root.slice(WORKTREE_PREFIX.length);
  if (!relative || relative.startsWith("/") || relative.endsWith("/")) return false;

  const segments = relative.split("/");
  if (segments.length < 2) return false;
  if (segments.some((segment) => segment.length === 0 || segment === "..")) return false;

  return true;
}

function validateSandboxCwd(cwd: unknown): string | null {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) {
    return "cwd must be an absolute path";
  }
  if (cwd.includes("\0")) {
    return `cwd must be under ${WORKTREE_ROOT}`;
  }

  const normalized = normalizePosix(cwd);
  if (normalized !== cwd) {
    return `cwd must be under ${WORKTREE_ROOT}`;
  }
  if (!cwd.startsWith(WORKTREE_PREFIX)) {
    return "Sandbox requires a worktree. Create one first with: git worktree add -b <branch> /workspace/worktrees/<repo>/<branch-with-slashes> HEAD";
  }

  return null;
}

async function prepareSandbox(
  cwd: string,
  mode: "exec" | "create",
  args: string[],
): Promise<PreparedSandbox> {
  const { root: worktreeRoot, subpath } = await resolveWorktreeRoot(cwd);

  // Lock per-worktree: prevents duplicate sandbox creation (TOCTOU in
  // ensureSandbox) and conflicting syncs on the same worktree.
  // Released before streaming exec so commands run concurrently.
  return withCwdLock(worktreeRoot, async () => {
    const currentSha = await resolveHead(worktreeRoot);
    const sandbox = await ensureSandbox(worktreeRoot, currentSha);

    if (mode === "create") {
      return { sandboxId: sandbox.id, command: "" };
    }

    const lastSyncedSha = getLastSyncedSha(sandbox);
    if (lastSyncedSha !== currentSha) {
      await syncSandbox(sandbox.id, worktreeRoot, lastSyncedSha, currentSha);
    }

    const overlay = await overlayDirtyFiles(sandbox.id, worktreeRoot);
    if (overlay.pushed.length > 0 || overlay.deleted.length > 0) {
      logInfo(log, "sandbox_overlay_push", {
        pushed: overlay.pushed,
        deleted: overlay.deleted,
        cwd: worktreeRoot,
      });
    }

    // If cwd is a subdirectory of the worktree root, prepend a cd into
    // the matching subpath inside the sandbox so the command runs in the
    // right directory (e.g. cwd=.../tree/packages/foo → cd packages/foo).
    const cdPrefix = subpath ? `cd ${shellQuote(subpath)} && ` : "";

    // Unwrap shell wrappers: when args are ["sh"|"bash", "-c"|"-lc", "..."],
    // pass the inner command directly to the outer login shell instead of
    // nesting a child shell. This avoids the function-inheritance trap where
    // nvm/sdk/pyenv (bash functions loaded by .profile) are not available
    // in a child bash -c process.
    if (
      (args[0] === "sh" || args[0] === "bash") &&
      (args[1] === "-c" || args[1] === "-lc") &&
      args.length === 3
    ) {
      return {
        sandboxId: sandbox.id,
        command: `bash -lc ${shellQuote(cdPrefix + args[2])}`,
      };
    }

    const command = args.map((a: string) => shellQuote(a)).join(" ");
    return {
      sandboxId: sandbox.id,
      command: `bash -lc ${shellQuote(cdPrefix + command)}`,
    };
  });
}

async function resolveHead(cwd: string): Promise<string> {
  const gitSha = await execCommand("git", ["rev-parse", "HEAD"], cwd);
  if ((gitSha.exitCode ?? 0) !== 0) {
    throw new SandboxError(
      "Failed to resolve worktree HEAD",
      `git rev-parse HEAD failed: ${gitSha.stderr || gitSha.stdout}`,
    );
  }
  const sha = gitSha.stdout.trim();
  if (!sha) {
    throw new SandboxError(
      "Failed to resolve worktree HEAD",
      "git rev-parse HEAD returned empty SHA",
    );
  }
  return sha;
}

async function ensureSandbox(cwd: string, currentSha: string) {
  const existing = await findSandboxForCwd(cwd);
  if (existing) return existing;

  const labels = {
    [THOR_MANAGED_LABEL]: "true",
    [THOR_CWD_LABEL]: cwd,
    [THOR_SHA_LABEL]: currentSha,
  };

  return createSandbox(buildSandboxName(cwd), cwd, currentSha, labels);
}

function summarizeGwsOperation(args: readonly string[]): string {
  const tokenCount = args[1]?.startsWith("+") ? 2 : 3;
  const tokens = args.slice(0, tokenCount);
  if (
    tokens.length === 0 ||
    tokens.some((arg) => arg.startsWith("-") || !/^[A-Za-z0-9_+]{1,80}$/.test(arg))
  ) {
    return "gws command";
  }
  return tokens.join(".");
}

function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function gwsConnectRequestCookie(value: string): string {
  return `${GWS_CONNECT_REQUEST_COOKIE}=${encodeURIComponent(value)}; Path=/google-workspace/connect/authorize; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

function clearGwsConnectRequestCookie(): string {
  return `${GWS_CONNECT_REQUEST_COOKIE}=; Path=/google-workspace/connect/authorize; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function gwsOAuthBrowserCookie(value: string, maxAgeSeconds: number): string {
  return `${GWS_OAUTH_BROWSER_COOKIE}=${encodeURIComponent(value)}; Path=/google-workspace/oauth/callback; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function clearGwsOAuthBrowserCookie(): string {
  return `${GWS_OAUTH_BROWSER_COOKIE}=; Path=/google-workspace/oauth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function setGwsOAuthBrowserSecurityHeaders(
  res: express.Response,
  options: { allowSelfForm?: boolean } = {},
): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action ${options.allowSelfForm ? "'self'" : "'none'"}`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function gwsDisconnectConfirmationHtml(csrfToken: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Disconnect Google Workspace</title></head><body><h1>Disconnect Google Workspace</h1><p>This removes Thor's local grant. You should also revoke Thor in Google Account security settings.</p><form method="post" action="/google-workspace/disconnect"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">Disconnect Google Workspace</button></form></body></html>`;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function gwsOAuthHtml(
  title: string,
  message: string,
  confirmation?: { csrfToken: string },
): string {
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (character) => {
      const escaped: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return escaped[character] ?? "";
    });
  const form = confirmation
    ? `<form method="post" action="/google-workspace/connect/authorize"><input type="hidden" name="csrf" value="${escape(confirmation.csrfToken)}"><button type="submit">Connect this Google account</button></form>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1><p>${escape(message)}</p>${form}</body></html>`;
}

function gwsIdentityDenialMessage(
  reason: Extract<GwsSlackRequester, { ok: false }>["reason"],
): string {
  switch (reason) {
    case "missing_session":
    case "no_active_slack_trigger":
      return "Google Workspace requires an active Slack-requested turn. No OAuth DM was sent. Retry the request from Slack.\n";
    default:
      return "Google Workspace could not verify the configured account restrictions. No OAuth DM was sent. Ask the operator to check Google Workspace account configuration.\n";
  }
}

export function createRemoteCliApp(config: RemoteCliAppConfig = {}): RemoteCliApp {
  const appEnv = config.appEnv ?? loadRemoteCliAppEnv();
  const envConfig = config.env;
  const internalSecret = appEnv.thorInternalSecret;
  const gws = config.gws ?? new GwsService(process.env);
  const gwsOAuth = config.gwsOAuth ?? new GwsOAuthService(process.env, config.gwsOAuthDeps);
  const approvalsDir = config.mcp?.approvalsDir ?? APPROVALS_DIR;
  const pendingDisconnects = new Map<string, { token: string; expiresAtMs: number }>();
  const gwsApprovalStore = new ApprovalStore(`${approvalsDir}/gws`, "gws");
  const drata = new DrataService(process.env);
  const getConfig =
    config.configLoader ?? config.mcp?.configLoader ?? createConfigLoader(WORKSPACE_CONFIG_PATH);
  const gwsSlackTransport = {
    fetch: config.mcp?.fetchImpl,
    env: {
      SLACK_BOT_TOKEN: config.mcp?.slack?.botToken ?? envConfig?.slackBotToken,
      SLACK_API_BASE_URL: config.mcp?.slack?.apiBaseUrl ?? envConfig?.slackApiBaseUrl,
    },
  };
  const gwsIdentity = new GwsSlackIdentityService(getConfig);
  const rawWriteToolCallLog = config.mcp?.writeToolCallLogFn ?? writeToolCallLog;
  const safeWriteToolCallLog = (entry: ToolCallLogEntry): void =>
    rawWriteToolCallLog(sanitizeCredentialBrokerToolCallLog(entry));
  const executeApprovedGwsCommand = async (input: {
    action: ApprovalAction;
    reviewer: string;
  }): Promise<{ result: McpExecResult; consumed: boolean }> => {
    const approvedSummary = GoogleWorkspaceCommandApprovalArgsSchema.safeParse(input.action.args);
    if (!approvedSummary.success || input.action.tool !== "google_workspace_command") {
      return {
        consumed: false,
        result: {
          stdout: "",
          stderr: "Google Workspace approval metadata is invalid.\n",
          exitCode: 1,
        },
      };
    }
    const consumed = gwsOAuth.consumePendingCommand(input.action.id, input.reviewer);
    if (!consumed.ok) {
      const alreadyConsumed = consumed.error.code === "already_used";
      return {
        consumed: alreadyConsumed,
        result: {
          stdout: "",
          stderr: alreadyConsumed
            ? 'Error calling "google_workspace_command": approval_already_consumed'
            : "Google Workspace approval is not valid for this Slack user.\n",
          exitCode: 1,
        },
      };
    }
    const finishConsumedCommand = (
      actualResult: McpExecResult,
      failureCategory?: string,
    ): { result: McpExecResult; consumed: true } => {
      const stored = gwsOAuth.storeCommandResult(input.action.id, actualResult);
      if (!stored.ok) {
        return {
          consumed: true,
          result: {
            stdout: JSON.stringify({
              status: "error",
              tool: "google_workspace_command",
              upstream: "gws",
              result_available: false,
            }),
            stderr: 'Error calling "google_workspace_command": result_storage_failed',
            exitCode: 1,
          },
        };
      }
      return {
        consumed: true,
        result: {
          stdout: JSON.stringify({
            status: failureCategory ? "error" : "completed",
            tool: "google_workspace_command",
            upstream: "gws",
            result_available: true,
            result_capability: stored.value,
          }),
          stderr: failureCategory
            ? `Error calling "google_workspace_command": ${failureCategory}`
            : "",
          exitCode: failureCategory ? 1 : 0,
        },
      };
    };
    const privateFingerprint = gwsOAuth.fingerprintCommand(consumed.value.args);
    if (!privateFingerprint.ok) {
      return finishConsumedCommand(
        {
          stdout: "",
          stderr: "Google Workspace command binding is unavailable; submit a new command.\n",
          exitCode: 1,
        },
        "command_binding_unavailable",
      );
    }
    const privateSummary = {
      operation: summarizeGwsOperation(consumed.value.args),
      argumentCount: consumed.value.args.length,
      commandFingerprint: privateFingerprint.value,
    };
    if (
      approvedSummary.data.slack_user_id !== consumed.value.owner.slackUserId ||
      approvedSummary.data.google_workspace_email !== consumed.value.owner.expectedGoogleEmail ||
      approvedSummary.data.operation !== privateSummary.operation ||
      approvedSummary.data.argument_count !== privateSummary.argumentCount ||
      approvedSummary.data.command_fingerprint !== privateSummary.commandFingerprint
    ) {
      return finishConsumedCommand(
        {
          stdout: "",
          stderr:
            "Google Workspace approval did not match the private command; submit a new command.\n",
          exitCode: 1,
        },
        "command_binding_mismatch",
      );
    }
    const currentUser = gwsIdentity.resolveGooglePin(consumed.value.owner.slackUserId);
    if (
      !currentUser.ok ||
      (currentUser.googleEmailPin !== undefined &&
        currentUser.googleEmailPin !== consumed.value.owner.expectedGoogleEmail)
    ) {
      return finishConsumedCommand(
        {
          stdout: "",
          stderr:
            "Google Workspace account mapping changed after approval was requested; submit a new command.\n",
          exitCode: 1,
        },
        "account_mapping_changed",
      );
    }
    const token = await gwsOAuth.getAccessToken(
      consumed.value.owner.slackUserId,
      consumed.value.owner.expectedGoogleEmail,
    );
    if (!token.ok) {
      const reconnectRequired =
        token.error.stage === "token" ||
        token.error.stage === "oauth" ||
        token.error.stage === "identity";
      if (reconnectRequired) gwsOAuth.disconnect(consumed.value.owner.slackUserId);
      logInfo(log, "exec_gws_oauth_failed", {
        stage: token.error.stage,
        code: token.error.code,
        actionId: input.action.id,
        slack: consumed.value.owner.slackUserId,
      });
      return finishConsumedCommand(
        {
          stdout: "",
          stderr: reconnectRequired
            ? "Google Workspace account access is unavailable. Retry to receive a new private connection link, then submit a new command.\n"
            : "Google Workspace account storage is unavailable; ask an operator to check configuration.\n",
          exitCode: 1,
        },
        reconnectRequired ? "account_reconnect_required" : "account_storage_unavailable",
      );
    }
    if (token.value.connectionId !== approvedSummary.data.connection_id) {
      return finishConsumedCommand(
        {
          stdout: "",
          stderr:
            "Google Workspace connection changed after approval was requested; submit a new command.\n",
          exitCode: 1,
        },
        "connection_changed",
      );
    }
    let response: Awaited<ReturnType<IGwsService["execute"]>>;
    try {
      response = await gws.execute([...consumed.value.args], token.value);
    } catch {
      logError(log, "exec_gws_dispatch_failed", "Unexpected Google Workspace execution failure", {
        actionId: input.action.id,
        reviewer: input.reviewer,
        slack: consumed.value.owner.slackUserId,
        operation: summarizeGwsOperation(consumed.value.args),
        argc: consumed.value.args.length,
        commandFingerprint: privateFingerprint.value,
      });
      return finishConsumedCommand(
        {
          stdout: "",
          stderr: "Google Workspace execution failed after approval; do not retry this approval.\n",
          exitCode: 1,
        },
        "execution_failed",
      );
    }
    logInfo(log, "exec_gws_approved", {
      actionId: input.action.id,
      reviewer: input.reviewer,
      slack: consumed.value.owner.slackUserId,
      googleEmail: token.value.googleEmail,
      googleSubject: token.value.googleSubject,
      connectionId: token.value.connectionId,
      operation: summarizeGwsOperation(consumed.value.args),
      argc: consumed.value.args.length,
      commandFingerprint: privateFingerprint.value,
      status: response.status,
      exitCode: response.result.exitCode,
    });
    return finishConsumedCommand(
      response.result,
      response.result.exitCode === 0 ? undefined : "provider_command_failed",
    );
  };
  const readGwsApprovalStatus = async (input: {
    action: ApprovalAction;
    mode: "status" | "result";
    capability?: string;
    context: { sessionId?: string };
  }): Promise<McpExecResult> => {
    if (input.mode === "status") {
      return {
        stdout: `${JSON.stringify(
          {
            id: input.action.id,
            upstream: input.action.upstream,
            status: input.action.status,
            tool: input.action.tool,
            args: input.action.args,
            createdAt: input.action.createdAt,
            ...(input.action.resolvedAt ? { resolvedAt: input.action.resolvedAt } : {}),
            ...(input.action.reviewer ? { reviewer: input.action.reviewer } : {}),
          },
          null,
          2,
        )}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    const activeUser = gwsIdentity.resolveActiveRequester(input.context.sessionId);
    const approvedSummary = GoogleWorkspaceCommandApprovalArgsSchema.safeParse(input.action.args);
    if (
      !activeUser.ok ||
      !approvedSummary.success ||
      activeUser.slackUserId !== approvedSummary.data.slack_user_id ||
      (activeUser.googleEmailPin !== undefined &&
        activeUser.googleEmailPin !== approvedSummary.data.google_workspace_email)
    ) {
      return {
        stdout: "",
        stderr: "Google Workspace command output is unavailable for this active Slack turn.\n",
        exitCode: 1,
      };
    }
    const connected = gwsOAuth.findConnectedIdentity(
      activeUser.slackUserId,
      approvedSummary.data.google_workspace_email,
    );
    if (!connected.ok || connected.value.connectionId !== approvedSummary.data.connection_id) {
      return {
        stdout: "",
        stderr: "Google Workspace connection changed; command output is unavailable.\n",
        exitCode: 1,
      };
    }
    const result = gwsOAuth.readCommandResult(input.action.id, input.capability);
    if (!result.ok) {
      return {
        stdout: "",
        stderr: "Google Workspace command output is unavailable for this approval capability.\n",
        exitCode: 1,
      };
    }
    return result.value;
  };
  const mcpService = createMcpService({
    isProduction: appEnv.isProduction,
    ...config.mcp,
    writeToolCallLogFn: safeWriteToolCallLog,
    configLoader: config.mcp?.configLoader ?? getConfig,
    slack: config.mcp?.slack ?? {
      botToken: envConfig?.slackBotToken,
      apiBaseUrl: envConfig?.slackApiBaseUrl,
    },
    customApprovalExecutors: {
      ...config.mcp?.customApprovalExecutors,
      gws: executeApprovedGwsCommand,
    },
    customApprovalStatusReaders: {
      ...config.mcp?.customApprovalStatusReaders,
      gws: readGwsApprovalStatus,
    },
    customApprovalReviewerAuthorizers: {
      ...config.mcp?.customApprovalReviewerAuthorizers,
      gws: ({ action, reviewer }) => {
        const summary = GoogleWorkspaceCommandApprovalArgsSchema.safeParse(action.args);
        return summary.success && summary.data.slack_user_id === reviewer;
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "remote-cli",
      mcp: mcpService.getHealth(),
      googleWorkspaceOAuth: gwsOAuth.setupStatus(),
    });
  });

  app.post("/internal/google-workspace/diagnostics", async (req, res) => {
    if (!matchesInternalSecret(internalSecret, getInternalSecretHeader(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const target = z
      .object({ slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/) })
      .strict()
      .safeParse(req.body);
    if (!target.success) {
      res.status(400).json({ error: "A Slack member ID is required" });
      return;
    }
    const pin = gwsIdentity.resolveGooglePin(target.data.slackUserId);
    const connected = pin.ok
      ? gwsOAuth.findConnectedIdentity(target.data.slackUserId, pin.googleEmailPin)
      : undefined;
    res.json({
      oauth: gwsOAuth.setupStatus(),
      botTokenConfigured: !!gwsSlackTransport.env.SLACK_BOT_TOKEN,
      identity: pin.ok
        ? { ok: true, pinned: !!pin.googleEmailPin, connected: connected?.ok ?? false }
        : pin,
    });
  });

  app.get("/google-workspace/connect", (req, res) => {
    setGwsOAuthBrowserSecurityHeaders(res);
    if (!matchesInternalSecret(internalSecret, getInternalSecretHeader(req))) {
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    const requestId = typeof req.query.request === "string" ? req.query.request : "";
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(requestId)) {
      res
        .status(400)
        .type("html")
        .send(
          gwsOAuthHtml("Google Workspace connection failed", "The connection link is invalid."),
        );
      return;
    }
    res.setHeader("Set-Cookie", gwsConnectRequestCookie(requestId));
    res.redirect(302, "/google-workspace/connect/authorize");
  });

  const authorizeGoogleConnection: express.RequestHandler = (req, res) => {
    setGwsOAuthBrowserSecurityHeaders(res, { allowSelfForm: true });
    if (!matchesInternalSecret(internalSecret, getInternalSecretHeader(req))) {
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    const requestId = parseCookieHeader(req.get("cookie"), GWS_CONNECT_REQUEST_COOKIE) ?? "";
    const authenticatedEmail = req.get("x-vouch-user")?.trim().toLowerCase() ?? "";
    if (!requestId || !authenticatedEmail) {
      logInfo(log, "gws_oauth_browser_context_missing", {
        requestCookiePresent: Boolean(requestId),
        authenticatedEmailPresent: Boolean(authenticatedEmail),
      });
      if (!requestId) res.setHeader("Set-Cookie", clearGwsConnectRequestCookie());
      res
        .status(400)
        .type("html")
        .send(
          gwsOAuthHtml(
            "Google Workspace connection failed",
            !requestId
              ? "The private connection cookie is missing or expired. Open a fresh original Slack DM link in this same browser; this authorization page cannot be opened directly. If the problem repeats, check whether browser cookies are blocked."
              : "Browser sign-in identity was not forwarded. Ask the operator to check the Google SSO ingress configuration. The connection cookie has been preserved; no Google authorization was started.",
          ),
        );
      return;
    }
    const preview = gwsOAuth.previewAuthorization(requestId, authenticatedEmail);
    if (preview.ok && preview.value.confirmationRequired && req.method === "GET") {
      res
        .type("html")
        .send(
          gwsOAuthHtml(
            "Confirm Google Workspace connection",
            `Connect Google account ${preview.value.googleEmail} to Slack member ${preview.value.slackUserId} in workspace ${preview.value.slackTeamId}. Continue only if this is your Slack account and you requested this private connection link. Do not forward the link.`,
            { csrfToken: preview.value.confirmationToken },
          ),
        );
      return;
    }
    const csrf = typeof req.body?.csrf === "string" ? req.body.csrf : undefined;
    const started = gwsOAuth.beginAuthorization(
      requestId,
      authenticatedEmail,
      req.method === "POST" ? csrf : undefined,
    );
    if (!started.ok) {
      res.setHeader("Set-Cookie", clearGwsConnectRequestCookie());
      logInfo(log, "gws_oauth_connect_rejected", {
        stage: started.error.stage,
        code: started.error.code,
      });
      res
        .status(400)
        .type("html")
        .send(
          gwsOAuthHtml(
            "Google Workspace connection failed",
            "The link is expired, already used, or does not belong to this signed-in user.",
          ),
        );
      return;
    }
    res.setHeader("Set-Cookie", [
      clearGwsConnectRequestCookie(),
      gwsOAuthBrowserCookie(started.value.browserNonce, started.value.maxAgeSeconds),
    ]);
    res.redirect(302, started.value.authorizationUrl);
  };
  app.get("/google-workspace/connect/authorize", authorizeGoogleConnection);
  app.post("/google-workspace/connect/authorize", authorizeGoogleConnection);

  app.get("/google-workspace/disconnect", (req, res) => {
    setGwsOAuthBrowserSecurityHeaders(res, { allowSelfForm: true });
    if (!matchesInternalSecret(internalSecret, getInternalSecretHeader(req))) {
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    const authenticatedEmail = req.get("x-vouch-user")?.trim().toLowerCase() ?? "";
    const connection = gwsOAuth.findConnectedIdentityByEmail(authenticatedEmail);
    if (!authenticatedEmail || !connection.ok) {
      res
        .status(403)
        .type("html")
        .send(
          gwsOAuthHtml(
            "Google Workspace disconnect failed",
            "This signed-in identity does not have a unique connected Google Workspace account.",
          ),
        );
      return;
    }
    const token = randomBytes(32).toString("base64url");
    pendingDisconnects.set(authenticatedEmail, {
      token,
      expiresAtMs: Date.now() + GWS_DISCONNECT_TTL_MS,
    });
    res.setHeader(
      "Set-Cookie",
      `${GWS_DISCONNECT_COOKIE}=${token}; Path=/google-workspace/disconnect; Max-Age=300; HttpOnly; Secure; SameSite=Strict`,
    );
    res.status(200).type("html").send(gwsDisconnectConfirmationHtml(token));
  });

  app.post("/google-workspace/disconnect", (req, res) => {
    setGwsOAuthBrowserSecurityHeaders(res);
    if (!matchesInternalSecret(internalSecret, getInternalSecretHeader(req))) {
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    const authenticatedEmail = req.get("x-vouch-user")?.trim().toLowerCase() ?? "";
    const cookieToken = parseCookieHeader(req.get("cookie"), GWS_DISCONNECT_COOKIE) ?? "";
    const formToken = typeof req.body?.csrf === "string" ? req.body.csrf : "";
    const pending = pendingDisconnects.get(authenticatedEmail);
    pendingDisconnects.delete(authenticatedEmail);
    res.setHeader(
      "Set-Cookie",
      `${GWS_DISCONNECT_COOKIE}=; Path=/google-workspace/disconnect; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    );
    if (
      !authenticatedEmail ||
      !pending ||
      pending.expiresAtMs <= Date.now() ||
      !cookieToken ||
      !formToken ||
      !timingSafeStringEqual(pending.token, cookieToken) ||
      !timingSafeStringEqual(pending.token, formToken)
    ) {
      res
        .status(403)
        .type("html")
        .send(
          gwsOAuthHtml(
            "Google Workspace disconnect failed",
            "The confirmation expired or did not come from the same signed-in browser.",
          ),
        );
      return;
    }
    const connection = gwsOAuth.findConnectedIdentityByEmail(authenticatedEmail);
    if (!connection.ok) {
      res
        .status(403)
        .type("html")
        .send(
          gwsOAuthHtml(
            "Google Workspace disconnect failed",
            "This identity has no unique connected account.",
          ),
        );
      return;
    }
    const disconnected = gwsOAuth.disconnect(connection.value.slackUserId);
    if (!disconnected.ok) {
      logInfo(log, "gws_oauth_disconnect_rejected", {
        stage: disconnected.error.stage,
        code: disconnected.error.code,
      });
      res
        .status(503)
        .type("html")
        .send(
          gwsOAuthHtml(
            "Google Workspace disconnect failed",
            "Thor could not remove the local grant. Ask an operator to check configuration.",
          ),
        );
      return;
    }
    logInfo(log, "gws_oauth_disconnected", {
      slack: connection.value.slackUserId,
      googleEmail: authenticatedEmail,
    });
    res
      .status(200)
      .type("html")
      .send(
        gwsOAuthHtml(
          "Google Workspace disconnected",
          "Thor removed the local grant. Revoke Thor in your Google Account security settings to invalidate the provider grant immediately.",
        ),
      );
  });

  app.get("/google-workspace/oauth/callback", async (req, res) => {
    setGwsOAuthBrowserSecurityHeaders(res);
    if (!matchesInternalSecret(internalSecret, getInternalSecretHeader(req))) {
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const browserNonce = parseCookieHeader(req.get("cookie"), GWS_OAUTH_BROWSER_COOKIE) ?? "";
    res.setHeader("Set-Cookie", clearGwsOAuthBrowserCookie());
    if (!code || !state || !browserNonce || code.length > 4096 || state.length > 512) {
      res
        .status(400)
        .type("html")
        .send(gwsOAuthHtml("Google Workspace connection failed", "The OAuth callback is invalid."));
      return;
    }
    const completed = await gwsOAuth.completeAuthorization({ code, state, browserNonce });
    if (!completed.ok) {
      logInfo(log, "gws_oauth_callback_rejected", {
        stage: completed.error.stage,
        code: completed.error.code,
        httpStatus: completed.error.httpStatus,
      });
      res
        .status(400)
        .type("html")
        .send(
          gwsOAuthHtml(
            "Google Workspace connection failed",
            "Authorization could not be completed. Return to Slack and request a new link.",
          ),
        );
      return;
    }
    logInfo(log, "gws_oauth_connected", {
      connectionId: completed.value.connectionId,
      slack: completed.value.slackUserId,
      googleEmail: completed.value.googleEmail,
      googleSubject: completed.value.googleSubject,
      sessionId: completed.value.sessionId,
      anchorId: completed.value.anchorId,
      triggerId: completed.value.triggerId,
    });
    const retryTarget = resolveSlackThreadTargetFromTrigger(completed.value.sessionId);
    if (!("error" in retryTarget)) {
      const notification = await postSlackMessageApi(
        {
          channel: retryTarget.channel,
          threadTs: retryTarget.threadTs,
          text: "Google Workspace is connected. Retry the original request; Thor will ask you to approve the exact command before execution.",
        },
        gwsSlackTransport,
      );
      if ("error" in notification) {
        logInfo(log, "gws_oauth_retry_notification_failed", {
          connectionId: completed.value.connectionId,
          slack: completed.value.slackUserId,
        });
      }
    }
    res
      .status(200)
      .type("html")
      .send(
        gwsOAuthHtml(
          "Google Workspace connected",
          "Return to Slack and submit the command again. Thor will ask you to approve it before execution.",
        ),
      );
  });

  app.post("/exec/git", async (req, res) => {
    try {
      const { args, cwd } = req.body ?? {};

      const cwdError = validateCwd(cwd);
      if (cwdError) {
        res.status(400).json({ stdout: "", stderr: cwdError, exitCode: 1 });
        return;
      }

      const gitCloneAllowedOwners = isGitCloneArgs(args)
        ? Object.keys(getConfig().owners ?? {})
        : [];
      const gitResolution = resolveGitArgs(args, cwd, { gitCloneAllowedOwners });
      if ("error" in gitResolution) {
        res.status(400).json({ stdout: "", stderr: gitResolution.error, exitCode: 1 });
        return;
      }
      const ids = thorIds(req);
      const effectiveCwd = gitResolution.cwd ?? cwd;
      const effectiveCwdError = validateCwd(effectiveCwd);
      if (effectiveCwdError) {
        res.status(400).json({ stdout: "", stderr: effectiveCwdError, exitCode: 1 });
        return;
      }
      const effectiveArgs = withGitAttribution(gitResolution.args, ids.sessionId, getConfig);
      logInfo(log, "exec_git", {
        args,
        ...(JSON.stringify(effectiveArgs) !== JSON.stringify(args) ? { effectiveArgs } : {}),
        cwd,
        ...(effectiveCwd !== cwd ? { effectiveCwd } : {}),
        ...ids,
      });
      const result = await execCommand("git", effectiveArgs, effectiveCwd);
      if ((result.exitCode ?? 0) === 0) {
        registerGitCorrelationAlias(ids.sessionId, effectiveArgs, effectiveCwd);
      }
      res.json(result);
    } catch (err) {
      logError(
        log,
        "exec_git_error",
        err instanceof Error ? err.message : String(err),
        thorIds(req),
      );
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    }
  });

  app.post("/exec/gh", async (req, res) => {
    try {
      const { args, cwd } = req.body ?? {};

      const cwdError = validateCwd(cwd);
      if (cwdError) {
        res.status(400).json({ stdout: "", stderr: cwdError, exitCode: 1 });
        return;
      }

      const argsError = validateGhArgs(args, cwd);
      if (argsError) {
        res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
        return;
      }

      const ids = thorIds(req);
      const disclaimerArgs = withGhDisclaimer(args, ids.sessionId);
      if (!Array.isArray(disclaimerArgs)) {
        res.status(400).json({ stdout: "", stderr: disclaimerArgs.error, exitCode: 1 });
        return;
      }
      const effectiveArgs = withGhAttribution(disclaimerArgs, ids.sessionId, getConfig);

      logInfo(log, "exec_gh", { args: effectiveArgs, cwd, ...ids });
      const result = await execCommand("gh", effectiveArgs, cwd);
      if ((result.exitCode ?? 0) === 0) {
        if (effectiveArgs[0] === "issue" && effectiveArgs[1] === "create") {
          registerCreatedIssueCorrelationAlias(ids.sessionId, cwd, result.stdout);
        }
      }
      res.json(result);
    } catch (err) {
      logError(
        log,
        "exec_gh_error",
        err instanceof Error ? err.message : String(err),
        thorIds(req),
      );
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    }
  });

  app.post("/exec/scoutqa", async (req, res) => {
    try {
      const { args } = req.body ?? {};

      const argsError = validateScoutqaArgs(args);
      if (argsError) {
        res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
        return;
      }

      logInfo(log, "exec_scoutqa", { args, ...thorIds(req) });

      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Transfer-Encoding", "chunked");

      const write = (chunk: ExecStreamEvent) => {
        res.write(JSON.stringify(chunk) + "\n");
      };

      await withNdjsonHeartbeat(write, async () => {
        const exitCode = await execCommandStream("scoutqa", args, "/workspace", {
          onStdout: (data) => write({ type: "stdout", data }),
          onStderr: (data) => write({ type: "stderr", data }),
        });
        write({ type: "exit", exitCode });
      });
      res.end();
    } catch (err) {
      logError(
        log,
        "exec_scoutqa_error",
        err instanceof Error ? err.message : String(err),
        thorIds(req),
      );
      if (!res.headersSent) {
        res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
      } else {
        res.write(JSON.stringify({ type: "exit", exitCode: 1 } satisfies ExecStreamEvent) + "\n");
        res.end();
      }
    }
  });

  app.post("/exec/slack-post-message", async (req, res) => {
    const ids = thorIds(req);
    const parsedArgs = parseSlackPostMessageArgs(req.body?.args);
    try {
      const { cwd } = req.body ?? {};
      const execResult = await handleSlackPostMessage(
        { args: req.body?.args, stdin: req.body?.stdin, sessionId: ids.sessionId, cwd },
        {
          env:
            config.slackPostMessage?.env ??
            (envConfig
              ? {
                  SLACK_BOT_TOKEN: envConfig.slackBotToken,
                  SLACK_API_BASE_URL: envConfig.slackApiBaseUrl,
                }
              : undefined),
          ...config.slackPostMessage,
          logAliasError: (error, meta) => {
            logError(log, "slack_post_message_alias_error", error.message, meta);
            config.slackPostMessage?.logAliasError?.(error, meta);
          },
        },
      );

      logInfo(log, "exec_slack_post_message", {
        channel: "error" in parsedArgs ? undefined : parsedArgs.channel,
        hasThread: "error" in parsedArgs ? false : Boolean(parsedArgs.threadTs),
        exitCode: execResult.exitCode,
        ...ids,
      });
      res.status((execResult.exitCode ?? 0) === 0 ? 200 : 400).json(execResult);
    } catch (err) {
      logError(
        log,
        "exec_slack_post_message_error",
        err instanceof Error ? err.message : String(err),
        ids,
      );
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    }
  });

  app.post("/exec/sandbox", async (req, res) => {
    const writeNdjson = (chunk: ExecStreamEvent) => {
      res.write(JSON.stringify(chunk) + "\n");
    };

    try {
      const { args, cwd, mode: rawMode } = req.body ?? {};
      const mode = parseSandboxMode(rawMode);

      if (!mode) {
        res.status(400).json({
          stdout: "",
          stderr: "mode must be one of: exec, create, stop, list",
          exitCode: 1,
        });
        return;
      }

      if (mode !== "list") {
        const cwdError = validateSandboxCwd(cwd);
        if (cwdError) {
          res.status(400).json({ stdout: "", stderr: cwdError, exitCode: 1 });
          return;
        }
      }

      if (mode === "exec") {
        if (
          !Array.isArray(args) ||
          !args.every((arg) => typeof arg === "string") ||
          args.length === 0
        ) {
          res.status(400).json({
            stdout: "",
            stderr: "args must be a non-empty string array",
            exitCode: 1,
          });
          return;
        }

        // Block git — sandbox doesn't sync git state back, so
        // commits/branches made there would be silently lost.
        if (args[0] === "git") {
          res.status(400).json({
            stdout: "",
            stderr:
              "git commands cannot run in the sandbox — changes to git history are not synced back. Use the git command directly instead.",
            exitCode: 1,
          });
          return;
        }

        // Allow sh/bash only in the exact form: ["sh"|"bash", "-c"|"-lc", "<command>"].
        // prepareSandbox unwraps this into the outer login shell. Any other
        // form (extra flags, missing -c, bare sh/bash) would nest a child
        // shell that can't parse .profile or would hang on interactive mode.
        if (args[0] === "sh" || args[0] === "bash") {
          const isUnwrappable = (args[1] === "-c" || args[1] === "-lc") && args.length === 3;
          if (!isUnwrappable) {
            res.status(400).json({
              stdout: "",
              stderr: `Invalid shell invocation. Use: sandbox ${args[0]} -c '<command>'`,
              exitCode: 1,
            });
            return;
          }
        }
      }

      logInfo(log, "exec_sandbox", {
        mode,
        cwd: typeof cwd === "string" ? cwd : undefined,
        args: Array.isArray(args) ? args : undefined,
        ...thorIds(req),
      });

      if (mode === "list") {
        const sandboxes = await listSandboxes();
        const output = sandboxes.map((sandbox) => ({
          id: sandbox.id,
          name: sandbox.name,
          cwd: sandbox.labels?.[THOR_CWD_LABEL] || "",
          sha: sandbox.labels?.[THOR_SHA_LABEL] || "",
        }));

        res.json({ stdout: JSON.stringify(output, null, 2), stderr: "", exitCode: 0 });
        return;
      }

      // Resolve the worktree root for all sandbox operations — cwd may
      // be a subdirectory (e.g. /workspace/worktrees/repo/feat/auth/sub/path).
      const { root: worktreeRoot } = await resolveWorktreeRoot(cwd);

      if (mode === "stop") {
        const sandbox = await findSandboxForCwd(worktreeRoot);
        if (sandbox) {
          await deleteSandbox(sandbox.id);
        }
        res.json({ stdout: "", stderr: "", exitCode: 0 });
        return;
      }

      const result = await prepareSandbox(cwd, mode, args);

      if (mode === "create") {
        res.json({ stdout: `${result.sandboxId}\n`, stderr: "", exitCode: 0 });
        return;
      }

      // Streaming exec runs outside the lock — parallel commands are OK.
      // Known limitation: parallel execs share one sandbox filesystem, so
      // concurrent writes to the same file produce last-writer-wins pull results.
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Transfer-Encoding", "chunked");
      res.flushHeaders();

      await withNdjsonHeartbeat(writeNdjson, async () => {
        const exitCode = await execInSandboxStream(result.sandboxId, result.command, {
          onStdout: (chunk) => writeNdjson({ type: "stdout", data: chunk }),
          onStderr: (chunk) => writeNdjson({ type: "stderr", data: chunk }),
        });
        let finalExitCode = exitCode;

        // Pull changes back only on success — failed commands may leave partial artifacts
        if (exitCode === 0) {
          try {
            const pull = await withCwdLock(worktreeRoot, () =>
              pullSandboxChanges(result.sandboxId, worktreeRoot),
            );
            if (pull.pulled.length > 0 || pull.deleted.length > 0) {
              logInfo(log, "sandbox_pull", {
                pulled: pull.pulled,
                deleted: pull.deleted,
                cwd: worktreeRoot,
              });
            }
          } catch (pullErr) {
            const error =
              pullErr instanceof SandboxError
                ? pullErr
                : new SandboxError(
                    "Failed to pull sandbox changes back to the worktree",
                    String(pullErr),
                  );
            logError(log, "sandbox_pull_error", error.adminDetail, thorIds(req));
            writeNdjson({ type: "stderr", data: `${error.userMessage}\n` });
            finalExitCode = 1;
          }
        }

        writeNdjson({ type: "exit", exitCode: finalExitCode });
      });
      res.end();
    } catch (err) {
      const error =
        err instanceof SandboxError ? err : new SandboxError("Sandbox service error", String(err));
      logError(log, "exec_sandbox_error", error.adminDetail, thorIds(req));

      if (!res.headersSent) {
        res.status(500).json({ stdout: "", stderr: error.userMessage, exitCode: 1 });
      } else {
        writeNdjson({ type: "stderr", data: `${error.userMessage}\n` });
        writeNdjson({ type: "exit", exitCode: 1 });
        res.end();
      }
    }
  });

  app.post("/exec/langfuse", async (req, res) => {
    try {
      const { args } = req.body ?? {};

      const argsError = validateLangfuseArgs(args);
      if (argsError) {
        res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
        return;
      }

      const action = args[2];
      const needsJson = action === "list" || action === "get";
      const finalArgs = !needsJson || args.includes("--json") ? args : [...args, "--json"];

      logInfo(log, "exec_langfuse", { args: finalArgs, ...thorIds(req) });
      const result = await execCommand("langfuse", finalArgs, "/workspace");
      res.json(result);
    } catch (err) {
      logError(
        log,
        "exec_langfuse_error",
        err instanceof Error ? err.message : String(err),
        thorIds(req),
      );
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    }
  });

  app.post("/exec/ldcli", async (req, res) => {
    try {
      const { args } = req.body ?? {};

      const argsError = validateLdcliArgs(args);
      if (argsError) {
        res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
        return;
      }

      const finalArgs = hasLdcliOutputOverride(args) ? args : [...args, "--output", "json"];

      logInfo(log, "exec_ldcli", { args: finalArgs, ...thorIds(req) });
      const result = await execCommand("ldcli", finalArgs, "/workspace", {
        env: {
          LD_ACCESS_TOKEN: process.env.LD_ACCESS_TOKEN,
          LD_BASE_URI: process.env.LD_BASE_URI,
          LD_PROJECT: process.env.LD_PROJECT,
          LD_ENVIRONMENT: process.env.LD_ENVIRONMENT,
        },
        maxBuffer: LDCLI_MAX_OUTPUT,
      });
      res.json(result);
    } catch (err) {
      logError(
        log,
        "exec_ldcli_error",
        err instanceof Error ? err.message : String(err),
        thorIds(req),
      );
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    }
  });

  app.post("/exec/gws", async (req, res) => {
    const parsed = parseGwsArgs(req.body?.args);
    const ids = thorIds(req);
    if (!parsed.ok) {
      logInfo(log, "exec_gws_invalid_args", { reason: parsed.error._tag, ...ids });
      res.status(400).json({ stdout: "", stderr: `${parsed.error.message}\n`, exitCode: 1 });
      return;
    }
    if (!gwsOAuth.setupStatus().configured) {
      logInfo(log, "exec_gws_oauth_setup_required", { ...gwsOAuth.setupStatus(), ...ids });
      res.status(503).json({
        stdout: "",
        stderr:
          "Google Workspace OAuth setup is incomplete or invalid. No authorization DM was sent. Ask the operator to check Google Workspace setup diagnostics.\n",
        exitCode: 2,
      });
      return;
    }
    const activeUser = gwsIdentity.resolveActiveRequester(ids.sessionId);
    if (!activeUser.ok) {
      logInfo(log, "exec_gws_identity_rejected", { reason: activeUser.reason, ...ids });
      res.status(403).json({
        stdout: "",
        stderr: gwsIdentityDenialMessage(activeUser.reason),
        exitCode: 1,
      });
      return;
    }

    const connected = gwsOAuth.findConnectedIdentity(
      activeUser.slackUserId,
      activeUser.googleEmailPin,
    );
    if (!connected.ok) {
      if (connected.error.code !== "connection_missing") {
        logInfo(log, "exec_gws_connection_rejected", {
          stage: connected.error.stage,
          code: connected.error.code,
          slack: activeUser.slackUserId,
          ...ids,
        });
        res.status(503).json({
          stdout: "",
          stderr:
            "Google Workspace user OAuth is unavailable; ask an operator to check configuration.\n",
          exitCode: 2,
        });
        return;
      }
      const request = gwsOAuth.createConnectionRequest({
        slackUserId: activeUser.slackUserId,
        expectedGoogleEmail: activeUser.googleEmailPin,
        sessionId: activeUser.sessionId,
        anchorId: activeUser.anchorId,
        triggerId: activeUser.triggerId,
      });
      if (!request.ok) {
        logInfo(log, "exec_gws_connection_request_failed", {
          stage: request.error.stage,
          code: request.error.code,
          slack: activeUser.slackUserId,
          ...ids,
        });
        res.status(503).json({
          stdout: "",
          stderr:
            "Google Workspace user OAuth is unavailable; ask an operator to check configuration.\n",
          exitCode: 2,
        });
        return;
      }
      const slackPost = await postSlackMessageApi(
        {
          channel: activeUser.slackUserId,
          text: `Connect your Google Workspace account to Thor. This single-use link expires in 10 minutes: <${request.value.connectUrl}|Connect Google Workspace>`,
        },
        gwsSlackTransport,
      );
      if ("error" in slackPost) {
        logInfo(log, "exec_gws_connection_notification_failed", {
          slack: activeUser.slackUserId,
          reason: "slack_post_failed",
          ...ids,
        });
        res.status(503).json({
          stdout: "",
          stderr:
            "Google Workspace connection is required, but private OAuth DM delivery could not be confirmed. Do not assume a link was sent; ask the operator to check Slack DM permissions and the app's Messages tab.\n",
          exitCode: 2,
        });
        return;
      }
      if (!slackPost.channel.startsWith("D")) {
        logInfo(log, "exec_gws_connection_dm_unconfirmed", {
          slack: activeUser.slackUserId,
          ...ids,
        });
        res.status(502).json({
          stdout: "",
          stderr:
            "Google Workspace could not confirm delivery to a private Slack DM. Do not assume a link was sent; ask the operator to check Slack DM configuration.\n",
          exitCode: 2,
        });
        return;
      }
      logInfo(log, "exec_gws_connection_requested", {
        slack: activeUser.slackUserId,
        ...ids,
      });
      res.status(428).json({
        stdout: "",
        stderr:
          "Google Workspace connection is required. A private authorization link was sent to the requesting Slack user; retry after connecting.\n",
        exitCode: 2,
      });
      return;
    }

    const commandFingerprint = gwsOAuth.fingerprintCommand(parsed.args);
    if (!commandFingerprint.ok) {
      res.status(503).json({
        stdout: "",
        stderr: "Google Workspace command binding is unavailable.\n",
        exitCode: 1,
      });
      return;
    }
    const approvalArgs = {
      operation: summarizeGwsOperation(parsed.args),
      argument_count: parsed.args.length,
      command_fingerprint: commandFingerprint.value,
      google_workspace_email: connected.value.googleEmail,
      slack_user_id: activeUser.slackUserId,
      connection_id: connected.value.connectionId,
    };
    const approvalEvent = ApprovalRequiredEventPayloadSchema.safeParse({
      type: "approval_required",
      actionId: "_pending",
      proxyName: "gws",
      tool: "google_workspace_command",
      args: approvalArgs,
    });
    if (!approvalEvent.success || !ids.sessionId) {
      res.status(400).json({
        stdout: "",
        stderr: "Google Workspace approval request is invalid.\n",
        exitCode: 1,
      });
      return;
    }
    const slackTarget = resolveSlackThreadTargetFromTrigger(ids.sessionId);
    if ("error" in slackTarget) {
      res.status(403).json({
        stdout: "",
        stderr: "Google Workspace approval requires an active Slack thread.\n",
        exitCode: 1,
      });
      return;
    }
    const action = gwsApprovalStore.buildPending(
      "google_workspace_command",
      approvalArgs,
      {
        sessionId: ids.sessionId,
        trigger: { anchorId: activeUser.anchorId, triggerId: activeUser.triggerId },
      },
      {
        provider: "slack",
        channel: slackTarget.channel,
        threadTs: slackTarget.threadTs,
      },
    );
    const storedCommand = gwsOAuth.storePendingCommand({
      actionId: action.id,
      args: parsed.args,
      slackUserId: activeUser.slackUserId,
      expectedGoogleEmail: connected.value.googleEmail,
      sessionId: activeUser.sessionId,
      anchorId: activeUser.anchorId,
      triggerId: activeUser.triggerId,
    });
    if (!storedCommand.ok) {
      res.status(503).json({
        stdout: "",
        stderr: "Google Workspace approval could not be stored.\n",
        exitCode: 1,
      });
      return;
    }
    try {
      gwsApprovalStore.update(action);
    } catch {
      res.status(503).json({
        stdout: "",
        stderr: "Google Workspace approval could not be stored.\n",
        exitCode: 1,
      });
      return;
    }
    const approvalMessage = buildApprovalSlackMessage({
      actionId: action.id,
      tool: "google_workspace_command",
      args: approvalArgs,
      upstreamName: "gws",
      threadTs: slackTarget.threadTs,
    });
    const slackPost = await postSlackMessageApi(
      {
        channel: slackTarget.channel,
        threadTs: slackTarget.threadTs,
        text: approvalMessage.text,
        blocks: approvalMessage.blocks,
      },
      gwsSlackTransport,
    );
    if ("error" in slackPost) {
      gwsApprovalStore.rejectLoaded(action, "system", "slack_post_failed");
      res.status(503).json({
        stdout: "",
        stderr: "Google Workspace approval could not be posted to Slack.\n",
        exitCode: 1,
      });
      return;
    }
    action.notification = {
      provider: "slack",
      channel: slackTarget.channel,
      threadTs: slackTarget.threadTs,
      messageTs: slackPost.ts,
      postedAt: new Date().toISOString(),
    };
    try {
      gwsApprovalStore.update(action);
    } catch {
      logInfo(log, "exec_gws_notification_metadata_failed", {
        actionId: action.id,
        slack: activeUser.slackUserId,
        ...ids,
      });
    }
    logInfo(log, "exec_gws_pending_approval", {
      actionId: action.id,
      operation: approvalArgs.operation,
      argc: approvalArgs.argument_count,
      commandFingerprint: approvalArgs.command_fingerprint,
      slack: activeUser.slackUserId,
      googleEmail: connected.value.googleEmail,
      connectionId: connected.value.connectionId,
      ...ids,
    });
    res.json({
      stdout: `${JSON.stringify(
        {
          ...approvalEvent.data,
          actionId: action.id,
          command: `approval status ${action.id}`,
        },
        null,
        2,
      )}\n`,
      stderr: "",
      exitCode: 0,
    });
  });

  app.post("/exec/metabase", async (req, res) => {
    try {
      const { args } = req.body ?? {};

      const argsError = validateMetabaseArgs(args);
      if (argsError) {
        res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
        return;
      }

      const subcommand = args[0];
      logInfo(log, "exec_metabase", {
        subcommand,
        ...(subcommand !== "query" && args[1] ? { schema: args[1] } : {}),
        ...thorIds(req),
      });

      let result: unknown;

      switch (subcommand) {
        case "schemas":
          result = await listSchemas();
          break;
        case "tables":
          result = await listTables(args[1]);
          break;
        case "columns":
          result = await getColumns(args[1], args[2]);
          break;
        case "query":
          result = await executeQuery(args[1]);
          break;
        case "question":
          result = await getQuestion(args[1]);
          break;
      }

      res.json({ stdout: JSON.stringify(result, null, 2), stderr: "", exitCode: 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(log, "exec_metabase_error", message, thorIds(req));
      res.status(500).json({ stdout: "", stderr: message, exitCode: 1 });
    }
  });

  app.post("/exec/drata", async (req, res) => {
    const parsed = parseDrataArgs(req.body?.args);
    if (!parsed.ok) {
      res.status(400).json({ stdout: "", stderr: parsed.error.message, exitCode: 1 });
      return;
    }
    if (parsed.command.kind === "help") {
      res.json({
        stdout:
          "Usage: drata api METHOD /path [--json JSON]\nPermissions are enforced by the Drata API identity.\n",
        stderr: "",
        exitCode: 0,
      });
      return;
    }
    const request = parsed.command.request;
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
      request.method,
    )
      ? request.method
      : "custom";
    const fields = { method, ...thorIds(req) };
    try {
      const result = await drata.execute(request);
      if (!result.ok) {
        logInfo(log, "exec_drata_error", {
          ...fields,
          errorTag: result.error._tag,
          stage: result.error.stage,
          status: result.error.httpStatus,
        });
        res
          .status(result.error.stage === "configuration" ? 503 : 502)
          .json({ stdout: "", stderr: result.error.message, exitCode: 1 });
        return;
      }
      const succeeded = result.value.status >= 200 && result.value.status < 300;
      logInfo(log, "exec_drata", { ...fields, status: result.value.status });
      res.json({
        stdout: JSON.stringify(result.value.body, null, 2),
        stderr: succeeded ? "" : `Drata API returned HTTP ${result.value.status}`,
        exitCode: succeeded ? 0 : 1,
      });
    } catch {
      logError(log, "exec_drata_error", "Unexpected Drata execution failure", fields);
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    }
  });

  app.post("/exec/mcp", async (req, res) => {
    try {
      const args = parseArgs(req.body);
      if (!args) {
        res.status(400).json({ stdout: "", stderr: "args must be a string array", exitCode: 1 });
        return;
      }

      if (args[0] === "resolve") {
        const providedSecret = getInternalSecretHeader(req);
        if (!matchesInternalSecret(internalSecret, providedSecret)) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
      }

      const result = await mcpService.executeMcp(args, {
        directory: typeof req.body?.directory === "string" ? req.body.directory : undefined,
        ...thorIds(req),
      });

      res.json(result);
    } catch (err) {
      logError(
        log,
        "exec_mcp_error",
        err instanceof Error ? err.message : String(err),
        thorIds(req),
      );
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    }
  });

  app.post("/internal/exec", async (req, res) => {
    const providedSecret = getInternalSecretHeader(req);
    if (!matchesInternalSecret(internalSecret, providedSecret)) {
      res.status(401).json({ stdout: "", stderr: "Unauthorized", exitCode: 1 });
      return;
    }

    const { bin, args, cwd } = req.body ?? {};
    if (typeof bin !== "string" || !bin.trim()) {
      res.status(400).json({ stdout: "", stderr: "bin must be a non-empty string", exitCode: 1 });
      return;
    }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      res.status(400).json({ stdout: "", stderr: "args must be a string array", exitCode: 1 });
      return;
    }
    if (typeof cwd !== "string" || !cwd.trim()) {
      res.status(400).json({ stdout: "", stderr: "cwd must be a non-empty string", exitCode: 1 });
      return;
    }

    const startedAt = Date.now();
    try {
      const result = await execCommand(bin, args, cwd, {
        maxBuffer: INTERNAL_EXEC_MAX_OUTPUT,
      });
      logInfo(log, "internal_exec", {
        bin,
        argc: args.length,
        cwd,
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
        ...thorIds(req),
      });
      res.json(result);
    } catch (err) {
      logError(log, "internal_exec_error", err instanceof Error ? err.message : String(err), {
        bin,
        argc: args.length,
        cwd,
        durationMs: Date.now() - startedAt,
        ...thorIds(req),
      });
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    }
  });

  app.post("/exec/approval", async (req, res) => {
    try {
      const args = parseArgs(req.body);
      if (!args) {
        res.status(400).json({ stdout: "", stderr: "args must be a string array", exitCode: 1 });
        return;
      }

      const result = await mcpService.executeApproval(args, thorIds(req));
      res.json(result);
    } catch (err) {
      logError(
        log,
        "exec_approval_error",
        err instanceof Error ? err.message : String(err),
        thorIds(req),
      );
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    }
  });

  return {
    app,
    warmUp: () => mcpService.warmUpstreams(),
    close: () => mcpService.closeAll(),
  };
}

function hasLdcliOutputOverride(args: string[]): boolean {
  return args.some((arg, index) => {
    if (arg === "--json" || arg.startsWith("--output=")) {
      return true;
    }

    return arg === "--output" && Boolean(args[index + 1]);
  });
}

export async function startRemoteCliServer(): Promise<void> {
  const envConfig = loadRemoteCliEnv();
  const gitIdentity = deriveBotGitIdentity();
  const remoteCli = createRemoteCliApp({ env: envConfig });
  logInfo(log, "remote_cli_starting", {
    port: envConfig.port,
    gitIdentityName: gitIdentity.name,
    gitIdentityEmail: gitIdentity.email,
  });
  const server = remoteCli.app.listen(envConfig.port, () => {
    logInfo(log, "remote_cli_listening", { port: envConfig.port });
  });

  void remoteCli.warmUp();

  const shutdown = async () => {
    logInfo(log, "remote_cli_shutting_down");
    await remoteCli.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startRemoteCliServer().catch((err) => {
    logError(log, "remote_cli_start_failed", err);
    process.exit(1);
  });
}
