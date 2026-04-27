# Drop Non-Mention GitHub Comments

**Date**: 2026-04-27
**Status**: Ready to implement

## Goal

Stop forwarding GitHub PR comments that do not mention the configured app
(`@${GITHUB_APP_SLUG}`) into the runner. Today, comments addressed to other
bots (e.g. `@codex review`) on a PR owned by an existing
`slack:thread:...` session are still re-keyed onto that session and reach
opencode as instructions, causing it to act on requests not directed at it.

After this change: only comments that explicitly mention the app's slug fire
the runner. Other comments are dropped at the gateway with a structured log.

## Current State

- `packages/gateway/src/github.ts` — `normalizeGitHubEvent()` returns events
  with `mention: detectMention(body, mentionLogins)`. When `mention === false`
  the event is **still** returned (not ignored), only with longer debounce and
  `interrupt: false` downstream.
- `packages/gateway/src/app.ts` (and `service.ts`) consume the normalized
  event regardless of the `mention` flag and enqueue a runner trigger keyed
  by branch correlation. For PRs created from a Slack-started session, the
  branch correlation is then re-mapped to the originating
  `slack:thread:...` key, so opencode resumes with the comment body as
  context/instruction.
- Tests covering ignored reasons live in
  `packages/gateway/src/github.test.ts:84-158` (one test per reason).

## Design

Treat "non-mention GitHub comment" as another **early-ignore** reason in the
normalizer, alongside `pure_issue_comment_unsupported` /
`fork_pr_unsupported` / `self_sender` / `empty_review_body` /
`event_unsupported`.

Per-event-type rule:

- `issue_comment.created` (PR-scoped) — drop unless mention.
- `pull_request_review_comment.created` — drop unless mention **or** PR
  was opened by us (`pull_request.user.login` ∈ `mentionLogins`).
- `pull_request_review.submitted` — drop unless mention **or** PR was
  opened by us.

The bot-PR exception keeps the natural review loop: when opencode opens a
PR, every reviewer comment / review on that PR is feedback aimed at it, so
no `@mention` should be required. For human-opened PRs, the contract stays
"mention me to act."

### Why at the gateway, not the runner

- Cheaper: no enqueue, no remote-cli branch lookup, no runner wake-up.
- Predictable contract: "ping `@${slug}` to act" — no soft model-side rule
  that can be ignored.
- Single chokepoint: same place all other ignore reasons live.

### Trade-off accepted

Opencode loses passive visibility into PR comments that do not mention it.
This is intentional: if a comment is for someone else (human reviewer or
another bot), opencode should not be reading it as input. Users who want
opencode to act on a PR comment must mention `@${GITHUB_APP_SLUG}`.

## Phases

### Phase 1 — Gateway filter + tests

**Changes**

- `packages/gateway/src/github.ts`
  - Extend `IgnoreReason` with `"non_mention_comment"`.
  - In `normalizeGitHubEvent()`, after computing `mention`, return
    `{ ignored: true, reason: "non_mention_comment" }` when `mention` is
    false. Apply to all three event branches. Place the check **after**
    `self_sender` / `fork_pr_unsupported` / `empty_review_body` so existing
    drop reasons keep priority and stay observable.
  - Remove `mention` from `NormalizedGitHubEvent` (always true once we reach
    normalization success). Update consumers that read `.mention`:
    - `packages/gateway/src/app.ts` / `service.ts` — wherever debounce or
      `interrupt` is selected. With this change every GitHub event is a
      mention, so collapse to the "mention" branch (3s debounce, interrupt
      true). Verify via grep before deleting.
- `packages/gateway/src/github.test.ts`
  - Add test: `issue_comment` body without mention → ignored with
    `non_mention_comment`.
  - Add test: `pull_request_review_comment` body without mention → ignored.
  - Add test: `pull_request_review` body without mention → ignored.
  - Update any existing test that asserted a normalized event for a
    non-mention body — they should now expect the ignore result.
- `packages/gateway/src/app.test.ts` / `service.test.ts`
  - Adjust any fixtures that relied on `mention: false` events being
    forwarded. If a test specifically covered the non-mention forward path,
    flip it to assert the drop.

**Exit criteria**

- `pnpm exec vitest run packages/gateway/src/github.test.ts packages/gateway/src/app.test.ts packages/gateway/src/service.test.ts`
  passes.
- New unit tests assert the drop for all three event types.
- `mention` field is no longer referenced in gateway sources (grep clean).
- Ignored events emit a structured log including
  `reason: "non_mention_comment"` (matches the existing logging shape used
  for `pure_issue_comment_unsupported`).

### Phase 2 — Integration verification

- Push branch, let GitHub-app webhook E2E (whichever workflow currently
  exercises gateway → runner) run.
- If no workflow auto-triggers on these paths, dispatch the gateway
  integration workflow manually.
- Manual smoke (optional, post-merge in a staging install): on a PR owned by
  a Slack-started session, leave a comment `@codex review` — confirm
  opencode does **not** wake. Then leave `@i-am-thor please review` — confirm
  it does.

**Exit criteria**

- Required GitHub checks green on the push.
- PR opened against `main` only after checks pass.

## Decision Log

| Decision                                                         | Choice             | Rationale                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where to filter                                                  | Gateway normalizer | Cheapest, single chokepoint, matches existing ignore-reason pattern.                                                                                                                                 |
| Keep passive context for non-mention comments?                   | No                 | Avoids ambiguity about what counts as an instruction; opencode acts only when explicitly addressed.                                                                                                  |
| Keep `mention` field on the normalized event?                    | Drop it            | After this change every forwarded GitHub event is a mention, so the field is dead weight.                                                                                                            |
| Denylist of other-bot mentions (`@codex`, `@claude`, …) instead? | Rejected           | Maintenance burden and brittle; "mention me to act" is a stronger contract.                                                                                                                          |
| Bot-PR exception for review events?                              | Yes — review-only  | When opencode opened the PR, all reviews/inline review comments on it are feedback aimed at it. Not extended to `issue_comment` because those are easier to address to other bots (`@codex review`). |

## Out of Scope

- Changing how Slack-thread correlation re-keys GitHub events onto an
  existing session. The correlation behavior stays as-is.
- Slash-command or label-based triggers for PR comments.
- Issue-only (non-PR) comment handling. Still ignored as
  `pure_issue_comment_unsupported`.
- Runner-side filtering or system-prompt changes.
