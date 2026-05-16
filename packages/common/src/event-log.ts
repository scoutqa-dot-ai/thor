import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { getWorklogDir } from "./worklog.js";
import { truncate } from "./logger.js";
import { projectOpencodeEvent } from "./opencode-event-view.js";

export const ALIAS_TYPES = [
  "slack.thread_id",
  "slack.thread",
  "git.branch",
  "github.issue",
  "opencode.session",
  "opencode.subsession",
] as const;
export const AliasTypeSchema = z.enum(ALIAS_TYPES);

/**
 * Alias value safety: rejects empty values, oversized values, and any control
 * characters that could corrupt the JSONL line (newlines, tabs, NUL).
 */
const AliasValueSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !/[\n\r\t\0]/.test(v), {
    message: "alias value contains control characters",
  });

export const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isUuidV7(value: string): boolean {
  return UUID_V7_RE.test(value);
}
const AnchorIdSchema = z.string().regex(UUID_V7_RE, { message: "anchorId must be a UUIDv7" });

const BaseRecordSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.string(),
  type: z.string(),
});

export const TriggerStartRecordSchema = BaseRecordSchema.extend({
  type: z.literal("trigger_start"),
  triggerId: z.string().regex(UUID_V7_RE, { message: "triggerId must be a UUIDv7" }),
  correlationKey: z.string().optional(),
});

export const TriggerEndRecordSchema = BaseRecordSchema.extend({
  type: z.literal("trigger_end"),
  triggerId: z.string().regex(UUID_V7_RE, { message: "triggerId must be a UUIDv7" }),
  status: z.enum(["completed", "error", "aborted"]),
  durationMs: z.number().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
});

export const OpencodeEventRecordSchema = BaseRecordSchema.extend({
  type: z.literal("opencode_event"),
  event: z.unknown(),
});

export const AliasEventRecordSchema = BaseRecordSchema.extend({
  type: z.literal("alias"),
  aliasType: AliasTypeSchema,
  aliasValue: AliasValueSchema,
  anchorId: AnchorIdSchema,
  source: z.string().optional(),
});

export const ToolCallRecordSchema = BaseRecordSchema.extend({
  type: z.literal("tool_call"),
  callId: z.string().optional(),
  tool: z.string(),
  payload: z.unknown(),
});

export const SessionEventLogRecordSchema = z.discriminatedUnion("type", [
  TriggerStartRecordSchema,
  TriggerEndRecordSchema,
  OpencodeEventRecordSchema,
  AliasEventRecordSchema,
  ToolCallRecordSchema,
]);

export type SessionEventLogRecord = z.infer<typeof SessionEventLogRecordSchema>;

export const AliasRecordSchema = z.object({
  ts: z.string(),
  aliasType: AliasTypeSchema,
  aliasValue: AliasValueSchema,
  anchorId: AnchorIdSchema,
});

export type AliasRecord = z.infer<typeof AliasRecordSchema>;

export type TriggerSliceStatus = "completed" | "error" | "aborted" | "crashed" | "in_flight";

export interface TriggerSlice {
  records: SessionEventLogRecord[];
  status: TriggerSliceStatus;
  reason?: string;
  lastEventTs?: string;
  skippedMalformed: number;
  truncated?: boolean;
}

export type ActiveTriggerResult =
  | { ok: true; anchorId: string; sessionId: string; triggerId: string }
  | { ok: false; reason: "none" | "oversized" };

export interface ReverseAnchorEntry {
  sessionIds: string[];
  subsessionIds: string[];
  externalKeys: Array<{ aliasType: AliasRecord["aliasType"]; aliasValue: string }>;
  currentSessionId?: string;
}

export type AnchorSessionStatus = "stuck" | "in_progress" | "idle" | "unknown";

export interface AnchorSessionState {
  anchorId: string;
  status: AnchorSessionStatus;
  currentSessionId?: string;
  ownerSessionId?: string;
  triggerId?: string;
  triggerStartedAt?: string;
  lastEventTs?: string;
  ageMs?: number;
  idleMs?: number;
  latestTerminalStatus?: Exclude<TriggerSliceStatus, "in_flight">;
  externalKeys: Array<{ aliasType: AliasRecord["aliasType"]; aliasValue: string }>;
  sessionIds: string[];
  subsessionIds: string[];
  skippedMalformed: number;
  oversized: boolean;
  reason?: string;
}

export interface ListAnchorSessionStatesOptions {
  now?: Date;
  stuckAfterMs?: number;
  limit?: number;
}

interface InternalReverseEntry {
  /** sessionId → newest record ts seen for that binding. */
  sessions: Map<string, string>;
  subsessions: Set<string>;
  /** "<aliasType>\0<aliasValue>" encoding. */
  externalKeys: Set<string>;
}

const MAX_RECORD_BYTES = 4095;
export const MAX_SESSION_FILE_BYTES = Number.parseInt(
  process.env.SESSION_LOG_MAX_BYTES || "52428800",
  10,
);

interface AliasCacheState {
  /** "<aliasType>\0<aliasValue>" → anchorId. */
  forward: Map<string, string>;
  reverse: Map<string, InternalReverseEntry>;
}
const aliasCache: AliasCacheState = { forward: new Map(), reverse: new Map() };
/** Last observed size of aliases.jsonl. -1 = never loaded. */
let aliasCacheLastSize = -1;

interface SessionRecordsCacheEntry {
  signature: string;
  records: SessionEventLogRecord[];
  skippedMalformed: number;
  oversized: boolean;
}
const sessionRecordsCache = new Map<string, SessionRecordsCacheEntry>();

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid session id: ${value}`);
  return value;
}

export function sessionLogPath(sessionId: string): string {
  const root = resolve(getWorklogDir(), "sessions");
  const resolved = resolve(root, `${safeId(sessionId)}.jsonl`);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error(`Invalid session path: ${sessionId}`);
  return resolved;
}

function aliasLogPath(): string {
  return join(getWorklogDir(), "aliases.jsonl");
}

function appendJsonlFileOrThrow(path: string, record: object): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** UUIDv7 (RFC 9562) — lexicographic sort matches mint order. */
export function mintAnchor(): string {
  const ms = Date.now();
  const rand = randomBytes(10);
  const buf = Buffer.alloc(16);
  buf[0] = (ms / 2 ** 40) & 0xff;
  buf[1] = (ms / 2 ** 32) & 0xff;
  buf[2] = (ms / 2 ** 24) & 0xff;
  buf[3] = (ms / 2 ** 16) & 0xff;
  buf[4] = (ms / 2 ** 8) & 0xff;
  buf[5] = ms & 0xff;
  buf[6] = 0x70 | (rand[0] & 0x0f); // version 7
  buf[7] = rand[1];
  buf[8] = 0x80 | (rand[2] & 0x3f); // variant 10
  buf[9] = rand[3];
  rand.subarray(4, 10).copy(buf, 10);
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const mintTriggerId = mintAnchor;

/**
 * Detects opencode_event records whose part is `text` or `reasoning` — the
 * user-visible message body we must never lose. Tool inputs/outputs can run
 * arbitrarily large (file reads, big JSON payloads) and still get capped;
 * text/reasoning bypass the cap unconditionally.
 */
function isTextOrReasoningOpencodeEvent(record: Record<string, unknown>): boolean {
  if (record.type !== "opencode_event") return false;
  const event = record.event;
  if (!event || typeof event !== "object") return false;
  const properties = (event as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return false;
  const part = (properties as { part?: unknown }).part;
  if (!part || typeof part !== "object") return false;
  const partType = (part as { type?: unknown }).type;
  return partType === "text" || partType === "reasoning";
}

function capRecord<T extends Record<string, unknown>>(record: T): T & { _truncated?: true } {
  let candidate: Record<string, unknown> = { ...record };
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") < MAX_RECORD_BYTES)
    return candidate as T;

  // Never truncate text/reasoning parts — long assistant replies or thinking
  // chains exceed 4 KB legitimately, and the debugging UI needs them whole.
  if (isTextOrReasoningOpencodeEvent(candidate)) return candidate as T;

  // Try schema-driven projection first for opencode events: keeps the render
  // skeleton (event type, part type, tool, callID, status) and replaces large
  // leaves with { _omitted: true, bytes: N } markers. If the schema rejects
  // the shape, fall through to the generic truncation envelope below.
  if (record.type === "opencode_event" && "event" in candidate) {
    const projected =
      projectOpencodeEvent(candidate.event) ??
      projectOpencodeEvent(candidate.event, { threshold: 0 });
    if (projected) {
      const next: Record<string, unknown> = {
        schemaVersion: 1,
        ts: String(record.ts),
        type: "opencode_event",
        event: projected,
        _truncated: true,
      };
      if (Buffer.byteLength(JSON.stringify(next), "utf8") < MAX_RECORD_BYTES) {
        return next as T & { _truncated?: true };
      }
      // Projected skeleton still too large (extremely unusual — would need
      // many fields each just under the marker threshold). Fall through to
      // the generic envelope.
    }
  }

  if ("event" in candidate) candidate.event = { _truncated: true };
  if ("payload" in candidate) candidate.payload = { _truncated: true };
  candidate._truncated = true;

  if (record.type === "trigger_start") {
    candidate = {
      schemaVersion: 1,
      ts: String(record.ts),
      type: "trigger_start",
      triggerId: String(record.triggerId),
      ...(typeof record.correlationKey === "string"
        ? { correlationKey: record.correlationKey }
        : {}),
      _truncated: true,
    };
  } else if (record.type === "trigger_end") {
    candidate = {
      schemaVersion: 1,
      ts: String(record.ts),
      type: "trigger_end",
      triggerId: String(record.triggerId),
      status: record.status,
      ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
      ...(typeof record.error === "string" ? { error: truncate(record.error, 512) } : {}),
      ...(typeof record.reason === "string" ? { reason: truncate(record.reason, 512) } : {}),
      _truncated: true,
    };
  } else if (record.type === "tool_call") {
    candidate = {
      schemaVersion: 1,
      ts: String(record.ts),
      type: "tool_call",
      ...(typeof record.callId === "string" ? { callId: record.callId } : {}),
      tool: String(record.tool),
      payload: { _truncated: true },
      _truncated: true,
    };
  } else if (record.type === "alias") {
    candidate = {
      schemaVersion: 1,
      ts: String(record.ts),
      type: "alias",
      aliasType: record.aliasType,
      aliasValue: String(record.aliasValue),
      anchorId: String(record.anchorId),
      _truncated: true,
    };
  }

  while (Buffer.byteLength(JSON.stringify(candidate), "utf8") >= MAX_RECORD_BYTES) {
    if (candidate.type === "trigger_end") {
      if (typeof candidate.error === "string" && candidate.error.length > 32) {
        candidate.error = truncate(
          candidate.error,
          Math.max(32, Math.floor(candidate.error.length / 2)),
        );
        continue;
      }
      if (typeof candidate.reason === "string" && candidate.reason.length > 32) {
        candidate.reason = truncate(
          candidate.reason,
          Math.max(32, Math.floor(candidate.reason.length / 2)),
        );
        continue;
      }
    }
    if (candidate.type === "tool_call") {
      delete candidate.callId;
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") < MAX_RECORD_BYTES) break;
    }
    throw new Error(
      `Unable to cap oversized ${String(record.type)} record without losing required fields`,
    );
  }
  return candidate as T & { _truncated?: true };
}

export function appendSessionEvent(
  sessionId: string,
  record: Record<string, unknown>,
): { ok: true } | { ok: false; error: Error } {
  try {
    const full = capRecord({
      schemaVersion: 1,
      ts: new Date().toISOString(),
      ...record,
    });
    const parsed = SessionEventLogRecordSchema.parse(full);
    appendJsonlFileOrThrow(sessionLogPath(sessionId), parsed);
    sessionRecordsCache.delete(sessionId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Append an alias binding to the global aliases.jsonl. The reverse map updates
 * incrementally for the new record; full rebuild is deferred to the next
 * size-signature miss.
 */
export function appendAlias(
  record: Omit<AliasRecord, "ts"> & { ts?: string },
): { ok: true } | { ok: false; error: Error } {
  try {
    const alias = AliasRecordSchema.parse({ ts: new Date().toISOString(), ...record });
    appendJsonlFileOrThrow(aliasLogPath(), alias);
    applyAliasToCache(alias);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function completeLines(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  return lines.filter((line) => line.length > 0);
}

function fileStat(path: string): { signature: string; size: number } | null {
  try {
    const stat = statSync(path);
    return { signature: `${stat.size}:${stat.mtimeMs}`, size: stat.size };
  } catch {
    return null;
  }
}

function readSessionRecords(sessionId: string): {
  records: SessionEventLogRecord[];
  skippedMalformed: number;
  oversized?: true;
} {
  const path = sessionLogPath(sessionId);
  const stat = fileStat(path);
  const signature = stat?.signature ?? "missing";
  const cached = sessionRecordsCache.get(sessionId);
  if (cached && cached.signature === signature) {
    return cached.oversized
      ? { records: [], skippedMalformed: cached.skippedMalformed, oversized: true }
      : { records: cached.records, skippedMalformed: cached.skippedMalformed };
  }
  if (!stat) {
    sessionRecordsCache.set(sessionId, {
      signature,
      records: [],
      skippedMalformed: 0,
      oversized: false,
    });
    return { records: [], skippedMalformed: 0 };
  }
  if (stat.size > MAX_SESSION_FILE_BYTES) {
    sessionRecordsCache.set(sessionId, {
      signature,
      records: [],
      skippedMalformed: 0,
      oversized: true,
    });
    return { records: [], skippedMalformed: 0, oversized: true };
  }
  let skippedMalformed = 0;
  const records: SessionEventLogRecord[] = [];
  for (const line of completeLines(path)) {
    try {
      const parsed = SessionEventLogRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
      else skippedMalformed++;
    } catch {
      skippedMalformed++;
    }
  }
  sessionRecordsCache.set(sessionId, { signature, records, skippedMalformed, oversized: false });
  return { records, skippedMalformed };
}

export function readTriggerSlice(
  sessionId: string,
  triggerId: string,
): TriggerSlice | { notFound: true; skippedMalformed: number } | { oversized: true } {
  const read = readSessionRecords(sessionId);
  if (read.oversized) return { oversized: true };
  const startIndex = read.records.findIndex(
    (r) => r.type === "trigger_start" && r.triggerId === triggerId,
  );
  if (startIndex === -1) return { notFound: true, skippedMalformed: read.skippedMalformed };

  const records: SessionEventLogRecord[] = [];
  for (let i = startIndex; i < read.records.length; i++) {
    const record = read.records[i];
    if (i > startIndex && record.type === "trigger_start" && record.triggerId !== triggerId) {
      return {
        records,
        status: "crashed",
        reason: `superseded by ${record.triggerId}`,
        lastEventTs: records.at(-1)?.ts,
        skippedMalformed: read.skippedMalformed,
      };
    }
    records.push(record);
    if (record.type === "trigger_end" && record.triggerId === triggerId) {
      return {
        records,
        status: record.status,
        reason: record.reason ?? record.error,
        lastEventTs: record.ts,
        skippedMalformed: read.skippedMalformed,
      };
    }
  }
  return {
    records,
    status: "in_flight",
    lastEventTs: records.at(-1)?.ts,
    skippedMalformed: read.skippedMalformed,
  };
}

function emptyReverseEntry(): InternalReverseEntry {
  return { sessions: new Map(), subsessions: new Set(), externalKeys: new Set() };
}

function ensureReverseEntry(anchorId: string): InternalReverseEntry {
  let entry = aliasCache.reverse.get(anchorId);
  if (!entry) {
    entry = emptyReverseEntry();
    aliasCache.reverse.set(anchorId, entry);
  }
  return entry;
}

function externalKeyEncoded(aliasType: AliasRecord["aliasType"], aliasValue: string): string {
  return `${aliasType}\0${aliasValue}`;
}

function applyAliasRecord(r: AliasRecord): void {
  const aliasKey = externalKeyEncoded(r.aliasType, r.aliasValue);
  const previousAnchorId = aliasCache.forward.get(aliasKey);
  aliasCache.forward.set(aliasKey, r.anchorId);

  if (previousAnchorId && previousAnchorId !== r.anchorId) {
    const old = aliasCache.reverse.get(previousAnchorId);
    if (old) {
      if (r.aliasType === "opencode.session") old.sessions.delete(r.aliasValue);
      else if (r.aliasType === "opencode.subsession") old.subsessions.delete(r.aliasValue);
      else old.externalKeys.delete(aliasKey);
    }
  }

  const entry = ensureReverseEntry(r.anchorId);
  if (r.aliasType === "opencode.session") {
    const existingTs = entry.sessions.get(r.aliasValue);
    if (existingTs === undefined || existingTs < r.ts) entry.sessions.set(r.aliasValue, r.ts);
  } else if (r.aliasType === "opencode.subsession") {
    entry.subsessions.add(r.aliasValue);
  } else {
    entry.externalKeys.add(aliasKey);
  }
}

function applyAliasToCache(alias: AliasRecord): void {
  loadAliasCacheIfChanged();
  applyAliasRecord(alias);

  // statSync mtime may round to the same ms after appendFileSync; bumping to
  // the current size keeps loadAliasCacheIfChanged from doing a redundant
  // rebuild on the next read.
  try {
    aliasCacheLastSize = statSync(aliasLogPath()).size;
  } catch {
    // best-effort
  }
}

function loadAliasCacheIfChanged(): void {
  const path = aliasLogPath();
  let currentSize = 0;
  try {
    currentSize = statSync(path).size;
  } catch {
    // missing file → treat as size 0
  }
  if (currentSize === aliasCacheLastSize) return;
  aliasCache.forward.clear();
  aliasCache.reverse.clear();
  if (currentSize > 0) {
    for (const line of completeLines(path)) {
      try {
        const parsed = AliasRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) applyAliasRecord(parsed.data);
      } catch {
        // ignored: malformed alias records are not routing facts
      }
    }
  }
  aliasCacheLastSize = currentSize;
}

function pickNewestSession(entry: InternalReverseEntry): string | undefined {
  let bestId: string | undefined;
  let bestTs = "";
  // `>=` so that ties on `ts` (sub-ms appends) break in favor of the
  // later-inserted entry, matching append-only file order.
  for (const [id, ts] of entry.sessions) {
    if (ts >= bestTs) {
      bestTs = ts;
      bestId = id;
    }
  }
  return bestId;
}

export function resolveAlias(input: {
  aliasType: AliasRecord["aliasType"];
  aliasValue: string;
}): string | undefined {
  loadAliasCacheIfChanged();
  return aliasCache.forward.get(externalKeyEncoded(input.aliasType, input.aliasValue));
}

export function reverseLookupAnchor(anchorId: string): ReverseAnchorEntry {
  loadAliasCacheIfChanged();
  const entry = aliasCache.reverse.get(anchorId);
  if (!entry) return { sessionIds: [], subsessionIds: [], externalKeys: [] };
  return reverseAnchorEntryFromCache(entry);
}

function reverseAnchorEntryFromCache(entry: InternalReverseEntry): ReverseAnchorEntry {
  return {
    sessionIds: [...entry.sessions.keys()],
    subsessionIds: [...entry.subsessions],
    externalKeys: [...entry.externalKeys].map((encoded) => {
      const sep = encoded.indexOf("\0");
      return {
        aliasType: encoded.slice(0, sep) as AliasRecord["aliasType"],
        aliasValue: encoded.slice(sep + 1),
      };
    }),
    currentSessionId: pickNewestSession(entry),
  };
}

export function listAnchors(): Array<{ anchorId: string; entry: ReverseAnchorEntry }> {
  loadAliasCacheIfChanged();
  return [...aliasCache.reverse.keys()].map((anchorId) => ({
    anchorId,
    entry: reverseAnchorEntryFromCache(aliasCache.reverse.get(anchorId) ?? emptyReverseEntry()),
  }));
}

export function listSessionAliases(sessionId: string): AliasRecord[] {
  return readSessionRecords(sessionId).records.flatMap((record) =>
    record.type === "alias"
      ? [
          {
            ts: record.ts,
            aliasType: record.aliasType,
            aliasValue: record.aliasValue,
            anchorId: record.anchorId,
          },
        ]
      : [],
  );
}

function openTrigger(
  records: SessionEventLogRecord[],
): { triggerId: string; ts: string } | undefined {
  let open: { triggerId: string; ts: string } | undefined;
  for (const record of records) {
    if (record.type === "trigger_start") open = { triggerId: record.triggerId, ts: record.ts };
    if (record.type === "trigger_end" && record.triggerId === open?.triggerId) open = undefined;
  }
  return open;
}

interface SessionOpenSummary {
  triggerId: string;
  startedAt: string;
  lastEventTs: string;
}

interface SessionTerminalSummary {
  triggerId: string;
  status: Exclude<TriggerSliceStatus, "in_flight">;
  ts: string;
  reason?: string;
}

function sessionSummary(sessionId: string):
  | {
      oversized?: false;
      skippedMalformed: number;
      open?: SessionOpenSummary;
      latestTerminal?: SessionTerminalSummary;
      lastEventTs?: string;
    }
  | { oversized: true; skippedMalformed: number } {
  const read = readSessionRecords(sessionId);
  if (read.oversized) return { oversized: true, skippedMalformed: read.skippedMalformed };

  let open: SessionOpenSummary | undefined;
  let latestTerminal: SessionTerminalSummary | undefined;
  let lastEventTs: string | undefined;

  for (const record of read.records) {
    lastEventTs = record.ts;
    if (record.type === "trigger_start") {
      if (open) {
        latestTerminal = {
          triggerId: open.triggerId,
          status: "crashed",
          ts: open.lastEventTs,
          reason: `superseded by ${record.triggerId}`,
        };
      }
      open = { triggerId: record.triggerId, startedAt: record.ts, lastEventTs: record.ts };
      continue;
    }
    if (open) open.lastEventTs = record.ts;
    if (record.type === "trigger_end" && record.triggerId === open?.triggerId) {
      latestTerminal = {
        triggerId: record.triggerId,
        status: record.status,
        ts: record.ts,
        reason: record.reason ?? record.error,
      };
      open = undefined;
    }
  }

  return { skippedMalformed: read.skippedMalformed, open, latestTerminal, lastEventTs };
}

function parseRecordTs(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function listAnchorSessionStates(
  options: ListAnchorSessionStatesOptions = {},
): AnchorSessionState[] {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const stuckAfterMs = options.stuckAfterMs ?? 5 * 60 * 1000;
  const limit = options.limit ?? 100;

  const rows = listAnchors().map(({ anchorId, entry }): AnchorSessionState => {
    let skippedMalformed = 0;
    let oversized = false;
    let bestOpen: (SessionOpenSummary & { sessionId: string }) | undefined;
    let latestTerminal: (SessionTerminalSummary & { sessionId: string }) | undefined;
    let lastEventTs: string | undefined;
    const readErrors: string[] = [];

    for (const sessionId of entry.sessionIds) {
      let summary: ReturnType<typeof sessionSummary>;
      try {
        summary = sessionSummary(sessionId);
      } catch (err) {
        readErrors.push(`${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      skippedMalformed += summary.skippedMalformed;
      if (summary.oversized) {
        oversized = true;
        continue;
      }
      if (summary.lastEventTs && (!lastEventTs || summary.lastEventTs > lastEventTs)) {
        lastEventTs = summary.lastEventTs;
      }
      if (summary.open && (!bestOpen || summary.open.startedAt > bestOpen.startedAt)) {
        bestOpen = { ...summary.open, sessionId };
      }
      if (
        summary.latestTerminal &&
        (!latestTerminal || summary.latestTerminal.ts > latestTerminal.ts)
      ) {
        latestTerminal = { ...summary.latestTerminal, sessionId };
      }
    }

    if (oversized || readErrors.length > 0) {
      return {
        anchorId,
        status: "unknown",
        currentSessionId: entry.currentSessionId,
        ownerSessionId: bestOpen?.sessionId ?? latestTerminal?.sessionId,
        triggerId: bestOpen?.triggerId ?? latestTerminal?.triggerId,
        triggerStartedAt: bestOpen?.startedAt,
        externalKeys: entry.externalKeys,
        sessionIds: entry.sessionIds,
        subsessionIds: entry.subsessionIds,
        skippedMalformed,
        oversized,
        reason: [
          oversized ? "one or more session logs exceeded the configured size cap" : null,
          ...readErrors,
        ]
          .filter(Boolean)
          .join("; "),
        lastEventTs: bestOpen?.lastEventTs ?? latestTerminal?.ts ?? lastEventTs,
      };
    }

    if (bestOpen) {
      const startedAtMs = parseRecordTs(bestOpen.startedAt);
      const lastEventMs = parseRecordTs(bestOpen.lastEventTs);
      if (startedAtMs === undefined || lastEventMs === undefined) {
        return {
          anchorId,
          status: "unknown",
          currentSessionId: entry.currentSessionId,
          ownerSessionId: bestOpen.sessionId,
          triggerId: bestOpen.triggerId,
          triggerStartedAt: bestOpen.startedAt,
          lastEventTs: bestOpen.lastEventTs,
          externalKeys: entry.externalKeys,
          sessionIds: entry.sessionIds,
          subsessionIds: entry.subsessionIds,
          skippedMalformed,
          oversized: false,
          reason: "invalid trigger timestamp in session log",
        };
      }
      const idleMs = Math.max(0, nowMs - lastEventMs);
      return {
        anchorId,
        status: idleMs > stuckAfterMs ? "stuck" : "in_progress",
        currentSessionId: entry.currentSessionId,
        ownerSessionId: bestOpen.sessionId,
        triggerId: bestOpen.triggerId,
        triggerStartedAt: bestOpen.startedAt,
        lastEventTs: bestOpen.lastEventTs,
        ageMs: Math.max(0, nowMs - startedAtMs),
        idleMs,
        externalKeys: entry.externalKeys,
        sessionIds: entry.sessionIds,
        subsessionIds: entry.subsessionIds,
        skippedMalformed,
        oversized: false,
      };
    }

    const idleReferenceTs = latestTerminal?.ts ?? lastEventTs;
    const idleReferenceMs = parseRecordTs(idleReferenceTs);
    if (idleReferenceTs && idleReferenceMs === undefined) {
      return {
        anchorId,
        status: "unknown",
        currentSessionId: entry.currentSessionId,
        ownerSessionId: latestTerminal?.sessionId,
        triggerId: latestTerminal?.triggerId,
        lastEventTs: idleReferenceTs,
        latestTerminalStatus: latestTerminal?.status,
        externalKeys: entry.externalKeys,
        sessionIds: entry.sessionIds,
        subsessionIds: entry.subsessionIds,
        skippedMalformed,
        oversized: false,
        reason: "invalid terminal timestamp in session log",
      };
    }

    return {
      anchorId,
      status: "idle",
      currentSessionId: entry.currentSessionId,
      ownerSessionId: latestTerminal?.sessionId,
      triggerId: latestTerminal?.triggerId,
      lastEventTs: idleReferenceTs,
      idleMs: idleReferenceMs !== undefined ? Math.max(0, nowMs - idleReferenceMs) : undefined,
      latestTerminalStatus: latestTerminal?.status,
      externalKeys: entry.externalKeys,
      sessionIds: entry.sessionIds,
      subsessionIds: entry.subsessionIds,
      skippedMalformed,
      oversized: false,
      reason: latestTerminal?.reason,
    };
  });

  const rank: Record<AnchorSessionStatus, number> = {
    stuck: 0,
    in_progress: 1,
    unknown: 2,
    idle: 3,
  };
  return rows
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] || (b.lastEventTs ?? "").localeCompare(a.lastEventTs ?? ""),
    )
    .slice(0, limit);
}

/**
 * Resolve the request session's anchor, then scan every opencode.session bound
 * to that anchor for an unclosed trigger_start. Sub-sessions don't carry their
 * own trigger_start so they're excluded from the scan. When multiple bound
 * sessions each have an open trigger (an orphan from a runner crash or stale
 * recreate alongside a new live trigger), the newest-by-`trigger_start.ts`
 * wins — the same supersede-by-newest semantics readTriggerSlice uses inside
 * a single session.
 */
export function findActiveTrigger(requestSessionId: string): ActiveTriggerResult {
  const anchorId =
    resolveAlias({ aliasType: "opencode.session", aliasValue: requestSessionId }) ??
    resolveAlias({ aliasType: "opencode.subsession", aliasValue: requestSessionId });
  if (!anchorId) return { ok: false, reason: "none" };

  const reverse = reverseLookupAnchor(anchorId);
  let best: { sessionId: string; triggerId: string; ts: string } | undefined;
  for (const sessionId of reverse.sessionIds) {
    const read = readSessionRecords(sessionId);
    if (read.oversized) return { ok: false, reason: "oversized" };
    const open = openTrigger(read.records);
    if (!open) continue;
    if (!best || open.ts > best.ts) best = { sessionId, ...open };
  }
  if (!best) return { ok: false, reason: "none" };
  return { ok: true, anchorId, sessionId: best.sessionId, triggerId: best.triggerId };
}

export function currentSessionForAnchor(anchorId: string): string | undefined {
  loadAliasCacheIfChanged();
  const entry = aliasCache.reverse.get(anchorId);
  if (!entry || entry.sessions.size === 0) return undefined;
  return pickNewestSession(entry);
}
