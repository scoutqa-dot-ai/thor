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
  `gh api repos/{owner}/{repo}/pulls/comments/<comment-id>/replies --method POST -f body=<text>`

The supported `gh api` subset is intentionally tiny and shape-based:

- REST endpoints only, never `graphql`
- implicit GET reads allow output flags only: `--jq`, `--template`, `--silent`, `--include`, `--paginate`
- append-only POST is allowed only for current-repo PR review-comment replies: `repos/{owner}/{repo}/pulls/comments/<numeric-id>/replies --method POST -f body=<non-empty text>`
- blocked outside that explicit POST shape: `--method`, `--input`, `-H/--header`, `--preview`, `--hostname`, `-f/--raw-field`, `-F/--field`

Notable exclusions:

- `-R` / `--repo` across the GH surface
- URL and branch selectors on the write path
- `--head` on `gh pr create` whose value does not match the branch implied by cwd (`/workspace/worktrees/<repo>/<branch>`) — `--head` is allowed only as the explicit form of the cwd-derived default, which keeps cross-fork forms, protected branches, and arbitrary-branch PRs out by construction
- `gh pr checkout`
- editor/browser/body-file modes
- PR approval, merge, edit, delete-last, and similar mutating shortcuts
- mutating or side-effecting release flows such as `gh release download`, create, edit, and delete

### 2026-04-29 update — Review-comment replies

Decision Log:

| Date       | Decision                                                                                                                                       | Rationale                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-29 | Model `gh api` as an explicit REST-shape registry and add only `POST repos/{owner}/{repo}/pulls/comments/<id>/replies -f body=<text>` for now. | This enables true inline replies to PR review comments while preserving append-only, current-repo-only behavior through GitHub's `{owner}/{repo}` placeholder and avoiding broad `gh api` mutation support. |

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
- Surface expansion — fill gaps surfaced by a policy audit against common git/gh usage. The current surface was too narrow for routine inspection and for creation-time PR metadata. The goals:
  - Phase A — `git` read-only expansion: passthrough `blame`, `reflog`, `grep`, `for-each-ref`, `cat-file`, `name-rev`, `describe`; bounded `ls-remote origin [<ref>...]`; list-only `tag` and `stash`; extend `rev-parse` with `HEAD`, `--short[=N] HEAD`, `--show-toplevel`, `--git-dir`, `--is-inside-work-tree`; extend `merge-base` with `--is-ancestor <l> <r>` and `--fork-point <ref> [<commit>]`.
  - Phase B — `git worktree` lifecycle: `worktree list [--porcelain]`, `worktree remove <path>` with path constrained under `/workspace/worktrees/`, and `worktree prune [--dry-run]`.
  - Phase C — `git fetch` flag allowlist: add `--prune`, `--tags`, `--no-tags`, `--all`, `--depth=<n>` to the scanner, keeping `origin` as the only remote.
  - Phase D — `git restore --staged`: accept `--staged` alone or combined with `--source` before the `--` separator.
  - Phase E — `gh` read-only expansion: add passthrough `release list`, `release view`, `search prs`, `search issues`, `search repos`, `search code`, `label list`, `cache list`.
  - Phase F — `gh api --paginate`: allow the paginate boolean in the existing scanner.
  - Phase G — Creation-time write additions: `gh issue create --title X --body Y [--label ...]`, `gh pr create` extras (`--fill`, `--label`, `--assignee`, `--reviewer`), body-file `-F <path>` for `gh pr create` and `gh pr comment`, `gh run rerun <id>`, `gh run download <id>`, `gh workflow run <name>` with `--ref <branch>` and repeatable `-f key=value`, `git commit -F <path>`, and `git commit -m subject -m body` for multi-paragraph messages.
  - Out of scope: `git push origin <branch>` shorthand. Supporting it would either revive implicit-push resolution (Decision #4) or require the wrapper to rewrite the refspec server-side, which violates Decision #4 in letter even if not in spirit. The long form `origin HEAD:refs/heads/<branch>` is what `using-git` documents and is typed only once per branch by tooling, so the ergonomic cost is near zero. Status: Completed.
- Drop dead arg-based org resolution: `validateGhArgs` already denies `-R` / `--repo` via `hasRepoOverride` before the gh wrapper invokes the auth helper, so the second-pass scan in `resolveOrgFromArgs` was unreachable. Collapse `resolveOrg` to a one-liner that defers to the cwd's git remote and delete the eight-test `resolveOrgFromArgs` describe block. Status: Completed.
- Drop `isPathUnderCwd` and the cwd-restriction on `-F` / `--body-file` / `--dir`: the agent already has full read/write access to whatever path `git` / `gh` would open via opencode tools, so restricting the path string moves no security boundary — it just adds friction. Remove the helper from `policy-paths.ts`, drop the cwd parameter from the four affected validators (`validateCommit`, `validateGhPrCreateArgs`, `validateGhCommentArgs`, `validateGhRunDownloadArgs`), and trim the corresponding cwd-escape test cases (keeping the conflict / mutex / duplicate checks). Status: Completed.
- Drop GitHub Enterprise support: Thor only targets `github.com` cloud, so `addGitHostsFromApiUrl`, `deriveAllowedGitHosts`, and the `api_url` / `GITHUB_API_URL` plumbing in `github-app-auth.ts` and the workspace config schema were ~50 lines of unused machinery. Hardcode `https://api.github.com` and remove the host-allowlist derivation, the `api_url` field, and the corresponding env vars from docker-compose, `.env.example`, README, and the example workspace config. Status: Completed.
- GH investigation reads: allow `gh search prs ...`, `gh search issues ...`, `gh label list ...`, `gh release list ...`, and `gh release view <tag|latest> ...` on the broad read path, while keeping `gh release download` and write flows blocked. Also document that `gh pr view` already allows URL selectors on the read path. Status: Completed.
- Passthrough `git rev-parse`: every ref `rev-parse` could resolve is already exposed via `show-ref`, `for-each-ref`, `cat-file`, `name-rev`, and `log` (all passthrough), and `rev-parse` is read-only by design (no writes, no fetches, no hooks). The eight-exact-form gate was asymmetric friction without a corresponding security boundary. Drop `validateRevParse`, route `rev-parse` to the same passthrough switch case as the other read commands, drop the `### git rev-parse` section from `using-git`, and add `git rev-parse` to its passthrough list. Unlocks idiomatic shapes like `rev-parse origin/main`, `rev-parse --verify --quiet`, `rev-parse --abbrev-ref @{upstream}`, `rev-parse HEAD~3`, and `rev-parse HEAD:<path>`. Status: Completed.
- Passthrough `gh workflow run` inputs: the prior policy denied `-F` entirely and rejected `-f key=@file`, in the name of "no local-file exfil via dispatch payload." But the same exfil channel exists via committing a workflow that reads files and posts them, then dispatching it via `gh workflow run --ref <branch>` (both allowed). Two-step instead of one-step, same outcome. Trade the theatre for typed-input ergonomics: accept `-f`, `-F`, `--raw-field`, `--field` as repeatable workflow inputs with no key/value validation. Selector and duplicate-`--ref` guards stay. Note that the parallel `=@` rejection on `gh api -f`/`-F` is left in place since `gh api` talks straight to the GitHub API rather than dispatching a workflow we control. Status: Completed.
- Passthrough `git merge`: agents need to integrate upstream changes into a feature branch (the workflow `git pull` would do), but `pull` itself stays denied because it depends on local upstream config — same Decision #4 reasoning as implicit push. Add `merge` to the allowlist as a near-passthrough that only blocks `--no-verify` (mirrors the `git commit` deny, since merge runs `pre-merge-commit` and `commit-msg` hooks). Other merge flags (`--squash`, `-s`/`-X` strategies, `--allow-unrelated-histories`, `--signoff`, octopus, `--abort`/`--continue`/`--quit`) carry no boundary that isn't already enforced by the push protected-branch rule. Replaces `git pull` with the redirect `git fetch origin <branch>` + `git merge origin/<branch>`. Status: Completed.
- Passthrough `git revert`: reverting creates new inverse commits rather than rewriting existing history, so it fits Thor's append-only git posture. Allow the subcommand with all arguments and rely on the existing protected-branch and explicit-push rules for externally-visible safety. Status: Completed.
- Multi-segment worktree paths: support branch names with `/` in both policy and sandbox root resolution. For `git worktree add`, validate that the branch string and the exact path segment under `/workspace/worktrees/<repo>/` match verbatim (not just basename/suffix), and reject malformed branch/path values (empty, leading/trailing slash, `//`, `..`, NUL, absolute). In sandbox execution, validate `git rev-parse --show-toplevel` as `/workspace/worktrees/<repo>/<branch-with-slashes>` and preserve subpath handling for nested cwd values. Status: Completed.
- Actionable deny messages: keep the existing string-returning policy API, but enrich Git/GH denials with stable plaintext `Reason`, `Try instead`, and `Details` lines. Cover common recovery paths for blocked branch switching, restore, pull, push, worktree, PR checkout/diff, repo override, PR creation, comments, reviews, workflow dispatch, releases, and `gh api`. Status: Completed.

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
| 16  | Broaden the GH read-only surface for investigation, but keep release side effects blocked       | `search`, `label list`, and selected `release` reads improve investigation workflows with much lower risk than widening write selectors or allowing local-file side effects like `release download`.      | Keep the narrower GH read-only surface, or allow broader release operations including download  |
| 17  | Require verbatim `<branch>` ↔ worktree path matching under `/workspace/worktrees/<repo>/`       | Correlation-key routing infers branch from path, so suffix-only checks were ambiguous for slashy branch names and could silently map to the wrong branch/repo shape.                                      | Keep basename/suffix matching, or normalize/rewrite one side before comparison                  |
| 18  | Enrich deny stderr as structured plaintext instead of changing the validator API                | OpenCode consumes stderr today; adding reason and recovery hints in the same string improves behavior without touching `/exec/git`, `/exec/gh`, `validateGitArgs`, `resolveGitArgs`, or `validateGhArgs`. | Return JSON/object errors or add a new policy result type                                       |

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
- GH `search prs`: https://cli.github.com/manual/gh_search_prs
- GH `search issues`: https://cli.github.com/manual/gh_search_issues
- GH `label list`: https://cli.github.com/manual/gh_label_list
- GH `release list`: https://cli.github.com/manual/gh_release_list
- GH `release view`: https://cli.github.com/manual/gh_release_view
