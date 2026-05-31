import { z } from "zod/v4";

/**
 * OpenCode event types — schema, parser, and writer-side projection.
 *
 * One module for everything Thor knows about OpenCode's `event` payload:
 *
 * - {@link OpencodeEventSchema} is the authoritative shape covering the four
 *   event types the runner viewer renders plus ~9 lifecycle events watched
 *   for drift detection.
 * - {@link parseOpencodeEvent} narrows an unknown event into the union (used
 *   by the runner viewer) and surfaces a fallback for unrecognized types.
 * - {@link projectOpencodeEvent} compacts an oversized event for storage by
 *   replacing unbounded leaves with {@link OmittedMarker}s. Called by
 *   `capRecord` when an `opencode_event` record exceeds the 4 KB cap.
 *
 * Both paths preserve fail-open semantics — parse failure never blocks the
 * write or the render, it just routes through the fallback branch.
 */

export interface OmittedMarker {
  _omitted: true;
  bytes: number;
}

export function isOmittedMarker(value: unknown): value is OmittedMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _omitted?: unknown })._omitted === true &&
    typeof (value as { bytes?: unknown }).bytes === "number"
  );
}

const OmittedMarkerSchema = z.object({
  _omitted: z.literal(true),
  bytes: z.number(),
});

/**
 * Payload leaves that the `capRecord` projection may replace with an
 * `OmittedMarker`. Everywhere else the field would be plain JSON.
 */
const PayloadOrOmittedSchema = z.union([OmittedMarkerSchema, z.json()]);

const TimeWindowSchema = z.object({
  start: z.number().optional(),
  end: z.number().optional(),
});

const TokensSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  reasoning: z.number().optional(),
  cache: z
    .object({
      read: z.number().optional(),
      write: z.number().optional(),
    })
    .optional(),
});

const ToolStateSchema = z.object({
  status: z.enum(["pending", "running", "completed", "error"]),
  title: z.string().optional(),
  input: PayloadOrOmittedSchema.optional(),
  output: PayloadOrOmittedSchema.optional(),
  error: z.string().optional(),
  metadata: PayloadOrOmittedSchema.optional(),
  time: TimeWindowSchema.optional(),
});

const BasePartSchema = z.object({
  id: z.string().optional(),
  sessionID: z.string().optional(),
  messageID: z.string().optional(),
});

export const ViewerToolPartSchema = BasePartSchema.extend({
  type: z.literal("tool"),
  tool: z.string(),
  callID: z.string().optional(),
  state: ToolStateSchema,
  cost: z.number().optional(),
  tokens: TokensSchema.optional(),
});

export const ViewerTextPartSchema = BasePartSchema.extend({
  type: z.literal("text"),
  text: z.string(),
});

export const ViewerReasoningPartSchema = BasePartSchema.extend({
  type: z.literal("reasoning"),
  text: z.string(),
});

export const ViewerStepFinishPartSchema = BasePartSchema.extend({
  type: z.literal("step-finish"),
  cost: z.number().optional(),
  tokens: TokensSchema.optional(),
});

const ViewerRetryPartSchema = BasePartSchema.extend({
  type: z.literal("retry"),
  reason: z.string().optional(),
});

const ViewerSubtaskPartSchema = BasePartSchema.extend({
  type: z.literal("subtask"),
});

export const ViewerCompactionPartSchema = BasePartSchema.extend({
  type: z.literal("compaction"),
  auto: z.boolean().optional(),
});

// Recognized but silently dropped by the renderer — the runner viewer doesn't
// surface them, but they're in the schema so they don't trigger the
// "unrecognized" fallback row + drift warning. step-start pairs with the
// rendered step-finish; the rest are either internal (snapshot, patch) or
// already covered by adjacent surfaces (agent → task tool input, file → not
// currently surfaced).
const ViewerStepStartPartSchema = BasePartSchema.extend({ type: z.literal("step-start") });
const ViewerSnapshotPartSchema = BasePartSchema.extend({ type: z.literal("snapshot") });
const ViewerPatchPartSchema = BasePartSchema.extend({ type: z.literal("patch") });
const ViewerAgentPartSchema = BasePartSchema.extend({ type: z.literal("agent") });
const ViewerFilePartSchema = BasePartSchema.extend({ type: z.literal("file") });

export const ViewerPartSchema = z.discriminatedUnion("type", [
  ViewerToolPartSchema,
  ViewerTextPartSchema,
  ViewerReasoningPartSchema,
  ViewerStepFinishPartSchema,
  ViewerRetryPartSchema,
  ViewerSubtaskPartSchema,
  ViewerCompactionPartSchema,
  ViewerStepStartPartSchema,
  ViewerSnapshotPartSchema,
  ViewerPatchPartSchema,
  ViewerAgentPartSchema,
  ViewerFilePartSchema,
]);

// Viewer-renderable events — schema is tight because renderers read fields.
const MessagePartUpdatedSchema = z.object({
  type: z.literal("message.part.updated"),
  properties: z.object({
    part: ViewerPartSchema,
  }),
});

const SessionStatusSchema = z.object({
  type: z.literal("session.status"),
  properties: z.object({
    sessionID: z.string(),
    status: z.object({ type: z.string() }),
  }),
});

const SessionIdleSchema = z.object({
  type: z.literal("session.idle"),
  properties: z.object({
    sessionID: z.string(),
  }),
});

const SessionErrorSchema = z.object({
  type: z.literal("session.error"),
  properties: z.object({
    sessionID: z.string().optional(),
    error: PayloadOrOmittedSchema.optional(),
  }),
});

// Telemetry-only events — we recognize the type but never read properties,
// so the schema validates the type literal and accepts any property bag.
const LoosePropertiesSchema = z.record(z.string(), z.unknown());

const MessageUpdatedSchema = z.object({
  type: z.literal("message.updated"),
  properties: LoosePropertiesSchema,
});
const MessageRemovedSchema = z.object({
  type: z.literal("message.removed"),
  properties: LoosePropertiesSchema,
});
const MessagePartRemovedSchema = z.object({
  type: z.literal("message.part.removed"),
  properties: LoosePropertiesSchema,
});
const SessionCreatedSchema = z.object({
  type: z.literal("session.created"),
  properties: LoosePropertiesSchema,
});
const SessionUpdatedSchema = z.object({
  type: z.literal("session.updated"),
  properties: LoosePropertiesSchema,
});
const SessionDeletedSchema = z.object({
  type: z.literal("session.deleted"),
  properties: LoosePropertiesSchema,
});
const SessionCompactedSchema = z.object({
  type: z.literal("session.compacted"),
  properties: LoosePropertiesSchema,
});
const PermissionUpdatedSchema = z.object({
  type: z.literal("permission.updated"),
  properties: LoosePropertiesSchema,
});
const PermissionRepliedSchema = z.object({
  type: z.literal("permission.replied"),
  properties: LoosePropertiesSchema,
});

export const OpencodeEventSchema = z.discriminatedUnion("type", [
  MessagePartUpdatedSchema,
  SessionStatusSchema,
  SessionIdleSchema,
  SessionErrorSchema,
  MessageUpdatedSchema,
  MessageRemovedSchema,
  MessagePartRemovedSchema,
  SessionCreatedSchema,
  SessionUpdatedSchema,
  SessionDeletedSchema,
  SessionCompactedSchema,
  PermissionUpdatedSchema,
  PermissionRepliedSchema,
]);

export type ViewerPart = z.infer<typeof ViewerPartSchema>;
export type ViewerToolPart = z.infer<typeof ViewerToolPartSchema>;
export type ViewerTextPart = z.infer<typeof ViewerTextPartSchema>;
export type ViewerReasoningPart = z.infer<typeof ViewerReasoningPartSchema>;
export type ViewerStepFinishPart = z.infer<typeof ViewerStepFinishPartSchema>;
export type ViewerCompactionPart = z.infer<typeof ViewerCompactionPartSchema>;
export type OpencodeEvent = z.infer<typeof OpencodeEventSchema>;
export type ViewerPayloadOrOmitted = z.infer<typeof PayloadOrOmittedSchema>;

export type ParsedOpencodeEvent =
  | { kind: "ok"; event: OpencodeEvent }
  | { kind: "truncated" }
  | { kind: "unrecognized"; rawType?: string; error: string };

export function parseOpencodeEvent(raw: unknown): ParsedOpencodeEvent {
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { _truncated?: unknown })._truncated === true
  ) {
    return { kind: "truncated" };
  }
  const result = OpencodeEventSchema.safeParse(raw);
  if (result.success) return { kind: "ok", event: result.data };
  return { kind: "unrecognized", rawType: extractDriftKey(raw), error: result.error.message };
}

/**
 * Drift-warn dedup key. Plain event type for most failures, but a compound
 * "<event-type>:<part-type>" for failed message.part.updated events so a new
 * SDK part type doesn't dedupe against legit event-level drift on the same
 * outer type.
 */
function extractDriftKey(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const eventType = (raw as { type?: unknown }).type;
  if (typeof eventType !== "string") return undefined;
  if (eventType === "message.part.updated") {
    const properties = (raw as { properties?: unknown }).properties;
    const part =
      typeof properties === "object" && properties !== null
        ? (properties as { part?: unknown }).part
        : undefined;
    const partType =
      typeof part === "object" && part !== null ? (part as { type?: unknown }).type : undefined;
    if (typeof partType === "string") return `${eventType}:${partType}`;
  }
  return eventType;
}

// ---------------------------------------------------------------------------
// Writer-side projection: compact an oversized event so it fits the 4 KB cap
// by replacing unbounded leaves (input/output/raw/metadata/snapshot) with
// {@link OmittedMarker}s. Operates structurally on unknown JSON so it doesn't
// reject events the schema doesn't recognize.
// ---------------------------------------------------------------------------

const OMITTABLE_KEYS = ["input", "output", "raw", "metadata", "snapshot"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function byteLen(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function omittedMarker(value: unknown): OmittedMarker {
  if (isOmittedMarker(value)) return value;
  return { _omitted: true, bytes: byteLen(value) };
}

function assignString(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string") target[key] = value;
}

function assignNumber(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function assignOmittedMarkers(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of OMITTABLE_KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value !== undefined && value !== null) target[key] = omittedMarker(value);
  }
}

function projectTime(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  assignNumber(out, value, "start");
  assignNumber(out, value, "end");
  assignNumber(out, value, "compacted");
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectStatus(value: unknown): unknown {
  if (typeof value === "string") return { type: value };
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  assignString(out, value, "type");
  assignString(out, value, "status");
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectError(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;

  const out: Record<string, unknown> = {};
  assignString(out, value, "name");
  assignString(out, value, "message");
  if (isRecord(value.data)) {
    const data: Record<string, unknown> = {};
    assignString(data, value.data, "name");
    assignString(data, value.data, "message");
    if (Object.keys(data).length > 0) out.data = data;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectState(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  assignString(out, value, "status");
  assignString(out, value, "title");
  const time = projectTime(value.time);
  if (time) out.time = time;
  const error = projectError(value.error);
  if (error !== undefined) out.error = error;
  assignOmittedMarkers(out, value);
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectPart(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  assignString(out, value, "id");
  assignString(out, value, "messageID");
  assignString(out, value, "sessionID");
  assignString(out, value, "type");
  assignString(out, value, "tool");
  assignString(out, value, "callID");
  const state = projectState(value.state);
  if (state) out.state = state;
  assignOmittedMarkers(out, value);
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectProperties(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  assignString(out, value, "sessionID");
  assignNumber(out, value, "time");

  const status = projectStatus(value.status);
  if (status !== undefined) out.status = status;

  const error = projectError(value.error);
  if (error !== undefined) out.error = error;

  const part = projectPart(value.part);
  if (part) out.part = part;

  assignOmittedMarkers(out, value);
  return Object.keys(out).length > 0 ? out : undefined;
}

export function projectOpencodeEvent(
  event: unknown,
): { type: string; id?: string; properties?: Record<string, unknown> } | null {
  if (!isRecord(event) || typeof event.type !== "string") return null;

  const out: { type: string; id?: string; properties?: Record<string, unknown> } = {
    type: event.type,
  };
  if (typeof event.id === "string") out.id = event.id;

  const properties = projectProperties(event.properties);
  if (properties) out.properties = properties;

  return out;
}
