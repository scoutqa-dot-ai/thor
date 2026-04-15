import express from "express";
import { createLogger, logInfo, logError, computeGitAlias, formatThorMeta } from "@thor/common";
import { execCommand, execCommandStream, MAX_OUTPUT_LARGE } from "./exec.js";
import {
  validateCwd,
  validateGitArgs,
  validateGhArgs,
  validateScoutqaArgs,
  validateLangfuseArgs,
} from "./policy.js";

const log = createLogger("remote-cli");

const PORT = parseInt(process.env.PORT || "3004", 10);

/** Extract Thor tracing IDs from request headers. */
function thorIds(req: express.Request): { sessionId?: string; callId?: string } {
  const sessionId = req.headers["x-thor-session-id"] as string | undefined;
  const callId = req.headers["x-thor-call-id"] as string | undefined;
  return {
    ...(sessionId && { sessionId }),
    ...(callId && { callId }),
  };
}

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

    logInfo(log, "exec_git", { args, cwd, ...thorIds(req) });
    const result = await execCommand("git", args, cwd);
    if ((result.exitCode ?? 0) === 0) {
      const alias = computeGitAlias("git", args, cwd);
      if (alias) result.stdout = (result.stdout || "") + formatThorMeta(alias);
    }
    res.json(result);
  } catch (err) {
    logError(log, "exec_git_error", err instanceof Error ? err.message : String(err), thorIds(req));
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

    logInfo(log, "exec_gh", { args, cwd, ...thorIds(req) });
    const result = await execCommand("gh", args, cwd);
    if ((result.exitCode ?? 0) === 0) {
      const alias = computeGitAlias("gh", args, cwd);
      if (alias) result.stdout = (result.stdout || "") + formatThorMeta(alias);
    }
    res.json(result);
  } catch (err) {
    logError(log, "exec_gh_error", err instanceof Error ? err.message : String(err), thorIds(req));
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

/**
 * POST /exec/langfuse — execute a langfuse CLI command
 * Body: { args: string[] }
 * Response: { stdout, stderr, exitCode }
 */
app.post("/exec/langfuse", async (req, res) => {
  try {
    const { args } = req.body ?? {};

    const argsError = validateLangfuseArgs(args);
    if (argsError) {
      res.status(400).json({ stdout: "", stderr: argsError, exitCode: 1 });
      return;
    }

    // Ensure --json is present for data commands (skip for --help and __schema)
    const action = args[2];
    const needsJson = action === "list" || action === "get";
    const finalArgs = !needsJson || args.includes("--json") ? args : [...args, "--json"];

    logInfo(log, "exec_langfuse", { args: finalArgs, ...thorIds(req) });
    const result = await execCommand("langfuse", finalArgs, "/workspace", MAX_OUTPUT_LARGE);
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

// ── Startup ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logInfo(log, "remote_cli_listening", { port: PORT });
});
