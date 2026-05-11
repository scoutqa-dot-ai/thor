# Plan: Approval Flow for Dangerous MCP Tools

**Date**: 2026-03-12
**Branch**: `feat/approval`
**Status**: Draft

---

## Problem

The proxy currently has a binary model: tools are either **exposed** (always callable) or **hidden**. There's no middle ground for tools that should be available but require human approval before execution — e.g., `create_pull_request`, `update_pull_request`, Jira status changes.

Per `docs/feat/mvp.md`, the proxy should support three policy decisions: **allow**, **block**, and **approval required**.

## Design

### Policy Config

Add an `approve` array to the proxy config alongside `allow`. Tools in `approve` are exposed to the agent (listed in `ListTools`) but their execution is gated on human approval.

```jsonc
// proxy.github.json
{
  "upstream": { "url": "...", "headers": { ... } },
  "allow": ["get_file_contents", "search_code", "list_issues", ...],
  "approve": ["create_pull_request", "update_pull_request"]
}
```

- Tools in `allow` → forwarded immediately (current behavior)
- Tools in `approve` → held for approval
- Tools in neither → hidden from agent

### Approval Lifecycle

```
Agent calls tool → Proxy checks policy
  ├─ allow → forward to upstream, return result
  ├─ approve → store request, return pending action ID
  │    ├─ Post notification to originating context (Slack thread / PR comment / fallback channel)
  │    ├─ Human clicks button → Gateway receives interactivity payload
  │    ├─ Gateway calls Proxy resolution endpoint
  │    ├─ If approved → Proxy executes against upstream, stores result
  │    └─ If rejected → Proxy stores rejection
  └─ hidden → "Unknown tool" error
```

### Agent Experience

When a tool requires approval, the proxy returns immediately with a structured response:

```json
{
  "content": [
    {
      "type": "text",
      "text": "⏳ Approval required for `create_pull_request`. Action ID: abc-123. A Slack notification has been sent. Use `check_approval_status` with this ID to check the outcome."
    }
  ],
  "isError": false
}
```

The agent is **not blocked** — it can continue other work and poll later.

### New Tool: `check_approval_status`

The proxy injects a synthetic tool `check_approval_status` into the exposed tools list. The agent calls it with an action ID and gets back:

- `pending` — still waiting
- `approved` — includes the original tool's result
- `rejected` — includes the reviewer's reason (if any)
- `expired` — TTL exceeded (default: 1 hour)

### Approval Store

Filesystem-based in `data/approvals/`, segmented by date for easy archival. One JSON file per action containing both request and resolution state:

```
data/approvals/
  2026-03-12/
    {actionId}.json   # single file: request + status + result (if resolved)
  2026-03-13/
    {actionId}.json
```

Each file contains the full action lifecycle — created as `pending`, updated in-place on resolution. No in-memory index; reads go straight to disk (approval checks are infrequent, not a hot path).

### Notification — Separated from Proxy

The proxy does **not** send notifications. It has no knowledge of Slack threads, PRs, or correlation keys — and it can't, because the MCP connection chain is `Runner → OpenCode → MCP client → Proxy`. OpenCode manages its own MCP sessions from static config; the runner cannot inject per-run headers.

Instead, the **runner** handles notification. It already streams tool events from OpenCode (NDJSON progress stream). When the runner sees a tool result containing a pending-approval action ID, it posts the notification to the originating context via slack-mcp's REST API (`POST /approval`), since it already has:

- The **correlation key** (knows the Slack thread or GitHub branch)
- Access to **slack-mcp** (same pattern as progress messages)

Notification message (posted to originating Slack thread):

```
🔒 Approval Required

Tool: create_pull_request
Arguments:
  title: "Fix import path for /api/execute"
  base: "main"
  head: "fix/import-path"

[✅ Approve]  [❌ Reject]
```

Buttons use Slack Block Kit interactive elements with `action_id: "approval_approve"` / `"approval_reject"` and `value: "v1:{actionId}:{proxyPort}"`. The `v1` prefix allows the gateway to reject or handle old button formats gracefully when the schema evolves.

### Gateway: Interactivity Handler

The existing `/slack/interactivity` endpoint (currently a no-op) will be wired up:

1. Parse `block_actions` payload
2. Extract `action_id` and `value` (action ID)
3. Call proxy resolution endpoint: `POST http://proxy:PORT/approval/{id}/resolve`
4. Update the original Slack message to show the outcome

### Proxy: Resolution Endpoint

New HTTP endpoint on the proxy (alongside `/mcp` and `/health`):

- `POST /approval/:id/resolve` — body: `{ "decision": "approved" | "rejected", "reviewer": "U12345" }`
- `GET /approval/:id` — returns current status (used internally, not exposed as MCP tool)

When approved, the proxy executes the stored tool call against upstream and persists the result.

### Proxy Port Flow: Stateless Button Value

Multiple proxy instances run on different ports (3010–3014), each handling a different upstream MCP server. When a Slack button is clicked to approve/reject, the gateway needs to know **which** proxy instance holds the approval action. This is solved by embedding the proxy port in the Slack button value — fully stateless, no in-memory maps or registry files.

```
1. PROXY     Includes `Proxy-Port: {PORT}` in the approval response text
             returned to the agent.

2. RUNNER    Parses the port from the tool output text via regex and includes
             `proxyPort` in the `approval_required` NDJSON progress event.

3. GATEWAY   Receives the NDJSON event, forwards `proxyPort` to slack-mcp
             via POST /approval.

4. SLACK-MCP Embeds the port in the Slack button value as `v1:{actionId}:{proxyPort}`.
             Both Approve and Reject buttons carry the same value.

5. RESOLVE   User clicks button → Slack sends interactivity payload to gateway →
             gateway parses `v1:{actionId}:{port}` from button value →
             constructs `http://{PROXY_HOST}:{port}` →
             calls POST /approval/:id/resolve on that specific proxy instance.
```

No in-memory state, no registry files, no shared volumes. The port survives gateway restarts and works with multiple gateway instances. The only requirement is that the proxy hostname is consistent (`PROXY_HOST` env var, defaults to `"proxy"`).

### Notification Channel

The runner derives the notification target from the correlation key it already holds:

- `slack:thread:{channel}:{threadTs}` → post to that Slack thread
- `git:branch:{repo}:{branch}` → post as PR comment (if PR exists for branch)
- Unknown/missing → post to a configured fallback channel

```jsonc
// runner or gateway config
{
  "fallbackApprovalChannel": "#thor-approvals",
}
```

---

## Phases

### Phase 1: Policy Engine — `approve` classification

- Extend `ProxyConfig` with `approve: string[]`
- Extend `policy.ts`: `isApprovalRequired(approve, toolName)`
- Validate `approve` list against upstream tools (same drift detection as `allow`)
- Tools in `approve` are included in `exposedTools` but flagged
- Update existing proxy configs with `approve: []` (no-op default)
- Tests for policy logic

**Exit criteria**: Policy correctly classifies tools as allow/approve/hidden. Existing behavior unchanged when `approve` is empty.

### Phase 2: Approval Store + Proxy Interceptor

- Create `ApprovalStore` class (filesystem-only, date-segmented, one file per action)
- Intercept `CallToolRequest`: if tool is approval-required, store request and return pending response
- Add `check_approval_status` synthetic tool
- Add `POST /approval/:id/resolve` and `GET /approval/:id` endpoints
- On resolve(approved): execute stored call against upstream, persist result
- On resolve(rejected): persist rejection
- TTL expiry (1 hour default)
- Worklog logging with `decision: "pending" | "approved" | "rejected" | "expired"`
- Tests for store, interceptor, resolution, and TTL

**Exit criteria**: Agent receives pending response for approval-required tools. Resolution endpoint correctly executes or rejects. `check_approval_status` returns correct state.

### Phase 3: Runner Notification + Gateway Wiring

- Runner detects pending-approval tool results in the OpenCode event stream
- Runner posts approval notification to originating context via slack-mcp `POST /approval`
- Slack-originated: post to originating Slack thread with Block Kit Approve/Reject buttons
- GitHub-originated: post as PR comment (with approve/reject links or slash commands)
- Fallback: post to configured `fallbackApprovalChannel`
- Gateway `/slack/interactivity` handles `block_actions` for approval buttons
- Gateway calls proxy resolution endpoint
- Original notification updated to show outcome
- Tests for runner detection, notification posting, and interactivity handler

**Exit criteria**: Approval notification appears in the originating context. Clicking Approve in Slack executes the tool and returns result. Clicking Reject stores rejection. Agent can poll and get the outcome.

### Phase 4: Integration + Config

- Update `proxy.github.json` to move write tools to `approve`
- Update `proxy.jira.json` if needed
- Add `approvalChannel` to configs
- Docker-compose: ensure gateway can reach proxy resolution endpoints
- End-to-end manual test

**Exit criteria**: Full flow works: agent calls `create_pull_request` → Slack notification → human approves → PR created → agent gets result via polling.

---

## Decision Log

| #   | Decision                                            | Rationale                                                                                                                                           |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Filesystem-based approval store, date-segmented     | Consistent with queue/worklog pattern, easy archival, survives restarts                                                                             |
| 2   | One JSON file per action (no separate .result file) | Reduces noise — single file updated in-place on resolution                                                                                          |
| 3   | No in-memory index                                  | Approval checks are infrequent; disk reads are fine, keeps code simple                                                                              |
| 4   | Synthetic `check_approval_status` tool              | Agent doesn't need special protocol — just calls a tool                                                                                             |
| 5   | Runner sends notifications, not proxy               | Proxy has no access to correlation key (OpenCode manages MCP sessions). Runner already has correlation key + slack-mcp access                       |
| 6   | Notification goes to originating context            | Human sees approval where they're already working (Slack thread, PR comment)                                                                        |
| 7   | Fallback channel for cron/unknown sources           | Config-level `fallbackApprovalChannel` for when no originating context exists                                                                       |
| 8   | Non-blocking return                                 | Per mvp.md spec — agent should not be blocked waiting                                                                                               |
| 9   | Gateway routes interactivity to proxy               | Gateway already owns Slack webhook handling; proxy owns policy                                                                                      |
| 10  | Remote-cli owns per-process approval resolve dedup  | Low-traffic approval clicks only need honest same-process atomicity/idempotence; gateway stays stateless and duplicate Slack updates are acceptable |
| 11  | Preserve gateway transport retries                  | Transient remote-cli/network failures can still use existing retry behavior without adding gateway-side click state                                 |
| 12  | Approved stored results must parse as ExecResult    | Unexpected result shapes indicate corrupt/invalid state and should fail fast instead of replaying approved side-effecting tools                     |

## 2026-05-07 Bug-fix Addendum: Approval Resolve Dedup Simplification

Duplicate Slack approval clicks can reach remote-cli close together. The intended fix is deliberately scoped to the practical risk: within a single remote-cli process, duplicate same-decision resolves for the same `actionId` share one in-flight resolution and later return the stored terminal result. Conflicting concurrent or terminal decisions fail clearly.

The gateway remains stateless. It continues to forward Slack actions and may retry transient transport/5xx failures using the existing retry behavior, but it does not maintain click deduplication state. Duplicate Slack message updates are acceptable for this low-traffic, non-critical workflow.

Approved terminal actions now store the buffered remote-cli `ExecResult` shape (`stdout`, `stderr`, `exitCode`) and status/status-check paths validate that shape explicitly. Invalid approved-result files are treated as corrupt state and fail fast; no backward-compatibility or replay logic is added.

## 2026-05-08 Bug-fix Addendum: Approval Payload Validation Before Persistence

Strict approval payload schemas are now validated before `approvalStore.create(...)` writes a pending action. Invalid approval arguments return a normal CLI failure and leave no approval file behind, avoiding orphaned pending approvals that were never returned to the agent or forwarded to Slack.

## Out of Scope

- Per-user approval permissions (any button clicker can approve)
- Approval delegation or escalation
- Approval for tools across multiple proxy instances in one action
- Auto-approve based on context or history
- MCP notifications (push to agent) — polling via synthetic tool is sufficient for MVP

---

## Appendix: Full Tool Inventory

Tool lists captured live from upstream MCP servers on 2026-03-12.

**Policy legend**: `allow` = forward immediately, `approve` = require human approval, `hidden` = not exposed to agent.

### GitHub Copilot MCP (81 upstream tools)

| Tool                                          | Current | Suggested   | Reason                                                 |
| --------------------------------------------- | ------- | ----------- | ------------------------------------------------------ |
| `actions_get`                                 | allow   | allow       |                                                        |
| `actions_list`                                | allow   | allow       |                                                        |
| `actions_run_trigger`                         | hidden  | **approve** | Triggers/cancels workflow runs                         |
| `add_comment_to_pending_review`               | allow   | allow       | Not visible until review submitted                     |
| `add_issue_comment`                           | allow   | allow       | Posts public comment                                   |
| `add_reply_to_pull_request_comment`           | allow   | allow       | Posts public reply                                     |
| `create_branch`                               | hidden  | hidden      | Use git-mcp                                            |
| `create_gist`                                 | hidden  | **approve** | Creates public/private gist                            |
| `create_or_update_file`                       | hidden  | hidden      | Use git-mcp                                            |
| `create_pull_request`                         | allow   | allow       | Too much friction if need approval                     |
| `create_repository`                           | hidden  | hidden      | Too dangerous                                          |
| `delete_file`                                 | hidden  | hidden      | Use git-mcp                                            |
| `dismiss_notification`                        | hidden  | hidden      | Not a bot use case                                     |
| `fork_repository`                             | hidden  | hidden      | Too dangerous                                          |
| `get_code_scanning_alert`                     | hidden  | hidden      | Not in used                                            |
| `get_commit`                                  | allow   | allow       |                                                        |
| `get_copilot_space`                           | hidden  | hidden      | Not in used                                            |
| `get_dependabot_alert`                        | hidden  | hidden      | Not in used                                            |
| `get_discussion`                              | hidden  | hidden      | Not in used                                            |
| `get_discussion_comments`                     | hidden  | hidden      | Not in used                                            |
| `get_file_contents`                           | allow   | allow       |                                                        |
| `get_gist`                                    | hidden  | **allow**   |                                                        |
| `get_global_security_advisory`                | hidden  | hidden      | Not in used                                            |
| `get_job_logs`                                | allow   | allow       |                                                        |
| `get_label`                                   | hidden  | hidden      | Not in used                                            |
| `get_latest_release`                          | hidden  | **allow**   |                                                        |
| `get_me`                                      | allow   | allow       |                                                        |
| `get_notification_details`                    | hidden  | hidden      | Not a bot use case                                     |
| `get_release_by_tag`                          | hidden  | **allow**   |                                                        |
| `get_repository_tree`                         | hidden  | hidden      | Use git-mcp                                            |
| `get_secret_scanning_alert`                   | hidden  | hidden      | Not a bot use case                                     |
| `get_tag`                                     | hidden  | **allow**   |                                                        |
| `get_team_members`                            | hidden  | hidden      | Not a bot use case                                     |
| `get_teams`                                   | hidden  | hidden      | Not a bot use case                                     |
| `github_support_docs_search`                  | hidden  | hidden      | Not in used                                            |
| `issue_read`                                  | allow   | allow       |                                                        |
| `issue_write`                                 | hidden  | hidden      | Not in used                                            |
| `label_write`                                 | hidden  | hidden      | Not in used                                            |
| `list_branches`                               | allow   | allow       |                                                        |
| `list_code_scanning_alerts`                   | hidden  | hidden      | Not in used                                            |
| `list_commits`                                | allow   | allow       |                                                        |
| `list_copilot_spaces`                         | hidden  | hidden      | Not in used                                            |
| `list_dependabot_alerts`                      | hidden  | hidden      | Not in used                                            |
| `list_discussion_categories`                  | hidden  | hidden      | Not in used                                            |
| `list_discussions`                            | hidden  | hidden      | Not in used                                            |
| `list_gists`                                  | hidden  | hidden      | Not a bot use case                                     |
| `list_global_security_advisories`             | hidden  | hidden      | Not in used                                            |
| `list_issue_types`                            | hidden  | hidden      | Not in used                                            |
| `list_issues`                                 | allow   | hidden      | Not in used                                            |
| `list_label`                                  | hidden  | hidden      | Not in used                                            |
| `list_notifications`                          | hidden  | hidden      | Not a bot use case                                     |
| `list_org_repository_security_advisories`     | hidden  | hidden      | Not in used                                            |
| `list_pull_requests`                          | allow   | allow       |                                                        |
| `list_releases`                               | hidden  | **allow**   |                                                        |
| `list_repository_security_advisories`         | hidden  | hidden      | Not in used                                            |
| `list_starred_repositories`                   | hidden  | hidden      | Not a bot use case                                     |
| `list_tags`                                   | hidden  | **allow**   |                                                        |
| `manage_notification_subscription`            | hidden  | hidden      | Not a bot use case                                     |
| `manage_repository_notification_subscription` | hidden  | hidden      | Not a bot use case                                     |
| `mark_all_notifications_read`                 | hidden  | hidden      | Not a bot use case                                     |
| `merge_pull_request`                          | hidden  | **approve** | Merges code — high impact                              |
| `projects_get`                                | hidden  | hidden      | Not in used                                            |
| `projects_list`                               | hidden  | hidden      | Not in used                                            |
| `projects_write`                              | hidden  | hidden      | Not in used                                            |
| `pull_request_read`                           | allow   | allow       |                                                        |
| `pull_request_review_write`                   | allow   | allow       | Low risk — submits review comments                     |
| `push_files`                                  | hidden  | hidden      | Use git-mcp                                            |
| `request_copilot_review`                      | hidden  | hidden      | Not a bot use case                                     |
| `search_code`                                 | allow   | hidden      | Searches all of GitHub, not scoped to repo             |
| `search_issues`                               | allow   | hidden      | Searches all of GitHub, may surface random public data |
| `search_orgs`                                 | hidden  | hidden      | Not a bot use case                                     |
| `search_pull_requests`                        | allow   | hidden      | Searches all of GitHub, may surface random public data |
| `search_repositories`                         | hidden  | hidden      | Not a bot use case                                     |
| `search_users`                                | hidden  | hidden      | Not a bot use case                                     |
| `star_repository`                             | hidden  | hidden      | Not a bot use case                                     |
| `sub_issue_write`                             | hidden  | hidden      | Not in used                                            |
| `unstar_repository`                           | hidden  | hidden      | Not a bot use case                                     |
| `update_gist`                                 | hidden  | hidden      | Not a bot use case                                     |
| `update_pull_request`                         | allow   | allow       | Too much friction if need approval                     |
| `update_pull_request_branch`                  | hidden  | allow       | Too much friction if need approval                     |

**Summary**: 24 allow, 3 approve, 54 hidden. Currently: 20 allow, 0 approve, 61 hidden.

### Atlassian MCP (42 upstream tools)

| Tool                   | Current | Suggested   | Reason                  |
| ---------------------- | ------- | ----------- | ----------------------- |
| `create_attachment`    | hidden  | hidden      | Not a bot use case      |
| `create_document`      | hidden  | hidden      | Not in used             |
| `create_issue_label`   | hidden  | hidden      | Not a bot use case      |
| `delete_attachment`    | hidden  | hidden      | Destructive             |
| `delete_comment`       | hidden  | hidden      | Destructive             |
| `delete_customer`      | hidden  | hidden      | Destructive             |
| `delete_customer_need` | hidden  | hidden      | Destructive             |
| `delete_status_update` | hidden  | hidden      | Destructive             |
| `extract_images`       | hidden  | **allow**   |                         |
| `get_attachment`       | hidden  | **allow**   |                         |
| `get_document`         | hidden  | hidden      | Not in used             |
| `get_initiative`       | hidden  | hidden      | Not in used             |
| `get_issue`            | allow   | allow       |                         |
| `get_issue_status`     | allow   | allow       |                         |
| `get_milestone`        | hidden  | hidden      | Not in used             |
| `get_project`          | allow   | allow       |                         |
| `get_status_updates`   | hidden  | **allow**   |                         |
| `get_team`             | allow   | hidden      | Not a bot use case      |
| `get_user`             | allow   | hidden      | Not a bot use case      |
| `list_comments`        | allow   | allow       |                         |
| `list_customers`       | hidden  | hidden      | Not in used             |
| `list_cycles`          | hidden  | hidden      | Not in used             |
| `list_documents`       | hidden  | hidden      | Not in used             |
| `list_initiatives`     | hidden  | hidden      | Not in used             |
| `list_issue_labels`    | hidden  | **allow**   |                         |
| `list_issue_statuses`  | allow   | allow       |                         |
| `list_issues`          | allow   | allow       |                         |
| `list_milestones`      | hidden  | hidden      | Not in used             |
| `list_project_labels`  | hidden  | **allow**   |                         |
| `list_projects`        | allow   | allow       |                         |
| `list_teams`           | allow   | hidden      | Not in used             |
| `list_users`           | allow   | hidden      | Not in used             |
| `save_comment`         | hidden  | allow       | Posts comment on issue  |
| `save_customer`        | hidden  | hidden      | Not in used             |
| `save_customer_need`   | hidden  | hidden      | Not in used             |
| `save_initiative`      | hidden  | hidden      | Not in used             |
| `save_issue`           | hidden  | allow       | Creates/updates issue   |
| `save_milestone`       | hidden  | hidden      | Not in used             |
| `save_project`         | hidden  | **approve** | Creates/updates project |
| `save_status_update`   | hidden  | allow       | Posts status update     |
| `search_documentation` | hidden  | hidden      | Not in used             |
| `update_document`      | hidden  | hidden      | Not in used             |

**Summary**: 15 allow, 1 approve, 26 hidden. Currently: 11 allow, 0 approve, 31 hidden.

### PostHog MCP (60 upstream tools)

| Tool                                 | Current | Suggested   | Reason                                |
| ------------------------------------ | ------- | ----------- | ------------------------------------- |
| `action-get`                         | hidden  | hidden      | Not in used                           |
| `actions-get-all`                    | hidden  | hidden      | Not in used                           |
| `add-insight-to-dashboard`           | hidden  | **approve** | Modifies dashboard                    |
| `cohorts-list`                       | hidden  | **allow**   |                                       |
| `cohorts-retrieve`                   | hidden  | **allow**   |                                       |
| `create-feature-flag`                | hidden  | **approve** | Feature flags affect production       |
| `dashboard-create`                   | hidden  | **approve** | Creates dashboard                     |
| `dashboard-delete`                   | hidden  | hidden      | Destructive                           |
| `dashboard-get`                      | hidden  | **allow**   |                                       |
| `dashboard-reorder-tiles`            | hidden  | **allow**   | Modifies dashboard layout             |
| `dashboard-update`                   | hidden  | **approve** | Modifies dashboard                    |
| `dashboards-get-all`                 | hidden  | **allow**   |                                       |
| `debug-mcp-ui-apps`                  | hidden  | hidden      | Internal debug tool                   |
| `delete-feature-flag`                | hidden  | hidden      | Destructive — flags affect production |
| `docs-search`                        | allow   | allow       |                                       |
| `entity-search`                      | hidden  | **allow**   |                                       |
| `error-details`                      | allow   | allow       |                                       |
| `error-tracking-issues-list`         | hidden  | **allow**   |                                       |
| `error-tracking-issues-retrieve`     | hidden  | **allow**   |                                       |
| `event-definition-update`            | hidden  | **approve** | Modifies event metadata               |
| `event-definitions-list`             | allow   | allow       |                                       |
| `experiment-create`                  | hidden  | **approve** | Creates A/B test                      |
| `experiment-delete`                  | hidden  | hidden      | Destructive                           |
| `experiment-get`                     | hidden  | **allow**   |                                       |
| `experiment-get-all`                 | hidden  | **allow**   |                                       |
| `experiment-results-get`             | hidden  | **allow**   |                                       |
| `experiment-update`                  | hidden  | **approve** | Modifies running experiment           |
| `feature-flag-get-all`               | allow   | allow       |                                       |
| `feature-flag-get-definition`        | allow   | allow       |                                       |
| `get-llm-total-costs-for-project`    | hidden  | hidden      | Not in used                           |
| `insight-create-from-query`          | hidden  | **approve** | Creates saved insight                 |
| `insight-delete`                     | hidden  | hidden      | Destructive                           |
| `insight-get`                        | hidden  | **allow**   |                                       |
| `insight-query`                      | allow   | allow       |                                       |
| `insight-update`                     | hidden  | **approve** | Modifies saved insight                |
| `insights-get-all`                   | hidden  | **allow**   |                                       |
| `list-errors`                        | allow   | allow       |                                       |
| `logs-list-attribute-values`         | allow   | allow       |                                       |
| `logs-list-attributes`               | allow   | allow       |                                       |
| `logs-query`                         | allow   | allow       |                                       |
| `organization-details-get`           | hidden  | hidden      | Not a bot use case                    |
| `organizations-get`                  | hidden  | hidden      | Not a bot use case                    |
| `projects-get`                       | allow   | hidden      | Not a bot use case                    |
| `prompt-get`                         | hidden  | hidden      | Not in used                           |
| `prompt-list`                        | hidden  | hidden      | Not in used                           |
| `properties-list`                    | allow   | allow       |                                       |
| `query-generate-hogql-from-question` | allow   | allow       |                                       |
| `query-run`                          | allow   | allow       |                                       |
| `survey-create`                      | hidden  | hidden      | Not in used                           |
| `survey-delete`                      | hidden  | hidden      | Destructive                           |
| `survey-get`                         | hidden  | hidden      | Not in used                           |
| `survey-stats`                       | hidden  | hidden      | Not in used                           |
| `survey-update`                      | hidden  | hidden      | Not in used                           |
| `surveys-get-all`                    | hidden  | hidden      | Not in used                           |
| `surveys-global-stats`               | hidden  | **allow**   |                                       |
| `switch-organization`                | hidden  | hidden      | Context-switching is dangerous        |
| `switch-project`                     | hidden  | hidden      | Context-switching is dangerous        |
| `update-feature-flag`                | hidden  | **approve** | Feature flags affect production       |
| `update-issue-status`                | hidden  | **allow**   | Too slow if approval needed           |
| `workflows-get`                      | hidden  | hidden      | Not in used                           |
| `workflows-list`                     | hidden  | hidden      | Not in used                           |

**Summary**: 28 allow, 10 approve, 22 hidden. Currently: 14 allow, 0 approve, 46 hidden.

### Slack MCP (4 upstream tools)

| Tool                  | Current | Suggested | Reason                                   |
| --------------------- | ------- | --------- | ---------------------------------------- |
| `get_channel_history` | allow   | allow     |                                          |
| `get_slack_file`      | allow   | allow     |                                          |
| `post_message`        | allow   | allow     | Core communication — agent needs to talk |
| `read_thread`         | allow   | allow     |                                          |

**Summary**: 4 allow, 0 approve, 0 hidden. No changes.

### Git MCP (1 upstream tool)

| Tool  | Current | Suggested | Reason                                                     |
| ----- | ------- | --------- | ---------------------------------------------------------- |
| `git` | allow   | allow     | Sandboxed in container; `clone`/`init` blocked server-side |

**Summary**: 1 allow, 0 approve, 0 hidden. No changes.

---

### Totals

| Server    | Upstream | allow  | approve | hidden  |
| --------- | -------- | ------ | ------- | ------- |
| GitHub    | 81       | 24     | 3       | 54      |
| Atlassian | 42       | 15     | 1       | 26      |
| PostHog   | 60       | 28     | 10      | 22      |
| Slack     | 4        | 4      | 0       | 0       |
| Git       | 1        | 1      | 0       | 0       |
| **Total** | **188**  | **72** | **14**  | **102** |
