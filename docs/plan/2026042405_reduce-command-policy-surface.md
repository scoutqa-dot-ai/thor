# Reduced Command Policy Surface

Narrow the `git` / `gh` policy from "support many CLI shapes safely" to "support a small set of explicit Thor workflows". This plan is intended to replace the current direction in `2026042402_bucket2-command-allowlist.md`, `2026042403_bare-git-push-resolution.md`, and `2026042404_declarative-command-policy.md` if approved.

## Motivation

The current policy work is getting pulled toward full CLI grammar emulation:

- `git checkout` mixes branch switching and file restore in one command.
- `git push` without an explicit target depends on repo config and current branch state.
- `gh` write commands accept positional numbers, URLs, branch selectors, repo flags, and interactive/file modes.
- GitHub App auth resolution now has to reason about host-qualified repo strings and multiple selector styles.

That makes the code harder to audit than the workflow it is trying to protect.

The simpler model is:

1. support the common inspect -> edit -> commit -> push -> PR loop explicitly
2. reject ambiguous or config-dependent CLI forms
3. keep write commands current-repo-only
4. prefer exact templates for mutating commands over broad flag parsing
5. define the policy as positive allowlist entries only

## Scope

**In scope:**

- reduce the allowed `git` / `gh` surface to a small workflow-oriented subset
- express that surface as allowlist-only policy entries
- remove ambiguous, overloaded, or config-dependent command shapes
- return a skill-loading hint on every denied `git` / `gh` invocation
- rewrite `packages/remote-cli/src/policy.test.ts` to match the smaller supported surface
- code-generate `using-git` / `using-gh` skill docs from the reduced allowlist
- keep `validateGitArgs`, `resolveGitArgs`, and `validateGhArgs` as the exported API

**Out of scope:**

- preserving the current widened allowlist surface
- reproducing full `git` or `gh` CLI semantics
- cross-repo write support
- branch switching inside the current worktree
- changing `scoutqa`, `langfuse`, `ldcli`, or `metabase` policy

## Target Shape

The policy becomes allowlist-only with a short list of exact supported workflows.

The source of truth is:

- positive allowlist entries only
- no separate blocked-command table
- no separate blocked-flag table as policy data

Helpers may still exist in code for parsing or normalization, but anything not matched by the allowlist is denied by default.

### Denial Behavior

Every denied `git` / `gh` invocation returns a skill hint:

- `git`: `"<command>" is not allowed. Load skill using-git for the supported command patterns.`
- `gh`: `"<command>" is not allowed. Load skill using-gh for the supported command patterns.`

The policy may still normalize or validate allowed commands internally, but it should not maintain a separate denylist to explain blocked forms.

### Git

| Command        | Supported shape                                       | Notes                                            |
| -------------- | ----------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| version        | `git --version`                                       | Safe introspection                               |
| status         | `git status ...`                                      | Read-only; pass through                          |
| log            | `git log ...`                                         | Read-only; pass through                          |
| diff           | `git diff ...`                                        | Read-only; pass through                          |
| show           | `git show ...`                                        | Read-only; pass through                          |
| merge base     | `git merge-base <a> <b>`                              | Exact arity                                      |
| branch current | `git branch --show-current`                           | Exact shape                                      |
| branch list    | `git branch -a` or `git branch --all`                 | Exact shape                                      |
| remote list    | `git remote`, `git remote -v`, `git remote --verbose` | Exact shapes only                                |
| remote inspect | `git remote show origin`, `git remote get-url origin` | `origin` only                                    |
| fetch          | `git fetch origin [<ref>...]`                         | `origin` only; no fetch flags in Phase 1         |
| restore files  | `git restore [--source <tree>] -- <path...>`          | Replaces all `git checkout` restore support      |
| stage changes  | `git add -A` or `git add <path...>`                   | No extra flag parsing beyond `-A`                |
| commit         | `git commit -m <message>`                             | Exact non-interactive shape                      |
| add worktree   | `git worktree add -b <branch> <path> [<start-point>]` | Path must be under `/workspace/worktrees/...`    |
| push           | `git push [--dry-run] [-u                             | --set-upstream] origin HEAD:refs/heads/<branch>` | Explicit destination only; no implicit upstream resolution |

### Git Commands No Longer Matched By The Allowlist

- `git checkout`
- `git switch`
- implicit `git push`
- `git pull`
- `git config`
- `git symbolic-ref`
- `git check-ignore`
- `git check-ref-format`
- `git --no-pager`
- `git branch` mutation forms like `-m`
- local history-rewrite helpers (`rebase`, `reset`, `cherry-pick`, `revert`, `am`, `apply`)

### GH

Read-only commands stay broad by command tuple, but write commands become exact templates.

| Command          | Supported shape                                                                                                           | Notes                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| version          | `gh --version`                                                                                                            | Safe introspection                                                                                                                                                          |
| help             | `gh help ...`, `gh <group> --help`, `gh <group> <subcommand> --help`                                                      | Safe introspection; if `gh api` GET is approved, allow `gh api --help` too                                                                                                  |
| auth             | `gh auth status`                                                                                                          | Exact tuple                                                                                                                                                                 |
| PR read          | `gh pr view [selector] ...`, `gh pr diff [selector] ...`, `gh pr list ...`, `gh pr checks [selector] ...`, `gh pr status` | Read-only tuples pass through normal GH selector/flag handling, but `-R/--repo` stays unsupported                                                                           |
| issue read       | `gh issue view <number> ...`, `gh issue list ...`                                                                         | Numeric issue selector only                                                                                                                                                 |
| repo read        | `gh repo view [<owner/repo>] ...`                                                                                         | Positional repo argument is acceptable; `-R/--repo` stays unsupported                                                                                                       |
| run read         | `gh run list ...`, `gh run view <id> ...`, `gh run watch <id> ...`                                                        | Numeric run ID for `view`/`watch`; `-R/--repo` stays unsupported                                                                                                            |
| workflow read    | `gh workflow list ...`, `gh workflow view <workflow> ...`                                                                 | Workflow selector required for `view`; `-R/--repo` stays unsupported                                                                                                        |
| REST API read    | `gh api <endpoint> [flags]`                                                                                               | REST only, implicit GET only; block `graphql`, `--method`, `--input`, `-H/--header`, `--preview`, `--hostname`, `-f/--raw-field`, and `-F/--field`; allow output flags only |
| create PR        | `gh pr create --title <t> --body <b> [--base <branch>] [--draft]`                                                         | Current repo + current branch only; no `--head`, no `-R`                                                                                                                    |
| comment on PR    | `gh pr comment <number> --body <text>`                                                                                    | Numeric PR selector only                                                                                                                                                    |
| review PR        | `gh pr review [<number>] (--comment                                                                                       | --request-changes) --body <text>`                                                                                                                                           | Numeric PR selector or current-branch default only |
| comment on issue | `gh issue comment <number> --body <text>`                                                                                 | Numeric issue selector only                                                                                                                                                 |

### GH API GET Subset

If `gh api` is reintroduced, keep it as a tiny read-only sub-language:

- endpoint must be a REST path, not `graphql`
- request method must stay implicit GET; block `--method` entirely
- block `-f/--raw-field` and `-F/--field`, since the CLI docs say adding parameters automatically switches the request to POST
- block `--input` entirely
- block `-H/--header`, `--preview`, and `--hostname`
- allow only output-shaping flags such as `--jq`, `--template`, `--silent`, and `--include` in Phase 1
- current-repo placeholders like `{owner}` / `{repo}` are acceptable

This is stricter than a generic "GET-only" rule, but it is much easier to audit because the policy never needs to reason about method overrides or parameter-triggered method changes.

### GH Commands No Longer Matched By The Allowlist

- URL selectors for PRs/issues
- branch selectors for PR read/write commands
- cross-repo writes via `-R` / `--repo`
- `--head` on `gh pr create`
- `--body-file`, editor, browser, and delete/edit-last comment modes
- `gh pr checkout`
- `gh api graphql`
- `gh api --method ...`
- parameterized `gh api` usage via `-f/--raw-field`, `-F/--field`, or `--input`
- less-central read commands (`gh search ...`, `gh label list`, `gh release ...`) unless re-justified later

## Common Supported Workflows

After this change, Thor still supports the common local-dev loop:

1. inspect repo state with `git status`, `git log`, `git diff`, `gh pr view`, `gh pr checks`
2. edit files normally in the worktree
3. stage and commit with `git add` + `git commit -m`
4. push with an explicit target only
5. create a PR with explicit `--title` and `--body`
6. leave PR comments or request changes with explicit `--body`
7. use `gh api` GET for REST read gaps that are not worth adding as first-class `gh <group> <subcommand>` support

It intentionally stops supporting "convenient but ambiguous" shortcuts.

## Phases

### Phase 1 — Ratify the reduced surface

**Changes:**

- create a replacement plan for the reduced surface
- document which older command-policy plans are superseded by this direction
- freeze the exact supported command shapes before code changes start

**Exit criteria:**

- the reduced `git` / `gh` surface is explicit and reviewable
- the keep/rewrite/delete test migration is recorded

### Phase 2 — Simplify Git policy

**Changes:**

- replace `checkout` restore heuristics with `git restore`
- remove implicit push resolution and require explicit `HEAD:refs/heads/<branch>`
- drop validators for `config`, `check-ignore`, `symbolic-ref`, and other removed commands
- keep only small per-command validators where the allowlist still needs exact shape checks (`remote`, `worktree`, `push`)
- make every denied git invocation end with the `using-git` skill hint

**Exit criteria:**

- `validateGitArgs` / `resolveGitArgs` enforce only the reduced surface
- no git policy path depends on branch-vs-path ambiguity or upstream config discovery
- git policy behavior is derived from allowlist matches only, not from separate blocked-shape tables

### Phase 3 — Simplify GH policy

**Changes:**

- keep read-only tuples on a short allowlist
- restrict write commands to exact non-interactive templates
- remove selector parsing for PR/issue URLs and branch names
- remove cross-repo write support
- add the narrow `gh api` GET-only path if approved
- make every denied gh invocation end with the `using-gh` skill hint

**Exit criteria:**

- gh write validation is template-based rather than grammar-heavy
- cross-repo and ambiguous selector handling disappears from the write path
- `gh api` cannot send a body, override headers, switch host, or use GraphQL
- gh policy behavior is derived from allowlist matches only, not from separate blocked-shape tables

### Phase 4 — Update tests and code-generated skills

**Changes:**

- rewrite `policy.test.ts` around the reduced surface
- regenerate `docker/opencode/config/skills/using-git/SKILL.md`
- regenerate `docker/opencode/config/skills/using-gh/SKILL.md`

**Exit criteria:**

- tests describe the new supported workflows, not the old widened surface
- generated skills match the reduced allowlist exactly

### Phase 5 — Verify

**Changes:**

- run focused policy tests
- run workspace typecheck

**Exit criteria:**

- `packages/remote-cli/src/policy.test.ts` passes
- workspace typecheck passes

## Verification

```bash
pnpm exec vitest run packages/remote-cli/src/policy.test.ts
pnpm -r typecheck
pnpm exec tsx scripts/gen-policy-skill.ts --check
```

## Test Migration

The current `packages/remote-cli/src/policy.test.ts` should be migrated as follows.

### Keep

- all `validateCwd` tests
- `allows a representative read command`
- `blocks git clone`
- `blocks git init`
- `blocks leading git flags before the subcommand`
- `blocks checkout and switch`
- `blocks worktree add outside /workspace/worktrees/`
- `allows worktree paths with nested branch names`
- `blocks git remote add/set-url/rename/remove`
- `blocks push to non-origin remotes`
- `blocks security-sensitive push flags`
- `blocks pushes to protected target branches`
- `allows explicit HEAD refspecs and blocks dangerous mapped refspecs`
- `blocks arbitrary commands`
- `rejects empty args`
- `rejects non-array`
- `rejects leading flags that are not explicitly allowlisted`
- `blocks non-append-only pr state mutation commands`
- `blocks pr merge`
- `blocks run/workflow mutation commands`
- `blocks repo create`
- `blocks repo delete`
- `blocks auth commands`
- `blocks secret commands`
- `blocks gh pr checkout`
- `blocks interactive and file-based pr create flags`
- `requires pr create to include --title and --body`
- `blocks comment edit/delete/interactive/file flags`
- `requires comments to provide --body`
- `blocks unknown comment flags`
- `blocks pr review approve and interactive/file/unknown flags`
- `requires pr review mode and --body`
- `requires a subcommand unless the invocation is help/version`

### Rewrite

- `allows common git read-only workflows`
  - reduce to the kept read-only git subset (`status`, `log`, `diff`, `show`, `merge-base`, limited `branch`, limited `remote`, `fetch origin`)
- `allows common git write workflows that stay inside the current repo`
  - reduce to `git add`, `git commit -m`, `git restore`, `git worktree add`, explicit `git push`
- `returns explicit push args unchanged`
  - keep explicit pushes unchanged; remove implicit-push rewrite coverage
- `rejects unknown push flags but keeps known safe ones working`
  - keep only `--dry-run`, `-u`, `--set-upstream`; remove `--force-with-lease` expectations
- `allows -u / --set-upstream to set upstream tracking`
  - keep, but only alongside explicit `HEAD:refs/heads/<branch>`
- `allows common gh read-only workflows`
  - shrink to the reduced tuple set; remove `search`, `release`, `label`, and broad selector coverage
- `allows gh help and command introspection flows while keeping gh api help blocked`
  - keep help/version support, but allow `gh api --help` if `gh api` GET support is approved
- `allows append-only pr create with explicit title/body`
  - remove `--head` coverage
- `allows append-only pr/issue comments with explicit body`
  - keep numeric selectors only; drop branch and URL selector cases
- `allows append-only pr reviews for comment/request-changes`
  - keep numeric selector or current-branch default only; drop branch and URL selector cases
- `blocks gh api entirely`
  - replace with a new implicit-GET-only test block: allow plain REST GET, reject GraphQL, reject any `--method`, reject `--input`, reject custom headers/host overrides, reject `-f/--raw-field`, and reject `-F/--field`
- `blocks gh api help even though other help flows are allowed`
  - rewrite to permit `gh api --help` while continuing to reject unsafe execution forms
- all denial-path tests
  - assert the returned message includes the relevant `Load skill using-git` or `Load skill using-gh` hint

### Delete

- `allows restore-only git checkout flows without reopening branch switching`
- `allows implicit push when the current branch has a safe origin upstream`
- `blocks --force-with-lease with an inline value`
- `requires explicit remote and explicit refspec when no safe upstream can be resolved`
- `blocks implicit push when the current branch has no upstream`
- `blocks implicit push when the upstream remote is not origin`
- `blocks implicit push when the upstream branch is protected`
- `blocks implicit push from detached HEAD`
- `blocks write-oriented git config operations`
- `blocks non-read-only git --no-pager usage`
- `blocks git check-ignore modes that can read from stdin`
- `blocks git symbolic-ref mutation shapes`
- `does not route mutations to the help validator when --help/-h appears as a flag value`
  - no longer needed once write commands are exact templates
- `blocks cross-repo head selectors for pr create`
- `blocks cross-repo flags for gh write commands`
- `blocks cross-repo URL selectors and repo-style shorthands for gh write comment/review commands`
- `rejects extra positional selectors for gh write comment/review commands`
  - replaced by much narrower template tests
- `requires issue comment to include a numeric issue selector`
  - rewritten into the simpler positive/negative exact-template tests rather than retained as-is

## Decision Log

| #   | Decision                                                                                              | Rationale                                                                                                                                                                                    | Rejected                                                                             |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Prefer a smaller workflow allowlist over a generic parser                                             | The dominant maintenance cost is modeling ambiguous CLI grammar, not the number of lines in `policy.ts`.                                                                                     | Continue broad CLI support with more declarative parsing                             |
| 2   | Replace `git checkout` restore support with `git restore`                                             | `git restore` is purpose-built for file restore, while `git checkout` is overloaded with branch switching.                                                                                   | Keep heuristic branch-vs-path detection for `checkout`                               |
| 3   | Remove implicit push support                                                                          | It depends on repo config and current branch state, which makes enforcement harder to reason about.                                                                                          | Preserve convenience by resolving upstream and rewriting                             |
| 4   | Make write commands current-repo-only                                                                 | This keeps GitHub App auth and command validation simple on the mutating path.                                                                                                               | Support cross-repo writes via `-R`, URL selectors, or branch selectors               |
| 5   | Keep read-only help/version support                                                                   | It is safe, common, and cheap to validate explicitly.                                                                                                                                        | Block help/version because they are not essential to the workflow                    |
| 6   | Use exact templates for gh write commands                                                             | These commands are where most parser complexity and auth ambiguity currently live.                                                                                                           | Preserve broad gh CLI compatibility and parse many selector styles                   |
| 7   | Keep policy semantics allowlist-only                                                                  | A positive spec is easier to audit than mixed allow/deny logic, and avoids policy drift as new flags are discovered.                                                                         | Maintain blocked-command or blocked-flag tables as first-class policy data           |
| 8   | Return a skill-loading hint for every denied `git` / `gh` invocation                                  | The user-facing guidance should come from the generated skill docs, not from a growing set of bespoke denial strings.                                                                        | Maintain many custom denial messages for blocked shapes                              |
| 9   | Continue to code-generate `using-git` and `using-gh`                                                  | With allowlist-only policy, codegen is still valuable because the skill docs should stay a projection of the same allowlist source of truth.                                                 | Hand-maintain skill docs separately from the policy                                  |
| 10  | Allow only implicit-GET `gh api` reads                                                                | The CLI docs say `gh api` defaults to GET but flips to POST when parameters are added; banning `--method` and parameter flags removes that ambiguity entirely.                               | Keep blocking `gh api` entirely; allow broad `gh api` parsing with method inspection |
| 11  | Supersede the widened-surface plans if this is approved                                               | The goals conflict: the older plans optimize for broad compatibility, while this plan optimizes for auditability and maintenance.                                                            | Try to merge both directions into one implementation                                 |
| 12  | Keep GH read-only commands broad by tuple and validate the exact grammar only for writes and `gh api` | The maintenance pain is concentrated in mutating selector/flag parsing. Passing through read-only tuple arguments keeps common inspection flows working without rebuilding GH's CLI grammar. | Fully parse selector and flag grammar for every read-only GH command                 |

## References

- Git `restore`: https://git-scm.com/docs/git-restore
- Git `switch`: https://git-scm.com/docs/git-switch
- Git `push`: https://git-scm.com/docs/git-push
- Git `branch`: https://git-scm.com/docs/git-branch
- Git `remote`: https://git-scm.com/docs/git-remote
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
