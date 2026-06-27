# Session Event Log and Public Trigger Viewer

**Date**: 2026-04-30
**Status**: partially superseded by `docs/plan/2026051501_admin-sessions-external-keys.md` and `docs/plan/2026052701_profile-based-integration-routing.md` Phase 6.

> **Note on current behavior:** The `slack.thread_id` alias type defined here has since been replaced by the channel-qualified `slack.thread` alias (`<channel>/<threadTs>`); GitHub issue create/comment are now allowed with disclaimer injection (via `github.issue` aliases). See the superseding plans above for those changes; the anchor abstraction and event-log design below remain current.

## Goal

Deliver a session-scoped JSONL event log that powers:

- a Vouch-gated trigger viewer at `/runner/v/<anchorId>/<triggerId>` for completed and in-flight triggers
- OpenCode session event history
- an **anchor abstraction** that decouples external correlation keys (Slack thread, git branch) from OpenCode session ids; Slack threads, git branches, OpenCode sessions, and OpenCode sub-sessions all bind as equal-class members to an opaque anchor id (replaces the `session.parent` chain-walk)
- disclaimer-link injection for Thor-created GitHub PRs/comments/reviews and Jira tickets/comments
- a bounded reader story for v1; retention/archival/janitor is deferred out of this implementation
- an end-to-end architecture reference at [`docs/feat/event-flow.md`](../feat/event-flow.md) covering inbound ingestion, queue serialization, runner trigger handling, alias resolution, and outbound approval-card emission — the runtime context this plan plugs into

No database. No backwards-compatible markdown-notes routing layer. The source of truth is the session log; the old markdown notes implementation is removed.

## Anchor Abstraction

External correlation keys (Slack thread, git branch) and OpenCode entities (sessions, sub-sessions) do not alias to each other directly. Every binding points at an opaque **anchor id** (UUIDv7) that has no record of its own — it is a pure pointer that gives all four entity types equal-class membership in the same logical conversation.

### Why anchors

- **Stability across `session_stale`.** A Slack thread aliases to an anchor, never a specific OpenCode session id. When the runner recreates a stale session, the Slack alias does not move; only a new `opencode.session → anchor` binding is appended for the new session id. Old viewer links keep working without a per-trigger fallback.
- **No `session.parent` chain-walk.** `findActiveTrigger` resolves the request session id to its anchor and scans every OpenCode session bound to that anchor for an open trigger. Linear over (typically 1, occasionally 2-3) sessions; no depth cap, no cycle detection, no recursion.
- **Disclaimer URL is conversation-stable.** `/runner/v/<anchorId>/<triggerId>` survives session recreate without 404. The viewer resolves anchor → owning-session at request time.
- **Equal-class membership.** All four entity types use the same `appendAlias` / `resolveAlias` machinery — one mechanism, one cache, one log file.

### Alias types

```ts
export const ALIAS_TYPES = [
  "slack.thread_id",
  "git.branch",
  "opencode.session",
  "opencode.subsession",
] as const;
```

`session.parent` is removed. Its sole consumer (`findActiveTrigger` chain-walk) is replaced by an anchor reverse lookup.

| Alias type            | Alias value                              | Binding target                           |
| --------------------- | ---------------------------------------- | ---------------------------------------- |
| `slack.thread_id`     | `<thread_ts>` (raw, validated `[0-9.]+`) | the anchor that owns this thread         |
| `git.branch`          | base64url(`git:branch:<repo>:<branch>`)  | the anchor that owns this branch         |
| `opencode.session`    | `<sessionId>` (OpenCode format)          | the anchor this session belongs to       |
| `opencode.subsession` | `<childSessionId>` (OpenCode format)     | the anchor the parent session belongs to |

### Anchor lifecycle

| Event                                                                                        | Action                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/trigger` arrives; correlation key resolves to an existing anchor                           | Use it                                                                                                                                   |
| `/trigger` arrives with no correlation key, or with a key that has no anchor binding         | Mint new anchor (UUIDv7); append the correlation-key alias and an `opencode.session → anchor` binding for the session it creates         |
| Runner creates a new OpenCode session for an existing anchor (e.g. after `session_stale`)    | Append `opencode.session → anchor` for the new session id; original Slack/git aliases stay put                                           |
| Runner discovers a child session on the event bus during an active trigger                   | Append `opencode.subsession → anchor` for the child session id (where anchor is the parent session's anchor)                             |
| Producer (remote-cli) observes a Slack `post_message` or `git push` during an active session | Resolve the session's anchor (`resolveAlias("opencode.session", sessionId)`), then append the correlation-key alias bound to that anchor |

The anchor itself is never written, mutated, or deleted as a record. Its existence is implied by any alias whose binding target is its id; the first alias that names an anchor implicitly creates it.

### Reverse lookup

`findActiveTrigger` and the viewer need: "given an anchor, list the OpenCode sessions bound to it." The in-process alias cache (already keyed by `<aliasType>:<aliasValue>` for forward lookups) gains a parallel reverse map keyed by `<anchorId>` → `{ sessionIds: Set<string>, subsessionIds: Set<string>, externalKeys: Set<{aliasType, aliasValue}> }`, populated on the same single pass over `aliases.jsonl`. No new file, no additional read cost; rebuilt alongside the forward map on size-signature change.

### Lock-key grouping

`resolveCorrelationLockKey` resolves `correlationKey → alias → anchor → "anchor:<anchorId>"`. Two correlation keys (a Slack reply and a GitHub push) for the same conversation share the lock at the anchor level rather than the session level — `session_stale` mid-batch no longer changes the lock identity. Raw-key fallback (no alias resolved yet) keeps using the unmodified correlation key as the lock until the first session create binds an anchor.

### No migration

The plan is greenfield on an unmerged branch with no production users. The anchor shape is the only shape that ships; existing dev-environment `aliases.jsonl` files are deleted as part of bringing up the new code. No backfill, no rotate-and-keep, no compatibility shim. The companion change to `docs/feat/event-flow.md` is tracked separately; its alias-routing diagram and §6 alias-types table need to be regenerated against the new shape before the branch lands.

## Log Shape

Each OpenCode session has one append-only log at a flat, day-independent path:

```text
/workspace/worklog/sessions/<session-id>.jsonl
```

The flat layout (no day-partition for session files) avoids absolute-symlink fragility across volume mounts, backups, and archival. Day-based archival happens later via the retention sweeper, not via the live read path.

Record kinds:

```ts
type SessionEventLogRecord =
  | {
      schemaVersion: 1;
      ts: string;
      type: "trigger_start";
      triggerId: string;
      correlationKey?: string;
      promptPreview?: string;
    }
  | {
      schemaVersion: 1;
      ts: string;
      type: "trigger_end";
      triggerId: string;
      status: "completed" | "error" | "aborted";
      durationMs?: number;
      error?: string;
      reason?: string;
    }
  | { schemaVersion: 1; ts: string; type: "opencode_event"; event: unknown }
  | {
      schemaVersion: 1;
      ts: string;
      type: "alias";
      aliasType: "slack.thread_id" | "git.branch" | "opencode.session" | "opencode.subsession";
      aliasValue: string;
      anchorId: string;
      source?: string;
    }
  | {
      schemaVersion: 1;
      ts: string;
      type: "tool_call";
      callId?: string;
      tool: string;
      payload: unknown;
    };
```

No record carries a `sessionId` field; the owning session id is encoded in the file path (`sessions/<sessionId>.jsonl`) and that is the sole source of truth. Child OpenCode sub-sessions write to their own `sessions/<childSessionId>.jsonl` — the owner session log never contains records authored by a different session.

Writer contract:

- One JSON object per line, terminated by `\n`. Writers use `appendFileSync` with a single complete append per record.
- Every record is capped at **< 4 KiB** serialized. Larger `event` and `payload` fields are truncated; truncation marker `"_truncated": true` is set on the record. Mirrors the existing pattern in `packages/common/src/worklog.ts`.
- Writers extend the existing `appendJsonlWorklog` primitive in `packages/common/src/worklog.ts:123` rather than building parallel infrastructure. New helper: `appendSessionEvent(sessionId, record)`.
- `triggerId` is generated as a UUIDv7 by the runner. The format is documented and asserted in tests so the viewer URL stays an unguessable bearer; UUIDv7's ~74 random bits per id are well above the bearer-pair threshold once Vouch fronts the route. Time-ordered minting also gives free chronological sort for log scans and viewer URL audits.
- Single-writer-per-session is assumed. Runner is single-replica today; if multi-replica is ever required, an advisory `flock` on the session file is added then.

Reader contract:

- Single shared Zod schema in `@thor/common/event-log.ts`, imported by writer, viewer, alias resolver, and any active-trigger inference fallback.
- Readers `safeParse` each line and skip-with-counter on failure. Counter surfaces in the viewer footer.
- Readers tolerate a partial trailing line: a fragment without `\n` is dropped without error.
- Unknown record types render as a generic `<details>` with `type` and the JSON body.
- Forward-compatibility: readers drop unknown fields, render best-effort.

## Lookup Indexes

Four lookup needs:

1. **External alias → anchor.** Slack thread id or git branch key must resolve to an anchor id.
2. **OpenCode session id → anchor.** A request session id (parent or child) must resolve to its anchor.
3. **Anchor → bound OpenCode sessions.** Reverse lookup used by `findActiveTrigger` and the viewer to find the session that owns a trigger.
4. **Active trigger in a session.** Used by remote-cli on disclaimer-eligible writes (PR create, PR comments, reviews, Jira ticket create, Jira comments) — a handful of reads per trigger.

### Alias index

```text
/workspace/worklog/aliases.jsonl
```

A single append-only file. Each line:

```ts
type AliasRecord = {
  ts: string;
  aliasType: "slack.thread_id" | "git.branch" | "opencode.session" | "opencode.subsession";
  aliasValue: string;
  anchorId: string;
};
```

Forward resolution: in-memory map keyed by `<aliasType>:<aliasValue>` → `anchorId`. Newest record wins. Cache rebuilt on cold start and on `aliases.jsonl` size-signature change.

Reverse resolution: parallel map keyed by `<anchorId>` → `{ sessionIds: Set<string>, subsessionIds: Set<string>, externalKeys: Set<{aliasType, aliasValue}> }`. Populated on the same single pass over `aliases.jsonl`; rebuilt alongside the forward map.

This replaces the absolute-symlink layout in the original plan. No symlinks → no portability concerns across volume mounts, backup tools, or archival. Day-partitioning is a write-time decision in `appendJsonlWorklog`, not a path requirement.

Filename encoding for `aliasValue`:

- Slack thread ids: validate as `[0-9.]+` before recording.
- Git branch aliases: use base64url of the full canonical branch key (case-fold-safe on macOS APFS).
- OpenCode session/sub-session ids: OpenCode session id format (alphanumeric + `_`); validate before use.

`anchorId` is a UUIDv7 written as the canonical 36-character hyphenated form; validated before use.

### Active-trigger inference

remote-cli calls `findActiveTrigger(requestSessionId)` on each disclaimer-eligible write. The function uses anchor reverse lookup; **returns the owner session id** alongside the trigger id — the owner is where the `trigger_start` record actually lives, which is the session id the viewer must read to assemble the slice.

1. Resolve the request session id's anchor: `resolveAlias("opencode.session", requestSessionId) ?? resolveAlias("opencode.subsession", requestSessionId)`. If neither resolves, return `{ reason: "none" }`.
2. Reverse-lookup the anchor's `opencode.session` ids (sub-sessions are intentionally excluded — child sessions never carry their own `trigger_start`).
3. For each session id in the reverse set: open `/workspace/worklog/sessions/<sessionId>.jsonl` if it exists; scan the complete session log for the latest `trigger_start` without a matching later `trigger_end`. Any later `trigger_start` in the same file supersedes earlier unclosed starts; those earlier slices are treated as crashed, not active.
4. If exactly one open trigger is found across all bound sessions → return `{ anchorId, sessionId, triggerId }`.
5. Zero opens → return `{ reason: "none" }`.
6. Multiple opens (a stale orphan from a runner crash on one session alongside a live trigger on the current session, both bound to the same anchor) → pick the open trigger with the newest `trigger_start.ts`; older opens are treated as crashed. Same supersede-by-newest rule `readTriggerSlice` uses inside a single session, lifted across the anchor's membership set.

The full scan is preserved (a long-running trigger can write enough events that its `trigger_start` falls outside any tail window before a late PR/Jira write). Relative to the pre-anchor design, the `session.parent` recursive walk, depth cap, cycle detection, and the `cycle`/`depth_exceeded` failure modes all go away — anchors flatten the parent relationship into a flat membership set.

No current-trigger sidecar/index in v1. Each disclaimer-eligible write does a fresh anchor lookup + session scan; the per-trigger call volume is small enough that I/O is not load-bearing, and correctness is more important than scan speed.

Failure mode: if inference returns anything other than an open trigger (`none`, `ambiguous`), the caller fails fast. The write does not ship without a disclaimer. See "Disclaimer Links" for the per-path details.

Child-session-before-parent-link case: if a child session writes before the runner has appended its `opencode.subsession → anchor` binding, step 1 returns `none` and the write fails closed with the same retry/delegate-to-parent guidance as before.

## Trigger Slicing

`triggerId` is **not** propagated through OpenCode/bash/curl/remote-cli. It is generated and owned by the runner; remote-cli recovers it via active-trigger inference (see "Lookup Indexes") on the small set of disclaimer-eligible writes. Prior research rejected direct propagation for v1: no trusted per-trigger env channel exists from runner into OpenCode shell hooks, and making one deterministic would require a new shared mapping, plugin contract, or remote lookup surface.

The runner owns trigger boundaries:

1. Resolve or create the OpenCode session via the JSONL alias resolver, with an advisory lock on the alias key during resolve+create to prevent same-`correlationKey` race.
2. If the session is busy and the trigger is non-interrupting, return busy and write no marker.
3. If the session is busy and the trigger may interrupt, abort the session.
4. Wait for `session.idle` or `session.error`.
5. If settle times out, write no marker and do not call `promptAsync`.
6. Generate `triggerId` (UUIDv7).
7. Append `trigger_start`.
8. Send `promptAsync`.
9. Append OpenCode events from the parent session to the parent's session log; append events from any discovered child session to that child's own session log. The viewer reads only the owner session log when assembling a trigger slice — child-session activity is kept in its own file for clean schema (no record carries a session id; the path is the source of truth) but is not merged into the parent slice.
10. Append `trigger_end` (with `status: completed | error | aborted`, plus optional `reason`) when the trigger finishes.

### What the runner can and cannot guarantee about close markers

The trigger handler is wrapped in a `try/catch/finally` and emits `trigger_end{status:"error", error: <message>}` on caught throws and `trigger_end{status:"aborted", reason: <reason>}` on user-initiated abort/interrupt. **It does not — and cannot — emit a close marker on process-level crashes.** SIGKILL, OOM kill, container kill, host failure, V8 abort, segfault, and `process.exit()` from anywhere all skip userland code. A best-effort `SIGTERM` handler can capture the most common operational case (graceful Docker stop, k8s rolling restart) by appending `trigger_end{status:"aborted", reason:"shutdown"}` for any in-flight trigger before the process exits — pairs with the slice algorithm below as a safety net, not a guarantee.

### Slice algorithm (conflict-based termination)

The viewer's `readTriggerSlice(sessionId, triggerId)` finds the requested `trigger_start` and walks forward to the first of:

| Stop reason                                                           | Slice status                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trigger_end{triggerId=target}` reached                               | terminal — render with that record's `status` (`completed` / `error` / `aborted`)                                                                                                                                  |
| Any other `trigger_start` (same session, different triggerId) reached | **`crashed`** — slice ends just before the new start. The new start is unambiguous proof the session moved on without closing this trigger; runner must have died after step 7 of the trigger flow                 |
| EOF reached                                                           | **`in_flight`** — no terminal marker, no superseder. Could be still running or could be a crashed-and-not-yet-superseded trigger. Viewer renders with auto-refresh; soft banner if last record is older than 5 min |

The viewer never time-bounds a slice into a "crashed" verdict on its own — that label requires hard data (a superseding `trigger_start`). Time staleness only soft-warns inside the in-flight render.

### Idempotency

A `trigger_start` with a `triggerId` already present in the session within the last hour is rejected by the writer (replay/retry safety).

## Alias Routing

Alias markers live in two places:

- Inside `/workspace/worklog/sessions/<session-id>.jsonl` for that session (audit trail; what aliases a session collected, including the anchor it belongs to).
- In the global `/workspace/worklog/aliases.jsonl` (newest-wins forward resolution + reverse anchor map).

The alias types and their binding targets are defined in "Anchor Abstraction" above; every record's binding target is an anchor id. No `github.pr` alias type in this phase.

Trigger flow:

1. Runner resolves the inbound correlation key via `aliasForCorrelationKey` + `resolveAlias`. If an anchor is found, use it; otherwise mint a new anchor (UUIDv7).
2. Advisory lock on `anchor:<anchorId>` during resolve+create to prevent same-anchor race.
3. Runner appends `opencode.session → anchor` for the session id used (resumed or freshly created), plus the correlation-key alias if it is the first time the conversation has seen that key.
4. Slack-triggered sessions write the incoming `slack.thread_id` alias before any tool call. Git branch aliases are added later only after successful `git push` in remote-cli, which resolves the executing session's anchor (`resolveAlias("opencode.session", sessionId)`) and binds the new key to it.
5. `opencode.subsession` aliases are written from the runner's OpenCode event subscription as child sessions are discovered. Child discovery is asynchronous, so child-session disclaimer support remains fail-closed: a write that reaches remote-cli before the child binding is recorded fails with retry/delegate-to-parent guidance.

If a trigger experiences `session_stale` recreate (`packages/runner/src/index.ts:440`), the anchor stays put and the runner appends `opencode.session → anchor` for the new session id. The Slack/git aliases never move — they were never bound to the old session id in the first place.

## Trigger Viewer

The viewer is **Vouch-gated** (same OAuth proxy that fronts `/admin`), hosted by the runner service under a stable `/runner/*` ingress prefix, server-side rendered, and treated as an internal-tooling surface.

URL shape:

```text
/runner/v/<anchorId>/<triggerId>
```

Single endpoint. There is **no `/raw` route**: every byte the viewer renders passes the redaction allowlist, so no path can sidestep it. The viewer resolves `anchorId` → owning session id at request time via the alias reverse map (look up `opencode.session` ids bound to the anchor; pick the one whose log contains `trigger_start{triggerId}`). Reading the right JSONL is an internal detail; the URL never leaks a session id.

No HMAC. No TTL query params. UUIDv7 ids on `anchorId` and `triggerId` (~148 bits of randomness combined, time-ordered) are the access-control floor; Vouch is the access-control ceiling. Anchor-keyed URLs keep working across `session_stale` recreates — old links survive because the anchor is the durable identity, not the session id.

Ingress mapping (in `docker/ingress/nginx.conf`): `location /runner/ { ... }` proxies to the runner service. This single mount lets future runner-owned routes (admin tools, debug endpoints, etc.) ship without per-route ingress changes.

The runner reads `X-Vouch-User` from incoming requests on `/runner/*` (matches the existing `packages/admin/src/app.ts` pattern) and treats absence as 401.

### States

| Slice status (from `readTriggerSlice`)                             | Server response | UI                                                                                                                                                              |
| ------------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed` (terminal `trigger_end{status:"completed"}`)           | 200             | Green "Completed" pill + hero + outcome card + collapsed timeline                                                                                               |
| `error` (terminal `trigger_end{status:"error"}`)                   | 200             | Red "Error" pill + `error` field + collapsed timeline                                                                                                           |
| `aborted` (terminal `trigger_end{status:"aborted"}`)               | 200             | Orange "Aborted" pill + `reason` if present + collapsed timeline                                                                                                |
| `crashed` (superseded by another `trigger_start` in same session)  | 200             | Red "Crashed" pill + copy: "This trigger was abandoned without a close marker. The runner started a new trigger at <ts>; whatever was in-flight here was lost." |
| `in_flight` (no terminal record, no superseder, last event recent) | 200             | Yellow "Running" pill + last-event timestamp + `<meta http-equiv="refresh" content="5">`                                                                        |
| `in_flight` + last event > 5 min old                               | 200             | Yellow "Running" pill + soft banner: "No new events in N min — the runner may have crashed without a close marker. Reload to check."                            |
| Empty (zero non-marker records between start and stop)             | 200             | "No recorded events" empty state                                                                                                                                |
| Redacted fields present                                            | 200             | Inline `[redacted: tool output, NN bytes]` markers                                                                                                              |
| Unknown anchor/trigger                                             | 404             | Branded 404                                                                                                                                                     |
| Missing `X-Vouch-User`                                             | 401             | Vouch redirects to OAuth                                                                                                                                        |
| Backend failure (parse, FS error)                                  | 503             | Branded retry copy                                                                                                                                              |

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

Generated by Thor.   Report an issue.
```

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

- Anchor resolution: viewer rejects `anchorId` not matching the canonical UUIDv7 36-char hyphenated form before any disk I/O. Resolution failure (no `opencode.session` bound to the anchor, or no session in the bound set whose log contains `trigger_start{triggerId}`) → branded 404.
- Path validation: viewer `realpath`s the resolved session file path and asserts prefix `/workspace/worklog/sessions/` before opening.
- No raw escape hatch on any route; engineers needing the bytes read the JSONL directly from the worklog volume.

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

The disclaimer URL is the plain Vouch-gated viewer path: `/runner/v/<anchorId>/<triggerId>`. No HMAC, no TTL. The URL is anchor-keyed because the anchor is the durable conversation identity — disclaimer links survive `session_stale` recreate without 404.

**Both paths fail-fast.** Every Thor-created artifact must be traceable to a trigger; if `findActiveTrigger(sessionId)` cannot return exactly one open trigger, or if the per-tool args injector cannot find the expected field, the operation fails outright. The artifact does not ship without the disclaimer. Silent skips would let routing bugs (missing `opencode.subsession` binding, runner crash mid-flight, schema drift on a Jira args shape) ship trivially-attributable artifacts as untraceable, which defeats the point of the disclaimer.

### Direct writes (GitHub `gh`)

Inline at execute time. The shell command runs through remote-cli with `x-thor-session-id` already in the request context.

1. remote-cli detects disclaimer-eligible commands: `gh pr create`, `gh pr comment`, `gh pr review`, and the explicit append-only `gh api repos/{owner}/{repo}/pulls/<pr>/comments/<comment>/replies --method POST -f body=...` shape.
2. Call `findActiveTrigger(requestSessionId)`. The helper resolves the request session's anchor (`opencode.session` or `opencode.subsession`), reverse-looks-up every session bound to that anchor, and scans each session log for a single open `trigger_start`. **Fail-fast** if `none` / `ambiguous`: the `gh` command exits non-zero with a clear error ("Disclaimer required: no single active trigger for session X — runner state may be broken"). No exec, no artifact.
3. Build the URL from the returned anchor and trigger: `${RUNNER_BASE_URL}/runner/v/${result.anchorId}/${result.triggerId}`. The anchor is uniform whether the request originates from the top-level session or a child sub-session; only the owner session id differs internally, and the viewer resolves it back from the anchor.
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

1. Call `findActiveTrigger(requestSessionId)` using the current request's session id. **Fail-fast** if `none` / `ambiguous`: return an error to the LLM ("Cannot create approval: no single active trigger for this session") and persist no action.
2. Build the URL from the returned anchor: `${RUNNER_BASE_URL}/runner/v/${result.anchorId}/${result.triggerId}`. Approve-gated calls also originate from child sessions during sub-agent work, but the anchor is uniform whether the request originates from the parent session or a sub-session — the URL is identical.
3. Mutate `args` per a small per-tool injector. **The injector throws if the expected field is missing on the args shape** — defense-in-depth against MCP schema drift or LLM passing the wrong field name. Throws bubble up as approval-create errors; no half-mutated action is persisted.

| Tool                    | Injection field | Strategy                                                                                                                    |
| ----------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `createJiraIssue`       | `description`   | Append `\n\n---\n[View Thor trigger](<url>)` to the description body. Throw if `args.description` is missing or non-string. |
| `addCommentToJiraIssue` | `commentBody`   | Append the same footer to the comment body. Throw if `args.commentBody` is missing or non-string.                           |

4. Call `approvalStore.create(toolInfo.name, mutatedArgs)`. The persisted action carries the URL in `args` from the start.

Child-session limitation: before the runner records the `opencode.subsession → anchor` binding, a child session has no anchor lookup hit and `findActiveTrigger` returns `none`. The write fails closed with the same no-active-trigger guidance. After the binding is recorded, the helper resolves the child's anchor and finds the parent's open trigger via the anchor reverse map.

At resolve+execute time, `mcp-handler.ts:515` calls `executeUpstreamCall({ args: action.args, ... })` unchanged — the disclaimer is already in the args. No execute-time mutation, no schema changes to `ApprovalActionSchema`, no Thor context required at resolve time.

### Why mutate-at-create-time rather than persist-then-execute-mutate

- **Transparency for the human approver.** The Slack approval prompt shows the full description body the artifact will carry, including the disclaimer. The reviewer can verify the disclaimer is correct, sees what they are signing off on, and can reject if the disclaimer is missing or wrong.
- **Idempotent on retry.** Approve-resolve has 3 attempts (`packages/gateway/src/service.ts`); replays carry identical args, no risk of double-injection.
- **No schema migration.** `ApprovalActionSchema` (`packages/remote-cli/src/approval-store.ts:6`) stays unchanged.
- **Audit-clean.** The action record IS the bytes that got executed. No "the args said X but we sent X+disclaimer" footnote.

## Decision Log

| Date       | Decision                                                                                                                                                                        | Why                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-04-30 | Use `/workspace/worklog/sessions/<session-id>.jsonl` as the source of truth; no symlink indexes — `aliases.jsonl` newest-wins for alias lookup                                  | Flat session-keyed path avoids symlink portability concerns and survives volume mount/backup/archival. In-process cache rebuilt on miss is faster than a grep-based scan.                                                                                                                                                                                                                        |
| 2026-04-30 | Do not add SQLite or another DB                                                                                                                                                 | Append-only JSONL + small in-memory cache is enough for v1. Revisit if alias scale becomes a problem.                                                                                                                                                                                                                                                                                            |
| 2026-05-03 | Register aliases at the producer, not via hidden tool-output metadata                                                                                                           | `remote-cli` already receives `x-thor-session-id`, so successful git/Slack producers append canonical aliases directly to `aliases.jsonl`; runner routing uses `resolveAlias` rather than scraping command output.                                                                                                                                                                               |
| 2026-05-03 | Store only the inbound user prompt in `trigger_start.promptPreview`                                                                                                             | Memory bootstrap, tool instructions, and correlation banners are synthesized runner context, not user prompt content. Recording the pre-injection preview keeps the viewer from exposing hidden memory/instructions.                                                                                                                                                                             |
| 2026-04-30 | Do not propagate `triggerId` through OpenCode/bash/curl/remote-cli; recover via bounded inference on disclaimer-eligible writes                                                 | No trusted per-trigger env channel exists between runner and OpenCode shell hooks; adding one requires a new shared mapping/plugin contract. Disclaimer-eligible writes are rare enough that scanning the session log is acceptable.                                                                                                                                                             |
| 2026-04-30 | Write `trigger_start` only after any prior busy session has settled; abort timeout means no marker and no prompt                                                                | Prevents prior-run events from entering the new trigger slice and avoids ambiguous slices.                                                                                                                                                                                                                                                                                                       |
| 2026-04-30 | One `trigger_end{status:"aborted"\|"error"\|"completed", reason?}` record; no separate `trigger_aborted` type                                                                   | One way to express "this trigger ended"; cleaner schema.                                                                                                                                                                                                                                                                                                                                         |
| 2026-04-30 | Trigger slices terminate on conflict, not on time                                                                                                                               | A subsequent `trigger_start` for the same session is unambiguous proof the prior trigger was abandoned. Time-based staleness only soft-warns inside the in-flight render — never a "crashed" verdict from the clock alone.                                                                                                                                                                       |
| 2026-04-30 | Process-level crashes are not the runner's responsibility to mark                                                                                                               | A `try/catch/finally` cannot run on SIGKILL/OOM/container-kill/segfault. Best-effort SIGTERM handler covers graceful shutdowns; crashes are detected at viewer time via supersede.                                                                                                                                                                                                               |
| 2026-04-30 | Greenfield JSONL logging, not a flag-gated cutover; the old markdown notes implementation is removed                                                                            | This project can fail closed on event-log writes and route session aliases from JSONL directly.                                                                                                                                                                                                                                                                                                  |
| 2026-04-30 | Viewer is Vouch-gated under a `/runner/*` ingress prefix; no HMAC, no TTL on the URL                                                                                            | Reuses the existing OAuth proxy pattern; UUIDv7 entropy + Vouch is the access-control model, dropping HMAC operational cost. A single ingress mount lets future runner routes ship without per-route changes. Old artifact links keep working.                                                                                                                                                   |
| 2026-04-30 | Redaction is allowlist (default-deny) on tool outputs                                                                                                                           | Defense-in-depth — even with Vouch fronting the route, allowlist redaction keeps screenshots/copy-paste/log-share from leaking content the page shouldn't render.                                                                                                                                                                                                                                |
| 2026-04-30 | No per-hit audit log on `/runner/v/*`                                                                                                                                           | Vouch / ingress already log auth events; an extra Thor-side audit stream is debt without a clear consumer.                                                                                                                                                                                                                                                                                       |
| 2026-04-30 | Confluence writes removed from the atlassian approve list (commit `a4d755ca`)                                                                                                   | Reduces blast radius; the only approve-gated MCP tools that need disclaimer support are `createJiraIssue` and `addCommentToJiraIssue`. Re-introduce later if a real use case lands.                                                                                                                                                                                                              |
| 2026-04-30 | Approve-gated writes (Atlassian MCP): mutate `args` at approval-create time                                                                                                     | Approval is async; by execute time the original trigger is closed and inference would return zero opens. Create-time mutation keeps Thor context in scope, lets the approver see the disclaimer in the Slack prompt, and avoids `ApprovalActionSchema` changes.                                                                                                                                  |
| 2026-04-30 | Both disclaimer paths fail-fast on missing/unsafe active trigger                                                                                                                | Every Thor-created artifact must be traceable to a trigger. Failing open would silently ship disclaimer-less artifacts and hide the underlying routing bug.                                                                                                                                                                                                                                      |
| 2026-04-30 | Per-tool args injector throws on missing/wrong-typed field                                                                                                                      | Defense-in-depth against MCP schema drift or LLM passing the wrong field name. A throw bubbles to approval-create and persists no action.                                                                                                                                                                                                                                                        |
| 2026-04-30 | No cache/index on the direct-write disclaimer path                                                                                                                              | Per-trigger call volume is small; full bounded JSONL scans are acceptable and avoid a second active-trigger source of truth.                                                                                                                                                                                                                                                                     |
| 2026-04-30 | `gh pr create --fill` denied at the policy layer                                                                                                                                | `--fill` composes the body from commit messages at exec time, leaving no field for the injector to mutate — it would silently produce disclaimer-less PRs. Denying at the policy layer gives the LLM an early deny with guidance toward `--title/--body`.                                                                                                                                        |
| 2026-04-30 | Direct writes (GitHub `gh`): inline injection at execute time                                                                                                                   | `gh` exec is synchronous within the runner-driven request; original Thor context is in scope. No approval-store involvement.                                                                                                                                                                                                                                                                     |
| 2026-04-30 | Include PR review-comment replies in disclaimer injection                                                                                                                       | The allowed `gh api .../pulls/<pr>/comments/<comment>/replies` shape creates GitHub-visible content; it gets the same disclaimer footer rather than becoming an untraceable carve-out.                                                                                                                                                                                                           |
| 2026-04-30 | Deny `gh issue create` and `gh issue comment` in v1                                                                                                                             | GitHub issues are outside the PR/Jira launch scope; deny rather than ship issue content without disclaimer injection.                                                                                                                                                                                                                                                                            |
| 2026-04-30 | Cap one event record at < 4 KiB serialized; truncate and mark `_truncated`                                                                                                      | Avoids cross-process append interleave; mirrors the existing `worklog.ts` truncation pattern.                                                                                                                                                                                                                                                                                                    |
| 2026-04-30 | Single shared Zod schema in `@thor/common/event-log.ts`                                                                                                                         | Writer-reader schema gate; readers `safeParse` and skip-with-counter; forward-compat by ignoring unknown fields.                                                                                                                                                                                                                                                                                 |
| 2026-04-30 | `findActiveTrigger` scans the full session log, not a tail window                                                                                                               | A long-running trigger can push its `trigger_start` outside a tail window before a late PR/Jira write. Full scan preserves a single-log source of truth without an active-trigger sidecar.                                                                                                                                                                                                       |
| 2026-05-01 | Superseded orphan triggers are not active                                                                                                                                       | A later `trigger_start` is hard evidence the session moved on after an earlier trigger was orphaned. Inference picks only the latest unclosed start; earlier ones remain visible as `crashed` slices and cannot poison routing forever.                                                                                                                                                          |
| 2026-05-03 | Introduce the **anchor abstraction**: Slack thread, git branch, and OpenCode sessions/sub-sessions all bind to an opaque `anchorId` instead of aliasing directly to session ids | Decouples conversation identity from OpenCode session lifecycle: survives `session_stale` recreate without a per-trigger fallback, flattens the old `session.parent` recursive walk into a flat membership set, and produces a stable disclaimer URL that does not 404 across session recreate. `ALIAS_TYPES` is `["slack.thread_id", "git.branch", "opencode.session", "opencode.subsession"]`. |
| 2026-05-03 | `aliases.jsonl` records bind to `anchorId`; the in-process cache gains a parallel reverse map keyed by `anchorId`                                                               | Same file, same single-pass read; reverse map rebuilt alongside the forward map on size-signature change. Answers "given an anchor, list the bound sessions and external keys" needed by `findActiveTrigger` and the viewer.                                                                                                                                                                     |
| 2026-05-03 | Trigger viewer URL is anchor-keyed (`/runner/v/<anchorId>/<triggerId>`); lock-key grouping is anchor-keyed (`anchor:<anchorId>`)                                                | The anchor is the durable conversation identity, so old links survive `session_stale` recreate and two correlation keys for the same conversation share one lock. Raw-key fallback applies until the first session create binds an anchor.                                                                                                                                                       |
| 2026-05-04 | `findActiveTrigger` returns `{ anchorId, sessionId, triggerId }`; failure modes are `none` / `ambiguous`                                                                        | URL is built from `anchorId`; viewer reads `<sessionId>.jsonl` to assemble the slice. When more than one bound session has an open trigger, the newest by `trigger_start.ts` wins — same supersede-by-newest semantics as within a single session, lifted across the anchor membership set.                                                                                                      |
| 2026-05-03 | Use UUIDv7 (not v4) for `anchorId` and `triggerId`                                                                                                                              | The viewer URL relies on the ids as unguessable bearers; ~74 random bits per id (≈148 combined) is well above the Vouch-gated bearer threshold. Time-ordered minting also gives free chronological sort for log scans and audits.                                                                                                                                                                |
| 2026-05-03 | Greenfield: no migration, no backfill, no compatibility shim                                                                                                                    | Plan is unmerged on a dev branch with no production users. Existing dev-environment `aliases.jsonl` files are deleted at code bring-up.                                                                                                                                                                                                                                                          |
| 2026-05-04 | Child OpenCode session events write to the child's own session log; viewer reads only the owner session log                                                                     | No `SessionEventLogRecord` variant carries a session id (path is the sole source of truth), and viewer assembly stays single-file. Child activity is still tracked via `opencode.subsession → anchor` for routing/URL correctness; a child-session viewer is future work.                                                                                                                        |
| 2026-05-04 | Drop the `/raw` viewer endpoint; single curated route only                                                                                                                      | Removes a redaction-bypass vector — every byte rendered passes the allowlist. Engineers needing raw bytes read the JSONL directly from the worklog volume.                                                                                                                                                                                                                                       |
| 2026-05-16 | Drop the session-log size cap; read logs at any size                                                                                                                            | Session logs carry trigger provenance for disclaimers/approvals; losing access silently breaks the audit trail. Slow read beats failing closed. Removed the `oversized` failure mode and the viewer "Slice truncated" page; the per-record 4 KiB cap stays. Revisit with streaming reads if a runaway log becomes a real risk.                                                                   |

## Phases

> Phases 1–5 are described in terms of the **anchor abstraction** (the final design at the top of this plan). The alias mechanism, `findActiveTrigger`, the viewer URL, and the disclaimer paths are all anchor-keyed end-to-end.

### Phase 1 - Common Event Log Primitives

Scope:

1. Add the shared Zod schema in `@thor/common/event-log.ts` (`SessionEventLogRecord`, `AliasRecord`). `AliasRecord.aliasType` is one of `ALIAS_TYPES` (`"slack.thread_id" | "git.branch" | "opencode.session" | "opencode.subsession"`); `AliasRecord` binds to `anchorId` (canonical UUIDv7), not `sessionId`. No `SessionEventLogRecord` variant carries a `sessionId` field — the path (`sessions/<sessionId>.jsonl`) is the sole source of truth.
2. Build typed helpers, layered on `appendJsonlWorklog` (`packages/common/src/worklog.ts:123`):
   - `appendSessionEvent(sessionId, record)` — single complete append, < 4 KiB cap with `_truncated` marker on overflow.
   - `appendAlias({ aliasType, aliasValue, anchorId })` — appends to global `aliases.jsonl`.
   - `mintAnchor()` — generates a UUIDv7 anchor id. Pure function, no I/O.
   - `readTriggerSlice(sessionId, triggerId)` — returns `{ records, status: "completed"|"error"|"aborted"|"crashed"|"in_flight", reason?, lastEventTs? }`. Termination is conflict-based (see "Trigger Slicing"): the slice ends at the first matching `trigger_end`, OR at any subsequent `trigger_start` for the same session (status = `crashed`), OR at EOF (status = `in_flight`). Tolerates malformed lines and discards partial trailing lines.
   - `findActiveTrigger(requestSessionId)` — resolves the request session's anchor (`resolveAlias("opencode.session", …) ?? resolveAlias("opencode.subsession", …)`), reverse-looks-up the `opencode.session` ids bound to that anchor, and scans each session log for the latest unclosed `trigger_start`; returns `{ anchorId, sessionId, triggerId } | { reason: "none" | "ambiguous" }`. The returned `sessionId` is the **owner** — the session whose log contains the latest unclosed `trigger_start`. Earlier unclosed starts superseded by a later `trigger_start` are crashed slices, not active triggers. A child session before its `opencode.subsession` binding exists returns `none` and fails closed.
   - `resolveAlias({ aliasType, aliasValue })` — newest-wins lookup returning `anchorId | undefined`, with in-process cache rebuilt on miss.
   - `reverseLookupAnchor(anchorId)` — returns `{ sessionIds, subsessionIds, externalKeys }`; reverse map populated on the same single pass over `aliases.jsonl` as the forward map.
   - `listSessionAliases(sessionId)` — collects `alias` records from session log.
3. Reader behaviors: `safeParse` each line, skip-with-counter on failure, drop unknown fields, tolerate partial trailing line.
4. Unit tests for: append + 4KB truncation, slice extraction across all five statuses (`completed`, `error`, `aborted`, `crashed` via subsequent `trigger_start`, `in_flight` via EOF), malformed-line tolerance, partial-trailing discard, active-trigger lookup (zero/one/superseded orphan in current session; late write where `trigger_start` is near the beginning of a large file; `ambiguous` when two same-anchor sessions both have open triggers; child before `opencode.subsession` exists returns `none`), forward + reverse alias map correctness (newest wins; `opencode.subsession` resolves to the parent's anchor), session→aliases listing, schema-drift handling (unknown field ignored), UUIDv7 format and lexicographic mint-time ordering.
5. Concurrency tests: multi-process append fuzz (no corrupt lines); reader observing partial trailing line during writer activity.

Exit criteria:

- Records append to `/workspace/worklog/sessions/<session-id>.jsonl`; no record carries a `sessionId` field.
- `readTriggerSlice` returns the correct status for each of `completed`, `error`, `aborted`, `crashed` (subsequent `trigger_start` in same session), and `in_flight` (EOF). Malformed lines and partial trailing lines do not break extraction.
- Forward and reverse alias maps populate on a single pass; resolution is newest-wins; cache rebuild on miss is verified.
- `findActiveTrigger` resolves via anchor reverse lookup, finds old open starts that a tail window would miss, returns `ambiguous` for two same-anchor open triggers, and returns `none` for a child before its `opencode.subsession` binding exists — all with failing-then-passing tests.
- Multi-process append fuzz produces zero corrupt lines.

### Phase 2 - Runner Event Capture and Session Boundaries

Scope:

1. Generate `triggerId` (UUIDv7) for each accepted `/trigger`.
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
9. Stream and append OpenCode events, routed by source session: parent-session events to `sessions/<parentSessionId>.jsonl`, discovered child-session events to `sessions/<childSessionId>.jsonl`. **When a new sub-session id appears on the event bus during an active trigger, append an `opencode.subsession → anchor` alias record (the parent's anchor) to `aliases.jsonl`.** This is what lets `findActiveTrigger` resolve a child session to the parent's open trigger after discovery.
10. Append `trigger_end` on normal completion (`status:"completed"`).
11. Write the Slack thread alias immediately on Slack-triggered sessions, bound to the session's anchor.

Exit criteria:

- Every completed trigger has ordered start, event, and end records.
- Caught throws inside the trigger handler land as `trigger_end{status:"error"}`; user-initiated aborts land as `trigger_end{status:"aborted", reason}`.
- A simulated SIGTERM during a live trigger appends `trigger_end{status:"aborted", reason:"shutdown"}` before the process exits.
- A simulated SIGKILL during a live trigger leaves the trigger open in the log; a subsequent runner restart followed by a new trigger on the same session lets the viewer render the original slice with `crashed` status (verified via integration test).
- Busy and abort-timeout paths produce no marker (none for non-interrupt-busy; no trigger_start for abort-timeout).
- Same-anchor concurrent triggers do not double-create.
- Discovered child sessions get an `opencode.subsession → anchor` alias and write their events to their own session log (not the parent's). If a child tool call reaches remote-cli before the alias exists, disclaimer injection fails closed with retry/delegate-to-parent guidance.
- Gateway and runner routing use JSONL aliases only; markdown notes are not consulted for routing.

### Phase 3 - Trigger Viewer

Scope:

1. Add `GET /runner/v/:anchorId/:triggerId` route to the runner service. Single endpoint — no `/raw` variant; every byte rendered goes through the redaction allowlist. Routes read `X-Vouch-User`; absence → 401. Resolve `anchorId → owning session id` at request time: `reverseLookupAnchor(anchorId)` yields the bound `opencode.session` ids; pick the one whose log contains `trigger_start{triggerId}`.
2. Update `docker/ingress/nginx.conf` with a `location /runner/ { ... }` block proxying to the runner service, behind the existing Vouch flow used for `/admin/`.
3. Server-side render HTML using the hierarchy in this plan (hero / outcome / collapsed timeline).
4. Implement the state matrix from "Trigger Viewer" above: `completed` / `error` / `aborted` (terminal); `crashed` (superseded); `in_flight` with `<meta refresh>` and a soft staleness banner if the last record is > 5 min old; empty / redacted variants; branded 401/404/503.
5. Implement redaction allowlist (default-deny on tool outputs); per-tool field rules ship iteratively starting with safe metadata.
6. Mobile-first CSS, semantic landmarks, `<time datetime>`, branded 401/404/503 pages.
7. Path validation: reject `:anchorId` not matching the canonical UUIDv7 36-char hyphenated form before any disk I/O; `realpath` + prefix-check the resolved session file on `/workspace/worklog/sessions/`.

Exit criteria:

- Authenticated request renders the requested trigger slice with the correct status from `readTriggerSlice` (one of `completed` / `error` / `aborted` / `crashed` / `in_flight`).
- A trigger that was superseded by a later `trigger_start` for the same session renders with the red "Crashed" pill and abandonment copy — without any time threshold required.
- A trigger with no terminal record and no superseder renders as "Running" with `<meta refresh>`; the soft staleness banner appears only when the last record is older than 5 min.
- Missing `X-Vouch-User` returns 401 (Vouch handles the OAuth redirect upstream of the runner).
- Unknown anchor/trigger returns branded 404; a malformed `:anchorId` returns 404 without disk I/O.
- Redaction default-deny is enforced (snapshot tests assert no raw tool output appears in HTML for non-allowlisted fields).
- Mobile snapshot at 375px viewport renders single-column with 16px base font.
- Ingress smoke test: an authenticated request to `/runner/v/<anchorId>/<tid>` reaches the runner; an unauth request gets the Vouch login redirect.

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

Two paths share the same `findActiveTrigger(requestSessionId)` helper from `@thor/common/event-log.ts` (anchor reverse lookup + bounded scan). The helper returns `{ anchorId, sessionId, triggerId }`. Both paths build the anchor-keyed URL `${RUNNER_BASE_URL}/runner/v/${result.anchorId}/${result.triggerId}` — no HMAC, no TTL. **Both fail-fast** if inference cannot return exactly one open trigger or if the per-tool args injector cannot find the expected field.

Prerequisites (already shipped on this branch as part of this plan):

- Commit `a4d755ca`: Confluence write tools removed from the approve list in `packages/common/src/proxies.ts`. Phase 5's per-tool injector covers only `createJiraIssue` and `addCommentToJiraIssue`.
- `gh pr create --fill` denied in `packages/remote-cli/src/policy-gh.ts` (companion commit). Removes the only `gh` shape that has no body field for the disclaimer injector to mutate. `using-gh` skill doc updated to match.

Additional Phase 5 policy change:

- Deny `gh issue create` and `gh issue comment`. They are content-creation surfaces, but v1 disclaimer injection targets PR/Jira artifacts only. Implementation must update all three surfaces together: remove/deny the issue command shapes in `packages/remote-cli/src/policy-gh.ts`, replace the existing allow assertions with deny assertions in `packages/remote-cli/src/policy.test.ts`, and remove/update the allowed-command documentation in `docker/opencode/config/skills/using-gh/SKILL.md`. Denial is required so the end-state invariant holds: all non-Slack content creation either receives a disclaimer link or is blocked.

#### Direct writes (GitHub `gh`) — inline at execute time

1. Extend remote-cli's `gh` exec path to detect disclaimer-eligible commands: `gh pr create`, `gh pr comment`, `gh pr review`, and the explicit `gh api repos/{owner}/{repo}/pulls/<pr>/comments/<comment>/replies --method POST -f body=...` review-comment reply shape.
2. For each, call `findActiveTrigger(sessionId)`. **Fail-fast** if `none`/`ambiguous`: the `gh` command exits non-zero with a clear error message; no upstream call.
3. Build the anchor-keyed URL and rewrite the relevant body source (`--body`/`-b`, `-F`/`--body-file`, or the `gh api` raw field `body`) to append `\n\n---\n[View Thor trigger](<url>)`.
4. Exec `gh` with the mutated body.

No cache — each disclaimer-eligible exec does a fresh full bounded JSONL scan. The per-trigger call volume is small enough that I/O cost is irrelevant; cache/index complexity is not warranted.

#### Approve-gated writes (Atlassian MCP) — args mutation at create time

1. At `packages/remote-cli/src/mcp-handler.ts:443`, before `approvalStore.create(toolInfo.name, args)`:
   - Call `findActiveTrigger(sessionId)` using the current request's session id.
   - **Fail-fast** if `none`/`ambiguous`: return an error to the caller. Do not persist a half-formed action.
   - Build the anchor-keyed URL.
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
- Approve-create with no active trigger, unsafe trigger state, or missing args field returns an error and persists no action.
- Child-session writes resolve via the `opencode.subsession → anchor` binding to the parent's open trigger after the binding is recorded AND inject an anchor-keyed URL. A viewer GET with the injected URL renders the parent slice. If the binding is not yet recorded, the lookup returns `none` and the write fails closed.
- Tests cover: direct write with one open trigger; PR review-comment reply body mutation through `gh api`; late disclaimer write with `trigger_start` near the beginning of a large log; `ambiguous` fail-fast; superseded orphan starts using the latest trigger id; child session before its `opencode.subsession` binding exists (`none`, no exec/no action); child session after the binding exists (URL anchor matches the parent's anchor); per-tool injector throws on missing field; approve-resolve replays the same args (idempotent); end-to-end: a child-session-originated `gh pr create` after the binding produces a URL whose viewer GET returns 200 (not 404); policy denies `gh pr create --fill`, `gh issue create`, and `gh issue comment` (covered by `policy.test.ts`), and `using-gh` docs no longer list issue create/comment as allowed.

### Phase 6 - Integration Wiring & Docs

The anchor schema and lookup behavior are described in "Anchor Abstraction", "Lookup Indexes", and "Alias Routing"; Phases 1–5 implement the helpers, runner flow, viewer, and producers against that shape. Phase 6 finishes the cross-package wiring and docs.

Scope:

1. **Lock-key grouping in queue** (`packages/gateway/src/queue.ts`): `resolveCorrelationLockKey` resolves `correlationKey → alias → anchor → "anchor:<anchorId>"`. Raw-key fallback unchanged.
2. **Greenfield bring-up** — delete existing dev-environment `aliases.jsonl` and any session JSONLs that carry an old shape before starting the new code. No migration script.
3. **Update `docs/feat/event-flow.md`** — alias-routing diagram and §6 alias-types table regenerated against the anchor shape (anchor as binding target, four alias types, anchor-keyed lock key, anchor-keyed viewer URL).

Exit criteria:

- Queue lock-key is `anchor:<anchorId>` once the anchor resolves; two correlation keys for the same anchor share a single lock. Raw-key fallback applies until the first session create binds an anchor.
- Existing dev-env `aliases.jsonl` / session JSONLs removed at bring-up.
- `docs/feat/event-flow.md` reflects the anchor shape.

### Deferred Future Work - Retention, Archival, and Janitor

Retention/archival/janitor automation is explicitly **out of scope for this PR**. v1 reads session logs at any size (no live-path size cap; only the per-record 4 KiB cap applies) and does not prune. The previously proposed `scripts/session-log-janitor.ts` one-shot is removed to avoid implying an unowned retention contract.

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
- Propagating `triggerId` through OpenCode/bash/curl/remote-cli — recovered via anchor lookup + bounded session scan.
- New alias types beyond `slack.thread_id`, `git.branch`, `opencode.session`, and `opencode.subsession` (no `github.pr` in this phase).
- Migration / backfill / compatibility shim for the pre-anchor `aliases.jsonl` shape — the plan is greenfield on an unmerged branch; existing dev-environment files are deleted at code bring-up.
- Anchor metadata records (status, owner, archive flag, directory). The anchor is a pure pointer; per-anchor metadata is future work if/when conversation-level state grows beyond what the alias log can answer.
- Raw JSONL viewer endpoint (`/raw`). Single curated route only — every render path passes the redaction allowlist. Engineers needing raw bytes read the JSONL directly from the worklog volume. Reintroduce later if a real need surfaces.
- Confluence write _features_. The three Confluence approve-gated tools (`createConfluencePage`, `createConfluenceFooterComment`, `createConfluenceInlineComment`) are removed from `packages/common/src/proxies.ts` as part of this plan (commit `a4d755ca` on this branch) and denied by default. Re-introducing them is out of scope.
- GitHub issue content creation in v1. `gh issue create` and `gh issue comment` are denied rather than injected. Re-introduce later only with explicit disclaimer support.
- Public unauthenticated viewer access — viewer is Vouch-gated; external Jira reporters who don't have OAuth cannot click into the disclaimer link. Acceptable trade for content-protection simplicity.
- HMAC-signed viewer URLs / TTL expiry — Vouch + UUIDv7 entropy is the access-control model.
- Rich client-side viewer UI.
- Slack disclaimer injection.
- Retention, archival, pruning, and janitor automation for session logs/aliases. Future work should define ownership, retention windows, archive UX, and operational rollout before adding scripts or cron jobs.
- Blocking raw Slack writes through mitmproxy.
- Per-tool field allowlist beyond a starter set (iterates after Phase 3 ships).
- Multi-replica runner support — current scope assumes single writer; revisit if/when scale-out becomes a need.

## Verification

Local verification:

- `@thor/common` tests for event log helpers (append, slice across all five statuses including `crashed`-via-supersede and `in_flight`-via-EOF, anchor-based active-trigger lookup including old starts near the beginning of a large file, alias forward + reverse map correctness including `opencode.subsession` resolution to the parent's anchor, `ambiguous` failure mode when two same-anchor sessions both have open triggers, child-before-`opencode.subsession`-recorded returning `none`, schema drift, multi-process fuzz, partial trailing line, UUIDv7 format assertion, anchor minted ids sort lexicographically by mint time).
- runner tests for marker order, busy behavior, interrupt behavior, abort timeout, caught-throw → `trigger_end{status:"error"}`, SIGTERM handler appends `trigger_end{status:"aborted", reason:"shutdown"}`, simulated SIGKILL leaves the trigger open and a follow-up trigger renders the prior slice as `crashed`, idempotent retry, same-anchor concurrent-trigger race, **anchor preserved across `session_stale` recreate** (new session gets fresh `opencode.session → anchor`; original Slack/git aliases unmodified), `opencode.subsession → anchor` alias write on child session discovery.
- resolver tests for Slack, git, OpenCode session, and OpenCode sub-session aliases (newest wins, type isolation, two correlation keys for the same anchor produce the same `anchor:<id>` lock key, both correlation-key sides resolve after `session_stale` recreate).
- viewer route tests for `completed` / `error` / `aborted` / `crashed` / `in_flight` rendering paths, soft staleness banner above 5 min, branded 401/404/503, mobile snapshot, single-endpoint contract (no `/raw` route exists; every render path passes redaction), `X-Vouch-User` 401 path, **anchor → owner-session resolution at request time** (URL produced before `session_stale` still renders after; URL with malformed `:anchorId` returns 404 without disk I/O).
- remote-cli tests for direct-write disclaimer injection (`gh pr create` flag rewrite, `gh pr comment`, `gh pr review`, and PR review-comment reply via `gh api` raw `body` field); fail-fast on direct write when active trigger is missing/ambiguous (`gh` exits non-zero, no exec); superseded orphan starts use the latest trigger id; policy denial for `gh pr create --fill`, `gh issue create`, and `gh issue comment`; approve-gated args mutation at create time (Jira ticket/comment); fail-fast approve-create on missing active trigger or missing `opencode.subsession` binding (returns `none`; no action persisted); per-tool injector throws on missing/wrong-typed field (no action persisted); idempotent approve-resolve replay; **child-session URL correctness** — child-session-originated `gh pr create` and `createJiraIssue` after the subsession binding produce URLs whose `<anchorId>` segment matches the parent's anchor (URL renders 200 in the viewer, not 404).
- ingress smoke test: `/runner/v/<anchorId>/<tid>` reaches the runner only with a valid Vouch session.
- Retention/janitor automation is out of scope for this PR; future retention work should add its own tests for gz round-trip, retention boundaries, dangling cleanup, and aliases.jsonl rotation.

Final verification follows the repository workflow: push the branch, wait for required GitHub checks, then open a PR.

Rollout posture:

- Ship JSONL session/event logging as the only implementation path.
- Verify viewer/disclaimer/alias paths against staging traffic before prod rollout.
- Do not keep a markdown-notes continuity/routing fallback; JSONL is the only session/event implementation path.
- Rollback requires reverting the feature change rather than toggling a runtime cutover switch.

---
