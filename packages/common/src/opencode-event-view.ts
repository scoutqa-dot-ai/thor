/**
 * Compact projection for the inner `event` field of oversized
 * `opencode_event` records.
 *
 * This is deliberately not a full OpenCode SDK schema. Under-cap records are
 * stored unchanged, and oversized text/reasoning parts bypass the cap in
 * `event-log.ts`. Projection only handles the remaining oversized records by
 * keeping the small fields the runner viewer needs to explain what happened,
 * while replacing unbounded payload leaves with `{ _omitted: true, bytes }`.
 */

export interface OmittedMarker {
  _omitted: true;
  bytes: number;
}

export type ProjectedOpencodeEvent = {
  type: string;
  id?: string;
  properties?: Record<string, unknown>;
};

export type OpencodeEventView = ProjectedOpencodeEvent;
export type UnknownOpencodeEventView = ProjectedOpencodeEvent;
export type OpencodeEventPart = Record<string, unknown>;

const OMITTABLE_KEYS = ["input", "output", "raw", "metadata", "snapshot"] as const;

export function isOmittedMarker(value: unknown): value is OmittedMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _omitted?: unknown })._omitted === true &&
    typeof (value as { bytes?: unknown }).bytes === "number"
  );
}

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

export function projectOpencodeEvent(event: unknown): ProjectedOpencodeEvent | null {
  if (!isRecord(event) || typeof event.type !== "string") return null;

  const out: ProjectedOpencodeEvent = { type: event.type };
  if (typeof event.id === "string") out.id = event.id;

  const properties = projectProperties(event.properties);
  if (properties) out.properties = properties;

  return out;
}
