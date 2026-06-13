# Slack progress as a passive, timerless event-stream projection

Make Slack progress a **passive projection** of the OpenCode event stream, owned by
a passive listener — the sole producer of Slack progress — that observes the event
bus and talks to no one. The
listener is **fully timerless**: every Slack call is triggered by a real OpenCode
event, and `session.idle` is the **sole finalizer** of a progress bubble. The
`/trigger` handler and `runPromptStream` lose all _Slack_ progress code — they never
register a Slack target, never call `handleProgressEvent`, and do not know the Slack
listener exists. (`/trigger` still synthesizes a single terminal `done` for its
NDJSON HTTP response from `runPromptStream`'s return value; see the _NDJSON /
`stream:true` contract_.)

## Current state

Progress today has three layers:

| Layer                | Where                                                                                                                                                                                                                                                                                  | Coupled to a request?              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Sink / state machine | `@thor/common` `progress-manager.ts` — `handleProgressEvent(target, event, transport)` + module-level `activeSessions`, `ProgressSession`                                                                                                                                              | No — global, keyed by Slack thread |
| Transport            | `runner/src/slack-progress.ts` — `createSlackProgressTransport(...)`, `resolveSlackProgressTarget(...)`                                                                                                                                                                                | No                                 |
| **Producer**         | `runner/src/index.ts` `/trigger` (the `emit` closure + `progressChain` + Slack target resolution) **and** `runner/src/prompt-stream.ts` `runPromptStream` (`emitToolProgress`, `emitTaskDelegateProgress`, `emitMemoryEventsFromToolPart`, `emitContextProgressFromInfo` + dedup sets) | **Yes**                            |

The sink and transport are already global. The clutter is in the **producer**:
`ProgressEvent`s are derived from the SSE stream inside `runPromptStream`,
interleaved with response aggregation, event persistence, idle auto-resume, and the
session-error grace window; and `/trigger` carries the per-request
`emit`/`progressChain`/target boilerplate. Progress therefore only flows while a
trigger is actively consuming its subscription.

The global event bus (`runner/src/event-bus.ts`, `GlobalEventBus` +
`EventBusRegistry`) already maintains **one** SSE connection per OpenCode URL and,
in its reader loop, extracts a session id from each event (`extractSessionId`, which
recognizes `message.part.updated`, `message.updated`, `session.idle`,
`session.status`, `session.error`) and dispatches it via `this.emitter.emit(sid, …)`
to the per-session `SessionSubscription`s handed to each trigger. Events with no
extractable sid are dropped at the bus and never reach any listener.

Identity plumbing already present (`@thor/common` `event-log.ts`):
`resolveSessionAnchorId(sessionId)` resolves `opencode.session` **and**
`opencode.subsession` aliases → anchor id; `reverseLookupAnchor(anchorId)` returns
`{ sessionIds, subsessionIds, externalKeys, currentSessionId }`. Sessions are bound
to anchors during session resolution in `/trigger` (`bindSessionToAnchor`), and
`runPromptStream`'s child discovery writes the `opencode.subsession` alias when a
delegated child session appears.

## Project posture

Pre-v1: no production users, no deployment, no backward-compatibility commitments.
Prefer the correct end-state and delete the old path in one move — no dual code
paths, no parity tests, no migration scaffolding. The integration/E2E workflow is
the gate, not equivalence-to-today.

## Goal

A passive **ProgressListener** is the **sole producer** of Slack progress: at most one
observer is active at a time (one bus per OpenCode URL), feeding a single shared Slack
transport. It observes the bus firehose, resolves the Slack target for any session id
from the existing alias index, derives `ProgressEvent`s from the stream, and feeds the
sink.
The listener is fully passive and **timerless** — it never sends a prompt, never
runs auto-resume, never arms a timer, and tolerates being out of sync with triggers.
`/trigger` and `runPromptStream` contain no Slack-progress code (the only residue is
`/trigger`'s synthesized NDJSON terminal `done` — see the _NDJSON / `stream:true`
contract_).

## Scope

**In scope**

- A passive observer hook on `GlobalEventBus` (a non-counting reader-loop tee) and a
  `ProgressListener` that consumes it; `EventBusRegistry` constructs a fresh per-bus
  observer wired to the once-constructed, shared Slack transport.
- Moving progress derivation (the four `emit*` helpers + dedup state) out of
  `runPromptStream` and the `emit`/`progressChain`/target boilerplate out of
  `/trigger`, into the listener.
- Sink changes to make rendering purely event-driven (remove the heartbeat ticker
  and the live elapsed counter; delete the bubble on completion).
- The timerless error keep-vs-dismiss model (see _Error handling_).

**Out of scope — stays exactly where it is in `runPromptStream`**

- Idle auto-resume (sends a `Continue` prompt when a session goes idle before
  finishing) and its `IdleAutoResume` state, including `parentMessageRoles` /
  `pendingNonEmptyTextMessageIds` (auto-resume inputs) and the
  `sawParentMessagePart` stale-idle guard (protects the terminal result).
- `SessionErrorGrace` as it feeds the **terminal result** (`terminalError`).
- Event persistence (`appendSessionEvent`), child-session discovery (the
  `opencode.subsession` alias write + child subscription), the per-trigger
  completion result `{ terminalError, textParts, toolCalls, totalParts }`, and the
  send-lock that serializes prompt sends per session.
- Gateway trigger sources (slack/github/cron/approval), Slack message format /
  `ProgressSession` field semantics beyond the changes listed under _Sink changes_.

## Architecture

```
OpenCode SSE ─► GlobalEventBus (one per URL, one SSE connection)
                  ├─ per-session subscriptions ──► runPromptStream (per trigger)
                  │      auto-resume · grace · child discovery · persistence · returns result
                  │
                  └─ firehose (NEW) ─────────────► ProgressListener (per-bus observer, passive, timerless)
                                                     per event, for a resolvable target:
                                                       resolve target: sessionId
                                                         → resolveSessionAnchorId → reverseLookupAnchor
                                                         → slack.thread → ProgressTarget
                                                       derive ProgressEvent (start/tool/memory/delegate/context)
                                                       session.error → mark pending + show inline (no finalize)
                                                       parent session.idle → finalize (sole finalizer)
                                                       handleProgressEvent(target, evt, slackTransport)

/trigger: resolve session (bindSessionToAnchor) → withKeyLock(send){ busy-gate / abort / promptAsync } → return accepted/busy
          (stream:true only) await runPromptStream result → NDJSON terminal done synthesized from result.
          NO Slack progress code, NO handleProgressEvent.
```

Two readers of the bus — `runPromptStream`'s per-trigger subscriptions (unchanged)
and the firehose — but exactly **one producer of progress** (the listener). They
never coordinate. Because the listener is naive about auto-resume there is no
projector-vs-stream race: if it finishes a bubble on a transient idle and
`runPromptStream` then auto-resumes, a fresh bubble appears on the `Continue`
(see D2).

### Bus firehose

The firehose is a **passive, non-counting observer** of `GlobalEventBus` — a normal
consumer with no special treatment. Inside the reader loop, alongside the existing
`this.emitter.emit(sid, payload)` per-session dispatch, the bus hands the same decoded
event to an observer callback. The observer therefore sees the same events the
per-session path does — every event with an extractable sid (`extractSessionId`),
parent and child. Events with no extractable sid are dropped at the bus and never
reach the observer either (acceptable: the listener only acts on `message.*` /
`session.idle` / `session.error`, all of which carry a sid).

**The firehose never affects the bus, and the bus gives it no special treatment.** It
does not increment `activeSubscriptions`, does not keep the connection alive, and does
not trigger `reconnectIfActive`; the bus lifecycle (`activeSubscriptions`, the
`onEmpty`-driven close, the reconnect guard) is left exactly as it is today, so nothing
`runPromptStream` relies on changes. Each `GlobalEventBus` instance owns its observer
for that instance's lifetime — wired at bus construction (so it is present before the
reader loop starts) and **discarded together with its per-session state when the bus
closes** (the bus's existing `close()` already drops everything). Only the Slack
transport is long-lived: constructed **once** at startup and shared, it is handed to a
fresh observer each time the registry constructs a bus, whose render state is rebuilt
from scratch.

Discarding observer state on `close()` is always safe: a bus only closes when
`activeSubscriptions` reaches 0 — i.e. no run is active — and since `session.idle`
finalizes/deletes every bubble, there is no live in-progress bubble to lose. (A run
that ends without ever emitting `session.idle` can leave an orphan `⏳` bubble; the
observer simply forgets it — the same accepted orphan case as error-then-no-idle.)

This works because of a property of `/trigger`, not of progress: **every run
`/trigger` drives — slack, github, cron, approval alike — holds an active per-session
subscription for its full duration.** `/trigger` subscribes before sending the prompt
(`subscribe` is unconditional, not gated on source) and runs `runPromptStream` in a
background task (un-awaited on the non-`stream` path) that holds that subscription
until the run terminates. So `activeSubscriptions > 0` whenever _any_ run is active
and the bus is alive — and in particular whenever a Slack run (the only kind the
listener actually projects, D9) is producing events. Liveness comes from _all_ runs;
projection is narrowed to Slack runs separately, when the listener resolves a target.

When `activeSubscriptions` returns to 0 nothing at all is running, the bus closes as
usual, and the firehose simply has nothing to see; the next trigger's `subscribe`
lazily creates a fresh bus — constructed with a fresh observer wired to the shared
transport — re-opening the SSE connection that trigger needs anyway. **If the connection dies while no
trigger is active there is no reconnect and no progress update — accepted, because
nothing is running.** Because this liveness rides `/trigger`'s subscription lifecycle,
a future change that stops `/trigger` running `runPromptStream` for some run would
also silence the firehose for it — the dependency is load-bearing and should stay
named. On restart the listener re-attaches and projects current activity; there is no
replay of past runs (D11).

### Slack target resolution (covers child sessions for free)

For any session id on the firehose: `resolveSessionAnchorId(sessionId)` → anchor;
`reverseLookupAnchor(anchorId).externalKeys` yields the `slack.thread` alias, whose
`aliasValue` is the **suffix only** (`<channel>/<threadTs>`, e.g.
`C123/1710000000.001`) — reconstruct the full correlation key by prefixing
`slack:thread:`, then pass it to `resolveSlackProgressTarget` (regex
`^slack:thread:([^/]+)\/(.+)$`) → `ProgressTarget`. Child sessions share the parent
anchor (via the `opencode.subsession` alias written by `runPromptStream`'s unchanged
child discovery), so delegated tool activity resolves to the **same** thread
automatically. Sessions with no `slack.thread` alias (cron/github/etc.) resolve to
nothing and are silently ignored — a pure projection, no side effects on unmatched
events. Child events arriving before the alias is written are dropped — a brief
startup-race gap, tolerated under D2.

### What the listener derives

The four `emit*` helpers move from `runPromptStream` into the listener unchanged;
only their trigger point changes to "every firehose event for a resolvable target."
Parent and child tool activity both render in the same thread. One injected
dependency moves with them: `emitContextProgressFromInfo` needs the current
`ModelContextLimits` (today supplied to `runPromptStream` via `modelContextLimits()`),
so the listener must be given the same `modelContextLimits` accessor at construction.

| ProgressEvent                              | Derived from                                                                                                                     | Notes                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`                                    | a parent `user`-role `message.updated`                                                                                           | An auto-resume `Continue` is also a `user` message → it starts a fresh bubble (cosmetic under D2); the 3-tool threshold means nothing posts until then. Supersedes any prior bubble on the thread. |
| `tool` / `delegate` / `memory` / `context` | tool parts (parent + child `message.part.updated`) / `task` tool input / memory tool parts / parent `message.updated` token info | Same logic as the current `emit*` helpers; the full tools / memory / agents / context breakdown is preserved (D6).                                                                                 |
| (`session.error`)                          | parent `session.error`                                                                                                           | Not a finalizer. Marks a pending error and shows it inline as a `tool` event named `error` (mirrors today's `emit({ type: "tool", tool: "error", status: "error" })`). See _Error handling_.       |
| `done`                                     | parent `session.idle`                                                                                                            | The **sole finalizer**. Resolves completed (delete) or error (❌) per _Error handling_. Only the parent/anchor session's idle finalizes (D3).                                                      |

### Finalization: `session.idle` is the sole finalizer

`session.idle` is the only event that finalizes a bubble. **Only the parent/anchor
session's idle** does so — a delegated child's `session.idle` is ignored, so a child
finishing does not tear down the parent bubble (D3; the parent is
`reverseLookupAnchor(anchorId).currentSessionId`). On finalize the listener emits a
`done` event carrying only `sessionId`, `status` (`completed` | `error`), and, for
errors, the message — the only fields the sink's `done` path reads (`event.sessionId`
for the supersede match, `event.status`, `event.error`). The current `ProgressDone`
schema also requires `response` / `toolCalls` / `durationMs` / `resumed`, which only
`/trigger` has (they feed the NDJSON response, not the sink); slim the sink-facing
`done` to the fields above so the listener can produce it without `runPromptStream`'s
return value, and let `/trigger` write its NDJSON terminal line directly (see _NDJSON
/ `stream:true` contract_). The sink's `sessionId` match then drops a late `done` from
a superseded stream.

The same slimming applies to the sink-facing `start`: the listener derives it from a
stream `user`-role `message.updated` and has no `resumed`/`correlationKey` to supply,
while the sink's `start` path reads only `event.sessionId` (for the supersede match
and `ProgressSession`). `ProgressStartSchema` today also requires `resumed` (and an
optional `correlationKey`) — both `/trigger`-only and dead to the sink — so slim the
sink-facing `start` to just `sessionId` as well. Both `start` and `done` are thus
emitted by the listener, which knows neither `resumed` nor `correlationKey`.

The listener does **not** replicate `runPromptStream`'s `sawParentMessagePart`
stale-idle guard (D5): that guard exists to stop `runPromptStream` returning a
premature empty terminal result and closing consumption — concerns the listener does
not have. A premature idle on the listener finalizes a bubble that was never posted
(below the 3-tool threshold) → a silent no-op; the next event rebuilds the session.

### Error handling — keep vs dismiss, no timer

A `session.error` that recovers is a known OpenCode flake but is **vanishingly rare**
(observed ~0.12% of `session.error`s in retained logs; the overwhelming majority are
`MessageAbortedError: Aborted`, which never recover). All observed errors reliably
reach a subsequent `session.idle`, so the listener uses **idle as the commit point**
instead of a timer:

- On parent `session.error`: set a per-session **`pendingError`** (the message) scoped
  to the active run's session id (D4), and show it inline (`tool: "error"`). **Do not
  finalize.**
- On the **next** parent `message.part.updated`: **clear** `pendingError` (recovered).
  Events are processed in receipt order, so "the next part" needs no sequence number;
  `session.idle` does **not** count as recovery activity.
- On parent `session.idle`: if `pendingError` is **still set** → emit
  `done(status: "error", error)`; otherwise → emit `done(status: "completed")`.

`pendingError` is one bit of state — _was the most recent event for this session an
unrecovered error?_ — which is exactly the keep/dismiss rule.

This yields three **finalization** cases (whether a bubble has been posted is a
separate matter — see _Threshold interaction_ below):

| Sequence                          | Finalization                   | Why                                                                                   |
| --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `error` → nothing                 | **keep** (`⏳` + inline error) | nothing recovered it and no idle confirmed terminality; status stays as last observed |
| `error` → activity → `idle`       | **dismiss** (delete)           | activity after the error means it recovered                                           |
| `error` → `idle`, nothing between | **keep as ❌**                 | the last activity was the error (idle ≠ activity)                                     |

**Threshold interaction.** The three cases above are the _finalization_ decision; the
3-tool threshold is a separate gate on whether a bubble has been posted at all (and the
inline `tool: "error"` counts toward it, so an error can itself trip the threshold).
Below the threshold there is no bubble, so:

- **Case 3** still surfaces the error: `finish("error")` finds no `messageTs` and falls
  back to the sink's existing **❌ reaction on the source message** — errors stay
  visible without a bubble.
- **Case 2** stays silent, like any sub-threshold run (nothing was ever posted).
- **Case 1** below the threshold shows nothing — the error-then-no-idle orphan
  intersected with a trivial run (fewer than 3 events, no idle ever). Doubly rare and
  accepted under D2; surfacing it would require firing ❌ eagerly on `session.error`,
  which the non-terminal model deliberately avoids.

Aborts settle the same way: `session.error(Aborted)` → `idle` with the error still
pending → `done(error, "…abort…")`, which the sink's existing **abort-as-completed**
rule converts to a delete. So aborts dismiss without special-casing (D4).

Because `session.error` never finalizes on its own, a late cross-session error
cannot mis-fire a ❌ on a freshly started run; it can only set a pending flag scoped
to its own session id (D4).

### Listener state

Per-session (keyed by session id, so a parent and its children keep separate
records even when posting to the same thread):

- dedup / role tracking for derivation: `emittedToolStarts`, `emittedTaskDelegates`,
  and whatever the moved `emit*` helpers need;
- the per-session `pendingError` (the error message, or null) — no sequence number;
  set on `session.error`, cleared on the next part.

The parent's state is reset on its `start` and cleared on its `done`. Child sessions
have no `start`/`done` of their own on the listener (only the parent derives those),
so clear a child's per-session record when the parent finalizes — otherwise child
dedup sets accumulate across the process lifetime. A missed or late clear at worst
shows a tool once extra or once fewer — cosmetic under D2. No run-origin
classification and no resume counter; those stay in the untouched `runPromptStream`.

## Sink changes (`progress-manager.ts`)

The sink stops being timer-driven and stops surfacing a wall clock.

- **Remove the heartbeat ticker** (S1): `tickTimer`, `scheduleNextTick`, `onTick`,
  `tickDelayForElapsed`, and the timer cleanup in `abandon()` / `finish()`. Updates
  fire only on real events. Keep the 10s update throttle (`UPDATE_INTERVAL_MS`) — a
  stateless `lastUpdateTime` comparison, not a timer.
- **Drop the live elapsed counter** (D7): the in-progress header becomes
  `⏳ Working... N tool calls` (no `| <elapsed> elapsed`). Tools-only still renders
  inline as `… | latest: <tools>`; once extras (memory/agents/context) are present
  it breaks into the multi-line `• tools:` / `• memory:` / `• agents:` / `• context:`
  breakdown, exactly as today.
- **Delete the bubble on completion** (S2): drop the transient "✅ Done …" edit —
  `finish("completed")` just marks the entry completed and stops touching Slack.
  Deletion stays single-owner in `cleanupProgressMessages` (via `onSessionEnd` on the
  `done` branch), which already handles the `hasActiveSession` guard, transient-failure
  retry, `message_not_found`, supersede-orphan cleanup, and the per-thread error cap;
  `finish` does **not** delete directly (that would add a second delete path). The net
  change is "no ✅ edit," not "a new deleter." `finish("error")` still renders
  `❌ Failed — …` and keeps it (errors are the only entries cleanup does not delete).
- **Remove the standalone `error` `ProgressEvent` path**: the listener routes all
  terminals through `done`, so the sink no longer needs a separate `error` event
  type.

**Preserved sink behavior**: the 3-tool threshold before the first post, the 10s
throttle, the full tools/memory/agents/context breakdown and its memory-path
disambiguation, prior-progress cleanup, error visibility (❌, plus the no-message
`addReaction` fallback), abort-as-completed, supersede-on-`start` (`abandon`), and
Slack API error containment.

## What `/trigger` and `runPromptStream` lose

- **`/trigger`**: the `emit` closure as a progress producer — its `progressChain`,
  `resolveSlackProgressTarget` usage, `progressTransport` injection, and all
  `handleProgressEvent` calls (Slack). It keeps session resolution +
  `bindSessionToAnchor` (identity, which _enables_ listener target resolution), the
  send-lock / busy-gate / abort path, the prompt send, the accepted/busy response,
  and (only for `stream:true`) awaiting `runPromptStream`'s result. See _NDJSON /
  `stream:true` contract_ below — the NDJSON response is the one place `/trigger`
  still writes a `done`-shaped line, but now only the single terminal `done` (its own
  full HTTP-response shape, not the slimmed sink-facing `done`) synthesized from the
  return value, not the intermediate per-event stream.
- **`runPromptStream`**: the four `emit*` helpers, their progress-only dedup sets
  (`emittedToolStarts`, `emittedTaskDelegates`), the `emit(...)` calls (including the
  `tool: "error"` emit on `session.error`), and the injected `emit` closure /
  `PromptStreamDeps.emit` field. Everything non-progress listed under _Out of scope_
  stays.

### NDJSON / `stream:true` contract

Today the `emit` closure in `/trigger` doubles as the NDJSON writer: every
`ProgressEvent` (`start` / `tool` / `memory` / `delegate` / `context` / `done` /
`error`) is `res.write`-streamed to the HTTP client and also forwarded to the test
`progressEventSink`. Because progress derivation leaves `runPromptStream`, the
intermediate `tool` / `memory` / `delegate` / `context` events are **no longer
available to `/trigger`** — only `runPromptStream`'s return value
(`{ terminalError, textParts, toolCalls, totalParts }`) is. So the NDJSON contract
narrows to a single line: `/trigger` writes one terminal `done` synthesized from the
return value; the per-event progress stream (including the opening `start`) is dropped
from NDJSON, since no NDJSON consumer reads anything but the final `done` (so an
opening `start` would be dead output — skip it per YAGNI). That terminal line keeps
its current full shape (`sessionId` / `status` / `error` / `response` / `toolCalls` /
`durationMs` / `resumed`) and is now an HTTP-response shape `/trigger` writes
directly — distinct from the slimmed sink-facing `done` the listener emits (which
carries only `sessionId` / `status` / `error`). This is acceptable — the only NDJSON
consumers are the opencode E2E smoke script (`scripts/test-opencode-e2e.sh`, which
reads only the final `{ type: "done" }`'s `response`/`toolCalls`/`error`) and
`progressEventSink` in `trigger.test.ts`. The `progressEventSink` hook and the
trigger-test assertions on intermediate `start`/`tool`/`memory`/`context` events are
removed or rewritten to assert the new Slack-listener path instead (Phase 2 tests).
The standalone `error` NDJSON event currently emitted from the `/trigger` catch block
is folded into the terminal `done(status:"error")`.

## Phases

One PR; phases are review/checkpoint boundaries, not ship gates.

- **Phase 1 — firehose + ProgressListener + swap the producer.** Add the non-counting
  observer tee to `GlobalEventBus` (wired at construction, before `ensureConnected`;
  the bus's own lifecycle/accounting untouched; the registry hands each new bus a fresh
  observer bound to the once-constructed shared transport). Build `ProgressListener`:
  target resolution,
  the moved `emit*` helpers + per-session dedup state, `start` derivation,
  `session.idle` finalization (parent-only), and the pending-error keep/dismiss
  model. In the **same phase**, delete all Slack-progress code from `/trigger` and
  `runPromptStream` and narrow the NDJSON path to the single synthesized terminal
  `done` (per the _NDJSON / `stream:true` contract_) — old and new producers cannot
  both post.
- **Phase 2 — sink changes + tests.** Apply the sink changes (remove ticker, drop
  elapsed, delete-on-complete, remove the standalone `error` path). Rewrite the
  `trigger.test.ts` progress assertions: drop `progressEventSink` and the
  intermediate-event expectations, assert only the terminal NDJSON `done` for
  `stream:true`, and move progress-behavior assertions onto the listener path. Unit
  tests: (a) target resolution for a parent and for a child via the `subsession`
  alias; (b) a session with no `slack.thread` alias is ignored; (c) the three error
  cases — `error`→nothing keeps, `error`→activity→`idle` dismisses, `error`→`idle`
  keeps as ❌ (and `idle` does not clear a pending error); (d) a child `session.idle`
  does not finalize the parent; (e) per-session dedup reset on `start` / cleared on
  `done`.
- **Phase 3 — integration verify.** Push to trigger the Slack/OpenCode E2E workflow;
  exercise mention → reply → delegated-task → completion, an interrupt mid-run, an
  auto-resume cycle, and an induced recovering `session.error`.

## Decision log

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Progress is a single passive listener on a bus firehose; two bus readers, one progress producer.                                                                                                                                                                                                                                                                                                                                                                                                          | The listener is naive about auto-resume, so there is no projector-vs-stream race. Auto-resume stays its own owner in `runPromptStream`; progress has exactly one producer.                                                                                                                                                                                                                           |
| D2  | Progress may be out of sync with triggers; cosmetic drift is accepted. No `done` debounce for auto-resume.                                                                                                                                                                                                                                                                                                                                                                                                | A bubble may finish and re-appear across an auto-resume `Continue` (a brief blink). A debounce would re-introduce the only timer to hedge a tolerated cosmetic outcome — not worth it.                                                                                                                                                                                                               |
| D3  | Only the parent/anchor session's `session.idle` finalizes; a child's idle is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                     | A delegated child finishing must not tear down the parent bubble. Compare against `reverseLookupAnchor(anchorId).currentSessionId`.                                                                                                                                                                                                                                                                  |
| D4  | `session.error` is non-terminal: a single per-session `pendingError` flag (the message; cleared on the next `message.part.updated`, no sequence number needed since events arrive in receipt order); `session.idle` is the sole finalizer (carrying the existing `done` sessionId match); aborts settle via idle → delete.                                                                                                                                                                                | Keeps the design timerless and removes false ❌ with one bit of state. A late cross-session error can only set a scoped flag, never finalize, so it cannot mis-fire a ❌.                                                                                                                                                                                                                            |
| D5  | Do not replicate the `sawParentMessagePart` stale-idle guard on the listener.                                                                                                                                                                                                                                                                                                                                                                                                                             | Its job — not returning a premature empty terminal result and not closing consumption — lives in the untouched `runPromptStream`. On the listener a premature idle finalizes a never-posted bubble → silent no-op.                                                                                                                                                                                   |
| D6  | Keep the full multi-line breakdown — tools, memory, agents, **and** context.                                                                                                                                                                                                                                                                                                                                                                                                                              | The progress breakdown is the product value; the `emitTool`/`emitMemory`/`emitDelegate`/`emitContext` helpers move to the listener rather than being dropped.                                                                                                                                                                                                                                        |
| D7  | Drop the live elapsed counter and the heartbeat ticker; updates are purely event-driven.                                                                                                                                                                                                                                                                                                                                                                                                                  | With no ticker the counter would be stale, and with delete-on-complete there is no terminal message to host a total. Makes the listener fully timerless.                                                                                                                                                                                                                                             |
| D8  | Drop the transient "✅ Done …" edit on completion (S2); `cleanupProgressMessages` stays the sole deleter; keep ❌ on error.                                                                                                                                                                                                                                                                                                                                                                               | The ✅ text is posted then immediately removed by cleanup today, so it is a dead render — but deletion already has one owner (cleanup, which also handles retries/orphans/error-cap). `finish` marking completed and letting cleanup delete avoids a second delete path; it removes the dead _edit_, not a delete path. Errors are the only entries cleanup keeps.                                   |
| D9  | Slack target resolved only from the session's current `slack.thread` alias.                                                                                                                                                                                                                                                                                                                                                                                                                               | Keeps scope to live Slack threads; no historical/approval/cron/GitHub progress.                                                                                                                                                                                                                                                                                                                      |
| D10 | Bootstrap-memory reads (synthesized `memory read` events in `index.ts`) are dropped from Slack progress.                                                                                                                                                                                                                                                                                                                                                                                                  | They are not OpenCode stream events, so the passive listener cannot see them. Revisit only if the first update visibly degrades.                                                                                                                                                                                                                                                                     |
| D11 | The firehose is a **passive, non-counting per-bus observer** (a reader-loop tee on `GlobalEventBus`), not a subscription. It never touches `activeSubscriptions` / `onEmpty` / `reconnectIfActive`; each bus owns its observer and discards it (and its per-session state) on `close()`. Only the Slack transport is long-lived; the registry wires a fresh observer to each bus it constructs. A dead connection with no active trigger means no progress update until the next trigger reopens the bus. | A normal consumer with no special treatment leaves the bus lifecycle `runPromptStream` depends on completely untouched. Every run `/trigger` drives (any source) holds a subscription for its full duration, so the bus is alive exactly when a run is active; and a bus only closes at `activeSubscriptions === 0` — when no bubble is live — so discarding observer state on close is always safe. |

## Risks / open questions

- **Observer wiring.** The observer is a non-counting tee owned by the bus, wired at
  construction so it is present before the reader loop starts and sees a run's opening
  events; it touches none of the `activeSubscriptions` / `releaseSubscription` /
  `onEmpty` / `reconnectIfActive` accounting (D11). The one thing to get right is that
  the registry wires it at construction, before `ensureConnected`. If the connection
  dies while no trigger is active there is no reconnect and no progress update —
  accepted, since nothing is running and the next trigger reopens the bus.
- **`start` fidelity.** Deriving `start` from a parent `user`-role message is the one
  heuristic that affects when a bubble appears (today `start` is emitted explicitly by
  `/trigger`; the listener instead synthesizes it from the stream). A listener that
  starts mid-run misses that run's `start` and renders via on-the-fly session creation
  with a reset count — acceptable under D2; confirm a fresh prompt's role is observable
  promptly. Note the bus's `extractSessionId` keys `message.updated` off
  `properties.info` only, while `runPromptStream` reads `properties.info ?? properties.message`;
  if a role-bearing `message.updated` ever arrives with only `properties.message`, the
  bus drops it (no sid) and the firehose never sees it — keep the listener's role read
  aligned with whatever the bus actually fans out.
- **Child-event startup race.** Child events arriving before the
  `opencode.subsession` alias is written resolve to nothing and are dropped. Brief
  and tolerated under D2; confirm the alias is written early in child discovery.
- **Error-then-no-idle.** If a real error is never followed by `session.idle`, the
  bubble stays `⏳` with the inline error rather than becoming ❌ — the same orphan
  case the timerless design already accepts (no watchdog). Observed traffic shows
  errors reliably reach idle, so this is rare-of-rare.

## Exit criteria

- `/trigger` and `runPromptStream` contain no Slack-progress-producing code and never
  call `handleProgressEvent`; the listener is the sole producer of Slack progress.
  (`/trigger` may still write the single synthesized terminal `done` to the NDJSON
  response per the _NDJSON / `stream:true` contract_ — that is an HTTP response shape,
  not a Slack progress signal.)
- The listener is timerless — no `setTimeout`/ticker/grace timer; every Slack call is
  triggered by a real OpenCode event.
- Slack behaviors preserved: 3-tool threshold, 10s throttle, full
  tools/memory/agents/context breakdown, prior-progress cleanup, error visibility,
  abort-as-completed, supersede-on-`start`.
- `session.idle` is the sole finalizer; a delegated child's idle does not finalize
  the parent.
- The three error cases render correctly: `error`→nothing keeps, `error`→activity→
  `idle` dismisses, `error`→`idle` keeps as ❌; a recovered `session.error` produces
  no false ❌.
- `stream:true`/NDJSON/smoke-test responses work off `runPromptStream`'s existing
  return value: the E2E smoke script still receives a terminal `{ type: "done" }`
  with `error`/`response`. Intermediate per-event NDJSON progress is intentionally
  dropped (see _NDJSON / `stream:true` contract_); `progressEventSink` and the
  intermediate-event trigger-test assertions are removed/rewritten accordingly.
- Slack/OpenCode E2E workflow green on push.
