# Memory Model

Thor uses global, channel, and person memory for durable agent-only context while
repo-specific context stays in repo-local docs and agent instructions.

## Tiers

| Tier         | Path                                          | Injected by runner?                                                        | Use for                                                                                        |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Global       | `/workspace/memory/README.md`                 | Yes, on new or stale sessions                                              | Rare cross-cutting Thor context, durable corrections, workspace-wide operating notes.          |
| Channel      | `/workspace/memory/channels/<channel-id>.md`  | Yes, when `correlationKey` is `slack:thread:<channel>/<ts>`                | Durable team/channel preferences, recurring channel workflows, channel-specific norms.         |
| Person       | `/workspace/memory/people/<email-local-part>.md` | Yes, when the trigger actor resolves through `/workspace/config/thor.json` | Durable user preferences, identity context, preferred follow-up style, stable ownership hints. |
| Repo context | Repo-local `AGENTS.md`, `CLAUDE.md`, and docs | Delegated to OpenCode/repo files                                           | Product facts, codebase conventions, runbooks, and anything humans should review in git.       |

## Person Files

Person memory filenames are deterministic and simple:

1. take the email local-part from `users[].email`
2. lowercase it
3. use that directly as the filename

Examples:

- `john.doe@example.com` → `people/john.doe.md`
- `acme@example.com` → `people/acme.md`

## Read Policy

On a new or stale OpenCode session, the runner builds bootstrap context in this
order: global memory, Slack channel memory when addressable, person memory when
the trigger actor resolves, tool instructions, triggering-user attribution, then
the user prompt. Missing or empty memory files are non-fatal. Memory progress
events list only files actually read, not suggested paths.

Normal resumed sessions do not receive memory bootstrap again. The correlation
key is still added to every prompt.

For non-trivial recurring work, prefer searching `/workspace/runs/` before
`/workspace/worklog/` because run directories usually have denser reusable task
context. Use worklog for prior-session continuity and audit/execution history.

## Write Policy

- Write global memory only for rare workspace-wide context that would help future
  unrelated tasks.
- Write channel memory for durable context tied to how a Slack channel/team works.
- Write person memory for stable preferences or identity context about a resolved user.
- Do not write repo facts, implementation decisions, or product runbooks to Thor
  memory; add or update repo-local docs instead.
- Do not store ephemeral task state, raw tool output, secrets, or personal data
  beyond what is already appropriate in `users[]`-backed operational context.
