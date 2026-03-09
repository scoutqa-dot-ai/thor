import express from "express";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import type { Part, TextPartInput, ToolPart } from "@opencode-ai/sdk";

const PORT = parseInt(process.env.PORT || "3000", 10);
const OPENCODE_PORT = parseInt(process.env.OPENCODE_PORT || "4096", 10);
const OPENCODE_HOST = process.env.OPENCODE_HOST || "127.0.0.1";

// Default timeout for waiting for agent response (ms)
const PROMPT_TIMEOUT = parseInt(process.env.PROMPT_TIMEOUT || "120000", 10);

// --- OpenCode server management ---

let opencodeProcess: ChildProcess | null = null;
let opencodeReady = false;

/**
 * Start the OpenCode headless server if not already running.
 */
async function ensureOpencode(): Promise<void> {
  if (opencodeReady) {
    // Quick health check
    try {
      const res = await fetch(`http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health`);
      if (res.ok) return;
    } catch {
      // Server died, restart it
      opencodeReady = false;
    }
  }

  if (opencodeProcess) {
    opencodeProcess.kill("SIGTERM");
    opencodeProcess = null;
  }

  console.log(`[runner] Starting opencode serve on :${OPENCODE_PORT}...`);

  opencodeProcess = spawn(
    "opencode",
    ["serve", "--port", String(OPENCODE_PORT), "--hostname", OPENCODE_HOST],
    {
      stdio: "pipe",
      env: { ...process.env },
    },
  );

  opencodeProcess.stdout?.on("data", (data: Buffer) => {
    console.log(`[opencode] ${data.toString().trim()}`);
  });

  opencodeProcess.stderr?.on("data", (data: Buffer) => {
    console.error(`[opencode] ${data.toString().trim()}`);
  });

  opencodeProcess.on("exit", (code) => {
    console.log(`[opencode] exited with code ${code}`);
    opencodeReady = false;
    opencodeProcess = null;
  });

  // Wait for server to be ready
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health`);
      if (res.ok) {
        opencodeReady = true;
        console.log(`[runner] OpenCode server ready on :${OPENCODE_PORT}`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error("OpenCode server failed to start within 15s");
}

// --- Express app ---

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  let opencodeHealthy = false;
  try {
    const r = await fetch(`http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health`);
    opencodeHealthy = r.ok;
  } catch {
    // not running
  }

  res.json({
    status: "ok",
    service: "runner",
    opencode: opencodeHealthy ? "connected" : "disconnected",
  });
});

interface TriggerRequest {
  prompt: string;
  model?: string;
}

app.post("/trigger", async (req, res) => {
  const { prompt, model } = req.body as TriggerRequest;

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Missing or invalid 'prompt' field" });
    return;
  }

  try {
    // Ensure OpenCode server is running
    await ensureOpencode();

    const client = createOpencodeClient({
      baseUrl: `http://${OPENCODE_HOST}:${OPENCODE_PORT}`,
    });

    // Create a new session
    const session = await client.session.create({
      body: { title: `trigger: ${prompt.slice(0, 50)}` },
    });

    if (!session.data) {
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    const sessionId = session.data.id;
    console.log(`[runner] Session created: ${sessionId}`);

    // Build prompt parts
    const parts: TextPartInput[] = [{ type: "text", text: prompt }];

    // Build model config if provided
    const modelConfig = model
      ? {
          providerID: model.split("/")[0],
          modelID: model.split("/").slice(1).join("/"),
        }
      : undefined;

    // Send the prompt and wait for the response
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts,
        ...(modelConfig ? { model: modelConfig } : {}),
      },
    });

    if (!result.data) {
      res.status(500).json({ error: "No response from agent", sessionId });
      return;
    }

    // Extract text content from the final response
    const responseParts = result.data.parts || [];
    const textParts = responseParts
      .filter((p): p is Part & { type: "text" } => p.type === "text")
      .map((p) => p.text);

    // Fetch all session messages to collect tool calls across the entire conversation
    const messagesResult = await client.session.messages({
      path: { id: sessionId },
    });

    const allMessages = messagesResult.data || [];
    const toolCalls = allMessages.flatMap(({ parts }) =>
      (parts || [])
        .filter((p): p is ToolPart => p.type === "tool")
        .map((p) => ({
          tool: p.tool,
          state: p.state,
        })),
    );

    console.log(
      `[runner] Session ${sessionId}: ${textParts.length} text parts, ${toolCalls.length} tool calls`,
    );

    res.json({
      sessionId,
      response: textParts.join("\n\n"),
      toolCalls,
      messageId: result.data.info?.id,
    });
  } catch (err) {
    console.error("[runner] Trigger error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// --- Startup ---

app.listen(PORT, () => {
  console.log(`[runner] listening on :${PORT}`);
});

// --- Graceful shutdown ---

function shutdown(): void {
  console.log("[runner] Shutting down...");
  if (opencodeProcess) {
    opencodeProcess.kill("SIGTERM");
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
