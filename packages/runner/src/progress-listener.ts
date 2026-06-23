/**
 * Passive Slack progress projection from the OpenCode event stream.
 *
 * ProgressListener registers as a firehose observer on the EventBusRegistry
 * and derives Slack progress events from the raw OpenCode SSE stream. It does
 * not send prompts, write session logs, or manage session lifecycle — those
 * remain the responsibility of runPromptStream and the trigger handler.
 *
 * Thread resolution:
 *   sessionId -> anchorId (via resolveSessionAnchorId)
 *             -> slack.thread externalKey (via reverseLookupAnchor)
 *             -> resolveSlackProgressTarget
 *
 * Error semantics (timerless):
 *   session.error sets pendingError for the parent session.
 *   Any subsequent message.part.updated or message.updated on the parent
 *   clears pendingError. Parent session.idle finalizes as completed (no
 *   pending error) or error (pending error remains).
 */

import type { Event, ToolPart } from "@opencode-ai/sdk";
import {
  createLogger,
  logError,
  handleProgressEvent,
  resolveSessionAnchorId,
  anchorHasExternalKeyType,
  reverseLookupAnchor,
  type ProgressEvent,
  type ProgressTransport,
  type ProgressTarget,
} from "@thor/common";
import type { FirehoseObserver } from "./event-bus.ts";
import { resolveSlackProgressTarget, type SlackProgressTransportTarget } from "./slack-progress.ts";
import {
  toolDisplayName,
  messageUpdatedInfo,
  emitContextProgressFromInfo,
  sessionErrorMessage,
} from "./prompt-stream.ts";
import { getMemoryProgressEvents } from "./memory-progress.ts";
import { isRecord, type ModelContextLimits } from "./opencode-events.ts";

const log = createLogger("progress-listener");

export class ProgressListener {
  /** sessionId -> error message for the parent session's last session.error */
  private pendingErrors = new Map<string, string>();
  /**
   * threadKey -> set of "sessionID|messageID|callID" emitted once per tool start.
   * Keyed by thread (not flat) so the whole set can be dropped when the thread's
   * parent session.idle finalizes — otherwise it would grow unbounded over the
   * process-lifetime listener.
   */
  private emittedToolStarts = new Map<string, Set<string>>();
  /** threadKey -> set of "sessionID|messageID|callID" emitted once per delegation. */
  private emittedTaskDelegates = new Map<string, Set<string>>();
  /** Per-thread serialized Slack API call chain. Key = progressTarget.key */
  private progressChains = new Map<string, Promise<void>>();
  private transport: ProgressTransport<SlackProgressTransportTarget>;
  private modelContextLimits: () => ModelContextLimits;

  constructor(
    addObserver: (observer: FirehoseObserver) => void,
    transport: ProgressTransport<SlackProgressTransportTarget>,
    modelContextLimits: () => ModelContextLimits,
  ) {
    this.transport = transport;
    this.modelContextLimits = modelContextLimits;
    addObserver(this.onEvent.bind(this));
  }

  private onEvent(event: Event, sessionId: string | undefined): void {
    if (!sessionId) return;

    const anchorId = resolveSessionAnchorId(sessionId);
    if (!anchorId) return;

    // Cheap reject before materializing a full ReverseAnchorEntry — the firehose
    // sees every event process-wide and most anchors have no slack.thread.
    if (!anchorHasExternalKeyType(anchorId, "slack.thread")) return;

    const anchor = reverseLookupAnchor(anchorId);

    const slackThreadKey = anchor.externalKeys.find((k) => k.aliasType === "slack.thread");
    if (!slackThreadKey) return;

    const correlationKey = `slack:thread:${slackThreadKey.aliasValue}`;
    const progressTarget = resolveSlackProgressTarget(correlationKey);
    if (!progressTarget) return;

    // Parent: the current session bound to this anchor.
    const isParent = sessionId === anchor.currentSessionId;

    this.processEvent(event, sessionId, progressTarget, isParent);
  }

  private processEvent(
    event: Event,
    sessionId: string,
    progressTarget: ProgressTarget<SlackProgressTransportTarget>,
    isParent: boolean,
  ): void {
    if (event.type === "message.part.updated") {
      const part = event.properties.part;

      // Any parent part — tool, text, retry, step-finish — means the session is
      // still running, so an earlier session.error has been recovered. Clear
      // before the tool-type check so a non-tool recovery part counts too,
      // matching the HTTP /trigger path (seq-based clearIfRecovered).
      if (isParent) {
        this.pendingErrors.delete(sessionId);
      }

      if (part.type === "tool") {
        const toolPart = part as ToolPart;
        const status = toolPart.state.status;

        this.maybeEmitDelegate(toolPart, progressTarget);

        if (status === "running") {
          this.maybeEmitTool(toolPart, "running", progressTarget);
        } else if (status === "completed" || status === "error") {
          this.maybeEmitTool(toolPart, status, progressTarget);
          const input = (toolPart.state as { input?: unknown }).input;
          for (const memEvent of getMemoryProgressEvents({
            tool: toolPart.tool,
            status,
            input,
          })) {
            const captured = memEvent;
            this.enqueue(progressTarget.key, () =>
              handleProgressEvent(progressTarget, captured, this.transport),
            );
          }
        }
      }
    } else if (event.type === "message.updated" && isParent) {
      // Parent activity after a session.error clears the pending error.
      this.pendingErrors.delete(sessionId);

      const info = messageUpdatedInfo(event);
      if (info) {
        const emitFn = (e: ProgressEvent) =>
          this.enqueue(progressTarget.key, () =>
            handleProgressEvent(progressTarget, e, this.transport),
          );
        emitContextProgressFromInfo(info, this.modelContextLimits(), emitFn);
      }
    } else if (event.type === "session.error" && isParent) {
      const errorMsg = sessionErrorMessage(event.properties.error);
      this.pendingErrors.set(sessionId, errorMsg);
      // Render inline error activity so the Slack bubble reflects the failure
      // even if a later idle never arrives.
      this.enqueue(progressTarget.key, () =>
        handleProgressEvent(
          progressTarget,
          { type: "tool", tool: "error", status: "error" },
          this.transport,
        ),
      );
    } else if (event.type === "session.idle" && isParent) {
      const pendingError = this.pendingErrors.get(sessionId);
      this.pendingErrors.delete(sessionId);

      const status: "completed" | "error" = pendingError ? "error" : "completed";
      this.enqueue(progressTarget.key, () =>
        handleProgressEvent(
          progressTarget,
          {
            type: "done",
            sessionId,
            resumed: false,
            status,
            ...(pendingError ? { error: pendingError } : {}),
            response: "",
            toolCalls: [],
            durationMs: 0,
          },
          this.transport,
        ),
      );

      // The turn ended: drop per-thread dedup state so it cannot accumulate
      // over the process-lifetime listener. The next turn re-emits from scratch.
      this.emittedToolStarts.delete(progressTarget.key);
      this.emittedTaskDelegates.delete(progressTarget.key);
    }
  }

  private maybeEmitTool(
    toolPart: ToolPart,
    status: "running" | "completed" | "error",
    progressTarget: ProgressTarget<SlackProgressTransportTarget>,
  ): void {
    const key = `${toolPart.sessionID}|${toolPart.messageID}|${toolPart.callID}`;
    const seen = this.emittedToolStarts.get(progressTarget.key) ?? new Set<string>();
    if (seen.has(key)) return;
    seen.add(key);
    this.emittedToolStarts.set(progressTarget.key, seen);
    const displayName = toolDisplayName(toolPart);
    this.enqueue(progressTarget.key, () =>
      handleProgressEvent(
        progressTarget,
        { type: "tool", tool: displayName, status },
        this.transport,
      ),
    );
  }

  private maybeEmitDelegate(
    toolPart: ToolPart,
    progressTarget: ProgressTarget<SlackProgressTransportTarget>,
  ): void {
    if (toolPart.tool !== "task") return;

    const input = (toolPart.state as { input?: unknown }).input;
    if (!isRecord(input)) return;
    const raw = input.subagent_type;
    if (typeof raw !== "string") return;
    const agent = raw.trim();
    if (!agent) return;

    const key = `${toolPart.sessionID}|${toolPart.messageID}|${toolPart.callID}`;
    const seen = this.emittedTaskDelegates.get(progressTarget.key) ?? new Set<string>();
    if (seen.has(key)) return;
    seen.add(key);
    this.emittedTaskDelegates.set(progressTarget.key, seen);

    this.enqueue(progressTarget.key, () =>
      handleProgressEvent(progressTarget, { type: "delegate", agent }, this.transport),
    );
  }

  /**
   * Serialize Slack API calls per thread so concurrent events for the same
   * thread do not race on the ProgressSession state.
   */
  private enqueue(threadKey: string, fn: () => Promise<void>): void {
    const chain = this.progressChains.get(threadKey) ?? Promise.resolve();
    const next: Promise<void> = chain
      .catch(() => undefined)
      .then(fn)
      .catch((err) => {
        logError(log, "progress_enqueue_error", err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        // Drop the entry once this thread's queue drains so idle threads don't
        // retain a resolved promise for the process lifetime. If newer work was
        // chained after us, the map already points past `next` — leave it.
        if (this.progressChains.get(threadKey) === next) {
          this.progressChains.delete(threadKey);
        }
      });
    this.progressChains.set(threadKey, next);
  }
}
