---
name: using-gh
description: GitHub CLI surface allowed by Thor's remote-cli server policy. Append-only: Thor can create PRs, comments, and non-approval reviews but cannot approve, merge, edit, or delete prior artifacts.
---

## Posture

All `gh` commands go through Thor's remote-cli which enforces:

- **Append-only writes.** Create PRs, post comments, submit `--comment`/`--request-changes` reviews. Never approve, merge, edit, or delete.
- **Repo-targeting flags are blocked.** `--repo`/`-R` is not part of the supported surface.
- **`gh api` is a tiny read-only subset.** REST only, implicit GET only, output-shaping flags only.
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

One of: `--title`/`-t` plus a body source (`--body`/`-b` or `-F`/`--body-file <path>`), OR `--fill` (no title/body needed; derived from commits). Optional: `--base`/`-B`, `--head`/`-H`, `--draft`, `--label`/`-l` (repeatable), `--assignee`/`-a` (repeatable), `--reviewer`/`-r` (repeatable). Blocked: `--editor`, `--web`, `--repo`/`-R`, and combining `--fill` with `--title`/`--body`/`-F`.

`--head` must equal the branch implied by cwd (`/workspace/worktrees/<repo>/<branch>`) — the explicit form of the default that `gh pr create` would pick anyway. To PR from a different branch, `cd` into that worktree first. Cross-fork (`<owner>:<branch>`) and protected branches (`main`/`master`) fall out as side effects.

### `gh issue create`

Required: `--title`/`-t`, `--body`/`-b`. Optional: `--label`/`-l` (repeatable). Blocked: `--repo`/`-R`, `--assignee`, `--project`, `--milestone`, `--editor`, `--web`, `--body-file`, `--template`, `--recover`.

### `gh pr comment`

Required: numeric PR selector plus a body source (`--body`/`-b` or `-F`/`--body-file <path>`). Blocked: non-numeric selectors, edit/delete modes, `--editor`, and `--repo`/`-R`.

### `gh issue comment`

Required: numeric issue selector plus `--body`/`-b`. Blocked: non-numeric selectors, interactive/file flags, and `--repo`/`-R`.

### `gh pr review`

Required: `--body`/`-b` and exactly one of `--comment`/`-c` or `--request-changes`/`-r`. Optional positional selector: numeric PR number only. `--approve`/`-a` is denied. Blocked: non-numeric selectors, interactive/file flags, and `--repo`/`-R`.

### `gh run rerun`

Required: numeric run ID. Optional: `--failed` (rerun only failed jobs), `--debug`. Blocked: `--job`, `--repo`/`-R`.

### `gh run download`

Required: numeric run ID. Optional: `--dir`/`-D <path>`, `--name`/`-n <artifact>` (repeatable), `--pattern`/`-p <glob>` (repeatable). Blocked: `--repo`/`-R`.

### `gh workflow run`

Required: workflow selector (workflow file name or numeric ID, positional, no flag-leading values). Optional: `--ref <branch>`, and repeatable workflow inputs via `-f key=value` (raw string) or `-F key=value` (typed: number, boolean, null, or `@file` to load from disk). Blocked: `--repo`/`-R`.

### `gh api`

Implicit GET only. Required: REST endpoint as the first positional argument. Optional flags: `--jq`/`-q`, `--template`/`-t`, `--silent`, `--include`/`-i`, and `--paginate` (follow `Link` headers across pages). Blocked: `graphql`, `--method`/`-X`, `--input`, `-H`/`--header`, `--preview`, `--hostname`, `-f`/`--raw-field`, and `-F`/`--field`.

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
