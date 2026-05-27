# Slack progress context expansion

## Goal

Expand the Slack progress message so long-running sessions can also show:

- memory files read/written while working
- agent delegations made through OpenCode task/subtask flow
- the existing tool-call count and latest 3 tool groups

## Scope

**In scope**

- Add shared progress event types for memory activity and agent delegation
- Emit bootstrap memory reads, memory-file tool access, and subtask delegations from `runner`
- Render the new context in `slack-mcp` progress updates
- Update relay/test coverage as needed across `common`, `gateway`, `runner`, and `slack-mcp`

**Out of scope**

- Parsing arbitrary bash commands for memory access
- Rich per-agent lifecycle beyond recent delegation summary
- Reworking the 3-tool-call threshold behavior

## Phases

### Phase 1 — Progress message context

**Changes**

- Extend `ProgressEventSchema` with typed `memory` and `delegate` events
- Teach `runner` to emit:
  - bootstrap memory reads for injected memory files
  - memory read/write activity for explicit file tools targeting `/workspace/memory`
  - delegate events from subtask parts
- Update `slack-mcp` progress state/formatting to show tool count, latest 3, memory activity, and delegated agents together in one compact message
- Update tests for schema forwarding and progress rendering

**Exit criteria**

- Progress updates still post only after the existing tool threshold is crossed
- When relevant activity exists, the Slack progress message shows:
  - tool call count
  - latest 3 grouped tools
  - recent memory file read/write context
  - recent delegated agent context
- New event types relay cleanly through `gateway`
- Targeted tests for `slack-mcp` and `gateway` pass

### Phase 2 — Slack formatting follow-up

**Changes**

- Update `slack-mcp` progress rendering only:
  - agent line shows names only (no descriptions)
  - consecutive duplicate agents collapse using the same run semantics as tools
  - memory line shows compact file labels when fewer than 3 distinct recent files
  - memory line switches to action-count summary (`read`, then `write`) at 3+ distinct files
  - ambiguous filename labels stay distinguishable via compact path fallback
- Keep thresholding, update cadence, and tool count semantics unchanged
- Extend `progress-manager.test.ts` coverage for the new formatting rules

**Exit criteria**

- Slack progress agent context renders only agent names with run-based collapsing
- Slack memory context renders:
  - filenames only for <3 distinct files
  - `read xN, write xM` summary for 3+ distinct files
  - distinguishable labels for ambiguous same-name files
- Existing threshold behavior and tool grouping behavior remain unchanged

### Phase 3 — Live tool-start + heartbeat timer

**Changes**

- Extend `ProgressToolSchema` to accept `running` in addition to `completed`/`error`
- In `runner`, dedupe tool progress emissions per `callID` and emit on the first
  `running` transition (parent and forwarded child sessions) so long-running
  tools (e.g. sandbox builds) appear in Slack the moment they start instead of
  on completion. Keep `collectedToolCalls`, memory, approval, and artifact
  collection on `completed` as before
- In `slack-mcp` `ProgressSession`, add a self-rescheduling timer (recursive
  `setTimeout`) that refreshes the elapsed counter even when no events arrive.
  Cadence backs off as the session ages: 10s under 10m, 30s past 10m, 60s past
  60m. Timer is cleared on `finish()`, with a defensive self-clear in
  `onTick()` if it ever fires after finish
- Move `lastUpdateTime = Date.now()` to before the awaited Slack API call in
  `flush()` so a heartbeat tick and a concurrent tool event can't both flush
  in the same turn

**Exit criteria**

- Slack progress shows a tool name as soon as it starts running, not only on
  completion
- For a single tool that runs for several minutes with no other events, the
  elapsed counter in the Slack message keeps refreshing on the cadence above
- No timer outlives its `ProgressSession`
- Existing throttle test (10s window for event-driven flushes) still passes

### Phase 4 — Context-window status

**Changes**

- Extend `ProgressEventSchema` with a typed `context` event carrying the model identity, current token total, context limit, and computed usage percentage. Keep the event separate from `tool` so tool thresholds/counts remain unchanged.
- In `runner`, treat model context limits as a global best-effort process cache keyed by model id, warmed outside the request hot path and reused across triggers. While consuming SSE, handle `message.updated` for assistant messages and emit `context` events from `info.tokens`, `info.providerID`, and `info.modelID` whenever a positive limit is already known in the cache. Emit percentages below 50 too; the gateway owns the render threshold so a later compaction/model change can hide the line again.
- In `gateway` `ProgressSession`, store the latest context status and include a compact progress line only when `usagePercent >= 50`, e.g. `• context: 63% (126k / 200k tokens)`. Do not let context events create a Slack progress message before the existing 3-tool threshold; after the threshold is met, context changes may flush using the same throttled/immediate semantics as memory/delegate updates.
- Thread `context` through progress logging/dispatch without changing final `done` payloads or persisted session viewer behavior.
- Add targeted coverage in `common`, `runner`, and `gateway` for schema validation, runner extraction from `message.updated`, render/no-render threshold behavior, and no tool-threshold side effects.

**Exit criteria**

- Slack progress updates show a context line when the latest known usage is at least 50% and omit/remove it when the latest known usage is below 50% or no limit is available.
- Context events do not increment tool count, do not satisfy the 3-tool threshold, and do not alter final success/error behavior.
- Runner uses OpenCode's provider/model context limits rather than hard-coded limits.
- Existing memory/delegate/tool formatting and heartbeat/throttle behavior remain unchanged.

### Phase 5 — Context progress correctness follow-ups

**Changes**

- Change model-context limit cache keys from `modelID` to `${providerID}/${modelID}` in both load and lookup paths, matching OpenCode UI behavior and preventing same-model collisions across providers.
- Replace context progress token aggregation with a strict extractor for OpenCode's usage shape: `input + output + reasoning + cache.read`. Do not recursively sum nested numeric fields, and do not include `cache.write` unless OpenCode later exposes it as part of the displayed total for this surface.
- Suppress zero-token assistant `message.updated` context emissions in `runner`; OpenCode initializes fresh assistant messages with zeroed token counters, and those lifecycle updates should not erase real context usage.
- Harden `ProgressSession.onContext()` so a non-renderable/bogus zero snapshot cannot replace an already-renderable context line. Preserve the prior renderable context until a trusted non-zero context update changes it; keep future explicit reset/compaction semantics as a separate event/schema decision if needed.
- Add focused coverage for provider/model limit collisions, strict token extraction, zero-token suppression, and progress-manager preservation of a visible context line across bogus zero updates.

**Exit criteria**

- `openai/gpt-5.4` and another provider's `gpt-5.4` can coexist with different limits, and a context event for OpenAI uses the OpenAI denominator.
- Context token totals are derived only from the intended usage fields and cannot be inflated by recursively summing nested metadata.
- A later zero-token assistant `message.updated` does not emit a Slack context update and does not remove an already-rendered context line.
- Existing context visibility threshold behavior remains: context events do not satisfy the tool threshold, and renderable non-zero updates still refresh Slack after threshold using the existing throttle rules.

## Decision log

| #   | Decision                                                                                | Rationale                                                                                          | Rejected                                                                              |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Add distinct `memory` and `delegate` progress events instead of overloading `tool`      | Keeps tool count semantics stable while allowing Slack to render richer context                    | Encoding memory/agent details into tool names                                         |
| 2   | Emit bootstrap memory only for files actually injected                                  | Avoids noisy "none yet" status lines                                                               | Emitting placeholder memory events                                                    |
| 3   | Track recent memory/delegate context separately from latest tools                       | User asked to show them together with, not instead of, tool count/latest 3                         | Replacing latest tool groups with mixed activity history                              |
| 4   | Render delegate descriptions nowhere in Slack progress text                             | Slack follow-up requested names-only to reduce noise                                               | Keeping `agent: description` formatting                                               |
| 5   | Use filename-first memory labels with path fallback for collisions                      | Keeps Slack output compact while preserving clarity for duplicate filenames                        | Always showing full memory paths                                                      |
| 6   | Emit `tool` event on `running` (deduped by `callID`) instead of waiting for `completed` | Long tools were silent for minutes; users want to see what's currently running                     | Adding a separate `tool_start` event type — would fork rendering logic in `slack-mcp` |
| 7   | Use recursive `setTimeout` rather than `setInterval` for the elapsed-timer heartbeat    | Lets the next delay adapt to the session's age and avoids runaway interval if a tick handler hangs | A fixed `setInterval` with branching inside the callback                              |
| 8   | Back off heartbeat cadence (10s → 30s past 10m → 60s past 60m)                          | Avoids burning Slack `chat.update` calls on tiny relative increments for hour-long sessions        | Constant 10s cadence forever                                                          |
| 9   | Add a separate `context` progress event instead of extending `tool`, `memory`, or `done` | Context-window status is live session state, not a tool call or terminal result                    | Encoding context usage into tool names or only appending it to `done`                 |
| 10  | Gate context visibility in the gateway at render time (`>= 50%`)                         | Lets later low-usage updates remove the line after compaction/model changes while preserving relay semantics | Suppressing sub-50 events in `runner`, which could leave stale high-usage Slack text  |
| 11  | Resolve model limits from OpenCode provider/config metadata via a global best-effort model-id cache | Keeps Thor aligned with OpenCode's own context-window source of truth while preserving a simple request path | Maintaining a Thor-owned model limit table or adding per-request / per-directory cache complexity |
| 12  | Render percentage plus token total/limit, but not cost, in Slack progress                | The user-facing risk is context-window saturation; cost already belongs to terminal/session summaries | Copying OpenCode's full footer usage text including cost                              |
| 13  | Key context limits by `${providerID}/${modelID}`                                        | OpenCode can expose the same model id through multiple providers with different limits; provider+model matches the UI source of truth | Model-only keys, which let the last provider win                                     |
| 14  | Use strict context token extraction (`input`, `output`, `reasoning`, `cache.read`)       | Recursive numeric summation double-counts or includes unrelated nested numbers and produced impossible percentages | Summing all numeric descendants under `tokens` or including `cache.write` without UI parity |
| 15  | Drop zero-token assistant context updates at the runner boundary                         | Zeroed assistant messages are a normal OpenCode creation lifecycle signal, not an authoritative context reset | Emitting zeros and relying only on the renderer to recover                            |
| 16  | Preserve a renderable gateway context across bogus zero/non-renderable updates           | Defense in depth keeps Slack stable if a malformed or stale event slips past the runner | Letting every latest context snapshot replace the visible one                         |

## Targeted verification

- `pnpm vitest run packages/common/src/progress-events.test.ts packages/gateway/src/progress-manager.test.ts packages/runner/src/trigger.test.ts`
- `pnpm --filter @thor/common typecheck && pnpm --filter @thor/gateway typecheck && pnpm --filter @thor/runner typecheck`
- Phase 5 should specifically cover: provider/model collision in runner tests, strict extractor totals, zero-token `message.updated` suppression, and gateway preservation of a visible context line across bogus zero/non-renderable updates.
- If the touched tests are not file-scoped or new common tests are added under a different name, run `pnpm test` only if the targeted Vitest invocation is insufficient.
