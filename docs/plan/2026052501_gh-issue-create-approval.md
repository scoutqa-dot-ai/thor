# Human approval for `gh issue create`

Put `gh issue create` behind the existing Slack-button human approval path while preserving Thor's GitHub disclaimer, assignee attribution, created-issue alias registration, and fail-closed behavior when no Slack thread is available.

## Goal

`gh issue create` should no longer perform an immediate GitHub write from `/exec/gh`. A validated issue-create request should create a pending approval in the originating Slack thread, return an `approval_required` payload to the agent, and execute the exact approved command only after a human clicks Approve.

## Scope

**In scope**

- Gate only `gh issue create`; keep `gh pr create`, comments, reviews, workflow dispatches, and the allowed `gh api` reply shape on their current policy paths.
- Reuse the current approval storage, Slack button, approval status, and gateway re-entry mechanics as much as possible.
- Preserve current `/exec/gh` behavior around:
  - command-shape validation through `validateGhArgs`
  - Thor traceability footer injection
  - trigger-user GitHub assignee attribution
  - created issue `github:issue:` alias registration after successful create
  - current-repo/write-scope restrictions and non-interactive body requirements
- Fail closed before creating an issue when Thor cannot map the request to a session, trigger anchor, or Slack thread, or when the approval notification cannot be posted.
- Update agent-facing `using-gh` docs to state that issue creation requires human approval.

**Out of scope**

- Gating any other `gh` write surface.
- Adding approval support to `git`, `sandbox`, or other `/exec/*` endpoints.
- Changing Slack approval button UX beyond adding a clear `gh issue create` presentation.
- Introducing an admin/web approval surface; Slack remains the approval path for this work.
- Changing GitHub issue template validation or product-repo intake rules.

## Current architecture notes

- `packages/remote-cli/src/index.ts` owns `/exec/gh`. Today it validates policy, injects the Thor footer via `withGhDisclaimer`, appends trigger-user assignees through `withGhAttribution`, executes `gh`, and then registers a created-issue correlation alias from stdout.
- `packages/remote-cli/src/mcp-handler.ts` owns the current approval lifecycle for MCP tools: build pending actions, resolve Slack thread targets, post Slack approval messages, expose `approval status`, and resolve button decisions through `/exec/mcp resolve`.
- `packages/remote-cli/src/approval-store.ts` is already generic enough to persist pending/approved/rejected actions, but the resolution code assumes every approval maps to an MCP upstream from `PROXY_NAMES`.
- `packages/common/src/approval-events.ts` and `packages/common/src/approval-presentation.ts` define the typed approval event payloads and Slack presentation, currently for Jira/LaunchDarkly-style MCP tools only.
- `packages/remote-cli/src/policy-gh.ts` currently allows `issue create` as a valid immediate write shape. The policy shape should remain valid, but execution should become approval-required.
- `docker/opencode/config/skills/using-gh/SKILL.md` currently documents issue creation as an immediate append-only write.
- Gateway Slack button handling already calls remote-cli's approval resolver and re-enters the agent with approved/rejected outcome context; this should continue to work if `gh` approvals are visible to the same resolver.

## Proposed architecture

Keep one approval resolver, but generalize it from “MCP-only approvals” to “remote-cli approvals with MCP and local executors”.

```mermaid
flowchart LR
    Agent -->|POST /exec/gh issue create| RC[index.ts]
    RC -->|validate + build exact effective args| Approval[approval coordinator/store]
    Approval -->|Slack message + buttons| Slack
    Slack -->|button action| Gateway
    Gateway -->|POST /exec/mcp resolve| Resolver[mcp-handler approval resolver]
    Resolver -->|ghIssueCreate executor| GH[gh CLI]
    GH -->|issue URL stdout| Alias[created-issue alias registration]
```

### Approval model

- Add a typed approval tool, tentatively `ghIssueCreate`, in `packages/common/src/approval-events.ts` with args such as:
  - `cwd: string`
  - `args: string[]` for the exact effective `gh issue create` arguments to execute after approval
  - optional display fields (`title`, `bodyPreview`, `labels`, `assignees`) if useful for Slack presentation without re-parsing in common
- Store the command after footer injection and assignee attribution so the approved side effect is deterministic and matches the reviewed request.
- Mark `ghIssueCreate` as not using `approvalToolRequiresDisclaimer`; the `/exec/gh` route prepares the final command before the approval is persisted.
- Use the existing `ApprovalStore` status model. Use an approval store namespace such as `gh` or `github-cli`; include it in approval lookup/status/resolution alongside MCP proxy stores.

### Request path

For `/exec/gh`:

1. Validate `cwd` and `validateGhArgs(args, cwd)` exactly as today.
2. Detect `args[0] === "issue" && args[1] === "create"` before execution.
3. Build `ids = thorIds(req)` and fail if `sessionId` is missing.
4. Run `withGhDisclaimer` and `withGhAttribution` before creating the pending action; if either cannot produce safe args, return the same 400-style command result as today.
5. Resolve the session anchor and Slack thread using the same common helpers as MCP approvals. If unavailable, return a non-zero command result and do not execute `gh`.
6. Persist a pending `ghIssueCreate` action and post the Slack approval message. If Slack posting fails, reject/mark the pending action as system-failed as MCP does today and return failure.
7. Return an `approval_required` JSON payload on stdout with `command: approval status <id>` and `exitCode: 0`, matching MCP approval behavior.
8. Keep non-issue-create `gh` commands on the existing immediate execution path.

### Approval resolution path

- Extend the approval resolver in `mcp-handler.ts` (or extract a small approval coordinator module used by it) so `findApproval`, `approval status`, and `resolve` consider both MCP proxy stores and the `gh` store.
- Add an injected/local executor for `ghIssueCreate` that:
  - loads the stored `cwd` and exact `args`
  - executes `execCommand("gh", args, cwd)`
  - on success, parses stdout with the existing issue URL logic and calls the created-issue alias registration using the stored origin session id
  - returns/stores the `ExecResult` through `approveLoaded`
  - on failure, preserves the existing behavior of returning the failing result and leaving the pending action available with error details for inspection/retry semantics
- Keep gateway's button endpoint and `resolveApproval` transport unchanged unless tests reveal it assumes only MCP upstream names.

## Phases

### Phase 1 — Generalize approval payloads and presentation

**Changes**

- Add `ghIssueCreate` to `APPROVAL_TOOL_NAMES`, `ApprovalRequiredEventPayloadSchema`, and related common types.
- Define a schema for the stored/requested GitHub issue-create approval args.
- Add a Slack presentation that highlights the command, cwd/repo context, title, labels, assignees, and a safe body preview/truncated JSON fallback.
- Ensure generic formatting still works if fields are absent.

**Exit criteria**

- Common typecheck passes.
- Approval presentation tests or existing approval tests cover the new tool sufficiently to prove Slack blocks render and button values stay compatible.

### Phase 2 — Add a non-MCP approval executor path in remote-cli

**Changes**

- Add an approval store namespace for GitHub CLI approvals.
- Extend `mcp-handler.ts` approval lookup/status/resolve to include the GitHub CLI store.
- Add a local approval executor registry/dependency for `ghIssueCreate` instead of forcing it through an MCP upstream connection.
- Reuse the existing in-flight resolution guard, approve/reject idempotency handling, `ApprovalStore.approveLoaded`, and `writeToolCallLogFn` decisions.

**Exit criteria**

- `mcp-handler.test.ts` proves `approval status`, reject, approve, approved-result replay, and missing/unknown action handling still work for both MCP and `ghIssueCreate` actions.
- Gateway approval-action tests continue to pass without changes to the Slack button value contract, or are updated only for a new optional upstream/store name.

### Phase 3 — Gate `/exec/gh issue create`

**Changes**

- In `packages/remote-cli/src/index.ts`, branch validated `gh issue create` requests into approval creation before `execCommand`.
- Build and store exact effective args after `withGhDisclaimer` and `withGhAttribution`.
- Fail closed for missing session id, missing trigger anchor, unsupported/missing Slack thread, and Slack post failures.
- Move or export the issue URL parsing/alias registration helpers so the approval executor can register the alias after the approved execution succeeds.
- Preserve immediate execution for all other allowed `gh` commands.

**Exit criteria**

- `gh-disclaimer.test.ts` proves `gh issue create` no longer invokes `execCommand` before approval, returns `approval_required`, stores args with footer/assignee, and registers the created issue alias only after approval succeeds.
- Existing disclaimer/assignee behavior for `gh pr create`, `gh pr comment`, `gh issue comment`, `gh pr review`, and allowed `gh api` reply remains covered.
- Fail-closed cases return non-zero results and do not execute `gh`.

### Phase 4 — Policy and agent-facing docs

**Changes**

- Keep `validateGhArgs` accepting the existing non-interactive `issue create` shape, but update naming/comments/tests to distinguish “policy-valid” from “immediate execution”.
- Update denial/help text only if needed so agents understand valid issue-create shapes still require approval.
- Update `docker/opencode/config/skills/using-gh/SKILL.md` to say `gh issue create` is supported only through human approval and that successful approved creates still receive the footer and alias binding.

**Exit criteria**

- `policy.test.ts` expectations are clear that issue-create shapes are permitted for approval, while unsupported shapes remain denied.
- Agent-facing docs no longer describe issue creation as an immediate append-only write.

### Phase 5 — Integration verification and cleanup

**Changes**

- Run targeted remote-cli/common/gateway tests.
- Inspect logs and command results for clear agent-facing failure messages.
- Remove duplicated parsing/presentation code introduced during earlier phases.

**Exit criteria**

- Targeted tests pass locally: `gh-disclaimer.test.ts`, `mcp-handler.test.ts`, `policy.test.ts`, common approval presentation/events tests if added, and gateway approval-action coverage if touched.
- Manual or test evidence shows the full path: request approval -> Slack button approve -> `gh issue create` executes once -> stdout URL is stored in the approved result -> created issue alias is registered.
- Rejection path produces no GitHub issue and re-enters the agent with the existing rejected-action guidance.

## File-level impact

| Path                                                        | Expected impact                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/approval-events.ts`                    | Add `ghIssueCreate` tool/schema/type and keep disclaimer injection limited to existing tools.                                       |
| `packages/common/src/approval-presentation.ts`              | Add Slack presentation for GitHub issue creation and tests/fallback behavior.                                                       |
| `packages/remote-cli/src/approval-store.ts`                 | Likely no structural change; schema already supports arbitrary tool names once common payload validation accepts the new tool.      |
| `packages/remote-cli/src/mcp-handler.ts`                    | Generalize approval lookup/status/resolve to include a GitHub CLI approval store and local executor.                                |
| `packages/remote-cli/src/index.ts`                          | Divert validated `gh issue create` into approval creation; preserve disclaimer, assignee, and alias helpers for approved execution. |
| `packages/remote-cli/src/policy-gh.ts`                      | Keep shape validation; update comments/guidance if needed to avoid implying immediate writes.                                       |
| `packages/remote-cli/src/gh-disclaimer.test.ts`             | Add/adjust `/exec/gh issue create` approval, fail-closed, final-args, and alias-after-approval coverage.                            |
| `packages/remote-cli/src/mcp-handler.test.ts`               | Add non-MCP approval store/executor resolution coverage.                                                                            |
| `packages/remote-cli/src/policy.test.ts`                    | Clarify issue-create valid-for-approval policy expectations and keep unsupported-shape denials.                                     |
| `packages/gateway/src/approval.test.ts` / `service.test.ts` | Touch only if upstream/store routing assumptions need updates for `gh` approvals.                                                   |
| `docker/opencode/config/skills/using-gh/SKILL.md`           | Document human approval requirement for `gh issue create`.                                                                          |

## Decision log

| #   | Decision                                                                                                          | Rationale                                                                                                                                                                                                                                                                                     | Rejected                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Reuse the existing Slack approval resolver and store instead of adding a second `/exec/gh`-specific approval API  | Keeps one human button path, one status command shape, and one gateway re-entry contract                                                                                                                                                                                                      | Building a parallel GitHub-only approval service or requiring a new gateway endpoint                                                                            |
| 2   | Add a local `ghIssueCreate` approval executor beside MCP tool executors                                           | `gh issue create` is a remote-cli command, not an MCP upstream tool; a local executor preserves current GitHub CLI behavior without fake upstreams                                                                                                                                            | Wrapping `gh` as an MCP server; moving all `/exec/gh` handling into `mcp-handler.ts`                                                                            |
| 3   | Store exact effective args after disclaimer injection and assignee attribution                                    | Approval should execute the reviewed, deterministic command and not depend on later config/user changes                                                                                                                                                                                       | Storing raw user args and mutating them only after approval                                                                                                     |
| 4   | Keep `validateGhArgs` allowing issue-create shapes                                                                | Policy validation still defines the safe command shape; approval gating belongs to execution routing                                                                                                                                                                                          | Returning policy denials for valid issue-create requests and teaching agents a separate command                                                                 |
| 5   | Fail closed when no Slack thread can be resolved                                                                  | The requested safety boundary is human approval; without a human approval surface, issue creation must not happen                                                                                                                                                                             | Falling back to immediate execution or a pending action with no notification                                                                                    |
| 6   | Extract the generic approval pipeline into `approval-service.ts`, keeping MCP and `gh` only as injected executors | Resolves the "MCP-centric naming leakage" risk below: the engine owns store registry, pending creation, Slack posting, in-flight dedup, resolution, status/list, and audit logging, while executors own only the side effect. `gh` is no longer a special branch inside an MCP-named resolver | Leaving the shared lifecycle inside `mcp-handler.ts` with a `lookup.upstreamName === GH_APPROVAL_STORE` branch; building a second parallel approval coordinator |

## Phase 6 — Extract the approval coordinator (cleanup)

**Changes**

- Add `packages/remote-cli/src/approval-service.ts` exporting `createApprovalService` plus the executor boundary: `ApprovalExecutor` (one `resolve(action)` method returning an `ApprovalPlan`), `ApprovalSystemRejection` (fail-closed at click time), `ApprovalOutcome`, and the shared `ApprovalExecResult`/`ok`/`fail`/`stringify` vocabulary.
- The engine is a **registry**: `register(store, executor)` records a store namespace and its executor; only registered stores are consulted by `findApproval`/`status`/`list` and resolved on approval. It owns store persistence (`getStore`), `createPending` (anchor/Slack resolution, Slack post, persistence, `tool_call_pending_approval` log, `approval_required` payload), in-flight resolution dedup, `resolve`, `executeApproval` (the `approval status`/`list` command surface), `storedApprovedResult`, and the approved/rejected audit logging. It defaults its own `approvalsDir`/`writeToolCallLogFn` and takes no `storeNames`/`resolveExecutor` deps.
- Add `packages/remote-cli/src/cli-approval.ts`: a generic framework for gating any CLI command behind the approval pipeline. A `CliApprovalDefinition` declares the store namespace, tool id, display name, request-arg builder, resolve-time command recovery, and an optional post-success hook; `createCliApprovalExecutor`, `requestCliApproval`, and `registerCliApprovals` are CLI-agnostic. `gh issue create` is the first registered definition (`CLI_APPROVAL_DEFINITIONS`), carrying its display parsing, schema validation, and created-issue alias hook. Adding another approvable CLI later is a new definition entry — no new executor or resolver wiring.
- `mcp-handler.ts` no longer contains any CLI-specific behavior, owns no approval lifecycle, and constructs no engine. `createMcpService(deps, approvalService)` takes the shared engine and **registers each MCP proxy store** (all `PROXY_NAMES` share one in-module `mcpExecutor` that re-resolves profile + reconnects upstream at click time, throwing `ApprovalSystemRejection` to fail closed). It uses the engine only via `createPending` (approve-gated tool calls) and `resolve` (`/exec/mcp resolve`). The `McpService` surface is back to MCP-only: `getHealth`, `warmUpstreams`, `closeAll`, `executeMcp`. `ProxyInstance` no longer carries an `approvalStore`.
- `index.ts` (`createRemoteCliApp`) is the composition root: it builds the `ApprovalService`, passes it to `createMcpService` (which registers MCP stores), then `registerCliApprovals(approvalService, execCommand)` registers CLI stores. `/exec/approval` calls `approvalService.executeApproval(args)`; `/exec/gh issue create` calls `requestCliApproval(approvalService, getCliApprovalDefinition("gh"), …)`. Neither approval surface routes through the MCP service.
- Approval audit logs now use the `approval` logger namespace instead of `mcp`; event names (`tool_call_pending_approval`, `tool_call_approved`, `tool_call_rejected`, `tool_call_rejected_profile_ambiguous`) and the `/exec/*` JSON contracts are unchanged.

**Exit criteria**

- The MCP service surface carries no approval methods; the engine is owned by the composition root and both MCP and CLI register their stores into it.
- Full `@thor/remote-cli` suite green (262 tests, incl. the new `cli-approval.test.ts`), plus remote-cli typecheck.

## Implementation risks

- **MCP-centric naming leakage:** `/exec/mcp resolve` and `mcp-handler.ts` are named for MCP but will resolve a GitHub CLI approval. Keep the public contract stable for this change. _(Addressed in Phase 6: the shared lifecycle now lives in `approval-service.ts`; `mcp-handler.ts` keeps only the MCP executor. The `/exec/mcp resolve` transport name is left unchanged to preserve the gateway contract.)_
- **Double execution:** ensure the initial `/exec/gh` request never reaches `execCommand` for `issue create`, and approval replay returns the stored approved result rather than creating a second issue.
- **Reviewed args drift:** store exact effective args, including server-added footer/assignee, to avoid drift between request and approval.
- **Alias timing:** created-issue alias registration must happen after the approved `gh` command succeeds, not when approval is requested.
- **Slack payload size:** long issue bodies should be previewed/truncated in presentation while the full effective body remains in the stored action.
- **Retry semantics:** existing approval resolution leaves failed approved side effects pending with error details. Preserve or explicitly document this behavior so humans/agents do not unknowingly replay a successful create after a transport ambiguity.

## Test plan

- `pnpm --filter @thor/common test -- approval` or the closest common approval event/presentation tests after adding coverage.
- `pnpm --filter @thor/remote-cli test -- gh-disclaimer mcp-handler policy` or equivalent targeted Vitest invocation.
- Gateway approval-action tests if the button route/store name changes.
- Final remote-cli/common typecheck and the relevant workspace test command before PR.
