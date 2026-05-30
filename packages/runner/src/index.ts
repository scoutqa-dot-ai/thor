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
import { EventBusRegistry, waitForSessionSettled } from "./event-bus.ts";
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
  withKeyLock,
  isOmittedMarker,
  iterateJsonlFileLinesSync,
  formatTokens,
  formatDuration,
  formatAge,
  formatBytes,
  formatCostUsd,
  parseOpencodeEvent,
  createConfigLoader,
  findUserByGithub,
  findUserBySlack,
  WORKSPACE_CONFIG_PATH,
  handleProgressEvent,
} from "@thor/common";
import type {
  ConfigLoader,
  OpencodeEvent,
  UserRecord,
  ViewerPart,
  ViewerToolPart,
  ViewerPayloadOrOmitted,
  ParsedOpencodeEvent,
} from "@thor/common";
import type { ReverseAnchorEntry, SessionEventLogRecord } from "@thor/common";
import type { ProgressEvent, ProgressTarget, ProgressTransport } from "@thor/common";
import { getMemoryProgressEvents } from "./memory-progress.ts";
import { pathToFileURL } from "node:url";
import {
  createSlackProgressTransport,
  resolveSlackProgressTarget,
  type SlackProgressTransportTarget,
} from "./slack-progress.ts";

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

export function resetModelContextLimitCacheForTests(): void {
  cachedModelContextLimits = undefined;
  cachedModelContextLimitsPending = undefined;
}

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
  repoDirectory?: string;
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
  // Stamp the anchor's repo once, from the trusted trigger-time directory. This
  // lets non-Slack/cron sessions (which carry no slack.thread alias) resolve a
  // profile, and lets the approval-click path re-resolve without a live
  // directory. Stamp only when the anchor has no repo yet so a resumed session
  // keeps its original repo even if a later trigger's directory differs.
  if (args.repoDirectory) {
    const repo = extractRepoFromCwd(args.repoDirectory);
    if (
      repo &&
      !reverseLookupAnchor(args.anchorId).externalKeys.some((key) => key.aliasType === "repo")
    ) {
      appendAlias({ aliasType: "repo", aliasValue: repo, anchorId: args.anchorId });
    }
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

function resolveOwnerSessionForTrigger(
  anchorId: string,
  triggerId: string,
): { ok: true; sessionId: string } | { ok: false; reason: "not_found" } {
  const reverse = reverseLookupAnchor(anchorId);
  for (const sessionId of reverse.sessionIds) {
    const slice = readTriggerSlice(sessionId, triggerId);
    if (!("notFound" in slice)) return { ok: true, sessionId };
  }
  return { ok: false, reason: "not_found" };
}

function anchorIsKnown(anchor: ReverseAnchorEntry): boolean {
  return anchor.sessionIds.length + anchor.subsessionIds.length + anchor.externalKeys.length > 0;
}

const E2eTriggerContextSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  correlationKey: z.string().trim().min(1).optional(),
  triggerSlackId: z.string().trim().min(1).optional(),
  triggerGithubLogin: z.string().trim().min(1).optional(),
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
  const workspaceConfigLoader = options.workspaceConfigLoader ?? defaultWorkspaceConfigLoader;
  const progressTransport =
    options.progressTransport ??
    createSlackProgressTransport({
      token: config.slackBotToken,
      slackApiUrl: config.slackApiBaseUrl,
    });

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

  // Auth and rate limiting for the runner viewer are intentionally enforced
  // at the infrastructure edge (ingress + Vouch), not in the app process.
  // codeql[js/missing-rate-limiting]
  // lgtm[js/missing-rate-limiting]
  app.get(
    "/runner/v/:anchorId",
    // codeql[js/missing-rate-limiting]
    // lgtm[js/missing-rate-limiting]
    (req, res) => {
      const anchorId = routeParam(req.params.anchorId);
      if (!isUuidV7(anchorId)) {
        res
          .status(404)
          .type("html")
          .send(renderPage("Anchor not found", "No Thor anchor context was found."));
        return;
      }
      const anchor = reverseLookupAnchor(anchorId);
      if (!anchorIsKnown(anchor)) {
        res
          .status(404)
          .type("html")
          .send(renderPage("Anchor not found", "No Thor anchor context was found."));
        return;
      }
      res.type("html").send(renderPage("Thor context", "<p>Coming soon.</p>"));
    },
  );

  app.get(
    "/runner/v/:anchorId/:triggerId",
    // codeql[js/missing-rate-limiting]
    // lgtm[js/missing-rate-limiting]
    (req, res) => {
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
        bindSessionToAnchor({
          anchorId,
          sessionId: id,
          correlationKey,
          repoDirectory: sessionDirectory,
        });

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
            if (!isRecord(input)) return;
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
    return safeStr(info?.sessionID) ?? safeStr(info?.sessionId);
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
  if (!isRecord(properties)) return undefined;
  const info = properties.info ?? properties.message;
  return isRecord(info) ? info : undefined;
}

function emitContextProgressFromMessage(
  event: Event,
  limits: ModelContextLimits,
  emit: (event: ProgressEvent) => void,
): void {
  const info = messageUpdatedInfo(event);
  if (!info) return;
  const role = safeStr(info.role) ?? safeStr(info.type);
  if (role && role !== "assistant") return;
  const tokens = contextTokenTotal(info.tokens);
  if (tokens === undefined) return;
  const tokenTotal = Math.max(0, Math.floor(tokens));
  if (tokenTotal <= 0) return;
  const providerID = safeStr(info.providerID) ?? safeStr(info.providerId);
  const modelID = safeStr(info.modelID) ?? safeStr(info.modelId);
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
  python3: 1,
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

function safeSnippet(value: string | undefined): string {
  // Debugging UI: no redaction, no length cap. Newlines/tabs are collapsed
  // to spaces for one-line rendering surfaces.
  if (!value) return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
}

/**
 * Narrow a `ViewerPayloadOrOmitted` to a plain JSON object — null/array/
 * primitive/OmittedMarker collapse to undefined so callers can read fields
 * without re-guarding.
 */
function payloadObject(
  value: ViewerPayloadOrOmitted | undefined,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || isOmittedMarker(value))
    return undefined;
  return value as Record<string, unknown>;
}

/**
 * Render an inline "(<label> omitted, N KB)" badge when `value` is a
 * `{ _omitted: true, bytes: N }` marker produced by capRecord's projection
 * step. Returns the empty string otherwise so callers can concatenate.
 */
function renderOmittedNote(value: unknown, label: string): string {
  if (!isOmittedMarker(value)) return "";
  return ` <span class="omitted">(${escapeHtml(label)} omitted, ${escapeHtml(formatBytes(value.bytes))})</span>`;
}

function viewerToolDisplayName(part: ViewerToolPart): string {
  // No bash-prefix heuristics — the raw `part.tool` is what the data says.
  return typeof part.tool === "string" ? part.tool : "tool";
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

/**
 * Some tools have a single input field that *is* the call (skill → `name`,
 * bash → `command`). For those, render that one field inline so the row tells
 * the whole story without a click. `inline` uses `<code>` for short
 * one-liners; `block` uses `<pre>` to preserve newlines (heredocs etc.).
 * Everything else falls back to the generic collapsible JSON dump.
 */
const TOOL_PRIMARY_INPUT_FIELD: Record<string, { field: string; mode: "inline" | "block" }> = {
  skill: { field: "name", mode: "inline" },
  bash: { field: "command", mode: "block" },
};

function renderToolInput(toolName: string, input: unknown): string {
  if (input === undefined) return "";
  if (isOmittedMarker(input)) return renderOmittedNote(input, "input");
  const primary = TOOL_PRIMARY_INPUT_FIELD[toolName];
  if (primary && isRecord(input)) {
    const val = input[primary.field];
    if (typeof val === "string" && val) {
      const safe = escapeHtml(val);
      return primary.mode === "inline" ? ` <code>${safe}</code>` : `<pre>${safe}</pre>`;
    }
  }
  let json: string;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return `<details><summary>input</summary><pre>${escapeHtml(json)}</pre></details>`;
}

function viewEvent(record: SessionEventLogRecord): ParsedOpencodeEvent | undefined {
  if (record.type !== "opencode_event") return undefined;
  return parseOpencodeEvent(record.event);
}

function eventPart(record: SessionEventLogRecord): ViewerPart | undefined {
  const parsed = viewEvent(record);
  if (parsed?.kind !== "ok") return undefined;
  return parsed.event.type === "message.part.updated" ? parsed.event.properties.part : undefined;
}

function statusFromRawEvent(raw: unknown): "pending" | "running" | "completed" | "error" {
  if (!isRecord(raw)) return "pending";
  const properties = raw.properties;
  if (!isRecord(properties)) return "pending";
  const part = properties.part;
  if (!isRecord(part)) return "pending";
  const state = part.state;
  if (!isRecord(state)) return "pending";
  const status = state.status;
  return status === "running" || status === "completed" || status === "error" ? status : "pending";
}

function renderUnrecognizedEvent(
  ts: string,
  rawType: string | undefined,
  rawEvent: unknown,
): string {
  const type = rawType ?? "unknown";
  const status = statusFromRawEvent(rawEvent);
  return `<li class="row unknown" data-status="${escapeHtml(status)}"><b>unknown event</b> <span>${escapeHtml(type)}</span> <span class="ts">${escapeHtml(ts)}</span></li>`;
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
    const quoted = `“${safeSnippet(firstLine)}”`;
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
    const label = title ? `${parts.join(" · ")} — “${safeSnippet(title)}”` : parts.join(" · ");
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
    const label = title ? `${parts.join(" · ")} — “${safeSnippet(title)}”` : parts.join(" · ");
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
  return { icon: "⏰", label: sentence ? safeSnippet(sentence) : "Cron" };
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

function getStateTitle(part: ViewerToolPart): string | undefined {
  // Prefer Claude's own `state.title` (e.g. "Lists test-management Thor
  // worktrees"). Fall back to `state.input.description` for tools whose
  // caller supplied it (most notably `task`) so the row carries a label even
  // when `state.title` is absent.
  if (part.state.title) return part.state.title;
  const input = payloadObject(part.state.input);
  return input ? safeStr(input.description) : undefined;
}

function renderDiffLines(patchText: string): string {
  // No line cap — render the entire patch. The whole block lives inside a
  // collapsed <details> on the apply_patch row, so volume is opt-in.
  const out = patchText
    .split("\n")
    .map((line) => {
      const safe = escapeHtml(line);
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
        return `<span class="diff-meta">${safe}</span>`;
      }
      if (line.startsWith("+")) return `<span class="diff-add">${safe}</span>`;
      if (line.startsWith("-")) return `<span class="diff-del">${safe}</span>`;
      return `<span>${safe}</span>`;
    })
    .join("\n");
  return `<pre class="diff">${out}</pre>`;
}

function renderApplyPatch(part: ViewerToolPart, durationStr: string | undefined): string {
  const title = getStateTitle(part);
  const rawInput = part.state.input;
  const inputOmitted = renderOmittedNote(rawInput, "patch");
  const input = payloadObject(rawInput);
  const patchText = input ? safeStr(input.patchText) : undefined;
  const status = part.state.status;
  // Status text is suppressed — the colored bullet on the row carries it.
  const hdr = `<b>apply_patch</b>${durationStr ? ` <span>${escapeHtml(durationStr)}</span>` : ""}${title ? ` <span class="tool-title">${escapeHtml(safeSnippet(title))}</span>` : ""}${inputOmitted}`;
  if (!patchText) return `<li class="row" data-status="${escapeHtml(status)}">${hdr}</li>`;
  return `<li class="row" data-status="${escapeHtml(status)}"><details><summary>${hdr}</summary>${renderDiffLines(patchText)}</details></li>`;
}

type SubAgentCtx = { visited: Set<string> };

function partDuration(part: ViewerToolPart): string | undefined {
  const time = part.state?.time;
  if (typeof time?.start === "number" && typeof time.end === "number") {
    return formatDuration(time.end - time.start);
  }
  return undefined;
}

/**
 * Time window (ms since epoch) during which this task tool was running. We
 * use it to filter the subagent's session log so only events from THIS
 * invocation surface — main agents often resume the same subagent session
 * later, and we don't want unrelated events to bleed into the card.
 */
function partTimeWindow(part: ViewerToolPart): { start: number; end?: number } | undefined {
  const time = part.state?.time;
  if (typeof time?.start !== "number" || !Number.isFinite(time.start)) return undefined;
  return {
    start: time.start,
    end: typeof time.end === "number" && Number.isFinite(time.end) ? time.end : undefined,
  };
}

/**
 * Yield each record paired with its parsed event and (for message.part.updated)
 * the dedup-by-id resolved latest-state part. Records that should not render
 * (non-opencode_event records, trigger_*, and intermediate updates of a
 * streaming part) are skipped — what comes out is exactly the surface the
 * renderer needs to dispatch on.
 */
function* iterateParsedParts(records: SessionEventLogRecord[]): Generator<{
  rec: SessionEventLogRecord;
  parsed: ParsedOpencodeEvent;
  resolved: ViewerPart | undefined;
}> {
  const latestById = new Map<string, ViewerPart>();
  const firstIdxById = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.type !== "opencode_event") continue;
    const parsed = parseOpencodeEvent(rec.event);
    if (parsed.kind !== "ok" || parsed.event.type !== "message.part.updated") continue;
    const part = parsed.event.properties.part;
    if (!part.id) continue;
    latestById.set(part.id, part);
    if (!firstIdxById.has(part.id)) firstIdxById.set(part.id, i);
  }

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.type !== "opencode_event") continue;
    const parsed = parseOpencodeEvent(rec.event);
    if (parsed.kind !== "ok" || parsed.event.type !== "message.part.updated") {
      yield { rec, parsed, resolved: undefined };
      continue;
    }
    const part = parsed.event.properties.part;
    if (part.id && firstIdxById.get(part.id) !== i) continue;
    const resolved = part.id ? (latestById.get(part.id) ?? part) : part;
    yield { rec, parsed, resolved };
  }
}

/** Bump stat counters on the ledger for tool/error/step-finish parts. */
function consumePartStats(part: ViewerPart, ledger: AgentLedger): void {
  if (part.type === "tool") {
    ledger.toolParts++;
    if (part.state.status === "error") ledger.errorRows++;
    return;
  }
  if (part.type === "step-finish") {
    const tokenTotal = numericTokenTotal(part.tokens);
    if (tokenTotal !== undefined) {
      ledger.totalTokens += tokenTotal;
      ledger.hasTokens = true;
    }
    const breakdown = extractTokenCounts(part.tokens);
    if (breakdown) addTokenCounts(ledger.tokens, breakdown);
  }
}

/**
 * Render a single part to HTML. Empty string for silent parts (step-start,
 * snapshot, patch, agent, file, subtask, retry, empty reasoning). step-finish
 * renders as a step-boundary divider.
 */
function renderPart(part: ViewerPart, ledger: AgentLedger, ctx: SubAgentCtx): string {
  if (part.type === "tool") {
    const duration = partDuration(part);
    if (part.tool === "apply_patch") return renderApplyPatch(part, duration);
    if (part.tool === "task") return renderTaskCard(part, duration, ctx, ledger);
    const status = part.state.status;
    const name = viewerToolDisplayName(part);
    const title = getStateTitle(part);
    const input = renderToolInput(name, part.state.input);
    return `<li class="row" data-status="${escapeHtml(status)}"><b>tool</b> <span>${escapeHtml(name)}</span>${duration ? ` <span>${duration}</span>` : ""}${title ? ` <span class="tool-title">${escapeHtml(safeSnippet(title))}</span>` : ""}${status === "error" ? ` <span class="err">${escapeHtml(safeSnippet(part.state.error))}</span>` : ""}${input}</li>`;
  }
  if (part.type === "text") {
    return `<li class="row" data-status="completed"><b>text</b><div class="text-body">${escapeHtml(part.text)}</div></li>`;
  }
  if (part.type === "reasoning") {
    if (!part.text.trim()) return "";
    return `<li class="row" data-status="completed"><b>reasoning</b><div class="text-body">${escapeHtml(part.text)}</div></li>`;
  }
  if (part.type === "step-finish") {
    return `<li class="row step-boundary" data-status="completed"><hr></li>`;
  }
  if (part.type === "compaction") {
    return `<li class="row" data-status="completed"><b>context compacted</b>${part.auto ? " <span>auto</span>" : ""}</li>`;
  }
  return "";
}

function renderSessionErrorRow(event: Extract<OpencodeEvent, { type: "session.error" }>): string {
  const error = event.properties.error;
  const msg =
    error && typeof error === "object" && !isOmittedMarker(error) && !Array.isArray(error)
      ? (((error as { data?: { message?: string } }).data?.message ??
          (error as { message?: string }).message ??
          (error as { name?: string }).name) as string | undefined)
      : typeof error === "string"
        ? error
        : undefined;
  return `<li class="row err" data-status="error"><b>session error</b> ${escapeHtml(safeSnippet(msg ?? "Unknown error"))}</li>`;
}

/**
 * Shared rendering loop. Walks records, dispatches event types, accumulates
 * stats into `ledger`, returns the rendered rows. Used by both the main
 * timeline and the subagent inline renderer — callers wrap the result in
 * their preferred container.
 */
function renderActivity(
  records: SessionEventLogRecord[],
  ledger: AgentLedger,
  ctx: SubAgentCtx,
): string[] {
  const rows: string[] = [];
  for (const { rec, parsed, resolved } of iterateParsedParts(records)) {
    if (parsed.kind === "truncated") {
      rows.push(
        `<li class="row truncated" data-status="pending"><b>truncated event</b> <span class="ts">${escapeHtml(rec.ts)}</span></li>`,
      );
      continue;
    }
    if (parsed.kind === "unrecognized") {
      const rawEvent = rec.type === "opencode_event" ? rec.event : undefined;
      rows.push(renderUnrecognizedEvent(rec.ts, parsed.rawType, rawEvent));
      continue;
    }
    const event = parsed.event;
    if (event.type === "session.idle" || event.type === "session.status") continue;
    if (event.type === "session.error") {
      ledger.errorRows++;
      rows.push(renderSessionErrorRow(event));
      continue;
    }
    if (!resolved) continue; // recognized telemetry-only events
    consumePartStats(resolved, ledger);
    const row = renderPart(resolved, ledger, ctx);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Render a subagent session's activity inline. Subagent sessions are written
 * to their own `ses_*.jsonl` files (no trigger boundaries — task tool spawns
 * them outside the trigger endpoint), so we stream the file line-by-line,
 * filter to the trigger's time window, dedup by part id, and emit every major
 * row (tool + non-empty assistant text). No record cap — the viewer is
 * admin-only behind Vouch and must show the full subagent activity.
 *
 * Nested `task` tools call back into this function so the recursion follows
 * the subagent chain. `ctx.visited` is the only guard — cycles (a subagent
 * pointing back at itself or an ancestor) are the only thing that would
 * otherwise loop.
 */
function renderInlineSubagent(
  sessionId: string,
  ctx: SubAgentCtx,
  window: { start: number; end?: number } | undefined,
  label: string,
  modelId: string | undefined,
): { html: string | undefined; ledger: AgentLedger } | undefined {
  if (ctx.visited.has(sessionId)) return undefined;
  // Without a time window we can't tell which subagent events belong to THIS
  // invocation versus earlier/later resumes of the same session. Skip the
  // inline render rather than show stale rows.
  if (!window) return undefined;
  let path: string;
  try {
    path = sessionLogPath(sessionId);
  } catch {
    return undefined;
  }
  const records: SessionEventLogRecord[] = [];
  const readStarted = performance.now();
  let bytesRead = 0;
  let linesRead = 0;
  for (const line of iterateJsonlFileLinesSync(path)) {
    bytesRead += line.length + 1;
    linesRead++;
    try {
      const obj = JSON.parse(line);
      const v = SessionEventLogRecordSchema.safeParse(obj);
      if (!v.success) continue;
      const ts = Date.parse(v.data.ts);
      if (!Number.isFinite(ts)) continue;
      if (ts < window.start) continue;
      if (window.end !== undefined && ts > window.end) continue;
      records.push(v.data);
    } catch {
      // skip malformed lines
    }
  }
  const readElapsedMs = performance.now() - readStarted;
  if (readElapsedMs > 50) {
    logWarn(log, "slow_subagent_jsonl_read", {
      sessionId,
      path,
      elapsedMs: Math.round(readElapsedMs),
      bytes: bytesRead,
      lines: linesRead,
      retained: records.length,
    });
  }
  if (!records.length) return undefined;

  const nextCtx: SubAgentCtx = {
    visited: new Set([...ctx.visited, sessionId]),
  };

  // The subagent's model id comes from the parent's `task` tool part metadata
  // (OpenCode tags the spawn with the child's model). Records inside the
  // subagent's own session don't carry it on step-finish parts, and any
  // modelID seen there would be a *grandchild's* model (another task tool).
  const ledger = emptyLedger(label, sessionId, modelId ? [modelId] : []);
  const rows = renderActivity(records, ledger, nextCtx);
  const html = rows.length
    ? `<details><summary>subagent activity (${rows.length} row${rows.length === 1 ? "" : "s"})</summary><ul class="events sub-events">${rows.join("")}</ul></details>`
    : undefined;
  // Even when the subagent had no display-worthy rows we keep the ledger so
  // its step-finish tokens still surface in the totals table.
  return { html, ledger };
}

function renderTaskCard(
  part: ViewerToolPart,
  durationStr: string | undefined,
  ctx: SubAgentCtx,
  parentLedger: AgentLedger,
): string {
  const rawInput = part.state.input;
  const inputOmitted = renderOmittedNote(rawInput, "input");
  const input = payloadObject(rawInput);
  const subagent = input ? safeStr(input.subagent_type) : undefined;
  const description = input ? safeStr(input.description) : undefined;
  const prompt = input ? safeStr(input.prompt) : undefined;
  const status = part.state.status;
  const rawMetadata = part.state.metadata;
  const metadataOmitted = renderOmittedNote(rawMetadata, "metadata");
  const metadata = payloadObject(rawMetadata);
  const subSession = metadata ? safeStr(metadata.sessionId) : undefined;
  const hdr = `🤖 <b>task</b>${subagent ? ` · ${escapeHtml(subagent)}` : ""}${durationStr ? ` · ${escapeHtml(durationStr)}` : ""}${inputOmitted}${metadataOmitted}`;
  const desc = description ? `<div>${escapeHtml(safeSnippet(description))}</div>` : "";
  const subChip = subSession
    ? `<div class="task-sub">subagent session <code>${escapeHtml(safeSnippet(subSession))}</code></div>`
    : "";
  const promptBlock = prompt
    ? `<details><summary>prompt</summary><pre>${escapeHtml(prompt)}</pre></details>`
    : "";
  // Task `state.output` is the model-facing summary of the subagent run.
  // We deliberately do not render it here — the subagent activity expansion
  // below already surfaces the assistant text and tool rows that comprise it.
  let subActivity = "";
  if (subSession) {
    const ledgerLabel = subagent ? `task · ${subagent}` : "task";
    // OpenCode tags the `task` tool part with the *child's* model — that's
    // the reliable source for the subagent's model id.
    const taskModelInfo = metadata && isRecord(metadata.model) ? metadata.model : undefined;
    const childModelId = taskModelInfo ? safeStr(taskModelInfo.modelID) : undefined;
    const result = renderInlineSubagent(
      subSession,
      ctx,
      partTimeWindow(part),
      ledgerLabel,
      childModelId,
    );
    if (result) {
      parentLedger.children.push(result.ledger);
      subActivity = result.html ?? "";
    }
  }
  return `<li class="task-card" data-status="${escapeHtml(status)}"><div class="task-hdr">${hdr}</div>${desc}${subChip}${promptBlock}${subActivity}</li>`;
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

function contextTokenTotal(tokens: unknown): number | undefined {
  const counts = extractTokenCounts(tokens);
  if (!counts) return undefined;
  return counts.input + counts.output + counts.reasoning + counts.cacheRead;
}

/**
 * Recover the user prompt body from the opencode_event stream. Thor wraps
 * every prompt as `[correlation-key: <key>]\n\n<body>` before sending it to
 * OpenCode (see prompt construction in this file), and OpenCode echoes that
 * text back through `message.part.updated` events. The first such text part
 * for this trigger's correlation key is the original prompt.
 */
function extractCorrelationKeyPrompt(
  records: SessionEventLogRecord[],
  correlationKey: string,
): string | undefined {
  const prefix = `[correlation-key: ${correlationKey}]`;
  for (const record of records) {
    if (record.type !== "opencode_event") continue;
    const part = eventPart(record);
    if (!part || part.type !== "text") continue;
    const text = typeof part.text === "string" ? part.text : "";
    if (!text.startsWith(prefix)) continue;
    return text.slice(prefix.length).replace(/^\s+/, "");
  }
  return undefined;
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

type AgentLedger = {
  label: string;
  sessionId: string;
  modelIds: Set<string>;
  tokens: TokenCounts;
  children: AgentLedger[];
  /** Bumped per rendered tool part. */
  toolParts: number;
  /** Bumped per error-status tool part and per session.error event. */
  errorRows: number;
  /** Sum of `step-finish` numeric token totals (single-number summary). */
  totalTokens: number;
  /** True once any step-finish has carried token counts. Drives footer
   *  visibility for model/cost so empty triggers don't surface defaults. */
  hasTokens: boolean;
};

function emptyLedger(
  label: string,
  sessionId: string,
  modelIds: Iterable<string> = [],
): AgentLedger {
  return {
    label,
    sessionId,
    modelIds: new Set(modelIds),
    tokens: emptyTokenCounts(),
    children: [],
    toolParts: 0,
    errorRows: 0,
    totalTokens: 0,
    hasTokens: false,
  };
}

function emptyTokenCounts(): TokenCounts {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
}

function addTokenCounts(target: TokenCounts, src: TokenCounts): void {
  target.input += src.input;
  target.output += src.output;
  target.reasoning += src.reasoning;
  target.cacheRead += src.cacheRead;
}

function hasAnyTokens(t: TokenCounts): boolean {
  return t.input + t.output + t.reasoning + t.cacheRead > 0;
}

function sumLedgerTokens(node: AgentLedger): TokenCounts {
  const acc = emptyTokenCounts();
  const walk = (n: AgentLedger) => {
    addTokenCounts(acc, n.tokens);
    n.children.forEach(walk);
  };
  walk(node);
  return acc;
}

function flattenLedger(root: AgentLedger): Array<{ ledger: AgentLedger; depth: number }> {
  const out: Array<{ ledger: AgentLedger; depth: number }> = [];
  const walk = (n: AgentLedger, depth: number) => {
    out.push({ ledger: n, depth });
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  return out;
}

function ledgerRowCost(l: AgentLedger): number | undefined {
  if (l.modelIds.size !== 1) return undefined;
  const [m] = l.modelIds;
  return estimateCostUsd(l.tokens, m);
}

function tokenCell(n: number): string {
  return n > 0 ? escapeHtml(formatTokens(n)) : "—";
}

function renderTotalsTable(root: AgentLedger): string {
  const flat = flattenLedger(root);
  const total = sumLedgerTokens(root);
  let totalCost = 0;
  let costPartial = false;
  const rows = flat.map(({ ledger, depth }) => {
    const indent = `style="padding-left:${depth * 16 + 8}px"`;
    const prefix = depth > 0 ? "└ " : "";
    const sidChip = ledger.sessionId
      ? ` <code class="ledger-sid" title="${escapeHtml(ledger.sessionId)}">${escapeHtml(ledger.sessionId)}</code>`
      : "";
    const models = [...ledger.modelIds].sort();
    const modelCell = models.length ? escapeHtml(models.join(", ")) : "—";
    const cost = ledgerRowCost(ledger);
    if (cost !== undefined && cost > 0) {
      totalCost += cost;
    } else if (hasAnyTokens(ledger.tokens)) {
      costPartial = true;
    }
    const costCell = cost !== undefined && cost > 0 ? `~${formatCostUsd(cost)}` : "—";
    return (
      `<tr><th scope="row" ${indent}>${prefix}${escapeHtml(ledger.label)}${sidChip}</th>` +
      `<td>${modelCell}</td>` +
      `<td>${tokenCell(ledger.tokens.input)}</td>` +
      `<td>${tokenCell(ledger.tokens.cacheRead)}</td>` +
      `<td>${tokenCell(ledger.tokens.output)}</td>` +
      `<td>${tokenCell(ledger.tokens.reasoning)}</td>` +
      `<td>${costCell}</td></tr>`
    );
  });
  const totalCostCell =
    totalCost > 0 ? `${costPartial ? "≥ " : ""}~${formatCostUsd(totalCost)}` : "—";
  const totalRow =
    `<tr class="totals-total"><th scope="row">Total</th><td>—</td>` +
    `<td>${tokenCell(total.input)}</td>` +
    `<td>${tokenCell(total.cacheRead)}</td>` +
    `<td>${tokenCell(total.output)}</td>` +
    `<td>${tokenCell(total.reasoning)}</td>` +
    `<td>${totalCostCell}</td></tr>`;
  return (
    `<table class="totals-table"><thead><tr>` +
    `<th>Agent</th><th>Model</th><th>Input</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Cost</th>` +
    `</tr></thead><tbody>${rows.join("")}${totalRow}</tbody></table>`
  );
}

/** UUIDs render as their last 7 characters everywhere on the viewer. */
function shortUuid(value: string): string {
  return value.length > 7 ? value.slice(-7) : value;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}main{max-width:900px;margin:0 auto;padding:24px}.pill{display:inline-block;border-radius:999px;padding:4px 10px;font-weight:700}.completed{background:#dcfce7;color:#166534}.error,.crashed{background:#fee2e2;color:#991b1b}.aborted{background:#ffedd5;color:#9a3412}.in_flight{background:#fef9c3;color:#854d0e}.summary{color:#334155;font-weight:500;margin:8px 0}.chips{color:#475569;font-size:0.9em;margin:4px 0}.chips code{font-size:0.95em}.live{display:inline-block;margin-left:8px;color:#dc2626;font-size:0.9em;animation:thor-pulse 1.6s ease-in-out infinite}@keyframes thor-pulse{0%,100%{opacity:1}50%{opacity:0.35}}@media (prefers-reduced-motion:reduce){.live{animation:none}}.row.truncated{color:#94a3b8;font-style:italic}.row.truncated .ts{color:#cbd5e1;font-size:0.85em;margin-left:4px}.omitted{color:#94a3b8;font-style:italic;font-size:0.9em}.source{margin:8px 0;font-size:1.05em}.source a{color:#0f172a;text-decoration:none;border-bottom:1px solid #cbd5e1}.source a:hover{border-bottom-color:#0f172a}.events{list-style:none;padding-left:0}.events>li{margin:6px 0}.row.step-boundary{padding-left:0}.row.step-boundary::before{display:none}.row.step-boundary hr{border:none;border-top:1px dashed #cbd5e1;margin:8px 0}.row{position:relative;padding-left:18px}.row::before{content:"";position:absolute;left:2px;top:0.55em;width:8px;height:8px;border-radius:50%;background:#94a3b8}.row[data-status="completed"]::before{background:#22c55e}.row[data-status="running"]::before{background:#facc15}.row[data-status="pending"]::before{background:#cbd5e1}.row[data-status="error"]::before{background:#ef4444}.row[data-status="aborted"]::before{background:#f97316}.tool-title{color:#475569;font-style:italic;margin-left:6px}.text-body{white-space:pre-wrap;margin:4px 0 0;color:#0f172a;font-size:0.95em}.task-card{background:#f1f5f9;border-left:3px solid #6366f1;padding:8px 12px;border-radius:4px;margin:6px 0;list-style:none}.task-card .task-hdr{color:#3730a3;font-size:0.9em;font-weight:600;margin-bottom:4px}.task-card .task-sub{color:#475569;font-size:0.85em;margin:2px 0 4px}.sub-events{margin:6px 0 0;padding-left:12px;border-left:2px solid #c7d2fe}.totals{color:#475569;font-size:0.95em;margin:12px 0 4px}.totals-table{border-collapse:collapse;font-size:0.9em;margin:8px 0;width:100%}.totals-table th,.totals-table td{padding:4px 8px;text-align:right;border-bottom:1px solid #e2e8f0}.totals-table thead th{color:#64748b;font-weight:600;text-align:right;border-bottom:1px solid #cbd5e1}.totals-table thead th:first-child,.totals-table tbody th{text-align:left}.totals-table tbody th{font-weight:500;color:#0f172a}.totals-table .ledger-sid{color:#64748b;font-size:0.85em;margin-left:4px}.totals-table tr.totals-total th,.totals-table tr.totals-total td{font-weight:700;border-top:2px solid #cbd5e1;border-bottom:none;padding-top:6px}.diff{font-size:0.85em;line-height:1.4}.diff .diff-add{color:#86efac;display:block}.diff .diff-del{color:#fca5a5;display:block}.diff .diff-meta{color:#94a3b8;display:block}details{margin:4px 0}summary{cursor:pointer}pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow:auto}</style></head><body><main><header><h1>${escapeHtml(title)}</h1></header>${body}</main></body></html>`;
}

function renderSlicePage(
  anchorId: string,
  triggerId: string,
  ownerSessionId: string,
  anchor: ReverseAnchorEntry,
  slice: Exclude<ReturnType<typeof readTriggerSlice>, { notFound: true }>,
  opts: { slackTeamId: string | null },
): string {
  const start = slice.records.find(
    (record) => record.type === "trigger_start" && record.triggerId === triggerId,
  );
  const end = slice.records.find(
    (record) => record.type === "trigger_end" && record.triggerId === triggerId,
  );
  const correlationKey = start?.type === "trigger_start" ? start.correlationKey : undefined;
  // The user prompt body lives in the opencode_event stream as the first
  // `text` part prefixed with `[correlation-key: <key>]` — see prompt
  // construction at `:814`. Strip the prefix to recover the original prompt;
  // that's what `decodeSourceLine` parses for Slack/GitHub fields.
  const promptPreview = correlationKey
    ? extractCorrelationKeyPrompt(slice.records, correlationKey)
    : undefined;

  // TODO(model-attribution): the main agent's model isn't recorded anywhere
  // in the on-disk JSONL today — OpenCode emits it on `message.updated`
  // events which Thor's runner doesn't subscribe to, and `step-finish` parts
  // don't carry it. We hardcode `gpt-5.4` (Thor's current default main-agent
  // model) so the totals/cost stay useful; switch to the real value once
  // the runner persists `message.updated` events or we call `sessions.get`
  // at render time.
  const rootLedger = emptyLedger("main", ownerSessionId, ["gpt-5.4"]);
  const tokenTotals = rootLedger.tokens;
  const modelIds = rootLedger.modelIds;
  const subAgentCtx: SubAgentCtx = { visited: new Set([ownerSessionId]) };
  const rows = renderActivity(slice.records, rootLedger, subAgentCtx);
  const { toolParts, errorRows, totalTokens, hasTokens } = rootLedger;

  const aliases = anchor.externalKeys
    .map(
      (key) => `${key.aliasType}: ${safeSnippet(decodeAliasValue(key.aliasType, key.aliasValue))}`,
    )
    .join("; ");
  const durationStr = formatDuration(end?.type === "trigger_end" ? end.durationMs : undefined);
  // "last event ago" is only useful while in flight (admin watching for a
  // stall). On terminal triggers it just restates how long ago the trigger
  // ended — drop it.
  const ageStr = slice.status === "in_flight" ? formatAge(slice.lastEventTs) : undefined;
  const summaryBits = [
    durationStr,
    `${toolParts} tools`,
    errorRows ? `${errorRows} errors` : undefined,
    ageStr ? `last event ${ageStr} ago` : undefined,
  ].filter((s): s is string => !!s);
  const summaryLine = summaryBits.join(" · ");

  const pillReason =
    (slice.status === "aborted" || slice.status === "crashed") && slice.reason
      ? ` · ${escapeHtml(safeSnippet(slice.reason))}`
      : "";
  const livePill =
    slice.status === "in_flight" ? ` <span class="live" aria-label="live">● live</span>` : "";
  const ownerChip = `<code>${escapeHtml(safeSnippet(ownerSessionId))}</code>`;
  const currentChip =
    anchor.currentSessionId && anchor.currentSessionId !== ownerSessionId
      ? ` · current <code>${escapeHtml(safeSnippet(anchor.currentSessionId))}</code>`
      : "";
  // Subagent token rollup: when the trigger spawned subagents, render a table
  // (one row per agent, indented by depth) so admins can see per-subagent cost
  // alongside the main trigger. Otherwise keep the single-line footer.
  let totalsFooter = "";
  if (rootLedger.children.length > 0) {
    totalsFooter = `<div class="totals">${renderTotalsTable(rootLedger)}</div>`;
  } else {
    const totalsBits: string[] = [];
    if (hasTokens) {
      const tokenParts: string[] = [];
      if (tokenTotals.input) tokenParts.push(`${formatTokens(tokenTotals.input)} input`);
      if (tokenTotals.cacheRead) tokenParts.push(`${formatTokens(tokenTotals.cacheRead)} cached`);
      if (tokenTotals.output) tokenParts.push(`${formatTokens(tokenTotals.output)} output`);
      if (tokenTotals.reasoning)
        tokenParts.push(`${formatTokens(tokenTotals.reasoning)} reasoning`);
      totalsBits.push(
        tokenParts.length
          ? `Tokens: ${tokenParts.join(" · ")}`
          : `Tokens: ${formatTokens(totalTokens)}`,
      );
    }
    const sortedModelIds = [...modelIds].sort();
    // Only surface model/cost when we actually saw token data — avoids
    // confidently displaying the hardcoded `gpt-5.4` default on zero-token
    // sessions (e.g. an aborted trigger with no step-finish parts).
    if (hasTokens) {
      if (sortedModelIds.length === 1) {
        totalsBits.push(`Model: ${escapeHtml(sortedModelIds[0]!)}`);
      } else if (sortedModelIds.length > 1) {
        totalsBits.push(`Models: ${sortedModelIds.map((m) => escapeHtml(m)).join(", ")}`);
      }
      if (sortedModelIds.length === 1) {
        const cost = estimateCostUsd(tokenTotals, sortedModelIds[0]);
        if (cost !== undefined && cost > 0) {
          totalsBits.push(`Est cost: ~${formatCostUsd(cost)}`);
        }
      }
    }
    totalsFooter = totalsBits.length ? `<p class="totals">${totalsBits.join(" · ")}</p>` : "";
  }
  const decodedSource = decodeSourceLine(correlationKey, promptPreview, opts.slackTeamId);
  const sourceLine = decodedSource ? renderSourceLine(decodedSource) : "";
  // Tab title: <source-type> · <short-trigger-id> · Thor.
  // Short id makes multiple open tabs distinguishable without duplicating the
  // full source label that the in-page source line already shows.
  const pageTitle = `${sourceFrom(correlationKey)} · ${shortUuid(triggerId)} · Thor`;

  const activityHtml = rows.length
    ? `<ul class="events">${rows.join("")}</ul>`
    : "<p>No meaningful events recorded.</p>";

  // The prompt body now lives as the first activity row (the
  // `[correlation-key: …]` text part). No need for a separate preview block
  // in Trigger context.

  const body = `<section><span class="pill ${slice.status}">${escapeHtml(slice.status.replace("_", " "))}${pillReason}</span>${livePill}<h2>${escapeHtml(sourceFrom(correlationKey))} trigger</h2>${sourceLine}${summaryLine ? `<p class="summary">${escapeHtml(summaryLine)}</p>` : ""}<p class="chips">anchor <code title="${escapeHtml(anchorId)}">${escapeHtml(shortUuid(anchorId))}</code> · trigger <code title="${escapeHtml(triggerId)}">${escapeHtml(shortUuid(triggerId))}</code> · session ${ownerChip}${currentChip}</p></section><section><h3>Trigger context</h3>${correlationKey ? `<p>Correlation <code>${escapeHtml(safeSnippet(correlationKey))}</code></p>` : ""}${aliases ? `<p>Aliases: ${escapeHtml(aliases)}</p>` : ""}<p>Sessions: ${anchor.sessionIds.map((id) => `<code>${escapeHtml(safeSnippet(id))}</code>`).join(" ") || "none"}</p>${anchor.subsessionIds.length ? `<p>Subsessions: ${anchor.subsessionIds.map((id) => `<code>${escapeHtml(safeSnippet(id))}</code>`).join(" ")}</p>` : ""}</section><section>${activityHtml}${totalsFooter}</section>`;
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
