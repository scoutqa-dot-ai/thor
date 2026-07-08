# Command Policy Consolidation

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
- widening policy for `scoutqa`, `langfuse`, or `ldcli`

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
- merge:
  passthrough — any `git merge ...` shape except `--no-verify`
- revert:
  passthrough — any `git revert ...` shape

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
- local history-rewrite helpers such as `rebase`, `reset`, `cherry-pick`, `am`, and `apply`

### GH Surface

Thor supports the following `gh` workflows:

- version and help:
  `gh --version`, `gh help ...`, `gh <group> --help`, `gh <group> <subcommand> --help`
- auth read:
  `gh auth status`
- PR read:
  `gh pr view [selector|url] ...`, `gh pr diff [selector] ...`, `gh pr list ...`, `gh pr checks [selector] ...`, `gh pr status`
- issue read:
  `gh issue view <number> ...`, `gh issue list ...`
- repo read:
  `gh repo view [<owner/repo>] ...`
- search read:
  `gh search prs ...`, `gh search issues ...`
- label read:
  `gh label list ...`
- release read:
  `gh release list ...`, `gh release view <tag|latest> ...`
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
- PR review-comment reply:
  `gh api repos/{owner}/{repo}/pulls/<pull-number>/comments/<comment-id>/replies --method POST -f body=<text>`

The supported `gh api` subset is intentionally tiny and shape-based:

- REST endpoints only, never `graphql`
- implicit GET reads allow output flags only: `--jq`, `--template`, `--silent`, `--include`, `--paginate`
- append-only POST is allowed only for current-repo PR review-comment replies: `repos/{owner}/{repo}/pulls/<numeric-pr>/comments/<numeric-comment-id>/replies --method POST -f body=<non-empty text>`
- blocked outside that explicit POST shape: `--method`, `--input`, `-H/--header`, `--preview`, `--hostname`, `-f/--raw-field`, `-F/--field`

Notable exclusions:

- `-R` / `--repo` across the GH surface
- URL and branch selectors on the write path
- `--head` on `gh pr create` whose value does not match the branch implied by cwd (`/workspace/worktrees/<repo>/<branch>`) — `--head` is allowed only as the explicit form of the cwd-derived default, which keeps cross-fork forms, protected branches, and arbitrary-branch PRs out by construction
- `gh pr checkout`
- editor/browser/body-file modes
- PR approval, merge, edit, delete-last, and similar mutating shortcuts
- mutating or side-effecting release flows such as `gh release download`, create, edit, and delete

### Skill Docs

The `using-git` and `using-gh` skill docs are maintained by hand and should stay aligned with the allowlist enforced by `policy-git.ts` and `policy-gh.ts`.

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

## Verification

```bash
pnpm exec vitest run packages/remote-cli/src/policy.test.ts
pnpm -r typecheck
```

## Decision Log

| #   | Decision                                                                                        | Rationale                                                                                                                                                            | Rejected                                                                                  |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Prefer a reduced workflow allowlist over the earlier widening and declarative-parser directions | The maintenance cost came from CLI grammar emulation, not from the number of policy entries. A smaller explicit surface is easier to audit and maintain.             | Keep widening compatibility or continue investing in a generic parser for a broad surface |
| 2   | Make the policy allowlist-only                                                                  | A positive spec is easier to audit than mixed allow/deny logic and keeps drift under control as new flags appear.                                                    | Maintain separate blocked-command or blocked-flag policy tables                           |
| 3   | Replace `git checkout` restore support with `git restore`                                       | `git restore` is purpose-built for file restore and avoids reopening branch-switching ambiguity.                                                                     | Keep heuristic path-vs-branch detection for `git checkout`                                |
| 4   | Remove implicit `git push` support                                                              | Implicit push behavior depends on local branch state and Git config, which makes policy reasoning harder.                                                            | Resolve upstreams and rewrite implicit push forms                                         |
| 5   | Keep the GH mutating path current-repo-only                                                     | Blocking `-R` / `--repo` and cross-repo write selectors keeps auth and validation simpler on the write path.                                                         | Preserve cross-repo write support for convenience                                         |
| 6   | Use exact templates for GH write commands                                                       | PR creation, comments, and reviews are where selector and flag complexity concentrate; exact templates keep that manageable.                                         | Preserve broad write parsing for URLs, branch selectors, and interactive modes            |
| 7   | Allow only a tiny implicit-GET `gh api` subset                                                  | `gh api` defaults to GET but can become POST when parameter flags are introduced; banning method and parameter controls removes that ambiguity.                      | Keep blocking `gh api` entirely or allow broader method-aware parsing                     |
| 8   | Hand-maintain `using-git` and `using-gh`                                                        | The skill docs are stable enough that direct maintenance is simpler than keeping generation and sync tooling alive.                                                  | Keep code generation as the long-term maintenance model                                   |
| 9   | Require verbatim `<branch>` ↔ worktree path matching under `/workspace/worktrees/<repo>/`       | Correlation-key routing infers branch from path, so suffix-only checks were ambiguous for slashy branch names and could silently map to the wrong branch/repo shape. | Keep basename/suffix matching, or normalize/rewrite one side before comparison            |

Reference docs for the supported commands live in the upstream `git` and `gh` manuals.
