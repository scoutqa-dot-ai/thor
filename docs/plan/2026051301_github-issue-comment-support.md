# GitHub Issue Comment Support

**Date:** 2026-05-13  
**Status:** Draft / ready to implement

## Goal

Enable Thor to participate on GitHub issues end-to-end:

- Outbound `gh issue comment` is a supported append-only GitHub write surface and receives the same Thor disclaimer / trigger-viewer traceability footer as existing PR writes.
- Inbound pure-issue `issue_comment.created` events that mention Thor are accepted and can intentionally wake or resume a Thor session, rather than being ignored as `pure_issue_comment_unsupported`.
- Policy, docs, and tests move together so the operator runbook and `using-gh` skill match runtime behavior.

## Current behavior

- `packages/remote-cli/src/policy-gh.ts` allowlists `gh issue view/list`, but denies `gh issue comment` because issue comments were outside v1 disclaimer scope.
- `packages/remote-cli/src/index.ts` injects GitHub disclaimers only into `gh pr create`, `gh pr comment`, `gh pr review`, and the allowlisted review-comment reply `gh api` shape.
- `packages/gateway/src/github.ts` classifies pure issue comments as `pure_issue_comment_unsupported` before mention handling.
- PR-backed `issue_comment` events have no branch in the webhook payload and use `pending:branch-resolve:<repo>:<number>` so `service.ts` can call `gh pr view`; pure issues have no branch to resolve.
- Correlation aliases currently cover Slack threads and git branches only (`packages/common/src/correlation.ts`, `packages/common/src/event-log.ts`). A new GitHub issue correlation key will not be durable unless a first-class alias type is added.

## Design

### Outbound issue comments

Support the same constrained form as PR comments:

```bash
gh issue comment <number> --body <text>
gh issue comment <number> -b <text>
```

Rules:

- Numeric selector required.
- Exactly one explicit body value required.
- `--body-file`, editor/web modes, edit/delete shapes, extra positionals, non-numeric selectors, and `--repo` / `-R` remain denied.
- Disclaimer injection appends to that single mutable body field via the existing `buildThorDisclaimerForSession()` path and fails closed when no active trigger can be inferred.

`gh issue comment` can technically target PR numbers because PRs are issues in GitHub's API. The supported guidance will still direct agents to use `gh pr comment` for PR conversation comments, but the policy-level safety property is the same for both: numeric target, current repo auth, one traced body, append-only.

### Inbound pure issue comments

Add a durable issue correlation key:

```text
github:issue:<localRepo>:<repoFullName>#<issueNumber>
```

Add alias support:

```ts
"github.issue";
```

with alias value `base64url(<full correlation key>)`, matching `git.branch`'s safe filename / case-folding story. This gives pure issue comments the same anchor/session durability as Slack and branch correlations. Without this alias type, the runner would mint a new anchor for every pure issue mention and fail to resume the prior issue session.

Inbound filter changes:

- Keep self-loop blocking by numeric `GITHUB_APP_BOT_ID`.
- Keep mention-gating for first-contact issue comments. Pure issue comments are accepted when the body mentions a configured app login (`@<slug>` or `@<slug>[bot]`) or when the durable `github:issue:` key already resolves to a live session. Non-mention pure issue comments with no existing session continue to be ignored as `non_mention_comment`.
- For PR-backed issue comments, preserve the existing pending branch-resolution path.
- For pure issue comments, skip branch resolution and enqueue directly on `github:issue:<localRepo>:<repoFullName>#<number>` with `interrupt: true`, `delayMs: githubMentionDelay`.

Prompt/directory behavior:

- Directory resolves to the mapped repo directory (`/workspace/repos/<localRepo>`), because an issue has no branch worktree.
- The prompt should make clear this is a GitHub **issue** comment and include repo, issue number, sender, action, body, and `comment.html_url`. JSON rendering can remain as an implementation detail, but tests should assert the runner receives enough issue context to act intentionally.

### Traceability and self-loop behavior

Outbound `gh issue comment` comments get the same viewer URL footer as PR comments. When GitHub later sends the bot's own `issue_comment` webhook, the gateway drops it as `self_sender`, preventing Thor from waking itself.

## Phases

### Phase 1 — Correlation and inbound routing

Touched files:

- `packages/common/src/event-log.ts`
- `packages/common/src/correlation.ts`
- `packages/gateway/src/github.ts`
- `packages/gateway/src/app.ts`
- `packages/gateway/src/service.ts`
- `packages/gateway/src/github.test.ts`
- `packages/gateway/src/app.test.ts` and/or service tests covering queue dispatch

Tasks:

1. Add `github.issue` to alias types and update `aliasForCorrelationKey()` so `github:issue:` keys resolve through `base64url(full key)`.
2. Add a `buildIssueCorrelationKey(localRepo, repoFullName, issueNumber)` helper in gateway GitHub utilities.
3. Replace `pure_issue_comment_unsupported` for pure issue comments with mention-gated acceptance:
   - self sender → `self_sender`
   - no mention → `non_mention_comment`
   - mention → accept
4. In `/github/webhook`, route pure issue comments to `buildIssueCorrelationKey(...)` rather than `pending:branch-resolve`.
5. Keep PR-backed `issue_comment` behavior unchanged: branch stays unknown at intake, then `planBatchDispatch()` resolves it via `gh pr view` and reroutes to `git:branch:`.
6. Ensure pure issue batches dispatch to the repo directory without calling `resolveGitHubPrHead()`.

Exit criteria:

- A pure issue comment without a mention is ignored as `non_mention_comment`.
- A pure issue comment with a Thor mention is enqueued/accepted with a `github:issue:` correlation key and wakes the runner.
- A second mention on the same issue resolves to the same anchor/session through the new alias type.
- Existing PR comment branch-resolution tests still pass.

### Phase 2 — Outbound `gh issue comment` / `gh issue create` policy and disclaimer injection

Touched files:

- `packages/remote-cli/src/policy-gh.ts`
- `packages/remote-cli/src/policy.test.ts`
- `packages/remote-cli/src/index.ts`
- `packages/remote-cli/src/gh-disclaimer.test.ts`
- `docker/opencode/config/skills/using-gh/SKILL.md`

Tasks:

1. Add `issue comment` to the allowlisted command set.
2. Implement `validateGhIssueCommentArgs()` mirroring `validateGhPrCommentArgs()`.
3. Update deny guidance so invalid issue-comment shapes point to `gh issue comment <number> --body <text>` instead of saying issues are out of scope.
4. Include `args[0] === "issue" && ["create", "comment"].includes(args[1])` in `withGhDisclaimer()` eligibility.
5. Extend disclaimer tests to prove injected footer, duplicate-body fail-closed, no-session fail-closed, and help passthrough for `gh issue comment --help`.
6. Update the `using-gh` skill structured command list and posture to include traced issue comments.

Exit criteria:

- Valid issue comments execute with a single injected footer.
- Invalid body sources and duplicate mutable body fields are denied before execution.
- Existing PR write, review, and `gh api` disclaimer behavior is unchanged.
- Valid issue creates execute with a traced body and bind `github:issue:<localRepo>:<owner>/<repo>#<number>` from the returned GitHub URL.

### Phase 3 — Docs and integration coverage

Touched files:

- `docs/github-app-webhooks.md`
- `docs/feat/event-flow.md`
- `docs/plan/2026042301_github-app-webhooks.md` (post-implementation note, not a rewrite)
- `docs/plan/2026043001_session-event-log.md` (alias-type addendum, if still treated as source of truth)

Tasks:

1. Update the operator runbook:
   - Issues permission is still read/write and now explicitly supports inbound issue mentions plus outbound issue comments.
   - `pure_issue_comment_unsupported` is no longer a normal troubleshooting reason.
   - Explain that issue comments require a Thor mention to wake a session.
2. Update event-flow docs with `github:issue:` correlation keys and `github.issue` aliases.
3. Add short post-implementation notes to older plans that originally declared pure issues unsupported, so future readers do not treat stale plan text as current behavior.
4. Run targeted package tests, then root test/build as appropriate for the branch.

Exit criteria:

- Docs describe exactly the same supported inbound/outbound surfaces as code and skill policy.
- Test evidence covers gateway inbound acceptance/ignore paths and remote-cli outbound injection/denial paths.

## Decision log

| Decision                                                              | Rationale                                                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Use `github:issue:<localRepo>:<repoFullName>#<number>` as the raw key | Pure issues have no branch; including both local repo and GitHub full name keeps the key readable while preserving routing context. |
| Add `github.issue` alias with `base64url(full key)` value             | Required for durable session resume; mirrors git branch encoding and avoids separator/case-folding edge cases.                      |
| Mention-gate pure issue comments                                      | Prevents every issue discussion comment from waking Thor; the user must intentionally invoke the app.                               |
| Keep PR-backed issue comments on `git:branch:`                        | Existing PR conversations should continue with branch/worktree sessions and CI/push aliases.                                        |
| Reuse the existing disclaimer footer builder                          | Keeps issue comments traceable to the same trigger viewer and fail-closed behavior as PR comments/reviews.                          |
| Allow non-mention comments only on already-engaged pure issues         | Lets ongoing GitHub issue sessions continue naturally without broadening first-contact intake for unrelated issue discussions.       |
| Bind `gh issue create` from the returned issue URL                     | Thor-authored issues need the durable `github:issue:` alias immediately so later comments can wake the same session.                 |

## Risks and mitigations

- **Alias schema expansion touches common event-log parsing.** Mitigate with focused alias/correlation tests and by preserving backwards-compatible parsing for existing alias records.
- **`gh issue comment` can comment on PR conversation numbers.** Mitigate in docs/skill guidance: use `gh pr comment` for PRs. Safety remains acceptable because both paths are append-only and traced.
- **Pure issue sessions run from the repo default checkout, not a branch worktree.** Make this explicit in prompts/docs; agents should create branches/PRs intentionally if code changes are needed.
- **Stale docs currently say pure issues are unsupported.** Update runbook and event-flow as source-of-truth, and add notes to old plan docs rather than silently leaving contradictions.

## Verification plan

- `pnpm --filter @thor/common test` or the repo's common/package test target covering correlation aliases.
- `pnpm --filter @thor/gateway test` for webhook normalization, app acceptance/ignore cases, and dispatch/reroute behavior.
- `pnpm --filter @thor/remote-cli test` for policy and disclaimer injection.
- Root `pnpm test` / `pnpm build` if targeted tests pass and time permits.
