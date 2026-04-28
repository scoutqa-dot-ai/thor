<!-- /autoplan restore point: /Users/son.dao/.gstack/projects/scoutqa-dot-ai-thor/investigate-workflow-trigger-autoplan-restore-20260427-215127.md -->

# GitHub event pass-through (drop NormalizedGitHubEvent)

**Date**: 2026-04-27
**Status**: Ready to implement
**Scope**: refactor-only, zero behavior change

## Goal

Drop `NormalizedGitHubEvent` and `normalizeGitHubEvent`. Pass the zod-parsed
envelope through the queue unchanged, mirroring how Slack events flow today.

The zod schema is already the lean projection of the GitHub payload — we don't
need a second hand-rolled struct. We never carry the raw GitHub payload (up to
25 MB) past `safeParse`; the parsed object is what gets enqueued, rendered,
and logged.

**This plan ships zero observable behavior change.** Same set of accepted
events. Same ignore reasons. Same prompts (byte-equivalent). Same correlation
keys. Only the in-memory shape changes.

## Non-goals (deferred)

- **`workflow_run` (and `workflow_job` / `check_run` / `check_suite`) support.**
  An earlier draft of this plan bundled "wake Thor on green CI" with this
  refactor. Splitting them out: the wake-on-CI design has unresolved questions
  (correct event primitive, self-loop guard, multi-workflow granularity, bot
  authorship proxy) that should not block the refactor. See
  `docs/plan/2026042703_github-wake-on-ci-design.md` for the design plan.
- Changing accepted event types, ignore-reason taxonomy, or correlation
  semantics.
- Touching `docs/github-app-webhooks.md` (no operator-facing changes).

## Current state

- `packages/gateway/src/github.ts` defines two parallel shapes:
  - `GitHubWebhookEnvelopeSchema` — lean zod projection of issue_comment /
    pull_request_review_comment / pull_request_review.
  - `NormalizedGitHubEvent` — hand-rolled flat struct.
    And `normalizeGitHubEvent()` translating between them while applying
    ignore rules (self_sender, fork_pr_unsupported, empty_review_body,
    non_mention_comment, …).
- `packages/gateway/src/app.ts` route handler calls `normalizeGitHubEvent`
  then enqueues the normalized struct.
- `packages/gateway/src/service.ts` consumes the normalized struct for
  directory resolution, branch correlation, and prompt rendering.

## Design

### Pass-through, like Slack

Slack does inline gates in the route handler (self user id, allowlist
channel, engaged thread) and enqueues the zod-parsed `event` directly.
`service.ts` uses that event as-is (`JSON.stringify(event)` for prompts;
fields read directly).

Adopt the same pattern for GitHub:

- Keep `GitHubWebhookEnvelopeSchema` as the canonical lean shape.
- Replace `normalizeGitHubEvent` with three small helpers exported from
  `github.ts`:
  - `shouldIgnoreIssueCommentEvent(event, options) → IgnoreReason | null`
  - `shouldIgnorePullRequestReviewCommentEvent(event, options) → IgnoreReason | null`
  - `shouldIgnorePullRequestReviewEvent(event, options) → IgnoreReason | null`

  Per Eng-review finding #5: do NOT collapse comment + review_comment into
  one helper. issue_comment has no `pull_request.user.id`; the bot-author-PR
  exception only applies to review variants. Three helpers makes the
  divergence explicit.

- Add `getGitHubEventBranch(event): string | null` (reads
  `pull_request.head.ref` for review/review_comment; null for issue_comment).
- Drop `NormalizedGitHubEvent` and `normalizeGitHubEvent`.

### Queue payload shape

Old:

```ts
QueuedEvent<NormalizedGitHubEvent>;
// payload: { source, eventType, action, installationId, repoFullName,
//   localRepo, senderLogin, htmlUrl, number, body, branch }
```

New:

```ts
type GitHubQueuedPayload = {
  v: 2; // discriminator for queue-dir migration
  event: GitHubWebhookEvent; // zod-parsed envelope
  deliveryId: string; // from x-github-delivery header
  localRepo: string; // resolved at enqueue time once
  resolvedBranch?: string; // set after issue_comment PR-head resolution
};
QueuedEvent<GitHubQueuedPayload>;
```

`deliveryId` and `localRepo` are not on the parsed event; carry them as
sibling fields rather than re-parsing or re-resolving downstream.

### Cross-check guard preserved

`app.ts:667` today does `if (normalized.eventType !== eventTypeHeader)`.
With normalizer removed, replace with: after parsing the envelope, derive
the variant via type-guards (`isIssueCommentEvent` /
`isPullRequestReviewCommentEvent` / `isPullRequestReviewEvent`) and verify
it matches the `x-github-event` header. Same drop on mismatch
(`event_unsupported`). (Eng-review finding #6.)

### Reroute path

`service.ts:347-355` currently spreads `{ ...event, branch: branchInfo.ref }`
to mutate the normalized struct. With pass-through, branch is not on the
envelope. Carry the resolved branch as a sibling on the queue entry
(`resolvedBranch?: string`); read via the same helper that reads
`getGitHubEventBranch`. (Eng-review finding #4.)

### `resolveGitHubPrHead` input

`resolveGitHubPrHead` only makes sense for issue_comment (the only variant
where branch is null). Narrow its parameter type to the issue_comment
variant so a future workflow_run path can't accidentally call it.
(Eng-review finding #5.)

### Prompt rendering

`renderGitHubPromptLine` currently hard-codes `event.body`,
`event.senderLogin`, `event.eventType`, `event.action`, `event.repoFullName`,
`event.number`, `event.htmlUrl`. With pass-through, derive each from the
parsed variant. Three branches (one per event type), each producing the
identical bytes today's `renderGitHubPromptLine` produces — bytes-equivalence
guarded by tests. (Eng-review finding #7.)

`GITHUB_PROMPT_EVENT_BODY_MAX = 280` stays.

### Backwards compat on the queue dir

Persisted JSON files under `data/queue` carry the OLD `NormalizedGitHubEvent`
shape. After deploy, `EventQueue.scan()` will read them and the new handler
will dereference `payload.event.…` → undefined → crash → silent file
deletion. (Eng-review finding #2 — HIGH.)

Mitigation: add `v: 2` discriminator on new entries and detect missing /
older `v` in the GitHub branch of the queue handler: dead-letter (move to
`data/queue/dead-letter/`) with a `legacy_payload_shape` reason and
structured log. `EventQueue.reject(reason)` is batch-level, so if any GitHub
payload in a ready correlation-key batch is legacy, the whole batch is
dead-lettered. Operationally this means in-flight events at deploy time are
explicitly dropped (and observable), not silently lost. Combined with "drain
queue before deploy" in the rollout step, in-flight count should be near zero.

## Phases

### Phase 1 — github.ts: lean helpers, drop normalizer

**Changes**

- `packages/gateway/src/github.ts`
  - Export `type GitHubWebhookEvent = z.infer<typeof GitHubWebhookEnvelopeSchema>`.
  - Export per-variant type guards.
  - Add three `shouldIgnore*` helpers — pure functions returning
    `IgnoreReason | null`. Mention check, self-sender check, fork check,
    empty-body check unchanged in behavior.
  - Add `getGitHubEventBranch(event)`.
  - Update `getGitHubEventSourceTs` to switch on variant; behavior unchanged.
  - Drop `NormalizedGitHubEvent` and `normalizeGitHubEvent`.

- `packages/gateway/src/github.test.ts`
  - Replace `normalizeGitHubEvent` test cases with equivalent calls to the
    new helpers. Same ignore-reason coverage. Same happy-path assertions.

**Exit criteria**

- `pnpm --filter @thor/gateway exec vitest run src/github.test.ts` passes.
- `NormalizedGitHubEvent` is no longer referenced anywhere in the repo.
- All existing ignore reasons still emitted with the same `reason` strings.

### Phase 2 — app.ts + service.ts wired to the parsed envelope

**Changes**

- `packages/gateway/src/app.ts`
  - Replace `normalizeGitHubEvent` call with: parse → derive `localRepo`
    from `repository.full_name` → variant guard cross-checks
    `x-github-event` → run the appropriate `shouldIgnore*` helper → enqueue
    `{ v: 2, event, deliveryId, localRepo }`.
  - Branch derivation via `getGitHubEventBranch`. issue_comment still
    enqueues with `pending:branch-resolve:` correlation key.
  - Same accepted-events allowlist (`issue_comment`,
    `pull_request_review_comment`, `pull_request_review`). No additions.

- `packages/gateway/src/service.ts`
  - `BatchDispatchInput.githubEvents` becomes `GitHubQueuedPayload[]`.
  - `resolveGitHubBatchDirectory` reads `payload.localRepo`.
  - `resolveGitHubPrHead` typed to take only the issue_comment variant.
  - `renderGitHubPromptLine` switches on variant, produces byte-equivalent
    output to today.
  - Reroute path: stop spreading branch onto the envelope; carry
    `resolvedBranch` on the queue entry.
  - Queue-handler legacy-payload guard: detect missing `payload.v` (or
    presence of normalized-shape fields) on a github event → dead-letter
    with `legacy_payload_shape` reason. One log per drop.

- `packages/gateway/src/{app,service}.test.ts`
  - Update fixtures from the flat struct to the parsed envelope shape.
  - Add tests:
    - happy paths for each of the three variants — assert same prompt bytes
      as today (snapshot or hard-coded string).
    - legacy-payload dead-letter path (write a v1-shape file, scan, expect
      dead-letter + log).
    - reroute path with `resolvedBranch` on the queue entry.

**Exit criteria**

- `pnpm --filter @thor/gateway exec vitest run` passes.
- Rendered prompt for each variant equals today's output (byte-for-byte).
- New test asserts legacy-payload dead-letter behavior.

### Phase 3 — Integration verification

- Drain `data/queue` (operational); document in PR description.
- Push branch; rely on the existing GitHub-app webhook E2E workflow to
  exercise the gateway → runner path on real comment/review events.
- If no auto-trigger, dispatch the gateway integration workflow manually.
- Open PR against `main` once required checks pass.

**Exit criteria**

- E2E workflow green on a real `issue_comment.created` (PR-mention) and one
  `pull_request_review_comment.created` (mention) delivery.
- No `legacy_payload_shape` dead-letters in the post-deploy logs (proves
  the drain worked).

## Decision log

| Decision                                              | Choice                                                    | Rationale                                                                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop `NormalizedGitHubEvent`?                         | Yes — pass-through                                        | Slack already proves the pattern; eliminates two parallel shapes; eliminates the awkward "fabricate fields for variants without a body" trap that bit the workflow_run draft.                                                    |
| Field set carried alongside the envelope on the queue | `{ v: 2, event, deliveryId, localRepo, resolvedBranch? }` | `deliveryId` is from the header, `localRepo` is the resolved local clone — both stable to derive once at enqueue. `v` enables legacy-payload dead-letter. `resolvedBranch` is populated only after issue_comment PR-head lookup. |
| Helper split                                          | Three helpers (issue_comment, review_comment, review)     | issue_comment lacks `pull_request.user.id`; bot-author exception only applies to review variants. Keeps the divergence explicit (Eng review #5).                                                                                 |
| Prompt format                                         | Byte-equivalent to today                                  | Refactor-only ships zero observable change; protects against runner-side parsers we don't control.                                                                                                                               |
| Queue-dir migration                                   | Dead-letter v1 with structured log + drain pre-deploy     | Eng review #2 — silently dropping in-flight events on deploy is unacceptable. Dead-letter is observable and recoverable.                                                                                                         |
| Resolved branch location                              | Inside `GitHubQueuedPayload.resolvedBranch`               | `EventQueue` parses only known top-level queue metadata; custom top-level fields would be stripped on scan.                                                                                                                      |
| Legacy reject granularity                             | Reject the whole ready batch                              | Queue `reject(reason)` operates on the current correlation-key batch. Partial dead-lettering would require a queue API change, which is unnecessary for drained deploys.                                                         |
| Bundle workflow_run with this refactor?               | No — separate plan                                        | /autoplan dual voices both flagged scope bundling. Wake-on-CI has open design questions (primitive choice, self-loop, granularity). See follow-up plan.                                                                          |

## Out of scope

- Wake-on-CI / `workflow_run` / `check_suite` / `check_run` /
  `repository_dispatch` — see `docs/plan/2026042703_github-wake-on-ci-design.md`.
- Changing the accepted-events allowlist.
- Slash-command or label-based triggers.
- Issue-only (non-PR) comment handling.
- Runner-side filtering or system-prompt changes.

## GSTACK REVIEW REPORT

Generated by /autoplan on 2026-04-27 (commit 3457b3b0).

| Skill                 | Status                 | Findings                    | Verdict                                                                                                      |
| --------------------- | ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| plan-ceo-review       | issues_open → resolved | 8 (5 critical, 3 medium)    | Plan revised — workflow_run split out per User Challenge #1; refactor-only path retained.                    |
| autoplan-voices (CEO) | clean                  | Codex + subagent both ran   | Consensus 5/6 confirmed — premise wrong, scope bundled, self-loop, alternatives missed.                      |
| plan-eng-review       | issues_open → folded   | 8 (3 high, 4 medium, 1 low) | Findings #2, #4, #5, #6, #7 folded into this revised refactor-only plan. #1, #3 deferred to wake-on-CI plan. |
| autoplan-voices (Eng) | subagent-only          | Subagent ran                | Codex deferred — CEO consensus already mandated replan.                                                      |
| plan-design-review    | n/a                    | —                           | Skipped — no UI scope.                                                                                       |
| plan-devex-review     | n/a                    | —                           | Skipped — no developer-facing scope.                                                                         |

User Challenge #1 (split refactor from feature): **accepted** → this plan
is now refactor-only.
User Challenge #2 (reconsider workflow_run vs alternatives): **accepted** →
deferred to a fresh design plan, not implemented in this branch.
