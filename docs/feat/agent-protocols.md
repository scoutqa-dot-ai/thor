# Agent Protocols

Directional index for Thor's multi-agent handoff protocols.

## Source Of Truth

Prompt-level behavior lives in:

- `docker/opencode/config/agents/build.md`
- `docker/opencode/config/agents/coder.md`
- `docker/opencode/config/agents/thinker.md`

This file is intentionally not a copy of those prompts. If behavior changes,
update the prompt files first, then update this index only if the protocol
catalogue or ownership model changed.

## Why Protocols Exist

Protocols give multi-hop Thor work a shared task state so the primary agent and
subagents do not re-narrate context on every hop. They are prompt-guided
conventions, not a workflow engine.

## Shared Substrate

Protocols use per-run scratch directories under `/workspace/runs`. The exact
README shape, role contract, and artifact naming are defined in the prompt
files.

Per-repo `AGENTS.md` / `CLAUDE.md` conventions still win for durable repo
artifacts.

Runner-injected memory is limited to global, Slack channel, and person tiers; see
[`memory.md`](memory.md) for the memory model and read/write policy.

## Current Protocols

| Protocol      | Used for                            | Primary prompt owner     | Subagent roles                                      |
| ------------- | ----------------------------------- | ------------------------ | --------------------------------------------------- |
| Code change   | Non-trivial implementation work     | `build.md`               | `thinker:plan`, `coder:implement`, `thinker:review` |
| Investigation | Debugging, root-cause, and analysis | `build.md`, `thinker.md` | `thinker:investigate`                               |

## Protocol Ownership

- `build.md` owns orchestration: when to use a protocol, how to frame work, and
  when to stop.
- `coder.md` owns implementation-role behavior.
- `thinker.md` owns planning, review, and investigation-role behavior.
- This document owns only the catalogue and design intent.

## Adding A Protocol

Add a new protocol when the work class recurs, benefits from shared state across
agent hops, and has a clear stop condition.

Checklist:

1. Define the orchestration behavior in `build.md`.
2. Define any new `Role:` value in the relevant subagent prompt.
3. Add focused tests or smoke coverage if the protocol has machine-observable behavior.
4. Add one row to this document's catalogue.
5. Avoid copying prompt grammar into this document.
