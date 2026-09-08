# Drata OAuth CLI Integration

## Goal

Give Thor controlled read-only access to the Drata API through OAuth client credentials, without exposing Drata credentials or access tokens to the OpenCode agent container.

## Scope

- Add a `drata` CLI wrapper routed through `remote-cli`.
- Add server-side OAuth client-credentials token minting and caching in `remote-cli`.
- Start with a generic read-only `drata api GET /public/v2/...` surface.
- Update env/docs/CI surfaces.
- Add behavior-focused policy/client tests.

Out of scope for v1:

- MCP transport.
- Drata write operations.
- Human approval schemas for Drata mutations.
- Agent-visible raw OAuth credentials or token minting.

## Phases

### Phase 1 — OAuth client and endpoint

- Add Drata env loading.
- Add Drata OAuth token cache and API GET helper.
- Add `/exec/drata` endpoint.
- Add read-only argument policy.

Exit: `drata api GET /public/v2/...` returns Drata JSON via remote-cli.

### Phase 2 — Agent wrapper and docs

- Add OpenCode `drata` wrapper.
- Update agent docs/skill, README, `.env.example`, compose, and CI env blocks.

Exit: operators know which OAuth vars to set and the agent can call the wrapper without seeing secrets.

### Phase 3 — Verification

- Add targeted unit tests for policy and OAuth behavior.
- Run targeted tests/typecheck where practical.

Exit: targeted tests pass.

## Decision Log

| Decision | Choice | Rationale |
| --- | --- | --- |
| Transport | remote-cli REST wrapper, not MCP | User explicitly asked to put MCP aside; repo already uses this pattern for read-heavy integrations. |
| Initial access | `GET` only under `/public/v2/` | Matches Drata's public API v2 path while keeping the wrapper read-only. |
| Token handling | Cache access tokens in remote-cli with a refresh buffer | Drata OAuth access tokens are short-lived; agent must not mint or hold them. |

## Exit Criteria

- Drata OAuth credentials are scoped to `remote-cli` only.
- `drata api GET /public/v2/...` is available from OpenCode.
- Non-GET and non-`/public/v2/` requests are denied by policy.
- Docs and env surfaces are updated.
- Targeted tests pass.
