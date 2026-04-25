# Slack progress context expansion

## Goal

Expand the Slack progress message so long-running sessions can also show:

- memory files read/written while working
- agent delegations made through OpenCode task/subtask flow
- the existing tool-call count and latest 3 tool groups

## Scope

**In scope**

- Add shared progress event types for memory activity and agent delegation
- Emit bootstrap memory reads, memory-file tool access, and subtask delegations from `runner`
- Render the new context in `slack-mcp` progress updates
- Update relay/test coverage as needed across `common`, `gateway`, `runner`, and `slack-mcp`

**Out of scope**

- Parsing arbitrary bash commands for memory access
- Rich per-agent lifecycle beyond recent delegation summary
- Reworking the 3-tool-call threshold behavior

## Phases

### Phase 1 — Progress message context

**Changes**

- Extend `ProgressEventSchema` with typed `memory` and `delegate` events
- Teach `runner` to emit:
  - bootstrap memory reads for injected memory files
  - memory read/write activity for explicit file tools targeting `/workspace/memory`
  - delegate events from subtask parts
- Update `slack-mcp` progress state/formatting to show tool count, latest 3, memory activity, and delegated agents together in one compact message
- Update tests for schema forwarding and progress rendering

**Exit criteria**

- Progress updates still post only after the existing tool threshold is crossed
- When relevant activity exists, the Slack progress message shows:
  - tool call count
  - latest 3 grouped tools
  - recent memory file read/write context
  - recent delegated agent context
- New event types relay cleanly through `gateway`
- Targeted tests for `slack-mcp` and `gateway` pass

### Phase 2 — Slack formatting follow-up

**Changes**

- Update `slack-mcp` progress rendering only:
  - agent line shows names only (no descriptions)
  - consecutive duplicate agents collapse using the same run semantics as tools
  - memory line shows compact file labels when fewer than 3 distinct recent files
  - memory line switches to action-count summary (`read`, then `write`) at 3+ distinct files
  - ambiguous filename labels stay distinguishable via compact path fallback
- Keep thresholding, update cadence, and tool count semantics unchanged
- Extend `progress-manager.test.ts` coverage for the new formatting rules

**Exit criteria**

- Slack progress agent context renders only agent names with run-based collapsing
- Slack memory context renders:
  - filenames only for <3 distinct files
  - `read xN, write xM` summary for 3+ distinct files
  - distinguishable labels for ambiguous same-name files
- Existing threshold behavior and tool grouping behavior remain unchanged

## Decision log

| #   | Decision                                                                           | Rationale                                                                       | Rejected                                                 |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Add distinct `memory` and `delegate` progress events instead of overloading `tool` | Keeps tool count semantics stable while allowing Slack to render richer context | Encoding memory/agent details into tool names            |
| 2   | Emit bootstrap memory only for files actually injected                             | Avoids noisy "none yet" status lines                                            | Emitting placeholder memory events                       |
| 3   | Track recent memory/delegate context separately from latest tools                  | User asked to show them together with, not instead of, tool count/latest 3      | Replacing latest tool groups with mixed activity history |
| 4   | Render delegate descriptions nowhere in Slack progress text                        | Slack follow-up requested names-only to reduce noise                            | Keeping `agent: description` formatting                  |
| 5   | Use filename-first memory labels with path fallback for collisions                 | Keeps Slack output compact while preserving clarity for duplicate filenames     | Always showing full memory paths                         |
