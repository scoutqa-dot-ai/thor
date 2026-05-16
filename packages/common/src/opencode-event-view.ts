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
 *    markers. Unknown SDK shapes route to a compact fallback projection that
 *    keeps the same strategic skeleton instead of blanking the whole event.
 *
 * 2. Render contract for the viewer (reader side). The viewer runs
 *    `OpencodeEventViewSchema.safeParse(record.event)` to obtain a typed
 *    union; un-recognized shapes (legacy `{ _truncated: true }` carcasses,
 *    fallback-projected future SDK additions, or under-cap future events)
 *    route to the viewer's unknown-event fallback.
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

export interface UnknownOpencodeEventView {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
}

export type ProjectedOpencodeEvent = OpencodeEventView | UnknownOpencodeEventView;

/**
 * Field names whose values are replaced with omitted markers during
 * projection. These are the large-payload leaves observed in the corpus.
 */
const OMITTABLE_KEYS = new Set(["input", "output", "raw", "metadata", "snapshot"]);

const STABLE_SKELETON_STRING_KEYS = new Set([
  "id",
  "messageID",
  "sessionID",
  "type",
  "tool",
  "callID",
  "status",
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function projectLeaf(key: string, value: unknown, threshold: number): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (isOmittedMarker(value)) return value;
  const size = byteLen(value);
  if (
    (OMITTABLE_KEYS.has(key) ||
      (typeof value === "string" && !STABLE_SKELETON_STRING_KEYS.has(key))) &&
    size > threshold
  ) {
    return { _omitted: true, bytes: size };
  }
  return shrinkLargeLeaves(value, threshold);
}

function assignProjectedKey(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  threshold: number,
): void {
  if (!(key in source)) return;
  const projected = projectLeaf(key, source[key], threshold);
  if (projected !== undefined) target[key] = projected;
}

function assignPrimitive(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    target[key] = value;
  }
}

function projectTime(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const key of ["start", "end", "created", "compacted"]) {
    const child = value[key];
    if (typeof child === "number" && Number.isFinite(child)) out[key] = child;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectStatus(value: unknown): unknown {
  if (!isRecord(value)) return typeof value === "string" ? value : undefined;
  const out: Record<string, unknown> = {};
  assignPrimitive(out, value, "type");
  assignPrimitive(out, value, "status");
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectError(value: unknown, threshold: number): unknown {
  if (typeof value === "string") return projectLeaf("error", value, threshold);
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  assignProjectedKey(out, value, "name", threshold);
  assignProjectedKey(out, value, "message", threshold);
  if (isRecord(value.data)) {
    const data: Record<string, unknown> = {};
    assignProjectedKey(data, value.data, "name", threshold);
    assignProjectedKey(data, value.data, "message", threshold);
    if (Object.keys(data).length > 0) out.data = data;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectUnknownState(
  value: unknown,
  threshold: number,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  assignPrimitive(out, value, "status");
  assignProjectedKey(out, value, "title", threshold);
  assignProjectedKey(out, value, "input", threshold);
  assignProjectedKey(out, value, "output", threshold);
  assignProjectedKey(out, value, "raw", threshold);
  assignProjectedKey(out, value, "metadata", threshold);
  const error = projectError(value.error, threshold);
  if (error !== undefined) out.error = error;
  const time = projectTime(value.time);
  if (time) out.time = time;
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectUnknownPart(
  value: unknown,
  threshold: number,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of [
    "id",
    "messageID",
    "sessionID",
    "type",
    "tool",
    "callID",
    "cost",
    "tokens",
    "reason",
    "text",
    "prompt",
    "description",
    "agent",
    "command",
    "mime",
    "filename",
    "url",
    "hash",
    "files",
    "name",
    "attempt",
    "auto",
    "overflow",
    "tail_start_id",
    "snapshot",
  ]) {
    assignProjectedKey(out, value, key, threshold);
  }
  const state = projectUnknownState(value.state, threshold);
  if (state) out.state = state;
  const time = projectTime(value.time);
  if (time) out.time = time;
  const error = projectError(value.error, threshold);
  if (error !== undefined) out.error = error;
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectUnknownProperties(
  value: unknown,
  threshold: number,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ["sessionID", "messageID", "time", "path", "file", "source"]) {
    assignProjectedKey(out, value, key, threshold);
  }
  const part = projectUnknownPart(value.part, threshold);
  if (part) out.part = part;
  const status = projectStatus(value.status);
  if (status !== undefined) out.status = status;
  const error = projectError(value.error, threshold);
  if (error !== undefined) out.error = error;
  for (const key of ["input", "output", "raw", "metadata", "snapshot"]) {
    assignProjectedKey(out, value, key, threshold);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectUnknownOpencodeEvent(
  event: unknown,
  threshold: number,
): UnknownOpencodeEventView | null {
  if (!isRecord(event) || typeof event.type !== "string") return null;
  const out: UnknownOpencodeEventView = { type: event.type };
  if (typeof event.id === "string") out.id = event.id;
  const properties = projectUnknownProperties(event.properties, threshold);
  if (properties) out.properties = properties;
  return out;
}

/**
 * Project an opencode event payload through the view schema.
 *
 * Strategy: shrink large leaves above `threshold` bytes, parse through the
 * schema, return the parsed value on success. On parse failure (unknown
 * event type, missing required field), return a strategic fallback projection
 * keyed by the event's own `type` so the writer/viewer can preserve context
 * without dumping the whole payload.
 *
 * The default 256-byte threshold keeps small inputs inline (a file path, a
 * search query) while turning large outputs (file bodies, search results)
 * into markers. Callers can pass `threshold: 0` to force aggressive
 * shrinking when the first projection is still too large.
 */
export function projectOpencodeEvent(
  event: unknown,
  options: { threshold?: number } = {},
): ProjectedOpencodeEvent | null {
  const threshold = options.threshold ?? 256;
  const shrunk = shrinkLargeLeaves(event, threshold);
  const parsed = OpencodeEventViewSchema.safeParse(shrunk);
  return parsed.success ? parsed.data : projectUnknownOpencodeEvent(shrunk, threshold);
}
