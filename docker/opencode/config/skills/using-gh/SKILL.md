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

## Common redirect

Instead of `gh pr checkout <N>`:

```
git fetch origin pull/<N>/head:pr-<N>
git worktree add -b pr-<N> /workspace/worktrees/<repo>/pr-<N> pr-<N>
```

## Structured commands

### `gh pr create`

Required: `--title`/`-t`, `--body`/`-b`. Optional: `--base`/`-B`, `--draft`. Blocked: `--head`, `--editor`, `--web`, `--body-file`, and `--repo`/`-R`.

### `gh pr comment`

Required: numeric PR selector plus `--body`/`-b`. Blocked: non-numeric selectors, edit/delete modes, interactive/file flags, and `--repo`/`-R`.

### `gh issue comment`

Required: numeric issue selector plus `--body`/`-b`. Blocked: non-numeric selectors, interactive/file flags, and `--repo`/`-R`.

### `gh pr review`

Required: `--body`/`-b` and exactly one of `--comment`/`-c` or `--request-changes`/`-r`. Optional positional selector: numeric PR number only. `--approve`/`-a` is denied. Blocked: non-numeric selectors, interactive/file flags, and `--repo`/`-R`.

### `gh api`

Implicit GET only. Required: REST endpoint as the first positional argument. Optional flags: `--jq`/`-q`, `--template`/`-t`, `--silent`, `--include`/`-i`, and `--paginate` (follow `Link` headers across pages). Blocked: `graphql`, `--method`/`-X`, `--input`, `-H`/`--header`, `--preview`, `--hostname`, `-f`/`--raw-field`, and `-F`/`--field`.

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
