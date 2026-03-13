import express from "express";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod/v4";
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
  createLogger,
  logInfo,
  logError,
  createNotes,
  continueNotes,
  appendTrigger,
  appendSummary,
  findNotesFile,
  getSessionIdFromNotes,
  isAliasableTool,
  extractAliases,
  registerAlias,
} from "@thor/common";
import type { ToolArtifact } from "@thor/common";
import type { ProgressEvent } from "@thor/common";

const log = createLogger("runner");

const PORT = parseInt(process.env.PORT || "3000", 10);
const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, "");
const OPENCODE_CONNECT_TIMEOUT = parseInt(process.env.OPENCODE_CONNECT_TIMEOUT || "15000", 10);
const SESSION_DIRECTORY =
  process.env.GIT_MCP_DEFAULT_CWD || "/workspace/repos/acme-project";

/** Timeout for waiting for a busy session to become idle after abort (ms). */
const ABORT_TIMEOUT = parseInt(process.env.ABORT_TIMEOUT || "10000", 10);

async function fetchOpencode(path: string): Promise<Response> {
  return fetch(`${OPENCODE_URL}${path}`);
}

async function isOpencodeReachable(): Promise<boolean> {
  try {
    const response = await fetchOpencode("/global/health");
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureOpencodeAvailable(): Promise<void> {
  const deadline = Date.now() + OPENCODE_CONNECT_TIMEOUT;

  while (Date.now() < deadline) {
    if (await isOpencodeReachable()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `OpenCode server at ${OPENCODE_URL} was not reachable within ${OPENCODE_CONNECT_TIMEOUT}ms`,
  );
}

// --- Express app ---

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  const opencodeHealthy = await isOpencodeReachable();

  res.json({
    status: "ok",
    service: "runner",
    opencode: opencodeHealthy ? "connected" : "disconnected",
    opencodeUrl: OPENCODE_URL,
  });
});

// --- Trigger endpoint ---

const TriggerRequestSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  /** Correlation key for session continuity. Same key = same OpenCode session. */
  correlationKey: z.string().optional(),
  /** Direct session ID to resume (bypasses correlation key lookup). */
  sessionId: z.string().optional(),
});

type TriggerRequest = z.infer<typeof TriggerRequestSchema>;

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
/** Log a part to stdout if it's interesting. */
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
 * Session lookup — returns the session entry for a correlation key, or 404.
 *
 * GET /sessions?correlationKey=slack:thread:123
 * GET /sessions (no filter) — returns all entries.
 */
app.get("/sessions", (req, res) => {
  const correlationKey = req.query.correlationKey;

  if (typeof correlationKey === "string") {
    const sessionId = getSessionIdFromNotes(correlationKey);
    if (!sessionId) {
      res.status(404).json({ error: "No session for this correlation key" });
      return;
    }
    res.json({ correlationKey, sessionId });
    return;
  }

  // No filter — not supported without the map file. Use OpenCode UI instead.
  res.json({ message: "Use ?correlationKey=<key> to look up a specific session" });
});

/**
 * Stream-based prompt handler.
 *
 * 1. Resolves or creates an OpenCode session (correlation key → session ID).
 * 2. Subscribes to the SSE event stream.
 * 3. Sends the prompt via promptAsync.
 * 4. Streams until `session.idle` or `session.error` (no timeout).
 * 5. Returns the aggregated response to the HTTP caller.
 */
app.post("/trigger", async (req, res) => {
  const parsed = TriggerRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  let { prompt, model, correlationKey, sessionId: requestedSessionId } = parsed.data;

  try {
    await ensureOpencodeAvailable();

    const client = createOpencodeClient({
      baseUrl: OPENCODE_URL,
      directory: SESSION_DIRECTORY,
    });

    // --- Session resolution: resume existing or create new ---
    let sessionId: string;
    let resumed = false;

    const candidateSessionId =
      requestedSessionId || (correlationKey ? getSessionIdFromNotes(correlationKey) : undefined);

    if (candidateSessionId) {
      // Verify the session still exists in OpenCode
      try {
        const existing = await client.session.get({ path: { id: candidateSessionId } });
        if (existing.data) {
          sessionId = candidateSessionId;
          resumed = true;
          logInfo(log, "session_resumed", { sessionId, correlationKey });
        } else {
          throw new Error("Session not found");
        }
      } catch {
        // Session is gone — create a new one and update the notes file
        logInfo(log, "session_stale", { sessionId: candidateSessionId, correlationKey });

        const session = await client.session.create({
          body: { title: `trigger: ${prompt.slice(0, 50)}` },
        });
        if (!session.data) {
          res.status(500).json({ error: "Failed to create session" });
          return;
        }
        sessionId = session.data.id;
        logInfo(log, "session_created", { sessionId, correlationKey });
      }
    } else {
      // No session to resume — create a new one
      const session = await client.session.create({
        body: { title: `trigger: ${prompt.slice(0, 50)}` },
      });
      if (!session.data) {
        res.status(500).json({ error: "Failed to create session" });
        return;
      }
      sessionId = session.data.id;
      logInfo(log, "session_created", { sessionId, correlationKey });
    }

    // --- If resuming a busy session, abort and wait for idle ---
    if (resumed) {
      const statusResult = await client.session.status({});
      const sessionStatus = statusResult.data?.[sessionId];

      if (sessionStatus?.type === "busy") {
        logInfo(log, "session_busy_aborting", { sessionId, correlationKey });
        await client.session.abort({ path: { id: sessionId } });

        const { stream: abortStream } = await client.event.subscribe();
        const abortDeadline = Date.now() + ABORT_TIMEOUT;
        let aborted = false;

        for await (const event of abortStream) {
          if (Date.now() > abortDeadline) break;
          if (event.type === "session.idle" && event.properties.sessionID === sessionId) {
            aborted = true;
            break;
          }
        }

        if (!aborted) {
          logError(log, "session_abort_timeout", `Session did not idle within ${ABORT_TIMEOUT}ms`, {
            sessionId,
          });
        } else {
          logInfo(log, "session_abort_complete", { sessionId });
        }
      }
    }

    // --- Notes: create or continue into today's file ---
    if (correlationKey) {
      if (resumed) {
        // Session already has full conversation history — no need to inject notes.
        // Roll forward into today's file (back-references the previous day's file).
        const previousNotesPath = findNotesFile(correlationKey);
        if (previousNotesPath) {
          continueNotes({ correlationKey, sessionId, prompt, model, previousNotesPath });
        }
      } else {
        createNotes({ correlationKey, prompt, model, sessionId });
      }
    }

    const parts: TextPartInput[] = [{ type: "text", text: prompt }];
    const modelConfig = model
      ? {
          providerID: model.split("/")[0],
          modelID: model.split("/").slice(1).join("/"),
        }
      : undefined;

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

    // --- NDJSON streaming response ---
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.status(200);

    function emit(event: ProgressEvent): void {
      res.write(JSON.stringify(event) + "\n");
    }

    emit({ type: "start", sessionId, correlationKey, resumed });

    // --- Stream processing ---

    let seq = 0;
    const collectedTextParts: string[] = [];
    const collectedToolCalls: Array<{ tool: string; state: string }> = [];
    const collectedArtifacts: ToolArtifact[] = [];
    let lastMessageId: string | undefined;
    let totalCost = 0;
    const totalTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    let sessionError: string | undefined;
    let finished = false;

    for await (const event of stream) {
      if (finished) break;

      if (!isSessionEvent(event, sessionId)) continue;

      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        seq++;

        // Stdout logging (selective)
        logPartToStdout(sessionId, part);

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
            emit({ type: "tool", tool: toolPart.tool, status });

            // Detect approval-required tool results and emit approval event.
            if (status === "completed") {
              const approval = parseApprovalResult(
                (toolPart.state as ToolStateCompleted).output,
                toolPart.tool,
              );
              if (approval) {
                emit(approval);
              }
            }

            // Collect input/output for aliasable tools
            if (status === "completed" && isAliasableTool(toolPart.tool)) {
              const completed = toolPart.state as ToolStateCompleted;
              collectedArtifacts.push({
                tool: toolPart.tool,
                input: completed.input as Record<string, unknown>,
                output: typeof completed.output === "string" ? completed.output : "",
              });
            }
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

    const durationMs = Date.now() - promptStart;

    // Append summary to the markdown notes file
    if (correlationKey) {
      const responseText =
        collectedTextParts.length > 0 ? collectedTextParts.join("\n\n") : undefined;
      appendSummary({
        correlationKey,
        status: sessionError ? "error" : "completed",
        durationMs,
        toolCalls: collectedToolCalls,
        responsePreview: responseText,
        error: sessionError,
      });

      // Register cross-channel aliases (best-effort)
      if (collectedArtifacts.length > 0) {
        try {
          const aliases = extractAliases(collectedArtifacts);
          for (const { alias, context } of aliases) {
            registerAlias({ correlationKey, alias, context });
            logInfo(log, "alias_registered", { correlationKey, alias });
          }
        } catch (err) {
          logError(
            log,
            "alias_registration_error",
            err instanceof Error ? err.message : String(err),
            {
              correlationKey,
            },
          );
        }
      }
    }

    logInfo(log, "session_done", {
      sessionId,
      status: sessionError ? "error" : "completed",
      textParts: collectedTextParts.length,
      toolCalls: collectedToolCalls.length,
      totalParts: seq,
      durationMs,
    });

    // Final NDJSON event
    emit({
      type: "done",
      sessionId,
      correlationKey,
      resumed,
      status: sessionError ? "error" : "completed",
      ...(sessionError ? { error: sessionError } : {}),
      response: collectedTextParts.join("\n\n"),
      toolCalls: collectedToolCalls,
      messageId: lastMessageId,
      durationMs,
    });
    res.end();
  } catch (err) {
    logError(log, "trigger_error", err);
    if (!res.headersSent) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    } else {
      // Stream already started — emit error event and close
      res.write(
        JSON.stringify({ type: "error", error: err instanceof Error ? err.message : String(err) }) +
          "\n",
      );
      res.end();
    }
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
 * Parse a tool result for approval-required pattern.
 * The proxy returns: "⏳ Approval required for `tool`. Action ID: <uuid>. ..."
 */
const ACTION_ID_PATTERN = /Action ID:\s*([0-9a-f-]{36})/;
const PROXY_PORT_PATTERN = /Proxy-Port:\s*(\d+)/;

function parseApprovalResult(output: string, tool: string): ProgressEvent | undefined {
  if (!output.includes("Approval required")) return undefined;
  const match = output.match(ACTION_ID_PATTERN);
  if (!match) return undefined;
  const portMatch = output.match(PROXY_PORT_PATTERN);
  return {
    type: "approval_required",
    actionId: match[1],
    tool,
    args: {},
    ...(portMatch ? { proxyPort: parseInt(portMatch[1], 10) } : {}),
  };
}

// --- Startup ---

app.listen(PORT, () => {
  logInfo(log, "runner_started", {
    port: PORT,
    opencodeUrl: OPENCODE_URL,
  });
});
