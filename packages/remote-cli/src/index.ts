import express, { type Express } from "express";
import { fileURLToPath } from "node:url";
import {
  computeGitAlias,
  createConfigLoader,
  createLogger,
  formatThorMeta,
  logError,
  logInfo,
  type ConfigLoader,
  WORKSPACE_CONFIG_PATH,
} from "@thor/common";
import { execCommand, execCommandStream } from "./exec.js";
import { createMcpService, type McpServiceDeps } from "./mcp-handler.js";
import { listSchemas, listTables, getColumns, executeQuery } from "./metabase.js";
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
  validateCwd,
  validateGitArgs,
  validateGhArgs,
  validateLdcliArgs,
  validateLangfuseArgs,
  validateMetabaseArgs,
  validateScoutqaArgs,
} from "./policy.js";

const log = createLogger("remote-cli");

const PORT = parseInt(process.env.PORT || "3004", 10);
const LDCLI_MAX_OUTPUT = 1024 * 1024;

export interface RemoteCliAppConfig {
  getConfig?: ConfigLoader;
  mcp?: Omit<McpServiceDeps, "getConfig">;
}

export interface RemoteCliApp {
  app: Express;
  warmUp(): Promise<void>;
  close(): Promise<void>;
}

function thorIds(req: express.Request): { sessionId?: string; callId?: string } {
  const sessionId = req.headers["x-thor-session-id"] as string | undefined;
  const callId = req.headers["x-thor-call-id"] as string | undefined;
  return {
    ...(sessionId && { sessionId }),
    ...(callId && { callId }),
  };
}

function parseArgs(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object" || !("args" in body)) return undefined;
  const args = (body as { args?: unknown }).args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    return undefined;
  }
  return args;
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
  // Use the full cwd path (unique per worktree) to avoid name collisions.
  // e.g. /workspace/worktrees/katalon-g5/fix-bug → thor-katalon-g5-fix-bug
  const segments = cwd.split("/").filter(Boolean);
  // Take the last two path segments for a readable name
  const slug = segments
    .slice(-2)
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

async function prepareSandbox(
  cwd: string,
  mode: "exec" | "create",
  args: string[],
): Promise<PreparedSandbox> {
  // Lock per-cwd: prevents duplicate sandbox creation (TOCTOU in
  // ensureSandbox) and conflicting syncs on the same worktree.
  // Released before streaming exec so commands run concurrently.
  return withCwdLock(cwd, async () => {
    const currentSha = await resolveHead(cwd);
    const sandbox = await ensureSandbox(cwd, currentSha);

    if (mode === "create") {
      return { sandboxId: sandbox.id, command: "" };
    }

    const lastSyncedSha = getLastSyncedSha(sandbox);
    if (lastSyncedSha !== currentSha) {
      await syncSandbox(sandbox.id, cwd, lastSyncedSha, currentSha);
    }

    const overlay = await overlayDirtyFiles(sandbox.id, cwd);
    if (overlay.pushed.length > 0 || overlay.deleted.length > 0) {
      logInfo(log, "sandbox_overlay_push", {
        pushed: overlay.pushed,
        deleted: overlay.deleted,
        cwd,
      });
    }

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
      return { sandboxId: sandbox.id, command: `bash -lc ${shellQuote(args[2])}` };
    }

    const command = args.map((a: string) => shellQuote(a)).join(" ");
    return { sandboxId: sandbox.id, command: `bash -lc ${shellQuote(command)}` };
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
  const mcpService = createMcpService({
    getConfig,
    resolveSecret: process.env.RESOLVE_SECRET || "",
    isProduction: process.env.NODE_ENV === "production",
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

      const argsError = validateGitArgs(args);
      if (argsError) {
        res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
        return;
      }

      logInfo(log, "exec_git", { args, cwd, ...thorIds(req) });
      const result = await execCommand("git", args, cwd);
      if ((result.exitCode ?? 0) === 0) {
        const alias = computeGitAlias("git", args, cwd);
        if (alias) result.stdout = (result.stdout || "") + formatThorMeta(alias);
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

      const argsError = validateGhArgs(args);
      if (argsError) {
        res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
        return;
      }

      logInfo(log, "exec_gh", { args, cwd, ...thorIds(req) });
      const result = await execCommand("gh", args, cwd);
      if ((result.exitCode ?? 0) === 0) {
        const alias = computeGitAlias("gh", args, cwd);
        if (alias) result.stdout = (result.stdout || "") + formatThorMeta(alias);
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

      const write = (obj: Record<string, unknown>) => {
        res.write(JSON.stringify(obj) + "\n");
      };

      const exitCode = await execCommandStream("scoutqa", args, "/workspace", {
        onStdout: (data) => write({ stream: "stdout", data }),
        onStderr: (data) => write({ stream: "stderr", data }),
      });

      write({ exitCode });
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
        res.write(JSON.stringify({ exitCode: 1 }) + "\n");
        res.end();
      }
    }
  });

  app.post("/exec/sandbox", async (req, res) => {
    const writeNdjson = (obj: Record<string, unknown>) => {
      res.write(JSON.stringify(obj) + "\n");
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
        const cwdError = validateCwd(cwd);
        if (cwdError) {
          res.status(400).json({ stdout: "", stderr: cwdError, exitCode: 1 });
          return;
        }

        if (!cwd.startsWith("/workspace/worktrees/")) {
          res.status(400).json({
            stdout: "",
            stderr:
              "Sandbox requires a worktree. Create one first with: git worktree add -b <branch> /workspace/worktrees/<repo>/<branch> HEAD",
            exitCode: 1,
          });
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

      if (mode === "stop") {
        const sandbox = await findSandboxForCwd(cwd);
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

      const exitCode = await execInSandboxStream(result.sandboxId, result.command, {
        onStdout: (chunk) => writeNdjson({ stream: "stdout", data: chunk }),
        onStderr: (chunk) => writeNdjson({ stream: "stderr", data: chunk }),
      });
      let finalExitCode = exitCode;

      // Pull changes back only on success — failed commands may leave partial artifacts
      if (exitCode === 0) {
        try {
          const pull = await withCwdLock(cwd, () => pullSandboxChanges(result.sandboxId, cwd));
          if (pull.pulled.length > 0 || pull.deleted.length > 0) {
            logInfo(log, "sandbox_pull", {
              pulled: pull.pulled,
              deleted: pull.deleted,
              cwd,
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
          writeNdjson({ stream: "stderr", data: `${error.userMessage}\n` });
          finalExitCode = 1;
        }
      }

      writeNdjson({ exitCode: finalExitCode });
      res.end();
    } catch (err) {
      const error =
        err instanceof SandboxError ? err : new SandboxError("Sandbox service error", String(err));
      logError(log, "exec_sandbox_error", error.adminDetail, thorIds(req));

      if (!res.headersSent) {
        res.status(500).json({ stdout: "", stderr: error.userMessage, exitCode: 1 });
      } else {
        writeNdjson({ stream: "stderr", data: `${error.userMessage}\n` });
        writeNdjson({ exitCode: 1 });
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

      const result = await mcpService.executeMcp(args, {
        directory: typeof req.body?.directory === "string" ? req.body.directory : undefined,
        resolveSecret: req.headers["x-thor-resolve-secret"] as string | undefined,
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
  const remoteCli = createRemoteCliApp();
  logInfo(log, "remote_cli_starting", { port: PORT });
  const server = remoteCli.app.listen(PORT, () => {
    logInfo(log, "remote_cli_listening", { port: PORT });
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
