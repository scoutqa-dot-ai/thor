# Move Slack Progress & Reactions from Gateway to slack-mcp

**Date**: 2026-03-12
**Branch**: `feat/slack-ephemeral-message`
**Status**: Updated — race condition fix committed
**Supersedes**: `2026031103_slack-ephemeral-message.md`

## Problem

The original progress message design (plan `2026031103`) had gateway owning Slack API calls via `@slack/web-api`. This created two problems:

1. **Duplicate Slack credentials** — both gateway and slack-mcp needed `SLACK_BOT_TOKEN`
2. **Cleanup relied on Slack event webhooks** — when the bot posted a reply via slack-mcp's `post_message` MCP tool, gateway had to wait for the Slack event webhook to echo the message back, then delete the progress message. This introduced a race window and required a 60s timeout fallback.

## Goal

Make slack-mcp the single Slack-credentialed component. Gateway becomes Slack-agnostic and communicates with slack-mcp via REST endpoints.

## Design

### Architecture

```
Gateway ──(trigger)──▶ Runner
   │                      │
   │  ◀── NDJSON stream ──┘
   │
   ├── POST /progress ──▶ slack-mcp ──▶ Slack: chat.postMessage / chat.update / chat.delete
   └── POST /reaction ──▶ slack-mcp ──▶ Slack: reactions.add
                              │
                              └── post_message MCP tool ──▶ auto-delete progress in same thread
```

### New slack-mcp REST Endpoints

| Endpoint         | Body (Zod-validated)                          | Purpose                       |
| ---------------- | --------------------------------------------- | ----------------------------- |
| `POST /progress` | `{ channel, threadTs, event: ProgressEvent }` | Forward progress events       |
| `POST /reaction` | `{ channel, timestamp, reaction }`            | Add emoji reaction to message |

Shared Zod schemas (`SlackProgressRequestSchema`, `SlackReactionRequestSchema`) live in `@thor/common`.

### Progress Message Lifecycle

1. **Threshold**: No message until 3+ tool calls
2. **Initial post** after threshold: `⏳ Working... 3 tool calls | 10s elapsed | last: Read, Grep, Edit`
3. **Register immediately**: Message is tracked in the progress registry (`Map<threadKey, Map<messageTs, { status, deps }>>`) as `"in_progress"` the moment it's posted to Slack — before `finish()` runs
4. **Periodic updates** every ~10s: edit same message
5. **Completion**: Edit to `✅ Done — N tool calls in Xm Ys`, update status to `"completed"`
6. **Auto-cleanup**: When `post_message` MCP tool posts to same thread → delete all non-error progress messages for that thread
7. **Error**: Edit to `❌ Failed — error message after N tool calls`, update status to `"error"` (preserved on cleanup)

### What Changed

| Package     | Change                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway`   | Removed `@slack/web-api` dep, `SlackNotifier`, `pendingCleanups`. Added `SlackMcpDeps` with HTTP calls to slack-mcp. Removed `SLACK_BOT_TOKEN` from config.                                                                                                                                                                                          |
| `slack-mcp` | Added `POST /progress`, `POST /reaction` endpoints. New `progress-manager.ts` with `ProgressSession` class and thread-keyed progress registry (`Map<threadKey, Map<messageTs, ProgressEntry>>`). Messages registered as `"in_progress"` at post time to avoid race conditions. Auto-delete hook in `post_message` MCP tool handler. Added `zod` dep. |
| `common`    | Added `SlackProgressRequestSchema`, `SlackReactionRequestSchema` and their types.                                                                                                                                                                                                                                                                    |
| `runner`    | No change (still streams NDJSON)                                                                                                                                                                                                                                                                                                                     |

## Decision Log

| #   | Decision                                          | Rationale                                                                                                                                                                                                                |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | slack-mcp owns all Slack API calls                | Single credential boundary. Gateway becomes Slack-agnostic.                                                                                                                                                              |
| 2   | Auto-delete via `post_message` hook, not webhooks | slack-mcp knows immediately when the bot replies — no waiting for Slack events.                                                                                                                                          |
| 5   | Register progress at post time, not finish time   | Fixes race condition: if bot replies before `finish()` completes, the message was not yet registered for cleanup. By registering as `"in_progress"` immediately in `post()`, `onBotReply` can always find and delete it. |
| 6   | Status-aware cleanup (preserve errors)            | `onBotReply` deletes all non-error progress messages. Error messages are kept as evidence for debugging.                                                                                                                 |
| 7   | No expiry timer on progress registry              | Simplicity over correctness for edge cases. Entries are tiny and process restarts clear them.                                                                                                                            |
| 3   | REST endpoints (not MCP tools) for progress       | Gateway isn't an MCP client. Simple HTTP POST is the right interface.                                                                                                                                                    |
| 4   | Shared Zod schemas in `@thor/common`              | Type safety at the boundary. Both producer (gateway) and consumer (slack-mcp) reference the same schema.                                                                                                                 |

## Out of Scope

- Same items as original plan (see `2026031103_slack-ephemeral-message.md`)

## Bug Fix — Slack delegate visibility for task tool calls (2026-04-25)

### Problem

Runner progress emission only converted `subtask` parts into `delegate` events. OpenCode `task` tool invocations now carry sub-agent metadata in `state.input.subagent_type` and `state.input.description`, and current runs emit no `subtask` parts. This made delegated work invisible in Slack progress.

### Fix

- Added runner-side delegate extraction for `tool` parts where `part.tool === "task"`.
- Emit one `delegate` progress event per task invocation when `state.input.subagent_type` is a non-empty string; include trimmed `description` when present.
- Apply extraction to both parent session parts and forwarded child-session parts.
- Added dedupe so repeated updates for the same task invocation do not emit duplicate delegate events.

### Validation

- Added slack-mcp progress-manager test to verify delegate events still render in the Slack progress line (`agents: ...`) without descriptions.
