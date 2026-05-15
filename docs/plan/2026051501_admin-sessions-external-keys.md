# Admin Sessions — Useful External Keys

**Date**: 2026-05-15
**Status**: Draft
**Depends on**: `docs/plan/2026051401_admin-sessions-dashboard.md`, `docs/plan/2026050501_prebind-correlation-anchors.md`

## Goal

Make the **External keys** column on `/admin/sessions` operator-useful:

- **Slack**: render a clickable link to the thread (desktop deep link + web fallback) instead of a bare `thread_ts`.
- **Git branch**: render the decoded `<repo> · <branch>` instead of a base64url blob.
- **GitHub issue**: render decoded `<repo>#<n>` linked to the issue page.

To do this for Slack we need both channel and thread id on the anchor. Today only `thread_ts` is persisted.

## Scope

In scope:

- New alias type `slack.thread` with value `<channel>/<thread_ts>` (unique per thread).
- New Slack correlation key shape `slack:thread:<channel>/<thread_ts>` alongside the existing `slack:thread:<thread_ts>`.
- Multi-key resolution at Slack ingest: try the new key first, fall back to legacy.
- Optional `SLACK_TEAM_ID` env var consumed only by the admin renderer.
- Admin chip rendering for `slack.thread`, `git.branch`, `github.issue`; hide legacy `slack.thread_id` chips when an anchor also has a `slack.thread` chip.

Out of scope:

- Migrating existing aliases. Legacy anchors keep their `slack.thread_id` binding; admin still displays them as a non-link "thread `<ts>`" chip. No automatic upgrade-in-place when a legacy thread is re-engaged — the new alias is only written for _fresh_ threads.
- Removing the `slack.thread_id` alias type from the schema. It stays in `ALIAS_TYPES` so existing `aliases.jsonl` lines keep parsing.
- Storing Slack team id on the anchor. Team is workspace-global; one env var is enough.

## Decisions

| Decision                | Choice                                                      | Why                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack alias value shape | `<channel>/<thread_ts>`                                     | `/` is not legal in Slack channel ids or message ts, so split is unambiguous. Unique per thread → no chip-stealing under the 1-to-1 reverse rule in `event-log.ts`. |
| Correlation key shape   | `slack:thread:<channel>/<thread_ts>`                        | Mirrors the alias value; trivial parse in `aliasForCorrelationKey`.                                                                                                 |
| Legacy resolution       | Multi-key via `resolveCorrelationKeys([newKey, legacyKey])` | Reuses the existing array API at `packages/gateway/src/app.ts:1241,1284`. Existing threads resolve under legacy; fresh threads pick the new key (it's first).       |
| Upgrade-in-place        | **Not done**                                                | Keeps the gateway path simple. Legacy anchors stay legacy; cost is they never get a Slack link in admin.                                                            |
| `SLACK_TEAM_ID`         | Optional                                                    | Without it, admin renders Slack chips as plain decoded text. Avoids forcing the env on dev setups that don't have Slack credentials.                                |
| Where the env is read   | Admin only                                                  | Gateway and runner don't need it.                                                                                                                                   |

## Phases

### Phase 1 — Schema + correlation plumbing

- `packages/common/src/event-log.ts`: add `"slack.thread"` to `ALIAS_TYPES`.
- `packages/common/src/correlation.ts`:
  - New constant `SLACK_THREAD_V2_PREFIX = "slack:thread:"` shared with legacy (the discriminator is whether the suffix contains `/`).
  - Extend `aliasForCorrelationKey`: if a `slack:thread:` key contains `/`, map to `slack.thread`; else to legacy `slack.thread_id`.
  - Export `buildSlackCorrelationKeys(channel, threadTs): string[]` → `[newKey, legacyKey]`.
- `packages/gateway/src/slack.ts`: replace `getSlackCorrelationKey` with `getSlackCorrelationKeys(event): string[]` returning both shapes.
- Unit tests:
  - `correlation.test.ts`: alias mapping for both shapes; `resolveCorrelationKeys` picks legacy when only legacy is bound, new when neither is bound.

**Exit**: `pnpm --filter @thor/common test` and `pnpm --filter @thor/gateway test` pass.

### Phase 2 — Gateway wiring

- `packages/gateway/src/app.ts:1240,1283`: replace the single `getSlackCorrelationKey(event)` call with `getSlackCorrelationKeys(event)` and pass the array to `resolveCorrelationKeys` / `hasSessionForCorrelationKey`.
- `hasSessionForCorrelationKey` only accepts a single key today. Either:
  - Extend it to accept `string | string[]` and check any, **or**
  - Call it twice in `app.ts`. Pick whichever is smaller; lean toward the helper extension since the multi-key shape is now the norm.
- Verify approval-outcome path (`packages/gateway/src/app.ts:600-672`) — if it constructs a Slack key, switch it to the same multi-key helper.

**Exit**: gateway tests pass. New Slack mentions create anchors with a `slack.thread` alias; re-engagements of pre-existing legacy threads still resolve and continue to write only `slack.thread_id`.

### Phase 3 — Admin rendering

- `packages/admin/src/app.ts`: read `process.env.SLACK_TEAM_ID` once at startup, pass through to `renderSessionsPage` / `renderSessionsFragment` via `SessionsProps`.
- `packages/admin/src/views.ts`:
  - Add `decodeExternalKey({ aliasType, aliasValue })` → `{ label: string; href?: string }`.
    - `slack.thread`: split on `/` → `{ channel, ts }`. If `SLACK_TEAM_ID` set, `href = https://app.slack.com/client/<team>/<channel>/thread/<channel>-<ts>`; label `#<channel> · <fmtDate(ts)>`.
    - `git.branch`: base64url-decode, strip `git:branch:` prefix, split into `repo`, `branch`; label `<repo> · <branch>`, no link.
    - `github.issue`: base64url-decode, strip `github:issue:` prefix, split into `repo`, `n`; label `<repo>#<n>`, `href = https://github.com/<repo>/issues/<n>`.
    - `slack.thread_id` (legacy): label `thread <ts>`, no link. Only shown if the anchor has no `slack.thread` chip.
  - Update the chip loop at `views.ts:196` accordingly. Anchor tags get `target="_blank" rel="noopener"`.
- `.env.example`, `docker-compose.yml` (admin block), `README.md` env table: document `SLACK_TEAM_ID` as optional.

**Exit**: `pnpm --filter @thor/admin test` extended with cases for each chip type (with/without team) passes.

### Phase 4 — Integration verification

- Push branch, watch the relevant E2E workflow (likely `core-e2e` — it exercises Slack).
- If green, open PR against `main`.

## Decision Log

| Date       | Decision                                                                     | Rationale                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-15 | Use `<channel>/<thread_ts>` instead of a separate `slack.channel` alias type | Single alias keeps the 1-to-1 reverse invariant intact and avoids chip-stealing across anchors that share a channel.            |
| 2026-05-15 | No upgrade-in-place for legacy anchors                                       | Keeps gateway flow simple; legacy chips just remain non-link. Cost is bounded (only affects threads that pre-date this change). |
| 2026-05-15 | `SLACK_TEAM_ID` optional, admin-only                                         | Admin still loads in setups without Slack; gateway/runner stay unaffected.                                                      |

## Out-of-scope follow-ups

- A migration that rewrites legacy `slack.thread_id` aliases into `slack.thread` by scanning session-event logs for the original `channel`. Worth doing if/when we want to drop the legacy type entirely.
- Dropping `slack.thread_id` from `ALIAS_TYPES` after the legacy is fully drained.
