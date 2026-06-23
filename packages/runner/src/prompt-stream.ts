import { createOpencodeClient } from "@opencode-ai/sdk";
import type {
  Event,
  Part,
  TextPart,
  ToolPart,
  StepFinishPart,
  ToolStateCompleted,
  ToolStateError,
} from "@opencode-ai/sdk";
import {
  createLogger,
  logInfo,
  logWarn,
  logError,
  truncate,
  appendSessionEvent,
  appendAlias,
} from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import type { SessionSubscription } from "./event-bus.ts";
import { IdleAutoResume, type AssistantMessageSummary } from "./idle-auto-resume.ts";
import { SessionErrorGrace } from "./session-error-grace.ts";
import { contextLimitKey, isRecord, safeStr, type ModelContextLimits } from "./opencode-events.ts";

const log = createLogger("runner");

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

/** Terminal error when an assistant message idles without producing output. */
export const ASSISTANT_EMPTY_ERROR_OUTPUT = "Assistant message failed before producing output";

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

const KNOWN_BINS: Record<string, number> = {
  approval: 2,
  corepack: 2,
  gh: 2,
  git: 2,
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

/**
 * Extract a short display name from a tool part.
 * For bash, show the wrapper binary (e.g. "git checkout") when the command starts
 * with one of our known wrappers; otherwise show "bash".
 */
export function toolDisplayName(toolPart: ToolPart): string {
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

export function sessionErrorMessage(error: unknown): string {
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

export function messageUpdatedInfo(event: Event): Record<string, unknown> | undefined {
  const properties = (event as unknown as { properties?: unknown }).properties;
  if (!isRecord(properties)) return undefined;
  const info = properties.info ?? properties.message;
  return isRecord(info) ? info : undefined;
}

function messageInfoId(info: Record<string, unknown>): string | undefined {
  return (
    safeStr(info.id) ??
    safeStr(info.messageID) ??
    safeStr(info.messageId) ??
    safeStr(info.message_id)
  );
}

function messageInfoRole(info: Record<string, unknown>): string | undefined {
  return safeStr(info.role) ?? safeStr(info.type);
}

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

/**
 * Live context-window occupancy: input + output + reasoning + cache reads.
 * A runtime heuristic for the context-usage progress event — deliberately
 * independent of the viewer's token-breakdown rendering, which reads the
 * persisted event payload directly. Returns undefined when there are no tokens.
 */
function contextTokenTotal(tokens: unknown): number | undefined {
  if (!isRecord(tokens)) return undefined;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const total =
    num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + (cache ? num(cache.read) : 0);
  return total === 0 ? undefined : total;
}

function assistantMessageSummaryFromInfo(
  info: Record<string, unknown>,
): AssistantMessageSummary | undefined {
  const role = messageInfoRole(info);
  if (role && role !== "assistant") return undefined;
  const id = messageInfoId(info);
  if (!id) return undefined;
  return {
    id,
    finish: safeStr(info.finish) ?? safeStr(info.finishReason) ?? safeStr(info.finish_reason),
    tokenTotal: contextTokenTotal(info.tokens),
  };
}

export function emitContextProgressFromInfo(
  info: Record<string, unknown>,
  limits: ModelContextLimits,
  emit: (event: ProgressEvent) => void,
): void {
  const role = messageInfoRole(info);
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

export interface PromptStreamDeps {
  client: OpencodeClient;
  subscription: SessionSubscription;
  sessionId: string;
  anchorId: string;
  /** Grace window for a session.error before it becomes terminal. */
  sessionErrorGraceMs: number;
  /**
   * Serialize a session-scoped send against concurrent trigger sends. The idle
   * auto-resume "Continue" uses this so it can't double-send into a session a
   * new trigger already drove busy; the trigger handler holds the same lock.
   */
  sendLock: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface PromptStreamResult {
  /** Terminal error message, or undefined when the run completed cleanly. */
  terminalError: string | undefined;
  /** Assistant text parts, in arrival order. */
  textParts: string[];
  /** Completed/errored tool calls observed on the parent session. */
  toolCalls: Array<{ tool: string; state: string }>;
  /** Total parent message parts processed (drives the done summary). */
  totalParts: number;
}

/**
 * Consume the OpenCode SSE stream for one prompt until the parent session
 * settles, persisting events, forwarding progress, discovering child sessions,
 * applying the session-error grace window, and driving idle auto-resume. The
 * subscription is closed before returning.
 */
export async function runPromptStream(deps: PromptStreamDeps): Promise<PromptStreamResult> {
  const { client, subscription, sessionId, anchorId } = deps;

  let seq = 0;
  const collectedTextParts: string[] = [];
  const collectedToolCalls: Array<{ tool: string; state: string }> = [];
  let terminalError: string | undefined;
  const errorGrace = new SessionErrorGrace(deps.sessionErrorGraceMs);
  const autoResume = new IdleAutoResume();
  let sawParentMessagePart = false;
  // Track child session IDs for child-session discovery.
  const childSessionIds = new Set<string>();
  // Text parts are roleless; learn parent message roles from message.updated
  // before allowing text to re-arm idle auto-resume.
  const parentMessageRoles = new Map<string, string>();
  const pendingNonEmptyTextMessageIds = new Set<string>();

  const iterator = subscription[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = errorGrace.pending
        ? await nextWithTimeout(iterator, errorGrace.remainingMs())
        : await iterator.next();

      if (next === "timeout") {
        terminalError = errorGrace.error;
        break;
      }
      if (next.done) {
        terminalError = errorGrace.error;
        break;
      }

      const event = next.value;

      // Child sub-session events land in the child's own log so the
      // viewer's owner-only slice never surfaces them.
      const resolvedSessionId = eventSessionId(event);
      const originSessionId = resolvedSessionId ?? sessionId;
      appendSessionEvent(originSessionId, { type: "opencode_event", event });

      const isParent = resolvedSessionId === sessionId;

      if (isParent && event.type === "message.updated") {
        const info = messageUpdatedInfo(event);
        if (info) {
          const messageId = messageInfoId(info);
          const role = messageInfoRole(info);
          if (messageId && role) {
            parentMessageRoles.set(messageId, role);
            if (role === "assistant" && pendingNonEmptyTextMessageIds.delete(messageId)) {
              autoResume.onAssistantText(messageId, true);
            } else if (role !== "assistant") {
              pendingNonEmptyTextMessageIds.delete(messageId);
            }
          }
          const assistantMessage = assistantMessageSummaryFromInfo(info);
          if (assistantMessage) {
            autoResume.onAssistantMessageUpdate(assistantMessage);
          }
        }
      }

      // Non-parent events (child sessions) must never drive parent terminal
      // handling below — a child's session.idle / session.error would otherwise
      // end the parent run before its final answer is emitted.
      if (!isParent) {
        continue;
      }

      if (event.type === "message.part.updated") {
        sawParentMessagePart = true;
        const part = event.properties.part;
        seq++;

        errorGrace.clearIfRecovered(seq);

        // Stdout logging (selective)
        logPartToStdout(sessionId, part);

        // Accumulate data for response regardless of filtering
        if (part.type === "text") {
          const textPart = part as TextPart;
          collectedTextParts.push(textPart.text);
          const hasContent = textPart.text.trim().length > 0;
          if (hasContent) {
            const role = parentMessageRoles.get(textPart.messageID);
            if (role === "assistant") {
              autoResume.onAssistantText(textPart.messageID, true);
            } else if (!role) {
              pendingNonEmptyTextMessageIds.add(textPart.messageID);
            }
          }
        } else if (part.type === "tool") {
          const toolPart = part as ToolPart;
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

          if (status === "completed" || status === "error") {
            const displayName = toolDisplayName(toolPart);
            collectedToolCalls.push({ tool: displayName, state: status });
          }
        }
      } else if (event.type === "session.error") {
        const errorProps = event.properties;
        const errorMessage = sessionErrorMessage(errorProps.error);
        errorGrace.record(errorMessage, seq);
        collectedToolCalls.push({ tool: "error", state: "error" });
        logError(log, "session_error", errorMessage, {
          sessionId,
          errorDetail: JSON.stringify(errorProps.error),
        });
      } else if (event.type === "session.idle") {
        const failedAssistantIdle = autoResume.isFailedAssistantIdle();
        const resumeMessageId = autoResume.decideResume();
        if (!sawParentMessagePart && !failedAssistantIdle) {
          logInfo(log, "stale_session_idle_ignored", { sessionId });
          continue;
        }
        if (resumeMessageId) {
          autoResume.markResumed(resumeMessageId);
          logInfo(log, "session_idle_auto_resume", {
            sessionId,
            messageId: resumeMessageId,
          });
          // We're deliberately keeping the run alive with a fresh prompt, so any
          // held session.error must not throttle/terminate the continued
          // response via a stale grace window timed from the original error.
          errorGrace.clear();
          // Serialize against concurrent trigger sends and re-check status under
          // the lock: if a new prompt already drove the session busy in the gap
          // since session.idle, skip the Continue rather than double-send. The
          // new trigger's own stream carries that prompt; this run ends as the
          // failed idle it already was.
          const continueResult = await deps.sendLock(async () => {
            const liveStatus = (await client.session.status({})).data?.[sessionId];
            if (liveStatus?.type === "busy") return undefined;
            return client.session.promptAsync({
              path: { id: sessionId },
              body: { parts: [{ type: "text", text: "Continue" }] },
            });
          });
          if (continueResult && !continueResult.error) continue;
          if (continueResult?.error) {
            logError(log, "session_idle_auto_resume_failed", JSON.stringify(continueResult.error), {
              sessionId,
              messageId: resumeMessageId,
            });
          } else if (!continueResult) {
            logInfo(log, "session_idle_auto_resume_skipped_busy", {
              sessionId,
              messageId: resumeMessageId,
            });
          }
        }
        terminalError =
          errorGrace.error ?? (failedAssistantIdle ? ASSISTANT_EMPTY_ERROR_OUTPUT : undefined);
        break;
      }
    }
  } finally {
    await iterator.return?.();
    subscription.close();
  }

  return {
    terminalError,
    textParts: collectedTextParts,
    toolCalls: collectedToolCalls,
    totalParts: seq,
  };
}
