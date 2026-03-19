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

const log = createLogger("remote-cli");

const PORT = parseInt(process.env.PORT || "3004", 10);

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

    // TODO: Phase 2+ will wire in SandboxManager, syncIn, agent exec, syncOut.
    // For now, emit a stub response so the wrapper → client → server pipe is testable.
    write({ stream: "stderr", data: "[sandbox:phase] stub\n" });
    write({
      stream: "stdout",
      data: `sandbox-coder stub: args=${JSON.stringify(args)} cwd=${cwd}\n`,
    });
    write({ exitCode: 0 });
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
