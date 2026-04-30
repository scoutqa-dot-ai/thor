<!-- /autoplan restore point: /Users/son.dao/.gstack/projects/scoutqa-dot-ai-thor/session-log-links-autoplan-restore-20260430-091720.md -->
# Session Event Log and Public Trigger Viewer

**Date**: 2026-04-30
**Status**: Draft

## Goal

Deliver a session-scoped JSONL event log that powers:

- trigger-scoped public viewer links
- OpenCode session event history
- Slack thread and git branch alias routing
- disclaimer-link injection for Thor-created GitHub and Jira content

No database. No markdown-notes compatibility layer. The source of truth is the session log.

## Log Shape

Each OpenCode session has one append-only log:

```text
/workspace/worklog/<yyyy-mm-dd>/<session-id>/events.jsonl
```

The day is when the session log is created. Later appends find the existing session directory through the session symlink index.

Initial record kinds:

```ts
type SessionEventLogRecord =
  | { schemaVersion: 1; ts: string; type: "trigger_start"; sessionId: string; triggerId: string; correlationKey?: string; promptPreview?: string }
  | { schemaVersion: 1; ts: string; type: "trigger_end"; sessionId: string; triggerId: string; status: "completed" | "error" | "aborted"; durationMs?: number; error?: string }
  | { schemaVersion: 1; ts: string; type: "opencode_event"; sessionId: string; event: unknown }
  | { schemaVersion: 1; ts: string; type: "alias"; sessionId: string; aliasType: "slack.thread_id" | "git.branch"; aliasValue: string; source?: string }
  | { schemaVersion: 1; ts: string; type: "tool_call"; sessionId: string; callId?: string; tool: string; payload: unknown };
```

One JSON object per line. Writers use one complete append per line.

## Symlink Indexes

JSONL is the source of truth. Absolute symlinks provide cheap lookup paths.

```text
/workspace/worklog/index/sessions/<session-id>
  -> /workspace/worklog/<yyyy-mm-dd>/<session-id>

/workspace/worklog/index/aliases/slack.thread_id/<thread-id>
  -> /workspace/worklog/<yyyy-mm-dd>/<session-id>

/workspace/worklog/index/aliases/git.branch/<encoded-key>
  -> /workspace/worklog/<yyyy-mm-dd>/<session-id>
```

Lookup rules:

- Session id: open `/workspace/worklog/index/sessions/<session-id>/events.jsonl`.
- Slack thread id: open `/workspace/worklog/index/aliases/slack.thread_id/<thread-id>/events.jsonl`.
- Git branch: encode the canonical branch key, then open `/workspace/worklog/index/aliases/git.branch/<encoded-key>/events.jsonl`.
- Active trigger: resolve the session symlink and scan that one `events.jsonl`.

Symlink writes:

1. Ensure the index directory exists.
2. Create a temporary symlink in the same index directory.
3. Rename the temporary symlink over the final path.

If an alias moves to a different session, the newest symlink target wins. This matches the desired routing behavior.

Filename encoding:

- Slack thread ids can be used directly after validating `[0-9.]+`.
- Git branch aliases use base64url of the full canonical branch key.

Thor runs on Ubuntu/macOS, so symlink support is assumed.

## Trigger Slicing

We will not propagate `triggerId` through OpenCode, bash, curl, or remote-cli.

The runner owns trigger boundaries:

1. Resolve or create the OpenCode session.
2. If the session is busy and the trigger is non-interrupting, return busy and write no marker.
3. If the session is busy and the trigger may interrupt, abort the session.
4. Wait for `session.idle` or `session.error`.
5. If settle times out, write no marker and do not call `promptAsync`.
6. Append `trigger_start`.
7. Send `promptAsync`.
8. Append OpenCode events for the parent and child sessions.
9. Append `trigger_end` when the trigger finishes.

The viewer slices from the requested `trigger_start` to the matching `trigger_end`. If a crash leaves no end marker, the slice ends at the next `trigger_start` for that session or EOF and is marked incomplete.

## Alias Routing

Alias markers live in `events.jsonl`.

Initial alias types:

- `slack.thread_id`
- `git.branch`

No `github.pr` alias type in this phase.

Index lookup rules:

- Slack thread id to session id: resolve the `index/aliases/slack.thread_id/<thread-id>` symlink.
- Git branch to session id: resolve the `index/aliases/git.branch/<encoded-key>` symlink.
- Session id to aliases: read that session log and collect `alias` records.

When a trigger creates a new session, the runner writes aliases as soon as enough context is known. For example, a Slack-triggered session should immediately write the incoming Slack thread id alias, and later writes can add git branch aliases discovered from tool output.

## Public Viewer

The viewer link uses `sessionId + triggerId` as a bearer pair. It is public, ingress-exposed, server-side rendered, and simple.

Viewer behavior:

- Open `/workspace/worklog/index/sessions/<session-id>/events.jsonl`.
- Find `trigger_start` with the requested `triggerId`.
- Render only that trigger slice.
- Include trigger status, OpenCode events, tool calls, memory reads, and delegate/task events.
- Return 404 for unknown session or trigger.
- Apply conservative output limits and basic redaction.

No client-side framework is needed.

## Disclaimer Links

Thor-created content includes a disclaimer/viewer link for:

- Jira ticket creation
- Jira comments
- GitHub PR creation
- GitHub comments/reviews

Slack messages are skipped to avoid noise.

Since `triggerId` is not propagated, remote-cli infers the active trigger from `x-thor-session-id`:

1. Open `/workspace/worklog/index/sessions/<session-id>/events.jsonl`.
2. Find open trigger slices in that one file: a `trigger_start` without a later matching `trigger_end`.
3. If exactly one active trigger exists, build the viewer link and inject it.
4. If zero or multiple active triggers exist, log and skip injection.

This depends on the runner appending `trigger_start` before any OpenCode tool can call remote-cli.

## Decision Log

| Date       | Decision                                                                            | Why                                                             |
| ---------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 2026-04-30 | Use `/workspace/worklog/<day>/<session-id>/events.jsonl` as the source of truth      | Keeps trigger, event, and alias data together                   |
| 2026-04-30 | Use absolute symlink indexes for session and alias lookup                            | Avoids repeated global scans without introducing a database      |
| 2026-04-30 | Do not add SQLite or another DB                                                     | Symlink indexes are enough for this phase                       |
| 2026-04-30 | Do not propagate `THOR_TRIGGER_ID` through OpenCode/bash/curl/remote-cli             | Ordered trigger markers are simpler                            |
| 2026-04-30 | Write `trigger_start` only after any prior busy session has settled                  | Prevents prior-run events from entering the new trigger slice   |
| 2026-04-30 | Abort timeout means no marker and no prompt                                          | Avoids ambiguous slices                                         |
| 2026-04-30 | remote-cli infers trigger from the latest open session marker                        | Enables disclaimer links without extra propagation              |
| 2026-04-30 | remote-cli skips injection when inference is ambiguous                               | Avoids attaching the wrong public link                          |
| 2026-04-30 | Initial alias types are only `slack.thread_id` and `git.branch`                      | Matches actual producers                                        |
| 2026-04-30 | No markdown-notes compatibility or migration path                                    | Project is greenfield; build the intended feature directly      |

## Phases

### Phase 1 - Common Event Log Primitives

Scope:

1. Add typed append/read helpers in `@thor/common`.
2. Resolve session log path through `index/sessions/<session-id>`, else create today's session directory and symlink.
3. Add helpers to:
   - append trigger markers
   - append OpenCode events
   - append alias markers
   - read a trigger slice
   - find the active trigger for a session
   - resolve aliases to session ids
4. Add helpers to write absolute symlinks atomically.
5. Add unit tests for append, read, slicing, active-trigger inference, alias symlinks, and malformed-line tolerance.

Exit criteria:

- Records append to the agreed path.
- Session and alias symlinks are created and replaced atomically.
- Trigger slices are extracted correctly.
- Missing `trigger_end` is handled as incomplete.
- Alias lookup works both alias-to-session and session-to-aliases.

### Phase 2 - Runner Event Capture and Session Boundaries

Scope:

1. Generate a `triggerId` for each accepted `/trigger`.
2. Replace notes-based session lookup for new routing with JSONL alias/session lookup.
3. Enforce the busy-session rules:
   - non-interrupt busy returns busy with no marker
   - interrupt busy aborts and waits for settle
   - abort timeout returns busy/error with no marker and no prompt
4. Append `trigger_start` before `promptAsync`.
5. Stream and append OpenCode events for parent and discovered child sessions.
6. Append `trigger_end` on completion or error.
7. Write initial aliases from trigger context, such as Slack thread id.

Exit criteria:

- Every completed trigger has ordered start, event, and end records.
- Busy and abort-timeout paths produce no partial trigger slice.
- Child-session activity appears inside the parent trigger slice.
- Incoming Slack/git context can route to an existing session through JSONL aliases.

### Phase 3 - Public Trigger Viewer

Scope:

1. Add a public route for `sessionId + triggerId`.
2. Expose the route through ingress without auth.
3. Render server-side HTML.
4. Show trigger metadata, status, OpenCode events, tool calls, memory reads, and delegate/task events.
5. Add output limits and redaction.

Exit criteria:

- Valid links render only the requested trigger slice.
- Unknown session or trigger returns 404.
- Incomplete slices are labeled incomplete.
- Route is publicly reachable through ingress.

### Phase 4 - Alias Marker Producers

Scope:

1. Emit `slack.thread_id` aliases from inbound Slack trigger context and Slack write artifacts.
2. Emit `git.branch` aliases from existing git artifact detection.
3. Route Slack and GitHub/git events through the JSONL resolver.
4. Add tests covering multiple aliases on one session.

Exit criteria:

- Slack thread replies route to the session with the matching `slack.thread_id`.
- Git branch activity routes to the session with the matching `git.branch`.
- A session can hold both Slack and git aliases.

### Phase 5 - Disclaimer Injection

Scope:

1. Extend remote-cli request context to infer the active trigger by session id.
2. Build the public viewer link from the inferred trigger.
3. Inject the link into supported GitHub and Jira write operations.
4. Skip Slack writes.
5. Log and skip injection when active-trigger inference is ambiguous.

Exit criteria:

- GitHub PR/comment/review writes include the viewer link when exactly one trigger is active.
- Jira ticket/comment writes include the viewer link when exactly one trigger is active.
- Ambiguous inference never injects a guessed link.

## Out of Scope

- SQLite or any database-backed index.
- In-memory rebuildable indexes.
- Propagating trigger id through OpenCode, bash, curl, or remote-cli.
- New alias types such as `github.pr`.
- Rich client-side viewer UI.
- Slack disclaimer injection.
- Retention, archival, and pruning automation.
- Blocking raw Slack writes through mitmproxy.

## Verification

Local verification:

- `@thor/common` tests for event log helpers
- runner tests for marker order, busy behavior, interrupt behavior, and abort timeout
- resolver tests for Slack and git aliases
- viewer route tests for valid, missing, incomplete, and oversized slices
- remote-cli tests for active-trigger inference and disclaimer injection fallback

Final verification follows the repository workflow: push the branch, wait for required GitHub checks, then open a PR.

---

## GSTACK REVIEW REPORT (auto-generated by /autoplan)

Branch: `session-log-links` | Commit at start: `6da9b56c` | Date: 2026-04-30
Mode: **SELECTIVE EXPANSION** (iteration on existing system, dual-voice review)
Codex available: yes | UI scope: yes (public viewer is a server-rendered page) | DX scope: no

### Phase 1 — CEO/Strategy Review

#### Step 0A. Premise Challenge

The plan's stated and implicit premises, with verdicts grounded in the codebase:

| # | Premise (stated or implicit) | Verdict | Evidence |
|---|---|---|---|
| P1 | Symlink support is enough; "Ubuntu/macOS, symlinks assumed" (line 76) | **WEAK** | `/workspace/worklog` is a Docker bind mount. Absolute symlink targets `/workspace/worklog/...` do not resolve outside the container. Volume rsync/backup tools may not preserve symlinks. Future archival creates dangling links. |
| P2 | One-line append per writer is enough concurrency control (line 39) | **WEAK** | No `O_APPEND` contract or per-line size cap stated. Posix guarantees atomic appends only ≤ `PIPE_BUF` (4KB). Long OpenCode events can exceed that and interleave. |
| P3 | Session-id is a stable bearer over time | **ACCEPTABLE WITH CAVEAT** | OpenCode session IDs are high-entropy. But `runner/src/index.ts:413-449` recreates a session on stale; old viewer links 404 silently. Should be documented behavior. |
| P4 | "Greenfield, no markdown-notes compatibility or migration" (line 16, 163) | **WRONG** | `runner/src/index.ts` calls `getSessionIdFromNotes` (414), `appendTrigger` (511), `createNotes` (515), `appendSummary` (798), `registerAlias` (812). Phases 2–4 are a hard cutover, not a greenfield build. |
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
- **Rollback**: ship behind a config flag (`SESSION_LOG_ENABLED`); fallback to today's notes-based path. Plan does not mention rollback posture.

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
- Plan does not specify a config flag. ACTION: gate behind `SESSION_LOG_ENABLED`; fallback to notes path. Two-deploy rollout: deploy code dark, flip flag, verify, then make notes.ts writes a no-op.
- Migration risk window: while flag flips, two stores diverge. Acceptable for ~24-48h validation period.
- Rollback: flip flag back; old notes path still reads markdown.
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
- Config flag `SESSION_LOG_ENABLED` gates the new writer.
- Dual-write window (notes + new event log) for ~24-48h validation period; readers prefer JSONL but fall back to notes if absent.
- Rollback: flip flag; old notes path still reads markdown.
- Two-deploy rollout: deploy code dark, flip flag on staging, verify, flip on prod.
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
| F3 | "Greenfield, no migration" claim is false — runner uses notes.ts heavily | **high** | Add cutover plan + `SESSION_LOG_ENABLED` flag; dual-write window |
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
| UC5 | Treat Phase 2-4 as a cutover, not greenfield | "No migration path; greenfield" (line 16, 163) | `SESSION_LOG_ENABLED` flag + dual-write window for ~24-48h validation | Runner uses notes.ts at 5 call sites (414/511/515/798/812); deploy boundary loses in-flight sessions | Manual recovery on deploy boundary; or accept session loss for one deploy |

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
