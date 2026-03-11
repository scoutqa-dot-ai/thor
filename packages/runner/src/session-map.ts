/**
 * Session map — maps correlation keys to OpenCode session IDs.
 *
 * Persisted as a JSON file so sessions survive container restarts.
 * The file is stored in the worklog directory alongside other state.
 *
 * Format:
 *   { "slack:thread:123": { "sessionId": "abc-def", "createdAt": "...", "lastUsedAt": "..." }, ... }
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLogger, logInfo, logError } from "@thor/common";

const log = createLogger("session-map");

const WORKLOG_DIR = process.env.WORKLOG_DIR || "/workspace/worklog";
const MAP_FILE = join(WORKLOG_DIR, "session-map.json");

export interface SessionMapEntry {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

type SessionMap = Record<string, SessionMapEntry>;

let cache: SessionMap | null = null;

function load(): SessionMap {
  if (cache) return cache;
  try {
    const raw = readFileSync(MAP_FILE, "utf-8");
    cache = JSON.parse(raw) as SessionMap;
    logInfo(log, "session_map_loaded", { entries: Object.keys(cache).length });
    return cache;
  } catch {
    cache = {};
    return cache;
  }
}

function save(map: SessionMap): void {
  try {
    mkdirSync(dirname(MAP_FILE), { recursive: true });
    writeFileSync(MAP_FILE, JSON.stringify(map, null, 2) + "\n");
    cache = map;
  } catch (err) {
    logError(log, "session_map_save_failed", err);
  }
}

/**
 * Look up the session ID for a correlation key.
 * Returns undefined if the key is not mapped.
 */
export function getSession(correlationKey: string): SessionMapEntry | undefined {
  const map = load();
  return map[correlationKey];
}

/**
 * Store a mapping from correlation key to session ID.
 */
export function setSession(correlationKey: string, sessionId: string): void {
  const map = load();
  const now = new Date().toISOString();
  if (map[correlationKey]) {
    map[correlationKey].sessionId = sessionId;
    map[correlationKey].lastUsedAt = now;
  } else {
    map[correlationKey] = { sessionId, createdAt: now, lastUsedAt: now };
  }
  save(map);
  logInfo(log, "session_mapped", { correlationKey, sessionId });
}

/**
 * Update the lastUsedAt timestamp for a correlation key.
 */
export function touchSession(correlationKey: string): void {
  const map = load();
  if (map[correlationKey]) {
    map[correlationKey].lastUsedAt = new Date().toISOString();
    save(map);
  }
}

/**
 * Remove a mapping (e.g. when the session no longer exists upstream).
 */
export function removeSession(correlationKey: string): void {
  const map = load();
  delete map[correlationKey];
  save(map);
  logInfo(log, "session_removed", { correlationKey });
}

/**
 * Get all current mappings (for the GET /sessions endpoint).
 */
export function listSessions(): Record<string, SessionMapEntry> {
  return JSON.parse(JSON.stringify(load()));
}

/**
 * Clear all mappings (for demo reset).
 */
export function clearSessions(): void {
  save({});
  logInfo(log, "session_map_cleared");
}
