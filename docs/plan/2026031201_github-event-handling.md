# GitHub Event Handling in build.md

**Created**: 2026-03-12
**Status**: Done

## Goal

Update Thor's agent instructions (`docker/opencode/agents/build.md`) to handle GitHub events received via the gateway. The gateway already delivers GitHub events as prompts — this plan covers what Thor should _do_ with them.

## Design Principles

1. **Mention-driven interaction** — Thor only responds on GitHub when explicitly mentioned. No automatic code reviews, no unsolicited comments.
2. **Housekeeping is silent** — Push and PR lifecycle events update local state (repos, worktrees) but produce no GitHub output.
3. **Session continuity** — All events on the same branch share a correlation key (`git:branch:{repo}:{branch}`), so Thor accumulates context across PR opens, pushes, comments, and reviews within a single session.

## Event Routing

### Housekeeping events (no GitHub response)

| Event                                      | Action                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `push` (to main)                           | `git pull` in `/workspace/repos/<repo-name>` to keep the clone current                         |
| `pull_request` (opened / ready_for_review) | Create worktree at `/workspace/worktrees/<repo-name>/<branch>`, read the diff to build context |
| `pull_request` (synchronize)               | Pull changes in existing worktree at `/workspace/worktrees/<repo-name>/<branch>`               |
| `pull_request` (closed)                    | Remove the worktree at `/workspace/worktrees/<repo-name>/<branch>`                             |

### Interaction events (respond only when Thor is mentioned)

| Event                         | Action when mentioned | Action when not mentioned |
| ----------------------------- | --------------------- | ------------------------- |
| `issue_comment`               | Respond on the PR     | Stay silent               |
| `pull_request_review`         | Respond on the PR     | Stay silent               |
| `pull_request_review_comment` | Respond on the PR     | Stay silent               |

### How to detect "mentioned"

Check the comment or review body for "Thor" (case-insensitive). The prompt arrives as `GitHub <event> event:\n\n{payload}` — Thor reads `comment.body` or `review.body` from the payload.

## Worktree Convention

All worktrees use a single unified path: `/workspace/worktrees/<repo-name>/<branch>`:

- `<repo-name>` is the repository name without the owner (e.g. `acme-project` from `acme/acme-project`)
- `<branch>` is the branch name (e.g. `feat/dark-mode`)
- Example: `/workspace/worktrees/acme-project/feat/dark-mode`

This convention is shared between Slack-initiated and GitHub-initiated flows. When a GitHub event arrives for a branch that already has a worktree (e.g. Thor created it from a Slack session), the existing worktree is reused. Thor checks `/workspace/worklog/` for notes from prior sessions to recover context.

## Phases

### Phase 1: Plan and alignment

**Status**: Done

Write this plan, align on event routing and worktree conventions.

**Exit criteria**: Plan approved.

### Phase 2: Update build.md

**Status**: Done

**Files**: `docker/opencode/agents/build.md`

Changes:

- Update intro line to mention GitHub alongside Slack
- Add "GitHub Execution Contract" section after the Slack one
- Add "GitHub Event Routing" subsection with the housekeeping/interaction table
- Add "GitHub Response Style" subsection (concise, respond on the PR, no Slack cross-posting)
- Update "Code Changes — Worktree Workflow" to document the unified `<repo-name>/<branch>` worktree convention

**Exit criteria**:

- build.md has clear instructions for all 5 GitHub event types
- Housekeeping vs interaction distinction is explicit
- Worktree path convention is documented

## Known Limitation: Slack → GitHub Session Continuity

When Thor creates a PR from a Slack session (push branch, open PR), the resulting GitHub events arrive with a `git:branch:` correlation key — a different key from the Slack session's `slack:thread:` key. This means GitHub events create a **separate session** without the original Slack conversation context.

**Why this happens**: Slack uses `slack:thread:{channel}:{ts}` and GitHub uses `git:branch:{repo}:{branch}`. The runner maps correlation keys to OpenCode session IDs, but has no way to know that a git branch was created from a particular Slack thread.

**Why we can't fix it easily**: The runner's event stream only exposes tool name and completion state — not the input args. So the runner can't detect `git push` commands to auto-alias. The Git MCP proxy sees the full args but doesn't know the current correlation key. Passing the correlation key to the proxy (via headers) and having it call back to the runner is feasible but adds cross-service coupling.

**Future fix**: Add a `POST /sessions/alias` endpoint to the runner. The Git MCP proxy would receive the correlation key as a request header, and when it sees a `git push`, call the runner to register `git:branch:{repo}:{branch}` as an alias for the current session. This is deterministic (no LLM involvement) and keeps aliasing at the infrastructure layer.

**Mitigation in v1**: The unified worktree convention (`<repo-name>/<branch>`) means GitHub events reuse the same worktree that the Slack session created. Thor checks `/workspace/worklog/` for notes from prior sessions to recover context. This doesn't give full session continuity (the OpenCode session is still separate), but Thor can read what happened before and act on it.

**Impact for v1**: GitHub events on Thor-created PRs will start fresh OpenCode sessions. Thor can still respond to mentions on those PRs and has partial context via worklog notes — it just won't have the full Slack conversation history in the session. This is acceptable for the initial rollout.

## Out of Scope

- Gateway or runner code changes (already done)
- Automatic code review (other agents handle this)
- Slack cross-posting of GitHub activity
- Handling events from non-PR contexts (plain issues, releases)
- Session aliasing between Slack and GitHub correlation keys (see Known Limitation above)

## Decision Log

| #   | Decision                                                               | Rationale                                                                                                                                    |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mention-driven only, no automatic reviews                              | Other agents handle code review; avoid noise and let team evaluate gradually                                                                 |
| 2   | Unified worktree path `<repo-name>/<branch>` for both Slack and GitHub | Single convention avoids duplicate worktrees; worklog notes bridge the session gap when GitHub events hit an existing Slack-created worktree |
| 3   | No Slack cross-posting in v1                                           | Keep it simple; team sees reviews on the PR itself                                                                                           |
| 4   | Push to main pulls the repo clone                                      | Keeps `/workspace/repos` current so Thor always reads latest main                                                                            |
| 5   | PR opened triggers diff exploration but no GitHub response             | Builds session context so Thor is ready when mentioned, without being noisy                                                                  |
| 6   | Defer session aliasing (Slack ↔ GitHub) to future work                 | Requires cross-service plumbing (Git MCP proxy → runner callback); v1 works without it, just loses Slack context on Thor-created PRs         |
