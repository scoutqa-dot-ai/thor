# Opencode Event — Shared View Schema + Hybrid Preservation

**Date**: 2026-05-16
**Status**: Draft
**Depends on**: `docs/plan/2026043001_session-event-log.md`, `docs/plan/2026051502_runner-viewer-readability.md`

## Goal

Stop discarding useful fields when an `opencode_event` exceeds the 4 KB per-record cap, and unify the writer's preservation logic with the viewer's render contract behind a single zod schema.

Today, `capRecord` in `packages/common/src/event-log.ts` replaces the entire `event` of any oversized opencode record with `{ _truncated: true }`. ~25% of records in the live corpus hit this path (`docs/plan/2026051502_runner-viewer-readability.md:36`), erasing fields the viewer needs to thread tool calls and show status — even though those fields are tiny. The bytes live in `state.input` / `state.output` / `state.raw` / `state.metadata` / `snapshot`; the skeleton (`event.type`, `part.type`, `part.tool`, `part.callID`, `state.status`, `properties.sessionID`, `properties.time`) is hundreds of bytes at most.

After this change:

- Under-cap records (75% today) are stored whole — full debugging fidelity preserved.
- Over-cap records are projected through a zod schema that keeps the render skeleton and replaces large leaves with `{ _omitted: true, bytes: N }` markers, then stamped `_truncated: true`.
- Records that fail the known-event schema (unknown SDK shape) route to a compact fallback projection that preserves event type, session/time, part/tool/state skeleton, and omitted markers for large leaves.
- The same schema is imported by the runner viewer to render events; `safeParse` + an unknown-event fallback renderer absorbs both legacy records on disk and future SDK additions.

## Scope

In scope:

- New module `packages/common/src/opencode-event-view.ts` (or section of `event-log.ts`) defining `OpencodeEventViewSchema` and `projectOpencodeEvent`.
- Hybrid `capRecord` for `opencode_event`: try schema projection on overflow; fall back to generic truncation on parse failure.
- Runner viewer (`packages/runner/src/index.ts`) consumes the schema via `safeParse`; unknown-event fallback renderer for legacy records and parse failures.
- Behavior tests for: under-cap pass-through, over-cap projection (skeleton preserved + omitted markers), parse-failure fallback, text/reasoning unbounded carve-out remains intact.

Out of scope (parking for later plans):

- Rewriting existing JSONL on disk. Old `{ _truncated: true }` carcasses render via the unknown-event fallback indefinitely.
- Raising or removing `MAX_RECORD_BYTES` — orthogonal policy decision.
- Storing omitted blobs off-record (S3 / sidecar files). Marker only.
- Admin views or other consumers beyond runner. They keep treating `event` as `unknown` for now; they can adopt the schema later.

## Data findings driving the schema

From `docker-volumes/workspace/worklog/sessions/*.jsonl`:

**`event.type` values observed:** `message.part.updated`, `session.status`, `session.idle`, `session.error`.

**Status values inside `session.status` (`properties.status.type`):** `busy`, `idle`.

**`part.type` values observed:** `text`, `reasoning`, `tool`, `step-start`, `step-finish`, `snapshot` (in file change events: `add`, `update`, `delete`, `move`).

**Tool `state.status` lifecycle:** `pending` → `running` → `completed` | `error`.

The schema must enumerate these with permissive fallbacks (see Decision Log: enum strictness).

## Schema shape (proposed)

```ts
// packages/common/src/opencode-event-view.ts
import { z } from "zod/v4";

const PartCommon = {
  id: z.string().optional(),
  messageID: z.string().optional(),
  sessionID: z.string().optional(),
};

// Text and reasoning keep their full content. The capRecord carve-out
// (isTextOrReasoningOpencodeEvent) already protects these from truncation;
// the schema mirrors that contract.
const TextPart = z.object({
  ...PartCommon,
  type: z.literal("text"),
  text: z.string(),
});

const ReasoningPart = z.object({
  ...PartCommon,
  type: z.literal("reasoning"),
  text: z.string(),
});

// Tool parts: keep skeleton; mark large leaves as omitted with byte count.
// Projection replaces input/output/raw/metadata with { _omitted: true, bytes }
// when oversized; un-truncated records pass through with raw values.
const OmittedMarker = z.object({ _omitted: z.literal(true), bytes: z.number() });
const Omittable = z.union([OmittedMarker, z.unknown()]);

const ToolState = z.object({
  status: z.string(), // permissive: pending/running/completed/error + future
  title: z.string().optional(),
  input: Omittable.optional(),
  output: Omittable.optional(),
  raw: Omittable.optional(),
  metadata: Omittable.optional(),
  error: z.string().optional(),
  time: z.object({ start: z.number().optional(), end: z.number().optional() }).optional(),
});

const ToolPart = z.object({
  ...PartCommon,
  type: z.literal("tool"),
  tool: z.string(),
  callID: z.string().optional(),
  state: ToolState,
});

const StepStartPart = z.object({ ...PartCommon, type: z.literal("step-start") });
const StepFinishPart = z.object({
  ...PartCommon,
  type: z.literal("step-finish"),
  cost: z.number().optional(),
  tokens: z.unknown().optional(),
});

const SnapshotPart = z.object({
  ...PartCommon,
  type: z.literal("snapshot"),
  snapshot: Omittable.optional(),
});

// Discriminated union — but with a passthrough escape hatch for unknown part
// types (see Decision Log: forward-compat).
const KnownPart = z.discriminatedUnion("type", [
  TextPart,
  ReasoningPart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
]);
const UnknownPart = z.object({ type: z.string() }).passthrough();
const Part = z.union([KnownPart, UnknownPart]);

const MessagePartUpdated = z.object({
  type: z.literal("message.part.updated"),
  properties: z.object({
    sessionID: z.string().optional(),
    time: z.number().optional(),
    part: Part,
  }),
});

const SessionStatus = z.object({
  type: z.literal("session.status"),
  properties: z.object({
    sessionID: z.string().optional(),
    status: z.object({ type: z.string() }).passthrough(),
  }),
});

const SessionIdle = z.object({
  type: z.literal("session.idle"),
  properties: z.object({ sessionID: z.string().optional() }).passthrough(),
});

const SessionError = z.object({
  type: z.literal("session.error"),
  properties: z
    .object({
      sessionID: z.string().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
});

export const OpencodeEventViewSchema = z.union([
  MessagePartUpdated,
  SessionStatus,
  SessionIdle,
  SessionError,
]);

export type OpencodeEventView = z.infer<typeof OpencodeEventViewSchema>;
```

## Projection function

```ts
const OMIT_THRESHOLD = 256; // bytes — fields larger than this become markers

type ProjectedOpencodeEvent = OpencodeEventView | UnknownOpencodeEventView;

export function projectOpencodeEvent(event: unknown): ProjectedOpencodeEvent | null {
  const projected = shrinkLargeLeaves(event);
  const parsed = OpencodeEventViewSchema.safeParse(projected);
  return parsed.success ? parsed.data : projectUnknownOpencodeEvent(projected);
}

function shrinkLargeLeaves(value: unknown): unknown {
  // Recursively walk; for keys input/output/raw/metadata/snapshot,
  // replace with { _omitted: true, bytes: N } when over OMIT_THRESHOLD.
  // text/reasoning string content is never touched.
}
```

Hybrid integration in `capRecord`:

```ts
if (record.type === "opencode_event" && record.event !== undefined) {
  const projected = projectOpencodeEvent(record.event);
  if (projected !== null) {
    return { ...record, event: projected, _truncated: true } as T;
  }
  // fall through to generic { event: { _truncated: true } } fallback only
  // when no usable event.type exists or the fallback skeleton remains too large
}
```

## Viewer usage

```ts
// packages/runner/src/index.ts
import { OpencodeEventViewSchema, type OpencodeEventView } from "@thor/common";

function renderOpencodeEvent(event: unknown): string {
  const parsed = OpencodeEventViewSchema.safeParse(event);
  if (!parsed.success) return renderUnknownEvent(event);
  return renderKnownEvent(parsed.data);
}

function renderUnknownEvent(event: unknown): string {
  // Legacy { _truncated: true } records, fallback-projected future SDK shapes,
  // and under-cap future SDK shapes land here.
  // Show a compact row with event type, session/part/tool/status skeleton,
  // and omitted-marker notes where present.
}

function renderKnownEvent(event: OpencodeEventView): string {
  switch (event.type) {
    case "message.part.updated":
      return renderPart(event.properties.part);
    case "session.status":
      return renderStatus(event.properties.status);
    case "session.idle":
      return renderIdle();
    case "session.error":
      return renderError(event.properties.error);
  }
}
```

Renderer branches handle `{ _omitted: true, bytes }` markers explicitly: e.g. tool output row shows `(output omitted, 38 KB)` instead of the body.

## Phases

### Phase 1 — Schema + projection in `@thor/common`

- Add `packages/common/src/opencode-event-view.ts` with `OpencodeEventViewSchema`, `projectOpencodeEvent`, `shrinkLargeLeaves`.
- Wire `projectOpencodeEvent` into `capRecord` ahead of the existing generic-truncate fallback.
- Tests in `packages/common/src/event-log.test.ts`:
  - Under-cap opencode record: unchanged.
  - Text/reasoning carve-out: still bypasses cap unconditionally.
  - Oversized `message.part.updated` with `tool` part: skeleton preserved, `state.output` becomes omitted marker, `_truncated: true` stamped.
  - Oversized record with unknown `event.type`: keeps strategic fallback skeleton instead of falling back to `{ event: { _truncated: true } }`.
  - Real-corpus fixture from `docker-volumes/.../sessions/*.jsonl`: projects without losing skeleton fields the viewer needs.

Exit criteria: `pnpm -F @thor/common test` green; new fixtures cover the four cases above.

### Phase 2 — Viewer adopts the schema

- Import `OpencodeEventViewSchema` in `packages/runner/src/index.ts`.
- Replace ad-hoc `event.properties.part.type` narrowing with `safeParse` + discriminated switch.
- Add `renderUnknownEvent` fallback for legacy `{ _truncated: true }` and parse failures.
- Render the `_omitted` marker explicitly in tool rows (`(output omitted, 38 KB)`).
- Update `packages/runner/src/trigger.test.ts` to assert: known events render rich, unknown/legacy events render a compact "event withheld" row, omitted-leaf marker appears in tool rows.

Exit criteria: `pnpm -F @thor/runner test` green; viewer renders historical session files without crashes (manual check against one large file).

### Phase 3 — Integration verification

- Push branch, run E2E workflow.
- Sample a session file in production worklog before/after to confirm the projected shape on disk and renderer output.

Exit criteria: E2E green; spot-check shows skeletons preserved on previously-truncated records.

## Decision Log

| Decision                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid (project only on overflow), not project-always**                                                                                 | Keeps 75% of records full-fidelity for engineering debugging. The schema is a preservation contract for the over-cap minority and a render contract for the viewer. Always-project would turn the worklog into a viewer cache, sacrificing the ability to grep raw JSONL for surprising SDK behavior.    |
| **Share schema between writer and viewer**                                                                                                | Single source of truth eliminates drift. Adding a `part.type` updates both projection and render branches from one diff. `safeParse` failures on either side both route to the unknown-event fallback — symmetric forward-compat.                                                                        |
| **Enums use `z.string()` for `status` / `event.type` discriminators where possible, with `.passthrough()` parts for unknown `part.type`** | Strict `z.enum(...)` would silently drop new SDK values to the generic-truncate fallback — worse than projection. Permissive strings preserve forward-compat at the cost of weaker typing; renderers handle unknown values as a default branch.                                                          |
| **`{ _omitted: true, bytes: N }` marker rather than dropping fields silently**                                                            | Engineers can see exactly which field blew the budget and how big it was; informs future raised limits or sidecar-blob storage. Costs ~20 bytes per omitted leaf vs. lossy total drop.                                                                                                                   |
| **`safeParse` + `renderUnknownEvent` fallback over a one-time JSONL rewrite migration**                                                   | Legacy records are debugging artifacts; rewriting risks corrupting them and adds migration code that lives forever. Treating old shapes as "unknown event, here's what we have" is honest and zero-risk.                                                                                                 |
| **Unknown top-level OpenCode events use strategic fallback projection, not blanket truncation**                                           | A future SDK event can be unfamiliar but still carry the same small routing/render fields. Keeping `event.type`, `properties.sessionID`/`time`, part id/type/tool/callID, state status/time/error, and omitted markers lets the viewer surface the event while still dropping unbounded vendor payloads. |
| **256-byte `OMIT_THRESHOLD` for large-leaf detection during projection**                                                                  | Small inputs (a path, a search query) stay inline; large outputs (file contents, search results) become markers. Threshold tuneable; not a hard contract.                                                                                                                                                |
| **Text/reasoning carve-out stays in `capRecord`, not enforced by schema**                                                                 | The unbounded-string allowance for text/reasoning is a preservation rule, not a render rule. Keeping it in `capRecord` (existing `isTextOrReasoningOpencodeEvent` early return) means schema authors don't accidentally bound text length with `.max(...)` and silently truncate assistant replies.      |
| **No off-record blob storage in this plan**                                                                                               | Adding sidecar files / S3 is a separate infra decision. Markers buy us the option without committing to it.                                                                                                                                                                                              |

## Risks

- **Schema drift vs. OpenCode SDK.** Mitigated by permissive enums (`z.string()`) and the unknown-event fallback. Worst case: a new SDK event type renders as a compact "event withheld" row until we extend the schema.
- **Coupling viewer needs to writer fidelity.** Code-review norm: removing a field from `OpencodeEventViewSchema` reduces what survives on disk for over-cap records — only subtract deliberately.
- **Bundle size / parse cost on hot path.** Every opencode event already goes through `JSON.stringify` size checks; adding a `safeParse` on overflow is the same order of magnitude. Negligible.
- **Tests against real fixtures.** Plan calls for using actual JSONL samples — these may contain unredacted content. Use small synthetic-but-shaped fixtures or scrub before committing.
