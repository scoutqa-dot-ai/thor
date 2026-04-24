# people-memory — 2026-04-24-01

## Problem

Thor currently injects root and repo memory for new/stale sessions, but has no structured people memory. This prevents durable user-specific context from being attached safely and consistently when Slack users trigger work.

## Scope

**In scope:**

- Add people memory files under `/workspace/memory/people/*.md` with YAML frontmatter identifier keys and markdown body.
- Add generic trigger identifiers from gateway to runner (`{ type, value }[]`) instead of prompt-text parsing.
- Resolve matching people memory files in runner and inject them for new/stale sessions (not resumed sessions).
- Handle duplicate identifier claims safely by warning and skipping ambiguous identifiers.
- Add targeted tests in gateway and runner for identifier forwarding and people memory matching/injection behavior.
- Update memory docs: minimal `build.md` guidance plus detailed memory skill doc.

**Out of scope:**

- Prompt NLP extraction of person identifiers.
- New memory backends or non-markdown file formats.
- Auto-writing people memory from runtime events.
- New third-party dependencies.

## Decisions

| Date       | Decision                                                                       | Why                                                               |
| ---------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 2026-04-24 | Use trigger `identifiers: Array<{ type: 'slack' \| 'github'; value: string }>` | Keeps runner contract generic for current Slack and future GitHub |
| 2026-04-24 | Parse frontmatter with a minimal built-in parser (`---` + simple `key: value`) | Satisfies format needs without adding dependencies                |
| 2026-04-24 | On duplicate identifier claims, skip ambiguous identifier and warn             | Avoids silently attaching wrong person context                    |

## Phases

### Phase 1 — Docs + contract

**Tasks:**

- Add this plan.
- Document people memory model in a new memory skill doc.
- Keep memory instructions in `build.md` minimal and point to the skill doc.
- Extend runner trigger schema for generic identifiers.

**Exit criteria:**

- Plan and docs describe root/repo/people memory responsibilities.
- Trigger payload contract supports typed identifiers without parsing prompt text.

### Phase 2 — Identifier plumbing (gateway → runner)

**Tasks:**

- Update gateway Slack trigger path to forward Slack user IDs as `identifiers`.
- Deduplicate repeated Slack users and skip missing user IDs.

**Exit criteria:**

- Runner receives structured identifiers from gateway on Slack-triggered runs.
- Gateway tests verify dedupe + missing-user behavior.

### Phase 3 — Runner people-memory matching + injection

**Tasks:**

- Add `packages/runner/src/people-memory.ts` helpers to parse frontmatter, index people files by identifiers, resolve matches with ambiguity handling, and build prompt blocks.
- Refactor runner prompt assembly so injection order is explicit and maintainable.
- Inject people memory only when session is new or stale (not resumed).

**Exit criteria:**

- Matching works for slack/github identifiers from frontmatter.
- Ambiguous identifiers are skipped with warnings.
- People memory is included for new/stale sessions and omitted for resumed sessions.

### Phase 4 — Targeted tests

**Tasks:**

- Add gateway tests for forwarded Slack identifiers.
- Add runner tests for frontmatter parsing/matching, ambiguity skipping, and new/stale-only injection behavior (helper-level acceptable).

**Exit criteria:**

- Targeted tests pass for changed gateway/runner paths.
- No new dependencies added.
