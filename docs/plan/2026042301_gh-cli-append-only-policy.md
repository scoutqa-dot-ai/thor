# GH CLI Append-Only Policy

Tighten Thor's `gh` command policy so GitHub write actions stay append-only for auditing. Thor may create PRs, comments, and non-approval reviews, but it must not edit/delete prior review artifacts, approve a PR, or merge on behalf of a human.

## Motivation

`remote-cli` is the server-side policy boundary for `gh`. The current policy only allow-lists `group subcommand`, which leaves gaps:

- `gh pr comment` / `gh issue comment` can still edit or delete the last comment via flags
- `gh pr review` can approve a PR
- `gh pr edit` and `gh pr ready` mutate existing PR state but are currently allowed
- some workflow/run commands trigger side effects that do not match the append-only auditing direction

This phase tightens the policy so Thor's GitHub behavior aligns with an auditable "create new evidence, do not rewrite old evidence" model.

## Scope

**In scope:**

- tighten `packages/remote-cli/src/policy.ts` for `gh` commands
- add per-command flag validation for PR/issue comments and PR reviews
- remove non-append-only GH mutations from the allow-list
- update focused tests in `packages/remote-cli/src/policy.test.ts`
- align top-level docs with the new GH policy boundary

**Out of scope:**

- changing approval-flow mechanics
- changing git policy beyond references needed for consistency
- changing auth/wrapper behavior
- pushing, merging, or automating human approval steps

## Target Shape

After this work:

- Thor can still use `gh pr create`, `gh pr comment`, `gh issue comment`, and `gh pr review` for append-only actions
- `gh pr comment` and `gh issue comment` reject edit/delete flags
- `gh pr review` rejects `--approve`
- `gh pr edit`, `gh pr ready`, and `gh pr merge` are blocked
- workflow/run commands that cause non-audit side effects are blocked unless they are clearly read-only
- tests document the allowed append-only surface and the blocked mutation surface

## Phases

### Phase 1 — Define the append-only GH policy

**Changes:**

- document the append-only invariant for GitHub write actions
- record decisions for borderline commands and flags

**Exit criteria:**

- plan clearly distinguishes allowed append-only actions from blocked state-changing actions
- decision log captures non-obvious command/flag choices

### Phase 2 — Enforce the GH policy in `remote-cli`

**Changes:**

- remove `pr edit` and `pr ready` from the GH allow-list
- add command-specific validation for:
  - `gh pr comment`
  - `gh issue comment`
  - `gh pr review`
- keep `gh pr merge` blocked
- restrict other GH commands that do not align with append-only auditing

**Exit criteria:**

- append-only comment/review commands validate successfully
- edit/delete/approve/merge/state-change commands are denied with clear errors

### Phase 3 — Tests and docs alignment

**Changes:**

- add focused `validateGhArgs` coverage for append-only and blocked cases
- update README / architecture wording to describe the tightened GH policy boundary

**Exit criteria:**

- focused GH policy tests pass
- docs match the actual enforcement behavior

## Verification

Run the smallest relevant checks first:

```bash
pnpm exec vitest run packages/remote-cli/src/policy.test.ts -t "validateGhArgs"
pnpm exec vitest run packages/remote-cli/src/policy.test.ts
pnpm -r typecheck
```

## Decision Log

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| 1 | Keep `gh pr create` allowed | Creating a new PR is append-only and remains useful for Thor's branch/PR workflow. | Block all GH writes |
| 2 | Block `gh pr edit` and `gh pr ready` | They mutate existing PR metadata/state rather than appending a new audit artifact. | Keep because they are common PR operations |
| 3 | Allow comment commands only with explicit `--body` text (no body files) | Avoids `--body-file`/`-F` file-read exfil paths while keeping append-only comment creation non-interactive. | Allow `--body-file`; allow all `gh ... comment` flags |
| 4 | Block `gh pr review --approve` | Approval is a human gate, not an agent action. | Allow approve because it is auditable |
| 5 | Allow `gh pr review --comment` and `--request-changes` | Both create a new review artifact without rewriting prior history; only approval is reserved for humans. | Comment-only reviews; allow all review modes |
| 6 | Block `gh run cancel`, `gh run rerun`, and `gh workflow run` | They trigger operational side effects that do not fit the requested append-only audit direction. | Keep because they are not edit/delete commands |
| 7 | Narrow `gh pr create` to explicit non-interactive flags | Reduces broad unvalidated passthrough by allowing only title/body (+ optional base/head/repo/draft) and blocking `--web`, `--editor`, and `--body-file`. | Keep broad `gh pr create` surface |
| 8 | Tighten `git push` to append-only feature-branch flows | Block `--force-with-lease`, require explicit `origin` + branch/refspec, and deny pushes to protected branches (`main`/`master`) so merge direction stays human-controlled. | Keep permissive `git push origin`; allow force-with-lease for convenience |
| 9 | Bind GH write actions to cwd/worktree repo only | For `gh pr create`, `gh pr comment`, `gh issue comment`, and `gh pr review`, block `--repo`/`-R` so writes cannot target another repository from the same token/session. | Keep cross-repo write override for convenience |
