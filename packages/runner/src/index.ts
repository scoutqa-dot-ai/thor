import express from "express";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  Event,
  Part,
  TextPartInput,
  ToolPart,
  TextPart,
  StepFinishPart,
  ToolStateCompleted,
  ToolStateError,
} from "@opencode-ai/sdk";
import {
  writePartLog,
  writeSessionSummaryLog,
  writeTriggerLog,
  createLogger,
  logInfo,
  logError,
} from "@thor/common";

const log = createLogger("runner");

const PORT = parseInt(process.env.PORT || "3000", 10);
const OPENCODE_PORT = parseInt(process.env.OPENCODE_PORT || "4096", 10);
const OPENCODE_HOST = process.env.OPENCODE_HOST || "127.0.0.1";

/** Timeout for waiting for agent to finish processing a prompt (ms). */
const PROMPT_TIMEOUT = parseInt(process.env.PROMPT_TIMEOUT || "120000", 10);

// --- OpenCode server management ---

let opencodeProcess: ChildProcess | null = null;
let opencodeReady = false;

/**
 * Start the OpenCode headless server if not already running.
 */
async function ensureOpencode(): Promise<void> {
  if (opencodeReady) {
    try {
      const res = await fetch(`http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health`);
      if (res.ok) return;
    } catch {
      opencodeReady = false;
    }
  }

  if (opencodeProcess) {
    opencodeProcess.kill("SIGTERM");
    opencodeProcess = null;
  }

  logInfo(log, "opencode_starting", { port: OPENCODE_PORT });

  opencodeProcess = spawn(
    "opencode",
    ["serve", "--port", String(OPENCODE_PORT), "--hostname", OPENCODE_HOST],
    {
      stdio: "pipe",
      env: { ...process.env },
    },
  );

  opencodeProcess.stdout?.on("data", (data: Buffer) => {
    // Forward opencode stdout as structured log
    const text = data.toString().trim();
    if (text) logInfo(log, "opencode_stdout", { message: text });
  });

  opencodeProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) logError(log, "opencode_stderr", text);
  });

  opencodeProcess.on("exit", (code) => {
    logInfo(log, "opencode_exit", { code });
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
        logInfo(log, "opencode_ready", { port: OPENCODE_PORT });
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

// ---------------------------------------------------------------------------
// Event filtering — what gets a JSON file, what gets a stdout log, what's ignored
// ---------------------------------------------------------------------------
//
// | Part type       | JSON file? | Stdout log?             | Why                                   |
// |-----------------|------------|-------------------------|---------------------------------------|
// | tool completed  | Yes        | Yes (name + duration)   | The actual useful event                |
// | tool error      | Yes        | Yes (name + error)      | Something failed                       |
// | tool pending    | No         | No                      | Immediately followed by running        |
// | tool running    | No         | No                      | Immediately followed by result         |
// | step-finish     | Yes        | Yes (cost/token summary) | Step boundary with cost data          |
// | text            | Yes        | Yes (length only)       | Assistant response, don't dump content |
// | step-start      | No         | No                      | Pure noise                             |
// | reasoning       | No         | No                      | Internal CoT, fires many times         |
// | snapshot/patch  | No         | No                      | Infrastructure noise                   |
// | compaction      | No         | No                      | Infrastructure noise                   |
// | retry           | No         | Yes (attempt + error)   | Worth noting but no file needed        |
// | subtask         | No         | Yes (brief)             | Worth noting a subtask was spawned     |
// | agent           | No         | No                      | Infrastructure noise                   |

/** Returns true if this part should get a JSON worklog file. */
function shouldWriteJson(part: Part): boolean {
  if (part.type === "tool") {
    const status = (part as ToolPart).state.status;
    return status === "completed" || status === "error";
  }
  return part.type === "step-finish" || part.type === "text";
}

/** Log a part to stdout if it's interesting. Returns true if logged. */
function logPartToStdout(sessionId: string, part: Part): void {
  const sid = sessionId.slice(0, 12);

  if (part.type === "tool") {
    const toolPart = part as ToolPart;
    const status = toolPart.state.status;

    if (status === "completed") {
      const completed = toolPart.state as ToolStateCompleted;
      const durationMs = completed.time.end - completed.time.start;
      logInfo(log, "tool_completed", {
        sessionId: sid,
        tool: toolPart.tool,
        durationMs,
      });
    } else if (status === "error") {
      const errState = toolPart.state as ToolStateError;
      logError(log, "tool_error", errState.error, {
        sessionId: sid,
        tool: toolPart.tool,
      });
    }
    // pending/running — silent
    return;
  }

  if (part.type === "text") {
    const textPart = part as TextPart;
    logInfo(log, "text", {
      sessionId: sid,
      length: textPart.text.length,
    });
    return;
  }

  if (part.type === "step-finish") {
    const sf = part as StepFinishPart;
    logInfo(log, "step_finish", {
      sessionId: sid,
      reason: sf.reason,
      cost: sf.cost,
      tokens: sf.tokens,
    });
    return;
  }

  if (part.type === "retry") {
    // RetryPart has attempt and error fields
    const retryPart = part as Part & { type: "retry"; attempt: number; error: { message: string } };
    logError(log, "retry", retryPart.error.message, {
      sessionId: sid,
      attempt: retryPart.attempt,
    });
    return;
  }

  if (part.type === "subtask") {
    const subtaskPart = part as Part & { type: "subtask"; description: string; agent: string };
    logInfo(log, "subtask", {
      sessionId: sid,
      description: subtaskPart.description,
      agent: subtaskPart.agent,
    });
    return;
  }

  // Everything else (step-start, reasoning, snapshot, patch, compaction, agent) — silent
}

/**
 * Stream-based prompt handler.
 *
 * 1. Creates a session and fires promptAsync (fire-and-forget, returns 204).
 * 2. Subscribes to the SSE event stream.
 * 3. Filters events by sessionID; writes worklog + stdout only for meaningful events.
 * 4. Waits for `session.idle` to know the prompt is done.
 * 5. Returns the aggregated response to the HTTP caller.
 */
app.post("/trigger", async (req, res) => {
  const { prompt, model } = req.body as TriggerRequest;

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Missing or invalid 'prompt' field" });
    return;
  }

  try {
    await ensureOpencode();

    const client = createOpencodeClient({
      baseUrl: `http://${OPENCODE_HOST}:${OPENCODE_PORT}`,
    });

    const session = await client.session.create({
      body: { title: `trigger: ${prompt.slice(0, 50)}` },
    });

    if (!session.data) {
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    const sessionId = session.data.id;
    logInfo(log, "session_created", { sessionId });

    const parts: TextPartInput[] = [{ type: "text", text: prompt }];
    const modelConfig = model
      ? {
          providerID: model.split("/")[0],
          modelID: model.split("/").slice(1).join("/"),
        }
      : undefined;

    writeTriggerLog({ sessionId, prompt, model });

    // Subscribe to event stream BEFORE sending the prompt
    const { stream } = await client.event.subscribe();

    const promptStart = Date.now();
    const asyncResult = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts,
        ...(modelConfig ? { model: modelConfig } : {}),
      },
    });

    if (asyncResult.error) {
      res.status(500).json({
        error: "Failed to send prompt",
        detail: asyncResult.error,
        sessionId,
      });
      return;
    }

    logInfo(log, "prompt_sent", { sessionId });

    // --- Stream processing ---

    let seq = 0;
    const collectedTextParts: string[] = [];
    const collectedToolCalls: Array<{ tool: string; state: string }> = [];
    let lastMessageId: string | undefined;
    let totalCost = 0;
    const totalTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    let sessionError: string | undefined;
    let finished = false;

    const timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true;
        logError(log, "session_timeout", `Timed out after ${PROMPT_TIMEOUT}ms`, { sessionId });
      }
    }, PROMPT_TIMEOUT);

    try {
      for await (const event of stream) {
        if (finished) break;

        if (!isSessionEvent(event, sessionId)) continue;

        if (event.type === "message.part.updated") {
          const part = event.properties.part;
          seq++;

          // Stdout logging (selective)
          logPartToStdout(sessionId, part);

          // JSON worklog file (selective)
          if (shouldWriteJson(part)) {
            writePartLog(buildPartLogEntry(sessionId, part, seq));
          }

          // Accumulate data for response regardless of filtering
          if (part.type === "text") {
            const textPart = part as TextPart;
            collectedTextParts.push(textPart.text);
            lastMessageId = textPart.messageID;
          } else if (part.type === "tool") {
            const toolPart = part as ToolPart;
            const status = toolPart.state.status;
            if (status === "completed" || status === "error") {
              collectedToolCalls.push({ tool: toolPart.tool, state: status });
            }
            lastMessageId = toolPart.messageID;
          } else if (part.type === "step-finish") {
            const stepFinish = part as StepFinishPart;
            totalCost += stepFinish.cost;
            totalTokens.input += stepFinish.tokens.input;
            totalTokens.output += stepFinish.tokens.output;
            totalTokens.reasoning += stepFinish.tokens.reasoning;
            totalTokens.cache.read += stepFinish.tokens.cache.read;
            totalTokens.cache.write += stepFinish.tokens.cache.write;
            lastMessageId = stepFinish.messageID;
          }
        } else if (event.type === "session.error") {
          const errorProps = event.properties;
          sessionError =
            errorProps.error && "data" in errorProps.error
              ? (errorProps.error.data as { message?: string }).message || errorProps.error.name
              : "Unknown error";
          logError(log, "session_error", sessionError, { sessionId });
          finished = true;
          break;
        } else if (event.type === "session.idle") {
          finished = true;
          break;
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    const durationMs = Date.now() - promptStart;

    writeSessionSummaryLog({
      sessionId,
      status: sessionError ? "error" : finished ? "completed" : "timeout",
      prompt,
      responseText: collectedTextParts.length > 0 ? collectedTextParts.join("\n\n") : undefined,
      totalToolCalls: collectedToolCalls.length,
      totalParts: seq,
      durationMs,
      error: sessionError,
      totals:
        totalCost > 0 || totalTokens.input > 0
          ? { cost: totalCost, tokens: totalTokens }
          : undefined,
    });

    logInfo(log, "session_done", {
      sessionId,
      status: sessionError ? "error" : finished ? "completed" : "timeout",
      textParts: collectedTextParts.length,
      toolCalls: collectedToolCalls.length,
      totalParts: seq,
      durationMs,
    });

    if (sessionError) {
      res.status(500).json({
        sessionId,
        error: sessionError,
        toolCalls: collectedToolCalls,
        durationMs,
      });
      return;
    }

    res.json({
      sessionId,
      response: collectedTextParts.join("\n\n"),
      toolCalls: collectedToolCalls,
      messageId: lastMessageId,
      durationMs,
    });
  } catch (err) {
    logError(log, "trigger_error", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// --- Helpers ---

/**
 * Check if an SSE event belongs to a specific session.
 */
function isSessionEvent(event: Event, sessionId: string): boolean {
  if (event.type === "message.part.updated") {
    return event.properties.part.sessionID === sessionId;
  }
  if (
    event.type === "session.idle" ||
    event.type === "session.status" ||
    event.type === "session.error"
  ) {
    return event.properties.sessionID === sessionId;
  }
  return false;
}

/**
 * Build a PartLogEntry from a Part for the worklog.
 * Only called for parts that pass the shouldWriteJson filter.
 */
function buildPartLogEntry(
  sessionId: string,
  part: Part,
  seq: number,
): import("@thor/common").PartLogEntry {
  const base = {
    sessionId,
    messageId: part.messageID,
    partId: part.id,
    partType: part.type,
    seq,
  };

  if (part.type === "text") {
    const textPart = part as TextPart;
    return { ...base, text: textPart.text };
  }

  if (part.type === "tool") {
    const toolPart = part as ToolPart;
    const toolInfo: import("@thor/common").PartLogEntry["tool"] = {
      callId: toolPart.callID,
      name: toolPart.tool,
      status: toolPart.state.status,
      input: toolPart.state.input,
    };

    if (toolPart.state.status === "completed") {
      const completed = toolPart.state as ToolStateCompleted;
      toolInfo.output = completed.output;
      toolInfo.durationMs = completed.time.end - completed.time.start;
    } else if (toolPart.state.status === "error") {
      const errState = toolPart.state as ToolStateError;
      toolInfo.error = errState.error;
      toolInfo.durationMs = errState.time.end - errState.time.start;
    }

    return { ...base, tool: toolInfo };
  }

  if (part.type === "step-finish") {
    const stepFinish = part as StepFinishPart;
    return {
      ...base,
      stepFinish: {
        reason: stepFinish.reason,
        cost: stepFinish.cost,
        tokens: stepFinish.tokens,
      },
    };
  }

  return base;
}

// --- Startup ---

app.listen(PORT, () => {
  logInfo(log, "runner_started", { port: PORT });
});

// --- Graceful shutdown ---

function shutdown(): void {
  logInfo(log, "runner_shutdown");
  if (opencodeProcess) {
    opencodeProcess.kill("SIGTERM");
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
