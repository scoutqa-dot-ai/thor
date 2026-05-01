import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { getWorklogDir } from "./worklog.js";

export const ALIAS_TYPES = ["slack.thread_id", "git.branch", "session.parent"] as const;
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

const BaseRecordSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.string(),
  type: z.string(),
  sessionId: z.string(),
});

export const TriggerStartRecordSchema = BaseRecordSchema.extend({
  type: z.literal("trigger_start"),
  triggerId: z.string().uuid(),
  correlationKey: z.string().optional(),
  promptPreview: z.string().optional(),
});

export const TriggerEndRecordSchema = BaseRecordSchema.extend({
  type: z.literal("trigger_end"),
  triggerId: z.string().uuid(),
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
  sessionId: z.string(),
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
  | { ok: true; sessionId: string; triggerId: string }
  | { ok: false; reason: "none" | "depth_exceeded" | "cycle" | "oversized" };

const MAX_RECORD_BYTES = 4095;
export const MAX_SESSION_FILE_BYTES = Number.parseInt(
  process.env.SESSION_LOG_MAX_BYTES || "52428800",
  10,
);
const PARENT_CHAIN_DEPTH_LIMIT = 5;
const aliasCache = new Map<string, string>();
let aliasCacheLoaded = false;
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

function capRecord<T extends Record<string, unknown>>(record: T): T & { _truncated?: true } {
  let candidate: Record<string, unknown> = { ...record };
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") < MAX_RECORD_BYTES)
    return candidate as T;

  if ("event" in candidate) candidate.event = { _truncated: true };
  if ("payload" in candidate) candidate.payload = { _truncated: true };
  candidate._truncated = true;

  while (Buffer.byteLength(JSON.stringify(candidate), "utf8") >= MAX_RECORD_BYTES) {
    const preview = JSON.stringify(candidate).slice(0, MAX_RECORD_BYTES - 200);
    candidate = {
      schemaVersion: 1,
      ts: String(record.ts),
      type: record.type,
      sessionId: record.sessionId,
      _truncated: true,
      preview,
    };
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
      sessionId,
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

export function appendAlias(
  record: Omit<AliasRecord, "ts"> & { ts?: string },
): { ok: true } | { ok: false; error: Error } {
  try {
    const alias = AliasRecordSchema.parse({ ts: new Date().toISOString(), ...record });
    appendJsonlFileOrThrow(aliasLogPath(), alias);
    aliasCache.set(`${alias.aliasType}\0${alias.aliasValue}`, alias.sessionId);
    aliasCacheLoaded = true;
    if (alias.aliasType !== "session.parent") {
      const audit = appendSessionEvent(alias.sessionId, {
        type: "alias",
        aliasType: alias.aliasType,
        aliasValue: alias.aliasValue,
      });
      if (!audit.ok) return audit;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function completeLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  return lines.filter((line) => line.length > 0);
}

function fileSignature(path: string): string {
  if (!existsSync(path)) return "missing";
  const stat = statSync(path);
  return `${stat.size}:${stat.mtimeMs}`;
}

function readSessionRecords(sessionId: string): {
  records: SessionEventLogRecord[];
  skippedMalformed: number;
  oversized?: true;
} {
  const path = sessionLogPath(sessionId);
  const signature = fileSignature(path);
  const cached = sessionRecordsCache.get(sessionId);
  if (cached && cached.signature === signature) {
    return cached.oversized
      ? { records: [], skippedMalformed: cached.skippedMalformed, oversized: true }
      : { records: cached.records, skippedMalformed: cached.skippedMalformed };
  }
  if (!existsSync(path)) {
    sessionRecordsCache.set(sessionId, {
      signature,
      records: [],
      skippedMalformed: 0,
      oversized: false,
    });
    return { records: [], skippedMalformed: 0 };
  }
  if (statSync(path).size > MAX_SESSION_FILE_BYTES) {
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
    if (
      i > startIndex &&
      record.type === "trigger_start" &&
      record.sessionId === sessionId &&
      record.triggerId !== triggerId
    ) {
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

function loadAliasCacheIfChanged(): void {
  const path = aliasLogPath();
  if (!existsSync(path)) {
    if (aliasCacheLastSize !== 0) {
      aliasCache.clear();
      aliasCacheLastSize = 0;
    }
    aliasCacheLoaded = true;
    return;
  }
  const size = statSync(path).size;
  if (aliasCacheLoaded && size === aliasCacheLastSize) return;
  aliasCache.clear();
  for (const line of completeLines(path)) {
    try {
      const parsed = AliasRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success)
        aliasCache.set(
          `${parsed.data.aliasType}\0${parsed.data.aliasValue}`,
          parsed.data.sessionId,
        );
    } catch {
      // ignored: malformed alias records are not routing facts
    }
  }
  aliasCacheLastSize = size;
  aliasCacheLoaded = true;
}

export function resolveAlias(input: {
  aliasType: AliasRecord["aliasType"];
  aliasValue: string;
}): string | undefined {
  loadAliasCacheIfChanged();
  return aliasCache.get(`${input.aliasType}\0${input.aliasValue}`);
}

export function listSessionAliases(sessionId: string): AliasRecord[] {
  return readSessionRecords(sessionId).records.flatMap((record) =>
    record.type === "alias"
      ? [{ ts: record.ts, aliasType: record.aliasType, aliasValue: record.aliasValue, sessionId }]
      : [],
  );
}

function openTrigger(records: SessionEventLogRecord[]): string | undefined {
  let open: string | undefined;
  for (const record of records) {
    if (record.type === "trigger_start") open = record.triggerId;
    if (record.type === "trigger_end" && record.triggerId === open) open = undefined;
  }
  return open;
}

export function findActiveTrigger(requestSessionId: string): ActiveTriggerResult {
  let current = requestSessionId;
  const visited = new Set<string>();
  for (let depth = 0; depth <= PARENT_CHAIN_DEPTH_LIMIT; depth++) {
    if (visited.has(current)) return { ok: false, reason: "cycle" };
    visited.add(current);
    const read = readSessionRecords(current);
    if (read.oversized) return { ok: false, reason: "oversized" };
    const open = openTrigger(read.records);
    if (open) return { ok: true, sessionId: current, triggerId: open };
    const parent = resolveAlias({ aliasType: "session.parent", aliasValue: current });
    if (!parent) return { ok: false, reason: "none" };
    current = parent;
  }
  return { ok: false, reason: "depth_exceeded" };
}
