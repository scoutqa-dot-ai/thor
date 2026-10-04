import {
  isOpencodeObject,
  readOpencodeString,
  extractOpencodeTokenCounts,
} from "./opencode-event-fields.js";
import { createLegacyRunnerViewer } from "./legacy-runner-viewer.js";
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
  extractRepoFromCwd,
  ANCHOR_LOCK_PREFIX,
  SESSION_LOCK_PREFIX,
  appendSessionEvent,
  appendAlias,
  appendCorrelationAliasForAnchor,
  currentSessionForAnchor,
  ensureAnchorForCorrelationKey,
  mintAnchor,
  mintTriggerId,
  resolveAlias,
  resolveAnchorForCorrelationKey,
  resolveCorrelationLockKey,
  loadRunnerEnv,
  matchesInternalSecret,
  withKeyLock,
  createConfigLoader,
  findUserByGithub,
  findUserBySlack,
  WORKSPACE_CONFIG_PATH,
  handleProgressEvent,
} from "@thor/common";
import type { ConfigLoader, UserRecord } from "@thor/common";
import type { ProgressEvent, ProgressTarget, ProgressTransport } from "@thor/common";
import { buildToolInstructions } from "./tool-instructions.js";
import { getMemoryProgressEvents } from "./memory-progress.js";
import {
  createSlackProgressTransport,
  resolveSlackProgressTarget,
  type SlackProgressTransportTarget,
} from "./slack-progress.js";

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

/** Shared event bus — one global SSE connection, dispatches to per-session listeners. */
const defaultEventBuses = new EventBusRegistry(OPENCODE_URL);

type OpencodeClient = ReturnType<typeof createOpencodeClient>;
type ModelContextLimits = Map<string, number>;
const EMPTY_MODEL_CONTEXT_LIMITS: ModelContextLimits = new Map();
const MODEL_CONTEXT_LIMIT_CACHE_TTL_MS = 5 * 60_000;
let cachedModelContextLimits:
  | {
      expiresAt: number;
      limits: ModelContextLimits;
    }
  | undefined;
let cachedModelContextLimitsPending: Promise<void> | undefined;

/** Reset the legacy model context cache between isolated runner tests. */
export function resetModelContextLimitCacheForTests(): void {
  cachedModelContextLimits = undefined;
  cachedModelContextLimitsPending = undefined;
}

/** Legacy execution dependencies; historical viewing does not construct these resources. */
export interface RunnerAppOptions {
  opencodeUrl?: string;
  memoryDir?: string;
  eventBuses?: EventBusRegistry;
  createClient?: (opts: { baseUrl: string; directory: string }) => OpencodeClient;
  isOpencodeReachable?: () => Promise<boolean>;
  ensureOpencodeAvailable?: () => Promise<void>;
  workspaceConfigLoader?: ConfigLoader;
  progressTransport?: ProgressTransport<SlackProgressTransportTarget>;
  progressEventSink?: (event: ProgressEvent) => void;
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
    return buildToolInstructions(directory);
  } catch {
    return undefined;
  }
}

const defaultWorkspaceConfigLoader = createConfigLoader(WORKSPACE_CONFIG_PATH);

function formatTriggeringUser(user: UserRecord): string {
  const handles = [
    user.slack ? `slack: ${user.slack}` : undefined,
    user.github ? `github: ${user.github}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return `${user.name} <${user.email}>${handles ? ` (${handles})` : ""}`;
}

function buildTriggeringUserPromptBlock(
  loader: ConfigLoader,
  actor: { triggerSlackId?: string; triggerGithubLogin?: string },
): string | undefined {
  if (!actor.triggerSlackId && !actor.triggerGithubLogin) return undefined;

  let user: UserRecord | undefined;
  try {
    const workspaceConfig = loader();
    user = actor.triggerSlackId
      ? findUserBySlack(workspaceConfig, actor.triggerSlackId)
      : undefined;
    user ??= actor.triggerGithubLogin
      ? findUserByGithub(workspaceConfig, actor.triggerGithubLogin)
      : undefined;
  } catch {
    // Best-effort prompt context; do not fail a run because config is temporarily unreadable.
  }

  const actorId = [
    actor.triggerSlackId ? `slack: ${actor.triggerSlackId}` : undefined,
    actor.triggerGithubLogin ? `github: ${actor.triggerGithubLogin}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  return [
    "[Triggering user]",
    user ? `Run triggered by ${formatTriggeringUser(user)}.` : `Run triggered by ${actorId}.`,
    `User directory: ${WORKSPACE_CONFIG_PATH} users[] (re-read it if you need more user details later).`,
  ].join("\n");
}

/**
 * In-flight trigger registry. Drives reliable trigger_end emission across normal
 * completion, caught throws, user-initiated aborts, and graceful shutdown.
 */
const inflightTriggers = new Map<string, { sessionId: string; startTime: number }>();

function appendTriggerStartEvent(
  sessionId: string,
  triggerId: string,
  payload: { correlationKey?: string; triggerSlackId?: string; triggerGithubLogin?: string },
): void {
  appendSessionEvent(sessionId, {
    type: "trigger_start",
    triggerId,
    ...(payload.correlationKey ? { correlationKey: payload.correlationKey } : {}),
    ...(payload.triggerSlackId ? { triggerSlackId: payload.triggerSlackId } : {}),
    ...(payload.triggerGithubLogin ? { triggerGithubLogin: payload.triggerGithubLogin } : {}),
  });
}

function startTrigger(
  sessionId: string,
  triggerId: string,
  payload: { correlationKey?: string; triggerSlackId?: string; triggerGithubLogin?: string },
): void {
  appendTriggerStartEvent(sessionId, triggerId, payload);
  inflightTriggers.set(triggerId, { sessionId, startTime: Date.now() });
}

/**
 * Idempotently bind an OpenCode session id (and optional correlationKey) to an
 * anchor. Shared by the production /trigger session resolver and the e2e
 * trigger-context seeder so both produce the same alias-table shape.
 */
function bindSessionToAnchor(args: {
  anchorId: string;
  sessionId: string;
  correlationKey?: string;
}): void {
  if (
    resolveAlias({ aliasType: "opencode.session", aliasValue: args.sessionId }) !== args.anchorId
  ) {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: args.sessionId,
      anchorId: args.anchorId,
    });
  }
  if (
    args.correlationKey &&
    resolveAnchorForCorrelationKey(args.correlationKey) !== args.anchorId
  ) {
    appendCorrelationAliasForAnchor(args.anchorId, args.correlationKey);
  }
}

function endTrigger(
  triggerId: string,
  status: "completed" | "error" | "aborted",
  extras: { error?: string; reason?: string } = {},
): void {
  const entry = inflightTriggers.get(triggerId);
  if (!entry) return;
  inflightTriggers.delete(triggerId);
  try {
    appendSessionEvent(entry.sessionId, {
      type: "trigger_end",
      triggerId,
      status,
      durationMs: Date.now() - entry.startTime,
      ...extras,
    });
  } catch (err) {
    logError(log, "trigger_end_write_failed", err instanceof Error ? err.message : String(err), {
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
    try {
      appendSessionEvent(entry.sessionId, {
        type: "trigger_end",
        triggerId,
        status: "aborted",
        reason: "shutdown",
        durationMs: Date.now() - entry.startTime,
      });
    } catch {
      // best-effort on shutdown; keep flushing the rest
    }
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

const E2eTriggerContextSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  correlationKey: z.string().trim().min(1).optional(),
  triggerSlackId: z.string().trim().min(1).optional(),
  triggerGithubLogin: z.string().trim().min(1).optional(),
});

// --- Express app ---

/** Construct the rollback OpenCode runner, including its historical viewer routes. */
export function createRunnerApp(options: RunnerAppOptions = {}): express.Express {
  const app = express();
  app.use(express.json());
  const opencodeUrl = options.opencodeUrl ?? OPENCODE_URL;
  const memoryDir = options.memoryDir ?? MEMORY_DIR;
  const eventBuses = options.eventBuses ?? defaultEventBuses;
  const createClient = options.createClient ?? createOpencodeClient;
  const checkOpencodeReachable = options.isOpencodeReachable ?? isOpencodeReachable;
  const waitForOpencode = options.ensureOpencodeAvailable ?? ensureOpencodeAvailable;
  const workspaceConfigLoader = options.workspaceConfigLoader ?? defaultWorkspaceConfigLoader;
  const progressTransport =
    options.progressTransport ??
    createSlackProgressTransport({
      token: config.slackBotToken,
      slackApiUrl: config.slackApiBaseUrl,
    });

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
        bindSessionToAnchor({
          anchorId,
          sessionId,
          correlationKey: parsed.data.correlationKey,
        });
        appendTriggerStartEvent(sessionId, triggerId, parsed.data);
        res.json({ sessionId, triggerId, anchorId });
      },
    );
  }

  app.use(createLegacyRunnerViewer());

  // --- Trigger endpoint ---

  const TriggerRequestSchema = z.object({
    prompt: z.string(),
    /** Correlation key for session continuity. Same key = same OpenCode session. */
    correlationKey: z.string().optional(),
    /** Trigger actor captured by gateway from source-specific event payloads. */
    triggerSlackId: z.string().trim().min(1).optional(),
    triggerGithubLogin: z.string().trim().min(1).optional(),
    /** Direct session ID to resume (bypasses correlation key lookup). */
    sessionId: z.string().optional(),
    /** If true, abort a busy session before sending the prompt.
     *  Defaults to false: return {busy: true} without aborting. */
    interrupt: z.boolean().optional(),
    /** Working directory for the OpenCode session. */
    directory: z.string(),
    /** If true, hold the HTTP response open and stream progress events as
     *  NDJSON lines until the agent settles, ending with a `done` line.
     *  Default false: fire-and-forget — return {accepted,sessionId,resumed}
     *  immediately and run the agent in a background task. Used by the
     *  OpenCode smoke test, which needs to read the agent's final response
     *  text and status from the trigger call. */
    stream: z.boolean().optional(),
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

    let { prompt, correlationKey, sessionId: requestedSessionId, directory } = parsed.data;
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
            appendCorrelationAliasForAnchor(anchorId, correlationKey);
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
        bindSessionToAnchor({ anchorId, sessionId: id, correlationKey });

        return { sessionId: id, resumed: didResume, anchorId };
      };
      const resolution = await (lockKey
        ? withKeyLock(correlationKeyLocks, lockKey, resolveSession)
        : resolveSession());

      const sessionId = resolution.sessionId;
      const resumed = resolution.resumed;
      const anchorId = resolution.anchorId;

      // Kick off model-limit warming up front so it overlaps the busy check and
      // prompt-send. Awaited later before the stream loop reads the cache.
      const warmModelLimits = warmModelContextLimits({ client, opencodeUrl });

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

      // Block briefly so the first trigger after process start sees populated
      // limits; subsequent calls within the cache TTL resolve immediately.
      await warmModelLimits;

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

        const triggeringUserBlock = buildTriggeringUserPromptBlock(workspaceConfigLoader, {
          triggerSlackId: parsed.data.triggerSlackId,
          triggerGithubLogin: parsed.data.triggerGithubLogin,
        });
        if (triggeringUserBlock) {
          prompt = `${triggeringUserBlock}\n\n${prompt}`;
        }
      }

      // --- Correlation key: inject into every prompt so the agent always knows its own key ---
      if (correlationKey) {
        prompt = `[correlation-key: ${correlationKey}]\n\n${prompt}`;
      }

      const parts: TextPartInput[] = [{ type: "text", text: prompt }];

      // Subscribe to event bus BEFORE sending the prompt
      const subscription = await eventBuses.subscribe([sessionId]);

      const triggerId = mintTriggerId();
      inflightTriggerId = triggerId;
      startTrigger(sessionId, triggerId, {
        correlationKey,
        triggerSlackId: parsed.data.triggerSlackId,
        triggerGithubLogin: parsed.data.triggerGithubLogin,
      });

      const promptStart = Date.now();
      const asyncResult = await client.session.promptAsync({
        path: { id: sessionId },
        body: { parts },
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

      const progressTarget = resolveSlackProgressTarget(correlationKey);
      let progressChain = Promise.resolve();

      const stream = parsed.data.stream === true;
      if (stream) {
        res.setHeader("Content-Type", "application/x-ndjson");
        res.flushHeaders?.();
      }

      function emit(event: ProgressEvent): void {
        logInfo(log, "progress_emit", {
          sessionId,
          type: event.type,
          ...(event.type === "tool" ? { tool: event.tool } : {}),
          ...(event.type === "memory"
            ? { action: event.action, path: event.path, source: event.source }
            : {}),
          ...(event.type === "delegate" ? { agent: event.agent } : {}),
          ...(event.type === "context"
            ? {
                providerID: event.providerID,
                modelID: event.modelID,
                tokens: event.tokens,
                limit: event.limit,
                usagePercent: event.usagePercent,
              }
            : {}),
          ...(event.type === "done"
            ? { status: event.status, durationMs: (event as { durationMs?: number }).durationMs }
            : {}),
          ts: Date.now(),
        });
        options.progressEventSink?.(event);
        if (stream && !res.writableEnded) {
          res.write(JSON.stringify(event) + "\n");
        }
        if (!progressTarget || !progressTransport) return;
        progressChain = progressChain
          .catch(() => undefined)
          .then(() =>
            handleProgressEvent(
              progressTarget as ProgressTarget<SlackProgressTransportTarget>,
              event,
              progressTransport,
            ),
          );
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

      const backgroundTask = (async () => {
        try {
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
          let sawParentMessagePart = false;
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
            if (!isOpencodeObject(input)) return;
            const raw = input.subagent_type;
            if (typeof raw !== "string") return;
            const agent = raw.trim();
            if (!agent) return;

            const key = [toolPart.sessionID, toolPart.messageID, toolPart.callID].join("|");
            if (emittedTaskDelegates.has(key)) return;
            emittedTaskDelegates.add(key);

            emit({ type: "delegate", agent });
          }

          {
            const iterator = subscription[Symbol.asyncIterator]();
            try {
              while (true) {
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

                // Child sub-session events land in the child's own log so the
                // viewer's owner-only slice never surfaces them.
                const originSessionId = eventSessionId(event) ?? sessionId;
                appendSessionEvent(originSessionId, { type: "opencode_event", event });

                const isParent = isSessionEvent(event, sessionId);

                if (isParent && event.type === "message.updated") {
                  emitContextProgressFromMessage(event, currentModelContextLimits(), emit);
                }

                // Forward tool progress from child sessions so
                // Slack progress isn't silent while a task runs. Non-parent
                // events must never drive parent terminal handling below — a
                // child's session.idle / session.error would otherwise end the
                // parent run before its final answer is emitted.
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
                  sawParentMessagePart = true;
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
                            try {
                              appendAlias({
                                aliasType: "opencode.subsession",
                                aliasValue: child.id,
                                anchorId,
                              });
                            } catch (err) {
                              logError(
                                log,
                                "opencode_subsession_alias_write_failed",
                                err instanceof Error ? err.message : String(err),
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
                  if (!sawParentMessagePart) {
                    logInfo(log, "stale_session_idle_ignored", { sessionId });
                    continue;
                  }
                  terminalError = latestSessionError;
                  finished = true;
                  break;
                }
              }
            } finally {
              await iterator.return?.();
              subscription.close();
            }
          }

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
          await progressChain;
        } catch (err) {
          logError(log, "trigger_background_error", err);
          endTrigger(triggerId, "error", {
            error: err instanceof Error ? err.message : String(err),
          });
          emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
          await progressChain;
        }
      })();
      if (stream) {
        await backgroundTask;
        if (!res.writableEnded) res.end();
      } else {
        void backgroundTask;
        res.json({ accepted: true, sessionId, resumed });
      }
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
      }
    }
  });

  return app;
}

// --- Helpers ---

function eventSessionId(event: Event): string | undefined {
  if (event.type === "message.part.updated") return event.properties.part.sessionID;
  if (event.type === "message.updated") {
    const info = messageUpdatedInfo(event);
    return readOpencodeString(info?.sessionID) ?? readOpencodeString(info?.sessionId);
  }
  if (
    event.type === "session.idle" ||
    event.type === "session.status" ||
    event.type === "session.error"
  ) {
    return event.properties.sessionID;
  }
  return undefined;
}

function contextLimitKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

async function resolveModelContextLimits(client: OpencodeClient): Promise<ModelContextLimits> {
  const limits: ModelContextLimits = new Map();
  try {
    const { data } = await client.provider.list({});
    for (const provider of data?.all ?? []) {
      for (const [modelID, model] of Object.entries(provider.models)) {
        if (model.limit.context > 0) {
          limits.set(contextLimitKey(provider.id, modelID), Math.floor(model.limit.context));
        }
      }
    }
  } catch (err) {
    logWarn(log, "model_context_limits_load_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return limits;
}

function currentModelContextLimits(): ModelContextLimits {
  const cached = cachedModelContextLimits;
  if (!cached) return EMPTY_MODEL_CONTEXT_LIMITS;
  if (cached.expiresAt <= Date.now()) return EMPTY_MODEL_CONTEXT_LIMITS;
  return cached.limits;
}

function warmModelContextLimits(input: {
  client: OpencodeClient;
  opencodeUrl: string;
}): Promise<void> {
  const cached = cachedModelContextLimits;
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve();
  if (cachedModelContextLimitsPending) return cachedModelContextLimitsPending;

  cachedModelContextLimitsPending = resolveModelContextLimits(input.client)
    .then((limits) => {
      cachedModelContextLimits = {
        limits,
        expiresAt: Date.now() + MODEL_CONTEXT_LIMIT_CACHE_TTL_MS,
      };
    })
    .catch((err) => {
      logWarn(log, "model_context_limits_warm_failed", {
        opencodeUrl: input.opencodeUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      cachedModelContextLimitsPending = undefined;
    });
  return cachedModelContextLimitsPending;
}

function messageUpdatedInfo(event: Event): Record<string, unknown> | undefined {
  const properties = (event as unknown as { properties?: unknown }).properties;
  if (!isOpencodeObject(properties)) return undefined;
  const info = properties.info ?? properties.message;
  return isOpencodeObject(info) ? info : undefined;
}

function emitContextProgressFromMessage(
  event: Event,
  limits: ModelContextLimits,
  emit: (event: ProgressEvent) => void,
): void {
  const info = messageUpdatedInfo(event);
  if (!info) return;
  const role = readOpencodeString(info.role) ?? readOpencodeString(info.type);
  if (role && role !== "assistant") return;
  const tokens = contextTokenTotal(info.tokens);
  if (tokens === undefined) return;
  const tokenTotal = Math.max(0, Math.floor(tokens));
  if (tokenTotal <= 0) return;
  const providerID = readOpencodeString(info.providerID) ?? readOpencodeString(info.providerId);
  const modelID = readOpencodeString(info.modelID) ?? readOpencodeString(info.modelId);
  if (!providerID || !modelID) return;
  const limit = limits.get(contextLimitKey(providerID, modelID));
  if (!limit) return;
  const usagePercent = Math.round((tokenTotal * 100) / limit);
  emit({
    type: "context",
    providerID,
    modelID,
    tokens: tokenTotal,
    limit,
    usagePercent,
  });
}

function isSessionEvent(event: Event, sessionId: string): boolean {
  return eventSessionId(event) === sessionId;
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

function contextTokenTotal(tokens: unknown): number | undefined {
  const counts = extractOpencodeTokenCounts(tokens);
  if (!counts) return undefined;
  return counts.input + counts.output + counts.reasoning + counts.cacheRead;
}
