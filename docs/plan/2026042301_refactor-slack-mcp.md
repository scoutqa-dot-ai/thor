# refactor slack-mcp — 2026-04-23-01

**Goal**: remove `packages/slack-mcp` as a package and runtime service without
losing any current Slack capability.

The target split is:

- agent-driven Slack work uses real Slack Web API URLs from OpenCode over the
  existing mitmproxy path
- system-driven Slack work lives inside `packages/gateway`
- `packages/remote-cli` no longer exposes a `slack` MCP upstream

## Workflow

Implementation follows `AGENTS.md`:

1. implement one phase only
2. self-test against that phase's exit criteria
3. stop for human review
4. after approval, create one focused commit for that phase
5. continue to the next phase

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

| Capability                                           | Current owner                         | Target owner                                                          |
| ---------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Post Slack reply / start new thread                  | `slack-mcp` MCP tool                  | OpenCode direct `curl` with mitmproxy in-band metadata injection      |
| Read thread replies                                  | `slack-mcp` MCP tool                  | OpenCode direct `conversations.replies`                               |
| Read channel history                                 | `slack-mcp` MCP tool                  | OpenCode direct `conversations.history`                               |
| Read Slack file                                      | `slack-mcp` MCP tool                  | OpenCode direct `files.info` + private file download                  |
| Upload file                                          | `slack-upload` helper                 | unchanged                                                             |
| Eyes reaction on accepted mention                    | `slack-mcp` REST                      | `gateway` direct Slack API                                            |
| Progress message lifecycle                           | `slack-mcp` REST + in-memory registry | `gateway` in-process                                                  |
| Approval cards with buttons                          | `slack-mcp` REST                      | `gateway` direct Slack API                                            |
| Approval message update after click                  | `slack-mcp` REST                      | `gateway` direct Slack API                                            |
| Slack thread alias registration for new thread posts | MCP `post_message` metadata           | mitmproxy-injected in-band `thor-meta-key` on `chat.postMessage` JSON |

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

## Recommendation

Remove `slack-mcp` by collapsing Slack responsibilities into two places only:

1. `packages/gateway` becomes the only service-side Slack component.
2. OpenCode uses the existing Slack skill plus real Slack Web API URLs for
   agent-driven reads and writes.

Do not build a new Slack-specific service or a new Slack MCP replacement.
Use direct `curl` to Slack write endpoints and let mitmproxy inject in-band
metadata into successful `chat.postMessage` JSON responses. Keep Slack reads on
normal `curl` or built-in `fetch`.

## Decision Log

| #   | Decision                                                                                                    | Rationale                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Move all system-side Slack API calls into `packages/gateway`                                                | Gateway already owns Slack webhooks, channel filtering, and approval interactivity routing. It is the natural place for reactions, progress, and approval cards.                                                                   |
| D2  | Keep agent Slack traffic on real Slack URLs over mitmproxy                                                  | That path already exists, matches the current OpenCode instructions, and removes the main reason for a dedicated Slack service.                                                                                                    |
| D3  | Do not replace `slack-mcp` with a general-purpose Slack CLI                                                 | A full wrapper would just recreate the MCP surface in another form. The repo already has `curl`, the Slack skill, and `slack-upload`.                                                                                              |
| D4  | Inject Slack thread correlation in-band via mitmproxy response mutation                                     | `chat.postMessage` already returns JSON; adding a top-level `thor-meta-key` preserves raw JSON usability and removes wrapper-specific stderr metadata plumbing.                                                                    |
| D5  | Keep service-side Slack writes off the mitmproxy allowlist                                                  | `chat.update`, `chat.delete`, and `reactions.add` are system-only methods. Keeping them in gateway avoids widening the OpenCode Slack proxy surface.                                                                               |
| D6  | Reuse the proven Slack progress and approval formatting code instead of rewriting behavior at the same time | The operational risk is in changing ownership, not in changing UX. Move the logic first; simplify internals later if still useful.                                                                                                 |
| D7  | Remove `slack` from repo proxy config immediately                                                           | This is a greenfield project. Carrying compatibility-only validation and prompt logic adds noise without protecting a real deployed population.                                                                                    |
| D8  | Route approval outcomes back to OpenCode through the gateway queue                                          | A direct non-interrupt runner trigger can return `busy`. Queue-backed replay preserves ordering and retries until the session can accept the announcement.                                                                         |
| D9  | Carry thread-routing context in the approval button payload                                                 | Slack interactivity gives us the approval message timestamp, not a guaranteed root-thread correlation key in our current parser. The button payload should carry enough data to re-enter the originating thread deterministically. |
| D10 | Remove wrapper-only request-header policy for `chat.postMessage`                                            | Slack writes should work with plain `curl`; correlation metadata is now injected by mitmproxy after inspecting request+response payloads rather than enforcing wrapper transport headers.                                          |
| D11 | Fail gateway startup when `SLACK_BOT_TOKEN` is missing                                                      | Gateway now owns all Slack side effects. Starting without the bot token only creates a half-configured service that will accept work and then fail at runtime.                                                                     |
| D12 | Drain accepted approval-outcome runner responses in the background                                          | Approval re-entry shares the same per-thread queue key as normal Slack traffic. Once runner accepts the event, gateway should release the queue lock immediately instead of waiting for the resumed session to finish.             |

## Phases

### Phase 1 — Agent path parity without `mcp slack`

**Goal**: make the agent Slack path independent from the `slack` MCP upstream
before touching gateway behavior.

Scope:

- preserve Slack thread aliasing for `chat.postMessage` while keeping the
  transport on real Slack URLs over mitmproxy
- make mitmproxy generate Slack thread correlation metadata in-band for
  successful `POST https://slack.com/api/chat.postMessage` responses:
  - inspect request payload (`thread_ts`) and response payload (`ts`)
  - inject top-level JSON field `thor-meta-key: slack:thread:<ts>`
  - replies use request `thread_ts`; new threads use response `ts`
- keep `chat.postMessage` accessible via plain `curl`/`fetch` without wrapper-
  specific header enforcement
- keep raw `curl` or built-in `fetch` for Slack reads and keep `slack-upload`
  for uploads
- update `build.md` and the Slack skill to use direct `curl` for
  `chat.postMessage` writes while preserving raw JSON stdout
- add or update tests around notes alias extraction and proxy policy so
  Slack posts still produce `slack:thread:*` aliases without breaking
  JSON pipelines

Files likely affected:

- `docker/opencode/config/agents/build.md`
- `docker/opencode/config/skills/slack/SKILL.md`
- `packages/common/src/notes.test.ts`
- `docker/mitmproxy/addon.py`
- `docker/mitmproxy/test_addon.py`

**Exit criteria**:

- agent can post to Slack without `mcp slack`
- `chat.postMessage` preserves valid Slack JSON on `stdout`
- successful `chat.postMessage` responses include
  `thor-meta-key=slack:thread:<ts>` in-band
- new-thread Slack posts still register `slack:thread:<ts>` aliases in notes
- in-thread Slack replies still register or preserve the thread alias
- existing file upload flow still works via `slack-upload`

### Phase 2 — Move progress, reactions, and approvals into gateway

**Goal**: remove every runtime HTTP dependency from `gateway` to `slack-mcp`.

#### Phase 2a — Gateway owns Slack side effects

Scope:

- move Slack Web API helper code needed for:
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

## Review Fixes

- 2026-04-27: Approval outcome re-entry resolves `slack:thread:*` aliases before
  enqueueing, so approval clicks resume the canonical session when a Slack thread
  is an alias for a GitHub or cron correlation key.
- 2026-04-27: Approved-action execution failures from remote-cli are treated as
  delivered approval outcomes. Gateway updates the Slack card with the failure
  summary and re-enters the agent session with non-interrupt failure guidance.
- 2026-04-27: Direct Slack writes through mitmproxy now enforce the configured
  Slack channel allowlist before bot-token injection. `chat.postMessage` and
  `files.completeUploadExternal` fail closed when the channel is missing or not
  configured.
- 2026-04-27: Removed the no-op OpenCode `curl` wrapper after Slack metadata
  injection moved into mitmproxy. The OpenCode image now uses the apt-installed
  `/usr/bin/curl` directly.

## Verification matrix

Run these checks before considering the migration complete:

1. Slack mention in an allowed channel adds `:eyes:` and starts a runner session.
2. A session with 3+ tool calls posts and updates a progress message.
3. A successful session removes non-error progress messages.
4. A failed session leaves the error progress message visible.
5. An approval-required tool posts a Slack approval card with working buttons.
6. Clicking Approve or Reject updates the original Slack message correctly.
7. Clicking Approve or Reject also re-enqueues a non-interrupt announcement to
   the originating OpenCode session.
8. If that session is busy, the approval-outcome event is deferred and retried
   instead of being dropped.
9. Agent can read a thread with direct `conversations.replies`.
10. Agent can read recent channel history with direct `conversations.history`.
11. Agent can fetch a Slack file via `files.info` plus direct download.
12. Agent can upload a file with `slack-upload`.
13. Agent can start a new Slack thread and the notes file records
    `slack:thread:<ts>`.
14. `mcp slack ...` is no longer required anywhere in the active prompt path.

## Out of Scope

- broadening Slack access beyond the current bot-token capability set
- adding Slack search or user-directory features that do not exist today
- introducing OAuth or user-token Slack access
- redesigning the Slack progress UX
- changing approval semantics or remote-cli approval storage
- changing the mitmproxy Slack rule surface beyond what is needed to inject
  in-band metadata for `chat.postMessage` and allow direct reads/uploads
