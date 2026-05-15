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
import { randomUUID } from "node:crypto";
import {
  createLogger,
  logInfo,
  logWarn,
  logError,
  truncate,
  isAllowedDirectory,
  createConfigLoader,
  WORKSPACE_CONFIG_PATH,
  extractRepoFromCwd,
  ANCHOR_LOCK_PREFIX,
  SESSION_LOCK_PREFIX,
  appendSessionEvent,
  appendAlias,
  appendCorrelationAliasForAnchor,
  currentSessionForAnchor,
  ensureAnchorForCorrelationKey,
  isUuidV7,
  mintAnchor,
  mintTriggerId,
  reverseLookupAnchor,
  resolveAlias,
  resolveAnchorForCorrelationKey,
  resolveCorrelationLockKey,
  readTriggerSlice,
  sessionLogPath,
  getWorklogDir,
  SessionEventLogRecordSchema,
  loadRunnerEnv,
  matchesInternalSecret,
  ProgressApprovalRequiredSchema,
  withKeyLock,
} from "@thor/common";
import type { ReverseAnchorEntry, SessionEventLogRecord } from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import { buildToolInstructions } from "./tool-instructions.js";
import { getMemoryProgressEvents } from "./memory-progress.js";
import { pathToFileURL } from "node:url";

const log = createLogger("runner");

const config = loadRunnerEnv();
const PORT = config.port;
const OPENCODE_URL = config.opencodeUrl;
const OPENCODE_CONNECT_TIMEOUT = config.opencodeConnectTimeout;
const INTERNAL_SECRET_HEADER = "x-thor-internal-secret";
const ABORT_TIMEOUT = config.abortTimeout;
const SESSION_ERROR_GRACE_MS = config.sessionErrorGraceMs;

/** Memory directory root. */
const MEMORY_DIR = "/workspace/memory";

const TaskDelegateInputSchema = z.object({
  subagent_type: z.string().trim().min(1),
});

const getWorkspaceConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

/** Shared event bus — one global SSE connection, dispatches to per-session listeners. */
const defaultEventBuses = new EventBusRegistry(OPENCODE_URL);

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

export interface RunnerAppOptions {
  opencodeUrl?: string;
  memoryDir?: string;
  eventBuses?: EventBusRegistry;
  createClient?: (opts: { baseUrl: string; directory: string }) => OpencodeClient;
  isOpencodeReachable?: () => Promise<boolean>;
  ensureOpencodeAvailable?: () => Promise<void>;
}

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
function readRootMemory(memoryDir = MEMORY_DIR): string | undefined {
  return readMemoryFile(`${memoryDir}/README.md`);
}

/** Read per-repo memory file, returns content or undefined. */
function readRepoMemory(directory: string, memoryDir = MEMORY_DIR): string | undefined {
  const repo = extractRepoFromCwd(directory);
  if (!repo) return undefined;
  return readMemoryFile(`${memoryDir}/${repo}/README.md`);
}

function getToolInstructions(directory: string): string | undefined {
  try {
    return buildToolInstructions(getWorkspaceConfig(), directory);
  } catch {
    return undefined;
  }
}

function unwrap(result: { ok: true } | { ok: false; error: Error }): void {
  if (!result.ok) throw result.error;
}

/**
 * In-flight trigger registry. Drives reliable trigger_end emission across normal
 * completion, caught throws, user-initiated aborts, and graceful shutdown.
 */
const inflightTriggers = new Map<string, { sessionId: string; startTime: number }>();

function startTrigger(
  sessionId: string,
  triggerId: string,
  payload: { correlationKey?: string; promptPreview?: string },
): void {
  unwrap(
    appendSessionEvent(sessionId, {
      type: "trigger_start",
      triggerId,
      ...(payload.correlationKey ? { correlationKey: payload.correlationKey } : {}),
      promptPreview: payload.promptPreview ?? "",
    }),
  );
  inflightTriggers.set(triggerId, { sessionId, startTime: Date.now() });
}

function endTrigger(
  triggerId: string,
  status: "completed" | "error" | "aborted",
  extras: { error?: string; reason?: string } = {},
): void {
  const entry = inflightTriggers.get(triggerId);
  if (!entry) return;
  inflightTriggers.delete(triggerId);
  const result = appendSessionEvent(entry.sessionId, {
    type: "trigger_end",
    triggerId,
    status,
    durationMs: Date.now() - entry.startTime,
    ...extras,
  });
  if (!result.ok) {
    logError(log, "trigger_end_write_failed", result.error.message, {
      sessionId: entry.sessionId,
      triggerId,
      status,
    });
  }
}

function findInflightTriggerForSession(sessionId: string): string | undefined {
  for (const [triggerId, entry] of inflightTriggers) {
    if (entry.sessionId === sessionId) return triggerId;
  }
  return undefined;
}

/**
 * Best-effort: emit trigger_end{status:'aborted', reason:'shutdown'} for every
 * still-open trigger this process owns. Captures graceful Docker stop / k8s
 * rolling restart. Does NOT cover SIGKILL/OOM/segfault. Exported for tests.
 */
export function flushInflightTriggersOnShutdown(): void {
  for (const [triggerId, entry] of inflightTriggers) {
    appendSessionEvent(entry.sessionId, {
      type: "trigger_end",
      triggerId,
      status: "aborted",
      reason: "shutdown",
      durationMs: Date.now() - entry.startTime,
    });
  }
  inflightTriggers.clear();
}

/**
 * Per-correlation-key advisory lock around resolve+create. Prevents two
 * concurrent triggers with the same correlationKey from creating duplicate
 * sessions. Sequenced as a chained promise per key (single-process).
 */
const correlationKeyLocks = new Map<string, Promise<unknown>>();

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

function resolveOwnerSessionForTrigger(
  anchorId: string,
  triggerId: string,
): { ok: true; sessionId: string } | { ok: false; reason: "not_found" | "oversized" } {
  const reverse = reverseLookupAnchor(anchorId);
  for (const sessionId of reverse.sessionIds) {
    const slice = readTriggerSlice(sessionId, triggerId);
    if ("oversized" in slice) return { ok: false, reason: "oversized" };
    if (!("notFound" in slice)) return { ok: true, sessionId };
  }
  return { ok: false, reason: "not_found" };
}

const E2eTriggerContextSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  correlationKey: z.string().trim().min(1).optional(),
  promptPreview: z.string().trim().min(1).optional(),
});

// --- Express app ---

export function createRunnerApp(options: RunnerAppOptions = {}): express.Express {
  const app = express();
  app.use(express.json());
  const opencodeUrl = options.opencodeUrl ?? OPENCODE_URL;
  const memoryDir = options.memoryDir ?? MEMORY_DIR;
  const eventBuses = options.eventBuses ?? defaultEventBuses;
  const createClient = options.createClient ?? createOpencodeClient;
  const checkOpencodeReachable = options.isOpencodeReachable ?? isOpencodeReachable;
  const waitForOpencode = options.ensureOpencodeAvailable ?? ensureOpencodeAvailable;

  function routeParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  }

  app.get("/health", async (_req, res) => {
    const opencodeHealthy = await checkOpencodeReachable();

    res.json({
      status: "ok",
      service: "runner",
      opencode: opencodeHealthy ? "connected" : "disconnected",
      opencodeUrl,
    });
  });

  if (process.env.THOR_E2E_TEST_HELPERS === "1") {
    // Rate limiting for this opt-in CI-only helper is intentionally enforced at
    // the infrastructure/test harness boundary, not in the app process.
    // codeql[js/missing-rate-limiting]
    // lgtm[js/missing-rate-limiting]
    app.post(
      "/internal/e2e/trigger-context",
      // codeql[js/missing-rate-limiting]
      // lgtm[js/missing-rate-limiting]
      (req, res) => {
        if (
          !matchesInternalSecret(
            process.env.THOR_INTERNAL_SECRET || "",
            req.get(INTERNAL_SECRET_HEADER) ?? undefined,
          )
        ) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        const parsed = E2eTriggerContextSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
          return;
        }

        const sessionId = parsed.data.sessionId ?? `e2e-${randomUUID()}`;
        const triggerId = mintTriggerId();
        const anchorId = mintAnchor();
        unwrap(
          appendAlias({
            aliasType: "opencode.session",
            aliasValue: sessionId,
            anchorId,
          }),
        );
        unwrap(
          appendSessionEvent(sessionId, {
            type: "trigger_start",
            triggerId,
            ...(parsed.data.correlationKey ? { correlationKey: parsed.data.correlationKey } : {}),
            promptPreview: parsed.data.promptPreview ?? "e2e approval disclaimer context",
          }),
        );
        res.json({ sessionId, triggerId, anchorId });
      },
    );
  }

  // Rate limiting for the Vouch-gated runner viewer is intentionally enforced
  // at the infrastructure edge, not in the app process.
  // codeql[js/missing-rate-limiting]
  // lgtm[js/missing-rate-limiting]
  app.get(
    "/runner/v/:anchorId/:triggerId",
    // codeql[js/missing-rate-limiting]
    // lgtm[js/missing-rate-limiting]
    (req, res) => {
      if (!req.get("X-Vouch-User")) {
        res
          .status(401)
          .type("html")
          .send(renderPage("Unauthorized", "Sign in with Vouch to view Thor trigger history."));
        return;
      }
      const anchorId = routeParam(req.params.anchorId);
      const triggerId = routeParam(req.params.triggerId);

      if (!isUuidV7(anchorId) || !isUuidV7(triggerId)) {
        res
          .status(404)
          .type("html")
          .send(
            renderPage("Trigger not found", "No Thor trigger slice was found for this anchor."),
          );
        return;
      }

      const owner = resolveOwnerSessionForTrigger(anchorId, triggerId);
      if (!owner.ok) {
        if (owner.reason === "oversized") {
          res
            .type("html")
            .send(
              renderPage(
                "Slice truncated",
                "<p>This session log is oversized for display. Engineers needing the bytes can read the JSONL directly from the worklog volume.</p>",
              ),
            );
          return;
        }
        res
          .status(404)
          .type("html")
          .send(
            renderPage("Trigger not found", "No Thor trigger slice was found for this anchor."),
          );
        return;
      }

      let slice;
      try {
        slice = readTriggerSlice(owner.sessionId, triggerId);
      } catch {
        res
          .status(404)
          .type("html")
          .send(
            renderPage("Trigger not found", "No Thor trigger slice was found for this anchor."),
          );
        return;
      }
      if ("notFound" in slice) {
        res
          .status(404)
          .type("html")
          .send(
            renderPage("Trigger not found", "No Thor trigger slice was found for this anchor."),
          );
        return;
      }
      if ("oversized" in slice) {
        res
          .type("html")
          .send(
            renderPage(
              "Slice truncated",
              "<p>This session log is oversized for display. Engineers needing the bytes can read the JSONL directly from the worklog volume.</p>",
            ),
          );
        return;
      }
      res
        .type("html")
        .send(
          renderSlicePage(
            anchorId,
            triggerId,
            owner.sessionId,
            reverseLookupAnchor(anchorId),
            slice,
            { slackTeamId: process.env.SLACK_TEAM_ID?.trim() || null },
          ),
        );
    },
  );

  // --- Trigger endpoint ---

  const TriggerRequestSchema = z.object({
    prompt: z.string(),
    model: z.string().optional(),
    /** Correlation key for session continuity. Same key = same OpenCode session. */
    correlationKey: z.string().optional(),
    /** Direct session ID to resume (bypasses correlation key lookup). */
    sessionId: z.string().optional(),
    /** If true, abort a busy session before sending the prompt.
     *  Defaults to false: return {busy: true} without aborting. */
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

  function sessionErrorMessage(error: unknown): string {
    if (!error || typeof error !== "object") return "Unknown error";

    const candidate = error as {
      name?: string;
      message?: string;
      data?: { name?: string; message?: string };
    };

    return (
      candidate.data?.message ||
      candidate.message ||
      candidate.data?.name ||
      candidate.name ||
      "Unknown error"
    );
  }

  async function nextWithTimeout(
    iterator: AsyncIterator<Event>,
    timeoutMs: number,
  ): Promise<IteratorResult<Event> | "timeout"> {
    if (timeoutMs <= 0) return "timeout";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        iterator.next(),
        new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
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
      const retryPart = part as Part & {
        type: "retry";
        attempt: number;
        error: { message: string };
      };
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
   * 4. Streams until `session.idle`; `session.error` is reported as progress and becomes
   *    terminal only if no recovery activity arrives within `SESSION_ERROR_GRACE_MS`.
   * 5. Returns the aggregated response to the HTTP caller.
   */
  app.post("/trigger", async (req, res) => {
    const parsed = TriggerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    let { prompt, model, correlationKey, sessionId: requestedSessionId, directory } = parsed.data;
    const userPromptPreview = truncate(prompt, 500);
    let inflightTriggerId: string | undefined;

    try {
      await waitForOpencode();

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

      const client = createClient({
        baseUrl: opencodeUrl,
        directory: sessionDirectory,
      });

      if (!requestedSessionId && correlationKey) {
        await ensureAnchorForCorrelationKey(correlationKey);
      }

      // --- Session resolution: resolve-or-mint anchor, then resume or create OpenCode session ---
      const lockKey = requestedSessionId
        ? `${SESSION_LOCK_PREFIX}${requestedSessionId}`
        : correlationKey
          ? resolveCorrelationLockKey(correlationKey)
          : undefined;
      const resolveSession = async () => {
        let anchorId: string;
        if (requestedSessionId) {
          anchorId =
            resolveAlias({
              aliasType: "opencode.session",
              aliasValue: requestedSessionId,
            }) ?? mintAnchor();
        } else if (correlationKey) {
          const existing = resolveAnchorForCorrelationKey(correlationKey);
          if (existing) {
            anchorId = existing;
          } else {
            anchorId = mintAnchor();
            unwrap(appendCorrelationAliasForAnchor(anchorId, correlationKey));
          }
        } else {
          anchorId = mintAnchor();
        }

        const candidateSessionId = requestedSessionId || currentSessionForAnchor(anchorId);

        let id: string;
        let didResume = false;

        if (candidateSessionId) {
          try {
            const existing = await client.session.get({ path: { id: candidateSessionId } });
            if (existing.data) {
              id = candidateSessionId;
              didResume = true;
              logInfo(log, "session_resumed", { sessionId: id, anchorId, correlationKey });
            } else {
              throw new Error("Session not found");
            }
          } catch {
            logInfo(log, "session_stale", {
              sessionId: candidateSessionId,
              anchorId,
              correlationKey,
            });
            const session = await client.session.create({ body: {} });
            if (!session.data) throw new Error("Failed to create session");
            id = session.data.id;
            logInfo(log, "session_created", { sessionId: id, anchorId, correlationKey });
          }
        } else {
          const session = await client.session.create({ body: {} });
          if (!session.data) throw new Error("Failed to create session");
          id = session.data.id;
          logInfo(log, "session_created", { sessionId: id, anchorId, correlationKey });
        }

        // session_stale recreate appends a fresh opencode.session alongside
        // the old; original Slack/git aliases keep pointing at the same anchor.
        if (resolveAlias({ aliasType: "opencode.session", aliasValue: id }) !== anchorId) {
          unwrap(appendAlias({ aliasType: "opencode.session", aliasValue: id, anchorId }));
        }

        if (correlationKey && resolveAnchorForCorrelationKey(correlationKey) !== anchorId) {
          unwrap(appendCorrelationAliasForAnchor(anchorId, correlationKey));
        }

        return { sessionId: id, resumed: didResume, anchorId };
      };
      const resolution = await (lockKey
        ? withKeyLock(correlationKeyLocks, lockKey, resolveSession)
        : resolveSession());

      const sessionId = resolution.sessionId;
      const resumed = resolution.resumed;
      const anchorId = resolution.anchorId;

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

          // End any in-flight trigger this process owns for the session before aborting,
          // so the prior trigger renders as `aborted` rather than `completed`.
          const priorTriggerId = findInflightTriggerForSession(sessionId);
          if (priorTriggerId) {
            endTrigger(priorTriggerId, "aborted", { reason: "user_interrupt" });
          }

          logInfo(log, "session_busy_aborting", { sessionId, correlationKey });
          await client.session.abort({ path: { id: sessionId } });

          const abortSub = await eventBuses.subscribe([sessionId]);
          const aborted = await waitForSessionSettled(abortSub, ABORT_TIMEOUT);
          abortSub.close();

          if (!aborted) {
            logError(
              log,
              "session_abort_timeout",
              `Session did not idle within ${ABORT_TIMEOUT}ms`,
              { sessionId },
            );
            res.status(503).json({ error: "Session abort did not settle", sessionId });
            return;
          }
          logInfo(log, "session_abort_complete", { sessionId });
        }
      }

      const bootstrapMemoryPaths: string[] = [];

      // --- Memory: inject into new or stale sessions ---
      if (!resumed) {
        const rootMemory = readRootMemory(memoryDir);
        if (rootMemory) {
          prompt = `[Root memory — important context from prior sessions]\n${rootMemory}\n\n${prompt}`;
          bootstrapMemoryPaths.push(`${memoryDir}/README.md`);
        } else {
          prompt = `[Root memory: none yet — write to ${memoryDir}/README.md to persist cross-repo context]\n\n${prompt}`;
        }

        // Per-repo memory: inject repo-specific context
        const repo = extractRepoFromCwd(sessionDirectory);
        if (repo) {
          const repoMemoryPath = `${memoryDir}/${repo}/README.md`;
          const repoMemory = readRepoMemory(sessionDirectory, memoryDir);
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
      const subscription = await eventBuses.subscribe([sessionId]);

      const triggerId = mintTriggerId();
      inflightTriggerId = triggerId;
      startTrigger(sessionId, triggerId, {
        correlationKey,
        promptPreview: userPromptPreview,
      });

      const promptStart = Date.now();
      const asyncResult = await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts,
          ...(modelConfig ? { model: modelConfig } : {}),
        },
      });

      if (asyncResult.error) {
        endTrigger(triggerId, "error", { error: JSON.stringify(asyncResult.error) });
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
          ...(event.type === "delegate" ? { agent: event.agent } : {}),
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
      });

      for (const path of bootstrapMemoryPaths) {
        emit({ type: "memory", action: "read", path, source: "bootstrap" });
      }

      // --- Stream processing ---

      let seq = 0;
      const collectedTextParts: string[] = [];
      const collectedToolCalls: Array<{ tool: string; state: string }> = [];
      let lastMessageId: string | undefined;
      let totalCost = 0;
      const totalTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      let terminalError: string | undefined;
      let latestSessionError: string | undefined;
      let latestSessionErrorSeq: number | undefined;
      let latestSessionErrorAt: number | undefined;
      let finished = false;

      // Track child session IDs for progress forwarding.
      const childSessionIds = new Set<string>();
      // Dedupe task delegate emissions across repeated part updates.
      const emittedTaskDelegates = new Set<string>();
      // Dedupe tool progress emissions — emit once per call when it starts running.
      const emittedToolStarts = new Set<string>();

      function emitToolProgress(
        toolPart: ToolPart,
        status: "running" | "completed" | "error",
      ): void {
        const key = [toolPart.sessionID, toolPart.messageID, toolPart.callID].join("|");
        if (emittedToolStarts.has(key)) return;
        emittedToolStarts.add(key);
        const displayName = toolDisplayName(toolPart);
        emit({ type: "tool", tool: displayName, status });
      }

      function emitTaskDelegateProgress(toolPart: ToolPart): void {
        if (toolPart.tool !== "task") return;

        const input = (toolPart.state as { input?: unknown }).input;
        const parsed = TaskDelegateInputSchema.safeParse(input);
        if (!parsed.success) return;

        const key = [toolPart.sessionID, toolPart.messageID, toolPart.callID].join("|");
        if (emittedTaskDelegates.has(key)) return;
        emittedTaskDelegates.add(key);

        const { subagent_type: agent } = parsed.data;
        emit({
          type: "delegate",
          agent,
        });
      }

      await withNdjsonHeartbeat(emit, async () => {
        const iterator = subscription[Symbol.asyncIterator]();
        try {
          while (!finished) {
            const remainingSessionErrorGraceMs = latestSessionErrorAt
              ? SESSION_ERROR_GRACE_MS - (Date.now() - latestSessionErrorAt)
              : undefined;
            const next = latestSessionError
              ? await nextWithTimeout(
                  iterator,
                  remainingSessionErrorGraceMs ?? SESSION_ERROR_GRACE_MS,
                )
              : await iterator.next();

            if (next === "timeout") {
              terminalError = latestSessionError;
              finished = true;
              break;
            }
            if (next.done) {
              terminalError = latestSessionError;
              break;
            }

            const event = next.value;
            if (finished) break;

            // Child sub-session events land in the child's own log so the
            // viewer's owner-only slice never surfaces them.
            const originSessionId = eventSessionId(event) ?? sessionId;
            unwrap(appendSessionEvent(originSessionId, { type: "opencode_event", event }));

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
                  emitTaskDelegateProgress(toolPart);
                  const status = toolPart.state.status;
                  if (status === "running") {
                    emitToolProgress(toolPart, "running");
                  } else if (status === "completed" || status === "error") {
                    emitToolProgress(toolPart, status);
                    emitMemoryEventsFromToolPart(toolPart, emit);
                  }
                }
              }
              continue;
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part;
              seq++;

              if (latestSessionErrorSeq !== undefined && seq > latestSessionErrorSeq) {
                latestSessionError = undefined;
                latestSessionErrorSeq = undefined;
                latestSessionErrorAt = undefined;
              }

              // Stdout logging (selective)
              logPartToStdout(sessionId, part);

              // Accumulate data for response regardless of filtering
              if (part.type === "text") {
                const textPart = part as TextPart;
                collectedTextParts.push(textPart.text);
                lastMessageId = textPart.messageID;
              } else if (part.type === "tool") {
                const toolPart = part as ToolPart;
                emitTaskDelegateProgress(toolPart);
                const status = toolPart.state.status;

                // Discover child sessions when a task tool starts running.
                if (toolPart.tool === "task" && status === "running") {
                  client.session
                    .children({ path: { id: sessionId } })
                    .then((resp) => {
                      if (!resp.data) return;
                      for (const child of resp.data) {
                        if (childSessionIds.has(child.id)) continue;
                        childSessionIds.add(child.id);
                        subscription.addSessionId(child.id);
                        const aliasResult = appendAlias({
                          aliasType: "opencode.subsession",
                          aliasValue: child.id,
                          anchorId,
                        });
                        if (!aliasResult.ok) {
                          logError(
                            log,
                            "opencode_subsession_alias_write_failed",
                            aliasResult.error.message,
                            { sessionId, anchorId, childId: child.id },
                          );
                        }
                      }
                    })
                    .catch((err) => {
                      logError(
                        log,
                        "child_session_discovery_failed",
                        err instanceof Error ? err.message : String(err),
                        { sessionId, anchorId },
                      );
                    });
                }

                if (status === "running") {
                  emitToolProgress(toolPart, "running");
                }

                if (status === "completed" || status === "error") {
                  const displayName = toolDisplayName(toolPart);
                  collectedToolCalls.push({ tool: displayName, state: status });
                  emitToolProgress(toolPart, status);
                  emitMemoryEventsFromToolPart(toolPart, emit);

                  // Detect approval-required tool results and emit approval event.
                  if (status === "completed") {
                    const completed = toolPart.state as ToolStateCompleted;
                    const approval = parseApprovalResult(completed.output);
                    if (approval) {
                      emit(approval);
                    }
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
              const errorMessage = sessionErrorMessage(errorProps.error);
              latestSessionError = errorMessage;
              latestSessionErrorSeq = seq;
              latestSessionErrorAt = Date.now();
              collectedToolCalls.push({ tool: "error", state: "error" });
              emit({ type: "tool", tool: "error", status: "error" });
              logError(log, "session_error", errorMessage, {
                sessionId,
                errorDetail: JSON.stringify(errorProps.error),
              });
            } else if (event.type === "session.idle") {
              terminalError = latestSessionError;
              finished = true;
              break;
            }
          }
        } finally {
          await iterator.return?.();
          subscription.close();
        }
      });

      if (!finished && latestSessionError) {
        terminalError = latestSessionError;
      }

      const durationMs = Date.now() - promptStart;
      endTrigger(
        triggerId,
        terminalError ? "error" : "completed",
        terminalError ? { error: terminalError } : {},
      );

      logInfo(log, "session_done", {
        sessionId,
        status: terminalError ? "error" : "completed",
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
        status: terminalError ? "error" : "completed",
        ...(terminalError ? { error: terminalError } : {}),
        response: collectedTextParts.join("\n\n"),
        toolCalls: collectedToolCalls,
        messageId: lastMessageId,
        durationMs,
      });
      res.end();
    } catch (err) {
      logError(log, "trigger_error", err);
      // Emit trigger_end{status:"error"} so the trigger doesn't render as `in_flight`
      // forever or get superseded into `crashed`. No-op if endTrigger already ran.
      if (inflightTriggerId) {
        endTrigger(inflightTriggerId, "error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!res.headersSent) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        // Stream already started — emit error event and close
        res.write(
          JSON.stringify({
            type: "error",
            error: err instanceof Error ? err.message : String(err),
          }) + "\n",
        );
        res.end();
      }
    }
  });

  return app;
}

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

function eventSessionId(event: Event): string | undefined {
  if (event.type === "message.part.updated") return event.properties.part.sessionID;
  if (
    event.type === "session.idle" ||
    event.type === "session.status" ||
    event.type === "session.error"
  ) {
    return event.properties.sessionID;
  }
  return undefined;
}

function isSessionEvent(event: Event, sessionId: string): boolean {
  return eventSessionId(event) === sessionId;
}

function parseApprovalResult(output: string): ProgressEvent | undefined {
  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(output);
  } catch {
    return undefined;
  }

  const parsed = ProgressApprovalRequiredSchema.safeParse(parsedOutput);
  if (!parsed.success) return undefined;
  return parsed.data;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KNOWN_BINS: Record<string, number> = {
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

type ViewerEvent = { type?: unknown; properties?: Record<string, unknown>; _truncated?: unknown };
type ViewerToolPart = {
  id?: unknown;
  type?: unknown;
  tool?: unknown;
  callID?: unknown;
  cost?: unknown;
  tokens?: unknown;
  reason?: unknown;
  state?: {
    status?: unknown;
    title?: unknown;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    time?: { start?: unknown; end?: unknown };
  };
  text?: unknown;
};

function redactSnippet(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi,
      "[redacted]",
    )
    .replace(/\b(?:xox[baprs]-|gh[pousr]_|github_pat_)[A-Za-z0-9_\-]+/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /(["'])(token|access_token|api_key|password|secret)\1\s*:\s*(["'])(?:(?!\3).)*\3/gi,
      "$1$2$1:$3[redacted]$3",
    )
    .replace(
      /\b(token|access_token|api_key|password|secret)\b\s*:\s*(["'])(?:(?!\2).)*\2/gi,
      "$1:$2[redacted]$2",
    )
    .replace(/\b(token|access_token|api_key|password|secret)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(
      /\b(token|access_token|api_key|password|secret)\b\s*[:=]\s*["']?[^\s,"']+/gi,
      "$1=[redacted]",
    );
}

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function safeSnippet(value: unknown, max = 300): string {
  const text = coerceText(value);
  return (
    redactSnippet(text)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .slice(0, max) + (text.length > max ? "…" : "")
  );
}

function safeMultilineSnippet(value: unknown, max = 1500): string {
  const text = coerceText(value);
  return redactSnippet(text).slice(0, max) + (text.length > max ? "…" : "");
}

/**
 * Compact token formatter: under 1k stays as-is, otherwise truncate (don't
 * round) to one decimal place with a K/M suffix.
 *   5_983     → "5.9K"
 *   583_930   → "583.9K"
 *   4_962_304 → "4.9M"
 */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}K`;
  return `${(Math.floor(n / 100_000) / 10).toFixed(1)}M`;
}

function formatDuration(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const roundedSeconds = Math.round(ms / 100) / 10;
  if (roundedSeconds < 60) return `${roundedSeconds.toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatAge(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return formatDuration(ms);
}

function viewerToolDisplayName(part: ViewerToolPart): string {
  const tool = typeof part.tool === "string" ? part.tool : "tool";
  if (tool !== "bash") return tool;
  const input = part.state?.input;
  const command =
    input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
  if (typeof command !== "string") return "bash";
  const parts = command.trimStart().split(/\s+/);
  const depth = KNOWN_BINS[parts[0] ?? ""];
  return depth === undefined ? "bash" : parts.slice(0, depth).join(" ");
}

function decodeAliasValue(aliasType: string, aliasValue: string): string {
  if (aliasType !== "git.branch") return aliasValue;
  try {
    const decoded = Buffer.from(aliasValue, "base64url").toString("utf8");
    return decoded.startsWith("git:branch:") ? decoded : aliasValue;
  } catch {
    return aliasValue;
  }
}

function safeToolArgs(tool: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const args = input as Record<string, unknown>;
  const allow: Record<string, string[]> = {
    read: ["filePath", "offset", "limit"],
    glob: ["pattern", "path"],
    grep: ["pattern", "path", "include"],
  };
  const keys = allow[tool];
  if (!keys) return undefined;
  const shown = keys
    .filter((key) => args[key] !== undefined)
    .map((key) => `${key}: ${safeSnippet(args[key], 120)}`);
  return shown.length ? shown.join(", ") : undefined;
}

function eventPart(record: SessionEventLogRecord): ViewerToolPart | undefined {
  if (record.type !== "opencode_event" || !record.event || typeof record.event !== "object")
    return undefined;
  const event = record.event as ViewerEvent;
  const props = event.properties;
  const part = props?.part;
  return part && typeof part === "object" ? (part as ViewerToolPart) : undefined;
}

function eventType(record: SessionEventLogRecord): string | undefined {
  if (record.type !== "opencode_event" || !record.event || typeof record.event !== "object")
    return undefined;
  const type = (record.event as ViewerEvent).type;
  return typeof type === "string" ? type : undefined;
}

function sourceFrom(correlationKey: string | undefined): string {
  if (!correlationKey) return "direct";
  if (correlationKey.startsWith("slack:thread:")) return "slack";
  if (correlationKey.startsWith("git:branch:")) return "git";
  if (correlationKey.startsWith("github:")) return "github";
  if (correlationKey.startsWith("approval:")) return "approval";
  if (correlationKey.startsWith("cron:")) return "cron";
  return "direct";
}

type DecodedSource = { icon: string; label: string; href?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tryParseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const idx = value.indexOf("{");
  if (idx === -1) return undefined;
  try {
    const parsed = JSON.parse(value.slice(idx));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function decodeSlackSource(
  correlationKey: string,
  promptPreview: string | undefined,
  slackTeamId: string | null,
): DecodedSource {
  const tail = correlationKey.slice("slack:thread:".length);
  const slash = tail.indexOf("/");
  let channel: string | undefined = slash > 0 ? tail.slice(0, slash) : undefined;
  const ts = slash > 0 ? tail.slice(slash + 1) : tail;

  const payload = tryParseJsonObject(promptPreview);
  let user: string | undefined;
  let text: string | undefined;
  if (payload) {
    const event = isRecord(payload.event) ? payload.event : payload;
    channel = channel ?? safeStr(event.channel);
    user = safeStr(event.user);
    text = safeStr(event.text);
  }

  const head: string[] = [];
  if (channel) head.push(`#${channel}`);
  if (user) head.push(`@${user}`);
  let label = head.join(" · ");
  if (text) {
    const firstLine = text.split("\n", 1)[0] ?? "";
    const quoted = `“${safeSnippet(firstLine, 120)}”`;
    label = label ? `${label} — ${quoted}` : quoted;
  } else if (!label) {
    label = `Slack thread ${ts}`;
  }

  const href =
    channel && ts && slackTeamId
      ? `https://app.slack.com/client/${slackTeamId}/${channel}/thread/${channel}-${ts}`
      : undefined;
  return { icon: "💬", label, href };
}

function decodeGithubSource(promptPreview: string | undefined): DecodedSource | undefined {
  const payload = tryParseJsonObject(promptPreview);
  if (!payload) return undefined;
  const repo = isRecord(payload.repository) ? safeStr(payload.repository.full_name) : undefined;
  const sender = isRecord(payload.sender) ? safeStr(payload.sender.login) : undefined;

  if (isRecord(payload.pull_request)) {
    const pr = payload.pull_request;
    const num = typeof pr.number === "number" ? pr.number : undefined;
    const htmlUrl = safeStr(pr.html_url);
    const title = safeStr(pr.title);
    const href =
      htmlUrl ?? (repo && num !== undefined ? `https://github.com/${repo}/pull/${num}` : undefined);
    const parts = [
      num !== undefined ? `PR #${num}` : "PR",
      repo,
      sender ? `@${sender}` : "",
    ].filter((s): s is string => !!s);
    const label = title ? `${parts.join(" · ")} — “${safeSnippet(title, 120)}”` : parts.join(" · ");
    return { icon: "🔀", label, href };
  }

  if (isRecord(payload.issue)) {
    const issue = payload.issue;
    const num = typeof issue.number === "number" ? issue.number : undefined;
    const htmlUrl = safeStr(issue.html_url);
    const title = safeStr(issue.title);
    const href =
      htmlUrl ??
      (repo && num !== undefined ? `https://github.com/${repo}/issues/${num}` : undefined);
    const parts = [
      num !== undefined ? `Issue #${num}` : "Issue",
      repo,
      sender ? `@${sender}` : "",
    ].filter((s): s is string => !!s);
    const label = title ? `${parts.join(" · ")} — “${safeSnippet(title, 120)}”` : parts.join(" · ");
    return { icon: "🐞", label, href };
  }

  if (
    typeof payload.ref === "string" &&
    (safeStr(payload.after) || isRecord(payload.head_commit))
  ) {
    const branch = payload.ref.replace(/^refs\/heads\//, "");
    const sha = safeStr(payload.after)?.slice(0, 7);
    const href = repo && sha ? `https://github.com/${repo}/commit/${sha}` : undefined;
    const left = repo && sha ? `${repo}@${sha}` : repo;
    const parts = [left, `on ${branch}`, sender ? `@${sender}` : ""].filter(
      (s): s is string => !!s,
    );
    return { icon: "📦", label: parts.join(" · "), href };
  }

  if (repo) {
    return { icon: "📦", label: repo, href: `https://github.com/${repo}` };
  }
  return undefined;
}

function decodeCronSource(promptPreview: string | undefined): DecodedSource {
  if (!promptPreview) return { icon: "⏰", label: "Cron" };
  const sentence = promptPreview.split(/[.\n]/, 1)[0]?.trim();
  return { icon: "⏰", label: sentence ? safeSnippet(sentence, 160) : "Cron" };
}

function decodeSourceLine(
  correlationKey: string | undefined,
  promptPreview: string | undefined,
  slackTeamId: string | null,
): DecodedSource | undefined {
  if (!correlationKey) return undefined;
  if (correlationKey.startsWith("slack:thread:")) {
    return decodeSlackSource(correlationKey, promptPreview, slackTeamId);
  }
  if (correlationKey.startsWith("github:") || correlationKey.startsWith("git:branch:")) {
    return decodeGithubSource(promptPreview);
  }
  if (correlationKey.startsWith("cron:")) {
    return decodeCronSource(promptPreview);
  }
  return undefined;
}

function partId(part: ViewerToolPart | undefined): string | undefined {
  if (!part) return undefined;
  return typeof part.id === "string" ? part.id : undefined;
}

function getStateTitle(part: ViewerToolPart): string | undefined {
  const title = part.state?.title;
  return typeof title === "string" && title ? title : undefined;
}

function detectSlackPost(
  command: unknown,
): { channel?: string; threadTs?: string; message?: string } | null {
  if (typeof command !== "string") return null;
  const trimmed = command.trimStart();
  if (!/^slack-post-message\b/.test(trimmed)) return null;
  const channelMatch =
    trimmed.match(/--channel(?:=|\s+)['"]?([^\s'"]+)/) ?? trimmed.match(/-c\s+['"]?([^\s'"]+)/);
  const threadMatch = trimmed.match(/--thread-ts(?:=|\s+)['"]?([^\s'"]+)/);
  const heredocMatch = trimmed.match(/<<-?\s*'?(\w+)'?\s*\n([\s\S]*?)\n\1\b/);
  return {
    channel: channelMatch?.[1],
    threadTs: threadMatch?.[1],
    message: heredocMatch?.[2],
  };
}

function renderSlackBubble(
  info: { channel?: string; threadTs?: string; message?: string },
  durationStr: string | undefined,
  status: string,
): string {
  const target = info.channel ? `#${info.channel}` : "Slack";
  const hdr = `💬 → ${escapeHtml(target)}${info.threadTs ? ` · ts ${escapeHtml(info.threadTs)}` : ""}${durationStr ? ` · ${escapeHtml(durationStr)}` : ""}${status !== "completed" ? ` · ${escapeHtml(status)}` : ""}`;
  const body = info.message
    ? `<pre>${escapeHtml(safeMultilineSnippet(info.message, 1200))}</pre>`
    : "<em>message body not captured</em>";
  return `<li class="slack-bubble" data-status="${escapeHtml(status)}"><div class="slack-hdr">${hdr}</div>${body}</li>`;
}

function renderDiffLines(patchText: string): string {
  const MAX_LINES = 200;
  const all = patchText.split("\n");
  const lines = all.slice(0, MAX_LINES);
  const truncatedLines = all.length - lines.length;
  const out = lines
    .map((line) => {
      const safe = escapeHtml(safeSnippet(line, 300));
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
        return `<span class="diff-meta">${safe}</span>`;
      }
      if (line.startsWith("+")) return `<span class="diff-add">${safe}</span>`;
      if (line.startsWith("-")) return `<span class="diff-del">${safe}</span>`;
      return `<span>${safe}</span>`;
    })
    .join("");
  const tail =
    truncatedLines > 0
      ? `<span class="diff-meta">… ${truncatedLines} more line(s) hidden</span>`
      : "";
  return `<pre class="diff">${out}${tail}</pre>`;
}

function renderApplyPatch(part: ViewerToolPart, durationStr: string | undefined): string {
  const title = getStateTitle(part);
  const input = isRecord(part.state?.input) ? part.state.input : undefined;
  const patchText = input ? safeStr(input.patchText) : undefined;
  const status = typeof part.state?.status === "string" ? part.state.status : "unknown";
  const hdr = `<b>apply_patch</b> <span class="status">${escapeHtml(status)}</span>${durationStr ? ` <span>${escapeHtml(durationStr)}</span>` : ""}${title ? ` <span class="tool-title">${escapeHtml(safeSnippet(title, 200))}</span>` : ""}`;
  if (!patchText) return `<li class="row" data-status="${escapeHtml(status)}">${hdr}</li>`;
  return `<li class="row" data-status="${escapeHtml(status)}"><details><summary>${hdr}</summary>${renderDiffLines(patchText)}</details></li>`;
}

/**
 * Render a subagent session's activity inline. Subagent sessions are written
 * to their own `ses_*.jsonl` files (no trigger boundaries — task tool spawns
 * them outside the trigger endpoint), so we read the whole file, dedup by
 * part id, and emit the major rows (tool + non-empty assistant text).
 *
 * No size cap is applied — the page is gated by Vouch and admin-only, and
 * the parent log already has its own size cap.
 *
 * No recursion: a subagent's own task tools render as plain rows without
 * their own inline expansion.
 */
function renderInlineSubagent(sessionId: string): string | undefined {
  let path: string;
  try {
    path = sessionLogPath(sessionId);
  } catch {
    return undefined;
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  const records: SessionEventLogRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const v = SessionEventLogRecordSchema.safeParse(obj);
      if (v.success) records.push(v.data);
    } catch {
      // skip malformed lines
    }
  }
  if (!records.length) return undefined;

  const latestById = new Map<string, ViewerToolPart>();
  const firstIdxById = new Map<string, number>();
  records.forEach((rec, i) => {
    if (rec.type !== "opencode_event") return;
    const p = eventPart(rec);
    const id = partId(p);
    if (!id || !p) return;
    latestById.set(id, p);
    if (!firstIdxById.has(id)) firstIdxById.set(id, i);
  });

  const rows: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.type !== "opencode_event") continue;
    const ev = rec.event as ViewerEvent | undefined;
    if (ev && ev._truncated === true) continue;
    const raw = eventPart(rec);
    const id = partId(raw);
    if (id && firstIdxById.get(id) !== i) continue;
    const p = id ? (latestById.get(id) ?? raw) : raw;
    if (!p) continue;
    if (p.type === "tool") {
      const status = typeof p.state?.status === "string" ? p.state.status : "unknown";
      const name = viewerToolDisplayName(p);
      const title = getStateTitle(p);
      rows.push(
        `<li class="row" data-status="${escapeHtml(status)}"><b>tool</b> <span>${escapeHtml(name)}</span> <span class="status">${escapeHtml(status)}</span>${title ? ` <span class="tool-title">${escapeHtml(safeSnippet(title, 200))}</span>` : ""}</li>`,
      );
    } else if (p.type === "text") {
      const text = typeof p.text === "string" ? p.text : "";
      if (!text.trim() || text.startsWith("[correlation-key:")) continue;
      rows.push(
        `<li class="row" data-status="completed"><b>assistant text</b><div class="text-body">${escapeHtml(safeMultilineSnippet(text, 2000))}</div></li>`,
      );
    }
  }
  if (!rows.length) return undefined;
  return `<details><summary>subagent activity (${rows.length} row${rows.length === 1 ? "" : "s"})</summary><ul class="events sub-events">${rows.join("")}</ul></details>`;
}

function renderTaskCard(part: ViewerToolPart, durationStr: string | undefined): string {
  const input = isRecord(part.state?.input) ? part.state.input : undefined;
  const subagent = input ? safeStr(input.subagent_type) : undefined;
  const description = input ? safeStr(input.description) : undefined;
  const prompt = input ? safeStr(input.prompt) : undefined;
  const output = safeStr(part.state?.output);
  const status = typeof part.state?.status === "string" ? part.state.status : "unknown";
  const metadata = isRecord(part.state)
    ? isRecord((part.state as Record<string, unknown>).metadata)
      ? ((part.state as Record<string, unknown>).metadata as Record<string, unknown>)
      : undefined
    : undefined;
  const subSession = metadata ? safeStr(metadata.sessionId) : undefined;
  const hdr = `🤖 <b>task</b>${subagent ? ` · ${escapeHtml(subagent)}` : ""} <span class="status">${escapeHtml(status)}</span>${durationStr ? ` · ${escapeHtml(durationStr)}` : ""}`;
  const desc = description ? `<div>${escapeHtml(safeSnippet(description, 240))}</div>` : "";
  const subChip = subSession
    ? `<div class="task-sub">subagent session <code>${escapeHtml(safeSnippet(subSession, 120))}</code></div>`
    : "";
  const promptBlock = prompt
    ? `<details><summary>prompt</summary><pre>${escapeHtml(safeMultilineSnippet(prompt, 4000))}</pre></details>`
    : "";
  const outputBlock = output
    ? `<details><summary>output</summary><pre>${escapeHtml(safeMultilineSnippet(output, 4000))}</pre></details>`
    : "";
  const subActivity = subSession ? (renderInlineSubagent(subSession) ?? "") : "";
  return `<li class="task-card" data-status="${escapeHtml(status)}"><div class="task-hdr">${hdr}</div>${desc}${subChip}${promptBlock}${outputBlock}${subActivity}</li>`;
}

function renderSourceLine(source: DecodedSource): string {
  const inner = `${source.icon} ${escapeHtml(source.label)}`;
  if (source.href) {
    const safeHref = source.href.startsWith("https://") ? source.href : undefined;
    if (safeHref) {
      return `<p class="source"><a href="${escapeHtml(safeHref)}" rel="noopener noreferrer">${inner} ↗</a></p>`;
    }
  }
  return `<p class="source">${inner}</p>`;
}

function numericTokenTotal(tokens: unknown): number | undefined {
  if (!tokens || typeof tokens !== "object") return undefined;
  let total = 0;
  let found = false;
  const stack: unknown[] = [tokens];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (typeof child === "number" && Number.isFinite(child)) {
        total += child;
        found = true;
      } else if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return found ? total : undefined;
}

type TokenCounts = { input: number; output: number; reasoning: number; cacheRead: number };

function extractTokenCounts(tokens: unknown): TokenCounts | undefined {
  if (!isRecord(tokens)) return undefined;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const counts: TokenCounts = {
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: cache ? num(cache.read) : 0,
  };
  if (counts.input + counts.output + counts.reasoning + counts.cacheRead === 0) {
    return undefined;
  }
  return counts;
}

/**
 * Per-million-token USD prices for the model ids Thor currently runs against.
 *
 * Source: https://models.dev/api.json (snapshot 2026-05-15). To refresh:
 *   curl -s https://models.dev/api.json | jq '.openai.models["gpt-5.4","gpt-5.5"]'
 *
 * Only the exact ids Thor uses are listed; any other model id renders without
 * a cost estimate so we never surface guessed numbers. The 200k+ context tier
 * (which roughly doubles the published prices) is intentionally ignored — we
 * render the base-tier estimate and prefix it with `~`.
 */
const MODEL_PRICING_USD_PER_M: Record<
  string,
  { input: number; output: number; cacheRead?: number }
> = {
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
};

function estimateCostUsd(tokens: TokenCounts, modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const pricing = MODEL_PRICING_USD_PER_M[modelId];
  if (!pricing) return undefined;
  const cacheRead = pricing.cacheRead ?? pricing.input;
  // Reasoning tokens are billed at the completion (output) rate.
  return (
    (tokens.input * pricing.input +
      (tokens.output + tokens.reasoning) * pricing.output +
      tokens.cacheRead * cacheRead) /
    1_000_000
  );
}

function formatCostUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/** UUIDs render as their last 7 characters everywhere on the viewer. */
function shortUuid(value: string): string {
  return value.length > 7 ? value.slice(-7) : value;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}main{max-width:900px;margin:0 auto;padding:24px}.pill{display:inline-block;border-radius:999px;padding:4px 10px;font-weight:700}.completed{background:#dcfce7;color:#166534}.error,.crashed{background:#fee2e2;color:#991b1b}.aborted{background:#ffedd5;color:#9a3412}.in_flight{background:#fef9c3;color:#854d0e}.summary{color:#334155;font-weight:500;margin:8px 0}.chips{color:#475569;font-size:0.9em;margin:4px 0}.chips code{font-size:0.95em}.live{display:inline-block;margin-left:8px;color:#dc2626;font-size:0.9em;animation:thor-pulse 1.6s ease-in-out infinite}@keyframes thor-pulse{0%,100%{opacity:1}50%{opacity:0.35}}@media (prefers-reduced-motion:reduce){.live{animation:none}}.truncated-footer{color:#64748b;font-size:0.9em;font-style:italic;margin-top:12px}.source{margin:8px 0;font-size:1.05em}.source a{color:#0f172a;text-decoration:none;border-bottom:1px solid #cbd5e1}.source a:hover{border-bottom-color:#0f172a}.events,.step>ul{list-style:none;padding-left:0}.events>li,.step>ul>li{margin:6px 0}.row{position:relative;padding-left:18px}.row::before{content:"";position:absolute;left:2px;top:0.55em;width:8px;height:8px;border-radius:50%;background:#94a3b8}.row[data-status="completed"]::before{background:#22c55e}.row[data-status="running"]::before{background:#facc15}.row[data-status="pending"]::before{background:#cbd5e1}.row[data-status="error"]::before{background:#ef4444}.row[data-status="aborted"]::before{background:#f97316}.tool-title{color:#475569;font-style:italic;margin-left:6px}.text-body{white-space:pre-wrap;margin:4px 0 0;color:#0f172a;font-size:0.95em}.slack-bubble{background:#eff6ff;border-left:3px solid #3b82f6;padding:8px 12px;border-radius:4px;margin:6px 0;list-style:none}.slack-bubble .slack-hdr{color:#1e3a8a;font-size:0.9em;font-weight:600;margin-bottom:4px}.slack-bubble pre{background:transparent;color:#0f172a;padding:0;margin:0}.task-card{background:#f1f5f9;border-left:3px solid #6366f1;padding:8px 12px;border-radius:4px;margin:6px 0;list-style:none}.task-card .task-hdr{color:#3730a3;font-size:0.9em;font-weight:600;margin-bottom:4px}.task-card .task-sub{color:#475569;font-size:0.85em;margin:2px 0 4px}.sub-events{margin:6px 0 0;padding-left:12px;border-left:2px solid #c7d2fe}.totals{color:#475569;font-size:0.95em;margin:12px 0 4px}.diff{font-size:0.85em;line-height:1.4}.diff .diff-add{color:#86efac;display:block}.diff .diff-del{color:#fca5a5;display:block}.diff .diff-meta{color:#94a3b8;display:block}.step{list-style:none;margin:16px 0}.step>.step-hdr{color:#1e293b;font-weight:600;padding:6px 0;border-bottom:1px solid #e2e8f0}.step>ol{margin-top:6px;padding-left:24px}details{margin:4px 0}summary{cursor:pointer}pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow:auto}</style></head><body><main><header><h1>${escapeHtml(title)}</h1></header>${body}</main></body></html>`;
}

function renderSlicePage(
  anchorId: string,
  triggerId: string,
  ownerSessionId: string,
  anchor: ReverseAnchorEntry,
  slice: Exclude<ReturnType<typeof readTriggerSlice>, { notFound: true } | { oversized: true }>,
  opts: { slackTeamId: string | null },
): string {
  const start = slice.records.find(
    (record) => record.type === "trigger_start" && record.triggerId === triggerId,
  );
  const end = slice.records.find(
    (record) => record.type === "trigger_end" && record.triggerId === triggerId,
  );
  const correlationKey = start?.type === "trigger_start" ? start.correlationKey : undefined;
  const promptPreview = start?.type === "trigger_start" ? start.promptPreview : undefined;

  // Dedup pre-pass: for parts that stream multiple updates under the same id,
  // we want one row per id with the latest state.
  const latestPartById = new Map<string, ViewerToolPart>();
  const firstIndexById = new Map<string, number>();
  slice.records.forEach((record, idx) => {
    if (record.type !== "opencode_event") return;
    const part = eventPart(record);
    const id = partId(part);
    if (!id) return;
    latestPartById.set(id, part!);
    if (!firstIndexById.has(id)) firstIndexById.set(id, idx);
  });

  type Step = { rows: string[] };
  let toolParts = 0;
  let totalTokens = 0;
  let hasTokens = false;
  const tokenTotals: TokenCounts = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
  let errorRows = 0;
  let truncatedCount = 0;
  const modelIds = new Set<string>();
  const steps: Step[] = [];
  let current: Step = { rows: [] };
  for (let idx = 0; idx < slice.records.length; idx++) {
    const record = slice.records[idx]!;
    // trigger_start / trigger_end rows are intentionally not rendered — the
    // status pill, duration, and totals footer convey the same information
    // without two stand-alone "[1] trigger started …" / "[N] trigger ended …"
    // bullets that bracket every step.
    if (record.type === "trigger_start" || record.type === "trigger_end") continue;
    if (record.type !== "opencode_event") continue;
    if (
      record.event &&
      typeof record.event === "object" &&
      (record.event as ViewerEvent)._truncated === true
    ) {
      truncatedCount++;
      continue;
    }
    const type = eventType(record);
    const rawPart = eventPart(record);
    const id = partId(rawPart);
    if (id && firstIndexById.get(id) !== idx) continue;
    const part = id ? (latestPartById.get(id) ?? rawPart) : rawPart;
    if (part) {
      const stateMeta = isRecord((part.state as Record<string, unknown> | undefined)?.metadata)
        ? ((part.state as Record<string, unknown>).metadata as Record<string, unknown>)
        : undefined;
      const modelInfo = stateMeta && isRecord(stateMeta.model) ? stateMeta.model : undefined;
      const modelId = modelInfo ? safeStr(modelInfo.modelID) : undefined;
      if (modelId) modelIds.add(modelId);
    }
    if (part?.type === "tool") {
      toolParts++;
      const status = typeof part.state?.status === "string" ? part.state.status : "unknown";
      if (status === "error") errorRows++;
      const duration =
        typeof part.state?.time?.start === "number" && typeof part.state.time.end === "number"
          ? formatDuration(part.state.time.end - part.state.time.start)
          : undefined;
      const toolName = typeof part.tool === "string" ? part.tool : "";

      if (toolName === "apply_patch") {
        current.rows.push(renderApplyPatch(part, duration));
        continue;
      }
      if (toolName === "task") {
        current.rows.push(renderTaskCard(part, duration));
        continue;
      }
      const bashCommand = isRecord(part.state?.input) ? part.state.input.command : undefined;
      const slackPost = toolName === "bash" ? detectSlackPost(bashCommand) : null;
      if (slackPost) {
        current.rows.push(renderSlackBubble(slackPost, duration, status));
        continue;
      }

      const name = viewerToolDisplayName(part);
      const title = getStateTitle(part);
      const args =
        safeToolArgs(name, part.state?.input) ?? safeToolArgs(toolName, part.state?.input);
      current.rows.push(
        `<li class="row" data-status="${escapeHtml(status)}"><b>tool</b> <span>${escapeHtml(name)}</span> <span class="status">${escapeHtml(status)}</span>${duration ? ` <span>${duration}</span>` : ""}${args ? ` <code>${escapeHtml(args)}</code>` : ""}${title ? ` <span class="tool-title">${escapeHtml(safeSnippet(title, 200))}</span>` : ""}${status === "error" ? ` <span class="err">${escapeHtml(safeSnippet(part.state?.error, 300))}</span>` : ""}</li>`,
      );
      continue;
    }
    if (part?.type === "text") {
      // OpenCode echoes the user-message text parts through the same
      // message.part.updated channel as assistant text. Thor prefixes every
      // injected prompt with "[correlation-key: <key>]" (see
      // `packages/runner/src/index.ts` prompt construction), so dropping
      // those keeps the activity stream to assistant output only.
      const text = typeof part.text === "string" ? part.text : "";
      if (text.startsWith("[correlation-key:")) continue;
      // Preserve newlines (and bullet lists) instead of collapsing whitespace.
      // No markdown renderer — `**bold**` etc. still show as literal text.
      current.rows.push(
        `<li class="row" data-status="completed"><b>assistant text</b><div class="text-body">${escapeHtml(safeMultilineSnippet(text, 2000))}</div></li>`,
      );
      continue;
    }
    // Reasoning parts are the model's internal chain of thought — rendered raw
    // they're noisy (unrendered markdown, partial sentences) and the
    // user-visible result is the text / tool / slack-bubble row that follows.
    // Always drop.
    if (part?.type === "reasoning") continue;
    if (part?.type === "step-finish") {
      const tokenTotal = numericTokenTotal(part.tokens);
      if (tokenTotal !== undefined) {
        totalTokens += tokenTotal;
        hasTokens = true;
      }
      const breakdown = extractTokenCounts(part.tokens);
      if (breakdown) {
        tokenTotals.input += breakdown.input;
        tokenTotals.output += breakdown.output;
        tokenTotals.reasoning += breakdown.reasoning;
        tokenTotals.cacheRead += breakdown.cacheRead;
      }
      steps.push(current);
      current = { rows: [] };
      continue;
    }
    if (type === "session.error") {
      errorRows++;
      const event = record.event as ViewerEvent;
      const error = event.properties?.error;
      const msg =
        error && typeof error === "object"
          ? ((error as { data?: { message?: string }; message?: string; name?: string }).data
              ?.message ??
            (error as { message?: string; name?: string }).message ??
            (error as { name?: string }).name)
          : undefined;
      current.rows.push(
        `<li class="row err" data-status="error"><b>session error</b> ${escapeHtml(safeSnippet(msg ?? "Unknown error", 500))}</li>`,
      );
      continue;
    }
    // session.status (busy heartbeat) and session.idle are intentionally
    // dropped — the pill conveys liveness; row-by-row heartbeats are noise.
  }
  if (current.rows.length > 0) steps.push(current);

  const aliases = anchor.externalKeys
    .map(
      (key) =>
        `${key.aliasType}: ${safeSnippet(decodeAliasValue(key.aliasType, key.aliasValue), 300)}`,
    )
    .join("; ");
  const durationStr = formatDuration(end?.type === "trigger_end" ? end.durationMs : undefined);
  const ageStr = formatAge(slice.lastEventTs);
  const summaryBits = [
    durationStr,
    `${toolParts} tools`,
    errorRows ? `${errorRows} errors` : undefined,
    ageStr ? `last event ${ageStr} ago` : undefined,
  ].filter((s): s is string => !!s);
  const summaryLine = summaryBits.join(" · ");

  const pillReason =
    (slice.status === "aborted" || slice.status === "crashed") && slice.reason
      ? ` · ${escapeHtml(safeSnippet(slice.reason, 120))}`
      : "";
  const livePill =
    slice.status === "in_flight" ? ` <span class="live" aria-label="live">● live</span>` : "";
  const truncatedFooter =
    truncatedCount > 0
      ? `<p class="truncated-footer">${truncatedCount === 1 ? "1 opencode event was truncated at write time and is not shown." : `${truncatedCount} opencode events were truncated at write time and are not shown.`}</p>`
      : "";
  const ownerChip = `<code>${escapeHtml(safeSnippet(ownerSessionId, 120))}</code>`;
  const currentChip =
    anchor.currentSessionId && anchor.currentSessionId !== ownerSessionId
      ? ` · current <code>${escapeHtml(safeSnippet(anchor.currentSessionId, 120))}</code>`
      : "";
  const totalsBits: string[] = [];
  if (hasTokens) {
    const tokenParts: string[] = [];
    if (tokenTotals.input) tokenParts.push(`${formatTokens(tokenTotals.input)} input`);
    if (tokenTotals.cacheRead) tokenParts.push(`${formatTokens(tokenTotals.cacheRead)} cached`);
    if (tokenTotals.output) tokenParts.push(`${formatTokens(tokenTotals.output)} output`);
    if (tokenTotals.reasoning) tokenParts.push(`${formatTokens(tokenTotals.reasoning)} reasoning`);
    totalsBits.push(
      tokenParts.length
        ? `Tokens: ${tokenParts.join(" · ")}`
        : `Tokens: ${formatTokens(totalTokens)}`,
    );
  }
  const sortedModelIds = [...modelIds].sort();
  if (sortedModelIds.length === 1) {
    totalsBits.push(`Model: ${escapeHtml(sortedModelIds[0]!)}`);
  } else if (sortedModelIds.length > 1) {
    totalsBits.push(`Models: ${sortedModelIds.map((m) => escapeHtml(m)).join(", ")}`);
  }
  // Cost is only meaningful when one model is in play; mixing pricing tables
  // across multiple models would be misleading without per-step model tracking.
  if (sortedModelIds.length === 1) {
    const cost = estimateCostUsd(tokenTotals, sortedModelIds[0]);
    if (cost !== undefined && cost > 0) {
      totalsBits.push(`Est cost: ~${formatCostUsd(cost)}`);
    }
  }
  const totalsFooter = totalsBits.length ? `<p class="totals">${totalsBits.join(" · ")}</p>` : "";
  const decodedSource = decodeSourceLine(correlationKey, promptPreview, opts.slackTeamId);
  const sourceLine = decodedSource ? renderSourceLine(decodedSource) : "";
  // Tab title: <source-type> · <short-trigger-id> · Thor.
  // Short id makes multiple open tabs distinguishable without duplicating the
  // full source label that the in-page source line already shows.
  const pageTitle = `${sourceFrom(correlationKey)} · ${shortUuid(triggerId)} · Thor`;

  let activityHtml: string;
  if (steps.length <= 1) {
    const flat = steps.flatMap((step) => step.rows);
    activityHtml = flat.length
      ? `<ul class="events">${flat.join("")}</ul>`
      : "<p>No meaningful events recorded.</p>";
  } else {
    const stepBlocks = steps.map((step, i) => {
      const heading = `Step ${i + 1}`;
      return `<li class="step"><div class="step-hdr">${escapeHtml(heading)}</div><ul>${step.rows.join("")}</ul></li>`;
    });
    activityHtml = `<ul class="events">${stepBlocks.join("")}</ul>`;
  }

  const sourceCoveredByDecode =
    !!decodedSource &&
    !!correlationKey &&
    (correlationKey.startsWith("slack:thread:") ||
      correlationKey.startsWith("github:") ||
      correlationKey.startsWith("git:branch:"));
  const promptPreviewBlock =
    promptPreview && !sourceCoveredByDecode
      ? `<p>Prompt preview: ${escapeHtml(safeSnippet(promptPreview, 800))}</p>`
      : "";

  const body = `<section><span class="pill ${slice.status}">${escapeHtml(slice.status.replace("_", " "))}${pillReason}</span>${livePill}<h2>${escapeHtml(sourceFrom(correlationKey))} trigger</h2>${sourceLine}${summaryLine ? `<p class="summary">${escapeHtml(summaryLine)}</p>` : ""}<p class="chips">anchor <code title="${escapeHtml(anchorId)}">${escapeHtml(shortUuid(anchorId))}</code> · trigger <code title="${escapeHtml(triggerId)}">${escapeHtml(shortUuid(triggerId))}</code> · session ${ownerChip}${currentChip}</p></section><section><h3>Trigger context</h3>${correlationKey ? `<p>Correlation <code>${escapeHtml(safeSnippet(correlationKey))}</code></p>` : ""}${promptPreviewBlock}${aliases ? `<p>Aliases: ${escapeHtml(aliases)}</p>` : ""}<p>Sessions: ${anchor.sessionIds.map((id) => `<code>${escapeHtml(safeSnippet(id, 120))}</code>`).join(" ") || "none"}</p>${anchor.subsessionIds.length ? `<p>Subsessions: ${anchor.subsessionIds.map((id) => `<code>${escapeHtml(safeSnippet(id, 120))}</code>`).join(" ")}</p>` : ""}</section><section>${activityHtml}${totalsFooter}${truncatedFooter}</section>`;
  return renderPage(pageTitle, body);
}

// --- Startup ---

export function startRunner(): void {
  const app = createRunnerApp();
  const server = app.listen(PORT, () => {
    logInfo(log, "runner_started", {
      port: PORT,
      opencodeUrl: OPENCODE_URL,
    });
  });

  const shutdown = (signal: string) => {
    logInfo(log, "runner_shutting_down", { signal });
    flushInflightTriggersOnShutdown();
    server.close(() => process.exit(0));
    // Hard exit if server.close hangs.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRunner();
}
