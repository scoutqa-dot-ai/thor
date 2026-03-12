# Session Mapping Refactor — 2026-03-12-01

> Eliminate `session-map.json` by deriving session mappings from existing worklog notes files. Add an archival tool to manage old worklog data and bound the search scope.

## Context

The runner currently maintains a separate `session-map.json` file that maps correlation keys to OpenCode session IDs. However, the notes files (`worklog/{date}/notes/{key}.md`) already contain the session ID in their header. This creates two sources of truth that can diverge.

OpenCode sessions have no custom metadata or tags — only `id`, `title`, and timestamps — so we cannot store the correlation key on the session object itself.

## Decision Log

| #   | Decision                                        | Rationale                                                                                                          |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D1  | **Derive session ID from notes files**          | Notes already contain `Session ID:` in the header. Eliminates separate state file and divergence risk.             |
| D2  | **Use `grep` for fast lookup across date dirs** | Single `grep -m1` call across `worklog/*/notes/{key}.md` is efficient and avoids manual directory iteration.       |
| D3  | **Archive old date directories as tar.gz**      | Zipped dirs are invisible to grep → natural TTL. Old sessions become unreachable, forcing new session creation.    |
| D4  | **Configurable retention window**               | Default 7 days of active notes. Older dirs get archived. Configurable via `WORKLOG_RETAIN_DAYS` env var.           |
| D5  | **Queue guarantees per-key serialization**      | `EventQueue.processing` Set prevents concurrent triggers for the same correlation key. No new concurrency issues.  |
| D6  | **Update notes header on session replacement**  | When a stale session is replaced, update `Session ID:` in the notes file so the next lookup finds the new session. |

## Phases

### Phase 1 — Replace session-map with notes-based lookup

**Goal**: Remove `session-map.json` and `session-map.ts`. Derive session IDs by reading the `Session ID:` line from notes files.

Steps:

1. Add a `getSessionIdFromNotes(correlationKey)` function in `@thor/common/notes.ts`:
   - Use `findNotesFile(correlationKey)` to locate the most recent notes file
   - Read the file and parse `Session ID: <id>` from the header
   - Return `sessionId` or `undefined`
2. Add an `updateSessionId(correlationKey, newSessionId)` function in `@thor/common/notes.ts`:
   - Find the notes file, replace the `Session ID:` line with the new ID
   - Used when a stale session is replaced with a new one
3. Update `runner/src/index.ts`:
   - Replace all `getSession()` / `setSession()` / `touchSession()` / `removeSession()` calls with notes-based equivalents
   - Session lookup: `getSessionIdFromNotes(correlationKey)`
   - Session create: `createNotes()` already writes session ID — no change
   - Stale session replace: `updateSessionId()` + `createNotes()` for new day
   - Remove `listSessions()` usage from GET `/sessions` endpoint (or derive from notes)
4. Delete `runner/src/session-map.ts` and `runner/src/session-map.test.ts`
5. Remove `session-map` imports from `runner/src/index.ts`

**Exit criteria**:

- `session-map.json` is no longer created or read
- `session-map.ts` is deleted
- Triggering with a correlation key still resumes the correct session (verified by the same secret-code e2e test)
- Notes file is the single source of truth for correlation key → session ID

---

### Phase 2 — Worklog archival tool _(DEFERRED)_

Deferred until we detect slowness in notes-based lookup. Will compress old date dirs to tar.gz to bound grep scope when needed.

---

### Phase 3 — Update tests and GET /sessions endpoint

**Goal**: Update unit tests and the sessions endpoint to work with the new notes-based lookup.

Steps:

1. Add unit tests for `getSessionIdFromNotes()` and `updateSessionId()` in `packages/common`
2. Update or replace GET `/sessions` endpoint:
   - Without `correlationKey`: scan active notes dirs, return all correlation keys with session IDs
   - With `correlationKey`: return the session ID from notes, or 404
3. Verify e2e tests still pass

**Exit criteria**:

- Unit tests cover: lookup hit, lookup miss, stale update, archived (missing) file
- GET `/sessions` returns data derived from notes files
- E2E secret-code recall test passes

---

## Out of Scope

- Database-backed session map (not needed — notes files are sufficient)
- Automatic scheduled archival (cron setup is deployment-specific)
- Cross-session search over archived data
- Changes to the notes file format beyond session ID header

## Dependencies

| Dependency                 | Version | Purpose                       | Status   |
| -------------------------- | ------- | ----------------------------- | -------- |
| `@thor/common`             | —       | Notes utilities (extended)    | Existing |
| No new dependencies needed | —       | grep/tar are system utilities | —        |
