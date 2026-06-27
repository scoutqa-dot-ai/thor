# Runner Idle Auto-Resume

## Problem

OpenCode occasionally idles a session immediately after an assistant
`message.updated` that finished with `finish === "error"` and produced **zero
tokens** — a transient model/provider hiccup, not a real answer. Before this
feature the runner surfaced that idle as a completed-but-empty response, leaking
a provider flake to the Slack/gateway caller as if the agent had nothing to say.

The fix: when the parent session idles on such an empty failure, send a single
`"Continue"` nudge to the same session rather than terminating. If the nudge
also fails (or we've nudged too many times), report a clear terminal error
instead of an empty success.

## Two signals, two mechanisms

The stream loop reacts to two different OpenCode signals with two independent
state machines. They are easy to conflate; keep them distinct.

|              | `SessionErrorGrace` (`session-error-grace.ts`)                                                                                      | `IdleAutoResume` (`idle-auto-resume.ts`)                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Triggered by | a `session.error` event                                                                                                             | a `session.idle` event after a zero-token error-finish assistant message         |
| Timing       | **bounded wait** of `SESSION_ERROR_GRACE_MS` (default 10000ms) for the stream to recover with a later part                          | **no wait** — fires synchronously on the idle event                              |
| Action       | hold the error; if a later part (higher seq) arrives, clear it as recovered; if the window elapses, the held error becomes terminal | send one `"Continue"` prompt to the same session, then keep consuming the stream |
| Bound        | one window per error; reset on each new error                                                                                       | `MAX_RESUMES = 3` per run, plus once-per-message-id                              |

The grace window gates **error recovery**; auto-resume reacts to **idle**. They
interact at exactly one point: when a resume fires it calls `errorGrace.clear()`
(see Decision D4).

## State machine: `IdleAutoResume`

Driven from three points in the parent-session stream loop:

1. assistant `message.updated` → `onAssistantMessageUpdate(summary)`
2. assistant `text` part → `onAssistantText(messageId, hasContent)`
3. `session.idle` → `decideResume()` / `isFailedAssistantIdle()` / `markResumed()`

Rules (all enforced in one class so arm/disarm logic can't drift apart across
the three call sites):

- **Armed by default.** Each failed-idle resume disarms until a _different_
  message id proves recovery (real tokens via `message.updated`, or non-empty
  text).
- **Once per message id.** A given failed message id is resumed at most once,
  ever (`#resumedFailedMessageIds`).
- **Text wins permanently.** A message id that ever produced non-empty text is
  never treated as a failed idle, even if a later zero-token error update
  arrives for it (`#messageIdsWithOutput`).
- **Hard cap.** At most `MAX_RESUMES = 3` resumes per run regardless of message
  id (`#resumeCount`).
- **`isFailedAssistantIdle()` is state-independent.** It reports whether the
  latest assistant message was an empty failure, independent of arm/resume
  state. The loop uses it both to decide the stale-idle guard and to pick the
  terminal error, so it must not be coupled to `decideResume`.

## Trigger lifecycle interaction

Auto-resume is entirely contained inside `runPromptStream` and is **invisible to
the trigger lifecycle**:

- One trigger = the original prompt **plus** up to `MAX_RESUMES` `"Continue"`
  nudges. `startTrigger` fires once before the initial prompt; `endTrigger`
  fires once after `runPromptStream` returns. No new trigger id is minted per
  resume, and the trigger stays `in_flight` across the whole window.
- The `"Continue"` prompt targets the same `sessionId` via `promptAsync`, so it
  is a genuine follow-up turn on the same conversation/subscription.
- A concurrent external trigger bounces with `{ busy: true }` while the session
  is `busy`, unless it sets `interrupt: true`, in which case it aborts the
  in-flight run first (existing busy/abort path).
- **Send race / session-send lock.** The session is _not_ continuously busy: at
  `session.idle` OpenCode reports `idle` until the `"Continue"` `promptAsync`
  flips it back. A new trigger whose `session.status()` lands in that gap would
  see `idle`, skip the busy bail, and send a second prompt into the same session
  (double-send). To close this, both writers — the trigger handler's
  busy-check→send span (`index.ts`) and the auto-resume `"Continue"` send
  (`prompt-stream.ts`) — run inside one session-scoped lock keyed
  `${SESSION_LOCK_PREFIX}${sessionId}` on the shared `correlationKeyLocks` map,
  and each **re-reads live status under the lock** before sending. Whoever loses
  the race observes `busy` and backs off: the trigger bounces `{ busy: true }`,
  the auto-resume skips `"Continue"` (logged `session_idle_auto_resume_skipped_busy`)
  and lets the run end as the failed idle it was — the new trigger's own stream
  carries its prompt. The lock relies only on OpenCode's live status, never on
  `inflightTriggers` (a liveness signal that leaks into a permanent false-busy
  when a terminal OpenCode event is dropped).

## Decision Log

| #   | Decision                                                                                                                                                                | Rationale                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Nudge with a literal `"Continue"` on empty failed idle, not a re-send of the original prompt                                                                            | The session already has full context; a minimal nudge avoids duplicating/observing the original instruction. (`feat: auto-continue failed idle runs`)                                                                                                         |
| D2  | Re-arm only on a _different_ message id with real output, never the disarmed one                                                                                        | Late zero-token updates on the same failed id must not look like recovery; only fresh work proves the session moved on. (`feat: auto-continue failed idle runs`)                                                                                              |
| D3  | Report `ASSISTANT_EMPTY_ERROR_OUTPUT` when an empty failed idle is not (or can no longer be) resumed                                                                    | An exhausted/blocked resume must surface a clear terminal error, not an empty "completed" response. (`fix: report exhausted idle auto-resume`)                                                                                                                |
| D4  | Clear the session-error grace window when a resume fires (`errorGrace.clear()`)                                                                                         | A held error otherwise bounds the _continued_ response by a stale window timed from the _original_ error — it would time out and abandon the `"Continue"` just sent. (`fix: bound idle auto-resume and stop stale grace`)                                     |
| D5  | Cap total resumes at `MAX_RESUMES = 3`, independent of the per-id guard                                                                                                 | A flapping provider (tokens>0, then a zero-token error on an ever-new id) re-arms each round and would loop `"Continue"` without bound. The per-id guard alone can't stop it. (`fix: bound idle auto-resume`)                                                 |
| D6  | Evaluate `failedAssistantIdle` _before_ the stale-idle (`!sawParentMessagePart`) guard                                                                                  | An empty failure can idle before any parent message part is emitted; that case must still resume / report rather than be dropped as a stale idle. (`fix: handle empty failed idle before parts`)                                                              |
| D7  | Resume `promptAsync` follows the codebase convention (`await` + check `.error`), no dedicated try/catch                                                                 | The outer `backgroundTask` already catches thrown rejections and routes them to the terminal-error path; an extra try/catch was redundant. (`refactor: drop redundant auto-resume try/catch` — reverting the defensive wrap added in D5's commit)             |
| D8  | Extract `IdleAutoResume` and `SessionErrorGrace` into their own modules/classes                                                                                         | The arm/disarm/recover rules were loose variables mutated across three event branches; consolidating them prevents drift and makes them unit-testable with an injectable clock. (`refactor: extract idle auto-resume and session-error-grace state machines`) |
| D9  | `SessionErrorGrace` takes an injectable `now()` clock                                                                                                                   | Enables deterministic time-based tests without real timers. (`fix: bound idle auto-resume`)                                                                                                                                                                   |
| D10 | Serialize the auto-resume `"Continue"` send and the trigger busy-check→send under one `${SESSION_LOCK_PREFIX}${sessionId}` lock, each re-checking live status inside it | Closes the TOCTOU gap where a trigger reads `idle` in the window between `session.idle` and the `"Continue"` send and double-prompts the session. A transient send-lock is held only across the dispatch, so a stalled stream never pins it.                  |
| D11 | Gate the send on OpenCode's live `session.status()`, never on `inflightTriggers`                                                                                        | `inflightTriggers` is a liveness signal; a dropped terminal OpenCode event leaks it, pinning the session as falsely "busy" forever. Using it to gate correctness trades a rare transient race for a permanent stuck session.                                  |

## Exit criteria

Behaviors locked in by tests (treat as regression guards):

`idle-auto-resume.test.ts`

- never treats a message that emitted text as a failed idle
- re-arms only for a new message id, not late tokens on the disarmed one
- stops resuming once the global cap is hit, even with ever-new message ids

`session-error-grace.test.ts`

- full window / no pending error before any `record`
- `remainingMs` counts down from recorded time using the injected clock
- clears only on a seq strictly greater than the error seq
- `clearIfRecovered` is a no-op with no held error
- a second `record` replaces the held error and resets the window
- `clear()` drops the held error unconditionally and restores the full window

`trigger.test.ts`

- intercepts bad idle and sends `Continue` once before done
- intercepts bad idle even when no parent message part was emitted
- does not retry the same failed message id twice
- exhausted/empty failed idle reports `done` with `status: "error"` and the
  empty-output message
- session errors emit tool progress and continue when later activity arrives
- status events do not extend the session-error grace period
- skips the auto-resume `Continue` when a concurrent send drove the session busy
  (no double-send; run ends as `status: "error"`)

## Out of scope

- Configurable resume count or per-resume backoff/cooldown — resume is
  intentionally immediate and capped at a constant.
- Custom resume prompt text or model-specific nudges.
- Resuming on non-empty failures or non-error finishes — only the zero-token
  error-finish idle is treated as resumable.
- Cross-trigger persistence of resume state — the state machine lives for the
  span of a single `runPromptStream` call.

## Follow-up: hung-trigger reconcile (not yet implemented)

The session-send lock (D10/D11) closes the double-send race but does not address
the separate failure it exposed: if OpenCode drops a terminal event, the
`backgroundTask`/subscription waits forever and the trigger stays `in_flight`
even though OpenCode is idle. The durable fix is a periodic reconcile — poll
`session.status()`, and if a session is idle while a trigger for it has been
in-flight past a bound, force-`endTrigger`. Deferred deliberately: it is a
different failure mode (trigger recovery, not send safety), the lock is correct
without it, and it needs its own design (poll interval, idle-while-in-flight
bound, interaction with a just-restarted run) and tests.
