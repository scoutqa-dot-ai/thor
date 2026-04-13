# Drop Unengaged Slack Messages — 2026-04-13-01

> Non-mention messages in threads where Thor has never replied should be silently dropped instead of forwarded with a 60s delay.

## Motivation

Currently, all non-mention messages in allowlisted channels are forwarded to the runner — just with different delays (3s if engaged, 60s if not). This means Thor processes messages in threads it was never invited to, wasting compute and potentially confusing users.

The desired behavior: Thor only processes a Slack message if:

1. It's an `app_mention` (someone explicitly tagged `@thor`), OR
2. It's a non-mention in a thread where Thor has already replied (existing worklog)

## Changes

### Phase 1 — Gateway filter

In `packages/gateway/src/app.ts`, the `message` handler (lines 388–422):

- After computing `correlationKey` and checking `hasSlackReply()`, **drop** the event if `!engaged` instead of enqueueing with a 60s delay.
- Log as `event_ignored_not_engaged` for observability.
- Remove `UNADDRESSED_DELAY_MS` constant and `unaddressedDelayMs` config field (no longer used).

### Phase 2 — Documentation

- **README.md**: Update "Smart batching" line to reflect new behavior.
- **`2026032101_mention-interrupt.md`**: Mark obsolete rows/scenarios with a note pointing to this plan.
- **`2026031002_slack-app.md`**: Mark D12/D14 and Phase 4 references as superseded.

## Decision log

| #   | Decision                                       | Rationale                                                                       |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| D1  | Drop unengaged messages entirely               | Simpler than delayed forwarding. Users must `@mention` to start a conversation. |
| D2  | Keep `hasSlackReply()` as the engagement check | Already works correctly — checks for `slack:thread:` alias in notes.            |
| D3  | Mark old plan sections as obsolete, not edit   | Preserve historical context per team convention.                                |

## Supersedes

- `2026032101_mention-interrupt.md` — rows "Slack `message` (not engaged)" and scenarios S3, S4, S6, S7 (non-mention portions)
- `2026031002_slack-app.md` — D12, D14, Phase 4 step 2/4
