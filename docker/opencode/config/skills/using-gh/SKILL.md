---
name: using-gh
description: "GitHub CLI surface allowed by Thor's remote-cli server policy. Append-only: Thor can create PRs, comments, and non-approval reviews but cannot approve, merge, edit, or delete prior artifacts."
---

## Posture

All `gh` commands go through Thor's remote-cli which enforces:

- **Append-only writes.** Create PRs, post comments, submit `--comment`/`--request-changes` reviews. Never approve, merge, edit, or delete.
- **`--repo`/`-R` is allowed on read commands only.** Reads can target any repo. Writes (`pr create`, `pr comment`, `pr review`, `run rerun`, `run download`, `workflow run`, and `gh api` writes) stay scoped to the current worktree's origin — `cd` into the right worktree and drop the flag.
- **`gh api` is a tiny explicit subset.** REST implicit GET reads are allowed with output shaping. GraphQL is allowed for read queries only (no `mutation` keyword, no non-GET method, no `-F` field loading). One append-only POST shape is allowed for PR review-comment replies.
- **PR approval is a human gate.** `gh pr review --approve` is denied.
- **`gh pr checkout` is denied** because it would mutate the current worktree branch — use the fetch + worktree-add pattern in "Reviewing a PR" below.
- **`gh pr diff <N>` is allowed** as a read-only shortcut, but a fetched worktree gives a deeper review surface (run tests, grep, build). Prefer the worktree pattern when actually reviewing.

## Reviewing a PR

When asked to review or critique a PR, the first action is always to check out the branch to a worktree:

```
git fetch origin pull/<N>/head:pr-<N>
git worktree add /workspace/worktrees/<repo>/pr-<N> pr-<N>
```

Then `cd` into the worktree for every subsequent action — diffs, code search, tests, builds, file reads. Reviewing through `gh pr diff`, `git show <ref>` of an unfetched commit, or `gh api repos/.../pulls/<N>/files` produces shallow reviews because you can't run tests, can't grep beyond the diff, and can't reproduce the build.

For the same reason, `gh pr checkout <N>` is also denied — it would mutate the current worktree's branch state. Use the fetch + worktree-add pattern instead.

## Structured commands

### `gh pr diff`

Read-only PR file/patch view. `gh pr diff <N> [--patch] [--name-only]` is allowed. For a fuller review surface (tests, build, grep), prefer the fetch + worktree pattern above.

### `gh pr create`

Required: `--title`/`-t` plus `--body`/`-b`. Optional: `--base`/`-B`, `--head`/`-H`, `--draft`, `--label`/`-l` (repeatable), `--assignee`/`-a` (repeatable), `--reviewer`/`-r` (repeatable). Blocked: `--editor`, `--web`, `--repo`/`-R`, `--fill`, `-F`/`--body-file` (no mutable body value for Thor to inject the trigger viewer link into — pass an explicit `--body`).

`--head` must equal the branch implied by cwd (`/workspace/worktrees/<repo>/<branch>`) — the explicit form of the default that `gh pr create` would pick anyway. To PR from a different branch, `cd` into that worktree first. Cross-fork (`<owner>:<branch>`) and protected branches (`main`/`master`) fall out as side effects.

### `gh issue create`

Blocked in v1: GitHub issue content is outside Thor's disclaimer-injection scope. Use Jira for tracked work.

### `gh pr comment`

Required: numeric PR selector plus `--body`/`-b`. Blocked: non-numeric selectors, edit/delete modes, `--editor`, `-F`/`--body-file`, and `--repo`/`-R`.

### `gh issue comment`

Blocked in v1: GitHub issue content is outside Thor's disclaimer-injection scope. Use Jira for tracked work.

### `gh pr review`

Required: `--body`/`-b` and exactly one of `--comment`/`-c` or `--request-changes`/`-r`. Optional positional selector: numeric PR number only. `--approve`/`-a` is denied. Blocked: non-numeric selectors, interactive/file flags, and `--repo`/`-R`.

### `gh run rerun`

Required: numeric run ID. Optional: `--failed` (rerun only failed jobs), `--debug`. Blocked: `--job`, `--repo`/`-R`.

### `gh run download`

Required: numeric run ID. Optional: `--dir`/`-D <path>`, `--name`/`-n <artifact>` (repeatable), `--pattern`/`-p <glob>` (repeatable). Blocked: `--repo`/`-R`.

### `gh workflow run`

Required: workflow selector (workflow file name or numeric ID, positional, no flag-leading values). Optional: `--ref <branch>`, and repeatable workflow inputs via `-f key=value` (raw string) or `-F key=value` (typed: number, boolean, null, or `@file` to load from disk). Blocked: `--repo`/`-R`.

### `gh api`

REST read path: implicit GET only. Required: REST endpoint as the first positional argument. Optional flags: `--jq`/`-q`, `--template`/`-t`, `--silent`, `--include`/`-i`, and `--paginate` (follow `Link` headers across pages).

GraphQL read path: `gh api graphql -f query=<query> [--jq …] [--template …] [--silent] [--include] [--paginate]`. Exactly one `query=` raw field is required, that query value cannot contain the `mutation` keyword, `--method` must be unset or `GET`, and `-F`/`--field` is blocked (it can load file content as the query body). Pass `-f` (raw-field) only.

Append-only review-comment reply path: the current-repo placeholder endpoint is allowed, as is the explicit endpoint when `<owner>/<repo>` matches the GitHub.com repo resolved from the current cwd's `origin` remote:

```bash
gh api repos/{owner}/{repo}/pulls/<pull-number>/comments/<comment-id>/replies --method POST -f body=<text>
gh api repos/<owner>/<repo>/pulls/<pull-number>/comments/<comment-id>/replies --method POST -f body=<text>
```

`<pull-number>` and `<comment-id>` must be numeric, `body` must be non-empty, and `-f`/`--raw-field` is the only accepted body source. Explicit endpoints require an origin remote on `github.com` with the same owner/repo because `--hostname` is blocked. Cross-repo or wrong-host explicit write endpoints, `-F`/`--field`, `--input`, headers, previews, GraphQL, edit/delete endpoints, and arbitrary `--method` use remain blocked.

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
