# Runner Idle Auto-Resume

> Retroactive plan doc. The feature shipped across branch `feat/runner-idle-auto-resume`
> before a plan existed; this document reverse-engineers the design and decision
> log from the commit history so future sessions can reason about the behavior
> without re-reading the whole stream loop.

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

| | `SessionErrorGrace` (`session-error-grace.ts`) | `IdleAutoResume` (`idle-auto-resume.ts`) |
|---|---|---|
| Triggered by | a `session.error` event | a `session.idle` event after a zero-token error-finish assistant message |
| Timing | **bounded wait** of `SESSION_ERROR_GRACE_MS` (default 10000ms) for the stream to recover with a later part | **no wait** — fires synchronously on the idle event |
| Action | hold the error; if a later part (higher seq) arrives, clear it as recovered; if the window elapses, the held error becomes terminal | send one `"Continue"` prompt to the same session, then keep consuming the stream |
| Bound | one window per error; reset on each new error | `MAX_RESUMES = 3` per run, plus once-per-message-id |

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

- **Armed by default.** Each failed-idle resume disarms until a *different*
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
- Because the session stays `busy` for the whole window, a concurrent external
  trigger bounces with `{ busy: true }` unless it sets `interrupt: true`, in
  which case it aborts the in-flight run first (existing busy/abort path,
  unchanged by this feature).

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Nudge with a literal `"Continue"` on empty failed idle, not a re-send of the original prompt | The session already has full context; a minimal nudge avoids duplicating/observing the original instruction. (`feat: auto-continue failed idle runs`) |
| D2 | Re-arm only on a *different* message id with real output, never the disarmed one | Late zero-token updates on the same failed id must not look like recovery; only fresh work proves the session moved on. (`feat: auto-continue failed idle runs`) |
| D3 | Report `ASSISTANT_EMPTY_ERROR_OUTPUT` when an empty failed idle is not (or can no longer be) resumed | An exhausted/blocked resume must surface a clear terminal error, not an empty "completed" response. (`fix: report exhausted idle auto-resume`) |
| D4 | Clear the session-error grace window when a resume fires (`errorGrace.clear()`) | A held error otherwise bounds the *continued* response by a stale window timed from the *original* error — it would time out and abandon the `"Continue"` just sent. (`fix: bound idle auto-resume and stop stale grace`) |
| D5 | Cap total resumes at `MAX_RESUMES = 3`, independent of the per-id guard | A flapping provider (tokens>0, then a zero-token error on an ever-new id) re-arms each round and would loop `"Continue"` without bound. The per-id guard alone can't stop it. (`fix: bound idle auto-resume`) |
| D6 | Evaluate `failedAssistantIdle` *before* the stale-idle (`!sawParentMessagePart`) guard | An empty failure can idle before any parent message part is emitted; that case must still resume / report rather than be dropped as a stale idle. (`fix: handle empty failed idle before parts`) |
| D7 | Resume `promptAsync` follows the codebase convention (`await` + check `.error`), no dedicated try/catch | The outer `backgroundTask` already catches thrown rejections and routes them to the terminal-error path; an extra try/catch was redundant. (`refactor: drop redundant auto-resume try/catch` — reverting the defensive wrap added in D5's commit) |
| D8 | Extract `IdleAutoResume` and `SessionErrorGrace` into their own modules/classes | The arm/disarm/recover rules were loose variables mutated across three event branches; consolidating them prevents drift and makes them unit-testable with an injectable clock. (`refactor: extract idle auto-resume and session-error-grace state machines`) |
| D9 | `SessionErrorGrace` takes an injectable `now()` clock | Enables deterministic time-based tests without real timers. (`fix: bound idle auto-resume`) |

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

## Out of scope

- Configurable resume count or per-resume backoff/cooldown — resume is
  intentionally immediate and capped at a constant.
- Custom resume prompt text or model-specific nudges.
- Resuming on non-empty failures or non-error finishes — only the zero-token
  error-finish idle is treated as resumable.
- Cross-trigger persistence of resume state — the state machine lives for the
  span of a single `runPromptStream` call.
