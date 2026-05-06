# Trigger Viewer Event List

**Date**: 2026-05-05
**Status**: Implemented

## Goal

Replace the raw trigger-slice dump with a simple operator-first list view for authenticated `/runner/v/:anchorId/:triggerId` pages.

## Phase 1 — list-based viewer

- Render a compact header with source, status, duration/last-event age, anchor/trigger/session ids, and warning rows.
- Render normalized meaningful events instead of raw OpenCode JSON.
- Render tool rows with tool name/status for every tool; show arguments only for the strict safe allowlist: `read`, `glob`, and `grep`.
- Do not render raw bash commands or unsafe MCP/write-tool arguments.
- Warn when payloads are truncated, subsessions exist, multiple sessions are bound to the anchor, trigger records mismatch, or a trigger is superseded/crashed.

## Decision log

| Decision                                 | Rationale                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Keep v1 list-based, not a full dashboard | Latest operator direction favored a simple event list over richer source/effects extraction.                   |
| Diagnostics remain sanitized             | Operators can verify record boundaries without exposing full OpenCode events, bash commands, or tool payloads. |

## Verification

- `pnpm exec vitest run packages/runner/src/trigger.test.ts`
- `pnpm --filter @thor/runner typecheck`
