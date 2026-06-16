---
name: using-gh
description: "GitHub CLI surface allowed by Thor's remote-cli server policy. Append-only: Thor can create PRs, comments, and non-approval reviews but cannot approve, merge, edit, or delete prior artifacts."
---

## Posture

All `gh` commands go through Thor's remote-cli which enforces:

- **Append-only writes.** Create PRs, post PR/issue comments, submit `--comment`/`--request-changes` reviews. Issue creation is supported only after human approval. Approval, merge, edit, and delete are human gates.
- **`cd` into the target worktree** before running write commands — repo-targeting flags aren't part of the supported surface. For cross-repo API reads, use explicit REST endpoints such as `repos/<owner>/<repo>/...`.
- **Non-interactive bodies only.** Pass `--body`/`-b` directly; editor, web, and body-file flags aren't supported on the write surface.
- **`gh api` is a small explicit subset.** REST implicit GET reads are allowed with output shaping. One append-only POST shape is allowed for PR review-comment replies. GraphQL and arbitrary `--method` use are out of scope.
- **PR review through the worktree.** `gh pr diff` is fine for a quick scan; a fetched worktree gives the deeper surface (tests, grep, build). See `using-git` for the fetch + worktree-add pattern.

Anything not listed below — or any unsupported flag combination — returns a policy denial; treat that as the authoritative signal.

## Structured commands

### `gh pr diff`

Read-only PR file/patch view. `gh pr diff <N> [--patch] [--name-only]` is allowed. For a fuller review surface (tests, build, grep), prefer the fetch + worktree pattern above.

### `gh pr create`

Required: `--title`/`-t` plus `--body`/`-b`. Optional: `--base`/`-B`, `--head`/`-H`, `--draft`, `--label`/`-l` (repeatable), `--assignee`/`-a` (repeatable), `--reviewer`/`-r` (repeatable).

`--head` must equal the branch implied by cwd (`/workspace/worktrees/<repo>/<branch>`) — the explicit form of the default that `gh pr create` would pick anyway. To PR from a different branch, `cd` into that worktree first.

### `gh issue create`

Required: `--title`/`-t` plus `--body`/`-b`. Optional: `--label`/`-l` (repeatable), `--assignee`/`-a` (repeatable). Issue creation requires human approval: calling it returns an action ID instead of creating the issue; check status with `approval status <action-id>` for the approved result.

### `gh pr comment`

Required: numeric PR selector plus `--body`/`-b`. Use this for PR conversation-level replies, not inline review-thread replies.

### `gh issue comment`

Required: numeric issue selector plus `--body`/`-b`. For PR conversation comments, prefer `gh pr comment`; both comment paths receive Thor's traceability footer.

### `gh pr review`

Required: `--body`/`-b` and exactly one of `--comment`/`-c` or `--request-changes`/`-r`. Optional positional selector: numeric PR number only.

### `gh run rerun`

Required: numeric run ID. Optional: `--failed` (rerun only failed jobs), `--debug`.

### `gh run download`

Required: numeric run ID. Optional: `--dir`/`-D <path>`, `--name`/`-n <artifact>` (repeatable), `--pattern`/`-p <glob>` (repeatable).

### `gh workflow run`

Required: workflow selector (workflow file name or numeric ID, positional, no flag-leading values). Optional: `--ref <branch>`, and repeatable workflow inputs via `-f key=value` (raw string) or `-F key=value` (typed: number, boolean, null, or `@file` to load from disk).

### `gh api`

REST read path: implicit GET only. Required: REST endpoint as the first positional argument. Optional flags: `--jq`/`-q`, `--template`/`-t`, `--silent`, `--include`/`-i`, and `--paginate` (follow `Link` headers across pages).

Append-only review-comment reply path: the current-repo placeholder endpoint is allowed, as is the explicit endpoint when `<owner>/<repo>` matches the GitHub.com repo resolved from the current cwd's `origin` remote:

```bash
gh api repos/{owner}/{repo}/pulls/<pull-number>/comments/<comment-id>/replies --method POST -f body=<text>
gh api repos/<owner>/<repo>/pulls/<pull-number>/comments/<comment-id>/replies --method POST -f body=<text>
```

Use this reply path for inline PR review-thread replies; `gh pr comment` creates a top-level PR conversation comment instead. `<pull-number>` and `<comment-id>` must be numeric, `body` must be non-empty, and `-f`/`--raw-field` is the accepted body source. Explicit endpoints must target the same `<owner>/<repo>` as the current cwd's `origin` remote on github.com.

## Read-only (passthrough) commands

- `gh auth status`
- `gh cache list`
- `gh issue list`
- `gh issue view`
- `gh label list`
- `gh pr checks`
- `gh pr diff`
- `gh pr list`
- `gh pr status`
- `gh pr view` (numeric selectors and PR URLs are both allowed on the read path)
- `gh repo view`
- `gh release list`
- `gh run list`
- `gh run view`
- `gh run watch`
- `gh search code`
- `gh search issues`
- `gh search prs`
- `gh search repos`
- `gh workflow list`
- `gh workflow view`

## Additional constrained read-only commands

- `gh release view <tag|latest> ...`

`gh release download` is still blocked because it has local filesystem side effects.
