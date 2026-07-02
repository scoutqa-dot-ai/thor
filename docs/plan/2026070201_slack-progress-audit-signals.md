# Slack progress audit signals

Keep a run's Slack progress message on completion when the run did something
worth auditing, instead of always deleting it. Generalize this into a small,
extensible set of persisted "audit signals".

## Goal

By default a completed run's live "working…" message is deleted so threads stay
quiet. Some runs perform consequential, durable actions that leave no other
trace in the thread once that message vanishes. When a run records an
audit-worthy signal, finalize its progress message into a durable summary and
retain it; otherwise keep deleting as before.

## Scope

**In scope**

- Accumulate audit signals per `ProgressSession` and, on finish, render a
  retained summary when any are present.
- Persist two signals: **memory writes** (distinct files written) and **errors**
  (every session error seen mid-run — recovered or fatal).
- Unify the terminal error path into the same summary: a failed run renders the
  errors section as a failure headline; a completed run that hit and recovered
  from errors renders them as a footnote.
- Unify retention: drop retained messages from the cleanup registry so they
  persist in Slack without the registry growing over the process lifetime.
- Add a `session_error` progress event so the listener can feed mid-run errors
  to the progress engine.

**Out of scope**

- New signals beyond memory writes and errors (the mechanism is built to grow;
  candidates when needed: external/mutating MCP actions, commits/PRs opened).
- Changing the 3-tool threshold, throttling, heartbeat, or abort-as-completed
  semantics.
- The lightweight `x`-reaction fallback for a failure that never posted a live
  message — preserved as-is.

## Design

`AuditSignals { memoryWrites: string[]; errors: Map<message, count> }` lives on
the `ProgressSession`. `renderAuditSummary(signals, { failed, toolCalls })`
composes one section per non-empty signal:

- **memory writes** → `📝 Memory updated — N files written` + the paths.
- **errors** → `❌ Failed after N tool calls` (failed) or `⚠️ Recovered from N
errors during the run` (completed), + the messages with counts.

`finish()` is one path for both outcomes:

1. Aborts are still treated as completed.
2. A failed run with no recorded error records the terminal error defensively,
   so failures are never invisible.
3. If the summary is empty (completed, no signals) → return; cleanup deletes the
   live message.
4. Else finalize: update the live message (or post fresh below threshold), then
   `retainProgressMessage` drops it from the registry. A failure that never
   posted a message keeps the `x`-reaction fallback.

## Decision Log

| #   | Decision                                                               | Why                                                                                            | Instead of                                                                           |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Persist exactly two signals (memory writes, errors), built to extend   | Smallest correct set with real audit value; avoids speculative surface                         | Persisting delegations/tool counts/context (transient or already recorded elsewhere) |
| 2   | Treat recovered and fatal errors as one signal, framed by final status | One accumulator and one renderer; a recovered failure is as worth surfacing as a fatal one     | A separate bespoke `❌ Failed —` one-liner path alongside a recovered-errors path    |
| 3   | Retain by removing from the cleanup registry                           | Message persists in Slack; registry can't grow over process lifetime; removes a special case   | Marking `status="error"` and skipping it in cleanup, plus an eviction cap            |
| 4   | Add a `session_error` progress event                                   | Listener already sees `session.error` but clears it on recovery; this carries it to the engine | Deriving recovered errors from the inline `tool: "error"` activity                   |
| 5   | Drop sub-agent delegations as a signal                                 | Run structure, not a durable/consequential fact; low audit value                               | Keeping delegations in the summary                                                   |

## Supersedes

`2026052202_runner-owned-slack-progress.md` preserved "retention of capped error
entries" (a per-thread eviction cap keeping the last N error messages in the
registry). That mechanism is removed: error messages are now retained by
registry removal like any other audit summary, so no cap is needed and
`MAX_ERROR_ENTRIES_PER_THREAD` / `evictExcessErrors` / the `status` field are
gone.

## Exit criteria

- A completed run that wrote memory keeps a summary listing the files; a run
  with none is still deleted.
- A completed run that recovered from errors keeps a "recovered" summary; a
  failed run keeps a "failed" summary listing the errors.
- Below-threshold runs still record their signals (memory audit posts fresh;
  failures with no message still get the `x` reaction).
- Retained messages are not deleted and leave no lingering registry entry.
