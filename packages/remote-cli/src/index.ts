import express, { type Express } from "express";
import { access } from "node:fs/promises";
import { dirname, normalize as normalizePosix } from "node:path/posix";
import { fileURLToPath } from "node:url";
import {
  createConfigLoader,
  createLogger,
  errorMessage,
  logError,
  logInfo,
  logWarn,
  loadRemoteCliAppEnv,
  loadRemoteCliEnv,
  loadRemoteCliGitHubEnv,
  loadRemoteCliInternalEnv,
  matchesInternalSecret,
  resolvePsqlDatabases,
  resolveStrictProfileForSession,
  WORKSPACE_CONFIG_PATH,
  type ExecStreamEvent,
  type ConfigLoader,
} from "@thor/common";
import { execCommand, execCommandStream } from "./exec.ts";
import { createMcpService, type McpServiceDeps } from "./mcp-handler.ts";
import { createApprovalService } from "./approval-service.ts";
import {
  getCliApprovalDefinition,
  registerCliApprovals,
  requestCliApproval,
} from "./cli-approval.ts";
import { registerGitCorrelationAlias } from "./gh-issue-alias.js";
import {
  handleSlackPostMessage,
  parseSlackPostMessageArgs,
  type SlackPostMessageDeps,
} from "./slack-post-message.ts";
import {
  listSchemas,
  listTables,
  getColumns,
  executeQuery,
  getQuestion,
  MetabaseError,
} from "./metabase.ts";
import {
  createSandbox,
  deleteSandbox,
  execInSandboxStream,
  findSandboxForCwd,
  getLastSyncedSha,
  listSandboxes,
  overlayDirtyFiles,
  pullSandboxChanges,
  shellQuote,
  syncSandbox,
  withCwdLock,
  THOR_CWD_LABEL,
  THOR_MANAGED_LABEL,
  THOR_SHA_LABEL,
} from "./sandbox.ts";
import {
  awsCommandRequiresApproval,
  parsePsqlInvocation,
  resolveGitArgs,
  validateAwsArgs,
  validateCwd,
  validateGhArgs,
  validateLdcliArgs,
  validateMetabaseArgs,
  validateScoutqaArgs,
} from "./policy.ts";
import {
  isGhHelpRequest,
  usesBodyFileStdin,
  withGhAttribution,
  withGhStdinDisclaimer,
  withGitAttribution,
} from "./gh-args.ts";

const log = createLogger("remote-cli");

const LDCLI_MAX_OUTPUT = 1024 * 1024;
const WORKTREE_ROOT = "/workspace/worktrees";
const WORKTREE_PREFIX = `${WORKTREE_ROOT}/`;
const INTERNAL_SECRET_HEADER = "x-thor-internal-secret";
const INTERNAL_EXEC_MAX_OUTPUT = 1024 * 1024;

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

type NdjsonWrite = (chunk: ExecStreamEvent) => void;

async function streamNdjsonResponse(
  res: express.Response,
  onError: (err: unknown) => void,
  fn: (write: NdjsonWrite) => Promise<void>,
): Promise<void> {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders();

  const write: NdjsonWrite = (chunk) => {
    res.write(JSON.stringify(chunk) + "\n");
  };

  try {
    await withNdjsonHeartbeat(write, () => fn(write));
  } catch (err) {
    try {
      onError(err);
    } catch {
      // Logging/telemetry failures must not break the NDJSON response shape.
    }
    write({ type: "stderr", data: `${errorMessage(err)}\n` });
    write({ type: "exit", exitCode: 1 });
  } finally {
    res.end();
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
    throw new Error(`git rev-parse --show-toplevel failed for ${cwd}`);
  }
  const root = result.stdout.trim();
  if (!isValidWorktreeTopLevel(root)) {
    throw new Error(`git toplevel is not a valid worktree path: ${root}`);
  }

  const containingRoot = await findContainingWorktreeRoot(root);
  if (containingRoot) {
    throw new Error(
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
    throw new Error(`git rev-parse HEAD failed: ${gitSha.stderr || gitSha.stdout}`);
  }
  const sha = gitSha.stdout.trim();
  if (!sha) {
    throw new Error("git rev-parse HEAD returned empty SHA");
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
  const appEnv = config.appEnv ?? loadRemoteCliAppEnv();
  const envConfig = config.env;
  const internalSecret = appEnv.thorInternalSecret;
  const getConfig = config.configLoader ?? createConfigLoader(WORKSPACE_CONFIG_PATH);
  const mcpConfig: McpServiceDeps = {
    isProduction: appEnv.isProduction,
    ...config.mcp,
    configLoader: config.mcp?.configLoader ?? getConfig,
    slack: config.mcp?.slack ?? {
      botToken: envConfig?.slackBotToken,
      apiBaseUrl: envConfig?.slackApiBaseUrl,
    },
  };
  // The approval engine is a registry owned here at the composition root; the
  // MCP service and CLI approvals register their stores into it.
  const approvalService = createApprovalService({
    ...(mcpConfig.approvalsDir ? { approvalsDir: mcpConfig.approvalsDir } : {}),
    ...(mcpConfig.writeToolCallLogFn ? { writeToolCallLogFn: mcpConfig.writeToolCallLogFn } : {}),
    ...(mcpConfig.slack ? { slack: mcpConfig.slack } : {}),
    ...(mcpConfig.fetchImpl ? { fetchImpl: mcpConfig.fetchImpl } : {}),
  });
  const mcpService = createMcpService(mcpConfig, approvalService);
  registerCliApprovals(approvalService, execCommand, { getConfig });

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
      logError(log, "exec_git_error", errorMessage(err), thorIds(req));
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
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

      // issue create is approval-gated: store raw args and inject the footer +
      // assignee at execution time so the approval card shows only the raw command.
      if (args[0] === "issue" && args[1] === "create" && !isGhHelpRequest(args)) {
        const requestStdin = typeof req.body?.stdin === "string" ? req.body.stdin : undefined;
        if (usesBodyFileStdin(args) && requestStdin === undefined) {
          res.status(400).json({
            stdout: "",
            stderr: "Disclaimer required: gh stdin body is missing",
            exitCode: 1,
          });
          return;
        }
        logInfo(log, "exec_gh_pending_approval", { args, cwd, ...ids });
        const result = await requestCliApproval(approvalService, getCliApprovalDefinition("gh"), {
          cwd,
          args,
          stdin: requestStdin,
          ...ids,
        });
        res.status(result.exitCode === 0 ? 200 : 400).json(result);
        return;
      }

      // Other mutating gh commands run immediately, so inject up front.
      const stdinBody = usesBodyFileStdin(args)
        ? withGhStdinDisclaimer(req.body?.stdin, ids.sessionId)
        : undefined;
      if (stdinBody && typeof stdinBody !== "string") {
        res.status(400).json({ stdout: "", stderr: stdinBody.error, exitCode: 1 });
        return;
      }
      const effectiveArgs = withGhAttribution(args, ids.sessionId, getConfig);

      logInfo(log, "exec_gh", { args: effectiveArgs, cwd, ...ids });
      const result = await execCommand("gh", effectiveArgs, cwd, {
        ...(stdinBody !== undefined ? { stdin: stdinBody } : {}),
      });
      res.json(result);
    } catch (err) {
      logError(log, "exec_gh_error", errorMessage(err), thorIds(req));
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
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

      await streamNdjsonResponse(
        res,
        (err) => {
          logError(log, "exec_scoutqa_error", errorMessage(err), thorIds(req));
        },
        async (write) => {
          const exitCode = await execCommandStream("scoutqa", args, "/workspace", {
            onStdout: (data) => write({ type: "stdout", data }),
            onStderr: (data) => write({ type: "stderr", data }),
          });
          write({ type: "exit", exitCode });
        },
      );
    } catch (err) {
      logError(log, "exec_scoutqa_error", errorMessage(err), thorIds(req));
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
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
      logError(log, "exec_slack_post_message_error", errorMessage(err), ids);
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
    }
  });

  app.post("/exec/sandbox", async (req, res) => {
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
      await streamNdjsonResponse(
        res,
        (err) => {
          logError(log, "exec_sandbox_error", errorMessage(err), thorIds(req));
        },
        async (writeNdjson) => {
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
              const message = errorMessage(pullErr);
              logError(log, "sandbox_pull_error", message, thorIds(req));
              writeNdjson({ type: "stderr", data: `${message}\n` });
              finalExitCode = 1;
            }
          }

          writeNdjson({ type: "exit", exitCode: finalExitCode });
        },
      );
    } catch (err) {
      const message = errorMessage(err);
      logError(log, "exec_sandbox_error", message, thorIds(req));

      res.status(500).json({ stdout: "", stderr: message, exitCode: 1 });
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
      logError(log, "exec_ldcli_error", errorMessage(err), thorIds(req));
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
    }
  });

  app.post("/exec/aws", async (req, res) => {
    try {
      const { args, cwd } = req.body ?? {};

      const cwdError = validateCwd(cwd);
      if (cwdError) {
        res.status(400).json({ stdout: "", stderr: cwdError, exitCode: 1 });
        return;
      }

      const argsError = validateAwsArgs(args);
      if (argsError) {
        res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
        return;
      }

      const ids = thorIds(req);

      // Mutating ("write-alike") aws commands are gated behind human approval;
      // the approved command runs verbatim from the stored action. Read-only
      // commands run immediately below.
      if (awsCommandRequiresApproval(args)) {
        logInfo(log, "exec_aws_pending_approval", { args, cwd, ...ids });
        const result = await requestCliApproval(approvalService, getCliApprovalDefinition("aws"), {
          cwd,
          args,
          ...ids,
        });
        res.status(result.exitCode === 0 ? 200 : 400).json(result);
        return;
      }

      logInfo(log, "exec_aws", { args, cwd, ...ids });
      // aws inherits the container's AWS credential chain (IAM role / AWS_* env).
      // AWS_PAGER="" disables the v2 pager — output is captured non-interactively,
      // and the container has no pager (`less`) to redirect to.
      const result = await execCommand("aws", args, cwd, { env: { AWS_PAGER: "" } });
      res.json(result);
    } catch (err) {
      logError(log, "exec_aws_error", errorMessage(err), thorIds(req));
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
    }
  });

  app.post("/exec/psql", async (req, res) => {
    try {
      const { args, cwd } = req.body ?? {};

      const cwdError = validateCwd(cwd);
      if (cwdError) {
        res.status(400).json({ stdout: "", stderr: cwdError, exitCode: 1 });
        return;
      }

      const parsed = parsePsqlInvocation(args);
      if ("error" in parsed) {
        res.status(400).json({ stdout: "", stderr: parsed.error, exitCode: 1 });
        return;
      }

      const ids = thorIds(req);

      // The session's profile selects which credential bundle applies. Fail
      // closed on a profile conflict (one anchor bound to disagreeing profiles)
      // rather than guessing which credentials to use.
      const resolution = resolveStrictProfileForSession(getConfig(), ids.sessionId ?? "");
      if (!resolution.ok) {
        res.status(400).json({
          stdout: "",
          stderr: `psql access unavailable: ${resolution.error}`,
          exitCode: 1,
        });
        return;
      }
      const profile = resolution.profile;

      let targets: ReturnType<typeof resolvePsqlDatabases>;
      try {
        targets = resolvePsqlDatabases(profile);
      } catch (err) {
        // Malformed operator bundle — fail closed. The message names the env
        // var and field, never a credential value.
        logError(log, "exec_psql_config_error", errorMessage(err), ids);
        res.status(400).json({
          stdout: "",
          stderr: `psql configuration error: ${errorMessage(err)}`,
          exitCode: 1,
        });
        return;
      }

      const target = targets.get(parsed.alias);
      if (!target) {
        const available = [...targets.keys()].sort();
        res.status(400).json({
          stdout: "",
          stderr: `unknown database alias "${parsed.alias}". Available: ${
            available.length ? available.join(", ") : "(none configured)"
          }`,
          exitCode: 1,
        });
        return;
      }

      logInfo(log, "exec_psql", {
        alias: parsed.alias,
        database: target.database,
        argc: parsed.passthroughArgs.length,
        cwd,
        ...(profile ? { profile } : {}),
        ...ids,
      });

      // Connection + credentials go through PG* env, never argv, so the
      // password never lands in /proc/<pid>/cmdline. PGOPTIONS forces every
      // transaction read-only as defense-in-depth on top of the read-only DB
      // role. -X skips ~/.psqlrc; -w never prompts (creds come from PGPASSWORD).
      const result = await execCommand(
        "psql",
        ["-X", "-w", "-v", "ON_ERROR_STOP=1", ...parsed.passthroughArgs],
        cwd,
        {
          // Close stdin (EOF) so an invocation without -c/-f exits immediately
          // instead of blocking on psql's interactive stdin read — the client
          // never pipes stdin to this endpoint.
          stdin: "",
          env: {
            PGHOST: target.host,
            PGPORT: String(target.port),
            PGDATABASE: target.database,
            PGUSER: target.username,
            PGPASSWORD: target.password,
            PGSSLMODE: target.sslmode,
            PGOPTIONS: "-c default_transaction_read_only=on",
            // Defense-in-depth: if a psql shell meta-command (\!) ever slips
            // past the arg allowlist, give it no usable shell to run.
            SHELL: "/bin/false",
          },
        },
      );
      res.json(result);
    } catch (err) {
      logError(log, "exec_psql_error", errorMessage(err), thorIds(req));
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
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
      const message = errorMessage(err);
      const { args } = req.body ?? {};
      const subcommand = Array.isArray(args) ? args[0] : undefined;
      if (err instanceof MetabaseError && err.userFailure) {
        logWarn(log, "exec_metabase_query_failure", {
          category: "metabase_query_failure",
          subcommand,
          error: message,
          ...thorIds(req),
        });
        res.json({ stdout: "", stderr: message, exitCode: 1 });
        return;
      }
      logError(log, "exec_metabase_error", message, { subcommand, ...thorIds(req) });
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

      const result = await mcpService.executeMcp(args, thorIds(req));

      res.json(result);
    } catch (err) {
      logError(log, "exec_mcp_error", errorMessage(err), thorIds(req));
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
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
      logError(log, "internal_exec_error", errorMessage(err), {
        bin,
        argc: args.length,
        cwd,
        durationMs: Date.now() - startedAt,
        ...thorIds(req),
      });
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
    }
  });

  app.post("/exec/approval", async (req, res) => {
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

      const result = await approvalService.executeApproval(args);
      res.json(result);
    } catch (err) {
      logError(log, "exec_approval_error", errorMessage(err), thorIds(req));
      res.status(500).json({ stdout: "", stderr: errorMessage(err), exitCode: 1 });
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
