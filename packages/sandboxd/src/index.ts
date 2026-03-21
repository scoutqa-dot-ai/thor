import express from "express";

import {
  cleanupStaleSandboxes,
  createDaytonaSandboxProvider,
  createLogger,
  destroySandboxForWorktree,
  logError,
  logInfo,
} from "@thor/common";
import { z } from "zod/v4";

import { CoderRunRequestSchema, runHostedCoder } from "./hosted-coder.js";
import { resolveWorktreeContext } from "./worktree.js";

const log = createLogger("sandboxd");

const PORT = Number.parseInt(process.env.PORT || "3005", 10);
const OPENCODE_AUTH_PATH = process.env.OPENCODE_AUTH_PATH;

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "sandboxd",
    authConfigured: Boolean(OPENCODE_AUTH_PATH),
  });
});

app.post("/coder/run", async (req, res) => {
  const parsed = CoderRunRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      type: "error",
      message: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  const { cwd } = parsed.data;
  logInfo(log, "coder_run", { cwd });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");

  const write = (event: Record<string, unknown>) => {
    res.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const exitCode = await runHostedCoder(parsed.data, write);
    logInfo(log, "coder_run_completed", { cwd, exitCode });
    res.end();
  } catch (error) {
    logError(log, "coder_run_error", error instanceof Error ? error.message : String(error), {
      cwd,
    });
    write({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    res.end();
  }
});

const DestroyRequestSchema = z.object({
  cwd: z.string().min(1),
});

app.delete("/coder/sandbox", async (req, res) => {
  const parsed = DestroyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  const context = resolveWorktreeContext(parsed.data.cwd);
  logInfo(log, "sandbox_destroy", { cwd: context.cwd, worktreePath: context.worktreePath });

  try {
    const provider = createDaytonaSandboxProvider({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: process.env.DAYTONA_API_URL,
      target: process.env.DAYTONA_TARGET,
    });

    const destroyed = await destroySandboxForWorktree(provider, {
      worktreePath: context.worktreePath,
      repo: context.repo,
      branch: context.branch,
    });

    res.json({ destroyed, worktreePath: context.worktreePath });
  } catch (error) {
    logError(log, "sandbox_destroy_error", error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const DEFAULT_CLEANUP_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

app.post("/coder/cleanup", async (_req, res) => {
  logInfo(log, "sandbox_cleanup_start", {});

  try {
    const provider = createDaytonaSandboxProvider({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: process.env.DAYTONA_API_URL,
      target: process.env.DAYTONA_TARGET,
    });

    const result = await cleanupStaleSandboxes(provider, DEFAULT_CLEANUP_MAX_AGE_MS);
    logInfo(log, "sandbox_cleanup_completed", {
      destroyed: result.destroyed.length,
      errors: result.errors.length,
    });

    res.json(result);
  } catch (error) {
    logError(log, "sandbox_cleanup_error", error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(PORT, () => {
  logInfo(log, "sandboxd_listening", { port: PORT });
});
