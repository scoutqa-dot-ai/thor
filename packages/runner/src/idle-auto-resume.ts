/**
 * Idle auto-resume state machine.
 *
 * OpenCode sometimes idles a session right after an assistant message that
 * finished with `finish === "error"` and produced zero tokens — a model/provider
 * hiccup, not a real answer. When that happens we send a single "Continue" to
 * nudge the model rather than surfacing an empty failure to the caller.
 *
 * The transitions are driven from three points in the runner's stream loop
 * (assistant `message.updated`, assistant `text` parts, and `session.idle`),
 * which is exactly why the logic lives here instead of inline: the arm/disarm
 * rules must stay in one place so they can't drift apart.
 *
 * Rules:
 *  - Armed by default; each failed-idle resume disarms until a *new* message id
 *    proves the session recovered (real tokens or real text output).
 *  - A given failed message id is resumed at most once, ever.
 *  - A message id that ever produced non-empty text is never treated as a
 *    failed idle, even if a later zero-token error update arrives for it.
 *  - At most {@link MAX_RESUMES} resumes per run, regardless of message id — a
 *    flapping provider that emits tokens then a zero-token error on an
 *    ever-new id would otherwise re-arm and loop "Continue" without bound.
 */

/** Hard ceiling on auto-resumes per run, across all message ids. */
export const MAX_RESUMES = 3;

export interface AssistantMessageSummary {
  id: string;
  finish: string | undefined;
  tokenTotal: number | undefined;
}

export class IdleAutoResume {
  #armed = true;
  #disarmedAfterMessageId: string | undefined;
  #resumeCount = 0;
  readonly #resumedFailedMessageIds = new Set<string>();
  readonly #messageIdsWithOutput = new Set<string>();
  #latest: AssistantMessageSummary | undefined;

  /**
   * Record the latest assistant `message.updated` summary. Re-arms when a
   * *different* message id reports real tokens after a prior resume disarmed us
   * — proof the session moved on to fresh work.
   */
  onAssistantMessageUpdate(summary: AssistantMessageSummary): void {
    this.#latest = summary;
    if (
      !this.#armed &&
      summary.id !== this.#disarmedAfterMessageId &&
      (summary.tokenTotal ?? 0) > 0
    ) {
      this.#rearm();
    }
  }

  /**
   * Record an assistant `text` part. Non-empty text means the message produced
   * real output, so it can never be a failed idle; it also re-arms and clears
   * the latest-message tracking (the prior summary no longer represents a
   * pending answer).
   */
  onAssistantText(messageId: string, hasContent: boolean): void {
    if (!hasContent) return;
    this.#messageIdsWithOutput.add(messageId);
    this.#latest = undefined;
    this.#rearm();
  }

  /**
   * True when the session idled on an assistant message that finished with an
   * error, produced no tokens, and never emitted text — i.e. an empty failure.
   * Independent of arm/resume state; used to decide the terminal error.
   */
  isFailedAssistantIdle(): boolean {
    const latest = this.#latest;
    return (
      !!latest &&
      latest.finish === "error" &&
      (latest.tokenTotal ?? 0) <= 0 &&
      !this.#messageIdsWithOutput.has(latest.id)
    );
  }

  /**
   * Decide whether to send "Continue" for the current idle. Returns the failed
   * message id to resume, or undefined to let the run terminate. Does not mutate
   * state — call {@link markResumed} once the Continue prompt is sent.
   */
  decideResume(): string | undefined {
    if (this.#resumeCount >= MAX_RESUMES) return undefined;
    if (!this.#armed || !this.isFailedAssistantIdle()) return undefined;
    const id = this.#latest!.id;
    if (this.#resumedFailedMessageIds.has(id)) return undefined;
    return id;
  }

  /** Mark a failed message id as resumed and disarm until the session recovers. */
  markResumed(messageId: string): void {
    this.#resumedFailedMessageIds.add(messageId);
    this.#resumeCount++;
    this.#armed = false;
    this.#disarmedAfterMessageId = messageId;
  }

  #rearm(): void {
    this.#armed = true;
    this.#disarmedAfterMessageId = undefined;
  }
}
