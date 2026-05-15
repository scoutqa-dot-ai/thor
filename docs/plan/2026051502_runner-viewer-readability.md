# Runner Viewer — Readability Pass

**Date**: 2026-05-15
**Status**: In progress
**Depends on**: `docs/plan/2026050502_trigger-viewer-event-list.md`, `docs/plan/2026051501_admin-sessions-external-keys.md`

## Goal

Make `/runner/v/:anchorId/:triggerId` easy to read at a glance.

Today it dumps a flat `<ol>` of "tool / text / step finish" rows, four full UUIDs, a generic "Thor trigger" title, a wall of sanitized JSON, an `<meta refresh=5>` flash loop, and a `$0.0000` cost line that is always zero in this corpus. A 7 MB session file with 92 triggers and 25%-truncated `opencode_event` lines is unreadable in that shape.

After this pass the page shows decoded facts (source link, summary numbers, titled tool rows, real diffs, slack-post bubbles), drops everything admins can read in the JSONL anyway (sanitized diagnostics, warnings, autoplay refresh, cost), and stays static — a small `● live` indicator is the only signal while the trigger is in flight.

## Scope

In scope:

- One file: `packages/runner/src/index.ts` (renderer + supporting helpers in the same module).
- Wire `SLACK_TEAM_ID` env into the runner alongside the admin service.
- Update `packages/runner/src/trigger.test.ts` assertions to match the new HTML.

Out of scope (parking for later plans):

- Sibling-trigger sidebar for multi-trigger sessions (a session file holds up to ~90 triggers; navigation between them is its own feature).
- SSE / live streaming. Page stays static; admin refreshes manually.
- Removing the legacy "trigger viewer" event-log plumbing in `@thor/common` — only the rendering layer changes.

## Data findings driving the design

From surveying ~1,099 JSONL session files in `docker-volumes/workspace/worklog/sessions/`:

| Finding                                                                                                       | UI implication                                           |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `tool_call` top-level records: **0 occurrences**                                                              | Remove the dead render branch.                           |
| `~25%` of `opencode_event` records are `{ _truncated: true }`                                                 | Aggregate into one factual count line; no per-event row. |
| `cost` is always `0` in this corpus                                                                           | Drop the dollar line.                                    |
| `correlationKey`: 64% `slack:`, 35% `git:`, 1% `cron:`; `promptPreview` is structured JSON for slack & github | Parse it; build a clickable header link.                 |
| Tool `state.title` is a Claude-generated description (`"Lists test-management Thor worktrees"`)               | Use it as the row label; raw input behind `<details>`.   |
| `bash` p50 230 chars, max 3,206; multiline is the norm                                                        | Render as a `<pre>`, not inline `<code>`.                |
| `slack-post-message` bash commands are the agent's outward voice                                              | Render as a chat bubble (`💬 → #channel`).               |
| `apply_patch` parts carry a real unified diff in `input.patchText`                                            | Render with `+ / -` line coloring.                       |
| `task` tool launches subagents with a multi-paragraph prompt                                                  | Nested collapsible card.                                 |
| Same `part.id` is updated up to 4× as text/reasoning streams in                                               | Dedup by `id`; keep last seen state.                     |
| `session.status: busy` heartbeats and empty `reasoning` parts are pure noise                                  | Filter from the activity list.                           |
| `trigger_end.status: aborted` carries `reason: user_interrupt                                                 | shutdown`                                                | Show reason on the pill — distinguishes "user stopped" from "stranded". |

## Decisions

| Decision                  | Choice                                                                                          | Why                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto-refresh              | **Drop `<meta http-equiv=refresh>`**                                                            | Admin refreshes when they want fresh data; the flash loop scrolls past content. A static `● live` indicator on the pill is the only signal while in flight. |
| Warnings block            | **Drop entirely**                                                                               | Admin reads the page; hedging like "may be incomplete" adds noise. Facts only.                                                                              |
| Sanitized diagnostics     | **Drop entirely**                                                                               | The JSONL on disk is the source of truth for engineers; the redacted echo wastes screen and shrouds intent.                                                 |
| Cost line                 | **Drop entirely**                                                                               | Always `$0.0000` in the corpus. Re-add only when cost is real.                                                                                              |
| `tool_call` render branch | **Delete**                                                                                      | Zero records of this type in any session file.                                                                                                              |
| Slack permalink env       | **`SLACK_TEAM_ID`, optional**                                                                   | Same shape and behavior as admin (`packages/admin/src/views.ts:41`). Without it, channel/user IDs render as plain text.                                     |
| Where the env is read     | **Runner + admin**                                                                              | Runner now needs it for its viewer; admin already does. Other services don't.                                                                               |
| GitHub link source        | **`promptPreview` JSON** (`pull_request`, `issue`, `repository.full_name`, `head.ref`, `after`) | No env needed; `https://github.com/<repo>/...` is constructible.                                                                                            |
| Step grouping             | **`<details>` per `step-finish` boundary**, last step open by default                           | Real sessions chain 5–15 steps; a single flat ribbon is unscannable.                                                                                        |
| Stream dedup              | **By `part.id`, keep last seen state**                                                          | Avoids 4× duplicate assistant text rows when streaming.                                                                                                     |
| Truncated events          | **One aggregated muted footer line**                                                            | "14 opencode events were truncated at write time and are not shown." — fact-only.                                                                           |
| Activity row cap          | **Keep `MAX_MEANINGFUL_ROWS = 100`** with the existing "earlier rows omitted" header            | Bounded HTML size; cheap rendering.                                                                                                                         |

## Phases

### Phase 1 — Strip & summary

Remove the parts the admin asked to drop and reshape the header. No new data parsing yet.

- `packages/runner/src/index.ts`:
  - Drop the `<meta http-equiv=refresh>` line.
  - Drop the entire `Warnings` block (and the unused `warnings`/`mismatched`/`isStale`/`truncatedCount` setup that fed it — except `truncatedCount` which feeds the new footer line).
  - Drop the `<details>` "Sanitized diagnostics" block; delete `diagnosticRecords` and `redactRecord` helpers.
  - Drop `cost` from the step-finish row and from the summary line.
  - Delete the `record.type === "tool_call"` branch (dead code).
  - Replace the four-line ID block with a single chip row: short IDs with full UUID in `title`, owner/current session shown only when they differ from the trigger's owner.
  - Add a one-line summary strip under the title: `status · duration · N tokens · N tools · N errors · last event Xs ago`.
  - Add a `● live` span inside the pill when `slice.status === "in_flight"` (CSS pulse, no JS).
  - Add a one-line factual footer when truncated count > 0: `N opencode events were truncated at write time and are not shown.`
  - Pill abort reason: `[aborted · user_interrupt]` / `[aborted · shutdown]` when present.
- `packages/runner/src/trigger.test.ts`:
  - Replace the assertions that lock the dropped strings (`cost $0.0123`, `Subsessions exist`, `Multiple OpenCode sessions`, `records for another trigger`, `middle record(s) omitted from diagnostics`, `1 step finish row(s), $0.0123 total cost, 42 total tokens`) with assertions that lock the new fact-only summary, the chip row, and the truncated-footer line.
  - Keep the redaction/secret-leak assertions; they apply to the activity rows that remain.

**Exit**: `pnpm --filter @thor/runner test` passes. Page renders for a sample session with the four sections only: pill + summary, chip row, trigger context, activity list.

### Phase 2 — Source-decoded header

Parse `promptPreview` and `correlationKey` to render a real one-line source link.

- `packages/runner/src/index.ts`:
  - New helpers `decodeSlackPrompt`, `decodeGithubPrompt`, `decodeCronPrompt` returning `{ icon, label, href? }`.
  - Slack permalink: `https://app.slack.com/client/<team>/<channel>/thread/<channel>-<ts>` when `SLACK_TEAM_ID` is set.
  - GitHub PR: prefer `pull_request.html_url`; else `https://github.com/<repo>/pull/<n>`.
  - GitHub Issue: prefer `issue.html_url`; else `https://github.com/<repo>/issues/<n>`.
  - GitHub push: `https://github.com/<repo>/commit/<sha7>` from `after` or `head.sha`.
  - Cron: no link; first sentence of the prompt as the label.
  - Unknown / unparseable: first line of `promptPreview` as plain text.
  - Read `process.env.SLACK_TEAM_ID?.trim() || null` at app construction and thread through to `renderSlicePage`.
  - `<title>` includes the decoded source (e.g. `"#thor-dev · Slack — Thor trigger"`).
- Env discipline (AGENTS.md §6):
  - `docker-compose.yml`: add `SLACK_TEAM_ID=${SLACK_TEAM_ID:-}` to the `runner` service block.
  - `README.md` env table: extend the `SLACK_TEAM_ID` row to include `runner` alongside `admin` in the "Used by" column.
  - `.env.example`: comment updated to mention "admin sessions dashboard and runner trigger viewer".
- `packages/runner/src/trigger.test.ts`:
  - With `SLACK_TEAM_ID` set, assert the Slack permalink href appears.
  - Without it, assert the channel/user labels render as plain text (no `href`).
  - GitHub PR fixture: assert PR # and link href.

**Exit**: tests cover all four source shapes (slack, github PR, github issue, cron); page renders a clickable source line. Compose + README + .env.example updated in the same commit.

### Phase 3 — Activity quality

Make the activity list informative without expanding.

- `packages/runner/src/index.ts`:
  - Use `state.title` (when string) as the primary tool row label; fall back to `viewerToolDisplayName(part)`.
  - Wrap each tool row body (input/output/error) in a per-row `<details>` so the default view is a one-liner. `bash` commands render the full `state.input.command` in a `<pre>` inside the details.
  - Special-case `apply_patch`: detect by `tool === "apply_patch"`. Default-expanded `<details>` showing changed paths from `title` and the `input.patchText` rendered with `+ / -` line coloring (plain CSS, no library).
  - Special-case `slack-post-message` bash: detect `state.input.command` starting with the binary. Render as a chat-bubble row (`💬 → #channel ts <fmt>`), extracting the heredoc body as the message text. Raw command behind `<details>`.
  - `task` tool: render as a nested card showing `input.subagent_type`, `input.description` (one line), and `input.prompt` behind `<details>`.
  - Dedup `message.part.updated` by `part.id`: walk records once, keep the latest state per id, then emit rows in first-seen order.
  - Drop rows for `session.status` and `session.idle` (the heartbeat is the pill).
  - Drop rows for `reasoning` parts whose text is empty.
  - Aggregate `_truncated` events: count only; the footer line from Phase 1 already says "N opencode events were truncated…".
- `packages/runner/src/trigger.test.ts`:
  - Tool row title appears when present; raw command lives inside `<details>`.
  - `apply_patch` fixture renders a diff with `+`/`-` classes and changed-path summary.
  - `slack-post-message` fixture renders the chat-bubble row, not a generic bash row.
  - `task` fixture renders the subagent card with the subagent type label.
  - Duplicate `part.id` updates (4× streaming) emit one row.
  - `session.status: busy` and empty `reasoning` are not rendered.

**Exit**: `pnpm --filter @thor/runner test` passes; manual spot check against the largest real session under `docker-volumes/workspace/worklog/sessions/` shows < 1 screen of noise.

### Phase 4 — Step grouping

Group activity by `step-finish` boundary and finish the static-live polish.

- `packages/runner/src/index.ts`:
  - Split the activity stream at `step-finish` parts. Each group becomes a `<details>` block with a summary line: `Step N · M tools · Xs · K tokens`.
  - Last step `open`; prior steps closed.
  - When there is only a single (or zero) `step-finish`, render flat (no `<details>`) — avoid an empty wrapper.
  - `● live` pill animation: small CSS keyframe; respect `prefers-reduced-motion`.
- `packages/runner/src/trigger.test.ts`:
  - Multi-step fixture asserts N `<details>` step blocks with the correct summary string.
  - Single-step fixture asserts no `<details>` wrapper (flat list).
  - In-flight fixture asserts the `● live` element is present; completed fixture asserts it is absent.

**Exit**: tests pass; page on a real multi-step session shows scannable step groups.

## Verification

After all four phases:

1. `pnpm --filter @thor/runner test` green locally.
2. Push branch; the runner CI workflow (`runner-tests` if present, else the umbrella E2E job) is the final gate per AGENTS.md §3.
3. Open the PR against `main` once push checks are green.

## Out-of-scope follow-ups

- Sibling-trigger navigation pills for sessions with many triggers (own plan).
- True SSE streaming of in-flight events (own plan).
- Re-enabling a cost display once a cost source emits non-zero values.
- Migrating the dropped diagnostics surface into a separate authenticated "raw" endpoint if engineers ever want it back. Today the JSONL on disk is enough.

## Decision Log

| Date       | Decision                                            | Notes                                    |
| ---------- | --------------------------------------------------- | ---------------------------------------- |
| 2026-05-15 | Drop warnings, diagnostics, auto-refresh, cost line | Admin-reviewed; "page should show fact". |
| 2026-05-15 | Reuse `SLACK_TEAM_ID` env (now read by runner too)  | Mirrors admin behavior; no new env.      |
| 2026-05-15 | Static page, no polling; `● live` indicator only    | Admin refreshes manually.                |
