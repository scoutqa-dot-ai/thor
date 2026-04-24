# Mined Git/GH Usage Regression Tests

Add regression coverage for common `git` and `gh` command shapes by mining real tool usage from local Claude and Codex session logs, then encoding the safe patterns into `remote-cli` policy tests.

## Motivation

The current policy tests cover representative safe commands, but they are still curated by hand. That leaves room for future tightening to accidentally block routine agent workflows that already happen in practice.

This phase makes the test surface more evidence-driven:

- inspect local Claude and Codex session logs under:
  - `/Users/son.dao/.claude/projects/`
  - `/Users/son.dao/.codex/sessions/`
- extract actual tool calls that execute `git` and `gh`
- normalize those calls into common command shapes
- add focused regression tests so common safe usage stays allowed

## Scope

**In scope:**

- mine `git` / `gh` usage from local session logs
- summarize the most common safe command shapes
- add focused `validateGitArgs` / `validateGhArgs` coverage for those shapes
- update the plan decision log for any non-obvious mining or test-selection choices

**Out of scope:**

- changing runtime policy beyond what is needed to keep established safe flows working
- adding permanent analytics or telemetry collection
- backfilling tests for uncommon or risky commands that are intentionally blocked
- committing or pushing changes

## Target Shape

After this work:

- the repo has regression tests for common real-world `git` reads/writes that should remain allowed
- the repo has regression tests for common real-world append-only `gh` usage that should remain allowed
- the mined command list is summarized well enough to explain why each new test exists

## Phases

### Phase 1 — Mine real command usage

**Changes:**

- inspect Claude/Codex session log formats
- extract `git` / `gh` tool calls from those logs
- group calls into normalized command shapes

**Exit criteria:**

- a concrete list of common safe command patterns exists
- the mining approach is documented in the decision log

### Phase 2 — Add regression coverage

**Changes:**

- add focused tests for the common safe `git` patterns
- add focused tests for the common safe `gh` patterns

**Exit criteria:**

- mined common safe usage is represented in `policy.test.ts`
- no intentionally blocked mutation paths are re-enabled by the new tests

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

| #   | Decision                                                                           | Rationale                                                                                                                                                    | Rejected                                    |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| 1   | Mine both Claude and Codex local session logs instead of only current-repo history | The goal is to preserve routine agent command shapes, and those are broader than this branch's local history.                                                | Infer common usage from existing tests only |
| 2   | Normalize mined commands into command shapes before testing                        | Raw session commands contain repo-specific branch names, SHAs, and paths; tests should capture stable policy-relevant structure, not literal one-off values. | Add tests from raw command strings verbatim |
| 3   | Add tests only for clearly safe, already-allowed flows                             | The goal is regression protection, not policy expansion. Only commands that fit the current read-only or append-only model should be locked in.              | Expand policy to match every mined command  |
