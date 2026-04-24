---
name: using-git
description: Git command surface allowed by Thor's remote-cli server policy. Thor's git is append-only to the local repo and to origin. Load this skill to see what commands are allowed and the common redirect patterns.
---

## Posture

All `git` commands go through Thor's remote-cli which enforces:

- **No branch switching in-place.** `git checkout <ref>` and `git switch` are denied — use `git worktree add <path> <ref>` instead.
- **No force-push or implicit push resolution.** Pushes must target `origin HEAD:refs/heads/<branch>` explicitly.
- **Pushes only to `origin`**, never to protected branches `main` or `master`.
- **No config or broad ref-introspection helpers outside the allowlist.** `git config`, `git symbolic-ref`, and generic `git rev-parse` forms are denied.
- **Use `git restore` for file restore.** `git checkout -- <path>` is not part of the supported surface.

## Common redirects

Instead of switching branches in place:

```
git worktree add -b <branch> /workspace/worktrees/<repo>/<branch> <start-point>
```

Instead of `gh pr checkout 123`:

```
git fetch origin pull/123/head:pr-123
git worktree add -b pr-123 /workspace/worktrees/<repo>/pr-123 pr-123
```

## Structured commands

### `git merge-base`

Supported shapes: `git merge-base <left> <right>`, `git merge-base --is-ancestor <left> <right>`, and `git merge-base --fork-point <ref> [<commit>]`.

### `git ls-remote`

Network-safe form only: `git ls-remote [<flags>] origin [<ref-pattern>...]`. Non-`origin` remotes are denied.

### `git tag`

List-only: `git tag`, `git tag -l [<pattern>...]`, `git tag --list [<pattern>...]`, optionally with `-n[<num>]` output. Creation, deletion, signing, and move flags are denied.

### `git stash`

Read-only subcommands only: `git stash list [...]` and `git stash show [...]`. `stash push`/`pop`/`apply`/`drop`/`clear` are denied.

### `git branch`

Read-only only: `git branch --show-current`, `git branch -a`, `git branch --all`, `git branch --list [<pattern>]`, or `git branch (-a|--all) --list [<pattern>]`.

### `git rev-parse`

Exact forms only: `git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD`, `git rev-parse --short HEAD`, `git rev-parse --short=<N> HEAD`, `git rev-parse --show-toplevel`, `git rev-parse --git-dir`, `git rev-parse --is-inside-work-tree`.

### `git remote`

Read-only only: `git remote`, `git remote -v`, `git remote --verbose`, `git remote show origin`, `git remote get-url origin`.

### `git fetch`

Exact remote only: `git fetch origin [<ref>...]`. Flags are not part of the supported surface.

### `git restore`

Use `git restore [--source <tree>] -- <path...>` for file restore. This replaces all `git checkout` restore support.

### `git add`

Allowed forms: `git add -A` or `git add <path...>`. Extra flags are not supported.

### `git commit`

Exact non-interactive shape only: `git commit -m <message>`.

### `git worktree`

Only `git worktree add` is supported, with:

- one `-b <branch>`
- a worktree `<path>` under `/workspace/worktrees/`
- an optional `<start-point>`

Those safe arguments may appear in any order that Git accepts.

### `git push`

Only `git push origin HEAD:refs/heads/<branch>` is supported, with optional `--dry-run` and either `-u` or `--set-upstream`. Those approved flags may appear in any order that Git accepts. Force, implicit upstream resolution, and pushes to protected branches (`main`, `master`) are denied.

## Passthrough subcommands (any arguments accepted)

- `git blame`
- `git cat-file`
- `git describe`
- `git diff`
- `git for-each-ref`
- `git grep`
- `git log`
- `git ls-files`
- `git name-rev`
- `git reflog`
- `git shortlog`
- `git show`
- `git show-ref`
- `git status`

## Safe under `git --no-pager`

No `git --no-pager` forms are supported.
