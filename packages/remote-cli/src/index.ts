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
  execInSandbox,
  findSandboxForCwd,
  getLastSyncedSha,
  listSandboxes,
  SandboxError,
  shellQuote,
  syncSandbox,
  THOR_BRANCH_LABEL,
  THOR_CWD_LABEL,
  THOR_MANAGED_LABEL,
  THOR_SHA_LABEL,
} from "./sandbox.js";
import {
  validateCwd,
  validateGitArgs,
  validateGhArgs,
  validateLangfuseArgs,
  validateMetabaseArgs,
  validateScoutqaArgs,
} from "./policy.js";

const log = createLogger("remote-cli");

const PORT = parseInt(process.env.PORT || "3004", 10);

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

function buildSandboxName(cwd: string, branch: string): string {
  const repoSegment = cwd.split("/")[3] || "repo";
  const slug = `${repoSegment}-${branch}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `thor-${slug || "sandbox"}`.slice(0, 63);
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
          branch: sandbox.labels?.[THOR_BRANCH_LABEL] || "",
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

      const gitStatus = await execCommand("git", ["status", "--porcelain"], cwd);
      if ((gitStatus.exitCode ?? 0) !== 0) {
        throw new SandboxError(
          "Failed to inspect worktree state",
          `git status failed: ${gitStatus.stderr || gitStatus.stdout}`,
        );
      }
      if (gitStatus.stdout.trim().length > 0) {
        res.status(400).json({
          stdout: "",
          stderr:
            "Worktree not clean. Commit your changes first (add generated files to .gitignore).",
          exitCode: 1,
        });
        return;
      }

      const gitSha = await execCommand("git", ["rev-parse", "HEAD"], cwd);
      if ((gitSha.exitCode ?? 0) !== 0) {
        throw new SandboxError(
          "Failed to resolve worktree HEAD",
          `git rev-parse HEAD failed: ${gitSha.stderr || gitSha.stdout}`,
        );
      }
      const currentSha = gitSha.stdout.trim();
      if (!currentSha) {
        throw new SandboxError(
          "Failed to resolve worktree HEAD",
          "git rev-parse HEAD returned empty SHA",
        );
      }

      let sandbox = await findSandboxForCwd(cwd);

      if (!sandbox) {
        const gitBranch = await execCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
        if ((gitBranch.exitCode ?? 0) !== 0) {
          throw new SandboxError(
            "Failed to resolve worktree branch",
            `git rev-parse --abbrev-ref HEAD failed: ${gitBranch.stderr || gitBranch.stdout}`,
          );
        }
        const branch = gitBranch.stdout.trim() || "detached";

        const labels = {
          [THOR_MANAGED_LABEL]: "true",
          [THOR_CWD_LABEL]: cwd,
          [THOR_BRANCH_LABEL]: branch,
          [THOR_SHA_LABEL]: currentSha,
        };

        sandbox = await createSandbox(buildSandboxName(cwd, branch), cwd, currentSha, labels);
      }

      if (mode === "create") {
        res.json({ stdout: `${sandbox.id}\n`, stderr: "", exitCode: 0 });
        return;
      }

      // Sync only if sandbox already existed (create already synced to HEAD)
      const lastSyncedSha = getLastSyncedSha(sandbox);
      if (lastSyncedSha !== currentSha) {
        await syncSandbox(sandbox.id, cwd, lastSyncedSha, currentSha);
      }

      const command = args.map((a: string) => shellQuote(a)).join(" ");
      const sandboxCommand = `sh -lc ${shellQuote(command)}`;

      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Transfer-Encoding", "chunked");

      const result = await execInSandbox(sandbox.id, sandboxCommand);
      if (result.output) {
        writeNdjson({ stream: "stdout", data: result.output });
      }
      writeNdjson({ exitCode: result.exitCode });
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
