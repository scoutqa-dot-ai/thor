# Git Policy and Auth Hardening

Strengthen `remote-cli` git/gh policy and wrapper behavior in six focused phases. These changes are valuable on their own: they reduce credential exposure, close policy gaps, and make the agent's worktree-based workflow clearer.

## Motivation

`remote-cli` is the policy boundary for agent-triggered `git` and `gh` usage. That surface should be:

- strict about dangerous flags and subcommands
- explicit about the intended worktree workflow
- efficient for common local Git operations
- conservative about where credentials appear

Today there are still a few rough edges:

- `git push` validation can be tighter
- `git config` remains broader than the agent needs
- blocked branch-changing commands do not consistently point the agent at the worktree workflow
- the `git` wrapper pays a Node startup cost even for purely local operations
- leading git flags can still inject config or helper overrides before policy sees a subcommand
- README auth wording still lags behind the hardened wrapper behavior

## Scope

**In scope:**

- Tighten `git push` validation in `packages/remote-cli/src/policy.ts`
- Remove `git config` from the supported agent command surface
- Improve deny messages for `git checkout`, `git switch`, and `gh pr checkout`
- Refactor git auth resolution so local commands avoid unnecessary Node startup
- Reject leading git flags before the subcommand in `packages/remote-cli/src/policy.ts`
- Align README auth wording with the current git/gh wrapper behavior
- Add or update focused policy/auth tests

**Out of scope:**

- Any new remote execution endpoint
- New git/gh capabilities beyond the hardening and UX changes listed here
- Changes to the higher-level session model, runner behavior, or approval flow
- Broader auth model redesign beyond the wrapper-path optimization in Phase 5

## Target Shape

After this work:

- `git push` allows only a small reviewed set of flags, rejects security-sensitive flags such as `--receive-pack`, `--exec`, `--repo`, rejects unknown flags, and validates mapped refspecs.
- `git config` is not available to the agent via `remote-cli`.
- Blocked branch-changing commands point the agent to `git worktree add <path> <ref>`.
- The `git` wrapper only invokes Node when Git actually needs credentials.
- Git commands must start with a bare allowed subcommand; leading flags are rejected.
- PAT fallback behavior remains intact when GitHub App auth is not configured or cannot resolve a target org.
- README wording matches the actual `git`/`gh` auth flow instead of describing a generic GitHub CLI setup.

## Phases

### Phase 1 — Harden `git push` flag handling

Tighten `validateGitPush` so it uses an explicit allowlist instead of permissive flag skipping.

**Changes:**

- Block security-sensitive flags such as `--receive-pack`, `--exec`, and `--repo`
- Reject unknown push flags instead of silently skipping them
- Keep only a minimal reviewed flag set, including `--no-verify`, `--dry-run`, and `--force-with-lease`
- Validate mapped refspecs so force-update refspecs, delete refspecs, and non-branch destinations are rejected

**Exit criteria:**

- `policy.test.ts` covers blocked security-sensitive flags and blocked unknown flags
- Pushing to `origin` with the reviewed safe flags still validates
- Dangerous mapped refspecs are rejected while `HEAD:refs/heads/<branch>` remains valid

### Phase 2 — Remove `git config` from the agent surface

The agent does not need `git config`. Identity is already set through environment and credentials are injected out-of-band.

**Changes:**

- Remove `config` from the allowed git subcommands
- Drop the partial read/write allowlist approach
- Keep identity/auth behavior environment-driven rather than repo-config-driven

**Exit criteria:**

- `validateGitArgs(["config", ...])` is denied for both reads and writes
- Tests document that `git config` is intentionally unsupported

### Phase 3 — Improve checkout/switch deny guidance

Keep blocking `git checkout` and `git switch`, but return a better message.

**Changes:**

- Replace the generic deny with a targeted hint that points to `git worktree add <path> <ref>`
- Keep current worktree path validation intact

**Exit criteria:**

- The policy message for blocked branch-switching commands explicitly recommends the worktree workflow
- Existing worktree validation still passes

### Phase 4 — Improve `gh pr checkout` deny guidance

Align `gh` policy messaging with the Git worktree workflow.

**Changes:**

- Detect blocked `gh pr checkout`
- Return the same worktree-oriented guidance used for blocked `git checkout` / `git switch`

**Exit criteria:**

- The policy message for `gh pr checkout` explains how to inspect a PR without leaving the assigned worktree
- `policy.test.ts` has coverage for the new message

### Phase 5 — Move auth resolution into `GIT_ASKPASS`

Reduce wrapper overhead and narrow token handling to the path where Git actually prompts for credentials.

**Changes:**

- Update `packages/remote-cli/bin/git` so local commands do not always spawn Node
- Move token resolution into `packages/remote-cli/bin/git-askpass`
- Extend `auth-helper.ts` to support askpass-style prompts and print only the token when Git requests credentials
- Keep PAT fallback intact when GitHub App auth cannot resolve an org or is not configured

**Exit criteria:**

- Local Git operations (`status`, `log`, `diff`, local branch ops) do not require auth-helper boot
- Remote-auth flows still work via `GIT_ASKPASS`
- PAT fallback remains available for non-GitHub-App cases

### Phase 6 — Close the remaining policy and docs gaps

Finish the hardening pass by blocking global git flags ahead of the subcommand and aligning the README with the final auth model.

**Changes:**

- Reject leading git flags such as `-C`, `-c`, `--exec-path`, and similar global overrides before subcommand validation runs
- Keep the test surface narrow: one focused test for representative leading-flag cases
- Update README env/auth/security wording so it matches the current `git` and `gh` wrapper behavior and PAT fallback path

**Exit criteria:**

- `validateGitArgs` rejects argument vectors whose first token is a flag
- `policy.test.ts` covers representative leading-flag rejection without expanding into low-value permutations
- README no longer describes `GITHUB_PAT` as required or as generic GitHub CLI auth
- README explains the GitHub App / PAT fallback model accurately enough for operators

## Verification

At the end of each phase:

- Run the smallest relevant test target first
- Self-check against that phase's exit criteria
- Stop for review before creating the phase commit, per `AGENTS.md`

Recommended verification commands:

```bash
pnpm exec vitest run packages/remote-cli/src/policy.test.ts
pnpm exec vitest run packages/remote-cli/src/github-app-auth.test.ts packages/remote-cli/src/exec.test.ts
pnpm -r typecheck
```

If Phase 5 adds or changes auth-helper-specific tests, include them in the second command.

## Decision Log

| #   | Decision                                                                             | Reason                                                                                                                      |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Treat this as a standalone hardening effort                                          | These changes improve the security and ergonomics of `remote-cli` even without any larger feature work.                     |
| 2   | Keep one phase per coherent behavior change                                          | Matches the repo's phase-based workflow and keeps review boundaries tight.                                                  |
| 3   | Fully block `git config` instead of maintaining a partial allowlist                  | The agent has no legitimate need for it, and the partial policy still leaves unnecessary surface area.                      |
| 4   | Keep worktrees as the standard escape hatch for blocked branch-changing commands     | It matches the repo's operating model and avoids letting the agent leave its assigned branch.                               |
| 5   | Move auth resolution into `GIT_ASKPASS` instead of resolving on every git invocation | Git only needs credentials on remote operations; local operations should stay fast and avoid unnecessary token plumbing.    |
| 6   | Preserve PAT fallback during the wrapper refactor                                    | Avoids breaking installations that still rely on legacy auth paths.                                                         |
| 7   | Reject leading git flags instead of trying to selectively sanitize them              | Global git flags can override config, helpers, and execution paths before subcommand policy has a chance to constrain them. |
| 8   | Keep README auth wording at the wrapper-behavior level                               | Operators need docs that match the actual git/gh execution paths and fallback behavior, not stale shorthand.                |

## Risks

| Risk                                                                                | Mitigation                                                                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Tightening `git push` policy may block valid existing workflows                     | Keep the allowlist small but explicit, preserve `--no-verify`, and add focused tests for the reviewed safe paths we intend to support. |
| Removing `git config` may conflict with hidden assumptions in tests or wrapper code | Audit relevant tests before landing Phase 2 and keep the commit message explicit about the behavior change.                            |
| Worktree guidance could drift between `git` and `gh` deny messages                  | Keep Phases 3 and 4 aligned on exact wording and test both surfaces.                                                                   |
| Phase 5 may regress PAT fallback or GitHub App auth resolution                      | Keep the change isolated, verify wrapper behavior carefully, and run focused auth tests before review.                                 |
| Rejecting leading git flags may block benign conveniences such as `git -C`          | The agent already passes `cwd` separately, so blocking global flags removes ambiguity without taking away required capability.         |
| README auth wording may drift again as wrappers evolve                              | Keep the docs focused on the stable behavior contract and update them in the same phase as future auth-wrapper changes.                |
