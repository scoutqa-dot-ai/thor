# Bucket 2 Command Allowlist Expansion

Allow the selected safe/common command shapes from the mined blocked-command bucket, while keeping `gh api` blocked and preserving the repo/worktree boundary model.

## Motivation

The mined session logs surfaced a second class of regressions: commands that are common, read-only, or help/introspection-oriented, but still blocked by the current command policy.

This phase selectively widens the policy for those commands so routine agent workflows remain available without reopening the larger escape hatches that should stay closed.

## Scope

**In scope:**

- allow the selected safe/common Bucket 2 `git` commands:
  - restore-only `git checkout`
  - read-only `git config --get*`
  - `git check-ignore`
  - `git symbolic-ref`
  - `git check-ref-format`
  - `git --version`
  - read-only `git --no-pager ...`
- allow the selected safe/common Bucket 2 `gh` commands:
  - `gh search <resource>`
  - `gh run watch`
  - `gh auth status`
  - bare `gh` help and `gh help ...`
  - `gh --version`
  - `--help` on other `gh` command groups/subcommands
- add regression tests for the new allowlist surface

**Out of scope:**

- allowing `gh api`
- allowing `git -C`
- allowing branch/worktree switching via `git checkout` / `git switch`
- widening push rules
- allowing write-oriented `git config`
- allowing help or execution for commands that remain intentionally blocked when that help path would undermine the policy boundary for `gh api`

## Target Shape

After this work:

- routine mined read/help commands in the selected Bucket 2 set are allowed
- `gh api` remains blocked, including `gh api --help`
- branch switching, repo retargeting, and cross-repo mutation surfaces stay blocked
- `policy.test.ts` captures the newly-allowed shapes and the retained exclusions

## Phases

### Phase 1 — Expand the validator surface

**Changes:**

- add the selected Bucket 2 `git` allowlist entries and validation helpers
- add the selected Bucket 2 `gh` allowlist entries and help/version handling
- keep `gh api` explicitly blocked

**Exit criteria:**

- selected Bucket 2 commands validate successfully
- `gh api` still fails validation

### Phase 2 — Lock in regression coverage

**Changes:**

- add tests for the new `git` allowlist shapes
- add tests for the new `gh` allowlist shapes
- add explicit tests proving blocked surfaces stay blocked

**Exit criteria:**

- every newly-allowed command class has direct test coverage
- blocked neighbor commands still fail

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

| #   | Decision                                                                                          | Rationale                                                                                                                           | Rejected                                                                  |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Keep `gh api --help` blocked even while widening general `gh` help                                | The user explicitly excluded it, and allowing it would blur the line on a command group that remains fully disallowed.              | Allow all `gh` help uniformly                                             |
| 2   | Allow only restore-style `git checkout` shapes, not branch-switching forms                        | The mined regressions include file restore flows, but the worktree-boundary rule still depends on blocking branch changes in-place. | Re-allow `git checkout` broadly                                           |
| 3   | Limit `git config` to read-only `--get*` lookups                                                  | The mined safe usage is repo introspection, while writes would alter user/global config and expand the trust boundary.              | Allow all `git config` reads and writes                                   |
| 4   | Treat help/version commands as safe introspection except for the explicitly blocked `gh api` case | These commands are non-mutating and common in agent workflows, but the `gh api` boundary is important enough to keep explicit.      | Keep all help/version commands blocked because they are uncommon in tests |
