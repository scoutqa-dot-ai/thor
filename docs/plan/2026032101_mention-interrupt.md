# Mention Interrupt — 2026-03-21-01

> Mentions (`@thor`) should interrupt a running opencode session. Non-mention messages should never interrupt — they wait until the session is idle.

## Context

### Key architecture facts

- **Handler is fire-and-forget.** `triggerRunnerSlack()` is called without `await` in the queue handler — it returns in <1ms. The queue's `active` and `processing` locks only guard the brief enqueue→fire cycle, not the session lifetime.

- **Runner decides whether to abort.** The runner's `/trigger` endpoint checks if the session is busy, aborts it if so, waits for idle, then sends the new prompt. This logic already works in production.

- **Non-mentions check `hasRunnerSession`.** On `origin/main`, non-mention thread replies call `hasRunnerSession(correlationKey)` (HTTP to runner) to decide delay: 3s if session exists, 60s if not.

### How events are enqueued (origin/main)

| Event type                               | Delay                    | How                                       |
| ---------------------------------------- | ------------------------ | ----------------------------------------- |
| `app_mention`                            | 3s (`batchDelay`)        | Always enqueued immediately               |
| `message` (thread reply, session exists) | 3s (`batchDelay`)        | `hasRunnerSession` returns true           |
| `message` (thread reply, no session)     | 60s (`unaddressedDelay`) | `hasRunnerSession` returns false          |
| `message` (new thread, no mention)       | 60s (`unaddressedDelay`) | No `thread_ts` → skips `hasRunnerSession` |

### Queue readyAt calculation (origin/main)

```
latestArrival = max(readyAt - delayMs) across all events in group
shortestDelay = min(delayMs) across all events in group
batchReadyAt  = latestArrival + shortestDelay
```

A 3s event arriving into a group with a pending 60s event pulls the whole batch forward: `latestArrival` = the 3s event's arrival time, `shortestDelay` = 3s.

## Scenarios

### S1: Mention while no session is running

**origin/main:** Mention enqueued with 3s delay. After 3s, queue fires → runner creates session → opencode processes prompt. Works correctly.

**Desired:** Same.

### S2: Mention while session is running (same thread)

**origin/main:** Mention enqueued with 3s delay. Handler is fire-and-forget so locks are already clear. After 3s, queue fires → runner sees busy session → aborts → waits for idle → sends new prompt. Works correctly — abort is exercised.

**Desired:** Same. This already works.

### S3: Non-mention thread reply while session is running (same thread)

**origin/main:** `hasRunnerSession` returns true → enqueued with 3s delay. After 3s, queue fires → runner sees busy session → **aborts the running session** → sends the non-mention as a new prompt. This is wrong — a passive reply in the thread shouldn't abort work in progress.

**Desired:** Non-mention should never abort a running session. It should wait until the session is idle, then be delivered.

### S4: Non-mention thread reply, no session running

**origin/main:** `hasRunnerSession` returns false → enqueued with 60s delay. After 60s, queue fires → runner creates/resumes session → processes prompt. Works correctly — gives time for someone else to handle it.

**Desired:** Same.

### S5: Multiple rapid mentions in same thread

**origin/main:** Each mention enqueued with 3s delay. `batchReadyAt = latestArrival + 3s`, so the batch keeps sliding forward as new mentions arrive. Once 3s pass without a new mention, all fire together. Works correctly — natural debounce.

**Desired:** Same.

### S6: Non-mention pending (60s), then mention arrives (same thread)

**origin/main:** Non-mention has readyAt = T+60s. Mention arrives at T+10s with readyAt = T+13s. Batch calculation: `latestArrival = T+10`, `shortestDelay = 3`, `batchReadyAt = T+13`. Both fire together at T+13s. The mention pulls the non-mention forward.

**Desired:** Same — the mention sweeps up the pending non-mention. The runner will abort the session (if running) because the batch contains a mention.

### S7: Mention fires, session starts, then non-mention arrives in same thread

**origin/main:** Mention fires at T. Session starts. Non-mention arrives at T+5s. `hasRunnerSession` returns true → enqueued with 3s delay (readyAt = T+8s). At T+8s, queue fires → runner aborts the session started by the mention. The non-mention interrupted the mention's session.

**Desired:** Non-mention should not interrupt. It should wait until the running session completes, then fire.

### S8: Mention in thread A while session runs for thread B

**origin/main:** Different correlation keys. Mention for A enqueued with 3s delay. Queue fires independently — different keys don't interfere. Works correctly.

**Desired:** Same.

## Problem summary

**S3 and S7 are broken.** Non-mentions with existing sessions get a 3s delay (via `hasRunnerSession`) and abort the running session at the runner level. The queue can't prevent this because:

1. The handler is fire-and-forget — locks release in <1ms
2. The queue doesn't know whether a session is currently running
3. The runner aborts unconditionally when it sees a busy session

## Design options

### Option A: Fix at the runner

Pass an `interrupt` flag through to the runner's `/trigger` endpoint. When `interrupt=false` and the session is busy, the runner queues/skips instead of aborting.

- Pro: Single point of enforcement — the runner already knows session state
- Pro: No queue changes needed
- Con: Runner needs to decide what to do with non-interrupt events for busy sessions (drop? queue internally? return error?)

### Option B: Fix at the gateway enqueue

Remove the `hasRunnerSession` check. Non-mentions always get 60s delay regardless of session state. Mentions always get 3s delay.

- Pro: Simplest change — delete code
- Pro: No runner changes needed
- Pro: 60s delay means the session is very likely done by the time the non-mention fires
- Con: If the session runs longer than 60s, the non-mention still aborts it
- Con: Non-mention replies in active threads take 60s instead of 3s even when the session is idle

### Option C: Fix at both layers

Remove `hasRunnerSession` (gateway) + pass `interrupt` flag to runner (don't abort for non-interrupts).

- Pro: Defense in depth — even if timing is unlucky, the runner won't abort
- Con: Most changes across two packages

## Chosen: Option C — fix at both layers

### Queue changes

1. **Drop global lock, keep per-key lock only.** The global lock (`if (this.active.size > 0) return`) blocks unrelated keys from dispatching — thread-A's handler prevents thread-B from firing. This is wrong: keys are independent. The per-key lock (`processing.has(key)`) is the correct granularity — it prevents the same conversation from dispatching twice in the same cycle. Remove `active` set entirely.

2. **Revert lock bypass and ref-counted processing map.** With only the per-key lock remaining and fire-and-forget handlers, the lock releases in <1ms. Interrupt bypass adds complexity for no real effect. Restore the simple `Set<string>`.

3. **Simplify readyAt calculation.** Use `max(readyAt)` of all events in the group. A mention arriving into a group with a pending non-mention pulls the batch forward naturally because the mention's readyAt will be earlier.

### Gateway changes

4. **Remove `hasRunnerSession` check.** Non-mentions always get 60s delay. Mentions always get 3s. No HTTP call to the runner at enqueue time.

5. **Pass `interrupt` flag through the handler.** The queue already has the `interrupt` field on events. The handler passes it to `triggerRunnerSlack` which includes it in the POST body to the runner.

### Runner changes

5. **Accept `interrupt` flag on `/trigger`.** Add optional `interrupt` boolean to `TriggerRequestSchema`.

6. **Skip abort when `interrupt=false`.** When the session is busy and `interrupt` is false, return a response indicating the session is busy (`{busy: true}`). The gateway handler checks this and re-enqueues the events back into the queue with their original delay, so they'll be retried on the next scan cycle. Once the session finishes, the events fire and the agent sees all messages that arrived during the session.

7. **Abort when `interrupt=true` (or unset for backwards compat).** Same as today — abort, wait for idle, send prompt.

## Phases

### Phase 1: Simplify queue

- Drop global lock (`active` set), keep per-key lock only (`processing` set)
- Revert ref-counted `Map` back to `Set<string>`
- Revert interrupt lock bypass logic
- Simplify readyAt to `max(readyAt)` of all events in the group
- Keep `interrupt` field on `QueuedEvent` (passed downstream)
- Remove `flush()` dependency on `active` — wait on `processing` keys instead
- Update tests

### Phase 2: Gateway — remove `hasRunnerSession`, pass interrupt to runner

- Remove `hasRunnerSession` from service.ts
- Non-mentions always enqueue with 60s delay, no async lookup
- Mentions enqueue with `interrupt: true`, non-mentions with `interrupt: false`
- `triggerRunnerSlack` accepts and forwards `interrupt` flag to runner
- On `{busy: true}` response, re-enqueue events with `readyAt = now + scanInterval` so they retry on the next cycle
- Update app tests

### Phase 3: Runner — respect interrupt flag

- Add `interrupt` to `TriggerRequestSchema`
- When `interrupt=false` and session is busy → return 200 with `{busy: true}` (no abort)
- When `interrupt=true` or unset → abort as today
- Add runner tests

## Decision Log

| #   | Decision                                             | Rationale                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Handler stays fire-and-forget                        | The runner already handles abort/resume. Making the handler await would hold queue locks for minutes and require a complete redesign.                                                                                                                                                         |
| D2  | Drop global lock, keep per-key only                  | Global lock blocks unrelated keys (thread-A blocks thread-B). Per-key lock is the correct granularity — prevents same conversation from double-dispatching. With fire-and-forget, neither is load-bearing, but per-key is semantically correct and makes interrupt reasoning straightforward. |
| D3  | Option C — fix at both layers                        | Remove `hasRunnerSession` so non-mentions always get 60s delay (likely session is done). Runner also checks interrupt flag so even if timing is unlucky, it won't abort.                                                                                                                      |
| D4  | Re-enqueue non-interrupt events when session is busy | Messages that arrived after the session started haven't been seen by the agent. Runner returns `{busy: true}`, gateway re-enqueues so they fire once the session is idle.                                                                                                                     |
| D5  | `interrupt` defaults to true for backwards compat    | Existing callers (cron, GitHub) don't send the flag. Default to true so they retain current abort-and-resume behavior.                                                                                                                                                                        |
| D6  | Standardize delays: interrupt=3s, non-interrupt=60s  | Consistent across Slack and GitHub. Interrupt events debounce briefly (3s) then fire. Non-interrupt events wait 60s hoping someone else handles it or the session finishes.                                                                                                                   |

## Debounce behavior

Mentions must still debounce: multiple rapid mentions in the same thread should batch together, not each fire independently.

**How it works today (origin/main, S5):** Each mention enqueued with `readyAt = now + 3s`. Queue uses `max(readyAt)` across the batch. As new mentions arrive, the batch's readyAt slides forward. Once 3s pass without a new mention, all fire together.

**After our changes:** Same mechanism. `readyAt = max(readyAt)` of all events in the group. A mention at T+0 sets readyAt=T+3. Another at T+1 sets readyAt=T+4. Scan at T+4 fires both together. No change needed — the sliding window is inherent in `max(readyAt)`.

**Edge case — mention + non-mention:** Non-mention has readyAt=T+60. Mention arrives at T+10 with readyAt=T+13. `max(readyAt)` = T+60 — the non-mention holds the batch back. This is wrong.

**Fix:** When a batch contains interrupt events, use `max(readyAt)` of interrupt events only. Non-interrupt events get swept into the batch but don't delay it. This is already in the current code (`readyAtSource = hasInterrupt ? interruptEntries : entries`). Keep this logic in the simplified queue.

## Testing approach

Mock `Date.now()` for deterministic time control + one test per scenario (S1–S8). No real delays.

Each test:

- Mocks `Date.now()` to a fixed base time
- Sets up `EventQueue` with `disableInterval: true` and a mock handler
- Enqueues events at specific logical times (advancing `Date.now()` between enqueues)
- Calls `flush()` at specific times and asserts batch grouping, firing order, and handler call count
- Verifies non-interrupt events respect readyAt; interrupt events use interrupt-only readyAt

Runner `{busy: true}` re-enqueue tests are in Phase 2/3 (gateway + runner integration).

### Phase 4: GitHub mention detection + standardized delays

- Add `gitUsername` to `GatewayAppConfig` (env: `GIT_USERNAME`)
- GitHub events that mention the git username in comment/review body → `interrupt: true`, 3s delay
- GitHub events without mention → `interrupt: false`, 60s delay (was 60s with no interrupt flag)
- Standardize all delays: interrupt events = 3s, non-interrupt = 60s (Slack already follows this)
- Mention detection: check `@{gitUsername}` in `comment.body`, `review.body`, `pull_request.body`

| Source                             | Interrupt      | Delay |
| ---------------------------------- | -------------- | ----- |
| Slack `app_mention`                | true           | 3s    |
| Slack `message` (thread reply)     | false          | 60s   |
| GitHub with `@gitUsername` in body | true           | 3s    |
| GitHub without mention             | false          | 60s   |
| Cron                               | true (default) | 0s    |

## Out of Scope

- Changing the handler from fire-and-forget to awaited
- Changing debounce timing values (3s mention, 60s non-mention)
- Making the handler awaited (would require full lock redesign)
