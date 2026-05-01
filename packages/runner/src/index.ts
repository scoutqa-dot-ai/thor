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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createLogger,
  logInfo,
  logWarn,
  logError,
  truncate,
  isAliasableTool,
  extractAliases,
  extractThorMeta,
  isAllowedDirectory,
  createConfigLoader,
  WORKSPACE_CONFIG_PATH,
  extractRepoFromCwd,
  appendSessionEvent,
  appendAlias,
  resolveAlias,
  readTriggerSlice,
  sessionLogPath,
  getWorklogDir,
  MAX_SESSION_FILE_BYTES,
} from "@thor/common";
import type { ToolArtifact } from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import { buildToolInstructions } from "./tool-instructions.js";
import { getMemoryProgressEvents } from "./memory-progress.js";
import { pathToFileURL } from "node:url";

const log = createLogger("runner");

const PORT = parseInt(process.env.PORT || "3000", 10);
const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, "");
const OPENCODE_CONNECT_TIMEOUT = parseInt(process.env.OPENCODE_CONNECT_TIMEOUT || "15000", 10);
const INTERNAL_SECRET_HEADER = "x-thor-internal-secret";

/** Timeout for waiting for a busy session to become idle after abort (ms). */
const ABORT_TIMEOUT = parseInt(process.env.ABORT_TIMEOUT || "10000", 10);

/** Grace period after a session.error for OpenCode to emit recovery events before treating it as terminal. */
const SESSION_ERROR_GRACE_MS = parseInt(process.env.SESSION_ERROR_GRACE_MS || "10000", 10);

/** Threshold above which an in-flight slice renders the soft staleness banner. */
const SLICE_STALE_AFTER_MS = 5 * 60_000;

/** Memory directory root. */
const MEMORY_DIR = "/workspace/memory";

const TaskDelegateInputSchema = z.object({
  subagent_type: z.string().trim().min(1),
});

const getWorkspaceConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

/** Shared event buses — one SSE connection per directory, dispatches to per-session listeners. */
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

function appendSessionEventOrFail(sessionId: string, record: Record<string, unknown>): void {
  const result = appendSessionEvent(sessionId, record);
  if (!result.ok) throw result.error;
}

function appendAliasOrFail(record: Parameters<typeof appendAlias>[0]): void {
  const result = appendAlias(record);
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
  appendSessionEventOrFail(sessionId, {
    type: "trigger_start",
    triggerId,
    ...(payload.correlationKey ? { correlationKey: payload.correlationKey } : {}),
    promptPreview: payload.promptPreview ?? "",
  });
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

function withCorrelationKeyLock<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const prev = correlationKeyLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  correlationKeyLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
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

type RawSessionLogResponse = {
  status: number;
  contentType: "text/plain";
  body: string;
};

function readRawSessionLogResponse(sessionId: string, triggerId: string): RawSessionLogResponse {
  try {
    const path = sessionLogPath(sessionId);
    const root = realpathSync(`${getWorklogDir()}/sessions`);
    const real = realpathSync(path);
    if (!real.startsWith(`${root}/`) || !existsSync(real)) throw new Error("invalid path");
    if (statSync(real).size > MAX_SESSION_FILE_BYTES) {
      return { status: 503, contentType: "text/plain", body: "Session log is oversized" };
    }
    const slice = readTriggerSlice(sessionId, triggerId);
    if ("notFound" in slice) return { status: 404, contentType: "text/plain", body: "Not found" };
    if ("oversized" in slice) {
      return { status: 503, contentType: "text/plain", body: "Session log is oversized" };
    }
    const body = slice.records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    return { status: 200, contentType: "text/plain", body };
  } catch {
    return { status: 404, contentType: "text/plain", body: "Not found" };
  }
}

function matchesInternalSecret(
  expectedSecret: string,
  providedSecret: string | undefined,
): boolean {
  if (!expectedSecret || !providedSecret) return false;
  if (expectedSecret.length !== providedSecret.length) return false;
  return timingSafeEqual(Buffer.from(expectedSecret), Buffer.from(providedSecret));
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
        const triggerId = randomUUID();
        appendSessionEventOrFail(sessionId, {
          type: "trigger_start",
          triggerId,
          ...(parsed.data.correlationKey ? { correlationKey: parsed.data.correlationKey } : {}),
          promptPreview: parsed.data.promptPreview ?? "e2e approval disclaimer context",
        });
        res.json({ sessionId, triggerId });
      },
    );
  }

  // Rate limiting for the Vouch-gated runner viewer is intentionally enforced
  // at the infrastructure edge, not in the app process.
  // codeql[js/missing-rate-limiting]
  // lgtm[js/missing-rate-limiting]
  app.get(
    "/runner/v/:sessionId/:triggerId",
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
      const sessionId = routeParam(req.params.sessionId);
      const triggerId = routeParam(req.params.triggerId);
      const slice = readTriggerSlice(sessionId, triggerId);
      if ("notFound" in slice) {
        res
          .status(404)
          .type("html")
          .send(
            renderPage("Trigger not found", "No Thor trigger slice was found for this session."),
          );
        return;
      }
      if ("oversized" in slice) {
        res
          .type("html")
          .send(
            renderPage(
              "Slice truncated",
              `<p>This session log is oversized.</p><p><a href="${escapeHtml(req.originalUrl)}/raw">Open raw JSONL</a></p>`,
            ),
          );
        return;
      }
      res.type("html").send(renderSlicePage(sessionId, triggerId, slice));
    },
  );

  // Rate limiting for the Vouch-gated runner viewer is intentionally enforced
  // at the infrastructure edge, not in the app process.
  // codeql[js/missing-rate-limiting]
  // lgtm[js/missing-rate-limiting]
  app.get(
    "/runner/v/:sessionId/:triggerId/raw",
    // codeql[js/missing-rate-limiting]
    // lgtm[js/missing-rate-limiting]
    (req, res) => {
      if (!req.get("X-Vouch-User")) {
        res.status(401).type("text/plain").send("Unauthorized");
        return;
      }
      const raw = readRawSessionLogResponse(
        routeParam(req.params.sessionId),
        routeParam(req.params.triggerId),
      );
      res.status(raw.status).type(raw.contentType).send(raw.body);
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

      // --- Session resolution: resume existing or create new (locked per correlationKey) ---
      const resolution = await withCorrelationKeyLock(correlationKey, async () => {
        const candidateSessionId =
          requestedSessionId ||
          (correlationKey
            ? resolveAlias({ aliasType: "slack.thread_id", aliasValue: correlationKey })
            : undefined);

        let id: string;
        let didResume = false;
        let staleSessionId: string | undefined;

        if (candidateSessionId) {
          try {
            const existing = await client.session.get({ path: { id: candidateSessionId } });
            if (existing.data) {
              id = candidateSessionId;
              didResume = true;
              logInfo(log, "session_resumed", { sessionId: id, correlationKey });
            } else {
              throw new Error("Session not found");
            }
          } catch {
            logInfo(log, "session_stale", { sessionId: candidateSessionId, correlationKey });
            const session = await client.session.create({ body: {} });
            if (!session.data) throw new Error("Failed to create session");
            id = session.data.id;
            staleSessionId = candidateSessionId;
            logInfo(log, "session_created", { sessionId: id, correlationKey });
          }
        } else {
          const session = await client.session.create({ body: {} });
          if (!session.data) throw new Error("Failed to create session");
          id = session.data.id;
          logInfo(log, "session_created", { sessionId: id, correlationKey });
        }

        // Back-reference alias on session_stale recreate so old viewer links chain-walk
        // to the new session via findActiveTrigger (`session.parent` traversal).
        if (staleSessionId) {
          appendAliasOrFail({
            aliasType: "session.parent",
            aliasValue: staleSessionId,
            sessionId: id,
          });
        }

        if (correlationKey) {
          appendAliasOrFail({
            aliasType: "slack.thread_id",
            aliasValue: correlationKey,
            sessionId: id,
          });
        }

        return { sessionId: id, resumed: didResume };
      });

      const sessionId = resolution.sessionId;
      const resumed = resolution.resumed;

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

          const abortSub = await eventBuses.subscribe(sessionDirectory, [sessionId]);
          const aborted = await waitForSessionSettled(abortSub, ABORT_TIMEOUT);
          abortSub.close();

          if (!aborted) {
            logError(
              log,
              "session_abort_timeout",
              `Session did not idle within ${ABORT_TIMEOUT}ms`,
              { sessionId },
            );
            // Per plan: "If settle times out, write no marker and do not call promptAsync."
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
      const subscription = await eventBuses.subscribe(sessionDirectory, [sessionId]);

      const triggerId = randomUUID();
      inflightTriggerId = triggerId;
      startTrigger(sessionId, triggerId, {
        correlationKey,
        promptPreview: truncate(prompt, 500),
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
      const collectedArtifacts: ToolArtifact[] = [];
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

            appendSessionEventOrFail(sessionId, { type: "opencode_event", event });

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
                          aliasType: "session.parent",
                          aliasValue: child.id,
                          sessionId,
                        });
                        if (!aliasResult.ok) {
                          logError(
                            log,
                            "session_parent_alias_write_failed",
                            aliasResult.error.message,
                            { sessionId, childId: child.id },
                          );
                        }
                      }
                    })
                    .catch((err) => {
                      logError(
                        log,
                        "child_session_discovery_failed",
                        err instanceof Error ? err.message : String(err),
                        { sessionId },
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

      if (correlationKey) {
        // Register cross-channel aliases (best-effort)
        if (collectedArtifacts.length > 0) {
          try {
            const aliases = extractAliases(collectedArtifacts);
            for (const { alias } of aliases) {
              if (alias.startsWith("slack:thread:")) {
                appendAliasOrFail({
                  aliasType: "slack.thread_id",
                  aliasValue: alias.slice("slack:thread:".length),
                  sessionId,
                });
              } else if (alias.startsWith("git:branch:")) {
                appendAliasOrFail({
                  aliasType: "git.branch",
                  aliasValue: Buffer.from(alias).toString("base64url"),
                  sessionId,
                });
              }
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Thor</title><style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}main{max-width:900px;margin:0 auto;padding:24px}.pill{display:inline-block;border-radius:999px;padding:4px 10px;font-weight:700}.completed{background:#dcfce7;color:#166534}.error,.crashed{background:#fee2e2;color:#991b1b}.aborted{background:#ffedd5;color:#9a3412}.in_flight{background:#fef9c3;color:#854d0e}pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow:auto}details{margin:16px 0}</style></head><body><main><header><h1>${escapeHtml(title)}</h1></header>${body}<footer><p>Generated by Thor at <time datetime="${new Date().toISOString()}">${new Date().toUTCString()}</time></p></footer></main></body></html>`;
}

function redactRecord(record: unknown): unknown {
  if (!record || typeof record !== "object") return record;
  const value = record as Record<string, unknown>;
  if (value.type === "tool_call") return { ...value, payload: "[redacted: tool output]" };
  if (value.type === "opencode_event") return { ...value, event: "[redacted: opencode event]" };
  return value;
}

function renderSlicePage(
  sessionId: string,
  triggerId: string,
  slice: Exclude<ReturnType<typeof readTriggerSlice>, { notFound: true } | { oversized: true }>,
): string {
  const isStale =
    slice.status === "in_flight" &&
    slice.lastEventTs &&
    Date.now() - Date.parse(slice.lastEventTs) > SLICE_STALE_AFTER_MS;
  const refresh = slice.status === "in_flight" ? '<meta http-equiv="refresh" content="5">' : "";
  const records = slice.records
    .map((record) => JSON.stringify(redactRecord(record), null, 2))
    .join("\n");
  const body = `${refresh}<section><span class="pill ${slice.status}">${escapeHtml(slice.status.replace("_", " "))}</span><p>Session <code>${escapeHtml(sessionId)}</code>, trigger <code>${escapeHtml(triggerId)}</code></p>${slice.status === "crashed" ? "<p>This trigger was abandoned without a close marker. The runner started a new trigger later; whatever was in-flight here was lost.</p>" : ""}${isStale ? "<p>No new events in more than 5 minutes — the runner may have crashed without a close marker.</p>" : ""}${slice.records.length === 1 ? "<p>No recorded events.</p>" : ""}</section><details><summary>Timeline</summary><pre>${escapeHtml(records)}</pre></details><p><a href="/runner/v/${escapeHtml(sessionId)}/${escapeHtml(triggerId)}/raw">Show raw JSONL</a></p>`;
  return renderPage("Thor trigger", body);
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
