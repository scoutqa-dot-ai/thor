# refactor slack-mcp — 2026-04-23-01

> **Note:** A migration step references removing `"slack"` from
> `repos.*.proxies`. The entire `repos` block has since been removed from
> `WorkspaceConfigSchema`, so that step is now moot.

**Goal**: remove `packages/slack-mcp` as a package and runtime service without
losing any current Slack capability.

The target split is:

- agent-driven Slack work uses real Slack Web API URLs from OpenCode over the
  existing mitmproxy path
- system-driven Slack work lives inside `packages/gateway`
- `packages/remote-cli` no longer exposes a `slack` MCP upstream

## Why this is now viable

The repo already contains the key prerequisite for removing `slack-mcp`:

- OpenCode now has `curl`, `slack-upload`, and proxy wiring for real Slack URLs
- `docker/opencode/config/agents/build.md` already tells the agent to use
  `curl` for simple Slack replies
- `docker/opencode/config/skills/slack/SKILL.md` already documents direct
  Slack reads, writes, file fetches, and uploads over mitmproxy

That means `slack-mcp` is no longer needed as the agent-facing Slack transport.
Its remaining value is service-side orchestration:

- progress updates
- emoji reactions
- approval cards
- approval message updates
- the old `mcp slack ...` tool surface

## Current dependency surface

From the current codebase:

- `packages/gateway` forwards `/progress`, `/reaction`, `/approval`, and
  `/update-message` calls to `slack-mcp`
- `packages/common/src/proxies.ts` still registers `slack` as an MCP upstream
  that points at `http://slack-mcp:3003/mcp`
- `packages/runner/src/tool-instructions.ts` still tells agents to use
  `mcp slack ...` when repo config enables the `slack` proxy
- `packages/remote-cli/src/mcp-handler.ts` still adds Slack thread alias
  metadata only for the MCP `post_message` path
- `docker-compose.yml` and `Dockerfile` still build and run the
  `slack-mcp` service

## Feature preservation matrix

| Capability                                            | Current owner                         | Target owner                                                        |
| ----------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| Post Slack reply / start new thread                   | `slack-mcp` MCP tool                  | OpenCode direct `curl` over existing mitmproxy auth                 |
| Read thread replies                                   | `slack-mcp` MCP tool                  | OpenCode direct `conversations.replies`                             |
| Read channel history                                  | `slack-mcp` MCP tool                  | OpenCode direct `conversations.history`                             |
| Read Slack file                                       | `slack-mcp` MCP tool                  | OpenCode direct `files.info` + private file download                |
| Upload file                                           | `slack-upload` helper                 | unchanged                                                           |
| Eyes reaction on accepted mention                     | `slack-mcp` REST                      | `gateway` direct Slack API                                          |
| Progress message lifecycle                            | `slack-mcp` REST + in-memory registry | `gateway` in-process                                                |
| Approval cards with buttons                           | `slack-mcp` REST                      | `gateway` direct Slack API                                          |
| Approval message update after click                   | `slack-mcp` REST                      | `gateway` direct Slack API                                          |
| Slack thread alias registration for direct curl posts | pre-existing gap                      | out-of-scope follow-up; do not solve via mitmproxy response rewrite |

## Target shape

```text
Slack Events API
    |
    v
gateway
  | verify signatures
  | enqueue + batch
  | post eyes / progress / approval cards directly to Slack
  v
runner
  |
  v
OpenCode
  |--- mcp --> remote-cli --> Atlassian / Grafana / PostHog / ...
  |
  \--- curl / fetch / slack-upload --> mitmproxy --> slack.com / files.slack.com
```

## Decision Log

| #   | Decision                                                                                                    | Rationale                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Move all system-side Slack API calls into `packages/gateway`                                                | Gateway already owns Slack webhooks, channel filtering, and approval interactivity routing. It is the natural place for reactions, progress, and approval cards.                                                                   |
| D2  | Keep agent Slack traffic on real Slack URLs over mitmproxy                                                  | That path already exists, matches the current OpenCode instructions, and removes the main reason for a dedicated Slack service.                                                                                                    |
| D3  | Do not replace `slack-mcp` with a general-purpose Slack CLI                                                 | A full wrapper would just recreate the MCP surface in another form. The repo already has `curl`, the Slack skill, and `slack-upload`.                                                                                              |
| D4  | Leave direct-curl Slack thread alias repair out of scope                                                    | Alias registration was already broken on the direct `curl` path before this refactor. Fixing it via mitmproxy response mutation widens the PR and couples notes behavior to proxy internals.                                       |
| D5  | Keep broad service-side Slack writes off the mitmproxy allowlist                                            | `chat.update`, `chat.delete`, and broad reaction management should remain in gateway. The one agent-side exception is the narrow `reactions.add` for marking work done (see D13).                                                  |
| D6  | Reuse the proven Slack progress and approval formatting code instead of rewriting behavior at the same time | The operational risk is in changing ownership, not in changing UX. Move the logic first; simplify internals later if still useful.                                                                                                 |
| D7  | Remove `slack` from repo proxy config immediately                                                           | This is a greenfield project. Carrying compatibility-only validation and prompt logic adds noise without protecting a real deployed population.                                                                                    |
| D8  | Route approval outcomes back to OpenCode through the gateway queue                                          | A direct non-interrupt runner trigger can return `busy`. Queue-backed replay preserves ordering and retries until the session can accept the announcement.                                                                         |
| D9  | Carry thread-routing context in the approval button payload                                                 | Slack interactivity gives us the approval message timestamp, not a guaranteed root-thread correlation key in our current parser. The button payload should carry enough data to re-enter the originating thread deterministically. |
| D10 | Keep Slack writes on plain `curl` without proxy response mutation                                           | The refactor removes the Slack MCP transport. It should not also make mitmproxy parse Slack request bodies or rewrite Slack JSON responses.                                                                                        |
| D11 | Fail gateway startup when `SLACK_BOT_TOKEN` is missing                                                      | Gateway now owns all Slack side effects. Starting without the bot token only creates a half-configured service that will accept work and then fail at runtime.                                                                     |
| D12 | Drain accepted approval-outcome runner responses in the background                                          | Approval re-entry shares the same per-thread queue key as normal Slack traffic. Once runner accepts the event, gateway should release the queue lock immediately instead of waiting for the resumed session to finish.             |
| D13 | Permit direct-curl `reactions.add` as the only agent reaction mutation                                      | Agents need to mark Slack work done with emoji reactions. Keep `chat.update`, `chat.delete`, and reaction removal out of the mitmproxy allowlist to avoid broad Slack mutation access.                                             |
| D14 | Use `@slack/web-api` `WebClient` in gateway instead of a hand-rolled fetch wrapper                          | Official typings for `chat.postMessage` / `chat.update` / `chat.delete` / `reactions.add`, one timeout seam, and tests can mock the client object directly.                                                                        |

## Phases

### Phase 1 — Agent path parity without `mcp slack`

**Goal**: make the agent Slack path independent from the `slack` MCP upstream
before touching gateway behavior.

Scope:

- keep `chat.postMessage` accessible via plain `curl`/`fetch`
- keep raw `curl` or built-in `fetch` for Slack reads and keep `slack-upload`
  for uploads
- update `build.md` and the Slack skill to use direct `curl` for
  `chat.postMessage` writes while preserving raw JSON stdout
- document that direct-curl Slack thread alias registration remains a
  pre-existing gap and is out of scope for this service removal

Files likely affected:

- `docker/opencode/config/agents/build.md`
- `docker/opencode/config/skills/slack/SKILL.md`

**Exit criteria**:

- agent can post to Slack without `mcp slack`
- `chat.postMessage` preserves valid Slack JSON on `stdout`
- existing file upload flow still works via `slack-upload`

### Phase 2 — Move progress, reactions, and approvals into gateway

**Goal**: remove every runtime HTTP dependency from `gateway` to `slack-mcp`.

#### Phase 2a — Gateway owns Slack side effects

Scope:

- give gateway a Slack Web API client (via `@slack/web-api` `WebClient`, see
  D14) for:
  - `chat.postMessage`
  - `chat.update`
  - `chat.delete`
  - `reactions.add`
- move progress lifecycle logic into `packages/gateway`
- move approval block formatting into `packages/gateway`
- replace `SlackMcpDeps` and `SLACK_MCP_URL` with direct Slack deps in gateway
- add `SLACK_BOT_TOKEN` to gateway runtime config
- update health checks so gateway no longer depends on `slack-mcp`

Behavior to preserve:

- eyes reaction on accepted mention
- progress threshold at 3 tool calls
- periodic progress updates
- successful runs delete non-error progress messages
- error progress messages remain visible
- approval cards render with the same button payload format
- approval outcome updates still edit the original Slack message

Known behavior (expected, not a bug):

- if a channel is removed from `config.json` while a Slack-triggered run is
  already in progress, that in-flight run may continue posting progress updates
  to the original channel until the stream finishes
- channel allowlist changes apply to new inbound Slack events and new runs; they
  do not retroactively interrupt an active session's progress relay

Implementation note:

- bot-reply cleanup can become best-effort from the Slack event echo
- session-end cleanup remains authoritative

Files likely affected:

- `packages/gateway/src/app.ts`
- `packages/gateway/src/service.ts`
- `packages/gateway/src/index.ts`
- `packages/gateway/src/healthcheck.ts`
- new gateway-local Slack helper / progress / approval modules
- gateway tests

#### Phase 2b — Approval resolution and non-interrupt re-entry

**Goal**: when a human clicks Approve or Reject, gateway handles the approval
business logic and reliably announces the outcome back to the originating
OpenCode session without interrupting active work.

Scope:

- acknowledge Slack interactivity immediately, then continue in background
- extend approval button routing data so gateway can recover the originating
  thread deterministically
  - preferred shape: versioned button payload includes at least `actionId`,
    `upstreamName`, and `threadTs` or equivalent correlation data
- perform approval business logic in gateway:
  - parse approve vs reject
  - call remote-cli approval resolution
  - capture the effective outcome, reviewer, action ID, tool, and any useful
    resolution summary available from remote-cli
  - update the approval card in Slack with the final status
- enqueue a synthetic approval-outcome event into the existing gateway queue
  with:
  - `source: "approval"`
  - `correlationKey: slack:thread:{threadTs}`
  - `interrupt: false`
  - payload containing the decision context needed to brief OpenCode
- teach the queue handler to convert approval-outcome events into a runner
  prompt for the same repo/thread
  - approved announcement: human approved action `{id}`; continue the workflow,
    fetch approval status if needed, and finish the next safe step
  - rejected announcement: human rejected action `{id}`; do not retry the same
    write blindly, explain the implication, and choose the next safe action
- rely on existing queue semantics for non-interrupt retries
  - if runner returns `busy`, the approval event stays on disk and is retried
    later
  - this avoids losing the approval/rejection announcement while a session is
    still active
- treat an approved-action execution failure from remote-cli as a delivered
  outcome: update the Slack card with the failure summary and re-enter the
  session with non-interrupt failure guidance rather than dropping the click
- resolve `slack:thread:*` aliases before enqueueing so approval clicks resume
  the canonical session when a Slack thread is an alias for a GitHub or cron
  correlation key

Files likely affected:

- `packages/gateway/src/app.ts`
- `packages/gateway/src/service.ts`
- `packages/gateway/src/queue.ts`
- `packages/gateway/src/slack.ts`
- `packages/common/src/progress-events.ts` if a dedicated approval-outcome event
  schema is useful
- gateway tests covering interactivity, queue deferral, and re-entry prompts

**Exit criteria**:

- `gateway` makes no HTTP calls to `/progress`, `/reaction`, `/approval`, or
  `/update-message`
- a long-running Slack-triggered session still shows progress and cleans it up
  on success
- an error session still leaves the failure message visible
- approval buttons still post and still update after resolve
- approval outcomes are re-enqueued to the originating session with
  `interrupt: false`
- approval announcements are not lost when the target session is busy; they are
  retried by the queue until accepted
- mention handling still adds the eyes reaction

### Phase 3 — Remove Slack from the MCP control plane

**Goal**: stop presenting Slack as a remote MCP upstream while preserving Slack
discoverability for agents.

Scope:

- stop warming or exposing the `slack` upstream from `remote-cli`
- update runner tool instructions so Slack is no longer listed under
  `[Available MCP tools]`
- add a Slack capability hint for repos that have configured Slack channels,
  pointing agents to the Slack skill and direct `curl` write path instead of
  `mcp slack`
- remove `"slack"` from `repos.*.proxies` with no compatibility shim
- update the tracked config example and tests to remove `slack` from repo
  `proxies`

Files likely affected:

- `packages/common/src/proxies.ts`
- `packages/common/src/proxies.test.ts`
- `packages/common/src/workspace-config.ts`
- `packages/common/src/workspace-config.test.ts`
- `packages/runner/src/tool-instructions.ts`
- `packages/runner/src/tool-instructions.test.ts`
- `docs/examples/workspace-config.example.json`

**Exit criteria**:

- OpenCode sessions no longer list `slack` under MCP upstreams
- repo prompts still make it clear how Slack replies and reads should be done
- tracked config and validation no longer accept Slack as an MCP upstream
- remote-cli health no longer counts Slack as a configured upstream

### Phase 4 — Delete `slack-mcp` and clean the topology

**Goal**: remove the package, service, and compose wiring after feature parity
is already proven.

Scope:

- delete `packages/slack-mcp`
- remove `slack-mcp` from `Dockerfile`
- remove the `slack-mcp` service and `depends_on` edges from `docker-compose.yml`
- remove `SLACK_MCP_URL` from gateway config
- remove stale `NO_PROXY` references to `slack-mcp`
- update architecture docs to reflect the new topology

Files likely affected:

- `Dockerfile`
- `docker-compose.yml`
- `docs/feat/mvp.md`
- any remaining tests or docs that name `slack-mcp`

**Exit criteria**:

- `docker compose up` works with no `slack-mcp` service
- repo build and targeted tests pass with `packages/slack-mcp` removed
- there are no runtime references to `http://slack-mcp:3003`
- the architecture doc no longer shows Slack as an MCP service

## Inherited progress-message behavior

These behavioral decisions still ship now that gateway owns the progress lifecycle:

| #   | Decision                                                                    | Rationale                                                                                                                                                           |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Register progress messages as `in_progress` at post time, not at `finish()` | Closes the race where the bot replies before `finish()` runs — `onBotReply` can always find and delete the message because it was tracked the moment it was posted. |
| P2  | Auto-delete progress on `post_message`, not on Slack event webhook echo     | The posting service knows immediately when the bot replies; no need to wait for Slack's event echo, which introduced a race window and a 60s timeout fallback.      |
| P3  | Status-aware cleanup — delete non-error progress, preserve error progress   | Error messages stay visible as debugging evidence; only successful/in-progress messages are cleaned up when the agent replies.                                      |
| P4  | Update cadence ~10s                                                         | Slack rate-limits `chat.update` to ~50/min per channel; 10s stays well within limits while still feeling responsive.                                                |
| P5  | Threshold of 3+ tool calls before any progress message is posted            | Avoids posting a progress message for quick tasks that complete in a few tool calls.                                                                                |

## Out of Scope

- broadening Slack access beyond the current bot-token capability set
- adding Slack search or user-directory features that do not exist today
- introducing OAuth or user-token Slack access
- redesigning the Slack progress UX
- changing approval semantics or remote-cli approval storage
- changing mitmproxy policy or response mutation for Slack
- repairing Slack thread alias registration for direct `curl` writes
