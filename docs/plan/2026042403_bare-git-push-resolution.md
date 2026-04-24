# Bare Git Push Resolution

Allow `git push` without an explicit target only when the current branch resolves to a safe upstream in the current repo, then rewrite it to an explicit push before executing real Git.

## Motivation

Thor's current push policy requires `origin` plus an explicit branch/refspec. That is easy to reason about, but it blocks a common real-world flow: `git push` from a branch that already has a safe upstream configured.

This phase keeps the explicit-write safety model while restoring that convenience. The server will resolve the upstream locally, validate it against the existing push rules, and then execute an equivalent explicit push.

## Scope

**In scope:**

- allow `git push` and `git push origin` with safe flags when they resolve to a safe upstream
- resolve upstream from the current branch in the current repo only
- rewrite accepted implicit pushes to an explicit `git push origin HEAD:refs/heads/<branch>` form before execution
- add regression tests for allowed and denied implicit push cases

**Out of scope:**

- honoring arbitrary Git push semantics from `push.default`, `remote.pushDefault`, or other global config
- allowing non-`origin` remotes
- allowing pushes to protected branches
- allowing detached-HEAD implicit pushes
- changing `gh` policy

## Target Shape

After this work:

- safe `git push` without an explicit target works when the current branch has a safe upstream on `origin`
- the server still executes an explicit push after validation, not a config-dependent implicit push
- unsafe implicit push cases remain blocked with concrete errors

## Phases

### Phase 1 — Resolve and rewrite implicit push

**Changes:**

- thread `cwd` into git validation
- add upstream resolution for bare/missing-target push commands
- rewrite accepted implicit pushes to an explicit safe refspec before execution

**Exit criteria:**

- `git push` with a safe upstream validates successfully
- the executed args are explicit and stay inside existing push constraints

### Phase 2 — Lock in regression coverage

**Changes:**

- add tests for safe implicit push resolution
- add tests for blocked detached/protected/missing-upstream cases

**Exit criteria:**

- the intended implicit-push shapes are covered directly
- unsafe neighboring cases still fail

### Phase 3 — Verify

**Changes:**

- run the focused policy test file
- run workspace typecheck

**Exit criteria:**

- `packages/remote-cli/src/policy.test.ts` passes
- workspace typecheck passes

## Verification

```bash
pnpm exec vitest run packages/remote-cli/src/policy.test.ts
pnpm -r typecheck
```

## Decision Log

| #   | Decision                                                                              | Rationale                                                                                                           | Rejected                                                              |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Resolve implicit push only from branch upstream config, then rewrite to explicit args | Keeps the policy auditable and reuses the existing explicit push checks instead of emulating all Git push behavior. | Allow raw `git push` by trusting Git's own implicit target resolution |
| 2   | Support only `origin` upstreams for implicit push                                     | Preserves the existing remote boundary and avoids hidden cross-remote writes.                                       | Allow any upstream remote if configured locally                       |
| 3   | Block detached HEAD and missing-upstream cases                                        | There is no safe stable branch target to infer in those states.                                                     | Infer a destination from HEAD alone or from push.default              |
| 4   | Ignore global push semantics like `push.default` and `remote.pushDefault`             | They make policy depend on mutable external config and are harder to reason about defensively.                      | Reproduce full Git push behavior before validating                    |
