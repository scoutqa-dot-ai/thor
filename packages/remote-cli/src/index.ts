import express, { type Express } from "express";
import { access } from "node:fs/promises";
import { dirname, normalize as normalizePosix } from "node:path/posix";
import { fileURLToPath } from "node:url";
import {
  appendCorrelationAlias,
  buildThorDisclaimerForSession,
  computeGitCorrelationKey,
  createConfigLoader,
  createLogger,
  getRunnerBaseUrl,
  logError,
  logInfo,
  loadRemoteCliAppEnv,
  loadRemoteCliEnv,
  loadRemoteCliGitHubEnv,
  loadRemoteCliInternalEnv,
  matchesInternalSecret,
  type ConfigLoader,
  type ExecStreamEvent,
  WORKSPACE_CONFIG_PATH,
} from "@thor/common";
import { execCommand, execCommandStream } from "./exec.js";
import { resolveOwnerRepoFromRemote } from "./github-app-auth.js";
import { createMcpService, type McpServiceDeps } from "./mcp-handler.js";
import {
  handleSlackPostMessage,
  parseSlackPostMessageArgs,
  type SlackPostMessageDeps,
} from "./slack-post-message.js";
import { listSchemas, listTables, getColumns, executeQuery, getQuestion } from "./metabase.js";
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

const log = createLogger("remote-cli");

const LDCLI_MAX_OUTPUT = 1024 * 1024;
const WORKTREE_ROOT = "/workspace/worktrees";
const WORKTREE_PREFIX = `${WORKTREE_ROOT}/`;
const INTERNAL_SECRET_HEADER = "x-thor-internal-secret";
const INTERNAL_EXEC_MAX_OUTPUT = 1024 * 1024;
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
  getConfig?: ConfigLoader;
  appEnv?: ReturnType<typeof loadRemoteCliAppEnv>;
  env?: ReturnType<typeof loadRemoteCliEnv>;
  mcp?: Omit<McpServiceDeps, "getConfig">;
  slackPostMessage?: SlackPostMessageDeps;
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

  const result = appendCorrelationAlias(sessionId, correlationKey);
  if (!result.ok) {
    logError(log, "alias_registration_error", result.error.message, { sessionId, correlationKey });
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

function parseIssueCommentCorrelationKey(
  args: string[],
  cwd: string,
  stdout: string,
): string | undefined {
  if (args[0] !== "issue" || args[1] !== "comment") return undefined;
  const number = args[2];
  if (!number) return undefined;

  const cwdRepo = resolveOwnerRepoFromRemote(cwd);
  if (cwdRepo?.host === "github.com") {
    return buildIssueCorrelationKey(cwdRepo.owner, cwdRepo.repo, number);
  }

  const issue = parseIssueUrl(stdout);
  if (!issue || issue.number !== number) return undefined;
  return buildIssueCorrelationKey(issue.owner, issue.repo, issue.number);
}

function registerIssueCorrelationAlias(
  sessionId: string | undefined,
  args: string[],
  cwd: string,
  stdout: string,
): void {
  if (!sessionId || args[0] !== "issue") return;
  const correlationKey =
    args[1] === "create"
      ? parseCreatedIssueCorrelationKey(stdout, cwd)
      : parseIssueCommentCorrelationKey(args, cwd, stdout);
  if (!correlationKey) return;
  const result = appendCorrelationAlias(sessionId, correlationKey);
  if (!result.ok) {
    logError(log, "alias_registration_error", result.error.message, { sessionId, correlationKey });
    return;
  }
  logInfo(log, "alias_registered", { sessionId, correlationKey, source: "gh" });
}

function rewriteSingleValueFlag(
  args: string[],
  names: string[],
  append: string,
  valuePrefix?: string,
): string[] | { error: string } {
  const out = [...args];
  let match: { index: number; valueIndex?: number; inlinePrefix?: string } | undefined;
  for (let i = 0; i < out.length; i++) {
    for (const name of names) {
      if (out[i] === name && i + 1 < out.length) {
        if (valuePrefix && !out[i + 1].startsWith(valuePrefix)) continue;
        if (match) return { error: "Disclaimer required: multiple mutable gh body fields" };
        match = { index: i, valueIndex: i + 1 };
        i += 1;
        break;
      }
      if (out[i].startsWith(`${name}=`)) {
        const value = out[i].slice(name.length + 1);
        if (valuePrefix && !value.startsWith(valuePrefix)) continue;
        if (match) return { error: "Disclaimer required: multiple mutable gh body fields" };
        match = { index: i, inlinePrefix: `${name}=` };
        break;
      }
    }
  }
  if (!match) return { error: "Disclaimer required: could not find a mutable gh body field" };
  if (match.valueIndex !== undefined) {
    out[match.valueIndex] = `${out[match.valueIndex]}${append}`;
  } else if (match.inlinePrefix) {
    out[match.index] =
      `${match.inlinePrefix}${out[match.index].slice(match.inlinePrefix.length)}${append}`;
  }
  return out;
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
  return args[0] === "api"
    ? rewriteSingleValueFlag(args, ["-f", "--raw-field"], footer, "body=")
    : rewriteSingleValueFlag(args, ["--body", "-b"], footer);
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

export function createRemoteCliApp(config: RemoteCliAppConfig = {}): RemoteCliApp {
  const getConfig = config.getConfig ?? createConfigLoader(WORKSPACE_CONFIG_PATH);
  const appEnv = config.appEnv ?? loadRemoteCliAppEnv();
  const internalSecret = appEnv.thorInternalSecret;
  const mcpService = createMcpService({
    getConfig,
    isProduction: appEnv.isProduction,
    ...config.mcp,
  });

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "remote-cli", mcp: mcpService.getHealth() });
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
      const effectiveArgs = gitResolution.args;
      const effectiveCwd = gitResolution.cwd ?? cwd;
      const effectiveCwdError = validateCwd(effectiveCwd);
      if (effectiveCwdError) {
        res.status(400).json({ stdout: "", stderr: effectiveCwdError, exitCode: 1 });
        return;
      }
      const ids = thorIds(req);

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
      const effectiveArgs = withGhDisclaimer(args, ids.sessionId);
      if (!Array.isArray(effectiveArgs)) {
        res.status(400).json({ stdout: "", stderr: effectiveArgs.error, exitCode: 1 });
        return;
      }

      logInfo(log, "exec_gh", { args: effectiveArgs, cwd, ...ids });
      const result = await execCommand("gh", effectiveArgs, cwd);
      if ((result.exitCode ?? 0) === 0) {
        registerIssueCorrelationAlias(ids.sessionId, effectiveArgs, cwd, result.stdout);
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
            (config.env ? { SLACK_BOT_TOKEN: config.env.slackBotToken } : undefined),
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

      const result = await mcpService.executeApproval(args);
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
    warmUp: () => mcpService.connectConfiguredUpstreams(),
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
