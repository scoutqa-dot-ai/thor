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
import { EventBusRegistry, waitForSessionSettled } from "./event-bus.js";
import { readFileSync } from "node:fs";
import {
  createLogger,
  logInfo,
  logWarn,
  logError,
  truncate,
  createNotes,
  continueNotes,
  appendTrigger,
  appendSummary,
  findNotesFile,
  getSessionIdFromNotes,
  isAliasableTool,
  extractAliases,
  extractThorMeta,
  registerAlias,
  getNotesLineCount,
  isAllowedDirectory,
  createConfigLoader,
  WORKSPACE_CONFIG_PATH,
  extractRepoFromCwd,
} from "@thor/common";
import type { ToolArtifact } from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import { buildToolInstructions } from "./tool-instructions.js";
import { getMemoryProgressEvents } from "./memory-progress.js";

const log = createLogger("runner");

const PORT = parseInt(process.env.PORT || "3000", 10);
const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, "");
const OPENCODE_CONNECT_TIMEOUT = parseInt(process.env.OPENCODE_CONNECT_TIMEOUT || "15000", 10);

/** Timeout for waiting for a busy session to become idle after abort (ms). */
const ABORT_TIMEOUT = parseInt(process.env.ABORT_TIMEOUT || "10000", 10);

/** Memory directory root. */
const MEMORY_DIR = "/workspace/memory";

/** Root memory file — injected into every new or stale session prompt. */
const ROOT_MEMORY_PATH = `${MEMORY_DIR}/README.md`;

const getWorkspaceConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

/** Shared event buses — one SSE connection per directory, dispatches to per-session listeners. */
const eventBuses = new EventBusRegistry(OPENCODE_URL);

/** Read a file, returns trimmed content or undefined. */
function readMemoryFile(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

/** Read root memory file, returns content or undefined. */
function readRootMemory(): string | undefined {
  return readMemoryFile(ROOT_MEMORY_PATH);
}

/** Read per-repo memory file, returns content or undefined. */
function readRepoMemory(directory: string): string | undefined {
  const repo = extractRepoFromCwd(directory);
  if (!repo) return undefined;
  return readMemoryFile(`${MEMORY_DIR}/${repo}/README.md`);
}

function getToolInstructions(directory: string): string | undefined {
  try {
    return buildToolInstructions(getWorkspaceConfig(), directory);
  } catch {
    return undefined;
  }
}

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
  /** If true (default), abort a busy session before sending the prompt.
   *  If false, return {busy: true} without aborting. */
  interrupt: z.boolean().optional(),
  /** Working directory for the OpenCode session. */
  directory: z.string(),
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

/**
 * Binaries available in the opencode image. If a bash command's first token is one
 * of these, we show the binary (with the configured token depth, e.g. `git checkout`);
 * otherwise we fall back to "bash" so noise like `TEXT_FILE="$(mktemp ...)"` or
 * `cd x && ...` doesn't leak into the progress line.
 *
 * Three sources:
 *   1. Thor wrappers COPY'd from docker/opencode/bin/ → /usr/local/bin
 *   2. Explicitly installed in the `opencode` Dockerfile stage (apt, npm -g, pip, curl)
 *   3. Common coreutils from the node:22-slim base image
 */
const KNOWN_BINS: Record<string, number> = {
  // Thor wrappers (docker/opencode/bin/)
  approval: 2,
  corepack: 2,
  gh: 2,
  git: 2,
  langfuse: 4,
  ldcli: 2,
  mcp: 3,
  metabase: 2,
  npm: 2,
  npx: 2,
  pnpm: 2,
  pnpx: 2,
  sandbox: 2,
  scoutqa: 2,
  "slack-upload": 1,

  // Explicitly installed in the opencode Dockerfile stage
  curl: 1,
  jq: 1,
  node: 1,
  perl: 1,
  pip3: 2,
  prettier: 1,
  python3: 2,
  rg: 1,
  ruff: 2,
  shfmt: 1,

  // Coreutils from node:22-slim worth distinguishing from "bash"
  awk: 1,
  cat: 1,
  cp: 1,
  diff: 1,
  find: 1,
  grep: 1,
  gunzip: 1,
  gzip: 1,
  head: 1,
  ls: 1,
  mkdir: 1,
  mktemp: 1,
  mv: 1,
  rm: 1,
  sed: 1,
  tail: 1,
  tar: 1,
  wc: 1,
};

/**
 * Extract a short display name from a tool part.
 * For bash, show the wrapper binary (e.g. "git checkout") when the command starts
 * with one of our known wrappers; otherwise show "bash".
 */
function toolDisplayName(toolPart: ToolPart): string {
  if (toolPart.tool !== "bash") return toolPart.tool;

  const input = toolPart.state.input as { command?: string } | undefined;
  const command = input?.command;
  if (!command) return "bash";

  const parts = command.trimStart().split(/\s+/);
  const cmd = parts[0];
  if (!cmd) return "bash";

  const depth = KNOWN_BINS[cmd];
  if (depth === undefined) return "bash";
  return parts.slice(0, depth).join(" ");
}

function emitMemoryEventsFromToolPart(
  toolPart: ToolPart,
  emit: (event: ProgressEvent) => void,
): void {
  const status = toolPart.state.status;
  const input = (toolPart.state as { input?: unknown }).input;
  for (const event of getMemoryProgressEvents({ tool: toolPart.tool, status, input })) {
    emit(event);
  }
}

/** Log a part to stdout if it's interesting. */
function logPartToStdout(sessionId: string, part: Part): void {
  const sid = sessionId.slice(0, 12);

  if (part.type === "tool") {
    const toolPart = part as ToolPart;
    const status = toolPart.state.status;
    const tool = toolDisplayName(toolPart);

    if (status === "completed") {
      const completed = toolPart.state as ToolStateCompleted;
      const durationMs = completed.time.end - completed.time.start;
      const extra: Record<string, unknown> = {
        sessionId: sid,
        tool,
        durationMs,
      };
      // For long-running tools (task, bash), include an output snippet to aid debugging.
      if (toolPart.tool === "task" || durationMs > 60_000) {
        const raw = typeof completed.output === "string" ? completed.output : "";
        if (raw.length > 0) {
          extra.outputSnippet = truncate(raw, 400);
        }
      }
      logInfo(log, "tool_completed", extra);
    } else if (status === "error") {
      const errState = toolPart.state as ToolStateError;
      logWarn(log, "tool_error", {
        sessionId: sid,
        tool,
        error: String(errState.error),
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

  let { prompt, model, correlationKey, sessionId: requestedSessionId, directory } = parsed.data;

  try {
    await ensureOpencodeAvailable();

    const sessionDirectory = directory;
    if (!isAllowedDirectory(sessionDirectory)) {
      logError(
        log,
        "directory_not_allowed",
        `Directory not under allowed prefix: ${sessionDirectory}`,
        {
          directory: sessionDirectory,
          correlationKey,
        },
      );
      res.status(400).json({ error: `Directory not allowed: ${sessionDirectory}` });
      return;
    }

    const client = createOpencodeClient({
      baseUrl: OPENCODE_URL,
      directory: sessionDirectory,
    });

    // --- Session resolution: resume existing or create new ---
    let sessionId: string;
    let resumed = false;
    let previousNotesPath: string | undefined;

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
        // Session is gone — create a new one and prepend a resumption hint
        logInfo(log, "session_stale", { sessionId: candidateSessionId, correlationKey });

        if (correlationKey) {
          previousNotesPath = findNotesFile(correlationKey);
          if (previousNotesPath) {
            const lineCount = getNotesLineCount(previousNotesPath);
            prompt = `[Previous session was lost. Your notes from the prior session are at: ${previousNotesPath} (${lineCount} lines) — read it if you need context.]\n\n${prompt}`;
            logInfo(log, "resumption_hint", { previousNotesPath, lineCount, correlationKey });
          }
        }

        const session = await client.session.create({
          body: {},
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
        body: {},
      });
      if (!session.data) {
        res.status(500).json({ error: "Failed to create session" });
        return;
      }
      sessionId = session.data.id;
      logInfo(log, "session_created", { sessionId, correlationKey });
    }

    // --- If resuming a busy session, abort or bail ---
    if (resumed) {
      const statusResult = await client.session.status({});
      const sessionStatus = statusResult.data?.[sessionId];

      if (sessionStatus?.type === "busy") {
        // Non-interrupt triggers don't abort — return busy so gateway can re-enqueue.
        const shouldInterrupt = parsed.data.interrupt === true;
        if (!shouldInterrupt) {
          logInfo(log, "session_busy_nointerrupt", { sessionId, correlationKey });
          res.json({ busy: true });
          return;
        }

        logInfo(log, "session_busy_aborting", { sessionId, correlationKey });
        await client.session.abort({ path: { id: sessionId } });

        const abortSub = await eventBuses.subscribe(sessionDirectory, [sessionId]);
        const aborted = await waitForSessionSettled(abortSub, ABORT_TIMEOUT);
        abortSub.close();

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
        const existingNotes = findNotesFile(correlationKey);
        if (existingNotes) {
          // continueNotes creates a new today-file with Follow-up header when
          // rolling forward from a previous day; no-op if today's file exists.
          const created = continueNotes({
            correlationKey,
            sessionId,
            prompt,
            model,
            previousNotesPath: existingNotes,
          });
          if (!created) {
            // Same-day resume — today's file already existed, append follow-up.
            appendTrigger({ correlationKey, prompt, model });
          }
        }
      } else {
        createNotes({ correlationKey, prompt, model, sessionId });
      }
    }

    const bootstrapMemoryPaths: string[] = [];

    // --- Memory: inject into new or stale sessions ---
    if (!resumed) {
      const rootMemory = readRootMemory();
      if (rootMemory) {
        prompt = `[Root memory — important context from prior sessions]\n${rootMemory}\n\n${prompt}`;
        bootstrapMemoryPaths.push(ROOT_MEMORY_PATH);
      } else {
        prompt = `[Root memory: none yet — write to ${ROOT_MEMORY_PATH} to persist cross-repo context]\n\n${prompt}`;
      }

      // Per-repo memory: inject repo-specific context
      const repo = extractRepoFromCwd(sessionDirectory);
      if (repo) {
        const repoMemoryPath = `${MEMORY_DIR}/${repo}/README.md`;
        const repoMemory = readRepoMemory(sessionDirectory);
        if (repoMemory) {
          prompt = `[Repo memory — context for ${repo}]\n${repoMemory}\n\n${prompt}`;
          bootstrapMemoryPaths.push(repoMemoryPath);
        } else {
          prompt = `[Repo memory: none yet — write to ${repoMemoryPath} to persist per-repo context]\n\n${prompt}`;
        }
      }

      // Tool instructions: inject MCP tool list from config
      const toolInstructions = getToolInstructions(sessionDirectory);
      if (toolInstructions) {
        prompt = `${toolInstructions}\n\n${prompt}`;
        logInfo(log, "tool_instructions_injected", { directory: sessionDirectory });
      }
    }

    // --- Correlation key: inject into every prompt so the agent always knows its own key ---
    if (correlationKey) {
      prompt = `[correlation-key: ${correlationKey}]\n\n${prompt}`;
    }

    const parts: TextPartInput[] = [{ type: "text", text: prompt }];
    const modelConfig = model
      ? {
          providerID: model.split("/")[0],
          modelID: model.split("/").slice(1).join("/"),
        }
      : undefined;

    // Subscribe to event bus BEFORE sending the prompt
    const subscription = await eventBuses.subscribe(sessionDirectory, [sessionId]);

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
      logInfo(log, "progress_emit", {
        sessionId,
        type: event.type,
        ...(event.type === "tool" ? { tool: event.tool } : {}),
        ...(event.type === "memory"
          ? { action: event.action, path: event.path, source: event.source }
          : {}),
        ...(event.type === "delegate"
          ? { agent: event.agent, description: event.description }
          : {}),
        ...(event.type === "done"
          ? { status: event.status, durationMs: (event as { durationMs?: number }).durationMs }
          : {}),
        ts: Date.now(),
      });
      res.write(JSON.stringify(event) + "\n");
    }

    emit({
      type: "start",
      sessionId,
      correlationKey,
      resumed,
      ...(previousNotesPath ? { previousNotesPath } : {}),
    });

    for (const path of bootstrapMemoryPaths) {
      emit({ type: "memory", action: "read", path, source: "bootstrap" });
    }

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

    // Track child session IDs for progress forwarding.
    const childSessionIds = new Set<string>();

    await withNdjsonHeartbeat(emit, async () => {
      for await (const event of subscription) {
        if (finished) break;

        const isParent = isSessionEvent(event, sessionId);

        // Forward tool progress from child sessions so
        // Slack progress isn't silent while a task runs.
        if (!isParent) {
          if (
            event.type === "message.part.updated" &&
            childSessionIds.has(event.properties.part.sessionID)
          ) {
            const part = event.properties.part;
            if (part.type === "tool") {
              const toolPart = part as ToolPart;
              const status = toolPart.state.status;
              if (status === "completed" || status === "error") {
                const displayName = toolDisplayName(toolPart);
                emit({ type: "tool", tool: displayName, status });
                emitMemoryEventsFromToolPart(toolPart, emit);
              }
            }
          }
          continue;
        }

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

            // Discover child sessions when a task tool starts running.
            if (toolPart.tool === "task" && status === "running") {
              client.session
                .children({ path: { id: sessionId } })
                .then((resp) => {
                  if (resp.data) {
                    for (const child of resp.data) {
                      childSessionIds.add(child.id);
                      subscription.addSessionId(child.id);
                    }
                  }
                })
                .catch(() => {});
            }

            if (status === "completed" || status === "error") {
              const displayName = toolDisplayName(toolPart);
              collectedToolCalls.push({ tool: displayName, state: status });
              emit({ type: "tool", tool: displayName, status });
              emitMemoryEventsFromToolPart(toolPart, emit);

              // Detect approval-required tool results and emit approval event.
              if (status === "completed") {
                const completed = toolPart.state as ToolStateCompleted;
                const approval = parseApprovalResult(
                  completed.output,
                  toolPart.tool,
                  (completed.input as Record<string, unknown>) ?? {},
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
          } else if (part.type === "subtask") {
            const subtaskPart = part as Part & {
              type: "subtask";
              description: string;
              agent: string;
            };
            const description = subtaskPart.description?.trim();
            emit({
              type: "delegate",
              agent: subtaskPart.agent,
              ...(description ? { description } : {}),
            });
          }
        } else if (event.type === "session.error") {
          const errorProps = event.properties;
          sessionError =
            errorProps.error && "data" in errorProps.error
              ? (errorProps.error.data as { message?: string }).message || errorProps.error.name
              : "Unknown error";
          logError(log, "session_error", sessionError, {
            sessionId,
            errorDetail: JSON.stringify(errorProps.error),
          });
          finished = true;
          break;
        } else if (event.type === "session.idle") {
          finished = true;
          break;
        }
      }
    });
    subscription.close();

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
 * Run `fn` while a heartbeat keeps the NDJSON response stream alive.
 * Sends a typed heartbeat event every 30s to prevent idle-connection
 * timeouts; the heartbeat is always cleared on exit.
 */
async function withNdjsonHeartbeat<T>(
  emit: (event: ProgressEvent) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const id = setInterval(() => emit({ type: "heartbeat" }), 30_000);
  try {
    return await fn();
  } finally {
    clearInterval(id);
  }
}

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
 * Parse a tool result for approval-required signal.
 * remote-cli emits a [thor:meta] line with { type: "approval", actionId, proxyName, tool }.
 */
function parseApprovalResult(
  output: string,
  tool: string,
  args: Record<string, unknown>,
): ProgressEvent | undefined {
  for (const meta of extractThorMeta(output)) {
    if (meta.type === "approval") {
      return {
        type: "approval_required",
        actionId: meta.actionId,
        tool,
        args,
        proxyName: meta.proxyName,
      };
    }
  }
  return undefined;
}

// --- Startup ---

app.listen(PORT, () => {
  logInfo(log, "runner_started", {
    port: PORT,
    opencodeUrl: OPENCODE_URL,
  });
});
