# GitHub workflow_run support + normalizer pass-through

**Date**: 2026-04-27
**Status**: Ready to implement

## Goal

Two changes, one shape:

1. **Add `workflow_run` support.** When a GitHub Actions workflow finishes
   with `conclusion == "success"`, wake Thor on the corresponding branch so
   it can act on the green signal (open a PR, continue work, etc.). Today the
   gateway drops `workflow_run` (and `workflow_job` / `check_run` /
   `check_suite`) as `event_unsupported`.

2. **Remove `NormalizedGitHubEvent`.** Pass the zod-parsed envelope through
   the queue unchanged, mirroring how Slack events flow. The zod schema is
   already the lean projection — we don't need a second hand-rolled shape.
   We never carry the raw GitHub payload (which can be up to 25 MB) past
   `safeParse`; the parsed object is what gets enqueued, rendered, and
   logged.

## Current state

- `packages/gateway/src/github.ts` defines `GitHubWebhookEnvelopeSchema`
  (lean projection of issue_comment / pull_request_review_comment /
  pull_request_review) **and** `NormalizedGitHubEvent` (a hand-rolled
  flattened struct), with `normalizeGitHubEvent()` translating between
  them and applying ignore rules (self_sender, fork_pr_unsupported,
  empty_review_body, non_mention_comment, …).
- `packages/gateway/src/app.ts` route handler calls `normalizeGitHubEvent`
  then enqueues the normalized struct. `service.ts` consumes it for
  directory resolution, branch correlation, and prompt rendering.
- `GITHUB_SUPPORTED_EVENTS` in `app.ts` lists three event types.
  `workflow_run` is rejected at the header check before we even parse.

## Design

### Pass-through, like Slack

Slack does inline gates in the route handler (self user id, allowlist
channel, engaged thread) and enqueues the zod-parsed `event` directly.
`service.ts` uses that event as-is (`JSON.stringify(event)` for the prompt;
fields read directly).

Adopt the same pattern for GitHub:

- Keep one zod union as the canonical lean shape, extended with a
  `workflow_run` variant.
- Move the per-event ignore rules into small pure helpers exported from
  `github.ts` (`shouldIgnoreCommentEvent`, `shouldIgnoreReviewEvent`,
  `shouldIgnoreWorkflowRunEvent`) — each returns either an `IgnoreReason`
  or `null`. The route handler in `app.ts` wires them up like the Slack
  gates.
- Queue payload type becomes the zod-inferred envelope (`GitHubWebhookEvent`),
  not a hand-rolled flat struct. `localRepo` and `deliveryId` are no longer
  carried on the payload — they are derived from `repository.full_name`
  and the `x-github-delivery` header at enqueue time. Since both are needed
  downstream by `service.ts`, we attach them via small wrapper fields on
  the queued event (next to `correlationKey`/`sourceTs`), or by passing
  `deliveryId`/`localRepo` as extra fields on the queue entry's payload
  the same way Slack carries `event_id` separately. We'll add a tiny
  `GitHubQueuedPayload = { event, deliveryId, localRepo }` so service.ts
  has what it needs without re-parsing.

### workflow_run shape

Lean schema:

```ts
const WorkflowRunEnvelopeSchema = z.object({
  action: z.literal("completed"),
  installation: GitHubInstallationSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubSenderSchema,
  workflow_run: z.object({
    id: z.number().int().positive(),
    name: z.string(),
    head_branch: z.string(),
    head_sha: z.string(),
    html_url: z.string(),
    conclusion: z.string().nullable(),
    status: z.string(),
    updated_at: IsoDateTimeSchema,
    event: z.string(),
    pull_requests: z.array(z.object({ number: z.number().int().positive() })),
    triggering_actor: GitHubUserSchema, // { id, login }
  }),
});
```

Other actions (`requested`, `in_progress`) are dropped at the schema by
`z.literal("completed")` — the same trick the comment/review schemas use
for their actions. `conclusion` is checked at gate time.

### Trigger rule

Forward when:

- `action === "completed"`
- `conclusion === "success"`
- The run is associated with at least one PR (`pull_requests[]` non-empty)
  **and** the run's `triggering_actor.id` (or `actor.id`) equals our bot
  ID — i.e. our bot is what kicked off the workflow.

Rationale for the bot-author gate: mirrors the existing review/review-comment
"PR opened by us" exception — only act on workflow signal that originated
from Thor's own work. The workflow_run webhook does **not** include the PR
author directly (`pull_requests[].user` is absent), so we use
`triggering_actor.id === botId` as the local proxy: if Thor's bot triggered
the run (typically by pushing to a PR branch), the run is on Thor's PR.

Drop with new ignore reasons:

- `workflow_run_not_successful` — `conclusion` is not `success`
  (failed / cancelled / skipped / timed_out / null).
- `workflow_run_not_pr` — `pull_requests[]` empty (push to a branch with
  no open PR; not actionable as "Thor's PR is green").
- `workflow_run_not_self_authored` — `triggering_actor.id !== botId`.

Non-`completed` actions (`requested`, `in_progress`) are rejected at the
schema (`z.literal("completed")`) and log as `event_unsupported`.

### Correlation + directory

- `localRepo` = basename of `repository.full_name`, same as today.
- `branch` comes directly from `workflow_run.head_branch`; **no remote-cli
  lookup** is ever needed for workflow_run (head_branch is always present).
- `correlationKey = git:branch:{localRepo}:{branch}` after
  `resolveCorrelationKeys`.
- `sourceTs = Date.parse(workflow_run.updated_at)`.

### Self-loop concern

The `sender`/`self_sender` guard is **inverted** for workflow_run: instead
of dropping when our bot is the sender, we *require* our bot to be the
triggering actor (see the gate above). This keeps the natural use case
(Thor push → CI green → Thor reacts) while ignoring noise from
human-triggered or other-bot-triggered runs.

### Prompt

Render each forwarded workflow_run as a single line, similar in shape to
the existing per-event line:

```
[workflow] {name} {conclusion} on {repoFullName}@{head_branch} ({event}): {html_url}
```

No JSON-stringify of the parsed envelope into the prompt — keep it
human-readable, matching how comment/review events are rendered today.

### Why not just "add workflow_run to the allowlist"?

The user specifically asked for the normalizer-removal to land alongside,
because:

- Two parallel shapes (zod + hand-rolled `NormalizedGitHubEvent`) drift.
- Adding workflow_run forces a `body` field that doesn't exist, plus
  noise like `senderLogin`/`mention` that don't apply, leading to fake
  values in the flat struct.
- Slack already proved the pass-through pattern works.

### Out of scope

- `workflow_job` / `check_run` / `check_suite` events. We pick
  `workflow_run` because it has the right granularity (one event per
  workflow, not per job) and stable `head_branch`.
- Configurable trigger predicates (e.g. "only on PR-named workflows").
  Start with `conclusion: success`; layer policy later if needed.
- Failed-workflow handling. Not asked for. A separate event type can be
  added later if we want Thor to react to red CI.
- Cross-repo / fork workflow_run handling. The schema accepts what GitHub
  sends; if `head_branch` resolves to a branch we don't have locally, the
  runner side already handles that gracefully (no behavior change).

## Phases

### Phase 1 — Refactor github.ts to pass-through + add workflow_run schema

**Changes**

- `packages/gateway/src/github.ts`
  - Add `WorkflowRunEnvelopeSchema`; extend the union exported as
    `GitHubWebhookEnvelopeSchema`.
  - Export `type GitHubWebhookEvent = z.infer<typeof GitHubWebhookEnvelopeSchema>`
    plus per-variant type guards (`isIssueCommentEvent`,
    `isPullRequestReviewCommentEvent`, `isPullRequestReviewEvent`,
    `isWorkflowRunEvent`).
  - Replace `normalizeGitHubEvent` with three small helpers:
    - `shouldIgnoreCommentEvent(event, options) → IgnoreReason | null`
      (covers issue_comment + pull_request_review_comment),
    - `shouldIgnoreReviewEvent(event, options) → IgnoreReason | null`,
    - `shouldIgnoreWorkflowRunEvent(event) → IgnoreReason | null`.
  - Add `getGitHubEventBranch(event): string | null` (reads
    `pull_request.head.ref` or `workflow_run.head_branch`; null for
    issue_comment).
  - Update `getGitHubEventSourceTs` to handle `workflow_run.updated_at`.
  - Drop `NormalizedGitHubEvent` and `normalizeGitHubEvent`. Drop
    `IgnoreReason` value `event_unsupported` consumers — we still emit
    the same string in app.ts but it lives there now.
  - Add `IgnoreReason` values `workflow_run_not_successful`.

- `packages/gateway/src/github.test.ts`
  - Replace `normalizeGitHubEvent` test cases with equivalent calls to
    the new helpers (one test per ignore reason, one happy path per
    event type).
  - Add cases for `workflow_run`: success → no ignore; failed →
    `workflow_run_not_successful`; non-completed action → schema reject.

**Exit criteria**

- `pnpm --filter @thor/gateway exec vitest run src/github.test.ts` passes.
- `NormalizedGitHubEvent` is no longer referenced anywhere in the repo.

### Phase 2 — Wire app.ts + service.ts to the parsed envelope

**Changes**

- `packages/gateway/src/app.ts`
  - Add `"workflow_run"` to `GITHUB_SUPPORTED_EVENTS`.
  - Replace the `normalizeGitHubEvent` call with: parse, derive
    `localRepo`, run the appropriate `shouldIgnore*` helper, then
    enqueue.
  - Queue payload type: `{ event: GitHubWebhookEvent; deliveryId: string;
    localRepo: string }`.
  - Branch derivation uses `getGitHubEventBranch`. issue_comment still
    has null branch and goes through the existing pending-branch-resolve
    path.
  - workflow_run enqueues directly with the resolved correlation key
    (head_branch is always present, no remote-cli lookup).

- `packages/gateway/src/service.ts`
  - `BatchDispatchInput.githubEvents` becomes `GitHubQueuedPayload[]`.
  - `resolveGitHubBatchDirectory` reads `payload.localRepo`.
  - `resolveGitHubPrHead` reads `payload.event.installation.id`,
    `payload.event.repository.full_name`, and the PR number from the
    parsed envelope (issue_comment / review variants).
  - Prompt rendering: per-event helpers per variant, replacing
    `renderGitHubPromptLine` with a `match`-on-variant function.
  - The pending-branch-resolve path only runs for issue_comment;
    pull_request_review_comment / pull_request_review / workflow_run
    always have a branch.

- `packages/gateway/src/app.test.ts` / `service.test.ts`
  - Update fixtures from the flat struct to the parsed envelope shape.
  - Add at least one workflow_run test: happy path enqueue +
    correlation key.

**Exit criteria**

- `pnpm --filter @thor/gateway exec vitest run` passes.
- Manual: a workflow_run success delivery is observed in gateway logs as
  `github_event_accepted` (not `event_unsupported`).

### Phase 3 — Docs

**Changes**

- `docs/github-app-webhooks.md`
  - Add `Workflow run` to event subscriptions (§4).
  - Add `workflow_run_not_successful` to the ignore-reasons table (§9).
  - Note: `event_unsupported` now also covers
    workflow_run with a non-`completed` action.
- `docs/plan/2026042301_github-app-webhooks.md`
  - Append a short post-implementation note pointing to this plan and
    noting `NormalizedGitHubEvent` was removed in favor of pass-through.

**Exit criteria**

- Operator runbook reflects the new subscription and ignore reason.

### Phase 4 — Integration verification

- Push branch; let GitHub-app webhook integration workflow run.
- If no auto-trigger, dispatch the gateway integration workflow manually.
- Open PR against `main` once required checks pass.

## Decision log

| Decision                                                    | Choice                                | Rationale                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Drop `NormalizedGitHubEvent`?                               | Yes — pass-through                    | Slack already proves the pattern; eliminates two parallel shapes; avoids fabricating fields for variant events.    |
| What field set to carry alongside the envelope on the queue | `{ event, deliveryId, localRepo }`    | `deliveryId` comes from the header (not body), `localRepo` is the resolved local clone — both stable to derive once at enqueue. |
| Forward our own workflow_run senders?                       | Yes — skip self-sender check          | The whole point is "Thor pushed → CI passed → Thor opens PR." Self-loop guard would kill the use case.             |
| Trigger rule v1                                             | `action=completed` ∧ `conclusion=success` | Matches the user ask ("workflow success doesn't trigger opencode"). Fail/cancel handling is out of scope.        |
| Correlation key for workflow_run                            | `git:branch:{localRepo}:{head_branch}`| Same canonical key as comment/review events, ensuring continuity with the session that originated the branch.     |
| Prompt rendering shape                                      | Single human-readable line per event  | Matches comment/review prompt style; never embeds the raw 25 MB GitHub payload.                                    |
| Schema-reject non-completed actions vs. gate at runtime?    | Schema reject (`z.literal("completed")`) | Same convention used for comment/review actions; non-completed deliveries log as `event_unsupported`.            |

## Out of scope

- `workflow_job`, `check_run`, `check_suite`.
- Failed-workflow reactions.
- Per-workflow allowlists or branch filters.
- Renaming the GitHub queue source / changing the runner-side contract.
