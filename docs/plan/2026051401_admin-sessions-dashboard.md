# Admin Sessions Dashboard

**Date**: 2026-05-14
**Status**: Draft
**Depends on**: `docs/plan/2026042001_admin-webapp.md`, `docs/plan/2026043001_session-event-log.md`, `docs/plan/2026050501_prebind-correlation-anchors.md`

## Goal

Add an operator dashboard to the existing admin surface that shows per-anchor session state, with a clear split between currently in-progress and likely-stuck work. The dashboard must reuse the append-only session event logs and alias/anchor model; no database, sidecar state file, or new queue is introduced.

## Scope

In scope:

- New read-only admin route at `/admin/sessions` plus an htmx-polled fragment endpoint.
- A shared, testable state-derivation helper over `aliases.jsonl` and `sessions/<session-id>.jsonl`.
- Per-anchor rows with current session, bound external keys, latest trigger, age, last event, status, and viewer link when possible.
- Targeted unit tests for state derivation and admin rendering/route behavior.

Out of scope:

- Killing, retrying, or otherwise mutating sessions from the dashboard.
- A persistent status index, retention/janitor work, or log compaction.
- Exact liveness from OpenCode process APIs. In v1, “stuck” is derived from event-log silence and remains a likely-stuck operator signal, not proof of process death.

## Route shape

| Route | Purpose |
| --- | --- |
| `GET /admin/sessions` | Full dashboard page with nav back to config, signed-in user metadata, summary cards, and initial table. |
| `GET /admin/sessions/fragment` | HTML fragment polled by htmx every 10s; returns summary + table only. |
| `GET /admin/config` | Existing config editor; add a small nav link to sessions. |
| Admin catch-all | Keep redirect behavior, but redirect to `/admin/config` as today unless a later navigation plan changes the admin landing page. |

The admin app remains behind nginx/vouch. The sessions page is read-only and does not require additional auth or CSRF handling because it performs no writes.

## Data derivation and state algorithm

Add a common helper, tentatively `listAnchorSessionStates({ now, stuckAfterMs, limit })`, near the existing event-log readers so admin and future diagnostics do not duplicate log parsing.

1. Load the existing alias log and build a reverse anchor view for every anchor that has at least one `opencode.session`, `opencode.subsession`, or external key.
   - If the current reverse cache cannot enumerate anchors, extend `@thor/common/event-log.ts` with an exported enumeration helper instead of adding a second parser in admin.
   - Preserve the existing malformed-line behavior: skip invalid alias records and surface skipped counts if cheap to expose.
2. For each anchor, inspect all bound `opencode.session` ids using the same bounded session-file reader rules already used by `readTriggerSlice` and `findActiveTrigger`.
3. For each session, walk records chronologically:
   - `trigger_start` opens/replaces that session's current trigger.
   - Matching `trigger_end` closes it with `completed`, `error`, or `aborted`.
   - A later different `trigger_start` without a close marker marks the earlier trigger as `crashed/superseded`, matching the existing viewer semantics.
   - Track `lastEventTs`, record count, skipped malformed count, and oversized state.
4. Derive the anchor status:
   - `in_progress`: newest open trigger across bound sessions has a last event newer than `now - stuckAfterMs`.
   - `stuck`: newest open trigger has no terminal marker and its last event is older than `stuckAfterMs`.
   - `idle`: no open trigger; include latest terminal status for diagnostics.
   - `unknown`: any needed session log is oversized or unreadable enough that status cannot be trusted.
5. Choose display fields:
   - `anchorId`, `currentSessionId` from existing newest-session binding semantics.
   - `ownerSessionId` for the open/latest trigger, because viewer links must use the session that owns the `trigger_start`.
   - `triggerId`, `triggerStartedAt`, `lastEventTs`, `ageMs`, `idleMs`, `externalKeys`, `sessionIds`, `subsessionIds`, `skippedMalformed`, and optional `reason`.
   - Viewer URL: `/runner/v/<anchorId>` for each anchor row, with `/runner/v/<anchorId>/t/<triggerId>` as an optional exact-trigger deep link.
6. Sort rows by severity and recency: `stuck` first, then `in_progress`, then `unknown`, then recent `idle`; within each group, newest `lastEventTs` first. Apply a conservative default limit (for example 100 anchors) to keep the page bounded.

Use a local constant `STUCK_AFTER_MS = 5 * 60 * 1000` initially to match the trigger viewer's existing soft stale threshold. Do not add a new environment variable unless operators need runtime tuning during implementation.

## UI shape

- Keep the existing server-rendered Express + htmx style; no frontend build or new dependency.
- Add a lightweight admin layout/nav shared by config and sessions pages if it stays small.
- Top summary cards: `Stuck`, `In progress`, `Idle`, `Unknown`, and `Last refreshed`.
- Main table columns:
  - Status badge (`stuck`, `in progress`, `idle`, `unknown`).
  - Anchor id, shortened with full id in `title`.
  - Current session and owner session when different.
  - External keys (`slack.thread_id`, `git.branch`) rendered as compact chips.
  - Trigger id / viewer link.
  - Started, last event, age/idle time.
  - Diagnostics: session count, subsession count, skipped malformed, oversized flag/reason.
- Empty state: explain that no anchors have been recorded yet and point to the worklog paths.
- Error state: render a non-fatal banner if the dashboard cannot read logs, while preserving any partial rows that were derived.

## Phases

### Phase 1 — Shared session-state reader

Files:

- `packages/common/src/event-log.ts`
- `packages/common/src/index.ts`
- `packages/common/src/event-log.test.ts`

Work:

- Export an anchor enumeration/state helper over existing alias and session-log readers.
- Reuse current validation, size caps, partial-line tolerance, malformed-line skipping, and newest-open-trigger semantics.
- Return plain serializable DTOs so the admin package can render without touching internal caches.

Exit criteria:

- Tests cover idle, in-progress, stuck-by-age, superseded/crashed, multiple sessions on one anchor with newest open trigger winning, malformed lines, and oversized logs.
- `pnpm typecheck` passes.

### Phase 2 — Admin routes and rendering

Files:

- `packages/admin/src/app.ts`
- `packages/admin/src/views.ts`
- new `packages/admin/src/app.test.ts` if no admin HTTP tests exist yet

Work:

- Add `/admin/sessions` and `/admin/sessions/fragment`.
- Add summary cards, table rendering, empty/error states, and config↔sessions nav.
- Keep `/admin/config` behavior intact.

Exit criteria:

- Route tests prove full page renders, fragment renders without full document chrome, nav appears on config, status badges are escaped/safe, and catch-all redirect remains unchanged.
- Targeted admin tests pass.

### Phase 3 — Integration polish and verification

Files:

- Update docs only if implementation discovers non-obvious decisions.
- Optional fixture/script under `scripts/` only if manual dashboard verification needs repeatable sample logs.

Work:

- Seed a scratch worklog with one stuck, one in-progress, one idle, and one malformed/unknown example and verify the page manually.
- Run package and workspace checks.

Exit criteria:

- `pnpm test` passes.
- `pnpm typecheck` passes.
- Manual `GET /admin/sessions` and `GET /admin/sessions/fragment` against scratch logs show the expected counts and rows.
- If Docker/admin image behavior changes, `docker build --target admin` succeeds; otherwise no Docker verification is required.

## Decision Log

| # | Decision | Rationale | Rejected |
| --- | --- | --- | --- |
| 1 | Reuse session event logs and aliases; no DB or sidecar index | Matches the existing source of truth and keeps v1 operationally simple. | SQLite/status JSON cache |
| 2 | “Stuck” means open trigger with stale last event | Event logs cannot prove process death, but silence past the existing 5-minute viewer warning is the operator signal needed for triage. | Mark all unclosed triggers as stuck; require OpenCode process liveness |
| 3 | Put derivation in `@thor/common` | The state algorithm is domain logic over anchors/logs and should be testable without Express. | Parse logs directly in admin views |
| 4 | htmx polling fragment | Consistent with existing admin UI and avoids a frontend build. | SPA, websocket/SSE for v1 |

## Verification checklist

- `pnpm --filter @thor/common typecheck`
- `pnpm --filter @thor/admin typecheck`
- Targeted `vitest` tests for common/admin files
- `pnpm test`
- `pnpm typecheck`
- Manual scratch-log dashboard check for stuck/in-progress/idle/unknown rows
