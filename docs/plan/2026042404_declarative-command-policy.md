# Declarative Command Policy

Replace the hand-rolled per-command validators in `packages/remote-cli/src/policy.ts` with declarative spec tables, and code-generate `using-git` and `using-gh` skills from those specs so opencode learns the allowed surface from a single source of truth.

## Motivation

Today's `policy.ts` is ~1080 lines, most of it imperative flag parsing duplicated across `validateGhPrCreateArgs`, `validateGhAppendOnlyCommentArgs`, `validateGhPrReviewArgs`, `validateGitConfig`, `validateGitCheckIgnore`, `validateGitSymbolicRef`, `resolveGitPushArgs`, and more. Each validator re-implements the same `startsWith("-")` / `eqIdx` / `allowedValueFlags` / `blockedFlags` walk with slightly different shapes, which means:

- Adding a new allowed command requires writing another bespoke validator.
- Error messages for the same class of mistake (unknown flag, missing value, required flag absent) are inconsistent.
- The allowed surface is not discoverable from one place — it is smeared across a dozen functions.
- opencode has no authoritative description of what it can and cannot run, so it discovers the surface by trial and error.

This plan collapses the parsing work into one generic engine driven by small command specs, and uses those same specs to emit `using-git` and `using-gh` skills. The enforcement rules and the agent-facing documentation stay in lockstep because both come from the same tables.

## Scope

**In scope:**

- introduce declarative command spec tables in `packages/remote-cli/src/policy.ts` covering every currently allowed `git` and `gh` invocation
- add a single generic parser that validates args against a spec (flag/value splitting, aliases, required flags, exactly-one-of, positional validators, unknown flag detection)
- keep the exported surface the same: `validateGitArgs`, `resolveGitArgs`, `validateGhArgs` keep their signatures and allow/deny decisions
- rewrite denial messages to `"<command>" is not allowed. Load skill using-git for the full allowed surface.` with targeted inline hints preserved for the three worktree-redirect cases
- add `scripts/gen-policy-skill.ts` that walks the spec tables and emits `docker/opencode/config/skills/using-git/SKILL.md` and `docker/opencode/config/skills/using-gh/SKILL.md`
- wire the generator into the existing skill-doc generation pipeline so drift is impossible
- keep all 118 existing `policy.test.ts` tests green without modification

**Out of scope:**

- changing the allow/deny surface for any command (behavior-preserving refactor)
- changing `scoutqa`, `langfuse`, `ldcli`, or `metabase` validators (they are small and isolated — can follow later if useful)
- changing auth wrappers, execution paths, or the `remote-cli` HTTP layer
- changing the `git push` implicit upstream resolution rules
- introducing a new skill-loading runtime in opencode (skills already propagate via frontmatter)

## Target Shape

After this work:

- `policy.ts` is ~300-400 lines: types, parser, shared validators, two spec tables, glue.
- Every allowed command is one entry in a spec table. Adding a new allowed command means adding one object, not writing a function.
- Denial messages point opencode at `using-git` / `using-gh` skills for full context, with three inline hints retained for the `git checkout` / `git switch` / `gh pr checkout` → `git worktree add` redirect because that miss pattern dominates.
- `docker/opencode/config/skills/using-git/SKILL.md` and `using-gh/SKILL.md` are generated artifacts, not hand-written.
- opencode agents are primed with both skills via frontmatter injection and have the full allowed surface available before the first command.
- All 118 existing tests pass without modification.

## Phases

### Phase 1 — Parser and spec types

**Changes:**

- define `CommandSpec`, `FlagSpec`, and `ParseContext` types
- implement a generic `validateAgainstSpec(args, spec, ctx)` function that handles:
  - canonical flag + alias resolution
  - `kind: "bool"` vs `kind: "value"` consumption
  - required flag checks
  - `requireOneOf` exactly-one-of flag groups
  - positional min/max + validator hooks
  - unknown flag detection with per-spec hint
- keep the existing hand-rolled validators untouched behind the existing exports

**Exit criteria:**

- parser is covered by direct unit tests for each spec feature
- no change to exported validator behavior yet

### Phase 2 — Port `git` specs

**Changes:**

- build git spec tables covering every subcommand in today's `ALLOWED_GIT_SUBCOMMANDS` plus the bespoke shapes (`--no-pager`, `checkout` restore, `worktree add`, `remote` read-only, `push` with refspec + protected branch + implicit upstream, `config` read-only, `check-ignore`, `symbolic-ref`)
- route `resolveGitArgs` / `validateGitArgs` through the parser
- delete the superseded hand-rolled git validators
- keep the three inline hints: `"git worktree add <path> <ref>"` for `checkout` and `switch`, and the current hint text for anything else that already has a substring assertion in tests

**Exit criteria:**

- all git-related tests in `policy.test.ts` pass unchanged
- hand-rolled git validators are removed

### Phase 3 — Port `gh` specs

**Changes:**

- build gh spec tables covering every entry in today's `ALLOWED_GH_COMMANDS` plus the append-only shapes for `pr create`, `pr comment`, `issue comment`, `pr review`
- route `validateGhArgs` through the parser
- tighten the help-request detection inside the parser path so `--help` / `-h` in flag-value positions cannot short-circuit validation
- delete the superseded hand-rolled gh validators

**Exit criteria:**

- all gh-related tests in `policy.test.ts` pass unchanged
- hand-rolled gh validators are removed
- `policy.ts` line count is in the 300-400 range

### Phase 4 — Generate `using-git` and `using-gh` skills

**Changes:**

- add `scripts/gen-policy-skill.ts` that imports the spec tables and emits `SKILL.md` files containing:
  - a short narrative describing the append-only posture
  - a table of allowed commands with positional shape, required flags, and short notes
  - the three inline redirect hints
  - common patterns (e.g. use `git worktree add` instead of `checkout`/`switch`, use `pull/<N>/head` for reviewing PRs locally)
- wire the generator into the existing skill-doc generation pipeline
- commit the generated `SKILL.md` files at `docker/opencode/config/skills/using-git/` and `docker/opencode/config/skills/using-gh/`

**Exit criteria:**

- running the generator produces deterministic output
- generated skills describe the same allow/deny surface as the specs enforce
- opencode picks up both skills via its existing frontmatter injection

### Phase 5 — Verify and clean up

**Changes:**

- run the full policy test file
- run workspace typecheck
- delete any now-unused helpers (e.g. `looksLikeCheckoutPathspec`, `CHECKOUT_PATHSPEC_SUFFIXES` if the checkout spec no longer needs them)
- sanity-check `policy.ts` line count and spec readability

**Exit criteria:**

- `packages/remote-cli/src/policy.test.ts` passes with 118/118 tests
- workspace typecheck passes
- no dead helpers remain in `policy.ts`

## Verification

```bash
pnpm exec vitest run packages/remote-cli/src/policy.test.ts
pnpm -r typecheck
pnpm exec tsx scripts/gen-policy-skill.ts --check
```

## Decision Log

| #   | Decision                                                                                             | Rationale                                                                                                                                                                                     | Rejected                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Replace per-command validators with declarative specs driven by one generic parser                   | Collapses duplicated flag-parsing logic, makes the allowed surface discoverable from one place, and cuts `policy.ts` by ~65% without changing behavior.                                       | Keep per-command validators and extract smaller shared helpers instead                                        |
| 2   | Preserve the exact allow/deny surface and all 118 tests verbatim                                     | The refactor is mechanical, not a policy change. Keeping tests unchanged is the strongest guarantee the port is behavior-preserving.                                                          | Loosen or rewrite tests to match a new message format                                                         |
| 3   | Pure allowlist denial messages with a `Load skill using-<tool>` pointer                              | Centralizes guidance in one skill doc opencode can load once per session instead of smearing hint vocabulary across 50+ inline strings.                                                       | Keep all existing inline hints; use a redirect-map for the worktree cases only                                |
| 4   | Keep three inline hints for the `git checkout` / `git switch` / `gh pr checkout` → worktree redirect | That miss pattern dominates because every agent trained on public git data defaults to `checkout`. A one-line hint in the denial closes the first round-trip before the skill is even loaded. | Move all hints into the skill and accept the first-attempt churn                                              |
| 5   | Skill names `using-git` and `using-gh`                                                               | Verb-first naming matches the existing gstack skill convention (`ship`, `review`, `investigate`). Frames the skill as "how we use git here" rather than "what is blocked."                    | `git-policy` / `gh-policy`; `git-command-line` / `gh-command-line`; bare `git` / `gh`                         |
| 6   | Code-generate both skills from the spec tables                                                       | The spec is already machine-readable. Generating the skill from it makes drift between runtime enforcement and agent-facing docs impossible.                                                  | Hand-write the skills and rely on reviewers to keep them in sync                                              |
| 7   | Tighten help-request detection so `--help` / `-h` in flag-value positions does not short-circuit     | Closes the bypass where a comment body of `"-h"` or `"--help"` silently routed mutations to the help validator. Value-taking flags consume their next token before the help scan.             | Keep a flat `args.includes("--help")` check and rely on `gh` itself to show help instead of performing writes |
| 8   | Skip declarative port of `scoutqa`, `langfuse`, `ldcli`, `metabase` in this phase                    | Those validators are small and already readable. Porting them adds churn without meaningful savings, and can be done later if useful.                                                         | Port every validator in this phase                                                                            |
| 9   | Keep `resolveGitArgs` / `validateGitArgs` / `validateGhArgs` signatures (including optional `cwd`)   | The `remote-cli` callers depend on the current shape. Preserving the signatures keeps the refactor local to `policy.ts` and its tests.                                                        | Introduce a new parser-specific entry point and migrate callers in the same phase                             |
