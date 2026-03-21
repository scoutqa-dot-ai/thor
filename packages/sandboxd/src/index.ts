import express from "express";

import { createLogger, logError, logInfo } from "@thor/common";

import { CoderRunRequestSchema, runHostedCoder } from "./hosted-coder.js";

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

app.listen(PORT, () => {
  logInfo(log, "sandboxd_listening", { port: PORT });
});
