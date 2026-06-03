/**
 * Session-error grace window.
 *
 * A `session.error` event isn't necessarily terminal — OpenCode often recovers
 * and keeps streaming parts. So instead of failing the run immediately, we
 * remember the error and give the stream a bounded window to produce more
 * parts. If a later part arrives (a higher seq than the error), the error is
 * cleared as recovered; if the window elapses with no further parts, the
 * remembered error becomes the run's terminal error.
 *
 * Extracted from the stream loop so the seq-based clear and the time-based
 * window live together rather than as three loose variables mutated in three
 * separate event branches.
 */
export class SessionErrorGrace {
  #error: string | undefined;
  #errorSeq: number | undefined;
  #errorAt: number | undefined;
  readonly #graceMs: number;
  readonly #now: () => number;

  constructor(graceMs: number, now: () => number = () => Date.now()) {
    this.#graceMs = graceMs;
    this.#now = now;
  }

  /** Whether an unrecovered session error is currently being held. */
  get pending(): boolean {
    return this.#error !== undefined;
  }

  /** The held error message, or undefined when none is pending. */
  get error(): string | undefined {
    return this.#error;
  }

  /**
   * Milliseconds left in the grace window. May be <= 0 once the window has
   * elapsed; callers pass this straight to a timed wait that treats a
   * non-positive value as "already expired".
   */
  remainingMs(): number {
    if (this.#errorAt === undefined) return this.#graceMs;
    return this.#graceMs - (this.#now() - this.#errorAt);
  }

  /** Record a session.error observed at the given stream seq. */
  record(message: string, seq: number): void {
    this.#error = message;
    this.#errorSeq = seq;
    this.#errorAt = this.#now();
  }

  /** Clear the held error once a later part (higher seq) proves recovery. */
  clearIfRecovered(seq: number): void {
    if (this.#errorSeq !== undefined && seq > this.#errorSeq) {
      this.clear();
    }
  }

  /**
   * Drop the held error unconditionally. Used when the run is deliberately kept
   * alive by a fresh prompt (idle auto-resume): the old error must not throttle
   * or terminate the continued response via a stale grace window.
   */
  clear(): void {
    this.#error = undefined;
    this.#errorSeq = undefined;
    this.#errorAt = undefined;
  }
}
