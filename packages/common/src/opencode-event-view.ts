import { z } from "zod/v4";

/**
 * Schema + projection for the inner `event` field of an `opencode_event`
 * record. Two responsibilities:
 *
 * 1. Preservation contract for `capRecord` (writer side). When an opencode
 *    record exceeds `MAX_RECORD_BYTES`, `capRecord` calls
 *    `projectOpencodeEvent` to keep the render skeleton (event type, part
 *    type, tool name, callID, status, sessionID, time) while replacing
 *    large leaves (`state.input`, `state.output`, `state.raw`,
 *    `state.metadata`, `snapshot`) with `{ _omitted: true, bytes: N }`
 *    markers. Falls back to the generic `{ event: { _truncated: true } }`
 *    only when projection fails (unknown SDK shape).
 *
 * 2. Render contract for the viewer (reader side). The viewer runs
 *    `OpencodeEventViewSchema.safeParse(record.event)` to obtain a typed
 *    union; un-recognized shapes (legacy `{ _truncated: true }` carcasses
 *    or future SDK additions) route to the viewer's unknown-event fallback.
 *
 * The text/reasoning carve-out lives in `event-log.ts`
 * (`isTextOrReasoningOpencodeEvent`) and runs before projection, so this
 * schema does not bound `text` length.
 *
 * Relationship to the OpenCode SDK. This schema is a **viewer-oriented
 * projection** of the OpenCode SDK types
 * (`packages/sdk/js/src/v2/gen/types.gen.ts`), not a faithful mirror.
 * Differences are deliberate:
 *
 * - Event variants are narrowed to the four `event.type` values empirically
 *   persisted to session JSONL (`message.part.updated`,
 *   `session.{status,idle,error}`). The SDK has ~45 bus events; the others
 *   (`tui.*`, `lsp.*`, `permission.*`, etc.) are transient and never reach
 *   our worklog.
 * - Part variants enumerate all 12 SDK part types, but fields not consumed
 *   by the viewer are typed `z.unknown()`. The projection step uses zod's
 *   default strip mode, so on over-cap records those fields are dropped;
 *   on under-cap records the original JSON survives unchanged (parsing is
 *   only invoked at viewer read time and at writer projection time).
 * - `ToolState.status` is narrowed to the SDK's four-value literal union
 *   (`pending` / `running` / `completed` / `error`) with a string fallback,
 *   so future status values still parse rather than routing the whole part
 *   to the unknown-part branch.
 * - Per-status required-field invariants from `ToolStateCompleted` /
 *   `ToolStateError` (e.g. "completed implies `output`/`time.end`") are
 *   intentionally **not** enforced. A half-formed record from a streaming
 *   update should render as much as it can, not get rejected.
 *
 * When OpenCode bumps the SDK, re-survey corpus + diff
 * `types.gen.ts` against this file. Add new part/event variants when they
 * start appearing in worklog records; the `UnknownPartSchema` /
 * unknown-event fallback is the safety net, not the primary mechanism.
 */

const OmittedMarkerSchema = z.object({
  _omitted: z.literal(true),
  bytes: z.number().int().nonnegative(),
});
export type OmittedMarker = z.infer<typeof OmittedMarkerSchema>;

export function isOmittedMarker(value: unknown): value is OmittedMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _omitted?: unknown })._omitted === true &&
    typeof (value as { bytes?: unknown }).bytes === "number"
  );
}

const PartCommon = {
  id: z.string().optional(),
  messageID: z.string().optional(),
  sessionID: z.string().optional(),
};

const TextPartSchema = z.object({
  ...PartCommon,
  type: z.literal("text"),
  text: z.string(),
});

const ReasoningPartSchema = z.object({
  ...PartCommon,
  type: z.literal("reasoning"),
  text: z.string(),
});

/**
 * Canonical SDK union: `pending` | `running` | `completed` | `error`. The
 * `.or(z.string())` tail keeps forward-compat: a future SDK status renders
 * as a tagged string row instead of routing the whole part to the unknown
 * branch.
 */
const ToolStatusSchema = z.enum(["pending", "running", "completed", "error"]).or(z.string());

const ToolStateSchema = z.object({
  status: ToolStatusSchema,
  title: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  raw: z.unknown().optional(),
  metadata: z.unknown().optional(),
  error: z.string().optional(),
  time: z
    .object({
      start: z.number().optional(),
      end: z.number().optional(),
      compacted: z.number().optional(),
    })
    .partial()
    .optional(),
});

const ToolPartSchema = z.object({
  ...PartCommon,
  type: z.literal("tool"),
  tool: z.string(),
  callID: z.string().optional(),
  state: ToolStateSchema,
});

const StepStartPartSchema = z.object({
  ...PartCommon,
  type: z.literal("step-start"),
  snapshot: z.unknown().optional(),
});

const StepFinishPartSchema = z.object({
  ...PartCommon,
  type: z.literal("step-finish"),
  cost: z.number().optional(),
  tokens: z.unknown().optional(),
});

const SnapshotPartSchema = z.object({
  ...PartCommon,
  type: z.literal("snapshot"),
  snapshot: z.unknown().optional(),
});

const SubtaskPartSchema = z.object({
  ...PartCommon,
  type: z.literal("subtask"),
  prompt: z.string().optional(),
  description: z.string().optional(),
  agent: z.string().optional(),
  model: z.unknown().optional(),
  command: z.string().optional(),
});

const FilePartSchema = z.object({
  ...PartCommon,
  type: z.literal("file"),
  mime: z.string().optional(),
  filename: z.string().optional(),
  url: z.string().optional(),
  source: z.unknown().optional(),
});

const PatchPartSchema = z.object({
  ...PartCommon,
  type: z.literal("patch"),
  hash: z.string().optional(),
  files: z.array(z.string()).optional(),
});

const AgentPartSchema = z.object({
  ...PartCommon,
  type: z.literal("agent"),
  name: z.string().optional(),
  source: z.unknown().optional(),
});

const RetryPartSchema = z.object({
  ...PartCommon,
  type: z.literal("retry"),
  attempt: z.number().optional(),
  error: z.unknown().optional(),
  time: z.object({ created: z.number().optional() }).partial().optional(),
});

const CompactionPartSchema = z.object({
  ...PartCommon,
  type: z.literal("compaction"),
  auto: z.boolean().optional(),
  overflow: z.boolean().optional(),
  tail_start_id: z.string().optional(),
});

/**
 * Forward-compat escape hatch. Unknown `part.type` values pass through with
 * their shallow shape preserved so the viewer's unknown-part branch can
 * still show `(part type: foo)` instead of a blank row. New SDK part types
 * land here until we extend the discriminated union above.
 */
const UnknownPartSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const KnownPartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
  StepStartPartSchema,
  StepFinishPartSchema,
  SnapshotPartSchema,
  SubtaskPartSchema,
  FilePartSchema,
  PatchPartSchema,
  AgentPartSchema,
  RetryPartSchema,
  CompactionPartSchema,
]);

const PartSchema = z.union([KnownPartSchema, UnknownPartSchema]);
export type OpencodeEventPart = z.infer<typeof PartSchema>;

const MessagePartUpdatedSchema = z.object({
  type: z.literal("message.part.updated"),
  properties: z.object({
    sessionID: z.string().optional(),
    time: z.number().optional(),
    part: PartSchema,
  }),
});

const SessionStatusSchema = z.object({
  type: z.literal("session.status"),
  properties: z.object({
    sessionID: z.string().optional(),
    status: z
      .object({
        type: z.string(),
      })
      .passthrough(),
  }),
});

const SessionIdleSchema = z.object({
  type: z.literal("session.idle"),
  properties: z
    .object({
      sessionID: z.string().optional(),
    })
    .passthrough(),
});

const SessionErrorSchema = z.object({
  type: z.literal("session.error"),
  properties: z
    .object({
      sessionID: z.string().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
});

export const OpencodeEventViewSchema = z.discriminatedUnion("type", [
  MessagePartUpdatedSchema,
  SessionStatusSchema,
  SessionIdleSchema,
  SessionErrorSchema,
]);

export type OpencodeEventView = z.infer<typeof OpencodeEventViewSchema>;

/**
 * Field names whose values are replaced with omitted markers during
 * projection. These are the large-payload leaves observed in the corpus.
 */
const OMITTABLE_KEYS = new Set(["input", "output", "raw", "metadata", "snapshot"]);

function byteLen(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

/**
 * Recursively replace known-large leaves with omitted markers when they
 * exceed `threshold` bytes. Other fields are passed through structurally.
 * Arrays, primitives, and `null` are left as-is. Already-marked omitted
 * payloads are kept untouched.
 */
function shrinkLargeLeaves(value: unknown, threshold: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => shrinkLargeLeaves(item, threshold));
  }
  if (!value || typeof value !== "object") return value;
  if (isOmittedMarker(value)) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (OMITTABLE_KEYS.has(key) && child !== undefined && child !== null) {
      if (isOmittedMarker(child)) {
        out[key] = child;
        continue;
      }
      const size = byteLen(child);
      if (size > threshold) {
        out[key] = { _omitted: true, bytes: size };
        continue;
      }
    }
    out[key] = shrinkLargeLeaves(child, threshold);
  }
  return out;
}

/**
 * Project an opencode event payload through the view schema.
 *
 * Strategy: shrink large leaves above `threshold` bytes, parse through the
 * schema, return the parsed value on success. On parse failure (unknown
 * event type, missing required field), return `null` so the caller falls
 * back to the generic `{ _truncated: true }` envelope.
 *
 * The default 256-byte threshold keeps small inputs inline (a file path, a
 * search query) while turning large outputs (file bodies, search results)
 * into markers. Callers can pass `threshold: 0` to force aggressive
 * shrinking when the first projection is still too large.
 */
export function projectOpencodeEvent(
  event: unknown,
  options: { threshold?: number } = {},
): OpencodeEventView | null {
  const threshold = options.threshold ?? 256;
  const shrunk = shrinkLargeLeaves(event, threshold);
  const parsed = OpencodeEventViewSchema.safeParse(shrunk);
  return parsed.success ? parsed.data : null;
}
