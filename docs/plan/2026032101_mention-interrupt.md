# Mention Interrupt — 2026-03-21-01

> **Superseded note (2026-04-24):** the GitHub-specific mention details in this historical plan are outdated. GitHub mention detection now derives identities from `GITHUB_APP_SLUG` (`<slug>` and `<slug>[bot]`), not `GIT_USER_NAME`. Keep this document as historical design context only; use the current GitHub webhook docs/plan for live behavior.

> Mentions (`@thor`) should interrupt a running opencode session. Non-mention messages should never interrupt — they wait until the session is idle.

## Architecture

- **Handler is fire-and-forget.** All trigger functions (`triggerRunnerSlack`, `triggerRunnerGitHub`, `triggerRunnerCron`) are called without `await` in the queue handler. The queue's per-key `processing` lock only guards the brief enqueue→fire cycle, not the session lifetime.

- **Runner decides whether to abort.** The runner's `/trigger` endpoint checks `interrupt` flag. When `interrupt=true` and session is busy → abort, wait for idle, send prompt. When `interrupt=false` and session is busy → return `{busy: true}` without aborting.

- **At-least-once delivery.** Queue files are not deleted until the runner accepts the work. The handler receives an `ack()` callback; trigger functions call it after the runner's initial HTTP response (before stream consumption). If the process crashes or runner is busy, files stay on disk for retry.

## Interrupt rules

| Source                                          | Interrupt | Delay   |
| ----------------------------------------------- | --------- | ------- | ----------------------------------------------------------------- |
| Slack `app_mention`                             | true      | 0s      |
| Slack `message` (engaged — Thor replied before) | false     | 3s      |
| ~~Slack `message` (not engaged)~~               | ~~false~~ | ~~60s~~ | **Obsolete** — dropped since `2026041301_slack-drop-unengaged.md` |
| GitHub with `@GIT_USER_NAME` in body            | true      | 3s      |
| GitHub without mention                          | false     | 60s     |
| Cron                                            | false     | 0s      |

Default for new sources: `interrupt: false`. The runner treats unset interrupt as false.

"Engaged" means the worklog notes for the correlation key contain a `slack_post_message` tool call — i.e. Thor has actively replied in the thread before. This is checked via `hasSlackReply()` in `@thor/common`.

## Scenarios

### S1: Mention while idle

Mention enqueued with `interrupt: true`, 0s delay. Queue fires immediately → runner creates/resumes session → processes prompt.

### S2: Mention while session is running (same thread)

Mention enqueued with `interrupt: true`, 0s delay. Queue fires immediately → runner sees busy session → aborts → waits for idle → sends new prompt.

### S3: Non-mention while session is running (same thread)

> **Obsolete** — see `2026041301_slack-drop-unengaged.md`. Non-mention messages in unengaged threads are now dropped. Engaged threads use 3s delay.

~~Non-mention enqueued with `interrupt: false`, 60s delay. After 60s, queue fires → runner sees busy session → returns `{busy: true}` → ack not called → files stay on disk → retried on next scan. Once session finishes → fires → agent sees the message.~~

### S4: Non-mention, no session running

> **Obsolete** — see `2026041301_slack-drop-unengaged.md`. Non-mention messages in unengaged threads are now dropped.

~~Non-mention enqueued with 60s delay. After 60s, fires → runner creates/resumes session → processes.~~

### S5: Multiple rapid mentions (same thread)

Mentions fire immediately (0s delay). Each mention fires as soon as the per-key lock is free. The runner aborts the in-flight session for each new mention; opencode's abort handling collapses rapid-fire aborts into the terminal state the runner waits on before sending the next prompt. No gateway-side debounce window.

### S6: Non-mention pending, then mention arrives (same thread)

> **Obsolete** — see `2026041301_slack-drop-unengaged.md`. Non-mention messages in unengaged threads are now dropped, so this scenario no longer applies. In engaged threads, non-mentions use 3s delay (same as mentions).

~~Non-mention at T+0 (readyAt=T+60). Mention at T+10 (readyAt=T+13). Batch has interrupt events → readiness based on interrupt-only readyAt = T+13. Both fire together. Mention pulls non-mention forward.~~

### S7: Mention fires, session starts, then non-mention arrives

> **Obsolete** — see `2026041301_slack-drop-unengaged.md`. After a mention creates a session and Thor replies, the thread becomes engaged — subsequent non-mentions use 3s delay instead of 60s.

~~Mention fires at T, session starts. Non-mention at T+5 (readyAt=T+65). After 65s, fires with `interrupt: false` → runner returns `{busy: true}` → retried until session finishes.~~

### S8: Mention in thread A while session runs for thread B

Different correlation keys. Independent per-key locks. No cross-key blocking.

## Implementation

### Queue (`queue.ts`)

- Per-key lock only (`Map<string, Promise>`). No global lock.
- `EventHandler` signature: `(events, ack) => Promise<void>`. Handler calls `ack()` to delete files.
- Files stay on disk until acked. Handler errors delete files (prevent infinite retry).
- `flush()` uses `ackCount` to detect progress and stop when all handlers defer.
- When interrupt events exist in a batch, readiness uses `max(readyAt)` of interrupt events only.

### Gateway (`app.ts`, `service.ts`)

- All trigger functions accept `interrupt` flag + `onAccepted` callback.
- `onAccepted` is called after runner accepts (before stream consumption).
- If runner returns `{busy: true}`, `onAccepted` is not called — files stay for retry.
- `hasRunnerSession` removed. Non-mentions always get 60s delay.
- GitHub mention detection via `githubEventMentions()` using existing payload schemas.
- `GIT_USER_NAME` env var (shared with remote-cli) configures the username to detect.
- Config: `interruptDelayMs` (default 3s), `unaddressedDelayMs` (default 60s).

### Runner (`index.ts`)

- `interrupt` field on `TriggerRequestSchema` (optional boolean, defaults to false).
- When `interrupt=false` and session is busy → return 200 with `{busy: true}`.
- When `interrupt=true` → abort as before.
- `GET /sessions` endpoint removed (no callers).

## Decision log

| #   | Decision                                                       | Rationale                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Handler stays fire-and-forget                                  | Runner handles abort/resume. Awaiting would hold locks for minutes.                                                                                                                                                |
| D2  | Drop global lock, keep per-key only                            | Global lock blocks unrelated keys. Per-key is correct granularity.                                                                                                                                                 |
| D3  | Fix at both layers (gateway + runner)                          | Remove `hasRunnerSession` so non-mentions get 60s delay. Runner also checks interrupt flag as defense in depth.                                                                                                    |
| D4  | At-least-once via ack callback                                 | Don't delete files until runner accepts. Crash or busy → files stay for retry. Duplicates are fine (opencode handles them).                                                                                        |
| D5  | `interrupt` defaults to false (safe by default)                | New sources should not interrupt. Only Slack mentions and GitHub @mentions set `interrupt: true`.                                                                                                                  |
| D6  | Standardize delays: interrupt=0s, non-interrupt=60s            | Interrupt events fire immediately (users expect instant response when they @mention). Non-interrupt events wait, hoping someone else handles it.                                                                   |
| D7  | Engaged-thread heuristic for Slack (3s if Thor replied before) | If Thor has `slack_post_message` in worklog notes → user expects Thor to stay responsive. Uses short delay without interrupt.                                                                                      |
| D8  | Defer similar heuristic for GitHub                             | GitHub interactions go through `bash` (gh CLI), so the tool name is too generic to reliably detect engagement. Revisit when we have a clearer signal (e.g. dedicated GitHub MCP tools or richer worklog metadata). |
