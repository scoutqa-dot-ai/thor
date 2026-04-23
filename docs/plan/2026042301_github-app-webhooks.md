# GitHub App Webhooks

**Date**: 2026-04-23
**Status**: Draft

## Goal

Add GitHub App webhook intake to Thor so the gateway can accept selected GitHub code-flow events, normalize them, queue them, and route them into the correct Thor session and repo context.

Initial target events:

- `issue_comment.created`
- `pull_request_review_comment.created`
- `pull_request_review.submitted` when a review body exists

These cover the concrete asks behind this plan:

- when a user tags the bot in GitHub
- when a PR receives a comment

## Why

- Thor already has Slack and cron intake in `packages/gateway`, but no implemented GitHub webhook route.
- The repo already contains design intent for GitHub-triggered continuity (`git:branch:*` correlation, mention interrupts), but that path was never completed.
- GitHub App auth already exists for `git` / `gh` execution in `remote-cli`; webhook intake completes the other half of the GitHub integration story.
- GitHub code review activity is a natural trigger for investigation and review follow-up without requiring a Slack mention every time.

## Current State

- `packages/gateway` currently handles Slack events, Slack interactivity, cron, queueing, and runner dispatch.
- `packages/runner` already supports `correlationKey`, `interrupt`, repo directory selection, and alias-based session continuity.
- `packages/common/src/notes.ts` already supports git branch aliases and multi-key correlation resolution.
- `packages/common/src/workspace-config.ts` has repo channel mappings and `github_app.installations`, but no webhook routing metadata from GitHub repo to local Thor repo.
- Older plans (`2026032101_mention-interrupt.md`, `2026031301_correlation-key-aliasing.md`) describe intended GitHub behavior, but files like `packages/gateway/src/github.ts` and `triggerRunnerGitHub()` do not exist today.

## Architecture

### Runtime flow

```text
GitHub App webhook
  -> packages/gateway POST /github/webhook
    -> verify X-Hub-Signature-256
    -> parse + normalize supported event
    -> map GitHub repo full_name to local Thor repo
    -> derive correlation key candidates
    -> resolve canonical correlation key
    -> enqueue event in EventQueue
      -> dispatch to triggerRunnerGitHub()
        -> POST /trigger { prompt, correlationKey, interrupt, directory }
          -> packages/runner
```

### Normalized event shape

The gateway should not forward raw GitHub webhook payloads blindly. It should normalize supported events into a compact internal shape that includes only the fields Thor needs to reason about routing and response.

Required normalized fields:

- `source: "github"`
- `deliveryId`
- `eventType`
- `action`
- `installationId`
- `repoFullName` (for example `acme/api`)
- `localRepo` (for example `acme-api`)
- `senderLogin`
- `htmlUrl`
- `number` (issue or PR number when present)
- `body` (comment or review text when present)
- `branch` (required for dispatch)
- `correlationKeys` (ordered candidates)

### Correlation model

Use ordered candidate keys and existing `resolveCorrelationKeys()` support, but keep the model branch-based.

When a branch is available:

- canonical: `git:branch:{owner/repo}:{branch}`
- short alias: `git:branch:{localRepo}:{branch}`

When a supported event does not include branch context directly, the gateway may do an extra GitHub API lookup to resolve the PR head branch. If it still cannot resolve a branch, the event is dropped and logged.

This keeps the scope aligned with code-flow events and preserves a single continuity model.

### Interrupt rules

- GitHub event with a bot mention in body/comment/review: `interrupt: true`, short delay (`3s`)
- Supported GitHub event without a bot mention: `interrupt: false`, long delay (`60s`)

Mention detection should inspect normalized body text and match configured GitHub identities instead of hardcoding a single handle.

### Branch resolution policy

- Prefer branch data already present in the webhook payload
- For PR-backed events that omit branch context, allow one GitHub API lookup to resolve the PR head ref
- If branch resolution still fails, log and drop the event instead of introducing a second non-branch correlation model

## Config Changes

Add explicit GitHub repo mapping to workspace config. Do not overload `github_app.installations`; that block remains auth-only.

Suggested shape:

```json
{
  "repos": {
    "thor": {
      "channels": ["C123"],
      "proxies": ["slack", "atlassian"],
      "github": {
        "repos": ["scoutqa-dot-ai/thor"],
        "mention_logins": ["thor", "thor[bot]"]
      }
    }
  },
  "github_app": {
    "installations": []
  }
}
```

Validation rules:

- each GitHub repo full name maps to exactly one local repo
- `mention_logins` is optional but, when present, must be non-empty strings
- existing configs without `github` blocks remain valid

## Phases

### Phase 1 — Config schema + GitHub webhook primitives

Implement the shared config and parsing layer for GitHub webhook intake.

1. Extend `packages/common/src/workspace-config.ts`
   - add optional repo-level GitHub mapping block
   - add helper to resolve GitHub repo full name to local repo name
   - validate duplicate GitHub repo mappings across local repos
2. Add `packages/gateway/src/github.ts`
   - verify `X-Hub-Signature-256`
   - define supported webhook schemas
   - normalize supported events into a compact internal shape
   - detect bot mentions from configured GitHub logins
   - resolve branch from payload or GitHub API lookup
   - derive ordered correlation key candidates
3. Add focused unit tests for config validation, signature verification, normalization, mention detection, and key derivation

**Exit criteria:**

- [ ] Workspace config accepts optional repo-level GitHub mappings without breaking existing config files
- [ ] Duplicate GitHub repo mappings are rejected with explicit validation errors
- [ ] Supported GitHub webhook payloads normalize into a typed internal shape
- [ ] Mention detection is configurable and unit-tested
- [ ] Branch resolution is unit-tested for direct-payload and API-lookup paths
- [ ] Events with unresolved branch context are dropped with explicit logging

### Phase 2 — Gateway webhook route + queueing

Add GitHub App webhook intake to `packages/gateway` using the existing queue.

1. Add `POST /github/webhook` in `packages/gateway/src/app.ts`
2. Verify required GitHub headers and HMAC signature
3. Ignore unsupported events and unmapped repos with `200 { ok: true, ignored: true }`
4. Enqueue normalized GitHub events with:
   - `source: "github"`
   - `id: X-GitHub-Delivery`
   - resolved correlation key
   - source timestamp from payload when available, otherwise request time
   - interrupt flag and delay based on mention detection
5. Drop supported events that still cannot resolve a branch after lookup
6. Add route tests for valid, invalid, ignored, and unmapped cases

**Exit criteria:**

- [ ] Valid supported GitHub webhooks are accepted and enqueued
- [ ] Invalid signatures return 401
- [ ] Unsupported events do not enqueue work and do not create retries
- [ ] Unmapped GitHub repos are logged and ignored safely
- [ ] Events without a resolvable branch are logged and ignored safely
- [ ] Queue event IDs use `X-GitHub-Delivery`

### Phase 3 — Runner dispatch for GitHub events

Route queued GitHub events into the runner using the correct repo directory and continuity key.

1. Add `GitHubQueuedEvent` handling in `packages/gateway/src/app.ts`
2. Add `triggerRunnerGitHub()` in `packages/gateway/src/service.ts`
3. Resolve the local repo directory using the mapped repo name
4. Send normalized GitHub event batches to the runner as prompt context
5. Preserve busy-session semantics:
   - mention events can interrupt
   - non-mention events remain queued until the runner accepts
6. Add tests for dispatch, batching, busy retry, and correlation resolution behavior

**Exit criteria:**

- [ ] GitHub events trigger the runner in the correct repo directory
- [ ] Mention events interrupt busy sessions for the same correlation key
- [ ] Non-mention events defer and retry until the runner accepts
- [ ] Branch-backed events can continue a session via existing `git:branch:*` aliases
- [ ] No secondary issue/PR correlation model is required for the MVP path

### Phase 4 — Operator docs + hardening

Document setup and close the main operational gaps.

1. Update `docs/examples/workspace-config.example.json`
2. Document the GitHub App webhook setup, supported events, required permissions, and secret configuration
3. Add gateway startup logging for configured GitHub repo mappings
4. Add focused redelivery/dedup tests around `X-GitHub-Delivery`
5. Document current GitHub-originated UX limitations explicitly

**Exit criteria:**

- [ ] Example config shows GitHub repo mapping
- [ ] Operators can configure webhook secret and mention logins from docs alone
- [ ] Docs list the exact supported GitHub events for MVP
- [ ] GitHub-originated limitations are documented accurately

## Decision Log

| #   | Decision                                                                 | Rationale                                                                                                                        |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Reuse `packages/gateway` for GitHub webhook intake                       | Gateway already owns signed external event intake, queueing, and runner dispatch.                                               |
| 2   | Start with a narrow event allowlist                                      | Limits noise and makes tests and ops predictable while still covering the requested workflows.                                  |
| 3   | Normalize GitHub payloads before prompting the runner                    | Smaller prompts, clearer tests, and less coupling to GitHub's full webhook schema.                                              |
| 4   | Add explicit repo-level GitHub mappings in workspace config              | Repo routing should be declarative and validated, not inferred from installation or filesystem heuristics.                      |
| 5   | Keep `github_app.installations` auth-only                                | Webhook routing and execution auth are related but distinct concerns.                                                            |
| 6   | Keep a branch-only correlation model for MVP                             | The user wants code-flow scope only; a branch-only model stays simpler if unresolved events are dropped.                        |
| 7   | Mentions interrupt; other supported GitHub events do not                 | Matches the earlier interrupt design and keeps GitHub noise from constantly aborting active sessions.                           |
| 8   | Use configurable GitHub mention logins                                   | Bot mention identity can vary by app slug, bot account, or migration path.                                                      |
| 9   | Ignore unsupported or unmapped webhook events with HTTP 200              | Prevents GitHub retries for events Thor intentionally does not handle.                                                           |
| 10  | Allow one GitHub API lookup when the webhook lacks branch context        | Keeps the continuity model branch-based while still handling PR-backed events that omit head ref in the webhook payload.        |
| 11  | Defer Slack progress mirroring for GitHub-originated sessions            | Existing progress plumbing is Slack-thread-centric; ingestion can ship independently of a richer cross-channel UX.              |
| 12  | Use `X-GitHub-Delivery` as the queue event ID                            | Best available dedupe key for webhook deliveries and aligns with the existing queue overwrite model.                            |

## Risks / Open Questions

1. GitHub mentions may need to match more than one identity (`app slug`, bot login, or both); confirm the operator-facing configuration shape before implementation.
2. `pull_request_review.submitted` can exist without a meaningful body; Phase 1 should define whether empty-body reviews are ignored during normalization.
3. The gateway will need GitHub API auth for branch lookup on some PR-backed events; decide whether to reuse existing app-installation auth helpers directly or add a lighter helper in gateway.
4. GitHub-originated sessions currently have no first-class Slack thread for approvals/progress; if that becomes required, a follow-on plan should define the notification surface.
5. GitHub webhook signatures do not include a timestamp header like Slack, so replay protection in MVP is limited to signature validation plus delivery-ID dedupe.

## Out of Scope

- Full GitHub webhook coverage beyond the MVP event allowlist
- Non-code-flow events such as `issues.assigned`
- Backfilling historical GitHub comments, assignments, or reviews
- Automatically replying back to GitHub issues or PRs from Thor
- Automatic Slack progress mirroring for GitHub-originated sessions
- Durable replay-prevention storage beyond existing queue semantics
- GitHub-side assignment ownership rules or triage policy
