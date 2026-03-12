# Move Slack Progress & Reactions from Gateway to slack-mcp

**Date**: 2026-03-12
**Branch**: `feat/slack-ephemeral-message`
**Status**: Implementation complete — committed
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

### Progress Message Lifecycle (unchanged behavior, new location)

1. **Threshold**: No message until 3+ tool calls
2. **Initial post** after threshold: `⏳ Working... 3 tool calls | 10s elapsed | last: Read, Grep, Edit`
3. **Periodic updates** every ~10s: edit same message
4. **Completion**: Edit to `✅ Done — N tool calls in Xm Ys`, register for cleanup
5. **Auto-cleanup**: When `post_message` MCP tool posts to same thread → delete progress message immediately (no webhook delay)
6. **Timeout**: If no bot reply within 60s → keep progress message as evidence
7. **Error**: Edit to `❌ Failed — error message after N tool calls`

### What Changed

| Package     | Change                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway`   | Removed `@slack/web-api` dep, `SlackNotifier`, `pendingCleanups`. Added `SlackMcpDeps` with HTTP calls to slack-mcp. Removed `SLACK_BOT_TOKEN` from config.                                                      |
| `slack-mcp` | Added `POST /progress`, `POST /reaction` endpoints. New `progress-manager.ts` with `ProgressSession` class and `pendingCleanups` registry. Auto-delete hook in `post_message` MCP tool handler. Added `zod` dep. |
| `common`    | Added `SlackProgressRequestSchema`, `SlackReactionRequestSchema` and their types.                                                                                                                                |
| `runner`    | No change (still streams NDJSON)                                                                                                                                                                                 |

## Decision Log

| #   | Decision                                          | Rationale                                                                                                   |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | slack-mcp owns all Slack API calls                | Single credential boundary. Gateway becomes Slack-agnostic.                                                 |
| 2   | Auto-delete via `post_message` hook, not webhooks | Eliminates the race window. slack-mcp knows immediately when the bot replies — no waiting for Slack events. |
| 3   | REST endpoints (not MCP tools) for progress       | Gateway isn't an MCP client. Simple HTTP POST is the right interface.                                       |
| 4   | Shared Zod schemas in `@thor/common`              | Type safety at the boundary. Both producer (gateway) and consumer (slack-mcp) reference the same schema.    |

## Out of Scope

- Same items as original plan (see `2026031103_slack-ephemeral-message.md`)
