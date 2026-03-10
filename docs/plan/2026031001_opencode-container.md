# Plan — 2026031001_opencode-container

> Move OpenCode out of the runner container, make the runner connect to a configurable OpenCode URL, and enable OpenCode server password auth by default in Docker Compose.

## Decision Log

| #   | Decision                                                | Rationale                                                                   |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| D1  | Split OpenCode into its own Compose service             | Removes fragile child-process management from the runner and isolates it.   |
| D2  | Runner connects via `OPENCODE_URL`                      | Makes local testing simpler and allows targeting host or remote instances.  |
| D3  | Keep runner auth optional but enable it in Compose      | Supports both secured Compose defaults and ad hoc local instances.          |
| D4  | Use OpenCode server basic auth via env vars             | Matches current OpenCode server behavior and removes the startup warning.   |
| D5  | Expose OpenCode on `4096` in Compose                    | Useful for direct local debugging and attaching external clients.           |
| D6  | Do not make OpenCode depend on proxy at container start | Runner already depends on both services; startup ordering is cleaner there. |
| D7  | Use the published GHCR OpenCode image                   | Removes custom installer logic and makes the runtime version explicit.      |

## Phase 1 — Dedicated OpenCode Service

**Goal**: Runner stops managing a local OpenCode process and instead talks to a dedicated service over HTTP.

Steps:

1. Add dedicated OpenCode Docker assets and Compose service
2. Refactor runner to use `OPENCODE_URL` and optional auth headers
3. Remove runner-local OpenCode install/startup logic
4. Add Compose env wiring for password-protected OpenCode
5. Update docs/examples/tests for local and Compose usage

**Exit criteria**:

- `pnpm build` succeeds
- `pnpm typecheck` succeeds
- `docker compose config` succeeds with the new service topology
- Runner health reflects remote OpenCode connectivity instead of child-process state

## Out of Scope

- Multiple OpenCode replicas
- TLS termination for OpenCode
- Secret management beyond env vars
- Non-Docker deployment changes
