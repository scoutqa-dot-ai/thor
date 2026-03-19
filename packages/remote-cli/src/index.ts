import express from "express";
import { createLogger, logInfo, logError } from "@thor/common";
import { execCommand, execCommandStream } from "./exec.js";
import {
  validateCwd,
  validateGitArgs,
  validateGhArgs,
  validateScoutqaArgs,
  validateSandboxCwd,
  validateSandboxCoderArgs,
} from "./policy.js";
import { DaytonaSandboxProvider } from "./sandbox/provider.js";
import { SandboxManager } from "./sandbox/manager.js";
import { syncIn, syncOut } from "./sandbox/sync.js";

const log = createLogger("remote-cli");

const PORT = parseInt(process.env.PORT || "3004", 10);

// ── Sandbox manager (D6, D8) ───────────────────────────────────────────────

const sandboxProvider = new DaytonaSandboxProvider({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: process.env.DAYTONA_API_URL,
  target: process.env.DAYTONA_TARGET,
});
const sandboxManager = new SandboxManager(sandboxProvider);

// ── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "remote-cli" });
});

/**
 * POST /exec/git — execute a git command
 * Body: { args: string[], cwd: string }
 * Response: { stdout, stderr, exitCode }
 */
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

    logInfo(log, "exec_git", { args, cwd });
    const result = await execCommand("git", args, cwd);

    // Sandbox destroy hook: after successful "git worktree remove", clean up sandbox (D8)
    if (result.exitCode === 0 && args.includes("worktree") && args.includes("remove")) {
      const removedPath = args[args.indexOf("remove") + 1];
      if (removedPath) {
        sandboxManager.destroy(removedPath).catch((err) => {
          logError(
            log,
            "sandbox_destroy_hook_error",
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    }

    res.json(result);
  } catch (err) {
    logError(log, "exec_git_error", err instanceof Error ? err.message : String(err));
    res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
  }
});

/**
 * POST /exec/gh — execute a gh CLI command
 * Body: { args: string[], cwd: string }
 * Response: { stdout, stderr, exitCode }
 */
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

    logInfo(log, "exec_gh", { args, cwd });
    const result = await execCommand("gh", args, cwd);
    res.json(result);
  } catch (err) {
    logError(log, "exec_gh_error", err instanceof Error ? err.message : String(err));
    res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
  }
});

/**
 * POST /exec/scoutqa — execute a scoutqa CLI command (streaming)
 * Body: { args: string[] }
 * Response: newline-delimited JSON chunks:
 *   { "stream": "stdout", "data": "..." }
 *   { "stream": "stderr", "data": "..." }
 *   { "exitCode": 0 }                        ← final line
 */
app.post("/exec/scoutqa", async (req, res) => {
  try {
    const { args } = req.body ?? {};

    const argsError = validateScoutqaArgs(args);
    if (argsError) {
      res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
      return;
    }

    logInfo(log, "exec_scoutqa", { args });

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
    logError(log, "exec_scoutqa_error", err instanceof Error ? err.message : String(err));
    if (!res.headersSent) {
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    } else {
      res.write(JSON.stringify({ exitCode: 1 }) + "\n");
      res.end();
    }
  }
});

/**
 * POST /exec/sandbox-coder — execute a coding task in a Daytona sandbox (streaming)
 * Body: { args: string[], cwd: string }
 * Response: newline-delimited JSON chunks (same format as scoutqa):
 *   { "stream": "stderr", "data": "[sandbox:phase] ...\n" }
 *   { "stream": "stdout", "data": "..." }
 *   { "exitCode": 0 }                                       ← final line
 *
 * Subcommands (via args):
 *   sandbox-coder "prompt"              — run coding task
 *   sandbox-coder --reconnect <id>      — resume streaming from session
 *   sandbox-coder --pull <id>           — pull files from sandbox
 */
app.post("/exec/sandbox-coder", async (req, res) => {
  try {
    const { args, cwd } = req.body ?? {};

    const cwdError = validateSandboxCwd(cwd);
    if (cwdError) {
      res.status(400).json({ stdout: "", stderr: cwdError, exitCode: 2 });
      return;
    }

    const argsError = validateSandboxCoderArgs(args);
    if (argsError) {
      res.status(400).json({ stdout: "", stderr: argsError, exitCode: 2 });
      return;
    }

    logInfo(log, "exec_sandbox_coder", { args, cwd });

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");

    const write = (obj: Record<string, unknown>) => {
      res.write(JSON.stringify(obj) + "\n");
    };

    // Parse subcommand from args (D12)
    const first = args[0] as string;

    if (first === "--reconnect") {
      // Resume streaming from existing Daytona session (D7, D12)
      const sessionId = args[1] as string;
      const sandboxId = sandboxManager.get(cwd);
      if (!sandboxId) {
        write({ stream: "stderr", data: "[sandbox:error] no sandbox found for this worktree\n" });
        write({ exitCode: 2 });
        res.end();
        return;
      }

      write({ stream: "stderr", data: `[sandbox:id] ${sandboxId}\n` });
      write({ stream: "stderr", data: `[sandbox:session] ${sessionId}\n` });
      write({ stream: "stderr", data: "[sandbox:phase] reconnecting\n" });

      // Get the latest command in this session and stream its logs
      const session = await sandboxProvider.getSessionCommandLogs(
        sandboxId,
        sessionId,
        sessionId, // commandId — we use sessionId as commandId for simplicity
        (chunk) => write({ stream: "stdout", data: chunk }),
        (chunk) => write({ stream: "stderr", data: chunk }),
      );

      // After reconnect completes, do syncOut
      write({ stream: "stderr", data: "[sandbox:phase] sync_out\n" });
      const result = await syncOut(sandboxProvider, sandboxId, cwd);
      write({ stream: "stderr", data: `[sandbox:done] files_changed=${result.filesChanged}\n` });
      write({ exitCode: 0 });
      res.end();
      return;
    }

    if (first === "--pull") {
      // SyncOut only — recover files from sandbox (D12, D14)
      const targetSandboxId = args[1] as string;
      write({ stream: "stderr", data: `[sandbox:id] ${targetSandboxId}\n` });
      write({ stream: "stderr", data: "[sandbox:phase] sync_out\n" });

      const result = await syncOut(sandboxProvider, targetSandboxId, cwd);
      write({ stream: "stderr", data: `[sandbox:done] files_changed=${result.filesChanged}\n` });
      write({ exitCode: 0 });
      res.end();
      return;
    }

    // ── Regular prompt — full pipeline: create → syncIn → agent → syncOut ──

    const prompt = args.join(" ");

    // Step 1: Get or create sandbox
    write({ stream: "stderr", data: "[sandbox:phase] sandbox_create\n" });
    const sandboxId = await sandboxManager.getOrCreate(cwd);
    write({ stream: "stderr", data: `[sandbox:id] ${sandboxId}\n` });

    // Step 2: Sync worktree files into sandbox
    write({ stream: "stderr", data: "[sandbox:phase] sync_in\n" });
    await syncIn(sandboxProvider, sandboxId, cwd);

    // Step 3: Create session and run agent (D7)
    write({ stream: "stderr", data: "[sandbox:phase] agent_running\n" });
    const sessionId = `sess-${Date.now()}`;
    await sandboxProvider.createSession(sandboxId, sessionId);
    write({ stream: "stderr", data: `[sandbox:session] ${sessionId}\n` });

    const agentCommand = `opencode run --format json ${JSON.stringify(prompt)}`;
    const execResult = await sandboxProvider.execSessionCommand(sandboxId, sessionId, agentCommand);

    // Stream logs from the session command
    await sandboxProvider.getSessionCommandLogs(
      sandboxId,
      sessionId,
      execResult.commandId,
      (chunk) => write({ stream: "stdout", data: chunk }),
      (chunk) => write({ stream: "stderr", data: chunk }),
    );

    // Check agent exit code
    const cmdInfo = await sandboxProvider.executeCommand(
      sandboxId,
      `cat /tmp/.sandbox-exit-code 2>/dev/null || echo 0`,
    );

    // Step 4: Sync changed files back to worktree
    write({ stream: "stderr", data: "[sandbox:phase] sync_out\n" });
    const syncResult = await syncOut(sandboxProvider, sandboxId, cwd);

    const exitCode = execResult.exitCode ?? 0;
    if (exitCode !== 0) {
      write({
        stream: "stderr",
        data: `[sandbox:error] agent exited with code ${exitCode}\n`,
      });
    }

    write({
      stream: "stderr",
      data: `[sandbox:done] files_changed=${syncResult.filesChanged} files_deleted=${syncResult.filesDeleted}\n`,
    });
    write({ exitCode });
    res.end();
  } catch (err) {
    logError(log, "exec_sandbox_coder_error", err instanceof Error ? err.message : String(err));
    if (!res.headersSent) {
      res.status(500).json({ stdout: "", stderr: "Internal server error", exitCode: 1 });
    } else {
      res.write(JSON.stringify({ exitCode: 1 }) + "\n");
      res.end();
    }
  }
});

// ── Startup ─────────────────────────────────────────────────────────────────

// Reconcile sandbox state before accepting requests (D8)
sandboxManager.reconcile().then(() => {
  app.listen(PORT, () => {
    logInfo(log, "remote_cli_listening", { port: PORT });
  });
});
