<!-- /autoplan restore point: /Users/son.dao/.gstack/projects/scoutqa-dot-ai-thor/session-log-links-autoplan-restore-20260430-091720.md -->
# Session Event Log and Public Trigger Viewer

**Date**: 2026-04-30
**Status**: Draft (revised by /autoplan 2026-04-30)

## Goal

Deliver a session-scoped JSONL event log that powers:

- a Vouch-gated trigger viewer at `/runner/v/<sessionId>/<triggerId>` for completed and in-flight triggers
- OpenCode session event history
- Slack thread and git branch alias routing (plus a `session.parent` alias for child→parent resolution)
- disclaimer-link injection for Thor-created GitHub PRs/comments/reviews and Jira tickets/comments
- a retention/archival/janitor story so the worklog stays bounded

No database. No backwards-compatible markdown-notes routing layer. The source of truth is the session log; markdown notes remain only for human-readable continuity.

## Log Shape

Each OpenCode session has one append-only log at a flat, day-independent path:

```text
/workspace/worklog/sessions/<session-id>.jsonl
```

The flat layout (no day-partition for session files) avoids absolute-symlink fragility across volume mounts, backups, and archival. Day-based archival happens later via the retention sweeper, not via the live read path.

Record kinds:

```ts
type SessionEventLogRecord =
  | { schemaVersion: 1; ts: string; type: "trigger_start"; sessionId: string; triggerId: string; correlationKey?: string; promptPreview?: string }
  | { schemaVersion: 1; ts: string; type: "trigger_end"; sessionId: string; triggerId: string; status: "completed" | "error" | "aborted"; durationMs?: number; error?: string; reason?: string }
  | { schemaVersion: 1; ts: string; type: "opencode_event"; sessionId: string; event: unknown }
  | { schemaVersion: 1; ts: string; type: "alias"; sessionId: string; aliasType: "slack.thread_id" | "git.branch" | "session.parent"; aliasValue: string; source?: string }
  | { schemaVersion: 1; ts: string; type: "tool_call"; sessionId: string; callId?: string; tool: string; payload: unknown };
```

Writer contract:

- One JSON object per line, terminated by `\n`. Writers use `appendFileSync` with a single complete append per record.
- Every record is capped at **< 4 KiB** serialized. Larger `event` and `payload` fields are truncated; truncation marker `"_truncated": true` is set on the record. Mirrors the existing pattern in `packages/common/src/worklog.ts`.
- Writers extend the existing `appendJsonlWorklog` primitive in `packages/common/src/worklog.ts:123` rather than building parallel infrastructure. New helper: `appendSessionEvent(sessionId, record)`.
- `triggerId` is generated as a UUIDv4 (≥128-bit random) by the runner. The format is documented and asserted in tests so the viewer URL stays an unguessable bearer.
- Single-writer-per-session is assumed. Runner is single-replica today; if multi-replica is ever required, an advisory `flock` on the session file is added then.

Reader contract:

- Single shared Zod schema in `@thor/common/event-log.ts`, imported by writer, viewer, alias resolver, and any active-trigger inference fallback.
- Readers `safeParse` each line and skip-with-counter on failure. Counter surfaces in the viewer footer.
- Readers tolerate a partial trailing line: a fragment without `\n` is dropped without error.
- Unknown record types render as a generic `<details>` with `type` and the JSON body.
- Forward-compatibility: readers drop unknown fields, render best-effort.

## Lookup Indexes

Three lookup needs:

1. **External alias → session.** Slack thread id or git branch key must resolve to a Thor session id.
2. **Child session → parent session.** When a parent OpenCode session spawns a child, the child's session id maps to the parent's. Lets disclaimer inference walk up to the session that owns the active trigger.
3. **Active trigger in a session.** Used by remote-cli on disclaimer-eligible writes (PR create, PR comments, reviews, Jira ticket create, Jira comments) — a handful of reads per trigger.

### Alias index

```text
/workspace/worklog/aliases.jsonl
```

A single append-only file. Each line:

```ts
type AliasRecord = {
  ts: string;
  aliasType: "slack.thread_id" | "git.branch" | "session.parent";
  aliasValue: string;
  sessionId: string;
};
```

For `session.parent`: `aliasValue` is the **child** OpenCode session id; `sessionId` is the **parent** OpenCode session id.

Resolution: the resolver tails the file (read last N KiB), parses backwards or builds an in-memory map on cold start, returns the **newest** record for the given `(aliasType, aliasValue)`. The map is cached per process and rebuilt on miss.

This replaces the absolute-symlink layout in the original plan. No symlinks → no portability concerns across volume mounts, backup tools, or archival. Day-partitioning is a write-time decision in `appendJsonlWorklog`, not a path requirement.

Filename encoding for `aliasValue`:

- Slack thread ids: validate as `[0-9.]+` before recording.
- Git branch aliases: use base64url of the full canonical branch key (case-fold-safe on macOS APFS).
- Child session ids: OpenCode session id format (alphanumeric + `_`); validate before use.

### Active-trigger inference

remote-cli calls `findActiveTrigger(requestSessionId)` on each disclaimer-eligible write. The function walks the parent chain so a child session resolves to the parent's open trigger, and **returns the owner session id** alongside the trigger id — the owner is where the `trigger_start` record actually lives, which is the session id the viewer URL must use.

1. Set `currentId = requestSessionId`; track `visited = {currentId}`.
2. Open `/workspace/worklog/sessions/<currentId>.jsonl` if it exists.
3. Scan the complete capped session log for `currentId` (Phase 1 cap: 50 MiB). This is intentionally not a tail read: a long-running trigger can write enough events that its `trigger_start` falls outside any tail window before a late PR/Jira write.
4. If the file exceeds the cap or cannot be fully scanned within the read budget, return `oversized` and fail closed.
5. Find `trigger_start` records without a matching `trigger_end` later in the full scanned log.
6. If exactly one open trigger → return `{ sessionId: currentId, triggerId }`.
7. If zero open triggers → look up `(aliasType: "session.parent", aliasValue: currentId)` in `aliases.jsonl`. If a parent exists, set `currentId = parentId`, add to `visited` (return `cycle` if already present), check depth cap (≤5, return `depth_exceeded` otherwise), and loop to step 2.
8. If the chain exhausts with zero opens, return `none`. This includes the fail-closed case where a request originates from a child session before its `session.parent` alias has been recorded: without a recorded parent relation, `findActiveTrigger` intentionally treats it the same as any other session with no active trigger. If any node returns >1 open trigger, return `ambiguous` immediately.

No current-trigger sidecar/index in v1. Each disclaimer-eligible write does a fresh full bounded scan of the capped JSONL file; the per-trigger call volume is small enough that I/O is not load-bearing, and correctness is more important than tail-scan speed.

Failure mode: if inference returns anything other than exactly one open trigger (`none`, `ambiguous`, `depth_exceeded`, `cycle`, `oversized`), the caller fails-fast. The write does not ship without a disclaimer. See "Disclaimer Links" for the per-path details.

## Trigger Slicing

`triggerId` is **not** propagated through OpenCode/bash/curl/remote-cli. It is generated and owned by the runner; remote-cli recovers it via active-trigger inference (see "Lookup Indexes") on the small set of disclaimer-eligible writes. Prior research rejected direct propagation for v1: no trusted per-trigger env channel exists from runner into OpenCode shell hooks, and making one deterministic would require a new shared mapping, plugin contract, or remote lookup surface.

The runner owns trigger boundaries:

1. Resolve or create the OpenCode session via the JSONL alias resolver, with an advisory lock on the alias key during resolve+create to prevent same-`correlationKey` race.
2. If the session is busy and the trigger is non-interrupting, return busy and write no marker.
3. If the session is busy and the trigger may interrupt, abort the session.
4. Wait for `session.idle` or `session.error`.
5. If settle times out, write no marker and do not call `promptAsync`.
6. Generate `triggerId` (UUIDv4).
7. Append `trigger_start`.
8. Send `promptAsync`.
9. Append OpenCode events for the parent and child sessions.
10. Append `trigger_end` (with `status: completed | error | aborted`, plus optional `reason`) when the trigger finishes.

### What the runner can and cannot guarantee about close markers

The trigger handler is wrapped in a `try/catch/finally` and emits `trigger_end{status:"error", error: <message>}` on caught throws and `trigger_end{status:"aborted", reason: <reason>}` on user-initiated abort/interrupt. **It does not — and cannot — emit a close marker on process-level crashes.** SIGKILL, OOM kill, container kill, host failure, V8 abort, segfault, and `process.exit()` from anywhere all skip userland code. A best-effort `SIGTERM` handler can capture the most common operational case (graceful Docker stop, k8s rolling restart) by appending `trigger_end{status:"aborted", reason:"shutdown"}` for any in-flight trigger before the process exits — pairs with the slice algorithm below as a safety net, not a guarantee.

### Slice algorithm (conflict-based termination)

The viewer's `readTriggerSlice(sessionId, triggerId)` finds the requested `trigger_start` and walks forward to the first of:

| Stop reason | Slice status |
|---|---|
| `trigger_end{triggerId=target}` reached | terminal — render with that record's `status` (`completed` / `error` / `aborted`) |
| Any other `trigger_start` (same session, different triggerId) reached | **`crashed`** — slice ends just before the new start. The new start is unambiguous proof the session moved on without closing this trigger; runner must have died after step 7 of the trigger flow |
| EOF reached | **`in_flight`** — no terminal marker, no superseder. Could be still running or could be a crashed-and-not-yet-superseded trigger. Viewer renders with auto-refresh; soft banner if last record is older than 5 min |

The viewer never time-bounds a slice into a "crashed" verdict on its own — that label requires hard data (a superseding `trigger_start`). Time staleness only soft-warns inside the in-flight render.

### Idempotency

A `trigger_start` with a `triggerId` already present in the session within the last hour is rejected by the writer (replay/retry safety).

## Alias Routing

Alias markers live in two places:

- Inside `/workspace/worklog/sessions/<session-id>.jsonl` for that session (audit trail; what aliases a session collected).
- In the global `/workspace/worklog/aliases.jsonl` (newest-wins resolution).

Initial alias types:

- `slack.thread_id` — Slack thread id → Thor session id.
- `git.branch` — base64url-encoded branch key → Thor session id.
- `session.parent` — child OpenCode session id → parent OpenCode session id. Written by the runner whenever it observes a new sub-session on the OpenCode event bus that was spawned by a session already running an active trigger. Lets `findActiveTrigger` chain-walk from a child session up to the parent that owns the open trigger, after the relation is recorded.

No `github.pr` alias type in this phase.

When a trigger creates a new session, the runner writes the alias to both locations as soon as enough context is known. Slack-triggered sessions write the incoming Slack thread id alias before any tool call; git branch aliases are added later from tool output; `session.parent` aliases are written from the runner's OpenCode event subscription as child sessions are discovered. Because child discovery is asynchronous, v1 treats child-session disclaimer support as fail-closed: if a child-session write reaches remote-cli before the parent relation is recorded, disclaimer injection fails with retry/delegate-to-parent guidance rather than shipping an untraceable artifact.

If a trigger experiences `session_stale` recreate (`packages/runner/src/index.ts:440`), the new session inherits the aliases of the old one. The runner writes a back-reference alias on the new session pointing to the old `sessionId` so old viewer links can chain-follow rather than 404.

## Trigger Viewer

The viewer is **Vouch-gated** (same OAuth proxy that fronts `/admin`), hosted by the runner service under a stable `/runner/*` ingress prefix, server-side rendered, and treated as an internal-tooling surface.

URL shape:

```text
/runner/v/<sessionId>/<triggerId>
/runner/v/<sessionId>/<triggerId>/raw
```

No HMAC. No TTL query params. UUIDv4 entropy on `sessionId` and `triggerId` (256 bits combined) is the access-control floor; Vouch is the access-control ceiling. Old links keep working — that is the audit story.

Ingress mapping (in `docker/ingress/nginx.conf`): `location /runner/ { ... }` proxies to the runner service. This single mount lets future runner-owned routes (admin tools, debug endpoints, etc.) ship without per-route ingress changes.

The runner reads `X-Vouch-User` from incoming requests on `/runner/*` (matches the existing `packages/admin/src/app.ts` pattern) and treats absence as 401.

### States

| Slice status (from `readTriggerSlice`) | Server response | UI |
|---|---|---|
| `completed` (terminal `trigger_end{status:"completed"}`) | 200 | Green "Completed" pill + hero + outcome card + collapsed timeline |
| `error` (terminal `trigger_end{status:"error"}`) | 200 | Red "Error" pill + `error` field + collapsed timeline |
| `aborted` (terminal `trigger_end{status:"aborted"}`) | 200 | Orange "Aborted" pill + `reason` if present + collapsed timeline |
| `crashed` (superseded by another `trigger_start` in same session) | 200 | Red "Crashed" pill + copy: "This trigger was abandoned without a close marker. The runner started a new trigger at <ts>; whatever was in-flight here was lost." |
| `in_flight` (no terminal record, no superseder, last event recent) | 200 | Yellow "Running" pill + last-event timestamp + `<meta http-equiv="refresh" content="5">` |
| `in_flight` + last event > 5 min old | 200 | Yellow "Running" pill + soft banner: "No new events in N min — the runner may have crashed without a close marker. Reload to check." |
| Empty (zero non-marker records between start and stop) | 200 | "No recorded events" empty state |
| Oversized slice | 200 | "Slice truncated" marker + raw link |
| Redacted fields present | 200 | Inline `[redacted: tool output, NN bytes]` markers |
| Unknown session/trigger | 404 | Branded 404 |
| Missing `X-Vouch-User` | 401 | Vouch redirects to OAuth |
| Backend failure (parse, FS error) | 503 | Branded retry copy |

### Information hierarchy

```
HERO
  "Thor opened PR #123 in 4m 12s"
  [✓ Completed]   2026-04-30 14:22 UTC
  Triggered by @user from #channel

OUTCOME
  • Created PR: scoutqa-dot-ai/thor#123 →
  • Edited 4 files

▾ TIMELINE   (collapsed by default)
  • Memory reads (3)
  • Tool calls (12)
  • OpenCode events (87)

▾ Show raw JSONL   →  /runner/v/<sid>/<tid>/raw

Generated by Thor.   Report an issue.
```

### Two-view model

- `/runner/v/<sid>/<tid>` — curated view (hero + outcome + collapsed timeline).
- `/runner/v/<sid>/<tid>/raw` — raw JSONL dump as `text/plain` for engineers.

### Redaction (allowlist, default-deny — kept for defense-in-depth)

Even with Vouch in front, the viewer applies allowlist redaction so that screenshots / copy-paste / log-share doesn't leak content the page itself shouldn't have rendered. Initial allowlist:

- `tool_call.tool` — always shown
- `tool_call.callId` — always shown
- `trigger_*.status` — always shown
- everything in `tool_call.payload` — **default-deny**, replaced with `[redacted: tool output, NN bytes]` until per-tool fields are added

Per-tool field rules ship iteratively in Phase 3 starting with safe metadata (status codes, durations) and never raw input/output bodies.

Base64-detection: any field matching `^[A-Za-z0-9+/=]{200,}$` is rendered as `<base64 hidden, NN bytes>` regardless of allowlist.

### Page chrome

- System font stack: `-apple-system, system-ui, sans-serif`.
- Reuse status-pill colors from `packages/admin/src/views.ts:69`.
- Mobile-first: single column at <600px; 16px base font; 44px tap targets for `<details>`.
- Semantic landmarks (`<main>`, `<header>`, `<section>`); `aria-live="polite"` for streaming.
- `<time datetime>` for timestamps; render relative ("4m ago") with absolute on hover via `Intl.DateTimeFormat`.
- Branded 401/404/503 pages.
- Footer: "Generated by Thor at <time>" + "Report an issue" mailto.

OG metadata is dropped — Vouch will redirect Slack-unfurl bots to the OAuth login page anyway, so unfurl previews aren't a use case.

### Operational guards

- Path validation: viewer `realpath`s the resolved session file path and asserts prefix `/workspace/worklog/sessions/` before opening.
- Per-file size cap (e.g. 50 MiB) — beyond that, viewer returns oversized state with a raw link only.

Rate-limiting and access logging are delegated to Vouch / ingress; the runner does not add its own limiter or audit stream on `/runner/*`.

No client-side framework is needed.

## Disclaimer Links

Thor-created content includes a disclaimer/viewer link for:

- Jira ticket creation (`createJiraIssue`) — approve-gated MCP tool
- Jira comment creation (`addCommentToJiraIssue`) — approve-gated MCP tool
- GitHub PR creation (`gh pr create`) — direct, not approve-gated
- GitHub PR comments and reviews (`gh pr comment`, `gh pr review`) — direct, not approve-gated
- GitHub PR review-comment replies (`gh api repos/{owner}/{repo}/pulls/<pr>/comments/<comment>/replies --method POST -f body=...`) — direct, not approve-gated

End-state rule: every Thor-authored content-creation surface gets a disclaimer link, except Slack messages (skipped to avoid noise). Surfaces without v1 injection support are denied rather than allowed to create disclaimer-less content. Confluence writes are denied entirely (removed from the approve list — see "Out of Scope"); GitHub issue creation/commenting (`gh issue create`, `gh issue comment`) is denied in v1 rather than expanded into the disclaimer injector.

The disclaimer URL is the plain Vouch-gated viewer path: `/runner/v/<sessionId>/<triggerId>`. No HMAC, no TTL.

**Both paths fail-fast.** Every Thor-created artifact must be traceable to a trigger; if `findActiveTrigger(sessionId)` cannot return exactly one open trigger, or if the per-tool args injector cannot find the expected field, the operation fails outright. The artifact does not ship without the disclaimer. Silent skips would let routing bugs (broken `session.parent` chain, runner crash mid-flight, schema drift on a Jira args shape) ship trivially-attributable artifacts as untraceable, which defeats the point of the disclaimer.

### Direct writes (GitHub `gh`)

Inline at execute time. The shell command runs through remote-cli with `x-thor-session-id` already in the request context.

1. remote-cli detects disclaimer-eligible commands: `gh pr create`, `gh pr comment`, `gh pr review`, and the explicit append-only `gh api repos/{owner}/{repo}/pulls/<pr>/comments/<comment>/replies --method POST -f body=...` shape.
2. Call `findActiveTrigger(requestSessionId)`, which performs a full bounded scan of the capped session log and walks any recorded `session.parent` chain. **Fail-fast** if `none` / `ambiguous` / `cycle` / `depth_exceeded` / `oversized`: the `gh` command exits non-zero with a clear error ("Disclaimer required: no single active trigger for session X — runner state may be broken"). No exec, no artifact.
3. Build the URL using the **owner** session id from the return value, not the request session id: `${RUNNER_BASE_URL}/runner/v/${result.sessionId}/${result.triggerId}`. For top-level requests these are equal; for child-session requests `result.sessionId` is the resolved parent (where the `trigger_start` actually lives, so the viewer can find it).
4. Rewrite the relevant body field:
   - `--body`/`-b` for PR/comment/review.
   - `-F <file>` / `--body-file <file>` for PR/comment paths by reading, mutating, and re-passing via stdin or a temp file.
   - `-f body=<text>` / `--raw-field body=<text>` for the allowed `gh api` PR review-comment reply path.
5. Exec `gh` with the mutated body.

**`gh pr create --fill` is denied at the policy layer.** `--fill` instructs `gh` to compose the PR body from local commit messages at exec time, leaving no body field for Thor to mutate. Allowing `--fill` would silently produce disclaimer-less PRs (worse than a 404 — undetected). The policy in `packages/remote-cli/src/policy-gh.ts` denies `--fill` unconditionally with guidance toward `--title <t> --body <b>`; `gh pr comment` and `gh pr review` have no analogous "fill from elsewhere" shape, so this is a `gh pr create`-specific restriction.

**`gh issue create` and `gh issue comment` are denied in v1.** They create GitHub-visible content, but issue artifacts are outside the intended PR/Jira launch scope. Implementing this plan must remove those shapes from the allowed GitHub policy surface, add deny tests in `packages/remote-cli/src/policy.test.ts`, and update `docker/opencode/config/skills/using-gh/SKILL.md` so the skill no longer documents them as allowed structured commands. Deny them with guidance to use Jira for tracked work or wait for a future issue-disclaimer injector. This keeps the end-state invariant true: all non-Slack Thor-authored content creation either gets a disclaimer link or is blocked.

No cache — each disclaimer-eligible exec does a fresh `findActiveTrigger` full bounded JSONL scan. The per-trigger volume of these calls is small (a handful), so the I/O is not load-bearing; cache/index complexity is not warranted.

### Approve-gated writes (Atlassian MCP)

The approval flow is async — humans review in Slack, can take minutes-to-hours. By execute time, the original trigger has long since written `trigger_end`, so inference at execute time would always return zero opens. Instead, **mutate args at approval-create time, while the trigger is still open and Thor context is in scope.**

At `packages/remote-cli/src/mcp-handler.ts:443`, before `approvalStore.create(toolInfo.name, args)`:

1. Call `findActiveTrigger(requestSessionId)` using the current request's session id. **Fail-fast** if `none` / `ambiguous` / `cycle` / `depth_exceeded` / `oversized`: return an error to the LLM ("Cannot create approval: no single active trigger for this session") and persist no action.
2. Build the URL using the **owner** session id from the return value: `${RUNNER_BASE_URL}/runner/v/${result.sessionId}/${result.triggerId}`. Approve-gated calls also originate from child sessions during sub-agent work, so the owner-vs-request distinction matters here too.
3. Mutate `args` per a small per-tool injector. **The injector throws if the expected field is missing on the args shape** — defense-in-depth against MCP schema drift or LLM passing the wrong field name. Throws bubble up as approval-create errors; no half-mutated action is persisted.

| Tool | Injection field | Strategy |
|---|---|---|
| `createJiraIssue` | `description` | Append `\n\n---\n[View Thor trigger](<url>)` to the description body. Throw if `args.description` is missing or non-string. |
| `addCommentToJiraIssue` | `commentBody` | Append the same footer to the comment body. Throw if `args.commentBody` is missing or non-string. |

4. Call `approvalStore.create(toolInfo.name, mutatedArgs)`. The persisted action carries the URL in `args` from the start.

Child-session limitation: before the runner records a `session.parent` alias, a child session is indistinguishable from any other session with no active trigger. In that case `findActiveTrigger` returns `none` and the write fails closed with the same no-active-trigger guidance. After `session.parent` is recorded, the helper can walk to the parent and build the disclaimer URL from the owner session id.

At resolve+execute time, `mcp-handler.ts:515` calls `executeUpstreamCall({ args: action.args, ... })` unchanged — the disclaimer is already in the args. No execute-time mutation, no schema changes to `ApprovalActionSchema`, no Thor context required at resolve time.

### Why mutate-at-create-time rather than persist-then-execute-mutate

- **Transparency for the human approver.** The Slack approval prompt shows the full description body the artifact will carry, including the disclaimer. The reviewer can verify the disclaimer is correct, sees what they are signing off on, and can reject if the disclaimer is missing or wrong.
- **Idempotent on retry.** Approve-resolve has 3 attempts (`packages/gateway/src/service.ts`); replays carry identical args, no risk of double-injection.
- **No schema migration.** `ApprovalActionSchema` (`packages/remote-cli/src/approval-store.ts:6`) stays unchanged.
- **Audit-clean.** The action record IS the bytes that got executed. No "the args said X but we sent X+disclaimer" footnote.

## Decision Log

| Date       | Decision                                                                            | Why                                                             |
| ---------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 2026-04-30 | Use `/workspace/worklog/sessions/<session-id>.jsonl` as the source of truth          | Flat session-keyed path; avoids symlink portability concerns and survives volume mount/backup/archival. |
| 2026-04-30 | Drop absolute symlink indexes; use `aliases.jsonl` newest-wins for alias lookup       | No symlink fragility; in-process cache rebuilt on miss is faster than today's grep-based scan. |
| 2026-04-30 | Do not add SQLite or another DB                                                     | Append-only JSONL + small in-memory cache is enough for v1. Revisit if alias scale becomes a problem. |
| 2026-04-30 | Do not propagate `triggerId` through OpenCode/bash/curl/remote-cli; recover via full bounded inference on disclaimer-eligible writes | No trusted per-trigger env channel exists between runner and OpenCode shell hooks; adding one requires a new shared mapping/plugin contract. Disclaimer-eligible writes are rare enough that scanning the capped session log is acceptable. |
| 2026-04-30 | Add `session.parent` alias type for child→parent session resolution                  | Lets inference walk from a child OpenCode session id up to the parent session that owns the open trigger after the relation is recorded. Reuses the alias mechanism rather than introducing a new state shape. Cycle-safe via depth cap (5) + visited-set; child writes before parent linkage fail closed. |
| 2026-04-30 | Write `trigger_start` only after any prior busy session has settled                  | Prevents prior-run events from entering the new trigger slice.   |
| 2026-04-30 | Abort timeout means no marker and no prompt                                          | Avoids ambiguous slices.                                         |
| 2026-04-30 | Drop the `trigger_aborted` record type; merge into `trigger_end{status:"aborted", reason?}` | One way to express "this trigger ended"; cleaner schema. The original separate type was a vestige of the (incorrect) plan that the runner could emit a marker on process crash. |
| 2026-04-30 | Trigger slices terminate on conflict, not on time                                      | A subsequent `trigger_start` for the same session is unambiguous proof the prior trigger was abandoned (runner restart, lost state). Time-based "stale" detection only soft-warns inside the still-in-flight render — never assigns a "crashed" verdict from the clock alone. |
| 2026-04-30 | Process-level crashes are not the runner's responsibility to mark                       | A `try/catch/finally` cannot run on SIGKILL / OOM / container kill / segfault. The plan no longer pretends it can. Best-effort SIGTERM handler covers graceful shutdowns; crashes are detected at viewer time via supersede. |
| 2026-04-30 | Initial alias types are `slack.thread_id`, `git.branch`, and `session.parent`        | Matches actual producers needed for routing and child→parent trigger attribution. |
| 2026-04-30 | Treat phases 2-4 as greenfield JSONL logging, not a flag-gated cutover               | This project can fail closed on event-log writes and route session aliases from JSONL directly; notes remain only for unrelated session continuity. |
| 2026-04-30 | Viewer is Vouch-gated under `/runner/*` ingress prefix; no HMAC, no TTL on the URL    | Reuses the existing OAuth proxy pattern (`packages/admin/src/app.ts`); UUIDv4 entropy + Vouch is the access-control model. Drops HMAC operational cost (secret mgmt, signature code, "Invalid signature" UX). Audit-friendly: links in old artifacts keep working. (CHANGED 2026-04-30 from earlier "HMAC-signed public viewer" decision.) |
| 2026-04-30 | Use `/runner/*` ingress prefix for runner-owned routes                                | Single ingress mount lets future runner routes ship without per-route ingress changes. Mirrors the existing `/admin/*` pattern. |
| 2026-04-30 | Redaction is allowlist (default-deny) on tool outputs                                | Defense-in-depth — Vouch fronts the route, but allowlist redaction keeps screenshots / copy-paste / log-share from leaking content the page itself shouldn't render. |
| 2026-04-30 | Confluence writes removed from the atlassian approve list (commit `a4d755ca` on this branch) | Reduces blast radius; the only approve-gated MCP tools that need disclaimer support are `createJiraIssue` and `addCommentToJiraIssue`. Re-introduce later if a real Confluence write use case lands. Tracked as part of this plan, not just deferred. |
| 2026-04-30 | Approve-gated writes (Atlassian MCP): mutate `args` at approval-create time           | Approval is async; by execute time the original trigger is closed and inference would return zero opens. Create-time mutation keeps Thor context in scope, lets the human approver see the disclaimer in the Slack prompt, and avoids `ApprovalActionSchema` changes. |
| 2026-04-30 | Both disclaimer paths fail-fast on missing/ambiguous active trigger                   | Every Thor-created artifact must be traceable to a trigger. Direct writes (`gh`) exit non-zero with no upstream call; approve-create returns an error and persists no action. Failing open would silently ship disclaimer-less artifacts and hide the underlying routing bug. |
| 2026-04-30 | Per-tool args injector throws on missing/wrong-typed field                            | Defense-in-depth against MCP schema drift or LLM passing the wrong field name. A throw bubbles to approval-create and persists no action; never a half-mutated record. |
| 2026-04-30 | No cache/index on the direct-write disclaimer path                                    | Per-trigger call volume is small (handful of disclaimer-eligible execs); full bounded JSONL scans are acceptable and avoid maintaining a second active-trigger source of truth. |
| 2026-04-30 | `findActiveTrigger` returns `{ sessionId, triggerId }` (owner pair, not request pair)  | The viewer reads `<sessionId>.jsonl` and looks for `trigger_start{triggerId}` there. For child-session requests, the `trigger_start` lives in the parent's session log, not the child's. Returning only `triggerId` and pairing it with the request sessionId would build URLs that 404 for every child-session-originated disclaimer. Returning the owner sessionId makes URL construction correct in both top-level and chain-walked cases. |
| 2026-04-30 | `gh pr create --fill` denied at the policy layer                                       | `--fill` lets `gh` compose the body from commit messages at exec time, leaving no field for the disclaimer injector to mutate. Without a deny, `--fill` would silently produce disclaimer-less PRs. Policy is the right layer (rather than the disclaimer injector) so the LLM gets the deny early with the existing `instead`-text guidance, avoiding a doomed `--fill` retry. Code change shipped alongside this plan revision in `packages/remote-cli/src/policy-gh.ts`. |
| 2026-04-30 | Direct writes (GitHub `gh`): inline injection at execute time                         | `gh` exec is synchronous within the runner-driven request; original Thor context is in scope. Inference + URL build + flag rewrite is straightforward; no approval store involvement. |
| 2026-04-30 | Include PR review-comment replies in disclaimer injection                             | The allowed append-only `gh api .../pulls/<pr>/comments/<comment>/replies --method POST -f body=...` shape creates GitHub-visible content. It must receive the same disclaimer footer as other PR content rather than becoming an untraceable carve-out. |
| 2026-04-30 | Deny `gh issue create` and `gh issue comment` in v1                                   | End-state rule is all non-Slack content creation gets a disclaimer link. GitHub issues are outside the PR/Jira launch scope, so deny them rather than shipping issue content without disclaimer injection. |
| 2026-04-30 | Cap one event record at < 4 KiB serialized; truncate and mark `_truncated`           | Avoids cross-process append interleave; mirrors `worklog.ts:18` truncation pattern. |
| 2026-04-30 | `triggerId` is UUIDv4 (≥128-bit random)                                              | Public viewer URL relies on it as an unguessable bearer.         |
| 2026-04-30 | Reuse `appendJsonlWorklog` (`packages/common/src/worklog.ts:123`) as the underlying writer | DRY; the existing primitive already handles day-partitioning and graceful failure. |
| 2026-04-30 | Single shared Zod schema in `@thor/common/event-log.ts`                              | Writer-reader schema gate; readers `safeParse` and skip-with-counter; forward-compat by ignoring unknown fields. |
| 2026-04-30 | Add Phase 6: retention/archival/janitor                                              | JSONL grows unbounded; viewer OOMs on large `readFileSync`; active-trigger inference becomes O(file). |
| 2026-04-30 | No per-hit audit log on `/runner/v/*`                                                  | Vouch / ingress already log auth events; an additional Thor-side audit stream is bookkeeping debt without a clear consumer. Add only if a real incident-response need surfaces. |
| 2026-04-30 | `findActiveTrigger` scans the full capped session log, not a tail window              | A long-running trigger can push its `trigger_start` outside a tail window before a late PR/Jira write. Full bounded scan preserves single-log source of truth without an active-trigger sidecar. |

## Phases

### Phase 1 - Common Event Log Primitives

Scope:

1. Add the shared Zod schema in `@thor/common/event-log.ts` (`SessionEventLogRecord`, `AliasRecord`). `AliasRecord.aliasType` is `"slack.thread_id" | "git.branch" | "session.parent"`.
2. Build typed helpers, layered on `appendJsonlWorklog` (`packages/common/src/worklog.ts:123`):
   - `appendSessionEvent(sessionId, record)` — single complete append, < 4 KiB cap with `_truncated` marker on overflow.
   - `appendAlias({ aliasType, aliasValue, sessionId })` — appends to global `aliases.jsonl`.
   - `readTriggerSlice(sessionId, triggerId)` — returns `{ records, status: "completed"|"error"|"aborted"|"crashed"|"in_flight", reason?, lastEventTs? }`. Termination is conflict-based (see "Trigger Slicing"): the slice ends at the first matching `trigger_end`, OR at any subsequent `trigger_start` for the same session (status = `crashed`), OR at EOF (status = `in_flight`). Tolerates malformed lines and discards partial trailing lines.
   - `findActiveTrigger(requestSessionId)` — full bounded scan of the capped session log; if no open trigger in this session, walk `session.parent` chain (depth ≤ 5, cycle-detected); returns `{ sessionId: <owner>, triggerId } | { reason: "none" | "ambiguous" | "depth_exceeded" | "cycle" | "oversized" }`. The returned `sessionId` is the **owner** — the session whose session log contains the open `trigger_start` record. For top-level sessions it equals `requestSessionId`; for child sessions it is the resolved parent. Callers must use this `sessionId` to build viewer URLs, not the request sessionId. A child before `session.parent` exists returns `none` and fails closed.
   - `resolveAlias({ aliasType, aliasValue })` — newest-wins lookup with in-process cache rebuilt on miss.
   - `listSessionAliases(sessionId)` — collects `alias` records from session log.
3. Reader behaviors: `safeParse` each line, skip-with-counter on failure, drop unknown fields, tolerate partial trailing line.
4. Unit tests for: append + 4KB truncation, slice extraction across all five statuses (`completed`, `error`, `aborted`, `crashed` via subsequent `trigger_start`, `in_flight` via EOF), malformed-line tolerance, partial-trailing discard, active-trigger lookup (zero/one/many in current session; late write where `trigger_start` is near the beginning of a large-but-capped file; oversized file fails closed; chain-walk to parent returns `{sessionId: parentId, triggerId}` not the child id; chain-walk depth 2-3 returns the topmost owner; depth-cap at 5; cycle detection; child before `session.parent` exists returns `none`), alias resolution (newest wins), session→aliases listing, schema-drift handling (unknown field ignored).
5. Concurrency tests: multi-process append fuzz (no corrupt lines); reader observing partial trailing line during writer activity.

Exit criteria:

- Records append to `/workspace/worklog/sessions/<session-id>.jsonl` with size cap enforced.
- `readTriggerSlice` returns the correct status for each of `completed`, `error`, `aborted`, `crashed` (subsequent `trigger_start` in same session), and `in_flight` (EOF). Malformed lines and partial trailing lines do not break extraction.
- Alias resolution is newest-wins; cache rebuild on miss is verified.
- `findActiveTrigger` scans the full capped log, finds old open starts that a tail window would miss, fails closed on oversized logs, and walks `session.parent` chain correctly; depth cap, cycle detection, and child-before-parent-alias returning `none` all have failing-then-passing tests.
- Multi-process append fuzz produces zero corrupt lines.

### Phase 2 - Runner Event Capture and Session Boundaries

Scope:

1. Generate `triggerId` (UUIDv4) for each accepted `/trigger`.
2. Always write accepted triggers to the JSONL session log; write failures fail the trigger before publishing downstream content.
3. Resolve correlated sessions via JSONL aliases (`resolveAlias`) with no notes-based routing fallback.
4. Advisory lock on the alias key during resolve+create to prevent same-`correlationKey` race.
5. Enforce busy-session rules:
   - non-interrupt busy returns busy with no marker
   - interrupt busy aborts and waits for settle
   - abort timeout returns busy/error with no marker and no prompt
6. Append `trigger_start` before `promptAsync`. Reject duplicate `triggerId` already present in the session within the last hour (idempotency).
7. Wrap the trigger handler in `try/catch/finally`. The `catch` emits `trigger_end{status:"error", error: <message>}`; the user-initiated abort/interrupt path emits `trigger_end{status:"aborted", reason: <reason>}`. **Process-level crashes are not handled here** — by design, a `try/catch` cannot run on SIGKILL/OOM/container-kill/segfault. Those leave the trigger open and are detected at viewer time via supersede.
8. Register a best-effort `SIGTERM` handler that, before exit, appends `trigger_end{status:"aborted", reason:"shutdown"}` for any in-flight trigger this process owns. Captures `docker stop`, k8s rolling restart, and similar graceful shutdowns. Does not capture SIGKILL/OOM/segfault.
9. Stream and append OpenCode events for parent and discovered child sessions. **When a new sub-session id appears on the event bus during an active trigger, append a `session.parent` alias record (`aliasValue=<child-id>`, `sessionId=<parent-id>`) to `aliases.jsonl`.** This is what lets `findActiveTrigger` chain-walk from a child session up to the parent's open trigger after discovery.
10. Append `trigger_end` on normal completion (`status:"completed"`).
11. Write the Slack thread alias immediately on Slack-triggered sessions.

Exit criteria:

- Every completed trigger has ordered start, event, and end records.
- Caught throws inside the trigger handler land as `trigger_end{status:"error"}`; user-initiated aborts land as `trigger_end{status:"aborted", reason}`.
- A simulated SIGTERM during a live trigger appends `trigger_end{status:"aborted", reason:"shutdown"}` before the process exits.
- A simulated SIGKILL during a live trigger leaves the trigger open in the log; a subsequent runner restart followed by a new trigger on the same session lets the viewer render the original slice with `crashed` status (verified via integration test).
- Busy and abort-timeout paths produce no marker (none for non-interrupt-busy; no trigger_start for abort-timeout).
- Same-correlationKey concurrent triggers do not double-create.
- Child-session activity appears inside the parent trigger slice; discovered child sessions get a `session.parent` alias. If a child tool call reaches remote-cli before the alias exists, disclaimer injection fails closed with retry/delegate-to-parent guidance.
- Gateway and runner routing use JSONL aliases only; markdown notes are not consulted for routing.

### Phase 3 - Trigger Viewer

Scope:

1. Add `GET /runner/v/:sessionId/:triggerId` and `GET /runner/v/:sessionId/:triggerId/raw` routes to the runner service. Routes read `X-Vouch-User`; absence → 401.
2. Update `docker/ingress/nginx.conf` with a `location /runner/ { ... }` block proxying to the runner service, behind the existing Vouch flow used for `/admin/`.
3. Server-side render HTML using the hierarchy in this plan (hero / outcome / collapsed timeline / raw toggle).
4. Implement the state matrix from "Trigger Viewer" above: `completed` / `error` / `aborted` (terminal); `crashed` (superseded); `in_flight` with `<meta refresh>` and a soft staleness banner if the last record is > 5 min old; empty / oversized / redacted variants; branded 401/404/503.
5. Implement redaction allowlist (default-deny on tool outputs); per-tool field rules ship iteratively starting with safe metadata.
6. Mobile-first CSS, semantic landmarks, `<time datetime>`, branded 401/404/503 pages.
7. Path validation: `realpath` + prefix-check on `/workspace/worklog/sessions/`.
8. Per-file size cap (50 MiB default); oversized state returns curated view + raw link only.

Exit criteria:

- Authenticated request renders the requested trigger slice with the correct status from `readTriggerSlice` (one of `completed` / `error` / `aborted` / `crashed` / `in_flight`).
- A trigger that was superseded by a later `trigger_start` for the same session renders with the red "Crashed" pill and abandonment copy — without any time threshold required.
- A trigger with no terminal record and no superseder renders as "Running" with `<meta refresh>`; the soft staleness banner appears only when the last record is older than 5 min.
- Missing `X-Vouch-User` returns 401 (Vouch handles the OAuth redirect upstream of the runner).
- Unknown session/trigger returns branded 404.
- Redaction default-deny is enforced (snapshot tests assert no raw tool output appears in HTML for non-allowlisted fields).
- Mobile snapshot at 375px viewport renders single-column with 16px base font.
- Ingress smoke test: an authenticated request to `/runner/v/<sid>/<tid>` reaches the runner; an unauth request gets the Vouch login redirect.

### Phase 4 - Alias Marker Producers

Scope:

1. Emit `slack.thread_id` aliases from inbound Slack trigger context and Slack write artifacts (both per-session log and global `aliases.jsonl`).
2. Emit `git.branch` aliases from existing git artifact detection.
3. Route inbound Slack and GitHub/git events through the JSONL alias resolver with raw-key fallback only; do not consult markdown notes for routing.
4. Tests cover: multiple aliases on one session; alias type isolation (same numeric value across types); newest-wins on alias move; back-reference chain after `session_stale` recreate.

Exit criteria:

- Slack thread replies route to the session with the matching `slack.thread_id` via JSONL.
- Git branch activity routes to the session with the matching `git.branch` via JSONL.
- A session holding both Slack and git aliases resolves correctly from either side.
- Recreated sessions chain-follow without 404.

### Phase 5 - Disclaimer Injection

Two paths share the same `findActiveTrigger(requestSessionId)` helper from `@thor/common/event-log.ts` (full bounded scan, then walks any recorded `session.parent` chain). The helper returns `{ sessionId, triggerId }` where `sessionId` is the resolved owner — the session whose session log contains the open `trigger_start`. Both paths build the URL `${RUNNER_BASE_URL}/runner/v/${result.sessionId}/${result.triggerId}` from the returned owner pair — no HMAC, no TTL. **Both fail-fast** if inference cannot return exactly one open trigger or if the per-tool args injector cannot find the expected field.

Prerequisites (already shipped on this branch as part of this plan):

- Commit `a4d755ca`: Confluence write tools removed from the approve list in `packages/common/src/proxies.ts`. Phase 5's per-tool injector covers only `createJiraIssue` and `addCommentToJiraIssue`.
- `gh pr create --fill` denied in `packages/remote-cli/src/policy-gh.ts` (companion commit). Removes the only `gh` shape that has no body field for the disclaimer injector to mutate. `using-gh` skill doc updated to match.

Additional Phase 5 policy change:

- Deny `gh issue create` and `gh issue comment`. They are content-creation surfaces, but v1 disclaimer injection targets PR/Jira artifacts only. Implementation must update all three surfaces together: remove/deny the issue command shapes in `packages/remote-cli/src/policy-gh.ts`, replace the existing allow assertions with deny assertions in `packages/remote-cli/src/policy.test.ts`, and remove/update the allowed-command documentation in `docker/opencode/config/skills/using-gh/SKILL.md`. Denial is required so the end-state invariant holds: all non-Slack content creation either receives a disclaimer link or is blocked.

#### Direct writes (GitHub `gh`) — inline at execute time

1. Extend remote-cli's `gh` exec path to detect disclaimer-eligible commands: `gh pr create`, `gh pr comment`, `gh pr review`, and the explicit `gh api repos/{owner}/{repo}/pulls/<pr>/comments/<comment>/replies --method POST -f body=...` review-comment reply shape.
2. For each, call `findActiveTrigger(sessionId)`. **Fail-fast** if `none`/`ambiguous`/`depth_exceeded`/`cycle`/`oversized`: the `gh` command exits non-zero with a clear error message; no upstream call.
3. Build the URL and rewrite the relevant body source (`--body`/`-b`, `-F`/`--body-file`, or the `gh api` raw field `body`) to append `\n\n---\n[View Thor trigger](<url>)`.
4. Exec `gh` with the mutated body.

No cache — each disclaimer-eligible exec does a fresh full bounded JSONL scan. The per-trigger call volume is small enough that I/O cost is irrelevant; cache/index complexity is not warranted.

#### Approve-gated writes (Atlassian MCP) — args mutation at create time

1. At `packages/remote-cli/src/mcp-handler.ts:443`, before `approvalStore.create(toolInfo.name, args)`:
   - Call `findActiveTrigger(sessionId)` using the current request's session id.
   - **Fail-fast** if zero/ambiguous/cycle/depth-exceeded: return an error to the caller. Do not persist a half-formed action.
   - Build the URL.
   - Mutate `args` per a small per-tool injector helper. **The injector throws if the expected field is missing or wrong-typed:**
     - `createJiraIssue` → append footer to `args.description`. Throw if missing/non-string.
     - `addCommentToJiraIssue` → append footer to `args.commentBody`. Throw if missing/non-string.
   - Throws propagate as approval-create errors; no half-mutated action is persisted.
2. Persist the mutated args into the approval action. The Slack approval prompt now shows the disclaimer the human is signing off on.
3. At resolve+execute time (`mcp-handler.ts:515`), no changes — `executeUpstreamCall` runs `action.args` verbatim, disclaimer included.
4. Skip Slack writes (no injection). Confluence writes are denied entirely (already removed from approve list).

Exit criteria:

- `gh pr create`/`gh pr comment`/`gh pr review` and the allowed `gh api` PR review-comment reply shape inject the disclaimer link inline when inference returns one open trigger; otherwise exit non-zero with a clear error and no upstream call.
- `gh issue create` and `gh issue comment` are denied at the policy layer, with guidance that issue content is outside v1 disclaimer-injection scope.
- `createJiraIssue` and `addCommentToJiraIssue` carry the disclaimer in `description` / `commentBody` from approval-create time. The Slack approval prompt shows the disclaimer.
- Approve-create with no/ambiguous active trigger or missing args field returns an error and persists no action.
- Child-session writes resolve via `session.parent` chain to the parent's open trigger after the relation is recorded AND inject a URL that uses the **parent** session id. A viewer GET with the injected URL renders the parent slice (which contains both parent and child events). If the relation is not yet recorded, the lookup returns `none` and the write fails closed.
- Tests cover: direct write with one open trigger (URL uses request sessionId, == owner); PR review-comment reply body mutation through `gh api`; late disclaimer write with `trigger_start` near the beginning of a large capped log; oversized log fail-fast; child session before `session.parent` exists (`none`, no exec/no action); child session 1-deep after `session.parent` exists (URL uses parent sessionId, not request); chain depth 2-3 (URL uses topmost owner); chain depth exceeded; cycle detection; ambiguous direct-write (`gh` exits non-zero, no exec); ambiguous approve-create (errors, no action persisted); per-tool injector throws on missing field; approve-resolve replays the same args (idempotent); end-to-end: a child-session-originated `gh pr create` after parent linkage produces a URL whose viewer GET returns 200 (not 404); policy denies `gh pr create --fill`, `gh issue create`, and `gh issue comment` (covered by `policy.test.ts`), and `using-gh` docs no longer list issue create/comment as allowed.

### Phase 6 - Retention, Archival, and Janitor

Scope:

1. Per-session size cap on `/workspace/worklog/sessions/<session-id>.jsonl` (e.g. 50 MiB). On exceed, rotate to `<session-id>-1.jsonl` (continuation file) and link the chain in a sidecar.
2. Retention sweeper (cron job or one-shot script) that, after a configurable age (default 30 days), compresses session files to `<session-id>.jsonl.gz` and after a longer age (default 90 days) removes them.
3. Symlink/tmp janitor — sweep stray `tmp.*` files left behind by partial alias writes (and any future symlink-based artifacts).
4. Aliases.jsonl rotation: when the file exceeds (e.g.) 100 MiB, snapshot the current state into `aliases-snapshot-<date>.jsonl` and start a fresh `aliases.jsonl`. Resolver reads snapshot + current.
5. Viewer behavior on archived sessions: gzipped session loads transparently; removed sessions return branded 410 ("This trigger has been archived").

Exit criteria:

- Bounded disk usage under continuous load (worst-case = retention-age × peak rate).
- Archived sessions still render in the viewer (gz transparent decode).
- Removed sessions return a clean 410 with explanation copy.
- Sweeper job has tests for retention boundary, gz round-trip, and dangling cleanup.

## Out of Scope

- SQLite or any database-backed index.
- Propagating `triggerId` through OpenCode/bash/curl/remote-cli — recovered via full bounded inference + recorded `session.parent` chain.
- New alias types beyond `slack.thread_id`, `git.branch`, and `session.parent` (no `github.pr` in this phase).
- Confluence write *features*. The three Confluence approve-gated tools (`createConfluencePage`, `createConfluenceFooterComment`, `createConfluenceInlineComment`) are removed from `packages/common/src/proxies.ts` as part of this plan (commit `a4d755ca` on this branch) and denied by default. Re-introducing them is out of scope.
- GitHub issue content creation in v1. `gh issue create` and `gh issue comment` are denied rather than injected. Re-introduce later only with explicit disclaimer support.
- Public unauthenticated viewer access — viewer is Vouch-gated; external Jira reporters who don't have OAuth cannot click into the disclaimer link. Acceptable trade for content-protection simplicity.
- HMAC-signed viewer URLs / TTL expiry — Vouch + UUIDv4 entropy is the access-control model.
- Rich client-side viewer UI.
- Slack disclaimer injection.
- Blocking raw Slack writes through mitmproxy.
- Per-tool field allowlist beyond a starter set (iterates after Phase 3 ships).
- Multi-replica runner support — current scope assumes single writer; revisit if/when scale-out becomes a need.

## Verification

Local verification:

- `@thor/common` tests for event log helpers (append, slice across all five statuses including `crashed`-via-supersede and `in_flight`-via-EOF, full bounded active-trigger scan including old starts near the beginning of a capped file and oversized fail-fast, alias resolution including `session.parent` chain-walk + cycle/depth caps + child-before-parent-alias returning `none`, schema drift, multi-process fuzz, partial trailing line).
- runner tests for marker order, busy behavior, interrupt behavior, abort timeout, caught-throw → `trigger_end{status:"error"}`, SIGTERM handler appends `trigger_end{status:"aborted", reason:"shutdown"}`, simulated SIGKILL leaves the trigger open and a follow-up trigger renders the prior slice as `crashed`, idempotent retry, same-correlationKey race, stale-session chain, `session.parent` alias write on child session discovery.
- resolver tests for Slack and git aliases (newest wins, back-reference chain, type isolation).
- viewer route tests for `completed` / `error` / `aborted` / `crashed` / `in_flight` rendering paths, soft staleness banner above 5 min, branded 401/404/503, mobile snapshot, two-view model, `X-Vouch-User` 401 path.
- remote-cli tests for direct-write disclaimer injection (`gh pr create` flag rewrite, `gh pr comment`, `gh pr review`, and PR review-comment reply via `gh api` raw `body` field); fail-fast on direct write when active trigger is missing/ambiguous/oversized (`gh` exits non-zero, no exec); policy denial for `gh pr create --fill`, `gh issue create`, and `gh issue comment`; approve-gated args mutation at create time (Jira ticket/comment); fail-fast approve-create on missing/ambiguous active trigger or missing child parent relation (which returns `none`; no action persisted); per-tool injector throws on missing/wrong-typed field (no action persisted); idempotent approve-resolve replay; **child-session URL correctness** — child-session-originated `gh pr create` and `createJiraIssue` after parent linkage produce URLs whose `<sessionId>` segment is the resolved parent (URL renders 200 in the viewer, not 404).
- ingress smoke test: `/runner/v/<sid>/<tid>` reaches the runner only with a valid Vouch session.
- retention/janitor tests for gz round-trip, retention boundaries, dangling cleanup, aliases.jsonl rotation.

Final verification follows the repository workflow: push the branch, wait for required GitHub checks, then open a PR.

Rollout posture:

- Ship JSONL session/event logging as the only implementation path.
- Verify viewer/disclaimer/alias paths against staging traffic before prod rollout.
- Keep markdown notes only for unrelated continuity summaries; do not use notes as routing fallback.
- Rollback requires reverting the feature change rather than toggling a runtime cutover switch.

---

## GSTACK REVIEW REPORT (auto-generated by /autoplan)

Branch: `session-log-links` | Commit at start: `6da9b56c` | Date: 2026-04-30
Mode: **SELECTIVE EXPANSION** (iteration on existing system, dual-voice review)
Codex available: yes | UI scope: yes (public viewer is a server-rendered page) | DX scope: no

> **Post-/autoplan amendments (2026-04-30):**
> - UC1 (propagate `x-thor-trigger-id`) was reversed. The plan body keeps `triggerId` runner-internal and recovers it at remote-cli via inference + a new `session.parent` alias type that lets inference chain-walk from a child OpenCode session id up to the parent that owns the open trigger.
> - UC2 (HMAC-signed public viewer URL) was reversed. The viewer is Vouch-gated under `/runner/*` instead. UUIDv4 entropy + Vouch is the access-control model. Drops HMAC operational cost (secret mgmt, signature code, Invalid-signature 403, Expired 410). Trade-off: external Jira reporters without OAuth cannot click the disclaimer link.
> - **Approve-gated disclaimer gap surfaced post-review.** Atlassian writes (`createJiraIssue`, `addCommentToJiraIssue`) go through the MCP approval store, which neither persists Thor identifiers nor receives them at resolve time. By execute time the original trigger has closed. Fix: mutate `args` at approval-create time (while context is in scope). **Both disclaimer paths fail-fast** if `findActiveTrigger` cannot return one open trigger or if the per-tool injector cannot find the expected field — the artifact never ships without a disclaimer. Documented in the Disclaimer Links section.
> - **Child-session URL bug surfaced post-review.** With the original `findActiveTrigger` return shape `{ triggerId }`, URL construction would have paired the request sessionId with the resolved triggerId. For child-session calls, the request sessionId is the child's id but the `trigger_start` lives in the parent's events.jsonl, so every disclaimer URL produced from a child session would 404. Fix: `findActiveTrigger` returns `{ sessionId: <owner>, triggerId }` and both disclaimer paths build URLs from the returned owner sessionId.
> - **`gh pr create --fill` gap surfaced post-review.** `--fill` lets `gh` compose the body from commit messages at exec time, leaving no body field for the disclaimer injector to mutate. The plan's injection flow only described `--body`/`-b`/`-F` rewrites, so `--fill` would silently produce disclaimer-less PRs. Fix: deny `--fill` at the policy layer (`packages/remote-cli/src/policy-gh.ts`) with guidance toward `--title <t> --body <b>`. `using-gh` skill doc updated to match.
> - **Confluence writes denied entirely.** `createConfluencePage`, `createConfluenceFooterComment`, `createConfluenceInlineComment` removed from the approve list in `packages/common/src/proxies.ts`. Out of scope until a real use case lands.
> - **Tail-read active-trigger inference rejected post-review.** A long-running trigger can push its `trigger_start` outside a tail window before a late PR/Jira write. Because the plan avoids an additional active-trigger index, `findActiveTrigger` now scans the full capped session log and fails closed on oversized files. Child-session writes also fail closed with `none` until the durable `session.parent` relation is recorded.
> - **All non-Slack content creation must be traceable.** The allowed `gh api` PR review-comment reply path is now included in direct disclaimer injection. `gh issue create` and `gh issue comment` are denied in v1 rather than allowed to create GitHub-visible content without a disclaimer. Combined with Confluence denial and Slack exclusion, every remaining content-creation path either gets the viewer link or is blocked.
> - UC3 (flat session file path) and UC4 (retention as Phase 6) stand. UC5 was superseded by the greenfield simplification: JSONL is unconditional and notes are not a routing fallback.
>
> The dual-voice findings below are preserved verbatim as the audit record of the review at the time.

### Phase 1 — CEO/Strategy Review

#### Step 0A. Premise Challenge

The plan's stated and implicit premises, with verdicts grounded in the codebase:

| # | Premise (stated or implicit) | Verdict | Evidence |
|---|---|---|---|
| P1 | Symlink support is enough; "Ubuntu/macOS, symlinks assumed" (line 76) | **WEAK** | `/workspace/worklog` is a Docker bind mount. Absolute symlink targets `/workspace/worklog/...` do not resolve outside the container. Volume rsync/backup tools may not preserve symlinks. Future archival creates dangling links. |
| P2 | One-line append per writer is enough concurrency control (line 39) | **WEAK** | No `O_APPEND` contract or per-line size cap stated. Posix guarantees atomic appends only ≤ `PIPE_BUF` (4KB). Long OpenCode events can exceed that and interleave. |
| P3 | Session-id is a stable bearer over time | **ACCEPTABLE WITH CAVEAT** | OpenCode session IDs are high-entropy. But `runner/src/index.ts:413-449` recreates a session on stale; old viewer links 404 silently. Should be documented behavior. |
| P4 | "Greenfield, no markdown-notes compatibility or migration" (line 16, 163) | **SUPERSEDED** | JSONL now owns session/event routing unconditionally. Notes helpers remain only for unrelated continuity summaries and are not a routing fallback. |
| P5 | Don't propagate `triggerId` through OpenCode/bash/curl/remote-cli (line 79–80, decision-log) | **WRONG** | The wrapper at `packages/opencode-cli/src/remote-cli.ts:27` already propagates `x-thor-session-id` and `x-thor-call-id`. Adding `x-thor-trigger-id` is one line and removes the entire "exactly one active trigger" inference, which is the failure mode flagged below. |
| P6 | "Conservative output limits and basic redaction" (line 127) is sufficient for public ingress | **WRONG** | Slices contain Slack thread content, Jira bodies, MCP tool outputs (Atlassian queries, Metabase SQL with schema names), repo names, error stack traces with env-var names, memory file contents. Public bearer-pair link → search engine indexable, copy-paste leakable. |
| P7 | "Exactly one active trigger" inference (line 144) covers the disclaimer injection cases | **WRONG** | Plan's own scope (Phase 2) lists child sessions, retries, mention-interrupt, and parallel triggers. The "log and skip" fallback drops disclaimers in exactly the busy-session cases the feature is meant to cover. Solved by P5. |
| P8 | Existing JSONL primitive cannot serve this need | **PARTIALLY WRONG** | `packages/common/src/worklog.ts:123` exports `appendJsonlWorklog` for day-partitioned streams. The plan does not reference it or explain why it is insufficient. At minimum, the rationale belongs in the decision log; better, extend it. |
| P9 | "Out of scope: retention, archival, pruning" (line 268) is acceptable for v1 | **WRONG-AGES-WORST** | One large trigger logs hundreds of MB. JSONL grows unbounded. Six months: `worklog/` is the largest thing on disk and viewer route OOMs on `readFileSync`. |

#### Step 0B. Existing Code Leverage

Sub-problems mapped to existing code:

| Sub-problem | Existing code | Reuse plan |
|---|---|---|
| Append JSONL line | `packages/common/src/worklog.ts:123` (`appendJsonlWorklog`) | Extend with session-keyed variant; keep day-partitioning as a write-time decision, not a path requirement. |
| Day-partitioned worklog dir | `packages/common/src/worklog.ts:129` (`getWorklogDir() / yyyy-mm-dd`) | Reuse the helper. |
| Atomic write pattern | `packages/admin/src/app.ts:68-74` (custom `atomicWrite` for renames) | Promote to `@thor/common`; reuse for symlink-or-flat-file writes. |
| Slack thread alias extraction | `packages/common/src/notes.ts` (`extractAliases`, `computeSlackAlias`, `computeGitAlias`) | Reuse the alias extractors as-is; only the storage layer changes. |
| Trigger header propagation | `packages/opencode-cli/src/remote-cli.ts:27` already passes `x-thor-session-id`, `x-thor-call-id` | Add `x-thor-trigger-id` here (one line). Per P5 verdict. |
| OpenCode event subscription | `packages/runner/src/event-bus.ts` (`DirectoryEventBus`) | No change; tap the existing dispatcher to fan events into the new event log. |
| Remote-cli session-id read | `packages/remote-cli/src/index.ts:90-97` (`thorIds`) | Add `triggerId` to the same helper. |

#### Step 0C. Dream State

```
CURRENT STATE                    THIS PLAN                        12-MONTH IDEAL
─────────────────                ──────────                       ──────────────────
Markdown notes for          ──▶  JSONL + symlink indexes,    ──▶  Single durable session
session routing.                 day-partitioned, public           store with retention,
Per-session memory in            unauthed viewer, disclaimer       signed viewer URLs,
markdown. No structured          inference fallback.               structured replay,
event replay. Disclaimer                                           explicit triggerId
links not produced.                                                propagation, redaction
                                                                   allowlist, audit log.
```

Delta this plan ships toward the ideal: structured event log, alias routing, viewer surface. **Misses** that hurt trajectory: no retention story, public-by-default viewer, inference instead of header propagation.

#### Step 0C-bis. Implementation Alternatives

**APPROACH A — Plan as written (symlink indexes + inference)**
- Summary: Day-partitioned `events.jsonl` per session; absolute symlink indexes for `sessions/<id>` and `aliases/<type>/<key>`; `triggerId` not propagated, inferred at remote-cli.
- Effort: M (5 phases as described). Human ~5 days / CC ~3 hours.
- Risk: **High**. Symlink portability, public viewer leakage, inference ambiguity in busy sessions, hard cutover from notes.
- Reuses: ad-hoc; does not leverage `appendJsonlWorklog`.
- Pros: Conceptually simple data model. No DB. Works on dev laptops out of the box.
- Cons: P1, P2, P5, P6, P7, P9 above.
- Completeness: 6/10 (functionality covered; foundation gaps surface within 6 months).

**APPROACH B — Header propagation + flat session file + signed URLs (recommended)**
- Summary: Flat `/workspace/worklog/sessions/<session-id>.jsonl` (no symlink indexes). Propagate `x-thor-trigger-id` via `packages/opencode-cli/src/remote-cli.ts` (one line). Viewer link is HMAC-signed with TTL; redaction is allowlist; alias routing reads JSONL directly via a small in-process cache rebuilt on first miss.
- Effort: M-L. Human ~6 days / CC ~3.5 hours.
- Risk: **Medium**. Single-day archive job is the only ops piece deferred. Cache rebuild on first miss is well-understood.
- Reuses: `appendJsonlWorklog` (extend), `notes.ts` alias extractors, `opencode-cli` header pipe, admin `atomicWrite`.
- Pros: No symlink portability concerns. Disclaimer injection deterministic. Public viewer is signed (link leak ≠ content leak). Retention is just `find -mtime`.
- Cons: HMAC signing key needs to be managed. Cache rebuild on first miss adds ~50ms cold-start latency.
- Completeness: 9/10.

**APPROACH C — SQLite-backed index (rejected by plan, worth reconsidering)**
- Summary: SQLite for session→aliases→trigger lookup. JSONL still primary log. Schema: `sessions`, `aliases`, `triggers`. ~50 LOC of `INSERT INTO`.
- Effort: L. Human ~7 days / CC ~4 hours.
- Risk: **Low** for the storage layer; **Medium** for adding a new dependency.
- Reuses: same as B, plus better-sqlite3 (already a common dependency).
- Pros: Atomic alias swaps come free. Retention queries are one SQL line. Indexable lookups beat directory scans at scale.
- Cons: Adds a dependency the plan explicitly rejected. Schema migration becomes part of deploy.
- Completeness: 10/10.

**RECOMMENDATION: Approach B.** It addresses every premise verdict above with the smallest delta from the plan's intent, and 80% of the work is one-line changes (`x-thor-trigger-id`, flat file path, HMAC). Approach A ships faster but ages worst. Approach C is correct but introduces a dependency the plan owners explicitly want to avoid.

#### Step 0.5 — Dual Voices Consensus Table

Run #1: Claude CEO subagent (independent, no prior context). Run #2: Codex (`gpt-5.4`, read-only, web search enabled).

```
CEO DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════
  Dimension                                   Claude   Codex   Consensus
  ──────────────────────────────────────────  ─────── ──────── ───────────
  1. Premises valid?                          NO       NO       CONFIRMED — premises P4, P5, P6, P7, P9 fail
  2. Right problem to solve?                  PARTIAL  PARTIAL  CONFIRMED — viewer should be curated, not raw
  3. Scope calibration correct?               NO       NO       CONFIRMED — public viewer should be split into render+expose
  4. Alternatives sufficiently explored?      NO       NO       CONFIRMED — header propagation, signed URL, flat file
  5. Competitive/leakage risks covered?       NO       NO       CONFIRMED — public bearer-pair + raw output is unsafe
  6. 6-month trajectory sound?                NO       NO       CONFIRMED — no retention, dangling symlinks, growing JSONL
═══════════════════════════════════════════════════════════════
```

All six dimensions show CONFIRMED disagreement with the plan. This is unusual — both voices agree the foundation needs rework before phases 2–5 ship. These bubble up as **User Challenges** at the Phase 4 final gate.

#### Step 0D. Mode-Specific Analysis (SELECTIVE EXPANSION)

Complexity check: plan touches `@thor/common`, `runner`, `remote-cli`, `admin`/ingress, plus tests across all four. ~12-15 files. **Just past the smell threshold (8 files)**, but the breadth is justified by the cross-cutting nature (shared event log).

Minimum viable subset (if HOLD-SCOPE-style triage): Phase 1 (event log helpers) + Phase 2 (runner emission) + Phase 4 (alias routing) is a complete internal feature. Phase 3 (public viewer) and Phase 5 (disclaimer injection) are downstream consumers; they can ship after the foundation is exercised internally. Splitting them out reduces deploy risk window dramatically.

Cherry-pick candidates surfaced by the dual voices (presented as Phase 4 User Challenges, not auto-added):

| # | Cherry-pick | Effort | Recommend |
|---|---|---|---|
| C1 | Propagate `x-thor-trigger-id` header (replaces inference) | XS (1 line + tests) | **ACCEPT** |
| C2 | Flat session file path; drop absolute symlink indexes | S (path layout change in Phase 1) | **ACCEPT** |
| C3 | HMAC-signed viewer URL with TTL | S | **ACCEPT** |
| C4 | Redaction allowlist (default-deny tool outputs) | M | **ACCEPT** |
| C5 | Per-file size cap + rotation in Phase 1 | S | **ACCEPT** |
| C6 | Curated default viewer ("what Thor did") with raw events behind toggle | M | DEFER to follow-up |
| C7 | Document stale-session behavior: old viewer links 404 by design | XS | **ACCEPT** |
| C8 | Extend `appendJsonlWorklog` rather than build parallel writer | XS | **ACCEPT** |
| C9 | Audit log for viewer hits (request-id, ip, ua, sessionId, triggerId) | S | **ACCEPT** |

#### Step 0E. Temporal Interrogation

```
HOUR 1 (foundations):  How do `index/sessions/<id>` symlinks survive container restart?
                        Are paths absolute (plan says yes) or relative (recommended)?
                        What's the directory mode/perm on `index/`? Worker UID writes — viewer reads.
HOUR 2-3 (core logic):  What's the contract for "one complete append per line"?
                        Max line size? Larger → split into multiple `opencode_event` records?
                        Is `appendFileSync` synchronous enough or do we need `O_APPEND` flag explicitly?
HOUR 4-5 (integration): Where exactly is `trigger_start` appended in runner?
                        Before or after promptAsync's first event hits the bus?
                        How do we test the abort+settle window without a real OpenCode?
HOUR 6+ (polish/tests): What's a "trigger slice" when there's a child session inside? Same file or
                        cross-references? When the viewer hits 100MB, what's the failure mode?
```

#### Step 0F. Mode Selection

Auto-decided per autoplan rules: **SELECTIVE EXPANSION**. Greenfield expansion would be wrong — the plan already has scope. Hold-scope would miss the dual-voice findings. Reduction is too aggressive.

#### Step 1. Architecture Review

```
                    ┌─────────────────────────┐
                    │  Inbound triggers        │
                    │  (Slack, GitHub, cron)   │
                    └─────────────┬───────────┘
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │  runner /trigger          │
                    │  - busy/abort logic       │
                    │  - generate triggerId     │
                    │  - append trigger_start   │   <── NEW
                    │  - resolve session via    │
                    │    JSONL alias index      │   <── NEW
                    └────┬───────────────┬──────┘
                         │               │
                ┌────────▼───────┐   ┌───▼────────────┐
                │ OpenCode SDK   │   │ session events │
                │ (existing)     │   │ JSONL writer    │   <── NEW
                └────────┬───────┘   └────────┬───────┘
                         │ events             │ append
                         ▼                    ▼
                ┌──────────────────┐  ┌──────────────────────┐
                │ event-bus        │  │ /workspace/worklog/  │
                │ (existing)       │─▶│ <day>/<sid>/events.  │
                └──────────────────┘  │ jsonl                 │
                                      │ + index/* symlinks   │
                                      └──────────┬───────────┘
                                                 │
                       ┌─────────────────────────┴──────────────────┐
                       │                                            │
                       ▼                                            ▼
            ┌────────────────────┐                      ┌────────────────────┐
            │ Public viewer      │                      │ remote-cli          │
            │ /v/<sid>/<tid>      │  (NEW + UI scope)    │ active-trigger      │
            │ unauth ingress     │                      │ inference            │
            └────────────────────┘                      │ disclaimer injection │
                                                        └────────────────────┘
```

Architecture findings:
- **Coupling**: viewer reads `events.jsonl` directly. If the writer's line format ever changes mid-trigger, the reader breaks. Need explicit reader contract: drop unknown fields, render best-effort, handle malformed lines.
- **Single point of failure**: every Thor-created GitHub/Jira write goes through remote-cli's inference. If inference is wrong, the disclaimer is wrong. P5 fix removes this.
- **Scaling**: at 100x trigger rate, alias symlink rename-over rate becomes a bottleneck (rename is fast but not free). Linear scan of one events.jsonl for active trigger is fine until file >50MB. Cap at Phase 1.
- **Rollback**: revert the feature change; there is no runtime cutover switch or notes-based routing fallback.

#### Sections 2–10 (auto-decided)

**Section 2 — Error & Rescue Map.** New failure modes:
- `events.jsonl` write fails (disk full, FS error) → today: append helpers in `worklog.ts` log to stderr and continue. New helpers should match. ACTION: do not let event log failures crash trigger handling.
- Symlink rename fails (race with another trigger swapping same alias) → fall back to `unlink + symlink` second try; if still fails, log and continue without the index update.
- Active-trigger inference returns >1 → log + skip (plan); P5 cherry-pick removes this case entirely.
- Viewer reads a partially-written trailing line → discard last line if no trailing newline, render rest.
- Session-stale recreate replaces session id → old viewer link 404s; document this.

**Section 3 — Security & Threat Model.**
| Threat | Likelihood | Impact | Mitigated? |
|---|---|---|---|
| Public link leakage (copy-paste, indexing) | High | High | NO — bearer-pair only |
| Direct object reference (guess sessionId+triggerId) | Low | High | Partial — high entropy IDs |
| Tool output exfil (Slack content, Jira bodies, MCP results) | High | High | NO — "basic redaction" undefined |
| Stack trace leakage with env-var names | Medium | Medium | NO |
| Symlink traversal in `<thread-id>` filename | Medium | Medium | YES — plan validates `[0-9.]+` |
| Symlink traversal in encoded git branch | Medium | Medium | YES — base64url normalizes |
| Viewer rate-limit DoS | Medium | Low | NO — not addressed |
| Audit gap (who viewed what) | High | Low | NO |

Critical mitigations to add: HMAC-signed URL with TTL; redaction allowlist (deny by default); rate limit on `/v/*`; access log per hit. All in C3/C4/C9.

**Section 4 — Data Flow Edge Cases.** Trigger slice is the data flow.
- Empty session log (just-created): `trigger_start` not written yet → viewer 404 (plan says so). OK.
- Crashed mid-trigger (no `trigger_end`): plan slices to next start or EOF, marks incomplete. OK.
- Two `trigger_start` for same triggerId (replay/retry): plan does not address. ACTION: writer must reject duplicate `triggerId` in same session.
- Out-of-order events (event-bus delivers an event after `trigger_end`): record but the viewer should still slice up to `trigger_end`. OK with current spec.
- Alias collision (two sessions claim same Slack thread): newest symlink wins per plan. OK and matches notes.ts behavior.

**Section 5 — Code Quality.**
- DRY: `appendJsonlWorklog` already exists; new writer should extend or wrap, not duplicate. Plan does not call this out.
- Naming: `triggerId` vs `trigger_id` consistency — pick one (camelCase in TS, snake in JSONL field names is fine, but be explicit).
- The `correlationKey` field in `trigger_start` partially overlaps with `aliasValue` records. Consider whether it can be derived from the first alias instead.

**Section 6 — Test Review.**

NEW UX FLOWS:
- Public viewer rendering valid slice, missing slice, oversized slice, partially-written slice
- Disclaimer link appearing in GitHub PR body, Jira ticket, GitHub comment, Jira comment

NEW DATA FLOWS:
- Trigger context → event log writer → JSONL append (happy, full disk, EAGAIN)
- Slack inbound → alias write → session resolve via JSONL
- Git-detected branch → alias write → session resolve via JSONL

NEW CODEPATHS:
- Symlink atomic create-rename
- Active-trigger inference (>1 / 0 / exactly 1)
- Trigger slice extraction (start→end, start→EOF, malformed line)

NEW BACKGROUND JOBS / ASYNC:
- None added by plan; retention deferred (and that's a problem).

NEW INTEGRATIONS:
- None new; reuses OpenCode event bus.

NEW ERROR/RESCUE PATHS: see Section 2 above.

Test plan artifact: `~/.gstack/projects/scoutqa-dot-ai-thor/session-log-links-test-plan-20260430.md` (to be written in Phase 3).

For LLM/prompt changes: none — this is infrastructure.

**Section 7 — Performance.**
- Linear `events.jsonl` scan in viewer route: fine until ~50MB per file. Cap with size limit + early-exit.
- Symlink resolution: O(1) per lookup. No concern.
- Alias-to-session lookup via symlink read: faster than today's grep-based scan in `notes.ts` (which scans every notes file). **Net win** vs current implementation.
- Active-trigger inference reads tail of `events.jsonl`: fine if size capped; tail-read pattern (read last N KB and parse forward) is the correct shape.

**Section 8 — Observability.**
- Logging: every append failure → stderr (matches `worklog.ts` pattern). Append success: silent (high volume).
- Metrics: counter for `event_log.appends_total{type}`, `event_log.bytes_total`, `viewer.hits_total{status}`. Plan adds none. ACTION: add at least counters.
- Alerting: viewer 5xx rate; event log write error rate.
- Dashboards: none needed; log explorer suffices for v1.
- Debuggability: structured per-trigger slices are themselves the debug aid. Score 9/10.

**Section 9 — Deployment & Rollout.**
- Plan uses unconditional JSONL logging; no runtime cutover switch.
- Migration risk window is avoided by not dual-writing for routing.
- Rollback requires reverting the feature change; markdown notes remain readable for continuity only.
- Environment parity: dev, staging, prod all have same `/workspace/worklog` mount semantics. Verify in staging.
- First 5 minutes after deploy: monitor viewer 5xx, event log write error rate, runner trigger latency.

**Section 10 — Long-Term Trajectory.**
- Tech debt: P9 (no retention) is debt that compounds linearly with time.
- Path dependency: if symlinks ship and break, migrating to flat-file is a one-time data migration (read symlink → resolve → rewrite path map). Not catastrophic, but real work.
- Reversibility: 3/5. Schema is durable, format is JSONL, but symlink layout is the part that could need migration.
- Ecosystem fit: append-only JSONL + grep is the established pattern in this repo. Plan fits.
- 1-year question: a new engineer can read `events.jsonl` directly and understand most things. Score 8/10.

**Section 11 — Design & UX (UI scope).**

Public viewer is the only UI surface. Plan describes intent but not specifics. Hand-off to Phase 2 of /autoplan (design review).

#### Phase 1 Output Summary

**Mode:** SELECTIVE EXPANSION
**Premises:** 5 of 9 challenged (P4, P5, P6, P7, P9). Plan needs foundation fixes.
**Cherry-picks recommended:** C1, C2, C3, C4, C5, C7, C8, C9 (defer C6 to follow-up).
**Critical findings (Phase 4 user challenges):** all 5 challenged premises bubble up as User Challenges in the final approval gate.
**Required ASCII diagrams:** delivered (architecture above).
**Test plan artifact:** to be written in Phase 3 of /autoplan.

#### NOT in scope (Phase 1 deferral list)

- C6 (curated viewer with raw-toggle): defer to follow-up after foundation lands.
- Migration tooling for existing notes.ts artifacts: out of scope; plan states "no migration" — accepting that, but it must be treated as cutover, not greenfield.
- SQLite migration: deferred per Approach B selection.

#### What already exists

- JSONL append helper: `packages/common/src/worklog.ts:123` (`appendJsonlWorklog`).
- Day-partitioned worklog dir: `packages/common/src/worklog.ts:129`.
- Atomic file write pattern: `packages/admin/src/app.ts:68-74`.
- Alias extraction: `packages/common/src/notes.ts` (`extractAliases`, `computeSlackAlias`, `computeGitAlias`).
- Trigger header pipe: `packages/opencode-cli/src/remote-cli.ts:27` (already passes `x-thor-session-id`, `x-thor-call-id`).
- OpenCode event bus: `packages/runner/src/event-bus.ts` (`DirectoryEventBus`).
- Remote-cli session-id read: `packages/remote-cli/src/index.ts:90-97` (`thorIds`).

---

### Phase 2 — Design Review

UI scope: Public Trigger Viewer at `/v/<sessionId>/<triggerId>`. Server-rendered, no client framework, exposed via ingress. Plan currently treats this as a JSONL renderer; both design voices flag it as a brand surface.

#### Step 0 — Design Scope Assessment

- Initial completeness: **3/10**. Plan's UI section is 13 lines. Phase 3 scope is 15 lines. No wireframe, no copy, no state matrix, no responsive strategy, no a11y specifics.
- DESIGN.md: not present in repo.
- Existing leverage: `packages/admin/src/views.ts:69` (121 lines — system font stack, htmx, status pills, CodeMirror). `docker/ingress/static/` (favicon, social-share.png).
- Focus areas: hierarchy, states, brand framing, mobile, redaction presentation.

#### Dual Voices Consensus Table

```
DESIGN DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════
  Dimension                                   Claude   Codex   Consensus
  ──────────────────────────────────────────  ─────── ──────── ───────────
  1. Information hierarchy serves user?       NO       NO       CONFIRMED — debug-first, not user-first
  2. Interaction states fully specified?      NO       NO       CONFIRMED — 3 of 6 specified
  3. User journey designed?                   NO       NO       CONFIRMED — Slack-mobile reporter unconsidered
  4. AI slop risk low?                        NO       NO       CONFIRMED — 9-line UI spec for public surface
  5. Responsive intent?                       NO       NO       CONFIRMED — mobile not mentioned
  6. Accessibility addressed?                 NO       NO       CONFIRMED — WCAG/a11y not mentioned
  7. Brand surface vs debug log?              NO       NO       CONFIRMED — public URL treated as debug log
═══════════════════════════════════════════════════════════════
```

7/7 confirmed. Both voices independently produced the same critique: the public viewer needs a Public Viewer Design Spec subsection before Phase 3 ships.

#### Pass 1 — Information Architecture

Plan's flat list (line 121–123): trigger metadata, status, events, tool calls, memory reads, delegate/task events. Implicit equal weight.

Recommended (consensus across both voices):
```
┌──────────────────────────────────────────────────┐
│  HERO                                              │
│  "Thor opened PR #123 in 4m 12s"                   │
│  [✓ Completed]   2026-04-30 14:22 UTC             │
│  Triggered by @user from #channel                  │
├──────────────────────────────────────────────────┤
│  OUTCOME                                           │
│  • Created PR: scoutqa-dot-ai/thor#123 →           │
│  • Edited 4 files                                  │
├──────────────────────────────────────────────────┤
│  ▾ TIMELINE   (collapsed by default)               │
│    • Memory reads (3)                              │
│    • Tool calls (12)                               │
│    • OpenCode events (87)                          │
├──────────────────────────────────────────────────┤
│  ▾ Show raw JSONL                                  │
│  Generated by Thor.   Report an issue.             │
└──────────────────────────────────────────────────┘
```

#### Pass 2 — Interaction State Coverage

| State | Plan specifies? | Required behavior |
|---|---|---|
| Loading | NO | Server-render is sync; need a 2s read budget; if exceeded, return cached "loading" placeholder with auto-refresh meta tag |
| Empty (zero events) | NO | "This trigger has no recorded events. It may have been a no-op." |
| Error (events.jsonl unreachable / parse failure) | NO | Branded 503 with retry copy |
| Incomplete (no trigger_end) | YES | Banner: "This trigger did not complete cleanly." |
| Partial / streaming (active) | NO (conflated with incomplete) | Yellow "Running" pill + last-event timestamp + `<meta refresh="5">`; remove on completion |
| Oversized (slice exceeds output limit) | YES (loose) | "Slice truncated for display. View full raw events." |
| Redacted (allowlist) | NO | "[redacted: tool output, 4.2KB]" inline marker |
| Invalid signature (HMAC fails) | NEW (per Phase 1 cherry-pick) | Branded 403 |
| Expired link | NEW | Branded 410 with refresh-instruction |

#### Pass 3 — User Journey & Emotional Arc

The reporter clicks a Slack/Jira disclaimer link from mobile. Current plan first-paint = JSONL dump → confusion → fear → bounce → brand damage.

Required arc: **Status pill → one-line summary → outcome card → trust** in 5 seconds. Raw events are below the fold for engineers who scroll.

#### Pass 4 — AI Slop Risk

**Critical**. 9-line UI spec for the most-public Thor surface. Implementer reaches for "render JSONL into `<pre>`" and the result looks like a debug log. The internal admin page got 121 lines of crafted CSS for an auth-gated audience; the public viewer got 13.

#### Pass 5 — Design System Alignment

No DESIGN.md exists. Reuse the admin pattern (`packages/admin/src/views.ts:69`):
- System font stack: `-apple-system, system-ui, sans-serif`.
- Status pill colors: green `#e7f5e7` / `#1a5a1a` (passes WCAG 4.5:1).
- Max-width 960px.
- No client-side framework (already plan policy).

Diverge from admin: it's an SSR debug page; the public viewer needs a hero zone, OG metadata, and a 404/410/403 branded page chrome that admin doesn't need.

#### Pass 6 — Responsive & Accessibility

Mobile-first additions required:
- Single column at <600px; 16px base font; 44px tap targets for `<details>`.
- `overflow-x: auto` on inner `<pre>` (not the page).
- Semantic landmarks: `<main>`, `<header>`, `<section>`.
- `aria-live="polite"` for streaming state.
- `<time datetime>` elements for all timestamps; render in viewer's local TZ via `Intl.DateTimeFormat`.
- Skip-to-content link.
- Color-contrast 4.5:1 minimum.

#### Pass 7 — Unresolved Design Decisions

| Decision | Plan says | Recommendation |
|---|---|---|
| Tool calls expanded by default | nothing | Collapsed; first 80 chars of payload as preview |
| Tool call payload truncation | "conservative output limits" | Per-record cap 8KB display; allowlisted fields only |
| Syntax highlighting | nothing | None — plain monospace `<pre>` |
| Base64 payloads | nothing | Detect `^[A-Za-z0-9+/=]{200,}$`; render `<base64 hidden, 4.2KB>` |
| Memory reads — full or truncated | nothing | First 200 chars + "Show full" toggle (default-deny) |
| Timestamps | nothing | Relative ("4m ago") with absolute on hover |
| Auto-refresh while running | nothing | `<meta http-equiv="refresh" content="5">` only on running state |
| Unknown event type | nothing | Generic `<details>` with `type` and JSON body |
| Failed-parse line | "malformed-line tolerance" | Skip silently; surface count in footer |
| OG metadata | nothing | Set `og:title`, `og:description`, `og:image=/social-share.png` |
| Two views, one URL | conflates curated + raw | `/v/<sid>/<tid>` curated; `/v/<sid>/<tid>/raw` JSONL dump |

#### Phase 2 Output Summary

- Dimensions: **0/7 pass**, all fail without spec additions.
- Critical fix: add a **Public Viewer Design Spec** subsection at line 128, ~80–100 lines, covering wireframe, copy, state matrix, responsive, a11y, OG metadata, and the two-view model. Without this, Phase 3's exit criteria ship a debug log with CSS.
- This bubbles up to Phase 4 as a User Challenge (the plan as written does not produce the design surface its consumers need).

---

### Phase 3 — Engineering Review

#### Step 0 — Scope Challenge (grounded in code)

Plan touches: `@thor/common` (new event-log helpers), `runner` (trigger boundaries + alias emit), `remote-cli` (active-trigger inference → header propagation per CEO recommendation), `admin`/`ingress` (new public viewer route), tests across all four. ~12-15 files. Just past the 8-file smell threshold; cross-cutting nature justifies it.

#### Dual Voices Consensus Table

```
ENG DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════
  Dimension                                   Claude   Codex   Consensus
  ──────────────────────────────────────────  ─────── ──────── ───────────
  1. Architecture sound?                      NO       NO       CONFIRMED — coupling fixed by header propagation
  2. Test coverage sufficient?                NO       NO       CONFIRMED — 8 missing test categories
  3. Performance risks addressed?             NO       NO       CONFIRMED — O(file) inference + no retention
  4. Security threats covered?                NO       NO       CONFIRMED — bearer-pair, no rate-limit, weak redaction
  5. Error paths handled?                     NO       NO       CONFIRMED — crash window, idempotency, stale recreate
  6. Deployment risk manageable?              NO       NO       CONFIRMED — no flag, no dual-write, no rollback story
═══════════════════════════════════════════════════════════════
```

6/6 confirmed — both voices unanimously flag the same architecture, concurrency, and operational gaps.

#### Section 1 — Architecture (with diagram)

Rendered at the end of Phase 1's report (above). Key coupling concerns confirmed:
- **Writer ↔ readers:** schema gate needed. Single Zod schema in `@thor/common/event-log.ts`, imported by writer, viewer, remote-cli inference, alias resolver. All readers `safeParse` and skip-with-counter on failure.
- **Symlink target ↔ FS layout:** absolute targets bake `<yyyy-mm-dd>/<session-id>` paths; archival or volume migration silently breaks them. Approach B (flat session file path) eliminates this coupling.
- **remote-cli inference ↔ runner ordering:** plan assumes `trigger_start` lands before any tool can call remote-cli. There is no enforcement. Header propagation (one line in `packages/opencode-cli/src/remote-cli.ts:27` + `packages/remote-cli/src/index.ts:90`) deletes the inference subsystem entirely.

#### Section 2 — Concurrency

- **Append atomicity for large records.** PIPE_BUF (4KB) is a pipe semantic, not a regular-file semantic. POSIX gives weaker guarantees on regular files — same-FD `O_APPEND` writes from one process are typically atomic up to filesystem block size, but multiple *processes* writing the same file have no guarantee. OpenCode `message.part.updated` events with embedded tool output trivially exceed 4KB. **Fix:** cap one record at < 4KB by truncating `payload`/`event` (mirror the pattern in `packages/common/src/worklog.ts:18`); for guaranteed safety across processes, hold an advisory `flock` for the write.
- **Symlink rename-over.** `rename(2)` on the same filesystem is atomic per POSIX, but two writers racing to swap the same alias may leak `tmp.*` if not stable-named. Use `tmp.<pid>.<rand>`; sweeper janitor.
- **Reader vs writer.** Viewer route may `readFileSync` while runner is `appendFileSync`-ing → reader can observe a partial trailing line (no `\n`). Splitter must discard fragments without trailing `\n`.
- **Multi-replica.** Plan assumes single runner. If ever scaled horizontally on the same `/workspace/worklog` mount, races corrupt the log. Document the single-writer assumption explicitly; add `flock` if defense-in-depth is wanted.

#### Section 3 — Test Review

NEW UX FLOWS:
1. Reporter clicks viewer link in Slack/Jira/PR → SSR HTML status page → states: valid, missing, incomplete, running, oversized, redacted, expired, signature-invalid.
2. Disclaimer link surfaces inside Thor-authored PR body, Jira ticket, GitHub comment.
3. Slack thread reply routes to existing session via `slack.thread_id` alias.
4. Git branch activity routes to existing session via `git.branch` alias.

NEW DATA FLOWS:
1. Trigger ingress → runner appends `trigger_start` → events.jsonl (append-only).
2. OpenCode SSE event → runner → events.jsonl (append; child sessions inline).
3. Tool output → runner extracts alias → atomic symlink swap (or flat path map under Approach B).
4. remote-cli write tool → reads events.jsonl tail OR reads `x-thor-trigger-id` header → injects HMAC-signed disclaimer URL.
5. Viewer GET → resolve sessionId → slice `trigger_start..trigger_end` → redact → SSR.

NEW CODEPATHS:
- `@thor/common/event-log.ts`: appendRecord, atomicSymlinkSwap (or flat-path resolve), readSlice, findActiveTriggers, resolveAliasToSession.
- runner: trigger marker emit, alias write on tool completion, stale-session-recreate alias bridge.
- remote-cli: inferActiveTrigger(sessionId) — or removed by header propagation; buildSignedViewerUrl.
- admin/ingress: GET `/v/<sessionId>/<triggerId>?sig=...&ttl=...`.

NEW BACKGROUND JOBS — **none in plan** (this is a finding):
- Symlink janitor (sweep dangling links + stray `tmp.*` files daily).
- Retention sweeper (compress + remove sessions > N days).
- Audit-log rotation for `/v/*` hits.

NEW INTEGRATIONS: none external. Internal: viewer route on ingress.

NEW ERROR/RESCUE PATHS:
- Append failure (ENOSPC, EIO) → log to stderr, do not block trigger handling.
- Symlink rename collision → retry once with `unlink+symlink`, then log.
- Reader on partial trailing line → discard fragment, render rest.
- Multiple active triggers in inference → log + skip (plan), or removed by header propagation.
- Crash between `trigger_start` and `promptAsync` → outer try emits `trigger_aborted`; viewer renders incomplete with reason.
- HMAC signature failure → branded 403; expired link → branded 410.

**Tests missing from plan lines 273–280** (consensus across both voices):
1. Multi-process append fuzz (two `node` processes appending 1k records each, assert no corrupt lines).
2. Symlink rename race: spawn N parallel `swap-alias` calls, assert exactly one target wins and no `tmp.*` leaks.
3. Reader observing a partial trailing line during writer activity.
4. Public viewer enumeration: brute-force `triggerId` for known `sessionId` returns 404 within rate-limit budget.
5. `>4KB` payload write: assert truncation rather than corruption.
6. Crashed-runner replay with same `triggerId`: assert idempotent (no duplicate `trigger_start`).
7. Stale-session recreate: alias chain-follow returns the new session.
8. Malformed-line tolerance: planted `\0`, partial JSON, `\r\n`, BOM — slice extraction skips and increments a counter.
9. `trigger_start` written, then `promptAsync` fails: assert `trigger_aborted` marker emitted.
10. Same `correlationKey` concurrent triggers: advisory lock prevents double-create.
11. Viewer states: invalid signature (403), expired (410), redacted slice render, active streaming state.
12. Schema drift: writer at v2 + reader at v1 → reader skips unknown fields.

**Test plan artifact:** `~/.gstack/projects/scoutqa-dot-ai-thor/session-log-links-test-plan-20260430.md` (written separately by /autoplan).

#### Section 4 — Performance

- Linear `events.jsonl` scan in viewer route: fine until ~50MB. Cap with size limit + early-exit by triggerId match.
- Symlink resolution: O(1) per lookup. No concern.
- Active-trigger inference reads tail of `events.jsonl`: fine if size capped; tail-read pattern (last N KB, parse forward) is correct shape.
- Cache last-seen offset per session in remote-cli (in-memory) to avoid re-reading on every disclaimer write.
- Without retention, file size grows unbounded → inference cost grows linearly with time. F8 above.

#### Section 5 — Security & Threat Model

| Threat | Likelihood | Impact | Mitigated? | Fix |
|---|---|---|---|---|
| Public link leakage (copy-paste, search indexing, referrer) | High | High | NO | HMAC-sign URL with TTL; signature failure → 403; expiry → 410 |
| Direct object reference (guess sessionId+triggerId) | Low | High | Partial — but only if both IDs are ≥128-bit random | Specify UUIDv4/v7 for `triggerId`; `sessionId` is OpenCode's (ULID, 128-bit) |
| Tool output exfil (Slack content, Jira bodies, MCP results, env vars in stack traces) | High | High | NO — "basic redaction" undefined | Allowlist-based default-deny; per-tool field whitelist |
| Symlink traversal in `<thread-id>` filename | Medium | Medium | YES — plan validates `[0-9.]+` | OK |
| Symlink traversal in encoded git branch | Medium | Medium | YES — base64url normalizes | OK |
| Symlink target escape from `/workspace/worklog/` | Low | High | NO | Viewer must `realpath` + prefix-check before opening |
| `sessionId` injection into symlink path | Medium | Medium | NO | Validate `sessionId` matches OpenCode format (alphanumeric + `_`) before use |
| Viewer rate-limit DoS / enumeration | Medium | Low | NO | Express rate-limit middleware on `/v/*` |
| Audit gap (who viewed what) | High | Low | NO | Per-hit JSONL audit log via `appendJsonlWorklog` |

#### Section 6 — Hidden Complexity

- **rename(2) on Docker bind mounts.** Atomic on the same backing FS. Cross-FS `EXDEV` if `/workspace/worklog` ever spans devices (overlay, tmpfs, NFS). Pin volume to single ext4/xfs.
- **APFS case-folding (macOS dev).** `feat/Foo` and `feat/foo` collide. Base64url encoding of git branch keys side-steps this. Document.
- **`appendFileSync` durability.** No `fsync`; kernel panic loses last few hundred ms. Acceptable for v1; document.
- **Active-trigger inference O(file) at scale.** Becomes high severity once retention is absent.

#### Section 7 — Deployment & Rollout

Plan does not mention rollout posture. **Required additions:**
- JSONL event logging is unconditional for new feature paths.
- No dual-write routing window; readers use JSONL and do not fall back to notes.
- Rollback requires reverting the feature change; old notes remain readable for continuity.
- Rollout verifies staging first, then prod, without a runtime cutover switch.
- Post-deploy verification: viewer 5xx rate, event-log write error rate, runner trigger latency. First 5 min + first hour.

#### Section 8 — Long-Term Trajectory

- Reversibility: 3/5. Schema is durable, format is JSONL, but Approach A's symlink layout is the part that could need migration. Approach B (flat path) is 4/5.
- 1-year question: a new engineer can read `events.jsonl` directly. JSONL + grep is the established pattern. Score 8/10.
- Tech debt: P9 (no retention) is debt that compounds linearly with time.

#### Phase 3 Output Summary

**Top 10 ranked findings (consensus):**

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | Public viewer is unsigned bearer-pair URL; raw tool outputs leak | **critical** | HMAC-sign URL with TTL; allowlist redaction |
| F2 | Disclaimer inference fails in busy/parallel cases — exactly the cases it must cover | **critical** | Propagate `x-thor-trigger-id` (one line in `packages/opencode-cli/src/remote-cli.ts:27` + add to `packages/remote-cli/src/index.ts:90`); deletes inference branch entirely |
| F3 | "Greenfield, no migration" claim is false — runner uses notes.ts heavily | **high** | Superseded: JSONL is unconditional; notes remain only for unrelated continuity summaries |
| F4 | Absolute symlink indexes are fragile across volume mounts, archival, backup tools | **high** | Use flat session files (`<workdir>/sessions/<session-id>.jsonl`); drop symlink layer |
| F5 | No retention/archival/janitor; `worklog/` grows unbounded | **high** | Add Phase 6 (retention) with per-file size cap + rotation |
| F6 | "Basic redaction" undefined; tool outputs leak | **high** | Allowlist-based default-deny; per-tool field whitelist |
| F7 | `triggerId` generation entropy/format unspecified; if sequential, viewer enumeration is trivial | **high** | UUIDv4 (≥128-bit random); document |
| F8 | `>4KB` line writes can corrupt JSONL across processes | **high** | Cap one record at < 4KB; truncate payload field; reuse `worklog.ts:18` truncation pattern |
| F9 | No rate limit, no audit log on public `/v/*` | **high** | Express rate-limit + per-hit JSONL audit log |
| F10 | Crash between `trigger_start` and `promptAsync` leaves orphan empty triggers | **medium** | Outer-try emits `trigger_aborted`; viewer renders incomplete with reason |

**Architecture diagram, test diagram, and consensus table above.** Mandatory artifacts delivered.

---

### Phase 3.5 — DX Review

**SKIPPED** — no developer-facing scope detected.

The plan produces no SDK, CLI, MCP server, skill template, or external developer API. The public viewer is a UI surface for end-users (Slack/Jira reporters), reviewed in Phase 2. The `remote-cli` changes are internal Thor service plumbing — the consumers are Thor's own runner and OpenCode wrapper, not third-party developers.

DX scope detection (10 matches) was driven by mentions of `remote-cli` and `webhook` — both internal infrastructure terms in this plan, not developer-facing surfaces. Skip is correct per /autoplan rules.

---

### Phase 4 — Final Approval Gate

#### User Challenges (both models disagree with the plan's stated direction)

| # | Challenge | Plan says | Both models recommend | Why | Cost if we're wrong |
|---|---|---|---|---|---|
| UC1 | Propagate `x-thor-trigger-id` | Don't propagate; infer from log (line 158) | Add one line to `packages/opencode-cli/src/remote-cli.ts:27` and `packages/remote-cli/src/index.ts:90` | Inference fails in busy/parallel cases — exactly the cases disclaimers must cover; header pipe already exists | Disclaimer silently drops in complex sessions; not a security regression but loses the feature value |
| UC2 | HMAC-sign the public viewer URL with TTL | "Conservative output limits and basic redaction" + raw bearer-pair URL | Signed URL + redaction allowlist + audit log + rate limit | Slices contain Slack/Jira/MCP outputs, repo names, env-var names, memory contents; bearer-pair is unsafe for public ingress | **Highest stakes.** Link leak (copy-paste, search index, referrer) exposes internal data to the open internet |
| UC3 | Flat session file path; drop absolute symlink indexes | Symlinks for `index/sessions/*` and `index/aliases/*/*` | Flat `/workspace/worklog/sessions/<session-id>.jsonl` | Absolute targets break across volume mounts/backup tools; dangle on archival; complicate retention | Symlinks work fine on a single host; cost surfaces on archival/migration day |
| UC4 | Add retention/archival/janitor (Phase 6) | "Out of scope" (line 268) | In scope | Unbounded JSONL growth → viewer OOMs; active-trigger inference becomes O(file) | In 6 months: ops debt manifests as a fire-fight; recoverable but costly |
| UC5 | Treat Phase 2-4 as a cutover, not greenfield | "No migration path; greenfield" (line 16, 163) | Superseded: unconditional JSONL, no notes routing fallback | Runner still writes notes for unrelated continuity summaries, but JSONL owns session/event routing | Revert feature change if rollback is needed |

**None of UC1–UC5 are flagged as security/feasibility blockers** by both models simultaneously, except UC2 which is the leakage risk. UC2's framing for the user: this is closer to "both models think this is a security risk, not just a preference" than the others.

#### Taste Decisions (surfaced for transparency)

| # | Topic | Recommendation |
|---|---|---|
| T1 | Public Viewer Design Spec subsection (wireframe, copy, state matrix, mobile, a11y, OG metadata, two-view model) | Add at line 128, ~80–100 lines |
| T2 | Extend `appendJsonlWorklog` rather than build parallel writer | Reuse existing primitive |
| T3 | Cap one event record < 4KB; truncate payload field | Mirror `worklog.ts:18` truncation pattern |
| T4 | `triggerId` is UUIDv4 (≥128-bit) | Specify in plan + tests assert |
| T5 | Reader contract: drop unknown fields, render best-effort | Document in Phase 1 scope |
| T6 | Per-hit audit log on `/v/*` | New JSONL stream `viewer-audit` |
| T7 | `<meta refresh>` for streaming state (no JS framework) | Match plan's no-framework intent |

#### Decisions Auto-Decided (audit trail)

| # | Phase | Decision | Classification | Principle | Rationale |
|---|---|---|---|---|---|
| AD1 | 0F | Mode = SELECTIVE EXPANSION | Mechanical | autoplan rule | Iteration on existing system; not greenfield, not bug fix |
| AD2 | 0 | UI scope = YES | Mechanical | scope detection | 18 matches; viewer is SSR HTML page, even if minimal |
| AD3 | 0 | DX scope = NO | Mechanical | scope detection | No SDK/CLI/MCP/skill/external-API surface produced |
| AD4 | 0C-bis | Recommended Approach B over A and C | Taste | P3+P5+P1 | Smallest delta from plan's intent; fixes all premise concerns; no new dependency |
| AD5 | 0D | Accept cherry-picks C1-C5, C7-C9; defer C6 | Taste | P2+P3 | All in blast radius and < 1 day CC; C6 is product polish, not foundation |
| AD6 | 0.5 | Run dual voices for every phase | Mechanical | autoplan rule + P6 | Codex available; both voices add signal |
| AD7 | 3 | Write test plan artifact to disk | Mechanical | autoplan rule | Required Phase 3 deliverable |
| AD8 | 3.5 | Skip DX phase | Mechanical | scope detection | DX scope = NO |

#### Review Scores

| Phase | Codex | Claude Subagent | Consensus |
|---|---|---|---|
| CEO | 6 strategic concerns | 7 issues | 6/6 confirmed disagreement |
| Design | 7 dimensions all fail | 8 findings (3 critical, 4 high) | 7/7 confirmed disagreement |
| Eng | 10 ranked findings (2 critical, 6 high) | 16 ranked findings (1 critical, 8 high) | 6/6 confirmed disagreement |
| DX | skipped | skipped | n/a |

#### Cross-Phase Themes

**Theme 1: The plan trades implementation simplicity for operational fragility.** Symlinks (no atomic alias swap library), inference (no header propagation), bearer-pair URLs (no signing infra), no retention (no janitor). Each individual choice is "ship faster"; together they manifest as load-bearing operational debt by month 3.

**Theme 2: The "greenfield" frame masks a hard cutover.** P4 (no migration claim is false) appeared in both CEO and Eng phases independently. The plan reads as a clean-sheet design but Phases 2–4 actively replace runtime routing.

**Theme 3: The public viewer is a brand surface treated as a debug log.** Surfaced in CEO (security/leakage), Design (UX/states/copy), and Eng (HMAC/audit/rate-limit). High-confidence signal that this is the part of the plan most likely to age worst.

#### Deferred to TODOS.md

- C6 (curated viewer with raw-toggle): defer as a follow-up after foundation lands.
- Per-tool field allowlist for redaction (UC2): can be iterative, but at least skeleton must ship in Phase 3.
- SQLite migration (Approach C): explicitly rejected for v1; keep on roadmap for Phase 6+ if alias scale becomes a problem.
