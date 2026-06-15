<!-- /autoplan restore point: /Users/son.dao/.gstack/projects/scoutqa-dot-ai-thor/refactor-progress-update-autoplan-restore-20260613-152859.md -->
# Slack progress as a passive event-stream projection

Make Slack progress a **passive projection** of the OpenCode event stream, owned by a
passive listener — the sole producer of Slack progress — that observes the event bus and
talks to no one. Every Slack call is triggered by a real OpenCode event; `session.idle`
finalizes a progress bubble. The `/trigger` handler and `runPromptStream` lose all
_Slack_ progress code — they never register a Slack target, never call
`handleProgressEvent`, and do not know the Slack listener exists. (`/trigger` still
synthesizes a single terminal `done` for its NDJSON HTTP response from
`runPromptStream`'s return value; see the _NDJSON / `stream:true` contract_.)

> **Reviewed by /autoplan (CEO + Eng dual voices); reverted to this stream-derived design
> by user decision after the operator-UI requirement surfaced (see Decision Log + review
> trail at end).** The design stays passive, timerless (for finalization), and independent
> of `runPromptStream`. Two review findings were resolved by the user as follows:
> - **C1 (`index.ts:662` reuses one session id across turns):** handled by the existing
>   **thread-keyed single-bubble map**, not by matching `sessionId`. One bubble per thread:
>   while it is live, a new turn's events render into it; a parent `session.idle` dismisses
>   it and clears the map entry; the next event posts a fresh bubble. A stale `idle` from a
>   prior turn just dismisses-and-recreates (brief flicker, accepted) instead of silently
>   losing the live turn. The broken `sessionId`-match guard is **deleted** — with one
>   producer (the listener) there is no competing `done` to guard against.
> - **C2 (`session-error-grace.ts` "often recovers"):** recovery at the Slack layer is
>   **operator-confirmed ~0.12%** (verified in Slack history), and the keep/dismiss model
>   already clears a `pendingError` on the next part, so a recovering error shows no false ❌
>   **without a timer**. We keep the timerless error model; the error-then-no-idle orphan
>   stays the accepted rare-of-rare case (errors reliably reach `session.idle`). The only
>   timer anywhere is the heartbeat **render** ticker (kept, H3) — not a finalization timer.
>
> **Why stream-derived (not authoritative finalization from `runPromptStream`):** an
> operator can open the OpenCode UI and drive a session directly — no `/trigger`, no
> `runPromptStream`. Those sessions still carry a `slack.thread` alias, so they have a Slack
> target. Only a passive bus listener can post progress for them, so the listener serves
> both `/trigger` runs and operator-UI sessions uniformly and must own its own connection
> liveness (D11-rev).

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

A passive **ProgressListener** is the **sole producer** of Slack progress: one observer
per OpenCode URL, feeding a single shared Slack transport. It observes the bus firehose,
resolves the Slack target for any session id from the existing alias index, derives
`ProgressEvent`s from the stream, and feeds the sink. It is fully passive — it never sends
a prompt, never runs auto-resume, and tolerates being out of sync with triggers — and has
no dependency on `runPromptStream`. Finalization is **timerless** (driven by
`session.idle`); the only timer anywhere is the heartbeat **render** ticker (kept, H3).

**The listener serves every session the bus carries, `/trigger`-driven or not.** It owns
its own long-lived subscription so the SSE connection stays up (and auto-reconnects) for
the process lifetime — so an operator working a session directly in the OpenCode UI (no
`/trigger`, no `runPromptStream`) still gets a progress bubble on its `slack.thread`
(D11-rev). `/trigger` and `runPromptStream` contain no Slack-progress code (the only
residue is `/trigger`'s synthesized NDJSON terminal `done` — see the _NDJSON /
`stream:true` contract_).

## Scope

**In scope**

- A passive observer on `GlobalEventBus` (a reader-loop tee) and a `ProgressListener`
  that consumes it; the listener holds a long-lived subscription that keeps the bus
  connected for the process lifetime; `EventBusRegistry` wires the observer to the
  once-constructed, shared Slack transport.
- **Operator-UI sessions** (an operator drives a session directly in the OpenCode UI,
  bypassing `/trigger`) are a first-class case: they have a `slack.thread` alias, so the
  listener resolves a target and projects their progress exactly like a `/trigger` run.
- Moving progress derivation (the four `emit*` helpers + dedup state) out of
  `runPromptStream` and the `emit`/`progressChain`/target boilerplate out of
  `/trigger`, into the listener.
- **One bubble per thread** via the existing thread-keyed map (C1): events render into the
  current bubble; a parent `session.idle` dismisses it and clears the entry; the next event
  posts a fresh bubble. The broken `sessionId`-match guard is deleted (single producer).
- The **timerless keep/dismiss error model** (C2): a `pendingError` bit cleared on the next
  part; `session.idle` commits ❌ if still pending; no grace timer.
- Sink changes: delete the bubble on completion (S2); the heartbeat ticker + live elapsed
  counter are **kept** (gate decision H3 — a static bubble looks wedged on long waits).

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
                  └─ firehose (NEW) ─────────────► ProgressListener (per-bus, passive; owns a long-lived subscription)
                                                     per event, for a resolvable target:
                                                       resolve target: sessionId
                                                         → resolveSessionAnchorId → reverseLookupAnchor
                                                         → slack.thread → ProgressTarget
                                                       derive ProgressEvent (start/tool/memory/delegate/context)
                                                       any event → update the thread's one bubble, or create it
                                                       session.error → set pendingError; show inline; clear on next part
                                                       parent session.idle → dismiss the bubble + clear the map entry
                                                       handleProgressEvent(target, evt, slackTransport)

operator UI: works a session directly → OpenCode emits the same events → firehose sees them
             (no /trigger, no runPromptStream) → projected onto the session's slack.thread.

/trigger: resolve session (bindSessionToAnchor) → withKeyLock(send){ busy-gate / abort / promptAsync } → return accepted/busy
          (stream:true only) await runPromptStream result → NDJSON terminal done synthesized from result.
          NO Slack progress code, NO handleProgressEvent.
```

Two readers of the bus — `runPromptStream`'s per-trigger subscriptions (unchanged) and the
listener's firehose — but exactly **one producer of progress** (the listener). They never
coordinate. The listener is naive about auto-resume: if it finalizes a bubble on a
`/trigger` run's transient idle and `runPromptStream` then auto-resumes, a fresh bubble
appears on the `Continue` (accepted blink — D2; operator-UI sessions don't auto-resume, so
they never blink).

### Bus firehose

The firehose is a **passive, non-counting observer** of `GlobalEventBus` — a normal
consumer with no special treatment. Inside the reader loop, alongside the existing
`this.emitter.emit(sid, payload)` per-session dispatch, the bus hands the same decoded
event to an observer callback. The observer therefore sees the same events the
per-session path does — every event with an extractable sid (`extractSessionId`),
parent and child. Events with no extractable sid are dropped at the bus and never
reach the observer either (acceptable: the listener only acts on `message.*` /
`session.idle` / `session.error`, all of which carry a sid).

**The listener owns the bus connection (D11-rev).** Because operator-UI sessions produce
events with no `/trigger` subscription holding the bus open, the listener cannot ride
`/trigger`'s subscription lifecycle — it must keep the connection up itself. So the
listener **holds its own long-lived subscription** for the process lifetime: the bus
connects at startup and `reconnectIfActive` keeps it up (the listener's subscription keeps
`activeSubscriptions > 0`, so the bus never closes on `onEmpty` and reconnects on drop).
This is simpler than a "non-counting tee" — the listener is just a normal permanent
subscriber. The cost is one always-on SSE connection per OpenCode URL (fine for a single
server). `runPromptStream`'s per-trigger subscriptions layer on top and behave exactly as
today.

Inside the reader loop, alongside the existing `this.emitter.emit(sid, payload)` dispatch,
the bus hands the same decoded event to the listener's observer — so the observer sees the
same events the per-session path does (every event with an extractable sid, parent and
child). Events with no extractable sid are dropped at the bus (acceptable: the listener
only acts on `message.*` / `session.idle` / `session.error`, all of which carry a sid —
align the bus's `message.updated` extraction to `properties.info ?? properties.message`,
H6). The wrapper must isolate observer/Slack exceptions so they cannot kill the SSE reader.

Because the connection is always up, the listener observes operator-UI activity the moment
it happens, with no dependency on a concurrent `/trigger` run. On restart the listener
re-attaches and projects current activity; there is no replay of past runs. State is held
in the listener (not discarded on a per-run boundary), so finalizing one turn never drops
another session's live bubble; per-session state is cleared on that session's finalize.

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
| `start`                                    | first event for a thread with no live bubble                                                                                     | Creates the thread's single bubble; the 3-tool threshold gates the first post. No supersede — while a bubble is live, later events (including a new turn or an auto-resume `Continue`) render into it. After a dismiss, the next event creates a fresh bubble. |
| `tool` / `delegate` / `memory` / `context` | tool parts (parent + child `message.part.updated`) / `task` tool input / memory tool parts / parent `message.updated` token info | Same logic as the current `emit*` helpers; the full tools / memory / agents / context breakdown is preserved (D6).                                                                                 |
| (`session.error`)                          | parent `session.error`                                                                                                           | Not a finalizer on its own. Sets `pendingError` and shows it inline as a `tool` event named `error`; cleared on the next part (recovered). See _Error handling_.                                    |
| `done`                                     | parent `session.idle`                                                                                                            | The finalizer. Resolves completed (delete) or error (❌) per _Error handling_. Only the parent/anchor session's idle finalizes (D3); it dismisses the thread's current bubble and clears the map (C1). |

### Finalization: one bubble per thread, dismissed on parent `session.idle` (C1)

The listener keeps the existing **thread-keyed in-memory map** — one progress bubble per
Slack thread (`channel:threadTs`). It does **not** track turns or match `sessionId`:

- Any activity event for a thread updates the current bubble, or creates one if none
  exists (gated by the 3-tool threshold).
- A parent `session.idle` finalizes: dismiss the bubble (delete on completed, keep-as-❌ if
  `pendingError`) and clear the map entry.
- The next event for the thread finds no bubble and posts a fresh one.

This is why the C1 bug (one OpenCode session id reused across turns — `index.ts:662-673`)
does not cause silent loss: a stale `idle` from a prior turn just dismisses the current
bubble, and the live turn's next event recreates it. We **accept the brief gap/flicker**
(and a tool-count reset on the recreated bubble) for simplicity — no turn counter, no
`sessionId` matching. The original draft's `sessionId`-match guard is **deleted**: with a
single producer (the listener) there is no competing `done` stream to guard against.

**Only the parent/anchor session's idle** finalizes — a delegated child's `session.idle`
is ignored, so a child finishing does not dismiss the parent bubble (D3; the parent is
`reverseLookupAnchor(anchorId).currentSessionId`).

On finalize the listener emits a `done` carrying `sessionId`, `status`
(`completed` | `error`), and, for errors, the message. The current `ProgressDone` schema
also requires `response`/`toolCalls`/`durationMs`/`resumed`, which only `/trigger` has
(they feed the NDJSON response, not the sink); the sink-facing `done`/`start` are slimmed to
what the sink reads (`sessionId` + status/error), and `/trigger` writes its full NDJSON
terminal line directly (see _NDJSON / `stream:true` contract_). The slim `done`/`start` are
a distinct internal type, not an overloaded `ProgressEvent` union.

The listener does **not** replicate `runPromptStream`'s `sawParentMessagePart` stale-idle
guard (D5): a premature idle on the listener finalizes a bubble that was never posted
(below the 3-tool threshold) → a silent no-op; the next event rebuilds the bubble.

### Error handling — keep vs dismiss, no timer (C2)

A `session.error` that recovers is a known OpenCode flake but is **rare at the Slack layer
— operator-confirmed ~0.12%** of `session.error`s in Slack history (the overwhelming
majority are `MessageAbortedError: Aborted`, which never recover). All observed errors
reliably reach a subsequent `session.idle`, so the listener uses **idle as the commit
point** instead of a timer (the `session-error-grace.ts` "often recovers" comment is about
the broader/older raw-stream denominator; the keep/dismiss "clear on next part" below
handles recovery without a timer anyway):

- On parent `session.error`: set a per-session **`pendingError`** (the message) scoped to
  the session id, and show it inline (`tool: "error"`). **Do not finalize.**
- On the **next** parent `message.part.updated`: **clear** `pendingError` (recovered).
  Events are processed in receipt order, so "the next part" needs no sequence number;
  `session.idle` does **not** count as recovery activity.
- On parent `session.idle`: if `pendingError` is **still set** → emit
  `done(status: "error", error)`; otherwise → emit `done(status: "completed")`.

`pendingError` is one bit of state — _was the most recent event for this session an
unrecovered error?_ — which is exactly the keep/dismiss rule. A recovering error therefore
shows **no false ❌** with no timer.

This yields three **finalization** cases (whether a bubble has been posted is a separate
matter — see _Threshold interaction_):

| Sequence                          | Finalization                   | Why                                                                                   |
| --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `error` → nothing                 | **keep** (`⏳` + inline error) | nothing recovered it and no idle confirmed terminality (the accepted rare-of-rare orphan, H2) |
| `error` → activity → `idle`       | **dismiss** (delete)           | activity after the error means it recovered                                           |
| `error` → `idle`, nothing between | **keep as ❌**                 | the last activity was the error (idle ≠ activity)                                     |

**Threshold interaction.** The 3-tool threshold gates whether a bubble was posted at all
(the inline `tool: "error"` counts toward it). Below the threshold there is no bubble, so a
terminal `error` finalize finds no `messageTs` and falls back to the sink's existing **❌
reaction on the source message**. A recovered error below threshold stays silent.

Aborts: `session.error(Aborted)` → `idle` with the error still pending →
`done(error, "…abort…")`, which the sink's existing **abort-as-completed** rule converts to
a delete.

Because `session.error` never finalizes on its own, a late cross-session error cannot
mis-fire a ❌ on a freshly started run — it only sets a flag scoped to its own session id.
**H2 (error-then-no-idle → perpetual `⏳`) is accepted**: errors reliably reach `session.idle`
(per the operator-confirmed data), so this is rare-of-rare; for `/trigger` runs the
HTTP/result path still surfaces the error in its NDJSON `done`.

### Listener state

Per-session (keyed by session id, so a parent and its children keep separate
records even when posting to the same thread):

- dedup / role tracking for derivation: `emittedToolStarts`, `emittedTaskDelegates`,
  and whatever the moved `emit*` helpers need;
- the per-session `pendingError` (the error message, or null) — no sequence number, no
  timer; set on `session.error`, cleared on the next part (C2).

The bubble itself lives in the thread-keyed sink map (one per thread, C1), dismissed on
parent `done`. Per-session listener state is cleared when the parent finalizes. Child
sessions have no `done` of their own (only the parent derives it), so clear a child's
per-session record when the parent finalizes — otherwise child dedup sets accumulate across
the process lifetime. A missed/late clear at worst shows a tool once extra or once fewer —
cosmetic. No run-origin classification and no resume counter; those stay in the untouched
`runPromptStream`.

## Sink changes (`progress-manager.ts`)

The sink's only behavioral change is delete-on-complete (S2).

- **Keep the heartbeat ticker + live elapsed counter** (S1/D7 — gate decision H3). The
  ticker (`tickTimer`, `scheduleNextTick`, `onTick`, `tickDelayForElapsed`) keeps the
  elapsed counter fresh between events; a static bubble on a long shell/MCP/approval wait
  is indistinguishable from a wedged agent, and `progress-manager.test.ts` already asserts
  the ticker. The header stays `⏳ Working... N tool calls | <elapsed> elapsed`. The ticker
  edits text only and never finalizes, so it does not interfere with the idle/grace
  finalizers. The 10s update throttle (`UPDATE_INTERVAL_MS`) stays.
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

- **Phase 1 — firehose + ProgressListener (listener owns the connection).** Add the
  observer tee to `GlobalEventBus`'s reader loop and align `extractSessionId` for
  `message.updated` to `properties.info ?? properties.message` (H6). The listener holds a
  long-lived subscription so the bus stays connected for the process lifetime and
  reconnects on drop (D11-rev) — serving operator-UI sessions that never call `/trigger`.
  Wrap the observer call so its exceptions can't kill the SSE reader. Build
  `ProgressListener`: target resolution, the moved `emit*` helpers + per-session dedup,
  bubble creation into the thread-keyed map, `session.idle` finalization (parent-only,
  dismiss + clear the map entry, C1), and the timerless keep/dismiss `pendingError` model
  (C2). Delete the sink's `sessionId`-match guard. In the **same phase**, delete all
  Slack-progress code from `/trigger` and `runPromptStream` and narrow the NDJSON path to
  the single synthesized terminal `done` (per the _NDJSON / `stream:true` contract_) — old
  and new producers cannot both post.
- **Phase 2 — sink changes + tests.** Apply S2 (delete-on-complete; drop the ✅ edit) and
  remove the standalone `error` event type; **keep** the heartbeat ticker + elapsed (H3).
  Rewrite the `trigger.test.ts` progress assertions: drop `progressEventSink` and the
  intermediate-event expectations, assert only the terminal NDJSON `done` for `stream:true`,
  and move progress-behavior assertions onto the listener path. Unit tests: (a) target
  resolution for a parent and a child via the `subsession` alias; (b) a session with no
  `slack.thread` alias is ignored; (c) **operator-UI session** (no `/trigger`) gets a bubble
  on its `slack.thread`; (d) **C1: a stale parent `idle` dismisses the current bubble and a
  subsequent event recreates a fresh one** (flicker accepted, no silent loss); (e) the three
  error cases — `error`→nothing keeps `⏳`, `error`→activity→`idle` dismisses,
  `error`→`idle` keeps as ❌ (and `idle` does not clear a pending error); (f) **C2: a
  recovering `session.error` (a part arrives after) produces no ❌, with no timer**; (g)
  abort → delete; (h) a child `session.idle` does not dismiss the parent bubble; (i)
  per-session dedup cleared on parent `done`; (j) an observer-callback exception does not
  kill the SSE reader; (k) the listener's long-lived subscription keeps the bus connected
  with no `/trigger` active, and reconnects on drop.
- **Phase 3 — integration verify.** Push to trigger the Slack/OpenCode E2E workflow;
  exercise mention → reply → delegated-task → completion, an interrupt mid-run, an
  auto-resume cycle, an induced recovering `session.error`, and **an operator working a
  session directly in the OpenCode UI** (assert its bubble appears and finalizes).

## Decision log

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Progress is a single passive listener on a bus firehose; two bus readers, one progress producer.                                                                                                                                                                                                                                                                                                                                                                                                          | The listener is naive about auto-resume, so there is no projector-vs-stream race. Auto-resume stays its own owner in `runPromptStream`; progress has exactly one producer.                                                                                                                                                                                                                           |
| D2  | Cosmetic drift across an auto-resume `Continue` is accepted (a brief blink) for `/trigger` runs; no debounce. Operator-UI turns don't auto-resume, so they never blink.                                                                                                                                                                                                                                                                                                                                    | A debounce would add timing complexity to hedge a tolerated cosmetic outcome on one flow only. The blink is rare and self-corrects on the next post.                                                                                                                                                                                                                                                |
| D3  | Only the parent/anchor session's `session.idle` finalizes; a child's idle is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                     | A delegated child finishing must not tear down the parent bubble. Compare against `reverseLookupAnchor(anchorId).currentSessionId`.                                                                                                                                                                                                                                                                  |
| D4  | `session.error` is non-terminal and **timerless**: a per-session `pendingError` flag (the message), cleared on the next `message.part.updated` (recovered); `session.idle` commits ❌ if still pending; aborts settle via idle → delete. No grace timer.                                                                                                                                                                                                                                                     | Slack-layer recovery is **operator-confirmed ~0.12%** (verified in Slack history), and clear-on-next-part already removes false ❌ without a timer. The C2 review flag is resolved by that data; the error-then-no-idle orphan (H2) is the accepted rare-of-rare case since errors reliably reach `session.idle`. Avoiding the timer is the simpler, posture-aligned choice.                          |
| D5  | Do not replicate the `sawParentMessagePart` stale-idle guard on the listener.                                                                                                                                                                                                                                                                                                                                                                                                                             | Its job — not returning a premature empty terminal result and not closing consumption — lives in the untouched `runPromptStream`. On the listener a premature idle finalizes a never-posted bubble → silent no-op.                                                                                                                                                                                   |
| D6  | Keep the full multi-line breakdown — tools, memory, agents, **and** context.                                                                                                                                                                                                                                                                                                                                                                                                                              | The progress breakdown is the product value; the `emitTool`/`emitMemory`/`emitDelegate`/`emitContext` helpers move to the listener rather than being dropped.                                                                                                                                                                                                                                        |
| D7-rev | **(H3 gate decision — supersedes original D7)** Keep the heartbeat ticker + live elapsed counter.                                                                                                                                                                                                                                                                                                                                                                                                          | A static bubble on a long shell/MCP/approval wait is indistinguishable from a wedged agent; `progress-manager.test.ts` asserts the ticker. The ticker edits text only and never finalizes, so it does not interfere with the idle finalizer.                                                                                                                                                  |
| C1  | **One bubble per thread via the existing thread-keyed map; no turn/`sessionId` tracking.** Events feed the current bubble; a parent `session.idle` dismisses it and clears the entry; the next event recreates a fresh bubble. The broken `sessionId`-match guard is deleted.                                                                                                                                                                                                                               | `index.ts:662-673` reuses one OpenCode session id across turns, so a `sessionId` match can't tell a stale `idle` from the live bubble. Rather than add a turn counter, accept that a stale `idle` dismisses-and-recreates (brief flicker + count reset) — no silent loss, and the single producer means no competing `done` to guard. Simpler; greenfield "fewer moving parts."                       |
| D8  | Drop the transient "✅ Done …" edit on completion (S2); `cleanupProgressMessages` stays the sole deleter; keep ❌ on error.                                                                                                                                                                                                                                                                                                                                                                               | The ✅ text is posted then immediately removed by cleanup today, so it is a dead render — but deletion already has one owner (cleanup, which also handles retries/orphans/error-cap). `finish` marking completed and letting cleanup delete avoids a second delete path; it removes the dead _edit_, not a delete path. Errors are the only entries cleanup keeps.                                   |
| D9  | Slack target resolved from the session's `slack.thread` alias (via `resolveSessionAnchorId` → `reverseLookupAnchor`). Sessions with no `slack.thread` alias are ignored.                                                                                                                                                                                                                                                                                                                                   | Alias-based resolution is what lets the listener serve **operator-UI sessions** — they have no `/trigger`/correlationKey, only the alias. (Caveat M3: an anchor with multiple Slack histories could resolve to a non-live thread; existing trigger-log logic finds the newest. Documented limitation; revisit if it bites.)                                                                          |
| D10 | Bootstrap-memory reads (synthesized `memory read` events in `index.ts`) are dropped from Slack progress.                                                                                                                                                                                                                                                                                                                                                                                                  | They are not OpenCode stream events, so the passive listener cannot see them. Revisit only if the first update visibly degrades.                                                                                                                                                                                                                                                                     |
| D11-rev | **(supersedes original D11 — the listener owns the connection.)** The listener holds a **long-lived subscription** that keeps the bus connected for the process lifetime and reconnects on drop; it observes via a reader-loop tee. It is NOT a non-counting freeloader on `/trigger`'s subscriptions.                                                                                                                                                                                                       | Operator-UI sessions produce events with no `/trigger` subscription holding the bus open, so liveness cannot ride `/trigger`. A permanent listener subscription is simpler than a non-counting tee and gives reconnect for free. Cost: one always-on SSE connection per OpenCode URL (fine for a single server).                                                                                     |
| D-operator | **Operator-UI sessions are first-class:** an operator driving a session directly in the OpenCode UI (no `/trigger`, no `runPromptStream`) gets progress projected onto its `slack.thread`, finalized by the listener's `session.idle` path.                                                                                                                                                                                                                                                                | This is the concrete second consumer that justifies the firehose + alias resolution + listener-owned connection over a simpler in-`runPromptStream` projector. Without it, the in-stream projector would be the leaner design.                                                                                                                                                                       |

## Risks / open questions

- **Listener connection ownership.** The listener must hold its subscription before the
  first events it cares about and keep it for the process lifetime; reconnect must work
  while it is the only subscriber (`reconnectIfActive` keys off `activeSubscriptions > 0`,
  which the listener's subscription satisfies). The always-on connection is a behavior
  change (today the connection drops when idle) — confirm one persistent SSE per OpenCode
  URL is acceptable.
- **`start` fidelity.** `start` is derived from a parent `user`-role `message.updated`. A
  listener that starts mid-run renders via on-the-fly session creation with a reset count —
  acceptable (D2). Align the bus's `extractSessionId` for `message.updated` to
  `properties.info ?? properties.message` (H6) so a role-bearing message carrying only
  `properties.message` is not dropped at the bus.
- **Child-event startup race.** Child events arriving before the `opencode.subsession`
  alias is written resolve to nothing and are dropped. Brief and tolerated; confirm the
  alias is written early in child discovery.
- **C1 flicker (accepted).** A stale parent `idle` dismisses the live bubble; the next
  event recreates it with a reset tool count. Accepted for simplicity (no turn tracking).
  Worst case during the rare error-while-reused intersection: a stray ❌ bubble plus the
  recreated bubble — cosmetic, rare-of-rare.
- **Error-then-no-idle (accepted, H2).** If a real error never reaches `session.idle`, the
  bubble stays `⏳` with the inline error rather than becoming ❌ — the timerless model has
  no watchdog. Operator-confirmed data shows errors reliably reach idle, so this is
  rare-of-rare; for `/trigger` runs the NDJSON `done` still carries the error.
- **Operator-UI finalization.** Operator turns rely on `session.idle` since there is no
  `runPromptStream`. Confirm the OpenCode UI emits `session.idle` when an operator turn
  settles (the listener's only finalizer for these sessions).

## Exit criteria

- `/trigger` and `runPromptStream` contain no Slack-progress-producing code and never
  call `handleProgressEvent`; the listener is the sole producer of Slack progress.
  (`/trigger` may still write the single synthesized terminal `done` to the NDJSON
  response per the _NDJSON / `stream:true` contract_ — an HTTP response shape, not a Slack
  signal.)
- The listener owns its connection: progress posts for an **operator-UI session** (no
  `/trigger`) on its `slack.thread`, and the connection reconnects with no `/trigger`
  active.
- Slack behaviors preserved: 3-tool threshold, 10s throttle, full
  tools/memory/agents/context breakdown, prior-progress cleanup, error visibility,
  abort-as-completed, supersede-on-`start`, and the heartbeat/elapsed counter (kept, H3).
- One bubble per thread (C1): a stale parent `idle` dismisses-and-recreates rather than
  silently losing the live turn; the `sessionId`-match guard is gone.
- A delegated child's idle does not dismiss the parent bubble (D3).
- A recovering `session.error` (a part arrives after) produces **no false ❌** with no timer
  (C2); the three error cases render correctly (`error`→nothing keeps `⏳`,
  `error`→activity→`idle` dismisses, `error`→`idle` keeps as ❌); abort → delete.
- `stream:true`/NDJSON/smoke-test responses work off `runPromptStream`'s existing
  return value: the E2E smoke script still receives a terminal `{ type: "done" }`
  with `error`/`response`. Intermediate per-event NDJSON progress is intentionally
  dropped (see _NDJSON / `stream:true` contract_); `progressEventSink` and the
  intermediate-event trigger-test assertions are removed/rewritten accordingly.
- Slack/OpenCode E2E workflow green on push.

## /autoplan review trail

This plan was reviewed by /autoplan (CEO + Eng phases, dual voices: Codex 0.138.0 + independent Claude subagents). Summary of how the design landed here:

- **CEO dual voices (5/6 dimensions flagged):** both said the original "timerless, `session.idle` as sole finalizer, `sessionId`-keyed supersede" model was unsafe. Two findings verified in code:
  - **C1** — `index.ts:662-673` reuses one OpenCode session id across prompts in a thread, so a `sessionId`-keyed guard cannot distinguish a stale `idle` from a live one.
  - **C2** — `session-error-grace.ts:4` ("OpenCode often recovers") contradicts the uncited "~0.12% rare recovery" premise.
- **Premise gate → initially option B** (authoritative finalization from `runPromptStream`). **Eng dual voices** confirmed B's direction but surfaced that it re-coupled `runPromptStream` to the Slack writer and needed `runToken`/ordering/bus-close machinery.
- **Reverted to this stream-derived design** once the **operator-UI requirement** surfaced: operators drive sessions directly in the OpenCode UI with no `/trigger`/`runPromptStream`, so authoritative finalization can't serve them — only a passive bus listener can. The original passive design is the right shape; it kept the timerless keep/dismiss error model and the thread-keyed single-bubble map, with the listener owning its connection (D11-rev). The two review findings were resolved by user decision: **C1** by relying on the thread-keyed map (stale `idle` dismisses-and-recreates, flicker accepted) and deleting the `sessionId`-match guard, rather than adding a turn counter; **C2** by operator-confirmed ~0.12% Slack-layer recovery data (keep/dismiss already clears on next part, so no timer is needed).
- **Greenfield posture (AGENTS.md):** the firehose + alias-based target resolution now earn their keep against a concrete second consumer (operator-UI), satisfying "generalize only when a second case exists." Heartbeat/elapsed kept (H3); M3 (multi-history alias resolution) documented as a limitation.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | APPROVED (via /autoplan) | C1/C2 verified; drove design revision |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | APPROVED (via /autoplan) | validated stream-derived design + 2 patches; test cases a-k |
| Outside Voice | `codex` | Independent 2nd opinion | 2 | issues_found | CEO + Eng; converged with Claude subagents |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — (no UI scope) | skipped |
| DX Review | `/plan-devex-review` | Developer experience | 0 | — (no DX scope) | skipped |

- **CODEX:** ran both phases (codex-cli 0.138.0); agreed on C1/C2 and on serving operator-UI via the passive listener.
- **CROSS-MODEL:** full agreement; no unresolved disagreement after the operator-UI requirement settled the architecture.
- **VERDICT:** CEO + ENG CLEARED via /autoplan — stream-derived, timerless passive listener: one bubble per thread dismissed on parent `session.idle` (C1, flicker accepted), timerless keep/dismiss error model (C2, 0.12% operator-confirmed), listener-owned connection (D11-rev), serving `/trigger` + operator-UI uniformly. Approved to implement.

NO UNRESOLVED DECISIONS
