---
name: using-gh
description: "GitHub CLI surface allowed by Thor's remote-cli server policy. Append-only: Thor can create PRs, comments, and non-approval reviews but cannot approve, merge, edit, or delete prior artifacts."
---

## Posture

All `gh` commands go through Thor's remote-cli which enforces:

- **Append-only writes.** Create PRs/issues, post PR/issue comments, submit `--comment`/`--request-changes` reviews. Never approve, merge, edit, or delete.
- **Repo-targeting flags are blocked.** `--repo`/`-R` is not part of the supported surface.
- **`gh api` is a tiny explicit subset.** REST implicit GET reads are allowed with output shaping. One append-only POST shape is allowed for PR review-comment replies.
- **PR approval is a human gate.** `gh pr review --approve` is denied.
- **PR review requires a worktree.** `gh pr diff` and `gh pr checkout` are denied — see "Reviewing a PR" below.

## Reviewing a PR

When asked to review or critique a PR, the first action is always to check out the branch to a worktree:

```
git fetch origin pull/<N>/head:pr-<N>
git worktree add /workspace/worktrees/<repo>/pr-<N> pr-<N>
```

Then `cd` into the worktree for every subsequent action — diffs, code search, tests, builds, file reads. Reviewing through `gh pr diff`, `git show <ref>` of an unfetched commit, or `gh api repos/.../pulls/<N>/files` produces shallow reviews because you can't run tests, can't grep beyond the diff, and can't reproduce the build.

For the same reason, `gh pr checkout <N>` is also denied — it would mutate the current worktree's branch state. Use the fetch + worktree-add pattern instead.

## Structured commands

### `gh pr create`

Required: `--title`/`-t` plus `--body`/`-b`. Optional: `--base`/`-B`, `--head`/`-H`, `--draft`, `--label`/`-l` (repeatable), `--assignee`/`-a` (repeatable), `--reviewer`/`-r` (repeatable). Blocked: `--editor`, `--web`, `--repo`/`-R`, `--fill`, `-F`/`--body-file` (no mutable body value for Thor to inject the trigger viewer link into — pass an explicit `--body`).

`--head` must equal the branch implied by cwd (`/workspace/worktrees/<repo>/<branch>`) — the explicit form of the default that `gh pr create` would pick anyway. To PR from a different branch, `cd` into that worktree first. Cross-fork (`<owner>:<branch>`) and protected branches (`main`/`master`) fall out as side effects.

### `gh issue create`

Required: `--title`/`-t` plus `--body`/`-b`. Optional: `--label`/`-l` (repeatable). Blocked: `--editor`, `--web`, `--repo`/`-R`, `-F`/`--body-file`, assignee/project/milestone mutation, and any missing explicit body. Successful creates receive Thor's traceability footer and bind the created `github:issue:` session for later issue comments.

### `gh pr comment`

Required: numeric PR selector plus `--body`/`-b`. Blocked: non-numeric selectors, edit/delete modes, `--editor`, `-F`/`--body-file`, and `--repo`/`-R`.

### `gh issue comment`

Required: numeric issue selector plus `--body`/`-b`. Blocked: non-numeric selectors, edit/delete modes, `--editor`, `-F`/`--body-file`, and `--repo`/`-R`. For PR conversation comments, prefer `gh pr comment`; both comment paths receive Thor's traceability footer.

### `gh pr review`

Required: `--body`/`-b` and exactly one of `--comment`/`-c` or `--request-changes`/`-r`. Optional positional selector: numeric PR number only. `--approve`/`-a` is denied. Blocked: non-numeric selectors, interactive/file flags, and `--repo`/`-R`.

### `gh run rerun`

Required: numeric run ID. Optional: `--failed` (rerun only failed jobs), `--debug`. Blocked: `--job`, `--repo`/`-R`.

### `gh run download`

Required: numeric run ID. Optional: `--dir`/`-D <path>`, `--name`/`-n <artifact>` (repeatable), `--pattern`/`-p <glob>` (repeatable). Blocked: `--repo`/`-R`.

### `gh workflow run`

Required: workflow selector (workflow file name or numeric ID, positional, no flag-leading values). Optional: `--ref <branch>`, and repeatable workflow inputs via `-f key=value` (raw string) or `-F key=value` (typed: number, boolean, null, or `@file` to load from disk). Blocked: `--repo`/`-R`.

### `gh api`

Read path: implicit GET only. Required: REST endpoint as the first positional argument. Optional flags: `--jq`/`-q`, `--template`/`-t`, `--silent`, `--include`/`-i`, and `--paginate` (follow `Link` headers across pages).

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
