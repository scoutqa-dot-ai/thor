---
name: using-git
description: Git command surface allowed by Thor's remote-cli server policy. Thor's git is append-only to the local repo and to origin. Load this skill to see what commands are allowed and the common redirect patterns.
---

## Posture

All `git` commands go through Thor's remote-cli which enforces:

- **No branch switching in-place.** `git checkout <ref>` and `git switch` are denied — use `git worktree add <path> <ref>` instead.
- **No force-push or implicit push resolution.** Pushes must target `origin HEAD:refs/heads/<branch>` explicitly.
- **Pushes only to `origin`**, never to protected branches `main` or `master`.
- **No `git pull`.** It depends on local upstream/config and can silently rebase. Run `git fetch origin <branch>` then `git merge origin/<branch>` instead.
- **`git config` is read-only.** Only `--get`, `--get-all`, and `--list` (with optional `--local`/`--show-origin`/`--show-scope`) are allowed. Scope overrides (`--global`, `--system`, `--file`) and mutation (`--add`, `--unset`, `--replace-all`, …) are denied.
- **`git -C <abspath>` is allowed when `<abspath>` is inside `/workspace/repos/<repo>` or `/workspace/worktrees/<repo>/<branch>`.** The flag is stripped and the path becomes the effective working directory for the rest of the command. Paths outside the workspace, relative paths, and bare `git -C <path>` (with no subcommand) are denied.
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

Network-safe form only: `git ls-remote [<flags>] [origin] [<ref-pattern>...]`. Omitting the remote defaults to `origin`. Non-`origin` remotes (other names, URLs) are denied.

### `git tag`

List-only: `git tag`, `git tag -l [<pattern>...]`, `git tag --list [<pattern>...]`, optionally with `-n[<num>]` output, `--sort=<key>` / `--sort <key>`, and `--format=<fmt>` / `--format <fmt>` selectors. Creation, deletion, signing, and move flags are denied.

### `git stash`

Read-only subcommands only: `git stash list [...]` and `git stash show [...]`. `stash push`/`pop`/`apply`/`drop`/`clear` are denied.

### `git branch`

Read-only only: `git branch --show-current`, `git branch -a`, `git branch --all`, `git branch --list [<pattern>]`, or `git branch (-a|--all) --list [<pattern>]`.

### `git remote`

Read-only only: `git remote`, `git remote -v`, `git remote --verbose`, `git remote show origin`, `git remote get-url origin`.

### `git fetch`

Supported shapes:

- `git fetch [<flags>]` — bare fetch (e.g. `git fetch`, `git fetch --prune`) defaults to `origin`.
- `git fetch origin [<ref>...]` — fetch from origin, optionally scoped to refs.
- `git fetch --all` — fetch every configured remote (standalone, no positional remote).
- Approved flags on any shape: `--prune`/`-p`, `--tags`/`-t`, `--no-tags`, `--depth=<n>` (positive integer). `--tags` and `--no-tags` cannot be combined.

### `git restore`

Use `git restore [--source <tree>] [--staged|-S] -- <path...>` for file restore or unstaging. `--staged`/`-S` unstages the listed paths (the replacement for `git reset <path>`); combine with `--source <tree>` to restore staged content from a specific tree. This replaces all `git checkout` restore support.

### `git add`

Allowed forms: `git add -A` or `git add <path...>`. Extra flags are not supported.

### `git commit`

Non-interactive only. Exactly one body source must be provided:

- `git commit -m <subject> [-m <paragraph>...]` — one or more `-m` messages. Multiple `-m` flags map to separate paragraphs.
- `git commit -F <path>` / `git commit --file=<path>` — read the message from a file.

`-m` and `-F` cannot be combined. Other flags (`--amend`, `--no-verify`, `-a`, `-s`, `--signoff`) remain denied.

### `git worktree`

Supported subcommands:

- `git worktree add` in one of three shapes:
  - `git worktree add -b <new-branch> <path> [<start-point>]` — create a new branch in a new worktree.
  - `git worktree add <path> <existing-branch>` — check out an existing branch (e.g. one just created by `git fetch origin pull/<N>/head:<branch>`) into a new worktree.
  - `git worktree add --detach <path> <commit-ish>` — create a detached-HEAD worktree at a specific commit (PR-review-by-SHA flows).

  In all three shapes, `<path>` must be under `/workspace/worktrees/<repo>/<label>`. For the branch shapes (`-b` and existing-branch), the portion under `/workspace/worktrees/<repo>/` **must equal `<branch>` verbatim** (including slash-separated branch names like `feat/auth`); correlation-key routing infers branch from worktree path. For `--detach` there is no branch, so `<label>` is freeform (commonly `pr-<N>`) but the structural prefix check still applies. Approved arguments may appear in any order that Git accepts.

- `git worktree list [--porcelain]` — read-only enumeration.
- `git worktree remove <path>` — `<path>` must be under `/workspace/worktrees/`. `--force` is denied; clean uncommitted state first.
- `git worktree prune [--dry-run]` — remove admin entries for worktrees whose directories are gone.

### `git push`

Only `git push origin HEAD:refs/heads/<branch>` is supported, with optional `--dry-run` and either `-u` or `--set-upstream`. Those approved flags may appear in any order that Git accepts. Force, implicit upstream resolution, and pushes to protected branches (`main`, `master`) are denied.

### `git merge`

Passthrough — any merge shape is accepted (FF, no-FF, squash, strategies, octopus, `--abort`/`--continue`/`--quit`, custom messages, merging local or remote refs). The merge target is whatever you're currently checked out on, so the existing protected-branch and force-push rules on `git push` cover the only externally-visible damage.

The only denied flag is `--no-verify`, which would skip `pre-merge-commit` / `commit-msg` hooks (mirrors the same deny on `git commit`).

To pick up upstream changes, run `git fetch origin <branch>` then `git merge origin/<branch>`. This replaces `git pull`.

### `git revert`

Passthrough — any revert shape is accepted. Revert adds inverse changes instead of rewriting existing commits; protected-branch and explicit-push rules still govern what can be pushed to origin.

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
- `git rev-parse`
- `git revert`
- `git shortlog`
- `git show`
- `git show-ref`
- `git status`

### `git config`

Read-only inspection only:

- `git config --get <key>`
- `git config --get-all <key>`
- `git config --list` / `git config -l`

Optional modifiers: `--local`, `--show-origin`, `--show-scope`. Mutation (`--add`, `--unset`, `--unset-all`, `--replace-all`, `--rename-section`, `--remove-section`), scope overrides (`--global`, `--system`, `--file`), and positional `key value` forms are all denied.

### `git -C <path>`

`git -C <abspath> <subcommand> …` is allowed when `<abspath>` is inside `/workspace/repos/<repo>` or `/workspace/worktrees/<repo>/<branch>`. Thor strips the `-C` and runs the subcommand with `<abspath>` as the effective working directory. Both `-C <abspath>` (two args) and `-C=<abspath>` (one combined arg) are supported. Relative paths, paths outside the workspace, and bare `git -C <path>` with no subcommand are denied.

## Safe under `git --no-pager`

No `git --no-pager` forms are supported.
