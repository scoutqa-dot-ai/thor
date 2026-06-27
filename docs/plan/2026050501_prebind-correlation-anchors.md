# Pre-bind correlation anchors at gateway enqueue

**Date**: 2026-05-05
**Status**: Implemented
**Depends on**: `docs/plan/2026043001_session-event-log.md` (anchor + alias system)

## Problem

A single Slack mention can produce two OpenCode sessions for the same
anchor, because the gateway dispatches one queue file twice under two
different lock keys.

Root cause: `resolveCorrelationLockKey(correlationKey)` is time-varying.
It returns the raw key (`slack:thread:X`) until a correlation alias exists,
then returns `anchor:Y`. The gateway queue recomputes the lock key on
every scan while its in-flight map is keyed by the previous value:

- `packages/gateway/src/queue.ts`: `processing` is keyed by lock key.
- `packages/gateway/src/queue.ts`: `scan()` calls
  `resolveCorrelationLockKey(event.correlationKey)` every time it reads a
  queue file.

If the runner writes `slack.thread_id -> anchor` while the first handler is
still in flight, the next scan sees a different lock key for the same file.
`processing.has("anchor:Y")` is false even though
`processing.has("slack:thread:X")` is true, so the same event dispatches
twice. The duplicate runner call can find the anchor before
`opencode.session -> anchor` exists, creating a parallel OpenCode session.

The same raw-key-to-anchor transition can affect direct runner `/trigger`
callers that provide a known-prefix correlation key and bypass the gateway.
That path must either be pre-bound too or explicitly remain out of scope.
This plan closes the direct no-session `/trigger` race by using the same
helper before the runner computes its correlation lock key.

## Decisions

- **Fix shape**: Pre-bind known-prefix correlation keys before they enter
  lock-key based dispatch. This removes the raw-key-to-anchor transition for
  gateway files and direct no-session runner triggers.
- **Helper location**: Add `ensureAnchorForCorrelationKey(correlationKey)` in
  `@thor/common` (`correlation.ts`). Gateway and runner already depend on
  common correlation helpers.
- **Helper result**: Return `{ anchorId: string; minted: boolean }` for
  supported keys, or
  `{ anchorId: undefined; minted: false; reason: "unsupported_prefix" }` for
  unsupported keys, so callers can log the bound anchor without parsing
  aliases again.
- **Concurrency model**: Process-local promise chain keyed by raw correlation
  key, using `Map<string, Promise<unknown>>` (a generic `withKeyLock` helper)
  rather than `Map<string, Promise<EnsureAnchorResult>>`, because the stored
  settled promise resolves to `undefined`.
- **Cross-process behavior**: No cross-process atomicity in this patch. The
  production gateway is single-process today. If the gateway is horizontally
  scaled later, add a file lock around `aliases.jsonl` or a shared keyed lock.
  Cross-process double-mint is not idempotent; newest-wins aliases make it
  recoverable but transiently divergent.
- **Unsupported prefixes**: No-op. Unknown keys keep the raw lock key, which is
  stable because no alias is derivable or written by these helpers.
- **Gateway integration**: `EventQueue.enqueue` becomes async and awaits
  `ensureAnchorForCorrelationKey` before writing the queue file. All production
  and test call sites must await it.
- **Runner integration**: For `/trigger` requests with `correlationKey` and no
  explicit `sessionId`, call `ensureAnchorForCorrelationKey(correlationKey)`
  before computing `resolveCorrelationLockKey(correlationKey)`. Keep the
  existing runner mint fallback for unsupported prefixes and defensive recovery.
- **Explicit `sessionId` triggers**: Keep the existing `session:<id>` lock path.
  A request with explicit `sessionId` is already locked by stable session id; it
  may still bind the provided correlation key to that session's anchor after
  resolution. Mixed concurrent direct calls where one request supplies
  `sessionId` and another supplies only a brand-new key are out of scope for
  this bug fix.
- **Cross-source batching**: Pre-binding does not infer that a fresh Slack key
  and a fresh Git branch key belong to the same anchor. Cross-source batching
  remains guaranteed only when both aliases already resolve to the same anchor,
  usually because a running session registered the producer alias. Tests must
  seed that condition explicitly.
- **Orphan anchors**: Acceptable. Dropped or dead-lettered gateway events may
  leave an unused alias. There is no alias janitor today; alias-log rotation or
  GC remains out of scope.

## Design

### Common helper

Add the helper in `packages/common/src/correlation.ts` and export it from
`packages/common/src/index.ts`.

```ts
export type EnsureAnchorResult =
  | { anchorId: string; minted: boolean }
  | { anchorId: undefined; minted: false; reason: "unsupported_prefix" };

export function ensureAnchorForCorrelationKey(key: string): Promise<EnsureAnchorResult>;
```

Implementation shape:

```ts
const anchorEnsureLocks = new Map<string, Promise<unknown>>();

function withKeyLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  settled.finally(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

export function ensureAnchorForCorrelationKey(key: string): Promise<EnsureAnchorResult> {
  if (!aliasForCorrelationKey(key)) {
    return Promise.resolve({
      anchorId: undefined,
      minted: false,
      reason: "unsupported_prefix",
    });
  }

  return withKeyLock(anchorEnsureLocks, key, () => {
    const existing = resolveAnchorForCorrelationKey(key);
    if (existing) return { anchorId: existing, minted: false };

    const anchorId = mintAnchor();
    const result = appendCorrelationAliasForAnchor(anchorId, key);
    if (!result.ok) throw result.error;
    return { anchorId, minted: true };
  });
}
```

Keep `aliasForCorrelationKey` private unless a test or call site has a
real need for it. Do not expose a broad alias parser only for test
convenience.

### Gateway queue

`EventQueue.enqueue` changes from synchronous to async:

```ts
async enqueue(event: QueuedEvent): Promise<void> {
  const bound = await ensureAnchorForCorrelationKey(event.correlationKey);

  // existing tmp file -> atomic rename

  logInfo(log, "event_enqueued", {
    source: event.source,
    correlationKey: event.correlationKey,
    ...(bound.anchorId ? { anchorId: bound.anchorId, anchorMinted: bound.minted } : {}),
  });
}
```

The queue file is written only after the alias is visible in
`aliases.jsonl`, so the first and later scans compute the same lock key.

All seven production `queue.enqueue(...)` call sites in
`packages/gateway/src/app.ts` must become `await queue.enqueue(...)`.
Tests that call `queue.enqueue(...)` directly must also await it. The
change is mechanical, but broad enough that it belongs in the plan.

### Runner direct trigger path

For direct `/trigger` requests that do not provide `sessionId`, pre-bind
before computing the lock key:

```ts
if (!requestedSessionId && correlationKey) {
  await ensureAnchorForCorrelationKey(correlationKey);
}

const lockKey = requestedSessionId
  ? `${SESSION_LOCK_PREFIX}${requestedSessionId}`
  : correlationKey
    ? resolveCorrelationLockKey(correlationKey)
    : undefined;
```

Inside the existing resolution block, keep the current defensive behavior:

- Known-prefix keys should resolve to an anchor because of the pre-bind.
- Unsupported-prefix keys still mint a fresh anchor, and
  `appendCorrelationAliasForAnchor` remains a no-op for them.
- The final `if (correlationKey && resolveAnchorForCorrelationKey(...) !== anchorId)`
  guard stays so direct explicit-session callers keep binding aliases to the
  authoritative session anchor.

Do not remove runner fallback minting in this patch.

## Phases

Each phase should be one commit.

### Phase 1 - Add `ensureAnchorForCorrelationKey`

**Goal:** create a shared resolve-or-mint helper with process-local
serialization for the same raw correlation key.

Files:

- `packages/common/src/correlation.ts`
  - Add `EnsureAnchorResult`.
  - Add `ensureAnchorForCorrelationKey`.
  - Add private `withKeyLock` if it keeps the helper readable.
- `packages/common/src/index.ts`
  - Export `ensureAnchorForCorrelationKey` and `EnsureAnchorResult`.

Tests:

- `packages/common/src/correlation.test.ts`
  - Concurrent calls for the same `slack:thread:` key return the same
    anchor, exactly one result has `minted: true`, and exactly one alias
    record is written for that key.
  - Same behavior for a `git:branch:` key.
  - Unsupported-prefix key returns
    `{ anchorId: undefined, minted: false, reason: "unsupported_prefix" }`
    and writes no alias file or no additional alias line.
  - Existing alias written through `appendCorrelationAliasForAnchor`
    returns that anchor with `minted: false`.

Exit criteria:

- Targeted common tests pass.
- `pnpm typecheck` passes.

### Phase 2 - Pre-bind in `EventQueue.enqueue`

**Goal:** every gateway queue file with a supported correlation key is
written only after its correlation alias exists.

Files:

- `packages/gateway/src/queue.ts`
  - Make `enqueue(event)` async.
  - Await `ensureAnchorForCorrelationKey(event.correlationKey)` before the
    temp-file write.
  - Include `anchorId` and `anchorMinted` in `event_enqueued` logs when a
    supported key is bound.
- `packages/gateway/src/app.ts`
  - Await all seven production `queue.enqueue(...)` calls.
- Gateway tests
  - Await direct enqueue calls in `queue.test.ts`, `app.test.ts`, and
    `cron.test.ts`.

Tests:

- `packages/gateway/src/queue.test.ts`
  - Regression for the observed bug: enqueue one `slack:thread:` event,
    start processing with a handler that remains in flight, then simulate the
    runner's current resolve-or-mint alias write while the file is still on
    disk: if no alias exists, mint an anchor and append the correlation alias;
    if an alias already exists, leave it alone. A second interval scan must
    not dispatch the same file again. The handler should be called once, and
    after the handler acks the file should be deleted once.
  - Cross-source batching: seed a Slack alias and a Git branch alias to the
    same anchor before enqueueing both events. Assert they dispatch in one
    batch under `anchor:<id>` and that pre-binding does not move either alias.
  - Unsupported-prefix key still writes, dispatches, and logs under the raw
    key.
- `packages/gateway/src/app.test.ts`
  - One Slack accepted-path test asserts that
    `resolveAnchorForCorrelationKey(rawSlackKey)` returns an anchor after the
    HTTP handler returns, before the queue is flushed.

Exit criteria:

- The queue regression fails against Phase 1 only and passes after Phase 2.
- Targeted gateway tests pass.
- `pnpm typecheck` passes.

### Phase 3 - Pre-bind direct no-session runner triggers

**Goal:** direct `/trigger` callers with known-prefix correlation keys use a
stable `anchor:<id>` lock before entering runner session resolution.

Files:

- `packages/runner/src/index.ts`
  - Import `ensureAnchorForCorrelationKey`.
  - If `correlationKey` is present and `requestedSessionId` is absent, await
    the helper before computing `lockKey`.
  - Keep the existing defensive mint and final alias bind logic.

Tests:

- `packages/runner/src/trigger.test.ts`
  - Two concurrent direct `/trigger` calls with the same fresh
    `slack:thread:` key create at most one OpenCode session and write one
    correlation alias for the key.
  - Unsupported-prefix direct trigger still succeeds and uses the raw lock
    path.
  - Explicit `sessionId` trigger still binds the correlation key to that
    session's anchor.

Exit criteria:

- Targeted runner tests pass.
- `pnpm typecheck` passes.

### Phase 4 - Integration verification

**Goal:** verify the observed Slack duplicate-session scenario end to end.

Verification:

- Run targeted tests:
  - `pnpm test packages/common/src/correlation.test.ts`
  - `pnpm test packages/gateway/src/queue.test.ts packages/gateway/src/app.test.ts`
  - `pnpm test packages/runner/src/trigger.test.ts`
- Run full local checks if time allows:
  - `pnpm test`
  - `pnpm typecheck`
- Run a local compose smoke against the resume path:
  - `./scripts/test-opencode-e2e.sh`
  - Use the Slack-shaped resume correlation key path as the relevant signal.

Exit criteria:

- A single Slack-shaped trigger produces one `session_created` for the new
  anchor.
- Repeated queue scans while the handler is in flight do not produce a second
  `event_processing` for the same queue file under a different lock key.
- Direct no-session `/trigger` calls for the same known-prefix key serialize
  under the same anchor lock.

## Out of scope

- Cross-process anchor mint atomicity.
- Inferring that unrelated fresh Slack and Git keys belong to the same anchor.
- Alias garbage collection or alias-log rotation.
- Removing `resolveCorrelationLockKey`'s raw-key fallback.
- Removing runner fallback minting.
- Solving mixed concurrent direct calls where one request supplies explicit
  `sessionId` and another supplies only the same brand-new correlation key.

## Decision Log

| Date       | Decision                                                            | Rationale                                                                                                          |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 2026-05-05 | Pre-bind supported correlation keys at gateway enqueue.             | Removes the queue file's raw-key-to-anchor lock transition before the file is visible to scanners.                 |
| 2026-05-05 | Add the helper in `@thor/common`.                                   | Gateway and runner both need the same correlation alias semantics.                                                 |
| 2026-05-05 | Use a process-local key lock with `Promise<unknown>` storage.       | Matches the runner's existing promise-chain pattern while avoiding the result-type mismatch in the original draft. |
| 2026-05-05 | Also pre-bind direct no-session runner triggers.                    | Otherwise the plan would fix the gateway symptom while leaving the described direct `/trigger` race intact.        |
| 2026-05-05 | Keep explicit-session runner behavior unchanged.                    | Explicit `sessionId` already gives a stable lock key and remains the authoritative session binding path.           |
| 2026-05-05 | Seed cross-source batching tests with existing same-anchor aliases. | Pre-binding cannot infer that a new Slack thread and a new Git branch are related.                                 |
