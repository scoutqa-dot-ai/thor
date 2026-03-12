# Plan: GitHub PR Workflow

**Date**: 2026-03-11
**Goal**: Enable agents to create PRs and participate in PR conversations, enforced by a worktree-based workflow with filesystem-level isolation.

## Context

Today, agents can read GitHub data via the hosted GitHub MCP (`/x/all` endpoint, proxy on port 3013) and run git commands via git-mcp (proxy on port 3014). However:

1. Creating a pull request requires the GitHub REST API — it cannot be done with raw `git` commands alone.
2. The agent has rw access to the repo clone, meaning it can modify the main working tree directly instead of working on branches.

Two concerns to address:

- **PR creation**: Switch the GitHub MCP upstream to the writable endpoint and allowlist PR lifecycle tools.
- **Worktree enforcement**: Mount `repos/` as read-only in the opencode container so the agent is physically forced to use git worktrees (via git-mcp) for any code changes.

## Phases

### Phase 1 — Switch upstream to writable endpoint + allowlist PR tools ✅

- Change `proxy.github.json` upstream URL from `https://api.githubcopilot.com/mcp/readonly` to `https://api.githubcopilot.com/mcp/x/all`
- Add these write tools to the `allow` array:
  - `create_pull_request` — open new PRs
  - `update_pull_request` — edit title, body, labels, draft status
  - `add_issue_comment` — post general comments on PRs/issues
  - `add_reply_to_pull_request_comment` — respond to reviewer feedback inline
  - `pull_request_review_write` — submit review comments (server-side rules block self-approve)
  - `add_comment_to_pending_review` — build multi-comment reviews before submitting
- Add these read-only Actions tools:
  - `actions_get` — get details of workflows, runs, jobs, artifacts
  - `actions_list` — list Actions workflows
  - `get_job_logs` — get workflow job logs
- Keep all existing read tools in the allowlist (they exist in the writable endpoint too)

**Exit criteria**: Proxy starts, lists 21 tools (12 existing + 9 new). Agent can call `create_pull_request` and receive a valid response.

### Phase 2 — Worktree enforcement via read-only mount

Currently both `opencode` and `git-mcp` mount `./docker-volumes/workspace:/workspace` as rw. Change this so:

- **opencode** mounts `workspace/repos` as **read-only** — can browse code but cannot modify the clone directly
- **opencode** mounts `workspace/worktrees` as **read-write** — can edit files in worktrees created by git-mcp
- **git-mcp** keeps full rw mount of `workspace/` — can create worktrees under `workspace/worktrees/`, commit, push

Docker-compose volume changes:
```yaml
# opencode
volumes:
  - ./docker-volumes/workspace/repos:/workspace/repos:ro
  - ./docker-volumes/workspace/worktrees:/workspace/worktrees
  - ./docker-volumes/workspace/worklog:/workspace/worklog
  - ./docker-volumes/opencode:/root/.local/share/opencode

# git-mcp (unchanged — full rw)
volumes:
  - ./docker-volumes/workspace:/workspace
```

Update `build.md` agent instructions to describe the worktree workflow:
- Use git-mcp to create a worktree: `git worktree add /workspace/worktrees/<branch> -b <branch>`
- Edit files in `/workspace/worktrees/<branch>/`
- Commit and push via git-mcp
- Create PR via GitHub MCP `create_pull_request`
- Clean up worktree after PR is merged

**Exit criteria**: opencode cannot write to `/workspace/repos/`. Agent creates a worktree, makes changes, pushes, and opens a PR end-to-end.

### Phase 3 — Verify end-to-end workflow

- Use a manual trigger to confirm:
  - Agent creates a worktree via git-mcp
  - Agent edits files in the worktree
  - Agent commits and pushes via git-mcp
  - Agent creates a PR via GitHub MCP `create_pull_request`
  - Read tools still work as before

**Exit criteria**: Full PR workflow works end-to-end. Existing read operations unaffected.

## Decision Log

| #   | Decision                                                  | Rationale                                                                                                          |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Use writable hosted MCP instead of custom tool in git-mcp | Zero code to maintain; tool already exists upstream; proxy allowlist provides the safety boundary                   |
| 2   | Use `/x/all` endpoint instead of `/readonly`              | Exposes all upstream toolsets; proxy allowlist is the sole safety boundary. Avoids policy drift when tools move between toolsets. |
| 3   | Keep the allowlist conservative                           | Add PR lifecycle tools (create, update, comment, review); other write tools added later as needed                  |
| 4   | Allow `pull_request_review_write`                         | GitHub branch protection rules block self-approval server-side; safe to expose                                     |
| 5   | Enforce worktrees via read-only mount, not agent instructions | Filesystem-level enforcement is stronger than relying on agent discipline; git-mcp keeps rw for worktree ops   |
| 6   | Split workspace mounts for opencode                       | `repos:ro` prevents writes, `worktrees:rw` allows editing worktree files, `worklog:rw` preserves logging          |

## Risk Assessment

| Risk                                     | Mitigation                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/x/all` exposes all upstream tools      | Proxy allowlist enforces which tools are callable; only PR lifecycle + Actions read tools added    |
| Allowlist drift lets unwanted tools leak | Proxy `validatePolicy()` detects drift at startup; production mode errors on unknown allowlist     |
| Agent creates unwanted PRs               | GitHub branch protection rules + repo rulesets provide server-side guardrails; PR review is manual |
| Agent modifies main clone directly       | `repos/` mounted read-only in opencode; writes are physically impossible                          |
| Worktree leaks disk space                | Agent instructions include cleanup step; can add periodic cleanup cron later                       |

## Disallowed GitHub MCP Tools (Write)

Write tools available on the writable endpoint but excluded from the allowlist. The readonly tools already disallowed in the [GitHub MCP plan](2026031102_github-mcp.md) remain disallowed.

| Tool                              | Reason                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `merge_pull_request`              | Too dangerous without approval gates; merges should be manual                           |
| `update_pull_request_branch`      | Not needed yet; agent can use git-mcp to rebase/merge                                   |
| `create_branch`                   | Agent uses git-mcp for branch creation (credential isolation)                           |
| `create_or_update_file`           | Agent uses git-mcp for file changes (full git workflow preferred)                       |
| `push_files`                      | Agent uses git-mcp for pushing (credential isolation)                                   |
| `delete_file`                     | Agent uses git-mcp for file operations                                                  |
| `create_repository`               | No use case; agent operates on existing repos                                           |
| `fork_repository`                 | No use case; agent operates on existing repos                                           |
| `issue_write`                     | Not needed yet; consider for future issue triage workflows                              |
| `sub_issue_write`                 | Not needed yet                                                                          |
| `label_write`                     | Not needed; labels managed by humans                                                    |
| `actions_run_trigger`             | Too dangerous; could trigger arbitrary CI workflows                                     |
| `star_repository`                 | No use case                                                                             |
| `unstar_repository`               | No use case                                                                             |
| `create_gist`                     | No use case; could leak code to public gists                                            |
| `update_gist`                     | No use case                                                                             |
| `projects_write`                  | Not needed; project boards managed by humans                                            |
| `dismiss_notification`            | No use case; agent doesn't manage notifications                                         |
| `assign_copilot_to_issue`         | No use case; agent is Thor, not GitHub Copilot                                          |
| `request_copilot_review`          | No use case                                                                             |
| `create_pull_request_with_copilot`| No use case; agent creates PRs directly                                                 |

## Out of Scope

- Approval gates / human-in-the-loop for PR creation (future)
- PR merge tools (too dangerous without approval gates)
- GitHub App / installation token auth
- Periodic worktree cleanup automation
