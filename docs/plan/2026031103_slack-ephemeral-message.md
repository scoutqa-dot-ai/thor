# Slack Ephemeral Progress Messages

**Date**: 2026-03-11
**Branch**: `feat/slack-ephemeral-message`
**Status**: Superseded by `2026031203_slack-progress-to-slack-mcp.md`

## Problem

When a user triggers Thor via Slack, the only feedback is the initial "eyes" reaction. If the OpenCode session takes a long time (many tool calls, large codebase exploration), the user has no visibility into what's happening. They don't know if Thor is stuck, working hard, or almost done.

## Goal

Stream progress updates from the runner back to the originating Slack thread as a single, self-updating message. The message shows what Thor is currently doing and updates in-place to avoid thread noise.

## Design

### ~~Approach: Runner streams NDJSON, Gateway owns Slack~~

~~The runner streams OpenCode events as NDJSON over the `/trigger` HTTP response. The gateway consumes the stream and drives a `SlackNotifier` that posts/updates a progress message using its existing `WebClient`.~~

```
Gateway ──(trigger)──▶ Runner
   │                      │
   │  ◀── NDJSON stream ──┘
   │    { type: "tool", tool: "Read", status: "completed" }
   │    { type: "tool", tool: "Grep", status: "completed" }
   │    { type: "done", status: "completed", ... }
   │
   ├── after threshold ──▶ Slack: chat.postMessage (initial)
   ├── on progress ──▶ Slack: chat.update (edit in-place)
   └── on finish ──▶ Slack: chat.update (final status)
```

~~**Why gateway owns Slack** (not runner):~~

- ~~Gateway is the Slack-aware component — it already has `WebClient` for reactions~~
- Runner stays focused on OpenCode orchestration, no Slack coupling
- No need to pass Slack context through the trigger request
- ~~No need for REST API endpoints on slack-mcp~~

### NDJSON Event Types

| Type    | Fields                                               | When                  |
| ------- | ---------------------------------------------------- | --------------------- |
| `start` | `sessionId`, `correlationKey`, `resumed`             | Session resolved      |
| `tool`  | `tool`, `status`                                     | Each tool completes   |
| `done`  | `status`, `response`, `toolCalls`, `durationMs`, ... | Session finishes      |
| `error` | `error`                                              | Unrecoverable failure |

### Message Lifecycle

1. **Threshold**: No message posted until 3+ tool calls completed. Short runs produce no status message.
2. **Initial post**: `⏳ Working... 3 tool calls | 10s elapsed | last: Read, Grep, Edit`
3. **Periodic updates** (every ~10 seconds): Edit the same message with new info
4. **Final update** on completion:
   - Success: `✅ Done — 18 tool calls in 1m 23s`
   - Error: `❌ Failed — session error after 15 tool calls`

### What Changes

| Package     | Change                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| `runner`    | Stream NDJSON progress events in `/trigger` response; remove all Slack awareness        |
| `gateway`   | ~~Consume NDJSON stream; `SlackNotifier` class uses `WebClient` for progress messages~~ |
| `slack-mcp` | ~~Revert to original (no `update_message` tool, no REST endpoints)~~                    |
| `proxy`     | No change                                                                               |

## Decision Log

| #   | Decision                                             | Rationale                                                                                                                 |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Single updating message, not multiple thread replies | Reduces noise. One message edited in-place is less disruptive than 10 progress replies.                                   |
| 2   | ~~Gateway owns Slack progress, not runner~~          | ~~Gateway is the Slack-aware component. Runner stays focused on OpenCode. Clean separation of concerns.~~                 |
| 3   | NDJSON streaming from runner                         | Lightweight, no new dependencies. Gateway reads line by line. Works with existing HTTP transport.                         |
| 4   | Threshold before posting (3+ tools)                  | Avoid posting a progress message for quick tasks that complete in a few tool calls.                                       |
| 5   | Update interval ~10 seconds                          | Slack rate limits `chat.update` to ~50/min per channel. 10s is well within limits and frequent enough to feel responsive. |
| 6   | ~~Gateway uses WebClient directly~~                  | ~~Already has the client for reactions. No need for MCP tool or REST API intermediary.~~                                  |

## Out of Scope

- Final response posting to Slack (the agent already does this via its own `post_message` tool call)
- Ephemeral messages (Slack's `chat.postEphemeral`) — these can't be updated after posting, defeating the purpose
- Rich Block Kit formatting — plain text with emoji is sufficient for MVP
- Progress for non-Slack triggers (cron, Linear) — can be added later with same pattern
