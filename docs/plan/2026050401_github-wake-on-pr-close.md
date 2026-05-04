# Wake Thor on PR close/merged

**Date**: 2026-05-04
**Status**: Ready to implement
**Depends on**: `docs/plan/2026042702_github-event-passthrough.md` ✅ (JSON passthrough)
**Sibling pattern**: `docs/plan/2026042703_github-wake-on-ci.md` (same shape, same gate philosophy)

## Problem

Today the gateway drops standalone `pull_request` events as
`event_unsupported`. When a PR Thor was working on is closed or merged,
nothing wakes the session: Thor keeps its branch context as if the PR
were still open. Operationally we want: when Thor's PR is closed (with
or without merge), Thor wakes once, reads the event, and decides what
to do (post-merge cleanup, notes update, abandon-state acknowledgment,
etc.). The wake should not interrupt in-flight work — it is a
continuation signal, not a user instruction.

## Decisions

| #   | Question             | Decision |
| --- | -------------------- | -------- |
| Q1  | Event primitive      | **`pull_request` action `closed`.** Covers both merged (`pull_request.merged === true`) and abandoned (`merged === false`) in one event. The agent reads `merged` from the raw JSON. |
| Q2  | Other PR actions     | **Out of scope.** `opened`, `reopened`, `synchronize`, `edited`, `ready_for_review`, etc. are not wired here. `synchronize` overlaps with `push`/`check_suite` wakes; `opened` is created by Thor itself. Revisit per-action only if a concrete need surfaces. |
| Q3  | Correlation          | **`pull_request.head.ref` → `git:branch:<localRepo>:<branch>`.** Same shape as every other branch-correlated event. Existing-session gate is mandatory: if no notes-backed session exists for the branch, drop with `correlation_key_unresolved`. |
| Q4  | Authorship gate      | **Not added.** The existing-notes gate is sufficient: a PR `closed` event for a branch Thor never worked on cannot resolve a notes file, so it drops at Q3. Unlike `check_suite` there is no self-loop risk (Thor doesn't close its own PRs as part of normal work). |
| Q5  | Interrupt semantics  | **`interrupt: false`.** PR close/merge is a continuation signal, mirroring `check_suite.completed` (D-11 of the CI-wake plan). User-initiated GitHub mention/review behaviour is unchanged. |
| Q6  | Prompt rendering     | **JSON passthrough.** No service-layer changes. The agent reads `pull_request.merged`, `pull_request.merge_commit_sha`, `pull_request.html_url`, etc. directly from the forwarded event. |
| Q7  | Fork PRs             | **Drop, consistent with existing PR-event handling.** The current `fork_pr_unsupported` reason already exists; reuse it for `pull_request.head.repo.full_name !== pull_request.base.repo.full_name`. |
| Q8  | Plan policy          | New plan file (this one), not an append to the CI-wake plan. The CI-wake plan is closed and shipped; PR-lifecycle is a distinct event surface with its own decisions, even though the gate machinery is reused. |

## Design

The flow mirrors `check_suite.completed` end-to-end:

1. Webhook signature verified (existing).
2. `x-github-event: pull_request` allowed by `GITHUB_SUPPORTED_EVENTS`.
3. Schema validates `action: "closed"`. Other actions are allowed at the
   header level but fail schema validation and are logged as
   `schema_validation_failed`.
4. Fork PRs drop with `fork_pr_unsupported`.
5. Branch correlation key built from `pull_request.head.ref`. If no
   notes-backed session resolves, drop with `correlation_key_unresolved`.
6. Enqueue with `interrupt: false`. The runner coalesces with any
   in-flight session.

No git gate (no `internalExec`) is needed: the existing-notes gate is
the safety filter, and the PR payload itself is the authoritative
state.

## Phases

Each phase = one commit.

### Phase 1 — Accept `pull_request.closed` at the gateway

**Goal:** parse and schema-validate `pull_request` action `closed`,
gate on existing notes-backed session, enqueue with `interrupt: false`.

Files:

- `packages/gateway/src/github.ts`
  - New `PullRequestClosedEventSchema` (zod): `event_type: "pull_request"`,
    `action: "closed"`, `repository`, `installation`, `sender`, and a
    `pull_request` object with at least `number`, `merged: boolean`,
    `merged_at: string|null`, `merge_commit_sha: string|null`,
    `closed_at: string`, `html_url`, `head: { ref, sha, repo: { full_name } }`,
    `base: { ref, repo: { full_name } }`, `user: { login }`.
  - Extend `withEventType`: when `obj.pull_request` is present and
    neither `comment` nor `review` is — i.e. a standalone PR event —
    set `event_type: "pull_request"`. (The discriminator for review
    and review-comment events keeps higher precedence; the existing
    branches in `withEventType` are checked first.)
  - Add the new schema to `GitHubWebhookEnvelopeSchema`'s discriminated union.
  - Export `PullRequestClosedEvent` type and `isPullRequestClosedEvent`
    type guard.
  - `getGitHubEventType` returns `"pull_request"` for the new variant.
  - `getGitHubEventBranch` returns `event.pull_request.head.ref`.
  - `getGitHubEventSourceTs` returns `Date.parse(event.pull_request.closed_at)`.
  - Add `"pull_request"` to the routing union returned by `getGitHubEventType`.
  - Add explicit standalone-PR handling to `shouldIgnoreGitHubEvent(...)`
    so the new variant does not fall through the review-event path.
  - No new `GitHubIgnoreReason` values needed; reuse
    `correlation_key_unresolved` and `fork_pr_unsupported`.
- `packages/gateway/src/app.ts`
  - Add `"pull_request"` to `GITHUB_SUPPORTED_EVENTS`.
  - In the per-event branch, when `eventType === "pull_request"`:
    - If `pull_request.head.repo.full_name !== pull_request.base.repo.full_name`
      → ignore with `fork_pr_unsupported`.
    - Build `rawKey = buildCorrelationKey(localRepo, head.ref)`,
      resolve, and require an existing notes-backed match (same strict
      check used for `check_suite` — `findNotesFile(resolvedKey)` after
      `resolveCorrelationKeys`). On miss → ignore with
      `correlation_key_unresolved`.
    - Accepted events enqueue with `interrupt: false`, `delayMs: 0`.

No `service.ts` changes. Phase 0 of the CI-wake plan already made GitHub
prompts pure JSON passthrough; the new variant rides that.

Tests:

- `packages/gateway/src/github.test.ts`
  - `PullRequestClosedEventSchema` parses real GitHub fixtures for
    both merged (`merged: true`) and abandoned (`merged: false`).
  - `getGitHubEventType`, `getGitHubEventBranch`,
    `getGitHubEventSourceTs` for the new variant.
  - `withEventType` still tags `pull_request_review_comment` and
    `pull_request_review` correctly (precedence regression).
- `packages/gateway/src/app.test.ts`
  - Existing-session merged path → ingested + `enqueue` called with
    `interrupt: false` and the raw event.
  - Existing-session abandoned path (`merged: false`) → same enqueue.
  - No-session path → `correlation_key_unresolved`, no enqueue.
  - Fork PR path → `fork_pr_unsupported`, no enqueue.
  - Non-`closed` action (e.g. `opened`) → `schema_validation_failed`.

Exit criteria:

- Targeted gateway tests green.
- `pull_request` action `closed` no longer hits `event_unsupported`.
- Branchless / unknown-session events drop before enqueue.
- Queued payload uses the resolved correlation key and `interrupt: false`.

### Phase 2 — Agent-side handling of PR close/merged

**Goal:** Thor reads the forwarded event and reacts. With JSON
passthrough the gateway needs no per-action prompt shape.

Files:

- `docker/opencode/config/agents/build.md` — document how to interpret
  a `pull_request` event in the inbound payload. Key fields to act on:
  `pull_request.merged` (true → merged; false → abandoned),
  `pull_request.merge_commit_sha`, `pull_request.html_url`,
  `pull_request.closed_at`. Recommended actions:
  - `merged: true` → record completion in notes; do not push further
    on the merged branch; consider task done unless there is follow-up.
  - `merged: false` → record abandonment; ask the requester before
    discarding work.

Tests:

- No new gateway unit tests. Coverage of the JSON envelope already
  exists from Phase 1.

Exit criteria:

- Agent docs updated. Manual smoke (Phase 3) confirms Thor reacts
  sensibly to both merged and abandoned events without aborting
  in-flight work.

### Phase 3 — Runbook + integration verification

**Goal:** documented and verified end-to-end.

Files:

- `docs/github-app-webhooks.md`
  - Document the `Pull request` event subscription (action `closed`)
    on the GitHub App.
  - Note the existing-session gate and the `correlation_key_unresolved`
    / `fork_pr_unsupported` ignored reasons.

Verification:

- Push the branch; ensure unit tests + relevant E2E workflows pass.
- Manual: in a real repo on the install, merge a Thor-authored PR;
  confirm a single wake with `interrupt: false` and the agent reads
  `merged: true`. Close (without merge) a Thor-authored PR; confirm a
  single wake with `merged: false`.

Exit criteria:

- All required CI green on the branch.
- One manual end-to-end verification recorded in the Decision Log below.

## Decision Log

| #   | Decision | Rationale |
| --- | -------- | --------- |
| D-1 | One event (`pull_request.closed`), not a family of PR actions | Scope is "Thor reacts when its PR is done." Other actions either overlap with existing wakes (`synchronize` ↔ `push`/`check_suite`) or are out of scope. |
| D-2 | Existing-session gate is sufficient; no git-author check | A `pull_request.closed` for a branch Thor never worked on cannot resolve a notes file. There is no self-loop risk to defend against (unlike `check_suite`). |
| D-3 | `interrupt: false` | Continuation signal, mirrors CI-wake D-11. Aborting in-flight work to deliver a "PR was merged" notification is a worse outcome than coalescing. |
| D-4 | JSON passthrough; no per-action prompt rendering | Phase 0 of the CI-wake plan already standardised this. A new event type costs zero rendering code. |
| D-5 | Drop fork PRs | Consistent with the rest of the GitHub gateway; `fork_pr_unsupported` reason already exists. |
| D-6 | Reuse existing `GitHubIgnoreReason` values | `correlation_key_unresolved` and `fork_pr_unsupported` cover every drop path. No new reason strings needed; keeps the operator log surface tight. |

## Out of scope

- `pull_request` actions other than `closed` (`opened`, `reopened`,
  `edited`, `synchronize`, `ready_for_review`, etc.). Add later only
  if a concrete need surfaces.
- Notes-file lifecycle state (`merged` / `abandoned` flag). Captured
  as an open item in `docs/plan/2026042701_agent-task-handoffs.md`;
  this plan keeps state in git/GitHub and lets the agent decide.
- Fork-PR support.
- Coalescing rapid open/close/reopen storms. Not observed; revisit if
  it becomes noisy.
- Auto-archival of run dirs after merge. Out of scope here; will be
  designed alongside the broader session lifecycle work.
