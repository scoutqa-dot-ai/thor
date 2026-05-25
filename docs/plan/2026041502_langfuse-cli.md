# Langfuse CLI Integration

**Date**: 2026-04-15
**Status**: Draft

## Goal

Give the Thor agent access to the Langfuse CLI (`langfuse-cli` npm package) so it can query traces, sessions, observations, metrics, and other Langfuse resources from within an OpenCode session.

## Why

Langfuse stores LLM traces, sessions, tool calls, costs, and latency metrics. Giving the agent CLI access lets it:

- Investigate user issues by pulling traces and conversation history
- Query cost and usage metrics for reporting
- Search for specific tool calls, skill activations, and error patterns
- Cross-reference Langfuse user IDs with Metabase identity data

## Architecture

Follows the existing **remote-cli pattern** (same as `git`, `gh`, `scoutqa`):

```
OpenCode agent
  → langfuse (wrapper script, calls remote-cli.mjs)
    → remote-cli service POST /exec/langfuse
      → langfuse-cli binary (authenticated via env vars)
        → Langfuse REST API (us.cloud.langfuse.com)
```

- **No MCP server needed** — Langfuse is a read-heavy analytics API, not an action-oriented tool. The CLI pattern (`langfuse api <resource> <action> [options]`) maps naturally to exec-and-return, like `gh pr list`.
- **Policy enforcement server-side** — remote-cli validates allowed resources and actions before executing.
- **Credentials scoped to remote-cli container** — `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_HOST` are env vars on the remote-cli service only, never exposed to the agent container.

## Phases

### Phase 1 — remote-cli endpoint + policy

Add `POST /exec/langfuse` to the remote-cli service with server-side policy.

1. **Install `langfuse-cli`** in the remote-cli Dockerfile target
   - `npm install -g langfuse-cli@0.0.8` in the build stage (pinned version)
   - Verify `langfuse --version` in healthcheck or entrypoint

2. **Add endpoint** in `packages/remote-cli/src/index.ts`
   - `POST /exec/langfuse` — same pattern as `/exec/gh`
   - Body: `{ args: string[], cwd?: string }` (cwd accepted but ignored, default `/workspace`)
   - Response: `{ stdout, stderr, exitCode }`
   - Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` from service env
   - Use `MAX_OUTPUT = 1024 * 1024` (1 MB) for this endpoint to handle large trace responses
   - Always append `--json` to args if not already present (machine-readable output)

3. **Add policy** in `packages/remote-cli/src/policy.ts`
   - `validateLangfuseArgs(args)` — allowlist approach:
   - First arg must be `api` (block `get-skill` and any future subcommands)
   - Second arg (resource) allowlist:
     - `traces`, `sessions`, `observations`, `metrics`, `models`, `prompts`
     - `__schema` (self-discovery, no action required, no additional args)
   - Block: `ingestions` (write-only), `projects`/`organizations` (admin),
     `datasets`/`dataset-items`/`dataset-run-items`/`annotation-queues`/`comments` (not needed for Phase 1)
   - Third arg (action) allowlist: `list`, `get`, `--help`
   - Block write actions: `create`, `update`, `delete`, `upsert`
   - Block bare resource with no action (e.g., `api traces` alone)
   - Flag denylist: reject args containing `--config`, `--output-file`, `--output` (filesystem access)
   - Special case: `metrics list` is the only metrics action (it takes `--query` JSON)

4. **Unit tests** in `packages/remote-cli/src/policy.test.ts`
   - Allowed: `api traces list --limit 10`, `api sessions get <id>`, `api metrics list --query '...'`, `api __schema`, `api prompts list`, `api traces list --help`
   - Blocked: `api ingestions create`, `api projects list`, `api traces create`, `get-skill`, `api datasets list`, `api __schema create`
   - Edge cases: empty args, non-array args, missing resource, missing action, dangerous flags (`--config`, `--output-file`), unknown resource

**Exit criteria:**

- [ ] `corepack pnpm -r build` succeeds
- [ ] `corepack pnpm -r typecheck` succeeds
- [ ] `corepack pnpm test` passes (including new policy tests)
- [ ] `POST /exec/langfuse` with `["api", "traces", "list", "--limit", "5"]` returns traces

### Phase 2 — Docker + OpenCode wrapper

1. **Update `docker-compose.yml`**
   - Add `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` to `remote-cli` service environment

2. **Update `.env.example`**
   - Add `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` entries

3. **Add OpenCode wrapper** in `docker/opencode/bin/langfuse`
   - Shell script: `exec node /usr/local/bin/remote-cli.mjs langfuse "$@"`
   - Same pattern as the existing `git`, `gh`, `scoutqa` wrappers

4. **Update Dockerfile** — ensure wrapper is copied and executable

**Exit criteria:**

- [ ] `langfuse api traces list --limit 5` works from inside OpenCode container
- [ ] `langfuse api ingestions create` is rejected by policy
- [ ] Env vars are not visible inside the OpenCode container

### Phase 3 — Langfuse skill + docs

1. **Create Langfuse skill** at `/workspace/memory/langfuse.md` (or bundled into the Docker image)
   - Standalone skill file the agent loads when investigating Langfuse issues
   - Not inlined into `build.md` — keeps the main agent instructions lean
   - Content:
     - CLI syntax: `langfuse api <resource> <action> [options]`
     - Discovery: `langfuse api __schema`, `langfuse api <resource> --help`
     - Response envelope: all responses wrap in `{ok, status, body}`, list data at `.body.data[]`, pagination at `.body.meta`
     - Gotchas: trace IDs are full 32-char hex, cursor-based pagination for observations (vs page-based for traces), large traces can be multi-MB
     - Cheat sheet with the 5 most common queries:
       - List recent traces: `langfuse api traces list --limit 10 --from-timestamp "..." --fields "core,metrics"`
       - Get specific trace: `langfuse api traces get <id>`
       - Metrics by model: `langfuse api metrics list --query '{...}'`
       - Filter by user: `langfuse api traces list --filter '[{"type":"string","column":"userId","operator":"=","value":"<uuid>"}]'`
       - List observations for user: `langfuse api observations list --user-id "<uuid>" --type "TOOL"`
     - Pagination patterns (page-based for traces, cursor-based for observations)

2. **Add `langfuse` to build.md Environment section** — one-line addition to the tools list (line 66), no detailed docs
   - Example: add `langfuse` (Langfuse CLI) to the available tools enumeration

3. **Update `docs/feat/mvp.md`** — add Langfuse to the integration list

**Exit criteria:**

- [ ] Langfuse skill file exists and covers CLI syntax, gotchas, and cheat sheet
- [ ] `build.md` lists `langfuse` in available tools
- [ ] Architecture docs reflect new integration

## Decision Log

| #   | Decision                                                  | Reason                                                                                                                                                                                               |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Remote-CLI pattern, not MCP server                        | Langfuse is read-only analytics — no tool-call semantics needed. CLI exec is simpler, matches existing `gh`/`scoutqa` pattern, and avoids building+maintaining an MCP tool schema for 12+ resources. |
| 2   | `langfuse-cli` npm package (not custom HTTP client)       | Existing, maintained CLI with OpenAPI-driven resource discovery. Handles auth, pagination args, and JSON output. Avoids reimplementing the Langfuse REST API.                                        |
| 3   | Read-only policy (block create/update/delete/upsert)      | Thor agent has no write use case for Langfuse. Traces are created by instrumentation, not by Thor. Read-only eliminates accidental data mutation.                                                    |
| 4   | Block `ingestions`, `projects`, `organizations` resources | `ingestions` is a write endpoint. `projects`/`organizations` are admin operations that could leak org-level config or mutate settings.                                                               |
| 5   | Accept but ignore `cwd` in request body                   | Langfuse is not repo-scoped. Shared client sends cwd automatically, endpoint ignores it.                                                                                                             |
| 6   | Credentials on remote-cli service only                    | Same isolation pattern as `GH_TOKEN` — agent container never sees the Langfuse keys.                                                                                                                 |

| 7 | Pin langfuse-cli@0.0.8 | Prevent surprise breaking changes from unpinned npm global install. |
| 8 | 1 MB output buffer for langfuse endpoint | Default 256KB truncates large trace JSON silently. 1MB handles 95%+ of queries. |
| 9 | Always append --json to args | Agent needs machine-readable output, not human-readable tables. |
| 10 | Flag denylist (--config, --output-file, --output) | Prevent filesystem write via CLI flags. |
| 11 | Narrow Phase 1 allowlist to core resources | Only traces, sessions, observations, metrics, models, prompts. Add datasets/comments later. |
| 12 | **schema special case (no action required) | Discovery command has different syntax. Block additional args after **schema. |

## Out of Scope

- Langfuse write operations (creating scores, datasets, annotations) -- add later if needed
- Custom MCP tool wrappers for Langfuse (premature given CLI covers all use cases)
- Streaming responses for large trace fetches -- use 1MB buffer + `--limit` for now
- Multi-environment Langfuse project selection -- single project sufficient for now
- Opinionated investigation workflows (`investigate-user`, `trace-for-thread`) -- Phase 2 after raw access validated
- Datasets, dataset-items, dataset-run-items, annotation-queues, comments resources -- add to allowlist when needed
