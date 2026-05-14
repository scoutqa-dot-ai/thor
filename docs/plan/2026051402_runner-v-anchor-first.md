# Runner Viewer Anchor-First Slice

**Date**: 2026-05-14
**Status**: Draft
**Depends on**: `docs/plan/2026043001_session-event-log.md`, `docs/plan/2026051401_admin-sessions-dashboard.md`

## Goal

Make `/runner/v` and outbound Thor disclaimers anchor-first now that runner routes are protected by Vouch SSO. The first slice should remove the user-visible dependency on a single active trigger while preserving trigger ids as internal event-log metadata and compatibility deep links.

## Scope

In scope for this PR:

- Canonical anchor viewer route at `GET /runner/v/:anchorId`.
- Compatibility behavior for existing trigger-shaped links, including `GET /runner/v/:anchorId/:triggerId` and a preferred exact-trigger sub-route such as `GET /runner/v/:anchorId/t/:triggerId`.
- Anchor-based disclaimer/footer helpers that replace active-trigger-as-default for outbound content.
- Relaxed direct GitHub write and approve-classified MCP flows that use anchor context when available instead of failing solely because no open trigger can be proven.
- Admin session links that always point anchors at `/runner/v/:anchorId`, with trigger links only as optional deep links.
- Targeted tests and docs updates that describe trigger ids as optional diagnostic/slice metadata.

Out of scope for this PR:

- Removing `triggerId`, `trigger_start`, or `trigger_end` from session logs.
- Building a persistent trigger/session index or changing log retention.
- Broad redesign of admin status semantics beyond link updates needed for the slice.
- Slack `slack-post-message` live-session gating changes.
- Generic disclaimer fallback when no session/anchor can be resolved, unless implementation confirms it is low-risk and clearly logged; the required relaxation is “no active trigger” rather than “no provenance at all.”

## Target behavior

| Area | Behavior |
| --- | --- |
| Anchor viewer | Authenticated users can open `/runner/v/:anchorId` for any known anchor and see the best available context across bound sessions. Known anchors with no triggers render a 200 empty state. Unknown or malformed anchors remain branded 404s. |
| Trigger links | Exact trigger URLs are filters/deep links, not the primary gate. Existing `/runner/v/:anchorId/:triggerId` links must continue to work. Missing exact trigger under a known anchor should show the anchor overview with a warning instead of a dead-end 404. |
| Footers | Default footer copy becomes “View Thor context” or equivalent and links to `/runner/v/:anchorId`. Exact trigger URLs remain available for diagnostics/tests that explicitly need them. |
| Direct GitHub writes | If the command body can be rewritten and the invoking session resolves to an anchor, execute with an anchor footer even when `findActiveTrigger()` would return `none`. Missing body/rewrite support still fails safely. |
| Approvals | Approval creation should persist best-effort anchor provenance and not reject solely due to no active trigger. Resolution injects an anchor footer from stored anchor context; old records with stored trigger provenance remain readable. |
| Admin | Anchor/current-session rows link to `/runner/v/:anchorId` even when no trigger id exists. Trigger ids, when present, may link to the exact-trigger sub-route. |

## Phases

### Phase 1 — Anchor context and viewer routes

Files likely touched:

- `packages/common/src/event-log.ts`
- `packages/common/src/index.ts`
- `packages/common/src/event-log.test.ts`
- `packages/runner/src/index.ts`
- `packages/runner/src/trigger.test.ts`

Work:

- Add or reuse a common anchor-context/state helper that resolves a session or anchor to bound sessions, current session, latest/open/terminal trigger summaries, and diagnostics without requiring a currently open trigger.
- Add `GET /runner/v/:anchorId` as the canonical viewer route.
- Add exact-trigger compatibility via `/runner/v/:anchorId/t/:triggerId`, while keeping the old `/runner/v/:anchorId/:triggerId` route operational for existing artifacts.
- Render an anchor overview/empty state for known anchors and a warning fallback when a requested trigger is missing under a known anchor.
- Keep existing SSO header check, UUID validation, escaping/redaction, file-size limits, and malformed-log diagnostics.

Exit criteria:

- Tests cover known anchor with no trigger, known anchor with recent trigger(s), stale/missing requested trigger fallback, old trigger-shaped link compatibility, malformed IDs/unknown anchors, and safe escaping.
- `pnpm --filter @thor/common test` and `pnpm --filter @thor/runner test` targeted suites pass.

### Phase 2 — Anchor-first footers and direct GitHub writes

Files likely touched:

- `packages/common/src/disclaimer.ts`
- `packages/common/src/disclaimer.test.ts`
- `packages/remote-cli/src/index.ts`
- `packages/remote-cli/src/gh-disclaimer.test.ts`

Work:

- Add `buildThorAnchorUrl()` and keep `buildThorTriggerUrl()` for exact links.
- Change the default session disclaimer helper to resolve anchor context rather than call `findActiveTriggerOrThrow()`.
- Update footer copy and injected URLs to use the anchor viewer by default.
- Relax direct `gh` writes so no-active-trigger no longer blocks execution when anchor context is available and the body can be safely rewritten.

Exit criteria:

- Tests prove anchor footer injection for open, closed, and no-trigger-known anchor cases.
- Tests preserve failure for unsupported/non-rewritable command shapes and invalid/missing provenance according to the explicit policy chosen during implementation.
- Targeted common and remote-cli tests pass.

### Phase 3 — Approval provenance relaxation

Files likely touched:

- `packages/remote-cli/src/approval-store.ts`
- `packages/remote-cli/src/mcp-handler.ts`
- `packages/remote-cli/src/mcp-handler.test.ts`

Work:

- Extend approval origin data to support anchor-first provenance, with optional trigger metadata for compatibility.
- On approval creation, persist anchor context when available and do not fail solely because no active trigger exists.
- On approval resolution, inject an anchor footer from stored anchor context; continue reading and resolving old `origin.trigger` records.
- Update approval card/display text only as needed to expose the stable anchor link.

Exit criteria:

- Tests cover creating approvals with anchor but no active trigger, resolving anchor-origin approvals, and resolving old trigger-origin approvals.
- Approval creation still fails for unrelated policy/auth/input errors.

### Phase 4 — Admin links, docs, and final verification

Files likely touched:

- `packages/admin/src/views.ts`
- `packages/admin/src/app.test.ts`
- `docs/plan/2026043001_session-event-log.md`
- `docs/feat/event-flow.md`
- this plan, if decisions change during implementation

Work:

- Update admin rows so anchor links are unconditional and trigger links are optional exact deep links.
- Update docs to say `/runner/v/:anchorId` is canonical and trigger ids are optional diagnostic/slice metadata.
- Remove doc/test language that says outbound writes or approvals must fail solely because there is no open trigger.

Exit criteria:

- Admin tests assert anchor links with and without trigger ids.
- Docs reflect Vouch-protected anchor-first viewer behavior and best-effort `trigger_end` semantics.
- Workspace `pnpm test` and `pnpm typecheck` pass before push/PR verification.

## Decision Log

| # | Decision | Rationale | Rejected |
| --- | --- | --- | --- |
| 1 | Make `/runner/v/:anchorId` canonical and keep trigger links as compatibility deep links | Vouch SSO is the access-control boundary; anchor links are stable when trigger closure/inference is imperfect. | Continue requiring `/runner/v/:anchorId/:triggerId` everywhere |
| 2 | Keep trigger ids and `trigger_end` in logs | They remain valuable for slicing, duration, debugging, and old artifact links. | Remove trigger metadata from the event model |
| 3 | Relax “no active trigger” but not all provenance failures in this slice | This targets the known UX failure while keeping traceability policy explicit and safer to review. | Silently inject generic footers for every unresolved session |
| 4 | Preserve old approval trigger-origin records | Pending approvals and historical records must remain resolvable through the migration. | One-way schema replacement |
| 5 | Store `origin.anchor` for new approvals while also writing `origin.trigger` when trigger metadata exists | Anchor-first resolution should not break older readers or tests that inspect trigger provenance during the migration. | Stop writing trigger provenance immediately |

## Verification checklist

- `pnpm --filter @thor/common test`
- `pnpm --filter @thor/runner test`
- `pnpm --filter @thor/remote-cli test`
- `pnpm --filter @thor/admin test`
- `pnpm test`
- `pnpm typecheck`
- Manual smoke check of `/runner/v/:anchorId`, `/runner/v/:anchorId/t/:triggerId`, and legacy `/runner/v/:anchorId/:triggerId` against scratch logs.
