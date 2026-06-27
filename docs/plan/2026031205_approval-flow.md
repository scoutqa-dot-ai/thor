# Plan: Approval Flow for Dangerous MCP Tools

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

| #   | Decision                                                                             | Rationale                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Filesystem-based approval store, date-segmented                                      | Consistent with queue/worklog pattern, easy archival, survives restarts                                                                                                                                                                                                                |
| 2   | One JSON file per action (no separate .result file)                                  | Reduces noise — single file updated in-place on resolution                                                                                                                                                                                                                             |
| 3   | No in-memory index                                                                   | Approval checks are infrequent; disk reads are fine, keeps code simple                                                                                                                                                                                                                 |
| 4   | Synthetic `check_approval_status` tool                                               | Agent doesn't need special protocol — just calls a tool                                                                                                                                                                                                                                |
| 5   | Runner sends notifications, not proxy                                                | Proxy has no access to correlation key (OpenCode manages MCP sessions). Runner already has correlation key + slack-mcp access                                                                                                                                                          |
| 6   | Notification goes to originating context                                             | Human sees approval where they're already working (Slack thread, PR comment)                                                                                                                                                                                                           |
| 7   | Fallback channel for cron/unknown sources                                            | Config-level `fallbackApprovalChannel` for when no originating context exists                                                                                                                                                                                                          |
| 8   | Non-blocking return                                                                  | Per mvp.md spec — agent should not be blocked waiting                                                                                                                                                                                                                                  |
| 9   | Gateway routes interactivity to proxy                                                | Gateway already owns Slack webhook handling; proxy owns policy                                                                                                                                                                                                                         |
| 10  | Remote-cli owns per-process approval resolve dedup                                   | Low-traffic approval clicks only need honest same-process atomicity/idempotence; gateway stays stateless and duplicate Slack updates are acceptable                                                                                                                                    |
| 11  | Preserve gateway transport retries                                                   | Transient remote-cli/network failures can still use existing retry behavior without adding gateway-side click state                                                                                                                                                                    |
| 12  | Approved stored results must parse as ExecResult                                     | Unexpected result shapes indicate corrupt/invalid state and should fail fast instead of replaying approved side-effecting tools                                                                                                                                                        |
| 13  | Same-process resolve dedup in remote-cli                                             | Duplicate same-decision resolves for an `actionId` share one in-flight resolution and return the stored terminal result; conflicting concurrent/terminal decisions fail clearly. Gateway stays stateless; duplicate Slack message updates are acceptable for this low-traffic workflow |
| 14  | Approved terminal actions store buffered `ExecResult` (`stdout`/`stderr`/`exitCode`) | Status/status-check paths validate that shape; invalid approved-result files fail fast with no backward-compat or replay logic                                                                                                                                                         |
| 15  | Validate approval payload before persistence                                         | Strict payload schemas validated before the store writes a pending action, so invalid arguments return a normal CLI failure and leave no orphaned pending approval behind                                                                                                              |

## Out of Scope

- Per-user approval permissions (any button clicker can approve)
- Approval delegation or escalation
- Approval for tools across multiple proxy instances in one action
- Auto-approve based on context or history
- MCP notifications (push to agent) — polling via synthetic tool is sufficient for MVP

---
