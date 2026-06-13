# Slack progress at the global event listener

Move Slack progress projection (and the rest of OpenCode event-stream
consumption) out of the per-trigger request lifecycle and into a single global
session processor built on the shared event bus, so progress is a passive
projection of the event stream rather than work woven through `runPromptStream`
and the `/trigger` handler.

## Problem

Today the progress pipeline has three layers, but only one of them is global:

| Layer | Where | Coupled to a request? |
| --- | --- | --- |
| Sink / state machine | `@thor/common` `progress-manager.ts` (`handleProgressEvent` + module-level `activeSessions`) | No — already global, keyed by Slack thread |
| Transport | `runner/src/slack-progress.ts` | No |
| **Producer** | `runner/src/index.ts` `/trigger` (`emit` closure + `progressChain` + target resolution) **and** `runner/src/prompt-stream.ts` `runPromptStream` (`emitToolProgress`, `emitTaskDelegateProgress`, `emitMemoryEventsFromToolPart`, `emitContextProgressFromInfo`, dedup sets, child discovery) | **Yes** |

The sink is already global. The clutter and coupling are entirely in the
**producer**: deriving `ProgressEvent`s from the OpenCode SSE stream is
interleaved with response aggregation, event persistence, the session-error
grace window, and idle auto-resume inside `runPromptStream`, and the `/trigger`
handler carries per-request `emit`/`progressChain`/target boilerplate. Progress
therefore only flows while a trigger is actively consuming its subscription.

Meanwhile the global event bus (`runner/src/event-bus.ts`) already maintains one
SSE connection per OpenCode URL and sees **every** event for **every** session —
it is currently a dumb fan-out to per-session subscriptions and nothing else.

This plan builds on `2026052202_runner-owned-slack-progress.md` (which moved the
sink into `@thor/common` and made the runner own Slack posting) and must respect
`2026060301_runner-idle-auto-resume.md` and
`2026051601_opencode-event-view-schema.md`.

## Goal

A single global **session processor** is the sole consumer of OpenCode
stream-derived state: progress projection (all event types), idle auto-resume,
session-error grace, child-session discovery, and event persistence. The
`/trigger` handler shrinks to: resolve session → acquire send-lock → send prompt
→ register a completion handle → await it (or fire-and-forget) → respond. There
is **one producer** of progress, driven by the bus, with no duplicated state
machines and no projector-vs-stream race.

## Scope

**In scope**

- Add a global session processor that consumes the event bus and owns
  per-session: progress projection → `handleProgressEvent`, `IdleAutoResume`,
  `SessionErrorGrace`, child-session discovery, and `appendSessionEvent`
  persistence.
- Resolve the Slack progress target for any session (parent or delegated child)
  from the session id via `resolveSessionAnchorId` → `reverseLookupAnchor` →
  `slack.thread` external key → correlation key → `ProgressTarget`.
- Introduce a per-prompt **completion handle**: the processor resolves it with
  `{ terminalError, textParts, toolCalls, totalParts }` when that prompt's run
  settles (spanning idle→Continue auto-resume cycles), and resolves the prior
  run as `aborted` when a new interrupting trigger supersedes it.
- Reduce `/trigger` and `runPromptStream` to: session resolution, the existing
  send-lock / busy-gate / abort path, prompt send, await completion handle, and
  HTTP/NDJSON response shaping.
- Keep NDJSON streaming (`stream:true`) and the smoke-test response working off
  the completion handle / processor event feed (no Slack coupling on that path).
- Preserve all current Slack behavior: 3-tool threshold, 10s throttling, elapsed
  heartbeat ticker, tool/memory/delegate/context formatting, prior-progress
  cleanup, done update, error visibility, abort-as-completed, supersede on a new
  `start`, and Slack API error containment.

**Out of scope**

- Changing the Slack message format or `ProgressSession` rendering.
- Gateway trigger sources (slack/github/cron/approval) — upstream of the runner,
  unaffected.
- Progress for non-current Slack aliases, approval-outcome metadata, or
  arbitrary historical correlation lookups (unchanged from prior plan).
- Bootstrap-memory progress reads as a permanent feature — see Decision D5.
- A general multi-platform progress framework.

## Why single-consumer (and not the alternatives)

Three shapes were considered. This is greenfield: no users, no deploy, no
backward-compatibility constraint, so migration-safety scaffolding (phasing for
green-between-steps, before/after parity tests) is unnecessary — the E2E is the
gate.

1. **Two producers (terminal-handoff).** Bus projector owns in-progress events;
   `runPromptStream` still owns `done`/`error`. Rejected: the "two producers"
   boundary is permanent overhead, and it only exists because `runPromptStream`
   stays a second stream consumer.
2. **Bus projector races the stream.** Projector independently derives
   `done`/`error` while `runPromptStream` still runs auto-resume. Rejected: it
   duplicates `IdleAutoResume`/`SessionErrorGrace` and races the "Continue" send
   (a `session.idle` is *not* reliably terminal).
3. **Single consumer (chosen).** There is exactly one consumer of the stream, so
   auto-resume and progress live in the same place — the race and the
   duplication both disappear by construction.

Feasibility was verified directly (see Decision D1/D2): the send-lock /
busy-gate / abort / auto-resume logic is already **process-global and
session-keyed**, not request-scoped, so it can move without inventing
per-request state. The only genuinely request-scoped things are the HTTP
response concerns (`subscription` handle, `emit` closure, `textParts`/
`toolCalls` accumulation, `terminalError`) — all reconnected via the completion
handle.

## Proposed architecture

```
OpenCode SSE ─► GlobalEventBus reader loop ─► SessionProcessor (global, one per OpenCode URL)
                                                 per session:
                                                   ├─ progress projection ──► handleProgressEvent(target, evt, slackTransport)
                                                   │     target via resolveSessionAnchorId → reverseLookupAnchor → slack.thread
                                                   ├─ IdleAutoResume         (sends "Continue" under sendLock)
                                                   ├─ SessionErrorGrace
                                                   ├─ child-session discovery (subscribe child ids, opencode.subsession alias)
                                                   ├─ appendSessionEvent persistence
                                                   └─ completion handle ─────► resolves awaiting /trigger with {terminalError, textParts, toolCalls}

/trigger: resolve session → withKeyLock(sendKey){ busy-gate / abort / promptAsync } → register completion handle → await (stream) or fire-and-forget → respond
```

### Slack target resolution (works for child sessions)

Given any session id seen on the stream:
`resolveSessionAnchorId(sessionId)` resolves both `opencode.session` and
`opencode.subsession` aliases → anchor; `reverseLookupAnchor(anchorId)
.externalKeys` yields the `slack.thread` alias → reconstruct correlation key →
`ProgressTarget<SlackProgressTransportTarget>`. Child sessions share the parent
anchor, so delegated tool activity resolves to the same thread automatically.

### What `/trigger` keeps — and why none of it is progress

Progress is fully abstracted into the listener: `/trigger` has **zero** progress
code after this (no `emit`, `progressChain`, target resolution, or Slack calls).
The listener picks up progress autonomously from the SSE stream + alias
resolution. What `/trigger` retains is three non-progress responsibilities:

1. **Identity binding** — it writes the session↔correlation alias during session
   resolution (`bindSessionToAnchor`, already present). This is what *enables*
   the listener to resolve a Slack target; it is not progress.
2. **Run-start signal** — it calls `processor.startExternalRun(...)` so the
   processor knows a new external run began and must reset (see *Run-lifecycle
   state & reset* for why this signal is irreducible). Run-lifecycle, not progress.
3. **Send outcome** — `startExternalRun` returns the immediate
   **accept / busy / abort-timeout** result from under the send-lock, so the
   gateway knows whether to re-enqueue. Send result, not progress.

Crucially, on the normal Slack path `/trigger` does **not** await the run result
— per `2026052202` it returns quick JSON once the prompt is accepted, and the
agent posts its own final answer via the Slack tool. The completion handle
(`{terminalError, textParts, toolCalls}`) is awaited **only when `stream:true`**
(smoke test / debug), because that HTTP response must carry the run's terminal
text and request/response can't be served by a fire-and-forget listener. So
steady-state `/trigger` reduces to: resolve session → send under lock → return
accepted/busy.

### Completion handle / supersede

The processor keeps per-session **run state** (see *Run-lifecycle state* below)
and a pending completion promise for the awaiting trigger. A new interrupting
trigger for the same session: resolves the prior run's handle `aborted`
(replacing today's `findInflightTriggerForSession` + `endTrigger(..., "aborted")`),
then drives the abort + new prompt under the unchanged send-lock. This preserves
the supersede-on-`start` behavior the Slack sink already expects. The handle
resolves on exactly the conditions in *Terminal detection* — nothing else.

## Terminal detection (handle resolution)

The completion handle is the re-coupling point and the place premature or hung
resolution hides, so the rule is mechanical, not aspirational. It is a **direct
port of the current `runPromptStream` break/continue conditions** — single-
consumer makes this safe because auto-resume lives in the same place, so handle
resolution is *gated on the auto-resume decision outcome* rather than guessing.

For a session's active run, the handle resolves **only** at:

- **T1 — idle-terminal.** A parent `session.idle` where the run is **not stale**
  and auto-resume did **not** successfully send a `Continue`. Concretely, mirror
  the existing order:
  1. `failed = autoResume.isFailedAssistantIdle()`, `resumeId = autoResume.decideResume()`.
  2. If `!sawParentMessagePart && !failed` → **stale idle, ignore** (handle stays
     pending; this is the OpenCode "idle before any part" flake).
  3. If `resumeId` → `markResumed`, `errorGrace.clear()`, send `Continue` under
     the send-lock with the live-busy re-check. If the send **succeeded** →
     handle stays pending (same run continues). If it **errored or was
     skipped-busy** → fall through to resolve.
  4. Resolve with `terminalError = errorGrace.error ?? (failed ? ASSISTANT_EMPTY_ERROR_OUTPUT : undefined)`.
- **T2 — grace expiry.** A held `session.error` whose grace window elapses with
  no recovery → resolve with the held error. See the grace mechanic below.
- **T3 — supersede/abort.** A new interrupting external prompt (or an abort that
  settles) → resolve `aborted`. For Slack this renders as completed via the
  sink's existing abort-as-completed; for the handle it is a distinct `aborted`
  outcome so the superseded `/trigger` can respond accordingly.

The handle **stays pending** (never resolves) for: stale idle, a successful
auto-resume `Continue`, a `session.error` still inside its grace window, and a
recovery part that clears the grace.

**Grace window becomes a timer, not an iterator timeout.** Today the window is
implemented by awaiting the per-run iterator with `nextWithTimeout(remainingMs)`.
A single consumer reads one shared stream across all sessions and cannot block it
per-session, so reimplement grace as **per-session state + a timer**: on parent
`session.error`, `errorGrace.record(msg, seq)` and arm a timer for `remainingMs`;
a later parent part with higher `seq` calls `clearIfRecovered(seq)` and cancels
the timer (recovered, stays pending); if the timer fires while still pending,
resolve via T2.

**No per-run "stream end" terminal; add a watchdog instead.** In
`runPromptStream` a closed subscription (`next.done`) was a terminal path. The
processor's bus subscription is long-lived and auto-reconnects, so a transient
disconnect must **not** end a run — this is strictly more robust. The cost: a run
whose session never emits `idle`/`error` would leave the handle pending forever.
Add a per-run **max-duration watchdog** that resolves the handle with a terminal
error if no terminal event arrives within a bound; this replaces the implicit
"stream ended" backstop. (Pick the bound in Phase 2; it must exceed the longest
legitimate run including auto-resume cycles.)

## Run-lifecycle state & reset

In `runPromptStream` the run boundary was function scope, so reset was free. The
processor now holds run state for many sessions at once, so every field must be
classified and the reset point must be exact. The leak hides in resetting on the
wrong event.

**Per-run state** (created fresh for each *new external prompt*, dropped/replaced
at the next one):

- accumulation: `collectedTextParts`, `collectedToolCalls`, `seq`/`totalParts`,
  `promptStart` (for `durationMs`).
- terminal machines: `IdleAutoResume` (re-armed; resets `MAX_RESUMES` count and
  `resumedFailedMessageIds`), `SessionErrorGrace` (+ its pending timer cleared).
- dedup/role tracking: `emittedToolStarts`, `emittedTaskDelegates`,
  `parentMessageRoles`, `pendingNonEmptyTextMessageIds`, `sawParentMessagePart`.
- relationships: `childSessionIds` for this run (child→parent association).
- the **completion handle** promise for the awaiting trigger.

**Per-session, persists across runs:** the resolved Slack `ProgressTarget` (cheap
to re-resolve), and whatever the bus needs to keep routing the session.

**Process-global, never per-run:** `correlationKeyLocks` (the send-lock map), the
Slack transport, the `handleProgressEvent` `activeSessions` registry (already
global, keyed by thread).

**The reset rule — the critical distinction:**

- A **new external prompt** (from `/trigger`) = **new run** → full reset of all
  per-run state above. Sequence under the send-lock: (1) if a prior run's handle
  is pending, resolve it `aborted` (supersede); (2) clear the prior run's grace
  timer and watchdog; (3) install fresh per-run state; (4) send the prompt.
- An **auto-resume `Continue`** (internal) = **same run** → **no reset.** It keeps
  the `MAX_RESUMES` counter, dedup sets, and accumulation.

Getting this backwards is the leak: resetting on `Continue` makes `MAX_RESUMES`
unreachable (infinite resumes); failing to reset on a new external prompt leaks
dedup sets, counters, and stale `childSessionIds` from the prior run into the new
one. Because both paths send a prompt under the same lock, the reset must key on
**prompt origin (external vs auto-resume)**, not merely "a prompt was sent."

**How origin is known — two entry points, not stream inference.** Origin is *not*
recovered from OpenCode events: an external prompt and an auto-resume `Continue`
both produce a `user`-role message, and the only content difference is the literal
`"Continue"` (fragile — a user can type it). Instead the processor is the
initiator of both sends, so origin is a property of the call site:

- **External** — `/trigger` (in-process) is the only caller of
  `processor.startExternalRun(sessionId, parts, …)`, which performs the reset
  sequence above under the send-lock, then sends.
- **Auto-resume** — the processor's own idle handler calls an internal
  `sendContinue()` that does not reset.

There is nothing to classify after the fact. The runner is the sole driver of
sessions via `/trigger`, so any send that bypasses `startExternalRun` is a bug to
prevent, not a case to detect; and a process restart simply finds no prior handle
and starts fresh.

## Phases

One PR; phases are review/checkpoint boundaries, not ship gates.

- **Phase 1 — SessionProcessor skeleton + target resolver.** Stand up the global
  processor consuming the bus; implement `sessionId → ProgressTarget` resolution
  and feed progress projection (start/tool/memory/delegate/context) to
  `handleProgressEvent`. Move the four `emit*` derivation helpers + dedup state
  out of `runPromptStream` into the processor.
  *Exit:* in-progress Slack updates post from the processor for a real session,
  including delegated child tool activity, with no Slack wiring in `/trigger`.

- **Phase 2 — terminal + auto-resume + grace + completion handle.** Move
  `IdleAutoResume`, `SessionErrorGrace`, child discovery, and persistence into
  the processor. Implement terminal detection (T1–T3 + watchdog), the
  grace-as-timer, the completion handle, supersede-on-interrupt, and the
  origin-keyed run reset — per *Terminal detection* and *Run-lifecycle state &
  reset*. `/trigger` and `runPromptStream` collapse to session-resolution + send
  + await-handle + response shaping; the `emit`/`progressChain`/target
  boilerplate is deleted.
  *Exit:* ✅/❌ render correctly including abort-as-completed and auto-resume
  (no premature finish, no double-send); HTTP/NDJSON/smoke-test responses
  unchanged; unit tests cover (a) supersede resolving the prior handle `aborted`,
  (b) an idle→Continue→idle run resolving only on the final idle, (c) grace-timer
  expiry vs. recovery, and (d) reset on a new external prompt clearing dedup sets
  and the `MAX_RESUMES` counter while `Continue` does not.

- **Phase 3 — integration verify.** Push to trigger the Slack/OpenCode E2E
  workflow; exercise mention → reply → delegated-task → completion, plus an
  interrupt mid-run and an induced session.error within the grace window.
  *Exit:* green E2E; progress posts, updates, finishes, and cleans up.

## Decision log

| ID | Decision | Rationale |
| --- | --- | --- |
| D1 | Single global consumer owns all stream-derived state | Auto-resume and progress in one place removes the projector-vs-stream race and `IdleAutoResume`/`SessionErrorGrace` duplication by construction. |
| D2 | Move auto-resume/grace as-is; do not refactor the send-lock | Verified the send-lock is `withKeyLock(correlationKeyLocks, "session:"+sessionId, fn)` — process-global and session-keyed already; the "Continue" send reads only live OpenCode status, no request scope. The lock semantics are unchanged. |
| D3 | Per-prompt completion handle reconnects the processor to the awaiting `/trigger` | The only request-scoped need is returning `{terminalError, textParts, toolCalls}` for HTTP/NDJSON/smoke-test; a per-session pending promise + supersede replaces `inflightTriggers`/`endTrigger` semantics. |
| D4 | No phasing-for-green or before/after parity tests | Greenfield, no deploy to protect; E2E is the gate. Assert desired behavior, not equivalence to today. |
| D5 | Bootstrap-memory reads (`index.ts` synthesized `memory read` events) are not OpenCode stream events | Decide during Phase 1: resurface by feeding synthetic events into the processor at prompt-send, or drop from Slack. Default: drop unless it visibly degrades the first update. Record the call here when made. |
| D6 | Slack target resolved only from the session's current `slack.thread` alias | Matches prior plan's scope; no historical/approval/cron/GitHub progress. |
| D7 | Terminal detection is a direct port of the `runPromptStream` break/continue conditions; the handle resolves gated on the auto-resume outcome, never by re-guessing | Single-consumer puts auto-resume and handle resolution in one place, so "did we send a Continue?" is a known fact, not a race. See *Terminal detection*. |
| D8 | Grace window reimplemented as per-session state + timer (not an iterator timeout); transient bus disconnect is non-terminal; a per-run watchdog replaces the old "stream end" backstop | One shared stream can't be blocked per-session; the bus reconnects, so disconnects must not end runs; the watchdog prevents a hung handle. |
| D9 | A **new external prompt** fully resets per-run state; an **auto-resume `Continue`** does not | Reset must key on prompt origin, not "a prompt was sent" — the two failure modes are infinite resumes vs. cross-run state leaks. See *Run-lifecycle state & reset*. |

## Risks / open questions

- **Run lifecycle reset** — *specified* in *Run-lifecycle state & reset*. Residual
  risk is implementation fidelity: the reset must key on prompt origin (external
  vs auto-resume), and the field list there is the checklist.
- **Completion-handle / terminal correctness** — *specified* in *Terminal
  detection*. Residual risk: the grace-as-timer and watchdog are new mechanics
  (the old code used iterator timeouts and stream-end), so they need direct unit
  tests, not just the ported idle/resume logic.
- **Watchdog bound.** Open: pick a max-run duration that exceeds the longest
  legitimate run (including all auto-resume cycles) without leaving a genuinely
  hung run pending too long. Decide in Phase 2.
- **Subscription model change.** The bus today hands out per-trigger
  `SessionSubscription`s; the processor becomes a long-lived subscriber for all
  sessions. Confirm the reconnect/`onEmpty`/`activeSubscriptions` accounting
  still behaves with one persistent consumer plus transient abort-wait
  subscriptions.
- **Transport injection.** The Slack transport must be constructed once and
  injected at processor/bus construction, not per request.

## Exit criteria (overall)

- No Slack-progress producer code remains in `/trigger`; `runPromptStream` no
  longer derives or emits progress.
- All Slack behaviors from the prior plan preserved (threshold, throttle,
  heartbeat, formatting, cleanup, done, error visibility, abort-as-completed,
  supersede).
- HTTP/NDJSON/smoke-test responses unchanged.
- Auto-resume and grace behave identically (covered by unit tests + E2E).
- Slack/OpenCode E2E workflow green on push.
