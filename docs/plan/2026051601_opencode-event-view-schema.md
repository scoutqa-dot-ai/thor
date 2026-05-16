# Opencode Event — Compact Oversize Projection

**Date**: 2026-05-16
**Status**: Draft
**Depends on**: `docs/plan/2026043001_session-event-log.md`, `docs/plan/2026051502_runner-viewer-readability.md`

## Goal

Stop discarding useful fields when an `opencode_event` exceeds the 4 KB per-record target. The cap is a soft budget for OpenCode payloads, so an oversized event should keep the small viewer skeleton even if the projected record lands closer to 8 KB.

Today, `capRecord` in `packages/common/src/event-log.ts` replaces the entire `event` of any oversized opencode record with `{ _truncated: true }`. ~25% of records in the live corpus hit this path (`docs/plan/2026051502_runner-viewer-readability.md:36`), erasing fields the viewer needs to thread tool calls and show status. The bytes live in `state.input` / `state.output` / `state.raw` / `state.metadata` / `snapshot`; the skeleton (`event.type`, `part.type`, `part.tool`, `part.callID`, `state.status`, `properties.sessionID`, `properties.time`) is small.

After this change:

- Under-cap records are stored whole.
- Text and reasoning events continue to bypass the cap so assistant prose remains intact.
- Other oversized `opencode_event` records are projected to a fixed viewer skeleton, replacing payload leaves with `{ _omitted: true, bytes: N }` markers and stamping `_truncated: true`.
- Projected OpenCode records may exceed 4 KB up to an 8 KB soft ceiling before falling back to the existing generic truncation envelope.

## Scope

In scope:

- `packages/common/src/opencode-event-view.ts` defines `projectOpencodeEvent` and omitted-marker helpers without a Zod schema.
- `capRecord` uses the projector only after the normal 4 KB check and the text/reasoning carve-out.
- Behavior tests cover under-cap pass-through, text/reasoning bypass, oversized tool projection, future-event skeleton preservation, and the generic fallback for pathological records.

Out of scope:

- Rewriting existing JSONL on disk.
- Removing the generic fallback for non-OpenCode records or pathological projected records.
- Storing omitted blobs off-record.
- Runner viewer changes beyond consuming the already-stored skeleton shape.

## Projection Algorithm

`capRecord` keeps the oversize handling deliberately narrow:

1. If the serialized record is under `MAX_RECORD_BYTES`, write it unchanged.
2. If the record is an OpenCode text or reasoning event, write it unchanged even when it exceeds the target.
3. If the record is another oversized `opencode_event`, write a projected skeleton when the projected record is under `PROJECTED_OPENCODE_RECORD_MAX_BYTES` (8 KB). Otherwise continue to the existing generic truncation envelope.

`projectOpencodeEvent` itself is deterministic:

- Require a top-level `event.type`; return `null` without one.
- Preserve top-level `type` and optional `id`.
- Preserve compact `properties.sessionID`, numeric `properties.time`, compact `properties.status`, compact `properties.error`, and `properties.part`.
- Preserve part `id`, `messageID`, `sessionID`, `type`, `tool`, `callID`, compact `state.status`, `state.title`, `state.time.{start,end,compacted}`, and compact `state.error`.
- Replace any `input`, `output`, `raw`, `metadata`, or `snapshot` on properties, part, or state with `{ _omitted: true, bytes: N }`.
- Drop all non-skeleton vendor or future fields.

## Phases

### Phase 1 — Projection in `@thor/common`

- Add `packages/common/src/opencode-event-view.ts` with `projectOpencodeEvent` and `isOmittedMarker`.
- Wire `projectOpencodeEvent` into `capRecord` ahead of the existing generic fallback.
- Update tests in `packages/common/src/event-log.test.ts` and `packages/common/src/opencode-event-view.test.ts`.

Exit criteria: targeted `@thor/common` tests pass for projection and event-log behavior.

### Phase 2 — Verification

- Run targeted tests for `event-log` and `opencode-event-view`.
- Run workspace typecheck.
- Run full test suite before handoff when time permits.

Exit criteria: local verification passes, with any skipped or blocked checks called out.

## Decision Log

| Decision                                          | Rationale                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid projection only on overflow**            | Keeps under-cap records full-fidelity for debugging while preserving useful viewer context for oversized records.                                                                     |
| **No Zod schema for this projection**             | The writer only needs a compact persistence skeleton, not a full OpenCode SDK/view schema. A deterministic projector is easier to reason about and avoids threshold/retry complexity. |
| **8 KB projected OpenCode ceiling**               | The 4 KB limit is a soft target for OpenCode events. Keeping a skeleton up to 8 KB is more useful than blanking the event.                                                            |
| **Always mark known payload leaves**              | `input`, `output`, `raw`, `metadata`, and `snapshot` are the observed large leaves. Always replacing them avoids size retries and makes the projected shape predictable.              |
| **Drop non-skeleton fields silently**             | The purpose of the projected record is preserving renderer context, not retaining every SDK/vendor field. Under-cap records still keep full fidelity.                                 |
| **Text/reasoning carve-out stays in `capRecord`** | Long assistant prose is user-visible debugging content and should remain whole; projection is for non-text oversized events.                                                          |
| **Allow truncation marker on base records**       | `capRecord` stamps `_truncated: true` before schema validation; the base event-log schema must preserve that marker for projected and generic capped records.                         |

## Risks

- **New SDK fields may be omitted on oversized records.** Under-cap records still preserve them. Oversized future events keep the routing skeleton until the viewer needs additional fields.
- **Projected records can exceed 4 KB.** This is intentional for OpenCode events and bounded by the 8 KB projected ceiling.
- **Existing legacy `{ _truncated: true }` records remain lossy.** This change only improves records written after deployment.
