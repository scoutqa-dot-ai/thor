# Inbound Event History (Durable JSONL)

**Date**: 2026-04-27
**Status**: Phase 1 complete; Phase 2 complete

## Goal

Add durable, append-only history capture for inbound Slack and GitHub webhook requests so operators can debug real payloads (including invalid signatures) from disk after the fact.

## Decision Log

| Date       | Decision                                                                                            | Why                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 2026-04-27 | Store inbound event history as day-partitioned JSONL under `/workspace/worklog/<day>/jsonl/*.jsonl` | Append-only files are durable, easy to inspect, and avoid per-event file explosion |
| 2026-04-27 | Keep writes best-effort (never throw) with stderr error logging                                     | Logging must not affect webhook response behavior                                  |
| 2026-04-27 | Read `WORKLOG_DIR` and `WORKLOG_ENABLED` at call time                                               | Tests and operators can steer logging behavior dynamically                         |
| 2026-04-27 | Parse `/slack/events` and `/github/webhook` with route-local raw parser and manual JSON decode      | Preserves exact request bytes and archives malformed JSON before parse failures    |
| 2026-04-27 | Use split GitHub streams (`github-webhook-ingested` / `github-webhook-ignored`) with final outcomes | Makes GitHub outcomes explicit and avoids ambiguous early `received` archive rows  |

## Phases

### Phase 1 — Shared durable JSONL writer in `@thor/common` ✅

Scope:

1. Create this plan document.
2. Extend `packages/common/src/worklog.ts` with a reusable append-only JSONL helper:
   - day partitioning: `<WORKLOG_DIR>/<YYYY-MM-DD>/jsonl/<stream>.jsonl`
   - best-effort/no-throw behavior
   - one JSON line per append
   - typed inbound webhook history entry for future gateway route usage
3. Export new helper/types from `packages/common/src/index.ts`.
4. Add unit tests validating same-file append and newline-delimited JSONL behavior.

Exit criteria:

- [x] New JSONL helper appends two entries to the same day stream file.
- [x] Output is newline-delimited JSON records (one JSON object per line).
- [x] Helper reads `WORKLOG_DIR`/`WORKLOG_ENABLED` at call time.
- [x] Inbound webhook history entry type exists with required fields for later route integration.

### Phase 2 — Gateway route integration ✅

Scope:

1. Wire Slack and GitHub inbound routes in `packages/gateway/src/app.ts` to emit inbound history entries.
2. Ensure raw payload bytes are preserved and logged for both valid and invalid signatures.
3. Add focused gateway tests for logging behavior and non-blocking error handling.

Exit criteria:

- [x] Inbound Slack/GitHub requests append history entries with route/provider/signature/parse metadata.
- [x] Invalid signature requests are still captured in history.
- [x] Gateway behavior and response codes remain unchanged by logging failures.

## Final Verification (after Phase 2)

1. Run unit tests and typecheck.
2. Push branch and validate required CI checks.
3. Open PR after checks pass.

## Out of Scope

- Retention, rotation, or pruning automation (operators manage retention manually).
- Any UI/reporting/query surface over the history files.
- Changes to event routing semantics beyond adding durable history capture.
