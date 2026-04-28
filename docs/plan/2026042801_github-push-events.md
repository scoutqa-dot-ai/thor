# GitHub push event sync and worktree cleanup

**Date**: 2026-04-28  
**Status**: Implemented  
**Branch**: `feat/github-push-events`  
**Scope**: Add GitHub `push` webhook handling for local repo/worktree sync, deleted-branch worktree cleanup, and optional non-interrupt OpenCode wake-up.

## Goal

Handle GitHub `push` webhooks in the gateway so Thor keeps local checkouts fresh without creating noisy sessions. A push to a repository default branch should fast-forward the mounted repo at `/workspace/repos/<repo-name>`. A push to a non-default branch should fast-forward an existing matching worktree at `/workspace/worktrees/<repo-name>/<branch-name>`. A deleted branch push should remove the matching worktree only when it exists and is clean. Delete events must never wake OpenCode.

## Current state

- `packages/gateway/src/github.ts` models GitHub webhooks as a zod-parsed pass-through `GitHubWebhookEvent` discriminated union. Current variants are `issue_comment`, `pull_request_review_comment`, `pull_request_review`, and `check_suite`.
- `packages/gateway/src/app.ts` accepts only those event headers in `GITHUB_SUPPORTED_EVENTS`; `push` is currently rejected before JSON schema parsing.
- Gateway already has `createInternalExecClient()` and remote-cli already exposes `POST /internal/exec`, guarded by `THOR_INTERNAL_SECRET`, for trusted service-to-service maintenance commands.
- Remote-cli policy intentionally rejects agent-facing `git pull`; push handling should use `/internal/exec`, not broaden the agent git policy.
- Existing GitHub `check_suite` wake-up already uses branch correlation keys and `findNotesFile(resolvedKey)` to avoid creating arbitrary sessions.

## Non-goals

- Do not make `push` events agent-visible by default.
- Do not wake OpenCode for branch deletion events.
- Do not add `git pull` to remote-cli's agent-facing `/exec/git` policy.
- Do not create worktrees for branches that do not already have one.
- Do not remove dirty worktrees.
- Do not handle tag pushes beyond explicitly ignoring/logging them.

## Design

### Payload model

Add a `PushEventSchema` to `packages/gateway/src/github.ts` and include it in `GitHubWebhookEnvelopeSchema`.

Lean fields required:

```ts
{
  event_type: "push";
  ref: string;
  before: string;
  after: string;
  created?: boolean;
  deleted?: boolean;
  forced?: boolean;
  installation: { id: number };
  repository: {
    full_name: string;
    default_branch: string;
  };
  sender: { id: number; login: string; type: string };
  pusher?: { name?: string; email?: string };
  head_commit?: {
    id?: string;
    message?: string;
    url?: string;
    timestamp?: string;
  } | null;
  commits?: Array<{ id?: string }>;
}
```

Extend helpers:

- `withEventType(raw)` detects push payloads via `ref` + `before` + `after` and sets `event_type: "push"`.
- `isPushEvent(raw)` type guard.
- `getGitHubEventType(raw)` returns `"push"`.
- `getGitHubEventBranch(raw)` returns the branch suffix for `refs/heads/<branch>`; returns `null` for tags/other refs.
- `getGitHubEventSourceTs(raw)` should use `head_commit.timestamp` when present; fall back to `Date.now()` at enqueue time if unavailable, especially for delete events where `head_commit` can be `null`.
- `shouldIgnoreGitHubEvent(raw, options)` should not apply PR mention-gating to push events. Pushes are infrastructure maintenance signals, not user prompts.

### Route handling

Add `push` to `GITHUB_SUPPORTED_EVENTS` in `packages/gateway/src/app.ts`.

After signature verification, JSON parse, schema parse, repo mapping, and event-header cross-check, branch to push-specific handling before the existing PR/comment/check-suite queue path:

```ts
if (isPushEvent(parsed.data)) {
  await handleGitHubPushEvent(...);
  res.status(200).json({ ok: true, ignored?: true, status });
  return;
}
```

Push handling is operational side-effect work; it should either perform sync/cleanup and return, or log a skip/failure and return. It should not enqueue the raw push event into the normal GitHub runner queue unless the optional wake-up rules below explicitly choose to do so.

### Branch and path safety

Branch extraction:

- Accept only refs with prefix `refs/heads/`.
- Branch name is the suffix, preserving slashes (for example `feat/file-handoff`).
- Reject/ignore empty branch names.

Default branch sync target:

- If `branch === repository.default_branch`, target `resolveRepoDirectory(localRepo)`, expected to resolve under `/workspace/repos/<repo-name>`.

Worktree sync/cleanup target:

- For non-default branches, candidate path is `/workspace/worktrees/<repo-name>/<branch>`.
- Resolve with `realpath` before use.
- Require the real path to equal or be nested under `/workspace/worktrees/<repo-name>/` and to point to the expected candidate. This protects branch names with `..`, symlinks, and accidental prefix collisions.
- If missing, log a skip status and return. Do not create the worktree.

### Non-deleted push: fast-forward sync

For `deleted !== true`:

1. Resolve the target directory:
   - default branch: main repo directory
   - non-default branch: existing matching worktree
2. Run via `internalExec`:

```ts
{ bin: "git", args: ["pull", "--ff-only", "origin", branch], cwd: targetDir }
```

3. If the command exits non-zero, log sync failure and do not wake OpenCode.
4. If successful, optionally wake OpenCode:
   - Build raw key `git:branch:<repo>:<branch>`.
   - Resolve aliases with `resolveCorrelationKeys([rawKey])`.
   - Require `findNotesFile(resolvedKey)` to exist.
   - If a notes file exists, enqueue the push payload as a GitHub-source queue event with `interrupt: false`. The synced target remains metadata only; dispatch resolves through the repo directory so the runner receives an allowed `/workspace/repos/<repo>` directory and same-key GitHub batches do not split across sources/directories.

   - If no notes file exists, log `correlation_key_unresolved` and stop.

### Deleted push: clean worktree removal

For `deleted === true`:

1. Accept only branch refs. Ignore tag/other refs.
2. Resolve only the matching non-default branch worktree at `/workspace/worktrees/<repo>/<branch>`.
   - If the deleted branch is the default branch, log a protected/default-branch cleanup skip and do nothing.
   - If no worktree exists, log missing and do nothing.
3. Verify cleanliness via internal exec in the worktree:

```ts
{ bin: "git", args: ["status", "--porcelain"], cwd: worktreeDir }
```

4. If `stdout.trim()` is non-empty, log dirty and do not delete.
5. If clean, remove using Git so worktree metadata is cleaned up:

```ts
{ bin: "git", args: ["worktree", "remove", worktreeDir], cwd: repoDir }
```

6. Never trigger/enqueue OpenCode for delete events, regardless of correlation key state.

## Logging/status taxonomy

Use structured logs and webhook history metadata with explicit statuses. Proposed statuses:

### Non-deleted push

- `push_sync_default_branch_pulled`: default branch repo fast-forwarded successfully.
- `push_sync_worktree_pulled`: matching branch worktree fast-forwarded successfully.
- `push_sync_worktree_missing`: branch push received but no matching worktree exists.
- `push_sync_non_branch_ref_ignored`: tag/other ref ignored.
- `push_sync_failed`: pull command failed.
- `push_wake_triggered`: successful sync woke an existing correlation key with `interrupt:false`.
- `push_wake_skipped_no_session`: successful sync had no matching notes/correlation file.

### Deleted push

- `push_delete_worktree_removed`: matching clean worktree removed.
- `push_delete_worktree_dirty`: matching worktree exists but was not clean; removal skipped.
- `push_delete_worktree_missing`: branch delete received but no matching worktree exists.
- `push_delete_default_branch_ignored`: delete event targets the default branch; no removal attempted.
- `push_delete_non_branch_ref_ignored`: tag/other ref delete ignored.
- `push_delete_cleanup_failed`: status check or worktree removal failed.

Include at least: `deliveryId`, `repoFullName`, `localRepo`, `branch`, `ref`, `after`, `targetDir` when available, `exitCode` on command failure, and `correlationKey` when wake-up is evaluated.

## Phases

### Phase 1 — Schema and pure helpers

**Changes**

- Add `PushEventSchema` and `PushEvent` type in `packages/gateway/src/github.ts`.
- Add `isPushEvent` and push support in event type/source timestamp/branch helpers.
- Add branch-ref extraction helper, exported for tests.
- Update tests in `packages/gateway/src/github.test.ts` with the attached example payload and deleted/tag variants.

**Exit criteria**

- `pnpm --filter @thor/gateway exec vitest run src/github.test.ts` passes.
- Push branch extraction preserves slash-containing branch names.
- Deleted push payload with `head_commit: null` parses.

### Phase 2 — Push sync and delete cleanup in gateway

**Changes**

- Add `push` to `GITHUB_SUPPORTED_EVENTS`.
- Add `handleGitHubPushEvent` in `packages/gateway/src/app.ts` or a small dedicated module if app.ts becomes too large.
- Use existing `internalExec` to run `git pull --ff-only origin <branch>` for sync events.
- Use `git status --porcelain` and `git worktree remove <path>` for deleted-branch cleanup.
- Add path-safety helpers for worktree resolution.
- Record explicit log/history statuses from the taxonomy.

**Exit criteria**

- Default branch push calls internal exec with cwd `/workspace/repos/<repo>`.
- Existing nested worktree push calls internal exec with cwd `/workspace/worktrees/<repo>/<branch>`.
- Missing worktree push logs skip and does not trigger runner.
- Deleted branch clean worktree removes via `git worktree remove`.
- Deleted branch dirty worktree is preserved.
- All delete paths assert no runner trigger.

### Phase 3 — Optional non-interrupt wake-up after successful sync

**Changes**

- After successful non-delete sync, resolve `git:branch:<repo>:<branch>` through `resolveCorrelationKeys`.
- Require `findNotesFile(resolvedKey)` before wake-up.
- Trigger the runner with `interrupt:false`, directory set to the synced checkout, and a minimal prompt.
- Do not wake on failed sync, missing worktree, non-branch refs, or deleted branches.

**Exit criteria**

- Existing session/correlation gets a non-interrupt trigger after successful pull.
- Missing notes file skips wake-up with a clear status.
- Delete event never triggers wake-up, even when notes exist.

### Phase 4 — Verification and docs

**Changes**

- Add/update tests in `packages/gateway/src/app.test.ts` and `packages/gateway/src/github.test.ts`.
- Update `docs/github-app-webhooks.md` with operational behavior for push sync and deleted-branch cleanup.
- If needed, add a short note in README/operator docs that `/internal/exec` is used for service-side push maintenance.

**Exit criteria**

- Targeted gateway tests pass.
- Docs describe supported push behavior, ignored cases, and dirty-worktree safety.

## Test matrix

| Case | Expected behavior |
| --- | --- |
| Push to default branch | `git pull --ff-only origin <default>` in `/workspace/repos/<repo>` |
| Push to existing branch worktree | `git pull --ff-only origin <branch>` in matching worktree |
| Push to branch with slash | Preserves full branch name and resolves nested worktree path safely |
| Push to branch without worktree | Logs `push_sync_worktree_missing`; no runner trigger |
| Tag push | Logs `push_sync_non_branch_ref_ignored`; no pull, no trigger |
| Pull fails | Logs `push_sync_failed`; no trigger |
| Pull succeeds + notes file exists | Non-interrupt runner trigger |
| Pull succeeds + no notes file | Logs `push_wake_skipped_no_session`; no trigger |
| Deleted branch + clean worktree | Status check then `git worktree remove`; no trigger |
| Deleted branch + dirty worktree | Logs dirty; does not remove; no trigger |
| Deleted branch + missing worktree | Logs missing; no trigger |
| Deleted tag | Logs delete non-branch ignored; no trigger |

## Decision log

| # | Decision | Rationale |
| --- | --- | --- |
| D-1 | Use `/internal/exec` for `git pull` instead of changing `/exec/git` policy | Push sync is trusted gateway maintenance. Agent-facing policy should remain conservative and continue to reject `git pull`. |
| D-2 | Do not create missing worktrees | Push events can be high-volume; creating worktrees would be surprising and could exhaust disk. Existing worktree means Thor already has branch-local context. |
| D-3 | Deleted branch events never wake OpenCode | Cleanup is operational housekeeping. Waking an agent for branch deletion would be noisy and can race with PR-merge cleanup. |
| D-4 | Require clean worktree before deletion | Protects uncommitted human/agent work. Dirty worktrees need manual review. |
| D-5 | Prefer `git worktree remove` over raw filesystem deletion | Keeps Git worktree metadata consistent and avoids stale worktree admin entries. |
| D-6 | Wake only when a resolved notes file exists | Prevents arbitrary pushes from creating new sessions while still letting branch-linked work continue after external updates. |
| D-7 | Queue push wakes as GitHub events, not cron prompts | Runner directories are restricted to `/workspace/repos/*`, and same-key GitHub batches must resolve to one directory. Keeping the wake in the GitHub queue source avoids mixed-source drops and uses the repo-scoped directory resolver. |

## Follow-up log

2026-04-28: Codex review identified that branch worktree paths are not runner-allowed directories and cron-sourced wakes can conflict with same-key GitHub batches. Updated push wakes to enqueue as GitHub-source events while retaining the synced worktree path as operational metadata only.

## Open questions

- Should default branch pushes ever wake an existing `git:branch:<repo>:<default>` session, or should they only sync the repo? Proposed default: allow wake only if notes file exists, same as branch worktrees.
- Should forced pushes (`forced === true`) use the same `git pull --ff-only` path and simply log failure if non-FF, or should they be skipped up front? Proposed default: run `--ff-only` and let it fail safely.
- Should deleted dirty worktrees produce a Slack/admin notification, or is structured logging sufficient for the first iteration? Proposed default: structured log only.

## Log

2026-04-28 13:10 coder: implemented GitHub push schema/helpers, gateway fast-forward sync, clean deleted-worktree cleanup, optional notes-backed non-interrupt wake, docs, and targeted tests; tests: `pnpm --filter @thor/gateway exec vitest run src/github.test.ts` passed (23), `pnpm --filter @thor/gateway exec vitest run src/app.test.ts` passed (59), `pnpm --filter @thor/gateway exec tsc --noEmit` passed.
2026-04-28 13:16 coder: handled internalExec push sync/cleanup rejections safely, routed skipped push statuses to ignored history, and added skip/failure tests; tests: `pnpm --filter @thor/gateway exec vitest run src/github.test.ts src/app.test.ts` passed (86), `pnpm --filter @thor/gateway exec tsc --noEmit` passed.
