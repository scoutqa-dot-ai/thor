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
