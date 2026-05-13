# Policy relaxations to reduce tool-call failures

## Context

Auto-health report (`findings_2.md`) attributed 119 deduped agent failures to "policy-blocked commands". Many are command shapes that are read-only or safety-equivalent to already-allowed shapes — the policy is just stricter than it needs to be. Relaxing those without weakening real safety boundaries should retire most of that bucket.

## Scope

Ten relaxations across `packages/remote-cli/src/policy-gh.ts` and `policy-git.ts`, plus matching tests and `using-gh` / `using-git` skill docs.

### `gh` relaxations

1. **`--repo` / `-R` allowed on read-only commands.** The ban exists to keep writes scoped; reads have no auth-scoping concern. Allow it on every command in `READ_ONLY_GH_COMMANDS`; keep banning it on `pr create`, `pr comment`, `pr review`, `run rerun`, `run download`, `workflow run`, and `api` mutation shapes.
2. **`gh pr diff <N>` allowed.** Pure read; the "use a worktree instead" guidance is workflow opinion, not safety.
3. **`gh api graphql` read-only allowed.** Accept when exactly one `-f query=…` is provided, no `--method` is provided or `--method GET`, and the query does not contain a `mutation` block. Writes (`mutation`, `--method POST/PUT/PATCH/DELETE`) remain blocked.
4. **`gh run view --log-failed` test lock.** Already accepted by the validator (it only gates `args[2]`), but add a regression test so we don't break it later.

### `git` relaxations

5. **`git -C <abspath> <subcmd> …` allowed when `<abspath>` is inside `WORKSPACE_REPOS_ROOT` or `WORKSPACE_WORKTREES_ROOT`.** Strip the `-C <path>` prefix and override the effective cwd. Identical to a workdir change; no new capability.
6. **Bare `git fetch` and `git fetch --prune` allowed.** Rewrite to pass `origin` when no positional is supplied, avoiding Git's branch-upstream default. Already-allowed `git fetch origin --prune` is just a longer way to type the same thing.
7. **Bare `git ls-remote` allowed.** Rewrite to pass `origin` when no repo positional is supplied, matching the fetch relaxation.
8. **`git config --get <key>` / `--get-all <key>` / `--list` allowed.** Read-only, scoped to local repo config. Deny `--global`, `--system`, `--file`, and any write subflag (`--unset`, `--add`, `--replace-all`).
9. **`git tag --sort=<key>` and `--format=<fmt>` allowed in list mode.** Read-only listing flags; today only `-l`/`--list`/`-n[N]` pass.
10. **`git worktree add --detach <path> <commit-ish>` allowed.** Required for PR-review-by-SHA flows. Path must still live under `/workspace/worktrees/<repo>/`; the last segment is treated as a freeform label (commonly `pr-<N>`) rather than required to equal the ref.

## Phases

### Phase 1 — Plan + intent

Land this plan document. Single commit.

### Phase 2 — `gh` policy relaxations

- `policy-gh.ts`: split the repo-override deny into write-only; allow `pr diff`; allow GraphQL read shape.
- `policy.test.ts`: extend the gh suite with positive cases for each relaxation and locked negative cases (still-blocked writes/mutations).
- `using-gh/SKILL.md`: document the new surface.

Exit criteria: full `pnpm test` passes; new gh tests cover both the relaxed positive cases and at least one regression case per relaxation.

### Phase 3 — `git` policy relaxations

- `policy-git.ts`: extend `ResolvedGitArgs` to optionally carry a rewritten `cwd`; accept leading `-C <path>` and validate the path against workspace prefixes. Relax `validateFetch` / `validateLsRemote` / `validateTag` / `validateWorktreeAdd`. Add a small `validateConfig` and wire it through `ALLOWED_GIT_SUBCOMMANDS`.
- `index.ts` (`/exec/git`): when resolution returns a rewritten cwd, use it for `validateCwd` + `execCommand`.
- `policy.test.ts`: extend the git suite with positives for each relaxation and the kept-denials around them.
- `using-git/SKILL.md`: document the new surface.

Exit criteria: full `pnpm test` passes; `pnpm typecheck` clean.

## Out of scope

- Policy changes outside `gh` / `git` (scoutqa, langfuse, ldcli, metabase).
- Sandbox/Dockerfile changes (covered by the orthogonal findings_2 review thread).
- Agent system-prompt injection of workspace layout (separate planned change).

## Decision log

| Decision                                                                                           | Reason                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Carry rewritten cwd through `ResolvedGitArgs` instead of mutating args in place.                   | Keeps `validateCwd` enforcement in `/exec/git` consistent with the rewritten path, and avoids leaking `-C` into the actual `git` invocation. |
| Tag list-mode `--sort` / `--format` rather than dropping the list-mode requirement.                | Tag creation needs a positional; relaxing to "anything in list mode" preserves the deny on creation.                                         |
| Worktree `--detach` keeps path-prefix and structural checks but drops the path-equals-branch rule. | The branch isn't known for a detached worktree — the only constraint left is "stays inside `/workspace/worktrees/<repo>/<freeform>`".        |
| GraphQL allowed only when no `mutation` keyword appears in `-f query=`.                            | Coarse but matches the spirit of the existing REST policy (implicit GET only). Anything fancier is overkill for v1.                          |
| Bare `git fetch` / `git ls-remote` are rewritten to include `origin`.                              | Git's no-remote behavior can follow the current branch's upstream remote; rewriting preserves the intended origin-only network boundary.     |
| Detached worktree adds do not register git branch correlation aliases.                             | A detached worktree's commit-ish is not a branch, so aliasing it would misroute future branch events such as `origin/main` review worktrees. |
| `git -C` rewrites to the target realpath after rejecting raw `..` traversal.                       | This accepts harmless normalized paths such as `./` while keeping traversal attempts out of the policy surface.                              |
| `git ls-remote` uses an explicit read-only flag allowlist.                                         | Flags such as `--upload-pack` alter remote execution behavior, so only inspection flags are accepted.                                        |
| GraphQL requires exactly one `query=` raw field.                                                   | Non-query raw fields are useful for variables, but the policy needs an actual query body to validate read-only intent.                       |
