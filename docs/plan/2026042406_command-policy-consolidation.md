# Command Policy Consolidation

This document is the single branch record for the `git` / `gh` command-policy work.

## Goal

Keep `remote-cli` command policy easy to audit by modeling a small set of explicit Thor workflows instead of trying to emulate broad `git` and `gh` CLI grammar.

The final model is:

1. allowlist-only
2. workflow-oriented instead of grammar-oriented
3. current-repo-only on the mutating path
4. explicit about ambiguous operations such as checkout, push, and GH write selectors
5. paired with hand-maintained `using-git` / `using-gh` skill docs that describe the same allowed surface

## Scope

**In scope:**

- reduce the supported `git` / `gh` surface to the workflows Thor actually needs
- make `git` and `gh` denials default to skill-loading hints
- keep hand-maintained skill docs aligned with runtime policy
- keep policy coverage explicit in `packages/remote-cli/src/policy.test.ts`
- preserve the exported policy API: `validateGitArgs`, `resolveGitArgs`, and `validateGhArgs`

**Out of scope:**

- full `git` or `gh` CLI compatibility
- cross-repo write support
- branch switching in the current worktree
- implicit or config-dependent push behavior
- widening policy for `scoutqa`, `langfuse`, `ldcli`, or `metabase`

## Final Design

### Policy Model

- Match only approved command shapes; deny everything else by default.
- Keep parsing minimal and localized to the commands that truly need it.
- Reuse only a small shared arg-scanning helper where structured validators need the same token-walking mechanics.
- Use the hand-maintained skills as the user-facing description of the allowed surface.

Every denied command returns:

- `git`: `"<command>" is not allowed. Load skill using-git for the supported command patterns.`
- `gh`: `"<command>" is not allowed. Load skill using-gh for the supported command patterns.`

### Git Surface

Thor supports the following `git` workflows:

- version:
  `git --version`
- read-only:
  `git status ...`, `git log ...`, `git diff ...`, `git show ...`, `git shortlog ...`, `git ls-files ...`, `git show-ref ...`
- merge base:
  `git merge-base <left> <right>`
- branch read:
  `git branch --show-current`, `git branch -a`, `git branch --all`, `git branch --list [<pattern>]`, `git branch (-a|--all) --list [<pattern>]`
- exact ref introspection:
  `git rev-parse --abbrev-ref HEAD`
- remote read:
  `git remote`, `git remote -v`, `git remote --verbose`, `git remote show origin`, `git remote get-url origin`
- fetch:
  `git fetch origin [<ref>...]`
- restore:
  `git restore [--source <tree>] -- <path...>`
- stage:
  `git add -A`, `git add <path...>`
- commit:
  `git commit -m <message>`
- worktree:
  `git worktree add` with one `-b <branch>`, a `<path>` under `/workspace/worktrees/`, and an optional `<start-point>` in any order Git accepts
- push:
  `git push origin HEAD:refs/heads/<branch>` with optional `--dry-run` and either `-u` or `--set-upstream` in any order Git accepts

Notable exclusions:

- `git checkout`
- `git switch`
- implicit `git push`
- `git pull`
- `git config`
- `git symbolic-ref`
- `git check-ignore`
- `git check-ref-format`
- `git --no-pager`
- local history-rewrite helpers such as `rebase`, `reset`, `cherry-pick`, `revert`, `am`, and `apply`

### GH Surface

Thor supports the following `gh` workflows:

- version and help:
  `gh --version`, `gh help ...`, `gh <group> --help`, `gh <group> <subcommand> --help`
- auth read:
  `gh auth status`
- PR read:
  `gh pr view [selector] ...`, `gh pr diff [selector] ...`, `gh pr list ...`, `gh pr checks [selector] ...`, `gh pr status`
- issue read:
  `gh issue view <number> ...`, `gh issue list ...`
- repo read:
  `gh repo view [<owner/repo>] ...`
- run read:
  `gh run list ...`, `gh run view <id> ...`, `gh run watch <id> ...`
- workflow read:
  `gh workflow list ...`, `gh workflow view <workflow> ...`
- PR create:
  `gh pr create --title <t> --body <b> [--base <branch>] [--draft]`
- PR comment:
  `gh pr comment <number> --body <text>`
- issue comment:
  `gh issue comment <number> --body <text>`
- PR review:
  `gh pr review [<number>] (--comment | --request-changes) --body <text>`
- REST read gap:
  `gh api <endpoint> [output flags]` with the restricted subset below

The supported `gh api` subset is intentionally tiny:

- REST endpoints only, never `graphql`
- implicit GET only
- allowed output flags only: `--jq`, `--template`, `--silent`, `--include`
- blocked: `--method`, `--input`, `-H/--header`, `--preview`, `--hostname`, `-f/--raw-field`, `-F/--field`

Notable exclusions:

- `-R` / `--repo` across the GH surface
- URL and branch selectors on the write path
- `--head` on `gh pr create`
- `gh pr checkout`
- editor/browser/body-file modes
- PR approval, merge, edit, delete-last, and similar mutating shortcuts
- less-central read tuples such as `gh search ...`, `gh label list`, and `gh release ...`

### Skill Docs

`docker/opencode/config/skills/using-git/SKILL.md` and `docker/opencode/config/skills/using-gh/SKILL.md` are maintained by hand. They should stay aligned with the allowlist enforced by `policy-git.ts` and `policy-gh.ts`, but they are no longer generated artifacts.

## Phases

### Phase 1 — Ratify the reduced surface

**Changes:**

- settle on a smaller workflow-oriented policy
- drop the broader widening and parser-generalization directions
- define the final `git` and `gh` command shapes before code changes

**Exit criteria:**

- the target surface is explicit
- the superseded directions are no longer the source of truth

**Status:** Completed

### Phase 2 — Reduce the Git surface

**Changes:**

- replace checkout-restore support with `git restore`
- remove implicit push resolution
- shrink validation to the retained Git workflows
- make Git denials skill-oriented

**Exit criteria:**

- `validateGitArgs` and `resolveGitArgs` enforce only the retained Git surface
- Git validation no longer depends on branch/path ambiguity or upstream discovery

**Status:** Completed

### Phase 3 — Reduce the GH surface

**Changes:**

- keep read-only GH commands broad by tuple
- make GH write commands exact templates
- remove cross-repo write support and selector-heavy write parsing
- reintroduce only a narrow implicit-GET `gh api` subset
- update skill docs directly and align tests

**Exit criteria:**

- GH write validation is template-based
- `gh api` cannot send a body, change method, switch host, or use GraphQL
- skill docs and tests match the final policy surface

**Status:** Completed

### Phase 4 — Verify

**Changes:**

- run focused policy tests
- run workspace typecheck

**Exit criteria:**

- `packages/remote-cli/src/policy.test.ts` passes
- workspace typecheck passes

**Status:** Completed

## Follow-up

- Safe argument ordering: replace slot-based validation for `git worktree add` with option-aware parsing, allow the approved `git push` flags to appear in any position, and add regression tests for reordered valid forms while keeping invalid forms denied. Status: Completed.
- Bounded arg scanner: create a shared helper for recognized flag aliases and positional collection, refactor the structured `git` / `gh` validators onto it, and keep per-command semantic checks in the validators themselves. Status: Completed.
- Stakeholder read-only additions: allow `git shortlog ...`, `git ls-files ...`, and `git show-ref ...` as read-only passthrough commands, add constrained support for `git branch --list [<pattern>]` and `git branch (-a|--all) --list [<pattern>]`, and allow the exact branch-introspection form `git rev-parse --abbrev-ref HEAD`. Status: Completed.

## Verification

```bash
pnpm exec vitest run packages/remote-cli/src/policy.test.ts
pnpm -r typecheck
```

## Decision Log

| #   | Decision                                                                                        | Rationale                                                                                                                                                                                                 | Rejected                                                                                        |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Prefer a reduced workflow allowlist over the earlier widening and declarative-parser directions | The maintenance cost came from CLI grammar emulation, not from the number of policy entries. A smaller explicit surface is easier to audit and maintain.                                                  | Keep widening compatibility or continue investing in a generic parser for a broad surface       |
| 2   | Make the policy allowlist-only                                                                  | A positive spec is easier to audit than mixed allow/deny logic and keeps drift under control as new flags appear.                                                                                         | Maintain separate blocked-command or blocked-flag policy tables                                 |
| 3   | Replace `git checkout` restore support with `git restore`                                       | `git restore` is purpose-built for file restore and avoids reopening branch-switching ambiguity.                                                                                                          | Keep heuristic path-vs-branch detection for `git checkout`                                      |
| 4   | Remove implicit `git push` support                                                              | Implicit push behavior depends on local branch state and Git config, which makes policy reasoning harder.                                                                                                 | Resolve upstreams and rewrite implicit push forms                                               |
| 5   | Keep the GH mutating path current-repo-only                                                     | Blocking `-R` / `--repo` and cross-repo write selectors keeps auth and validation simpler on the write path.                                                                                              | Preserve cross-repo write support for convenience                                               |
| 6   | Use exact templates for GH write commands                                                       | PR creation, comments, and reviews are where selector and flag complexity concentrate; exact templates keep that manageable.                                                                              | Preserve broad write parsing for URLs, branch selectors, and interactive modes                  |
| 7   | Allow only a tiny implicit-GET `gh api` subset                                                  | `gh api` defaults to GET but can become POST when parameter flags are introduced; banning method and parameter controls removes that ambiguity.                                                           | Keep blocking `gh api` entirely or allow broader method-aware parsing                           |
| 8   | Hand-maintain `using-git` and `using-gh`                                                        | The skill docs are stable enough that direct maintenance is simpler than keeping generation and sync tooling alive.                                                                                       | Keep code generation as the long-term maintenance model                                         |
| 9   | Keep GH read-only commands broad by tuple and validate exact grammar only where needed          | Read-only tuple pass-through preserves common inspection flows without rebuilding the full GH CLI grammar.                                                                                                | Fully parse every GH read-only selector and flag combination                                    |
| 10  | Parse supported git commands by recognized flags and positionals                                | The policy should gate workflows, not fail because Git accepted the same workflow in another order.                                                                                                       | Keep exact tuple matching for commands with safe reordering                                     |
| 11  | Keep the ordering fix limited to `git worktree add` and `git push`                              | Those were the concrete user-facing drift points in this branch and did not justify a broad parser rewrite by themselves.                                                                                 | Broad parser rewrites across every structured command                                           |
| 12  | Extract only token-scanning concerns into a shared helper                                       | The duplication was in walking flags and values, not in the policy decisions themselves.                                                                                                                  | A generic reusable command-policy engine                                                        |
| 13  | Keep command semantics in the per-subcommand validators                                         | Each supported workflow still has materially different safety rules and should stay easy to audit.                                                                                                        | Move allow/deny semantics into a shared abstraction                                             |
| 14  | Refactor only the structured validators that already scan tokens                                | That is where reuse improves clarity without changing the policy shape or forcing passthrough tuple checks into a parser abstraction.                                                                     | Rewrite passthrough tuple checks to fit the shared helper                                       |
| 15  | Broaden the Git read-only surface with narrowly bounded ownership and ref-inspection helpers    | `shortlog`, `ls-files`, and `show-ref` are read-only and useful enough to allow broadly, while `branch --list` and `rev-parse --abbrev-ref HEAD` stay constrained to avoid reopening generic parser work. | Keep the narrower surface and force agents into workarounds, or allow broad `rev-parse` grammar |

## References

- Git `restore`: https://git-scm.com/docs/git-restore
- Git `switch`: https://git-scm.com/docs/git-switch
- Git `push`: https://git-scm.com/docs/git-push
- Git `branch`: https://git-scm.com/docs/git-branch
- Git `rev-parse`: https://git-scm.com/docs/git-rev-parse
- Git `remote`: https://git-scm.com/docs/git-remote
- Git `ls-files`: https://git-scm.com/docs/git-ls-files
- Git `show-ref`: https://git-scm.com/docs/git-show-ref
- Git `shortlog`: https://git-scm.com/docs/git-shortlog
- Git `worktree`: https://git-scm.com/docs/git-worktree
- GH `pr create`: https://cli.github.com/manual/gh_pr_create
- GH `pr review`: https://cli.github.com/manual/gh_pr_review
- GH `pr comment`: https://cli.github.com/manual/gh_pr_comment
- GH `issue comment`: https://cli.github.com/manual/gh_issue_comment
- GH `api`: https://cli.github.com/manual/gh_api
- GH `pr view`: https://cli.github.com/manual/gh_pr_view
- GH `pr checks`: https://cli.github.com/manual/gh_pr_checks
- GH `issue view`: https://cli.github.com/manual/gh_issue_view
- GH `repo view`: https://cli.github.com/manual/gh_repo_view
