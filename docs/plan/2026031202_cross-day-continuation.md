# Cross-Day Session Continuation

**Date**: 2026-03-12
**Status**: In Progress

## Problem

When a session from a previous day is triggered again today, `appendTrigger` and `appendSummary` find the old day's notes file via `findNotesFile()` and mutate it. Old day files should stay frozen.

## Approach: Roll-forward + Write-local (A+C)

- **Roll forward on resume**: When cross-day resume is detected, create today's notes file with session ID + back-reference to the previous day's file. Old file stays frozen.
- **All writes go to today's path**: `appendTrigger` and `appendSummary` write directly to `todayNotesPath()` — no `findNotesFile()` lookup on writes. Faster, and guarantees old files are never touched.

## Phases

### Phase 1: Core notes refactor

- Add `continueNotes()` — creates today's file with session ID, back-reference (`Previous: ../2026-03-10/notes/...`), and initial follow-up prompt
- Change `appendTrigger()` — write to `todayNotesPath()` directly, no-op if file missing
- Change `appendSummary()` — write to `todayNotesPath()` directly, no-op if file missing
- Use `appendFileSync` instead of read-then-write for append operations
- Export `continueNotes` from `@thor/common`
- Update runner: on resume, call `findNotesFile()` → `continueNotes()` instead of `appendTrigger()`
- Add cross-day test suite (6 tests)

**Exit criteria**:

- All 22 tests pass (`pnpm vitest run packages/common/src/notes.test.ts`)
- `@thor/common` type-checks clean (`pnpm --filter @thor/common typecheck`)
- Old notes files are never modified on cross-day resume (verified by tests)

## Decision Log

| #   | Decision                                        | Rationale                                                                        |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| D1  | `continueNotes` is no-op if today's file exists | Prevents duplicate roll-forwards from retries                                    |
| D2  | Back-reference uses relative path               | Portable across environments / bind mounts                                       |
| D3  | `appendFileSync` instead of read+write          | Simpler, avoids TOCTOU, faster for append-only                                   |
| D4  | Write functions no-op if today's file missing   | Caller must call `createNotes` or `continueNotes` first — explicit over implicit |

## Concurrency Analysis

The notes module has **no internal locking** — concurrency safety comes from the gateway's `EventQueue`.

### Why it's safe today

The `EventQueue` enforces **per-key serial processing** (`processing.has(key)` gate in `scan()`). For a given `correlationKey`, only one batch runs at a time, and the runner handles that batch in a single async request where `createNotes`/`continueNotes` → `appendSummary` execute sequentially.

Different correlation keys can process in parallel, but they write to **different files** (each key maps to its own `{sanitized-key}.md`), so there is no cross-key file contention.

### appendFileSync atomicity

On POSIX with `O_APPEND`, small writes (< PIPE_BUF = 4096 bytes) are atomic. Our note entries are well under that limit, so even hypothetical concurrent appends to the same file would not interleave.

### What would break this

If multiple runner instances are added (horizontal scaling) without the gateway queue serializing per-key, then:

- Two runners could race on `continueNotes` → one write silently overwrites the other
- `appendFileSync` interleaving becomes possible on non-POSIX or large entries

That scenario would require file locking or moving to a database — but it is not the current architecture and is out of scope.

## Out of Scope

- Updating stale session IDs in notes (since superseded by JSONL session aliases — see `2026043001_session-event-log.md`)
- Archiving old date directories / TTL rotation
- Multi-day notes chain traversal (reading back-references)
