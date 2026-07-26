# Memory Tiers

Replace runner-injected per-repo memory with global, Slack channel, and person
memory tiers, and document the resulting read/write policy.

## Goal

Simplify Thor's durable prompt-memory model so repo-scoped context comes from the
active repo's own `AGENTS.md`, `CLAUDE.md`, and docs, while runner bootstrap
injects only:

1. global memory from `/workspace/memory/README.md`
2. channel memory from `/workspace/memory/channels/<channel-id>.md`
3. person memory from `/workspace/memory/people/<email-local-part>.md`

The change should update runner bootstrap behavior, tests, and durable docs so
the memory model is explicit and consistent.

## Scope

- Runner bootstrap in `packages/runner/src/index.ts`
- Runner tests in `packages/runner/src/trigger.test.ts`
- Agent-facing prompt guidance in `docker/opencode/config/agents/build.md`
- Durable docs in `README.md`, `docs/feat/memory.md`, and related references

Out of scope:

- Replacing repo-local `AGENTS.md` / `CLAUDE.md` behavior in OpenCode
- Adding topic-based memory selection
- Tight filesystem/tool-level enforcement for per-tier write policy

## Decision Log

| #   | Decision                                                                                           | Rationale                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Remove runner-injected per-repo memory                                                             | Repo-scoped context should live in repo-local docs/instructions that humans and agents share.                                              |
| D2  | Keep three injected tiers only: global, channel, person                                            | Simpler prompt model with clearer ownership and less accidental context stacking.                                                          |
| D3  | Person memory path uses lowercased email local-part only                                           | Keeps filenames simple and deterministic, matching configured user identity in `users[]`.                                                  |
| D4  | Prefer `/workspace/runs/` over `/workspace/worklog/` for dense reusable recall on non-trivial work | Run dirs carry higher-signal curated task context; worklog remains continuity/audit history.                                               |
| D5  | Do not add extra runner validation for Slack channel ids in this change                            | Channel ids come from Thor's signed Slack webhook intake path, so this boundary is treated as trusted input for the channel-memory lookup. |

## Phases

### Phase 1 — Runner bootstrap

- Remove per-repo memory injection.
- Inject global memory on new/stale sessions.
- Inject channel memory only when `correlationKey` is `slack:thread:<channel>/<ts>`.
- Inject person memory only when the triggering actor resolves through
  `/workspace/config/thor.json` `users[]` and has an email.

### Phase 2 — Tests

- Update runner tests to cover:
  - global + channel + person injection on new sessions
  - resumed sessions not re-injecting bootstrap memory
  - unknown actors skipping person memory
  - GitHub actor resolution to person memory via configured email

### Phase 3 — Documentation

- Document the new memory tiers and read/write policy.
- Clarify that repo context belongs in repo-local docs.
- Update prompt guidance to prefer `/workspace/runs/` for dense recall on
  non-trivial work and `/workspace/worklog/` for continuity/audit history.

## Exit Criteria

- Runner no longer injects per-repo memory.
- New/stale sessions inject only the documented global/channel/person tiers.
- Tests cover the new tier behavior and pass.
- Durable docs in the repo describe the memory model and decision boundaries.
