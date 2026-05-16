---
name: using-git
description: Git command surface allowed by Thor's server-side policy. Thor's git is append-only to the local repo and to origin. Load this skill to see what commands are allowed and the common redirect patterns.
---

## Posture

All `git` commands go through Thor's server-side policy, which enforces:

- **Switch branches via worktrees.** Use `git worktree add <path> <ref>` to work on a different ref.
- **Pushes target `origin HEAD:refs/heads/<branch>` explicitly**, to any branch other than `main` or `master`.
- **Pick up upstream changes with `git fetch origin <branch>` followed by `git merge origin/<branch>`.**
- **`git config` is read-only.** `--get`, `--get-all`, and `--list` are supported, with optional `--local`/`--show-origin`/`--show-scope` modifiers.
- **`git -C <abspath>` works when `<abspath>` resolves inside `/workspace/repos` or `/workspace/worktrees`.** The flag is stripped and the path becomes the effective working directory for the rest of the command.
- **`git clone` is narrow and deployment-configured.** One URL positional of the form `https://github.com/<owner>/<repo>[.git]` with an owner on Thor's clone allowlist; Thor derives `/workspace/repos/<repo>`.
- **Use `git restore` for file restore.**

## Common redirects

To work on a different branch:

```
git worktree add -b <branch> /workspace/worktrees/<repo>/<branch> <start-point>
```

To review PR #123:

```
git fetch origin pull/123/head:pr-123
git worktree add -b pr-123 /workspace/worktrees/<repo>/pr-123 pr-123
```

## Policy-enforced commands

The commands below have Thor-specific shape constraints. Other `git` subcommands are not listed here; try the usual invocation and treat any denial response as the authoritative signal that the shape isn't supported.

### `git clone`

Supported shape:

```
git clone https://github.com/<allowed-owner>/<repo>[.git]
```

The source URL must exactly match `https://github.com/<owner>/<repo>` or `https://github.com/<owner>/<repo>.git`, and `<owner>` must be on Thor's clone allowlist. Thor derives the destination as `/workspace/repos/<repo-name-from-url>`. When Git prompts for credentials, Thor's existing GitHub App askpass flow selects the installation by the owner in the clone URL.

### `git ls-remote`

Two supported shapes:

- `git ls-remote [<flags>]` — bare/flag-only. Thor rewrites the command to pass `origin` explicitly.
- `git ls-remote [<flags>] origin [<ref-pattern>...]` — explicit `origin` is required whenever any positional is present, including ref patterns. Pass `origin` explicitly when you want ref-pattern filtering.

Supported flags: `--heads`/`-h`, `--tags`/`-t`, `--refs`, `--quiet`/`-q`, `--exit-code`, `--symref`, and `--sort=<key>` / `--sort <key>`.

### `git tag`

List-only: `git tag`, `git tag -l [<pattern>...]`, `git tag --list [<pattern>...]`, optionally with `-n[<num>]` output, `--sort=<key>` / `--sort <key>`, and `--format=<fmt>` / `--format <fmt>` selectors.

### `git stash`

Read-only subcommands: `git stash list [...]` and `git stash show [...]`.

### `git branch`

Read-only: `git branch --show-current`, `git branch -a`, `git branch --all`, `git branch --list [<pattern>]`, or `git branch (-a|--all) --list [<pattern>]`.

### `git remote`

Read-only: `git remote`, `git remote -v`, `git remote --verbose`, `git remote show origin`, `git remote get-url origin`.

### `git fetch`

Supported shapes:

- `git fetch [<flags>]` — bare fetch (e.g. `git fetch`, `git fetch --prune`); Thor rewrites the command to pass `origin` explicitly.
- `git fetch origin [<ref>...]` — fetch from origin, optionally scoped to refs.
- `git fetch --all` — fetch every configured remote (standalone, no positional remote).
- Approved flags on any shape: `--prune`/`-p`, `--tags`/`-t`, `--no-tags`, `--depth=<n>`. Use either `--tags` or `--no-tags`, one at a time.

### `git restore`

Use `git restore [--source <tree>] [--staged|-S] -- <path...>` for file restore or unstaging. `--staged`/`-S` unstages the listed paths (the replacement for `git reset <path>`); combine with `--source <tree>` to restore staged content from a specific tree.

### `git add`

Supported forms: `git add -A` or `git add <path...>`.

### `git commit`

Non-interactive only. Provide exactly one body source:

- `git commit -m <subject> [-m <paragraph>...]` — one or more `-m` messages.
- `git commit -F <path>` / `git commit --file=<path>` — read the message from a file.

Use `-m` or `-F`, one at a time.

### `git worktree`

Supported subcommands:

- `git worktree add` in one of three shapes:
  - `git worktree add -b <new-branch> <path> [<start-point>]` — create a new branch in a new worktree.
  - `git worktree add <path> <existing-branch>` — check out an existing branch (e.g. one just created by `git fetch origin pull/<N>/head:<branch>`) into a new worktree.
  - `git worktree add --detach <path> <commit-ish>` — create a detached-HEAD worktree at a specific commit (PR-review-by-SHA flows).

  In all three shapes, `<path>` must be under `/workspace/worktrees/<repo>/<label>`. For the branch shapes (`-b` and existing-branch), the portion under `/workspace/worktrees/<repo>/` **must equal `<branch>` verbatim** (including slash-separated branch names like `feat/auth`); correlation-key routing infers branch from worktree path. For `--detach` `<label>` is freeform (commonly `pr-<N>`) and the structural prefix check still applies. Approved arguments may appear in any order that Git accepts.

- `git worktree list [--porcelain]`.
- `git worktree remove <path>` — `<path>` must be under `/workspace/worktrees/`. Clean uncommitted state first.
- `git worktree prune [--dry-run]` — remove admin entries for worktrees whose directories are gone.

### `git push`

Supported shape: `git push origin HEAD:refs/heads/<branch>`, with optional `--dry-run` and either `-u` or `--set-upstream`. Those approved flags may appear in any order that Git accepts. The target branch must be something other than `main` or `master`.

### `git config`

Read-only inspection:

- `git config --get <key>`
- `git config --get-all <key>`
- `git config --list` / `git config -l`

Optional modifiers: `--local`, `--show-origin`, `--show-scope`.

### `git -C <path>`

`git -C <abspath> <subcommand> …` works when `<abspath>` resolves inside `/workspace/repos` or `/workspace/worktrees`. Thor strips the `-C` and runs the subcommand with the path's realpath as the effective working directory. Both `-C <abspath>` (two args) and `-C=<abspath>` (one combined arg) are supported.
