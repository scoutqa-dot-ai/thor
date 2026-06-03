# Simplify OpenCode prompt-send path

Collapse the runner's `/trigger` send path so it does the minimum required: optionally abort, send, and uniformly stream NDJSON back. Drop the pre-send status check, the `{busy:true}` re-enqueue contract, and the ad-hoc fire-and-forget JSON shape.

## Goal

For every accepted `/trigger`:

- If `interrupt=true`: call `client.session.abort` (safe no-op on idle sessions per opencode source), then `promptAsync`.
- If `interrupt=false`: just `promptAsync`. No `client.session.status` round-trip.

For the response:

- One uniform NDJSON content type for all successful triggers.
- Always start the body with a `start` event so non-stream callers still receive an "accepted" receipt on the wire.
- `stream=false` ends the response immediately after `start`; `stream=true` continues until `done`.

For the gateway:

- Remove the `{busy:true}` retry branch and stop parsing the runner's success body.

## Scope

**In scope**

- `packages/runner/src/index.ts` `/trigger` handler: delete `session.status()` check, delete the `{busy:true}` response, delete the `interrupt=true` 503 `waitForSessionSettled` path, unify response shape to NDJSON with `start` as the first line.
- `packages/gateway/src/service.ts` `triggerRunnerPrompt`: drop body parse on 2xx, drop the `json.busy` branch, simplify the `TriggerResult` type.
- `packages/gateway/src/app.ts` dispatch handler: drop the `result.busy` branch and `"busy"` outcome from `logTrigger`.
- Tests in `packages/runner` and `packages/gateway` that assert today's busy-retry behavior or the `{accepted,sessionId,resumed}` JSON shape.

**Out of scope**

- Changes to the upstream `@opencode-ai/sdk` or to opencode server behavior. The `Running`-collision race in opencode's `ensureRunning` (work discarded; pickup via the loop's polling, racy at end-of-loop) is acknowledged but not fixed here.
- The gateway-side debounce/batching in `packages/gateway/src/queue.ts`. That is an independent mechanism and stays.
- New `delayMs` field on `TriggerRequestSchema`. Existing gateway debounce already covers the "delay as needed" semantics for current callers; a per-trigger delay can be added later if a caller needs it.
- Slack progress transport, memory injection, child-session forwarding, trigger lifecycle (`startTrigger`/`endTrigger`), and the smoke test contract. These are preserved.
- Exposing `triggerId` on the wire. Stays internal.

Additionally in scope (model-limit simplification, see Phase 5 below):

- Replace the dynamic per-provider model context-limit fetch with a hardcoded constant table.
- Drop the entire cache (`MODEL_CONTEXT_LIMIT_CACHE_TTL_MS`, `cachedModelContextLimits`, `cachedModelContextLimitsPending`), the warm-up call, the OpenCode `provider.list` round-trip, and the test-only cache-reset hook.
- Keep `ProgressContextSchema` and the `emitContextProgressFromMessage` flow; only the source of `limit` changes.

## Current design notes

- Trigger handler today: `packages/runner/src/index.ts:743-1326`.
- Status check + busy branch: `:857-897`. Returns `{busy:true}` for `interrupt=false`, or aborts + `waitForSessionSettled` with 503-on-timeout for `interrupt=true`.
- Success response today: `:1310` writes `{accepted:true, sessionId, resumed}` JSON when `stream=false`; otherwise NDJSON ending with `done`.
- `emit()` (`:989-1026`) gates `res.write()` on the `stream` flag at `:1013`. The `start` event is already constructed at `:1028-1033` but never reaches the wire in fire-and-forget mode.
- Gateway consumer: `packages/gateway/src/service.ts:543-573`. Reads `json.busy`; that is the only field it consumes from the success body. Confirmed by grep — no callsite reads `accepted`, `sessionId`, or `resumed` from the gateway side.
- Dispatch handler busy-log: `packages/gateway/src/app.ts:1154-1161`. The `result.busy` branch returns without calling `ack()`; that is what causes the queue to retain the file for the next scan (`packages/gateway/src/queue.ts:70-74`).
- Verified behavior of opencode (from upstream source at https://github.com/anomalyco/opencode):
  - `Session.cancel` is a safe no-op when the runner is idle (`packages/opencode/src/session/run-state.ts:80-82`).
  - `ensureRunning` does **not** queue `work` on a `Running` collision — the new `work` is discarded and the caller attaches to the in-flight deferred (`packages/opencode/src/effect/runner.ts:120-122`). Pickup of the new user message depends on the loop's `MessageV2.filterCompactedEffect` re-read each iteration; the exit guard at `prompt.ts:1268-1276` uses the iteration's stale snapshot, so a message persisted during the final iteration can be missed.
  - `Shell` and `ShellThenRun` are safe collisions in practice: a fresh `runLoop` runs later and reads the DB, picking up new user messages.
  - The status check on the runner today does not actually prevent the race because the opencode runner state is not held under any lock the runner shares with the gateway — `status()` then `promptAsync()` is TOCTOU.

## Response contract after this change

| `stream` | Status | Content-Type           | Body                                                                  |
| -------- | ------ | ---------------------- | --------------------------------------------------------------------- |
| false    | 200    | `application/x-ndjson` | one line: `start` event, then EOF                                     |
| true     | 200    | `application/x-ndjson` | NDJSON: `start` … (`tool`, `memory`, `delegate`, `context` …) `done` |
| any      | 400    | json                   | rejection reason (Zod parse, directory not allowed)                   |
| any      | 500    | json                   | error (promptAsync error from opencode, uncaught exception)           |

Every 2xx body begins with a `start` event. The `stream` flag controls how long the connection stays open afterward, not the shape.

## Phases

### Phase 1 — Runner: unify the response shape

**Changes**

- Move `res.setHeader("Content-Type", "application/x-ndjson")` and `res.flushHeaders?.()` out of the `if (stream)` guard so they run for every successful trigger.
- In `emit()`, drop the `stream &&` half of the write guard. The remaining `!res.writableEnded` check is sufficient: post-`end()` writes silently no-op in the background task.
- After the existing `start` emission at `:1028-1033`, branch on `stream`:
  - `stream === true`: keep the existing `await backgroundTask; if (!res.writableEnded) res.end();` shape.
  - `stream === false`: replace `res.json({accepted:true,sessionId,resumed})` with `res.end()` and fire-and-forget the background task as today.
- Decide where to emit the `bootstrapMemoryPaths` `memory` events: keep them where they are (`:1035-1037`, before background task) so non-stream callers see them too, or move them into the background task so non-stream bodies are strictly one line. Pick "strictly one line" for cleanliness; document in the decision log.
- Update the schema comment at `:553-559` to describe the new shape.

**Exit criteria**

- Hitting `/trigger` with `stream=false` returns HTTP 200, `Content-Type: application/x-ndjson`, one NDJSON line (`{"type":"start",...}`), then EOF.
- Hitting `/trigger` with `stream=true` is unchanged: NDJSON terminated by `done`.
- Runner unit test asserts both shapes.

### Phase 2 — Runner: remove the status check and busy branch

**Changes**

- In `packages/runner/src/index.ts:857-897`, delete the `client.session.status({})` call and the entire `if (sessionStatus?.type === "busy")` block.
- Replace with: `if (resumed && parsed.data.interrupt === true) { … abort … }`.
- Abort step: `endTrigger` the prior in-flight trigger for this session if any, then `await client.session.abort({path:{id:sessionId}}).catch(/* defensive — abort is documented-safe */);`.
- Delete `waitForSessionSettled`, `ABORT_TIMEOUT`, and the 503 path. `cancel` in opencode's `SynchronizedRef.modify` commits the `Idle` transition before the HTTP `abort` response returns, so an immediately-following `promptAsync` lands in the `Idle` branch.
- Drop `{busy:true}` (`:867`) from the response set.
- If `waitForSessionSettled` has no other callers, delete it. Same for `ABORT_TIMEOUT` if unreferenced after this phase.

**Exit criteria**

- `/trigger` with `interrupt=true` against an idle session sends the prompt without 503 or extra waits.
- `/trigger` with `interrupt=true` against a busy session aborts and sends the prompt; no `waitForSessionSettled`.
- `/trigger` with `interrupt=false` never calls `client.session.status`; it goes straight to `promptAsync`.
- Runner trigger tests cover all three paths.

### Phase 3 — Gateway: drop the `{busy:true}` contract

**Changes**

- `packages/gateway/src/service.ts:543-573` — `triggerRunnerPrompt` becomes:
  - On `!response.ok` 4xx: call `onRejected`, return `{ rejected: true, reason }`.
  - On `!response.ok` 5xx: throw (unchanged; queue handler logs and retains the file).
  - On 2xx: call `onAccepted`, return `{ rejected: false }`. No `await response.json()`, no `Record<string, unknown>` cast.
- Collapse the `TriggerResult` union to `{ rejected: true; reason: string } | { rejected: false }`. Drop the `busy` discriminator. Update the other `return { busy: false, ... }` site at `:761`.
- `packages/gateway/src/app.ts:1154-1161` — replace the three-way branch with:
  ```ts
  const result = await executeBatchDispatchPlan(plan);
  if (result.rejected) logTrigger(plan.logPrefix, "dropped", result.reason);
  else logTrigger(plan.logPrefix, "fired");
  ```
- `logTrigger` outcome union (`app.ts:1067`) drops `"busy"`.
- Tests:
  - `packages/gateway/src/service.test.ts` lines 335, 358, 392 — three cases mocking `{busy:true}` are obsolete. Either delete them or rewrite to assert "2xx always acks." Keep the 5xx-retry assertion.
  - `packages/gateway/src/app.test.ts` lines 511, 3474 — same; assertions that a busy response leaves the queue untouched go. Add a test that a 2xx empty body and a 2xx NDJSON body both ack.

**Exit criteria**

- Gateway never reads the runner's success body.
- Gateway test suite passes with no `{busy:true}` fixtures.
- Queue retry path still works for 5xx and network errors (covered by existing throw-path tests).

### Phase 4 — Replace dynamic model-limit fetching with a hardcoded constant

**Background**

- `packages/runner/src/index.ts:97-111, 855, 901, 1124, 1350-1405` implement a 5-minute TTL cache of per-provider per-model context limits, populated by calling `client.provider.list({})` and reading `model.limit.context` for each provider's models.
- The cache is consumed in exactly one place: `emitContextProgressFromMessage` at `:1414-1441`, which looks up `limits.get("${providerID}/${modelID}")` to compute `usagePercent` for the `context` progress event.
- The warm-up call (`warmModelContextLimits`) is the only reason the trigger handler awaits anything before `promptAsync`. After this phase, that `await` goes away too.
- Only two production models are configured in this repo's opencode agent set:
  - `openai/gpt-5.4` — `docker/opencode/config/agents/build.md` (primary)
  - `openai/gpt-5.5` — `docker/opencode/config/agents/coder.md`, `thinker.md` (subagents)
  - `openai/gpt-5.4-mini` is listed as `small_model` in `docker/opencode/config/opencode.json` but is not used by the named agents.
- The user-stated limit for both `gpt-5.4` and `gpt-5.5` is **1,050,000 tokens**.
- The `provider.list` endpoint has no other caller in the repo (`rg "provider\.list|providers\.list"` returns one hit).

**Changes**

- In `packages/runner/src/index.ts`:
  - Replace lines 97-111 (cache state and `resetModelContextLimitCacheForTests`) with a single module-level constant:
    ```ts
    const MODEL_CONTEXT_LIMITS = new Map<string, number>([
      ["openai/gpt-5.4", 1_050_000],
      ["openai/gpt-5.5", 1_050_000],
    ]);
    ```
  - Delete the `export function resetModelContextLimitCacheForTests` symbol entirely.
  - Delete `resolveModelContextLimits` (`:1354-1371`), `currentModelContextLimits` (`:1373-1378`), and `warmModelContextLimits` (`:1380-1405`).
  - Delete the warm-up call at `:855` (`const warmModelLimits = warmModelContextLimits(...)`) and the `await warmModelLimits` at `:901`. After Phase 2 these are the last awaited side effects between session resolve and `promptAsync`, so removing them tightens the path further.
  - At `:1124`, change `emitContextProgressFromMessage(event, currentModelContextLimits(), emit)` to `emitContextProgressFromMessage(event, MODEL_CONTEXT_LIMITS, emit)`.
  - Keep `contextLimitKey()` (`:1350-1352`) and `emitContextProgressFromMessage()` (`:1414-1441`) unchanged. The "no limit known → skip context event" branch at `:1431` already gives us the right behavior for unknown models (mini, future additions): no `context` event until the constant table is updated.
  - Drop the `model_context_limits_load_failed` and `model_context_limits_warm_failed` log names — both go with `resolveModelContextLimits` and `warmModelContextLimits`.

- In `packages/runner/src/trigger.test.ts`:
  - Remove the `resetModelContextLimitCacheForTests` import and call at `:8, :352`.
  - Remove `providerList`, `onProviderList`, and `providerLists`-counting fixtures from the harness for context-progress tests. The `client.provider.list` mock is no longer exercised by the trigger handler.
  - Rewrite or replace the affected test cases (`:1222, :1261, :1299, :1530, :1554`) so they target `openai/gpt-5.4` / `openai/gpt-5.5` with the constant 1,050,000 limit. Expected math: 126,000 input/output/reasoning tokens against 1,050,000 → `usagePercent: 12`.
  - The "skips context progress when no positive configured model limit is known" case (`:1530`) becomes "skips context progress for models not in the constant table" — change the `modelID` in the fixture to one absent from the table (`gpt-5.4-mini` is a natural fit).
  - The "keys context limits by provider and model to avoid same-model collisions" case (`:1261`) loses its premise (no `anthropic/gpt-5.4` entry in the table) — delete it. The keying logic is still exercised by the lookup at `:1430` and covered by inspection.
  - Any harness option for stubbing `client.provider.list` can be deleted if unused after these test edits.

**Decision: how to extend later**

- Adding a new model (or correcting a limit) is a one-line edit to `MODEL_CONTEXT_LIMITS`. The constant lives next to the agent configs conceptually but stays in code for now because `emitContextProgressFromMessage` runs in-process. A future move to a JSON/YAML config alongside `docker/opencode/config/` is possible but out of scope.
- The agent config files (`docker/opencode/config/agents/build.md`, `coder.md`, `thinker.md`, plus `opencode.json`) are touched only by future model-list changes. When a new model is added to those files, the same PR must add the model to `MODEL_CONTEXT_LIMITS` — call out in `AGENTS.md §6` style discipline (environment-variable discipline applied analogously to model registration).

**Exit criteria**

- No call to `client.provider.list` anywhere in `packages/runner`.
- No `cachedModelContextLimits*` symbols, no `warmModelContextLimits`, no `resolveModelContextLimits`, no `currentModelContextLimits`, no `resetModelContextLimitCacheForTests`.
- `emitContextProgressFromMessage` produces a `context` event with `limit: 1_050_000` for `openai/gpt-5.4` and `openai/gpt-5.5` token updates.
- `emitContextProgressFromMessage` skips the event for any provider/model pair not in the table (e.g. `gpt-5.4-mini`).
- Trigger handler has no `await` between session-resolve and `promptAsync` (other than the new `abort` call when `interrupt=true`).
- Runner trigger tests covering context progress pass without any `provider.list` fixture.

### Phase 5 — Documentation, tests, and integration verification

**Changes**

- Update any docs/comments referencing `{busy:true}` or `{accepted:true,...}` from the runner. The `/trigger` schema comment at `runner/src/index.ts:548-559` is the main one.
- Search for `progress_relay`, `ndjson_parse_skip`, `runner_response_drain_error`, `ABORT_TIMEOUT`, `waitForSessionSettled`, and `session_busy_*` log names. Remove or rename anything that no longer applies.
- Push the branch to GitHub. The opencode E2E workflow (`scripts/test-opencode-e2e.sh`) is the integration gate per AGENTS.md §3 — it exercises `stream:true` and `parse_done`, which is the smoke test for both the NDJSON shape and the resume path. Dispatch manually if not auto-triggered.

**Exit criteria**

- `pnpm --filter @thor/runner typecheck` and runner tests green.
- `pnpm --filter @thor/gateway typecheck` and gateway tests green.
- `pnpm --filter @thor/common typecheck` green (no schema change expected; runs as sanity).
- Opencode E2E workflow green on the push.
- PR open against `main`.

## Decision log

| #   | Decision                                                                                     | Rationale                                                                                                                                                                                                                   | Rejected                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Drop the `client.session.status()` check entirely                                            | The check is TOCTOU: opencode session state can change between status and `promptAsync`. The runner is not the only thing that can transition a session into `Running` (sub-agent `continueIfIdle` and Task tool can too). In practice the check shrinks the lossy window without closing it. | Keep the status check as best-effort. Adds complexity for a guarantee it does not provide.                                                                                                             |
| 2   | Call `abort` unconditionally when `interrupt=true`, with no `waitForSessionSettled`         | Opencode's `Session.cancel` is documented-safe on idle sessions (`run-state.ts:80-82`). The `Running`-case path uses `SynchronizedRef.modify` to commit `Idle` before the cleanup effect runs, so the next `promptAsync` lands in the `Idle` branch of `ensureRunning`. | Keep the wait. The wait was guarding against an event-bus settle that the SynchronizedRef has already committed to.                                                                                    |
| 3   | Drop `{busy:true}` from the runner response and the gateway's retry-on-busy branch           | The retry-on-busy only helps for the `Running` collision; `Shell`/`ShellThenRun` would have picked the message up anyway. For `Running` the opencode loop polls the DB each iteration, so most collisions resolve. The end-of-loop race remains either way. | Keep `{busy:true}` and the disk-resident retry. Adds complexity for a soft safety net that does not close the lossy race.                                                                             |
| 4   | Uniform `application/x-ndjson` response with `start` as the first line for both stream modes | Reuses an existing event type, no schema change. Gives `stream=false` callers an explicit accepted-receipt on the wire instead of an empty body. Stream callers see no change (they already get `start` today).          | Empty body for `stream=false`. Forces callers debugging via curl to infer acceptance from headers alone, and gives the protocol two distinct shapes.                                                   |
| 5   | Emit `bootstrapMemoryPaths` events inside the background task, after `res.end()` for `stream=false` | Keeps the non-stream body strictly one line. Slack/log sinks still receive the memory events because they run inside `emit()` regardless of `res.writableEnded`.                                                             | Emit them before `res.end()` for non-stream. Two or more lines in non-stream bodies; readers would need to handle a variable line count.                                                               |
| 6   | Do not add a `delayMs` field to `TriggerRequestSchema`                                       | Existing gateway debounce in `packages/gateway/src/queue.ts` already implements per-correlation-key delay for the only current caller. A per-trigger delay is a future need without a present user.                        | Add `delayMs` now. YAGNI plus an extra knob to test.                                                                                                                                                   |
| 7   | Preserve trigger lifecycle (`startTrigger`/`endTrigger`) and Slack progress transport unchanged | This is a wire-shape and control-flow simplification, not a behavior change.                                                                                                                                               | Fold lifecycle bookkeeping into the simplification. Increases regression surface for no benefit here.                                                                                                  |
| 8   | Replace dynamic model context-limit fetching with a hardcoded `Map` constant                 | Only one OpenCode endpoint (`provider.list`) is involved, exactly one consumer (`emitContextProgressFromMessage`), and the production model set is small and slow-moving (`gpt-5.4`, `gpt-5.5`). Removes a 5-minute TTL cache, a warm-up `await` on every trigger, a `provider.list` round-trip per cold cache, and a test-only reset hook. | Keep dynamic fetching with a longer TTL; load from a config file. Both keep moving parts; neither matches how rarely the model set actually changes here.                                               |
| 9   | Use `1_050_000` for both `openai/gpt-5.4` and `openai/gpt-5.5`                               | User-supplied value. Matches the deployed limit for both models in this environment.                                                                                                                                       | Per-model distinct numbers. Not warranted today; can be split in the same one-line edit if it changes.                                                                                                 |
| 10  | Skip context progress for models not in the constant table                                   | Preserves the existing "no limit known → no event" branch. New models can be added in one line; until they are, the progress UI stays silent on context rather than rendering a fabricated or zero percentage.             | Default to a fallback limit (e.g. 1M) for unknown models. Hides drift between agent configs and the table; better to fail visibly by absence.                                                         |

## Implementation risks

- **End-of-loop race in opencode `Running`:** a user message persisted during the final iteration of the in-flight `runLoop` may be missed because the exit guard uses the iteration's stale `lastUser`/`lastAssistant` snapshot. After this change the gateway no longer holds events on disk for retry. The race surface is the same as today's (`status()` is racy), but the worst-case recovery is gone. Document in the plan; mitigate later by changing opencode `ensureRunning` to enqueue work on `Running` collisions (mirror the `Shell→ShellThenRun` branch) if observed in production.
- **5xx retry path:** the only remaining queue-retain path is "runner throws" (5xx or network). Confirm the queue handler still leaves files on disk in this case and that the gateway test suite covers it.
- **Test fixtures referencing `{busy:true}`:** five known sites (`service.test.ts:335,358,392`, `app.test.ts:511,3474`). Audit for any others.
- **NDJSON-on-error responses:** 4xx/5xx keep their existing JSON bodies. The content-type mismatch (NDJSON on 200, JSON on error) is acceptable — the gateway only reads `.text()` on non-2xx — but worth noting for any future caller that expects strict uniformity.
- **`startTrigger`/`endTrigger` ordering:** after Phase 2, the abort path calls `endTrigger(prior, "aborted")` synchronously and starts the new trigger on the same fiber. Confirm there is no observable gap where the viewer sees a session with no trigger attached.
- **Model-limit drift:** the constant table can fall out of sync with `docker/opencode/config/agents/*.md` and `docker/opencode/config/opencode.json`. Today this fails silently (no `context` event for unknown models). Add a one-line note to `AGENTS.md` (or to the agent config files themselves) reminding contributors that adding a model entry to opencode configs also requires an entry in `MODEL_CONTEXT_LIMITS`. Not a hard gate; living with silent drift is acceptable because the consequence is only a missing progress event, not an incorrect one.

## Test plan

- `pnpm --filter @thor/runner typecheck` and runner unit tests covering:
  - `stream=false` returns 200 + NDJSON + one `start` line + EOF.
  - `stream=true` returns 200 + NDJSON terminated by `done`.
  - `interrupt=true` against an idle session does not 503 and does not wait.
  - `interrupt=true` against a busy session aborts, sends, and the prior trigger is `endTrigger`d as `aborted`.
  - `interrupt=false` against any state never calls `client.session.status`.
  - 4xx/5xx paths unchanged.
  - `context` progress event emitted with `limit: 1_050_000` for `openai/gpt-5.4` and `openai/gpt-5.5`.
  - `context` progress event suppressed for models absent from the constant (use `openai/gpt-5.4-mini`).
  - No test imports `resetModelContextLimitCacheForTests`; no test fixture stubs `client.provider.list`.
- `pnpm --filter @thor/gateway typecheck` and gateway tests covering:
  - 2xx with empty body and 2xx with NDJSON both call `onAccepted`.
  - 4xx calls `onRejected` with the response text.
  - 5xx throws; the queue handler retains the file.
  - No `{busy:true}` fixtures remain.
- `pnpm --filter @thor/common typecheck` for sanity (no schema change).
- Push branch; let the opencode E2E workflow run end-to-end (`stream:true` + `parse_done` path).
- Open PR against `main` after the workflow goes green.
