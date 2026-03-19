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
import { setupSandboxOpenCode, uploadSandboxAuth } from "./sandbox/setup.js";

const log = createLogger("remote-cli");

const PORT = parseInt(process.env.PORT || "3004", 10);

// ── Sandbox manager (D6, D8) ───────────────────────────────────────────────

const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
if (!DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY environment variable is required");
}

const sandboxProvider = new DaytonaSandboxProvider(DAYTONA_API_KEY);
const sandboxManager = new SandboxManager(sandboxProvider);

const SANDBOX_MODEL = process.env.SANDBOX_MODEL || "openai/gpt-5.3-codex-spark";

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
 *   sandbox-coder "prompt"                        — run coding task (new session)
 *   sandbox-coder --session <id> "prompt"         — continue existing opencode session
 *   sandbox-coder --pull <sandbox-id>             — pull files from sandbox
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

    // Parse --session <id> if provided (continue existing opencode session)
    let opencodeSessionId: string | undefined;
    const sessionIdx = args.indexOf("--session");
    if (sessionIdx !== -1 && args[sessionIdx + 1]) {
      opencodeSessionId = args[sessionIdx + 1];
      args.splice(sessionIdx, 2);
    }

    const prompt = args.join(" ");

    // Step 1: Get or create sandbox
    write({ stream: "stderr", data: "[sandbox:phase] sandbox_create\n" });
    const sandboxId = await sandboxManager.getOrCreate(cwd);
    write({ stream: "stderr", data: `[sandbox:id] ${sandboxId}\n` });

    // Step 1.5: One-time setup (install opencode, upload config)
    write({ stream: "stderr", data: "[sandbox:phase] setup\n" });
    await setupSandboxOpenCode(sandboxProvider, sandboxId);

    // Step 1.6: Fresh auth credentials (every prompt — tokens expire)
    await uploadSandboxAuth(sandboxProvider, sandboxId);

    // Step 2: Sync worktree files into sandbox
    write({ stream: "stderr", data: "[sandbox:phase] sync_in\n" });
    await syncIn(sandboxProvider, sandboxId, cwd);

    // Step 3: Run agent via PTY with real-time streaming
    write({ stream: "stderr", data: "[sandbox:phase] agent_running\n" });

    // Build opencode command with prompt, model, and optional session flag
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const sessionFlag = opencodeSessionId ? ` --session ${opencodeSessionId}` : "";
    const agentCommand = `opencode run --format json --model ${SANDBOX_MODEL}${sessionFlag} '${escapedPrompt}'`;

    const agentResult = await sandboxProvider.runAgentStreaming(
      sandboxId,
      agentCommand,
      "/home/daytona/src",
      (jsonLine) => write({ stream: "stdout", data: jsonLine + "\n" }),
    );

    // Emit the opencode session ID so the caller can use --session for follow-ups
    if (agentResult.opencodeSessionId) {
      write({
        stream: "stderr",
        data: `[sandbox:opencode_session] ${agentResult.opencodeSessionId}\n`,
      });
    }

    // Step 4: Sync changed files back to worktree
    write({ stream: "stderr", data: "[sandbox:phase] sync_out\n" });
    const syncResult = await syncOut(sandboxProvider, sandboxId, cwd);

    if (agentResult.exitCode !== 0) {
      write({
        stream: "stderr",
        data: `[sandbox:error] agent exited with code ${agentResult.exitCode}\n`,
      });
    }

    write({
      stream: "stderr",
      data: `[sandbox:done] files_changed=${syncResult.filesChanged} files_deleted=${syncResult.filesDeleted}\n`,
    });
    write({ exitCode: agentResult.exitCode });
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

app.listen(PORT, () => {
  logInfo(log, "remote_cli_listening", { port: PORT });
});
