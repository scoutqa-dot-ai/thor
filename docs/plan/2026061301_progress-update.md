# Slack progress as a passive global listener

Make Slack progress a **passive projection** of the OpenCode event stream, owned
by a single global listener that subscribes to the event bus and talks to no one.
The `/trigger` handler and `runPromptStream` lose all progress code and gain
nothing in its place — they do not signal, register, await, or know that progress
exists.

## Current state

Progress today has three layers:

| Layer                | Where                                                                                                                                                                                                                                                                                  | Coupled to a request?              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Sink / state machine | `@thor/common` `progress-manager.ts` — `handleProgressEvent(target, evt, transport)` + module-level `activeSessions`                                                                                                                                                                   | No — global, keyed by Slack thread |
| Transport            | `runner/src/slack-progress.ts` — `createSlackProgressTransport(...)`, `resolveSlackProgressTarget(...)`                                                                                                                                                                                | No                                 |
| **Producer**         | `runner/src/index.ts` `/trigger` (the `emit` closure + `progressChain` + Slack target resolution) **and** `runner/src/prompt-stream.ts` `runPromptStream` (`emitToolProgress`, `emitTaskDelegateProgress`, `emitMemoryEventsFromToolPart`, `emitContextProgressFromInfo` + dedup sets) | **Yes**                            |

The **sink** is already global and keyed by Slack thread, and applies all
user-visible Slack behavior — the 3-tool threshold before the first post, 10s
update throttle, elapsed heartbeat ticker, per-category formatting, prior-progress
cleanup, done update, error visibility, abort-as-completed, supersede-on-`start`,
and Slack API error containment. **None of this changes.**

The clutter is entirely in the **producer**: `ProgressEvent`s are derived from the
SSE stream inside `runPromptStream`, interleaved with response aggregation, event
persistence, and run lifecycle; and `/trigger` carries the per-request
`emit`/`progressChain`/target boilerplate. Progress therefore only flows while a
trigger is actively consuming its subscription.

The global event bus (`runner/src/event-bus.ts`, `GlobalEventBus` +
`EventBusRegistry`) already maintains **one** SSE connection per OpenCode URL and
decodes **every** event for **every** session, but only fans out to the per-session
`SessionSubscription`s handed to each trigger.

Identity plumbing already present: `resolveSessionAnchorId(sessionId)` (resolves
`opencode.session` **and** `opencode.subsession` aliases → anchor id) and
`reverseLookupAnchor(anchorId)` (returns `{ sessionIds, subsessionIds,
externalKeys, currentSessionId }`) in `@thor/common` `event-log.ts`. Sessions are
bound to anchors during session resolution in `/trigger` (`bindSessionToAnchor`),
and `runPromptStream`'s child discovery writes the `opencode.subsession` alias when
a delegated child session appears.

## Project posture

Pre-v1: no production users, no deployment, no backward-compatibility
commitments. Prefer the correct end-state and delete the old path in one move — no
dual code paths, no parity tests, no migration scaffolding; the E2E workflow is the
gate.

## Requirements

1. **Only progress moves.** Auto-resume (the existing mechanism that sends a
   `Continue` prompt when a session goes idle before finishing, so the agent keeps
   working), the session-error grace that holds a `session.error` before the
   completion result treats it as terminal, event persistence, the per-trigger
   completion result, and the send-lock (serializes prompt sends per session) are
   **out of scope** and stay exactly where they are in `runPromptStream`.
2. **`/trigger` and `runPromptStream` end with zero progress code** and emit zero
   progress signal — they never call into, register with, or await the listener.
3. **Progress may be out of sync with triggers.** A progress message may appear,
   update, finish, or re-appear at boundaries that don't line up exactly with a
   trigger. Two triggers sharing one progress bubble, or one run's bubble
   flickering finished→fresh across an auto-resume, are **acceptable**.
4. **The request path is untouched.** `stream:true` / NDJSON / smoke-test (an
   internal validation request that drives a prompt and returns its terminal
   result) responses keep working off `runPromptStream`'s existing return value
   `{ terminalError, textParts, toolCalls, totalParts }` — not off any progress
   machinery.

Requirement (3) is what makes a passive projection sufficient: progress no longer
needs precise per-run boundaries. Requirement (4) is satisfied by leaving
`runPromptStream` exactly as a per-trigger consumer.

## Goal

One global **ProgressListener** is the **sole producer** of Slack progress. It
subscribes to a bus firehose, resolves the Slack target for any session id from the
existing alias index, derives `ProgressEvent`s from the stream, and feeds the
unchanged sink. `/trigger` and `runPromptStream` contain no progress code.

## Architecture

```
OpenCode SSE ─► GlobalEventBus (one per URL, one SSE connection)
                  ├─ per-session subscriptions ──► runPromptStream (per trigger)
                  │      auto-resume · grace · child discovery · persistence · returns result
                  │
                  └─ firehose (NEW) ─────────────► ProgressListener (global, passive)
                                                     per event:
                                                       resolve target: sessionId
                                                         → resolveSessionAnchorId → reverseLookupAnchor
                                                         → slack.thread → ProgressTarget (a Slack thread)
                                                       derive ProgressEvent (start/tool/memory/delegate/context/done/error)
                                                       handleProgressEvent(target, evt, slackTransport)   // sink unchanged

/trigger: resolve session → withKeyLock(send){ busy-gate / abort / promptAsync } → return accepted/busy
          (stream:true only) await runPromptStream result → NDJSON/HTTP response.  ZERO progress code.
```

Two readers of the bus — `runPromptStream`'s per-trigger subscriptions (unchanged)
and the firehose — but exactly **one producer of progress** (the listener). They
never coordinate: the listener is fully passive and tolerant, so there is no race
between "finish on idle" and "auto-resume is about to send `Continue`." If the
listener finishes a bubble on a transient idle and `runPromptStream` then
auto-resumes, a fresh bubble appears on the `Continue` — acceptable under (3). The
listener never sends `Continue` and never reasons about run origin.

### Bus firehose

Add a firehose to `GlobalEventBus`: a listener that receives every event for every
session (parent and child) as an additional fan-out target alongside the existing
per-session dispatch. Attach one firehose listener at startup for the configured
OpenCode URL, constructing the Slack transport once and injecting it. The
registration lives on the bus and is re-applied by the bus's own reconnect path
(not via a per-trigger subscription), so it must keep the SSE connection alive
**without** disturbing the per-session `subscribe` / `releaseSubscription` /
`onEmpty` accounting that `runPromptStream` relies on. The listener is a global
handler started with the runner; on restart it re-attaches and projects current
activity — there is no replay of past runs.

### Slack target resolution (covers child sessions for free)

For any session id on the firehose: `resolveSessionAnchorId(sessionId)` → anchor;
`reverseLookupAnchor(anchorId).externalKeys` yields the `slack.thread` alias →
reconstruct the correlation key → `ProgressTarget`. Child sessions share the parent
anchor (via the `opencode.subsession` alias written by `runPromptStream`'s
unchanged child discovery), so delegated tool activity resolves to the **same**
thread automatically. Sessions with no `slack.thread` alias (cron/github/etc.)
resolve to nothing and are silently ignored — a pure projection, no side effects on
unmatched events. Child events arriving before the alias is written are dropped — a
brief startup-race gap, tolerated under (3).

### What the listener derives

The four `emit*` helpers move from `runPromptStream` into the listener unchanged;
only their trigger points change to "every firehose event for a resolvable target."

| ProgressEvent                      | Derived from                                                                      | Notes                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`                            | a `user`-role message for the session                                             | An auto-resume `Continue` is also a `user` message → it starts a fresh bubble (cosmetic under (3)); the threshold means nothing posts until 3 tools. |
| tool / delegate / memory / context | tool parts / `task` tool input / memory tool parts / `message.updated` token info | Same logic as the current `emit*` helpers.                                                                                                           |
| `done`                             | parent `session.idle`                                                             | Emitted on every idle; a later auto-resume just produces a new `start`. Optional debounce — see Phase 2.                                             |
| `error`                            | parent `session.error`, after a short grace                                       | See _Error grace_.                                                                                                                                   |

### Listener state

The dedup sets and role tracking (`emittedToolStarts`, `emittedTaskDelegates`,
`parentMessageRoles`, `pendingNonEmptyTextMessageIds`) move onto the listener as a
small **per-session** record, cleared on `done`/`error`. Keys
(`sessionID|messageID|callID`) include the session id, so a parent and its children
keep separate records even when posting to the same thread, and a missed or late
clear at worst shows a tool once extra or once fewer — cosmetic under (3). No
run-origin classification and no resume counter (that stays in `runPromptStream`).

### Error grace

A `session.error` that recovers is a known flake. A flickered or finished bubble
self-heals on the next `start`, but a false ❌ does not — no later event corrects
it. So the listener keeps its own minimal grace, separate from the completion-path
grace in `runPromptStream`: on parent `session.error`, record it and arm a short
timer; **any** later parent activity cancels it; if the timer fires, emit `error`.
This is the only timer in the design.

## Phases

One PR; phases are review/checkpoint boundaries, not ship gates. Verification is the
overall exit criteria below.

- **Phase 1 — firehose + ProgressListener + swap the producer.** Add the firehose;
  build `ProgressListener` (target resolution, the moved `emit*` helpers,
  `start`/`done`/`error` with error grace, transport injected once). In the **same
  phase**, delete all progress code from `/trigger` (the `emit` closure,
  `progressChain`, `resolveSlackProgressTarget` usage) and from `runPromptStream`
  (the four `emit*` helpers, dedup sets, every `emit(...)` call) — old and new
  producers cannot both post. Everything non-progress in `runPromptStream` stays.
- **Phase 2 — tests + flicker decision.** Unit tests: (a) target resolution for a
  parent and for a child via the `subsession` alias; (b) a session with no
  `slack.thread` alias is ignored; (c) per-session dedup cleared on `done`; (d)
  error grace emits `error` on timeout but cancels on a later part. Then decide
  whether auto-resume flicker is bad enough to add a short `done` debounce (emit
  `done` after N seconds unless a new `user` message arrives first). **Default: no
  debounce** — add only if Phase 3 shows it's ugly; record the call in D9.
- **Phase 3 — integration verify.** Push to trigger the Slack/OpenCode E2E
  workflow; exercise mention → reply → delegated-task → completion, an interrupt
  mid-run, and an induced `session.error` inside the grace window.

## Decision log

| ID  | Decision                                                                                                                         | Rationale                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Progress is a single passive listener on a bus firehose; two bus readers, one progress producer.                                 | The listener is naive about auto-resume, so there is no projector-vs-stream race. Auto-resume stays its own owner; progress has exactly one producer.                     |
| D2  | `runPromptStream` stays per-trigger; auto-resume, grace, persistence, completion, and the send-lock are unchanged.               | Only progress is in scope. Not moving them keeps the request path and resume logic as-is and avoids re-coupling anything.                                                 |
| D3  | No completion handle; `stream:true`/NDJSON/smoke-test read `runPromptStream`'s existing return value.                            | Nothing request-scoped moved out of the request path, so there is nothing to re-deliver.                                                                                  |
| D4  | No phasing-for-green, no before/after parity tests.                                                                              | Greenfield, no deploy; E2E is the gate. Assert desired behavior, not equivalence to today.                                                                                |
| D5  | Bootstrap-memory reads (synthesized `memory read` events in `index.ts`) are dropped from Slack progress.                         | They are not OpenCode stream events, so the passive listener can't see them. Revisit only if the first update visibly degrades; record here if so.                        |
| D6  | Slack target resolved only from the session's current `slack.thread` alias.                                                      | Keeps scope to live Slack threads; no historical/approval/cron/GitHub progress.                                                                                           |
| D7  | No per-run lifecycle reset and no origin classification; listener state is per-session, cleared on `done`/`error`, and cosmetic. | (3) makes dedup imprecision cosmetic; the resume counter lives in the untouched `runPromptStream`.                                                                        |
| D8  | One minimal listener-local error grace; no watchdog.                                                                             | A false ❌ doesn't self-heal; a finished/flickering bubble does (next `start`). The bus reconnects, so a transient disconnect isn't terminal — no hung state to watchdog. |
| D9  | Auto-resume flicker accepted by default; a `done` debounce added only if E2E shows it's ugly.                                    | (3). Avoid a timer to hedge a tolerated cosmetic outcome. Record the Phase 2 call here.                                                                                   |

## Risks / open questions

- **Firehose vs. per-session accounting.** The firehose listener is long-lived and
  must keep the SSE connection alive and re-attach across reconnects without
  disturbing per-session `subscribe`/`releaseSubscription`/`onEmpty`. Confirm
  `onEmpty` does not tear down while a firehose listener is attached.
- **`start` fidelity.** Deriving `start` from a `user`-role message is the one
  heuristic that affects when a bubble appears. A listener that starts mid-run
  misses that run's `start` (no bubble until the next run) — acceptable under (3),
  but confirm a fresh prompt's role is observable promptly.
- **Error-grace window length.** Pick a short fixed bound in Phase 1 that covers the
  recover-from-error flake without delaying a real ❌ noticeably.

## Exit criteria

- `/trigger` and `runPromptStream` contain no progress-producing code and emit no
  progress signal; the listener is the sole producer.
- All sink Slack behaviors preserved (threshold, throttle, heartbeat, formatting,
  cleanup, done, error visibility, abort-as-completed, supersede).
- `stream:true`/NDJSON/smoke-test responses work off `runPromptStream`'s existing
  return value.
- A recovered `session.error` produces no false ❌ (listener error grace).
- Slack/OpenCode E2E workflow green on push.

```

```
