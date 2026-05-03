# Event Flow

> Scope: how events move through Thor end-to-end — every external trigger that enters `gateway`, the on-disk queue that coalesces them, the runner endpoint that drives OpenCode sessions, the alias machinery that ties keys to sessions, and the outbound path that emits approval cards back to Slack. Source of truth for inbound and outbound event handling.

## Topology

```mermaid
flowchart LR
    Slack[Slack Events / Interactivity]
    GH[GitHub Webhooks]
    Cron[Cron HTTP]
    Approval[Slack Buttons]

    GW[gateway<br/>HTTP intake + filters]
    Q[Event Queue<br/>data/queue/*.json]
    PBD[planBatchDispatch<br/>resolve dir + render prompt]
    RT[runner POST /trigger]
    AL[(aliases.jsonl<br/>+ session event log)]

    Slack --> GW
    GH --> GW
    Cron --> GW
    Approval --> GW
    GW -->|enqueue| Q
    Q -->|batch by lock key| PBD
    PBD -->|HTTP| RT
    RT <-->|read/append| AL
    PBD <-->|resolve| AL
```

The entire flow is "raw correlation key in → maybe-resolved session out". Aliases are how a `slack:thread:1234` becomes `session:abc123` — once that mapping exists, every subsequent event for that thread serializes onto the same session lock and resumes the same OpenCode session.

---

## 1. Gateway intake routes

All routes live in `packages/gateway/src/app.ts`. Each has its own validator, signature check, filter chain, and correlation-key builder. None of them call the runner directly — they all go through `EventQueue.enqueue()`.

### 1.1 `POST /slack/events` — Slack Events API

- **Validator**: `SlackEventEnvelopeSchema` (`packages/gateway/src/slack.ts:47`).
- **Signature**: `verifySlackSignature()` (slack.ts:105) — HMAC-SHA256 with `config.signingSecret`, 5-minute timestamp tolerance.
- **Special case**: `url_verification` payloads echo `challenge` and return.
- **Supported event subtypes**: `app_mention`, `message`, `reaction_added`, `reaction_removed`.
- **Filter chain** (app.ts:1055–1238): drop if bot disabled, empty text, self-message, channel not allow-listed, or duplicate `app_mention` text. `message` events are dropped unless Thor is already engaged in the thread (`hasSessionForCorrelationKey()`); `app_mention` is always forwarded.
- **Correlation key**: `slack:thread:<thread_ts || ts>` via `getSlackCorrelationKey()` (slack.ts:148). The thread root's `ts` is the alias value.
- **Enqueue shape**:
  - `app_mention`: `interrupt=true`, `delayMs=0` (immediate, can preempt a busy session).
  - regular `message`: `interrupt=false`, `delayMs=shortDelay` (~3 s), so multi-line bursts coalesce.
- **Side effect**: posts an "eyes" emoji reaction so the user sees Thor received the event before the queue drains.

### 1.2 `POST /github/webhook` — GitHub webhooks

- **Validator**: `GitHubWebhookEnvelopeSchema` (`packages/gateway/src/github.ts:179`), a discriminated union over `event_type`.
- **Signature**: `verifyGitHubSignature()` (github.ts:211) — HMAC-SHA256 from `X-Hub-Signature-256`, no timestamp window (the digest covers the immutable payload).
- **Supported events**:
  - `issue_comment` (created)
  - `pull_request_review_comment` (created)
  - `pull_request_review` (submitted)
  - `check_suite` (completed)
  - `push`
- **Repo gate**: every event must map to a workspace directory via the configured `localRepo` mapping. Unmapped repos are logged and dropped.
- **Filter chain** (`shouldIgnoreGitHubEvent`, github.ts:365): drops fork PRs, self-sender (the bot's own comments), pure issue comments not on a PR, empty review bodies, and non-mention comments.
- **Two correlation-key shapes**:
  - **Branch known** (`push`, review/comment events with `head.ref`, completed check suites with `head_branch`): `git:branch:<localRepo>:<branch>` via `buildCorrelationKey()` (github.ts:247). Alias value is `base64url(<full key>)`.
  - **Branch unknown** (issue comments, where the payload only has the PR number): `pending:branch-resolve:<localRepo>:<number>` via `buildPendingBranchResolveKey()` (github.ts:258). The key is parked on the queue with this synthetic prefix and is resolved later (see §3.1).
- **Push events** are special — `handleGitHubPushEvent()` (app.ts:693–856) syncs the worktree (`git fetch`, hard reset, branch delete) and only enqueues a wake-trigger if a session already exists for the branch.
- **Check-suite completed** further requires `verifyThorAuthoredSha()` (`github-gate.ts:9`) — the head commit's author email must match the bot identity. This blocks "CI green for someone else's commit" from re-entering Thor's session.

### 1.3 `POST /cron` — scheduled prompts

- **Validator**: `CronRequestSchema` (`packages/gateway/src/cron.ts:4`) — `{prompt, directory, correlationKey?}`.
- **Auth**: `Authorization: Bearer <CRON_SECRET>`. If `CRON_SECRET` is unset, the route returns 401.
- **Correlation key**: caller-supplied, or derived as `cron:<md5(prompt)>:<unix-seconds>` (`deriveCronCorrelationKey()`, cron.ts:21). Note: cron keys do **not** map to any alias type — they only resolve to a session if the caller passes a key that was previously bound (e.g. `slack:thread:...`).
- **Enqueue shape**: `interrupt=false`, `delayMs=0`. Cron-only batches drain in the foreground — the HTTP response waits for the runner to ack.

### 1.4 `POST /slack/interactivity` — approval buttons

- **Validator**: `SlackInteractivityPayloadSchema` (slack.ts:59). Body is form-encoded `payload=<JSON>`.
- **Signature**: same `verifySlackSignature()` as events.
- **Routing**: only `block_actions` with `action_id ∈ {approval_approve, approval_reject}` are processed. `parseApprovalButtonValue()` (`packages/gateway/src/approval.ts:59`) decodes the button's `value` field — `v3:<actionId>:<urlEncodedUpstream>:<threadTs>` (current) or `v2:<actionId>:<upstream>` (legacy).
- **Two-stage processing** (app.ts:1266–1316):
  1. Synchronously call `remote-cli` to resolve the approval (`resolveApproval(actionId, decision, ...)`).
  2. Update the original Slack message (✅/❌) and enqueue an **`approval` outcome event**.
- **Correlation key**: `slack:thread:<threadTs>` — same key the agent's `post_message` produced when it asked for approval. This is the single mechanism that lets an approval click resume the originating session.
- **Enqueue shape**: `interrupt=false`, `delayMs=0`. Payload carries `actionId`, `decision`, `reviewer`, `tool`, and the resolution status from remote-cli.

### 1.5 `GET /health` — healthcheck

Not an event source, but it exercises the same correlation/queue surfaces: it pings the runner, remote-cli, counts pending queue files, and flags stale events older than the staleness threshold (default 15 min).

---

## 2. The event queue

All ingestion lands in a single directory queue (`packages/gateway/src/queue.ts`). Files are atomic JSON writes (`tmp` + rename) named `<sourceTs-padded>_<id>.json`.

`QueuedEvent` (queue.ts:28) carries:

| Field            | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `id`             | dedup key — retry with same id overwrites                              |
| `source`         | `slack` \| `github` \| `cron` \| `approval`                            |
| `correlationKey` | raw key from §1 (may still be a `pending:branch-resolve:` placeholder) |
| `payload`        | the original event                                                     |
| `sourceTs`       | event-authoritative time (Slack `ts`, GH `created_at`, etc.)           |
| `readyAt`        | epoch ms after which the batch is eligible                             |
| `delayMs`        | original debounce delay                                                |
| `interrupt`      | if true, this event can preempt a busy session                         |

### 2.1 Lock-key grouping

`scan()` runs every 100 ms and groups files by **`resolveCorrelationLockKey(event.correlationKey)`** (queue.ts:234). This is the critical line that makes ingestion session-aware:

- If the raw key resolves to an alias → lock key is `session:<sessionId>`.
- Otherwise → lock key is the raw key itself.

Two consequences:

1. **Cross-key coalescing.** If a single OpenCode session has both a Slack thread and a Git branch alias bound to it, a `git:branch:thor:feat-x` push and a `slack:thread:1701...` reply land in the **same batch** because both resolve to the same `session:<id>` lock key. The runner sees one combined prompt instead of two parallel triggers.
2. **A pending resolve waits on its own bucket.** `pending:branch-resolve:<repo>:<num>` doesn't match any alias type, so it keeps its raw key as the lock key until §3.1 reroutes it.

### 2.2 Interrupt-aware batching

When at least one event in a key group has `interrupt=true`, batch readiness is computed from the interrupt events only. Non-interrupt events get swept into the same batch but never delay it. This is how an `app_mention` arriving 50 ms after a `message` cuts straight through the 3-second debounce: the interrupt's `readyAt` is now, the message tags along.

### 2.3 Settlement

The handler must call `ack()` (delete files), `reject(reason)` (move to `dead-letter/`), or return without settling (files stay on disk; retry next scan). A thrown handler also deletes — chosen over infinite retry. Returning unsettled is how the runner says "busy, try again later" without losing events.

---

## 3. From queue to runner: `planBatchDispatch`

`packages/gateway/src/service.ts:443` takes a batch and decides whether to dispatch, drop, or **reroute**.

### 3.1 Pending GitHub branch resolution (the reroute case)

When the batch's correlation key starts with `pending:branch-resolve:`:

1. The latest event must be an `issue_comment` (the only ingress that produces this key).
2. `resolveGitHubPrHead()` (service.ts:170) calls `gh pr view <num> --json headRefName,headRepository,baseRepository` to fetch the PR head branch.
3. If the head and base repos differ → drop with `fork_pr_unsupported`.
4. Otherwise the plan is `{kind: "reroute", fromCorrelationKey, toCorrelationKey: "git:branch:<repo>:<branch>", githubEvents}`. The handler **re-enqueues** every event with the resolved key. The next queue scan picks them up under the new lock key, where they may now coalesce with an existing branch session.

This is the only place an event's correlation key changes after enqueue. Everything else is read-only routing.

### 3.2 Directory + prompt assembly

For non-pending batches:

- **Directory**: each event resolves to a working directory (Slack channel→repo map, GitHub repo path lookup, cron-supplied, approval channel→repo map). All events in the batch must agree — mixed-directory batches are dropped to dead-letter (service.ts:557). **TODO — improve**: cross-source mixed-directory batches happen legitimately when a session bridges repos via aliases (e.g. a Slack thread session in repoA's channel pushes a branch in repoB, registering `git:branch:repoB:* → s1`; a later Slack reply and GitHub push then batch under `session:s1` with two different directories). Dead-lettering silently drops the user's click/comment, which Slack already 200'd and cannot replay. Worth revisiting; design open.
- **Prompt**: each source has a renderer (`renderSlackPrompt`, `renderGitHubPrompt`, `buildApprovalOutcomePrompt`, raw cron prompt). Parts are joined with `\n\n`.
- **Progress target**: the last Slack event (or approval) provides `{channel, threadTs, ts}` for streaming relays. Cron-only batches have no progress target and drain in the foreground.

### 3.3 The HTTP call

`triggerRunnerPrompt()` (service.ts:376) issues:

```
POST <runnerUrl>/trigger
Content-Type: application/json

{
  "prompt": "<rendered>",
  "correlationKey": "<resolved key>",
  "directory": "<workdir>",
  "interrupt": true|false
}
```

Three response cases:

- `200 application/json` with `{busy: true}` and `interrupt=false` → batch stays unsettled, retried next scan.
- `200 application/x-ndjson` → stream each event to Slack via the progress relay (background) or drain (foreground).
- `4xx` → `reject()` to dead-letter.
- Other → throw, batch retried.

---

## 4. The runner trigger endpoint

`packages/runner/src/index.ts:682` (`POST /trigger`) is the only place sessions are created or resumed.

### 4.1 Lock + session resolution

```ts
lockKey = requestedSessionId
  ? `session:${requestedSessionId}`
  : correlationKey
    ? resolveCorrelationLockKey(correlationKey)
    : undefined;

await withCorrelationKeyLock(lockKey, async () => {
  candidate = requestedSessionId || resolveSessionForCorrelationKey(correlationKey);
  if (candidate && client.session.get({ id: candidate }).data) {
    // resume
  } else if (candidate) {
    // stale → create new + record session.parent alias from candidate → new
  } else {
    // create new
  }
  if (correlationKey) appendCorrelationAlias(newOrResumedId, correlationKey);
});
```

The lock is per-process and per-resolved-key; it prevents two concurrent triggers from race-creating duplicate sessions for the same Slack thread.

### 4.2 Busy handling

If the resolved session is `busy`:

- `interrupt=false`: respond `{busy: true}` and let the gateway re-enqueue.
- `interrupt=true`: end the in-flight trigger as `aborted` (reason `user_interrupt`), call `client.session.abort()`, wait up to `ABORT_TIMEOUT` for the `idle` event. Timeout → 503.

### 4.3 Trigger lifecycle in the session event log

Every trigger emits two records into the per-session JSONL log (`packages/common/src/event-log.ts`):

- `trigger_start` (event-log.ts:29) — `triggerId` (UUID), `correlationKey`, `promptPreview`.
- `trigger_end` (event-log.ts:36) — `status: completed | error | aborted`, `durationMs`, optional `error`, optional `reason`.

**Invariant**: every `trigger_start` is paired with a `trigger_end`. The runner emits `trigger_end` from the Express error path, the abort path above, and the SIGTERM shutdown handler — the log can never end with an open `trigger_start`. The viewer relies on this to compute slice status.

---

## 5. Outbound: approval card emission

Inbound `/slack/interactivity` (§1.4) only handles a button **click**. Posting the approval card in the first place is the outbound counterpart, and it rides the runner→gateway NDJSON stream rather than any direct call.

### 5.1 The chain

```mermaid
sequenceDiagram
    autonumber
    participant Agent
    participant RC as remote-cli
    participant Store as approvalStore
    participant Runner
    participant GW as gateway
    participant Slack

    Agent->>RC: MCP call (e.g. createJiraIssue, args)
    RC->>Store: create(tool, args)
    Note right of Store: pending action persisted to<br/>/workspace/data/approvals
    RC-->>Agent: tool result = JSON<br/>type=approval_required,<br/>actionId, proxyName, tool, command
    Note over Agent,Runner: OpenCode emits tool-completed part<br/>output = the JSON above
    Runner->>Runner: parseApprovalResult<br/>(JSON.parse + Zod validate)
    Runner-->>GW: NDJSON ProgressEvent<br/>type=approval_required, actionId, tool, args, proxyName
    GW->>GW: consumeNdjsonStream<br/>routes by event.type
    GW->>Slack: postMessage + approval blocks<br/>(Approve / Reject buttons)
    Note over Slack: Human reviews the card<br/>click → POST /slack/interactivity (§1.4)
```

### 5.2 The hand-offs

1. **remote-cli creates the approval** (`packages/remote-cli/src/mcp-handler.ts`). For tools classified `approve`, it calls `approvalStore.create(toolName, args)` and returns a tool result whose body is `JSON.stringify({type:"approval_required", actionId, proxyName, tool, command})`. For Jira write tools, args are first mutated by `addDisclaimerToApprovalArgs()` so the disclaimer footer is part of both the approval card the human reads and the payload that executes on approve. The action persists to `/workspace/data/approvals` regardless of what happens downstream.
2. **OpenCode emits the tool completion** through the session event bus. The output string is whatever remote-cli returned, byte-for-byte.
3. **Runner extracts the approval signal** in the per-tool branch of the stream handler (runner index.ts:1096). For every completed tool, `parseApprovalResult(output, tool, args)` (index.ts:1249) attempts `JSON.parse(output)` and validates the result against `ApprovalRequiredOutputSchema`. On success it returns a `ProgressEvent` `{type:"approval_required", actionId, tool, args, proxyName}`; on any failure it returns `undefined`. The event, if produced, is written into the NDJSON response stream alongside other progress events.
4. **Gateway routes the event** in `consumeNdjsonStream` (`packages/gateway/src/service.ts:692`). The `approval_required` type is special-cased to `forwardApprovalNotification(channel, threadTs, event, slackDeps)` rather than the generic `handleProgressEvent` path.
5. **Slack post** is built by `forwardApprovalNotification` (service.ts:931): `formatApprovalArgs(event.args)` produces a Slack-safe JSON snippet (with depth/length trimming for the 3000-char block limit), `buildApprovalButtonValue({actionId, upstreamName, threadTs})` produces the `v3:` button payload, `buildInlineApprovalBlocks(tool, argsJson, buttonValue)` assembles the blocks, and `postMessage()` posts to the thread. The button's `threadTs` is what later closes the loop in §1.4 — clicking the button enqueues an approval-outcome event with `slack:thread:<threadTs>` so the gateway resolves it back to the same session.

### 5.3 Required preconditions

Two things must hold for the Slack card to actually post:

- **The trigger has a progress target.** `consumeNdjsonStream` only runs when the runner trigger had a `progressTarget` (Slack channel + thread + ts). `buildProgressTarget` (service.ts:280) derives this from the last Slack event or the last approval-outcome event in the batch. **Cron-only batches have no progress target**, so an approval emitted from a cron-only run is drained silently — there's no thread to post to. This is consistent with cron design (cron jobs route their own output via the prompt), not a bug.
- **The runner's response is the NDJSON stream**, not the `{busy:true}` JSON short-circuit. Approvals can only originate inside an actively-streaming trigger, so this is automatic in practice.

### 5.4 Known weakness — fragile to tool-output handling

`parseApprovalResult` requires the **entire** tool output to be the approval JSON. This works perfectly when the agent calls the MCP tool natively (OpenCode → MCP server → remote-cli → returns clean JSON), but the agent has bash and a wrapper CLI (`mcp` per `build.md:40`), so it can also reach the same write tool via shell. Anything that munges the output between remote-cli and the runner breaks detection:

| Agent invocation                         | Output reaching `parseApprovalResult`      | Slack card |
| ---------------------------------------- | ------------------------------------------ | ---------- |
| Native MCP call                          | `{"type":"approval_required",...}`         | ✅         |
| `mcp call <tool> ...` (bash, no munging) | same JSON, maybe trailing `\n`             | ✅         |
| `mcp call ... \| jq .actionId`           | `"abc-123"\n`                              | ❌         |
| `mcp call ... > /tmp/out.json`           | empty                                      | ❌         |
| `echo "calling..."; mcp call ...`        | leading text + JSON                        | ❌         |
| Same call inside a `task()` subagent     | parent sees subagent summary, not raw JSON | ❌         |

In all the failure cases the **action is still persisted** in `approvalStore` — nothing is dropped at the policy layer — but no Slack notification fires. The human can only discover the pending action by polling `approval status <id>`, which they wouldn't think to do.

**TODO — improve.** Worth revisiting; design open.

---

## 6. Aliases — the entire mechanism

There are exactly **three alias types**, declared as a closed enum at `packages/common/src/event-log.ts:7`:

```ts
export const ALIAS_TYPES = ["slack.thread_id", "git.branch", "session.parent"] as const;
```

Alias values are validated: 1–512 chars, no control characters (`\n`, `\r`, `\t`, `\0`) — anything that could corrupt the JSONL line.

### 6.1 Storage

All aliases live in a single append-only file: `<worklog>/aliases.jsonl`. Each line is an `AliasRecord` (`event-log.ts:74`):

```json
{
  "ts": "...",
  "aliasType": "slack.thread_id",
  "aliasValue": "1701234567.123",
  "sessionId": "abc..."
}
```

`appendAlias()` (event-log.ts:252) writes the line, updates an in-memory cache keyed by `<aliasType>:<aliasValue>` → `sessionId`, and (except for `session.parent`) also appends a corresponding `alias` record into the session's own event log so the alias is visible in the viewer.

`resolveAlias()` (event-log.ts:415) looks up the cache. The cache reloads only when `aliases.jsonl`'s size changes (signature check) — cheap and consistent with append-only semantics.

### 6.2 The three alias types

| Alias type        | Alias value                               | Sessions it points at            | Created when                                                                                                                                            |
| ----------------- | ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack.thread_id` | `<thread_ts>` (raw, 1:1)                  | the live session for that thread | (a) gateway accepts a Slack event for an engaged thread; (b) agent calls `slack post_message` and remote-cli sees a `thread_ts` in the args or response |
| `git.branch`      | `base64url("git:branch:<repo>:<branch>")` | the live session for that branch | (a) gateway accepts a GitHub event for a known branch; (b) remote-cli sees `git push`, `git checkout`, `git switch`, or `git worktree add`              |
| `session.parent`  | `<some-sessionId>`                        | a successor / parent session     | (a) runner re-creates after `session_stale`; (b) runner discovers a child session from a `task` tool call                                               |

The first two are correlation-key aliases — `aliasForCorrelationKey()` (correlation.ts:120) is the single function that maps a key prefix to an alias spec:

```ts
"slack:thread:..."  → {aliasType: "slack.thread_id", aliasValue: <suffix>}
"git:branch:..."    → {aliasType: "git.branch", aliasValue: base64url(<full key>)}
otherwise           → undefined  // includes cron:..., pending:branch-resolve:...
```

This is why `cron:` keys never resolve to a session unless the caller passes a different key.

### 6.3 Where aliases are written

| Site                                            | Code                                                                                                              | What it does                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Runner trigger, on session create/resume        | `index.ts:768` `appendCorrelationAlias(id, correlationKey)`                                                       | binds the incoming `slack:thread:` or `git:branch:` key to the session           |
| Runner trigger, on `session_stale` recreate     | `index.ts:758` `appendAlias({aliasType: "session.parent", aliasValue: oldId, sessionId: newId})`                  | so old viewer links chain-walk to the new session                                |
| Runner stream handler, on subagent discovery    | `index.ts:1067` `appendAlias({aliasType: "session.parent", aliasValue: childId, sessionId: parentId})`            | so child session viewer links walk up to the orchestrator                        |
| Remote-cli, after every `git`/`gh` exec         | `remote-cli/src/index.ts:108` `appendCorrelationAlias(sessionId, computeGitCorrelationKey(args, cwd))`            | binds `git:branch:<repo>:<branch>` whenever the agent pushes/checks out a branch |
| Remote-cli, after Slack `post_message` MCP call | `remote-cli/src/mcp-handler.ts:426` `appendCorrelationAlias(sessionId, computeSlackCorrelationKey(args, stdout))` | binds `slack:thread:<ts>` on first message in a new thread, and on every reply   |

The agent itself never touches the alias file — every write happens in code paths that already see both `sessionId` and the correlating identifier.

### 6.4 Where aliases are read

```mermaid
flowchart LR
    A[gateway accepts event] --> B{rawKey resolves?<br/>resolveSessionForCorrelationKey}
    B -- yes --> C[lockKey = session:&lt;id&gt;<br/>batch coalesces with other keys for same session]
    B -- no --> D[lockKey = rawKey<br/>new session if dispatched]
    C --> E[runner /trigger]
    D --> E
    E --> F{candidate session<br/>still alive in OpenCode?}
    F -- yes --> G[resume, append alias]
    F -- no --> H[create new + session.parent alias from old to new]
```

Three call sites read aliases:

1. **`EventQueue.scan()`** (queue.ts:234) — `resolveCorrelationLockKey()` decides batch grouping. This is what makes `slack:thread:X` and `git:branch:Y` for the same session share a lock.
2. **Gateway filters** — `hasSessionForCorrelationKey()` decides whether a non-mention Slack `message` should be forwarded (only if Thor is engaged) and whether a `check_suite` completed event has a session to wake.
3. **Runner trigger** (index.ts:725) — picks the candidate session ID from the correlation key when the gateway didn't pin one explicitly.

`session.parent` is read separately by **`findActiveTrigger()`** (event-log.ts:440), which the trigger viewer (`/raw/:sessionId/:triggerId`) calls to walk up to depth 5 from a stale-or-child session ID to the live trigger. It's not used for ingestion routing — only for the viewer URL chain.

### 6.5 Non-obvious properties

- **Append-only, no revocation.** A `slack.thread_id` alias never points anywhere new after the first write — once `slack:thread:1701...` binds to session A, it binds forever. If session A goes stale, the runner creates session B and adds a `session.parent` from A→B; subsequent threads still resolve to A first, but then `client.session.get(A)` 404s, and the runner does a fresh create. This is **not** a re-bind of the Slack alias; it's a per-trigger fallback.
  - Net effect: a Slack thread can outlive multiple OpenCode sessions, with each generation linked by a `session.parent` chain readable through the viewer.
- **`git.branch` aliases are base64url'd** because branch names contain `/` and other characters; the value is round-tripped through the alias schema's safety check. The Slack form uses the raw `ts` (digits + dot) which is already safe.
- **`pending:branch-resolve:` is an unaliased key**, so it never resolves to a session and never coalesces with anything. It's a queue-only construct that exists for at most one batch cycle before §3.1 reroutes it.
- **The session log mirrors `slack.thread_id` and `git.branch` aliases** as `alias` records (`AliasEventRecordSchema`, event-log.ts:50). `session.parent` is suppressed from the per-session log to avoid noise — it lives only in `aliases.jsonl`.

---

## 7. Putting it together: a worked example

A user types `@thor look at this PR` in a Slack thread, then later pushes commits to the PR's branch.

1. **Slack mention arrives** → `POST /slack/events` → validator + signature pass → `app_mention` filter pass → enqueue with `correlationKey="slack:thread:1701234567.123"`, `interrupt=true`, `delayMs=0`.
2. **Queue scan** groups the file under lock key `slack:thread:1701234567.123` (no alias yet). Batch ready, `planBatchDispatch` resolves channel→repo, builds the prompt, posts to `runner/trigger`.
3. **Runner** has no candidate session → creates `session abc123`, appends `(slack.thread_id, 1701234567.123) → abc123`. Returns NDJSON stream; the agent does work.
4. **Agent pushes a branch** via `gh pr create` / `git push`. Remote-cli's `/exec/git` and `/exec/gh` shims call `computeGitCorrelationKey(["push", "origin", "feat-x"], cwd)` → `git:branch:thor:feat-x`, then `appendCorrelationAlias(abc123, ...)`. Now `(git.branch, base64url("git:branch:thor:feat-x")) → abc123` is bound.
5. **GitHub push webhook fires** → `POST /github/webhook` → `handleGitHubPushEvent` syncs the worktree → `hasSessionForCorrelationKey("git:branch:thor:feat-x")` returns true → enqueue with `interrupt=false`.
6. **Queue scan** sees the new file. `resolveCorrelationLockKey("git:branch:thor:feat-x")` → `session:abc123`. If a Slack reply also arrived in the same window, it has lock key `session:abc123` too — they batch together. One `runner/trigger` call, one resumed session, one combined prompt.

That last step — two different correlation keys becoming one batch through alias resolution — is the entire point of the aliasing layer.
