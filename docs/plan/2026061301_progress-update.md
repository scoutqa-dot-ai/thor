# Slack Progress As An Event Projection

## Goal

Make Slack progress a passive projection of the OpenCode event stream.

There is one producer of Slack progress: `ProgressListener`. It observes a
process-owned `GlobalEventBus` firehose, resolves the Slack thread for each
session through the alias index, derives progress from real OpenCode events,
and calls the Slack progress sink.

`/trigger` and `runPromptStream` stop producing Slack progress. `/trigger`
keeps only its HTTP contract: for `stream: true`, it writes one terminal NDJSON
`done` line synthesized from `runPromptStream`'s return value.

This is pre-v1 work. Build the clean end state in one move: delete the old
producer path, do not keep compatibility shims, and use tests plus E2E as the
gate.

## Current State

- `progress-manager.ts` is already a global Slack sink keyed by Slack thread.
- `slack-progress.ts` is already a reusable Slack transport.
- Slack progress is currently produced from two request-scoped places:
  `/trigger` and `runPromptStream`.
- `GlobalEventBus` currently ties SSE lifetime to transient per-session
  subscriptions through `activeSubscriptions`.

That lifetime model is the wrong abstraction once progress is a firehose
projection. The bus should be process-owned; per-session subscriptions should
only control listener registration.

## End State

```text
OpenCode SSE
  -> GlobalEventBus, one process-owned connection per OpenCode URL
      -> firehose observers
          -> ProgressListener
              -> resolve session anchor
              -> resolve slack.thread alias
              -> derive progress events
              -> handleProgressEvent(...)

      -> per-session subscriptions
          -> runPromptStream
              -> persistence, child discovery, auto-resume, terminal result
```

### GlobalEventBus

- Own one SSE connection per OpenCode base URL for the process lifetime.
- Expose an explicit `start()` that connects and reconnects until `close()`.
- Remove `activeSubscriptions` as a liveness mechanism.
- Remove `onEmpty` bus disposal from `EventBusRegistry`.
- `subscribe(sessionIds)` only registers per-session listeners and returns an
  iterator. Closing the subscription removes listeners; it does not affect SSE
  connection lifetime.
- Add a firehose observer API that receives every decoded event with an
  extractable session id.
- Catch and log observer exceptions so Slack failures cannot kill the SSE
  reader.
- Align `message.updated` session extraction with the existing stream parser:
  `properties.info ?? properties.message`.

Starting policy: the runner starts the bus when it starts the progress listener.
If Slack progress is disabled, the first `/trigger` subscription may still call
`start()`, but subscription close must not close the bus.

### ProgressListener

For every firehose event with a session id:

1. Resolve `sessionId -> anchorId` through `resolveSessionAnchorId`.
2. Read `reverseLookupAnchor(anchorId).externalKeys`.
3. Find the `slack.thread` alias.
4. Rebuild `slack:thread:<channel>/<threadTs>`.
5. Pass it through `resolveSlackProgressTarget`.
6. If no target resolves, ignore the event.

Move the progress-only derivation from `runPromptStream` into the listener:

- tool calls
- memory tool events
- task delegation
- context-window usage

Keep the non-progress stream responsibilities in `runPromptStream`:

- event persistence
- text/tool aggregation for the terminal result
- child-session discovery and `opencode.subsession` alias writes
- idle auto-resume
- `SessionErrorGrace` for the HTTP terminal result
- send locking

The listener does not send prompts, does not auto-resume, and does not write
session logs.

### Slack Bubble Semantics

Use one progress bubble per Slack thread.

- Any activity for a resolved thread updates the current bubble or creates one
  on demand.
- Do not emit a sink-facing `start` event. The first real activity is enough to
  create sink state.
- A parent session `session.idle` finalizes the current thread bubble and clears
  the thread entry.
- A child session `session.idle` does not finalize the parent bubble.
- The next activity after finalization creates a fresh bubble.
- Remove the sink's `done` session-id match guard. The sink is thread-keyed; the
  listener is responsible for deciding which idle events are terminal.

Parent means `event.sessionID === reverseLookupAnchor(anchorId).currentSessionId`.
If OpenCode reuses a session id across turns, a stale idle for that same id can
dismiss the live bubble; the next event recreates it. That brief flicker is
accepted in exchange for no turn counters or ordering protocol.

### Error Semantics

Keep Slack finalization timerless.

- On parent `session.error`, store `pendingError` for that parent session and
  render inline error activity.
- On the next parent `message.part.updated`, clear `pendingError`.
- On parent `session.idle`, finalize as:
  - `completed` when no `pendingError` remains
  - `error` when `pendingError` remains
- Abort errors still go through the sink's abort-as-completed behavior.
- If `session.error` is never followed by activity or idle, the bubble remains
  live with inline error activity. This rare orphan is accepted.

### Sink Changes

Simplify `progress-manager.ts` around the listener-owned model.

- Keep the 3-tool post threshold.
- Keep the 10s update throttle.
- Keep the heartbeat ticker and elapsed counter.
- Keep prior-progress cleanup and error-message retention.
- Delete the transient completed edit. Completed runs should be cleaned up by
  the existing cleanup path, not edited to a short-lived "done" message.
- Remove standalone sink-facing `start` and `error` event paths if they are no
  longer used after the listener move.
- Remove the `sessionId` stored on `ProgressSession` if it is only used by the
  deleted done guard.

## NDJSON Contract

`stream: true` no longer mirrors Slack progress.

The HTTP response is one terminal line:

```json
{"type":"done","sessionId":"...","status":"completed","response":"...","toolCalls":[],"durationMs":123,"resumed":false}
```

On errors, the same terminal shape uses `status: "error"` and includes `error`.
Intermediate `start`, `tool`, `memory`, `delegate`, and `context` lines are
dropped from NDJSON.

Remove `progressEventSink` from trigger tests. Move progress behavior tests to
the listener and sink.

## Out Of Scope

- Replaying past OpenCode events after runner restart.
- Duplicating child-session discovery in the listener. Operator-UI sessions may
  miss delegated child progress until a separate need proves this matters.
- Turn ids, run tokens, debounce windows, or ordering protocols.
- Slack progress for sessions with no `slack.thread` alias.
- Any compatibility path for the current request-scoped progress producer.

## Phases

### Phase 1 - Bus, Listener, Producer Deletion

- Refactor `GlobalEventBus` to be process-owned:
  - explicit `start()` / `close()`
  - no subscription-count liveness
  - firehose observer API
  - observer exception containment
  - corrected `message.updated` session extraction
- Add `ProgressListener`.
- Move progress derivation helpers from `runPromptStream` to the listener.
- Resolve Slack targets through aliases.
- Implement parent-only idle finalization and timerless pending-error handling.
- Delete Slack progress production from `/trigger` and `runPromptStream`.
- Narrow `stream: true` to the single terminal NDJSON `done` line.

Exit criteria:

- `/trigger` and `runPromptStream` never call `handleProgressEvent`.
- Operator-UI activity with a `slack.thread` alias can produce Slack progress
  without an active `/trigger`.
- Per-session subscription close does not close the SSE connection.
- `runPromptStream` still returns the terminal result used by `/trigger`.

### Phase 2 - Sink Cleanup And Tests

- Remove the sink session-id done guard.
- Remove unused sink-facing `start` / `error` paths and `ProgressSession`
  session-id state if no longer needed.
- Delete the completed-run transient edit.
- Keep heartbeat, throttle, threshold, cleanup, and abort-as-completed behavior.
- Rewrite tests around the new ownership model.

Required tests:

- Bus keeps the SSE connection alive independently of per-session subscriptions.
- Firehose observer receives events and observer exceptions do not stop the bus.
- `message.updated` extraction supports `properties.message`.
- Parent and child sessions resolve to the same Slack thread once the child has
  an `opencode.subsession` alias.
- Sessions without `slack.thread` are ignored.
- Operator-UI style events, with no `/trigger`, produce progress.
- Child `session.idle` does not finalize the parent bubble.
- Parent `session.idle` finalizes and clears the thread bubble.
- Stale idle for a reused parent id dismisses; later activity recreates.
- `session.error -> activity -> idle` dismisses without a false error.
- `session.error -> idle` keeps the failure visible.
- Abort error finalization deletes as completed.
- `stream: true` returns exactly the terminal NDJSON shape needed by the smoke
  script.

### Phase 3 - Integration Verification

- Run unit tests and typecheck locally.
- Push the branch and use the Slack/OpenCode E2E workflow as the final gate.
- Exercise:
  - Slack mention to completion
  - delegated task progress
  - interrupt/abort
  - idle auto-resume
  - recovering `session.error`
  - operator-driven OpenCode UI session with a `slack.thread` alias

## Decision Log

| ID | Decision | Reason |
| --- | --- | --- |
| D1 | Slack progress has one producer: `ProgressListener`. | Removes duplicate request-scoped producers and their races. |
| D2 | `GlobalEventBus` is process-owned, not subscription-owned. | The firehose must serve operator-UI sessions when no `/trigger` is active. |
| D3 | Per-session subscriptions only manage listeners. | Closing a trigger stream should not affect global SSE liveness. |
| D4 | Slack finalization is driven by parent `session.idle`. | Keeps the listener passive and event-derived. |
| D5 | Error finalization is timerless. | A pending error is committed only by idle or cleared by later activity. |
| D6 | The sink is thread-keyed and does not match `sessionId` on done. | OpenCode can reuse session ids across turns; the listener owns terminal-event filtering. |
| D7 | `stream: true` is terminal-only NDJSON. | Intermediate progress is now Slack-listener state, not an HTTP stream contract. |
| D8 | No compatibility shim or dual producer. | Greenfield project; the clean end state is cheaper and safer. |
