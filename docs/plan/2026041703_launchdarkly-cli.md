# LaunchDarkly CLI Integration

**Date**: 2026-04-17
**Status**: Draft

## Goal

Give the Thor agent **strictly read-only** access to LaunchDarkly via its official `ldcli`, so it can inspect feature flags, environments, segments, and rollout state from within an OpenCode session. Mutations (toggle, update, create, delete) are explicitly out of scope for this plan.

## Why

LaunchDarkly is the source of truth for runtime feature state. Read-only CLI access lets the agent:

- Answer "is flag X on for env prod?" while debugging a Slack-reported issue
- Cross-reference a Langfuse trace failure with the flag/segment state at that time

## Architecture

Follows the existing **remote-cli pattern** (same as `git`, `gh`, `langfuse`, `metabase`, `scoutqa`). The binary, wrapper, endpoint, env-var prefix, and policy function all use the canonical name `ldcli` for consistency:

```
OpenCode agent
  → ldcli (wrapper script in docker/opencode/bin/, calls remote-cli.mjs)
    → remote-cli service POST /exec/ldcli
      → ldcli binary (authenticated via LD_ACCESS_TOKEN env var)
        → LaunchDarkly REST API (app.launchdarkly.com)
```

- **No MCP server** — LaunchDarkly publishes an official MCP server (`@launchdarkly/mcp-server`), but its primary value is structured tool calls for mutations. Since this plan is strictly read-only, the CLI exec pattern is consistent with `langfuse`/`metabase`/`gh` and avoids a second transport.
- **Policy enforcement server-side** — remote-cli validates resource/action/flag allowlists before executing.
- **Credentials scoped to remote-cli container** — `LD_ACCESS_TOKEN` (and optional `LD_BASE_URI`, `LD_PROJECT`, `LD_ENVIRONMENT`) are env vars on the remote-cli service only, never exposed to the agent container.
- **Strictly read-only** — every `create`/`update`/`delete`/`toggle`/`replace` action is denied. No mutating subcommands, no mutating flags, no filesystem writes. If a future need for mutations appears, it gets a separate plan with approval-flow integration.

## Phases

### Phase 1 — remote-cli endpoint + read-only policy

Add `POST /exec/ldcli` to the remote-cli service with a strict read-only policy.

1. **Install `ldcli`** in the remote-cli Dockerfile target
   - `npm install -g @launchdarkly/ldcli@2.2.0` in the remote-cli build stage
   - Pinned to the latest npm-published release available during implementation
   - Verify `ldcli --version` works

2. **Add endpoint** in `packages/remote-cli/src/index.ts` (mirror the `/exec/langfuse` block, lines 184–210)
   - `POST /exec/ldcli` — same shape as `/exec/langfuse`
   - Body: `{ args: string[], cwd?: string }` (cwd accepted but ignored, default `/workspace`)
   - Response: `{ stdout, stderr, exitCode }`
   - Inject `LD_ACCESS_TOKEN` (and optional `LD_BASE_URI`) from service env via the existing `execCommand` env passthrough; do not echo the token to logs
   - Always append `--output json` to args when not already present, so output is machine-readable
   - Use `MAX_OUTPUT = 1024 * 1024` (1 MB) to handle larger flag lists

3. **Add policy** in `packages/remote-cli/src/policy.ts` (mirror the `validateLangfuseArgs` block, lines 281–351)
   - Function: `validateLdcliArgs(args)` — strict allowlist, deny everything else
   - **Resource allowlist** (first arg) — only what's needed for read-only debugging:
     - `flags`, `environments`, `projects`, `segments`, `metrics`
   - **Resource denylist** (explicit, anything else is also denied by allowlist):
     - Mutating / interactive: `dev-server`, `setup`, `login`, `sourcemaps`
     - PII / org admin: `members`, `teams`
     - Local config (could leak injected settings, no read-only need): `config`
     - Discovery (allowlist + skill doc cover this — no need for runtime enumeration): `resources`
     - Deferred until concrete need: `audit-log`, `experiments`, `holdouts`, `releases`, `release-pipelines`, `webhooks`, `code-refs`, `ai-configs`
   - **Action allowlist** (second arg) — strictly read-only:
     - `list`, `get`, `--help`
   - **Per-resource action constraints** (tighter than the global allowlist):
     - `metrics` → `list` only (no `get` — listing alone covers the cross-reference workflow; revisit if proven necessary)
   - **Required scoping** (defense in depth — agent must always specify scope):
     - `flags`, `environments`, `segments`, `metrics` → must include `--project <key>` somewhere in args (rejects accidental org-wide scans)
   - **Flag denylist** (rejected anywhere in args, both `--flag value` and `--flag=value` forms):
     - `--access-token` (forces the agent to use the server-side token only)
     - `--config` (prevents pointing at an attacker-controlled config file)
     - `--data`, `--data-file` (mutation payloads — defense in depth even though every mutating action is already denied)
     - `--output-file` (prevents arbitrary filesystem writes)
     - `--curl` (would print a curl command containing the access token to stdout)

4. **Unit tests** in `packages/remote-cli/src/policy.test.ts` (mirror the langfuse test block)
   - Allowed:
     - `flags list --project default`
     - `flags get my-flag --project default --environment production`
     - `environments list --project default`
     - `segments list --project default --environment production`
     - `metrics list --project default`
     - `flags list --project default --help`
   - Blocked (action / mutation):
     - `flags create --project default ...`
     - `flags update my-flag --project default ...`
     - `flags delete my-flag --project default`
     - `flags toggle my-flag --project default`
     - `flags replace my-flag --project default ...`
   - Blocked (resource):
     - `members list`, `teams list`, `config --list`, `config --set ...`
     - `dev-server`, `login`, `setup`, `sourcemaps upload`
     - `resources`, `audit-log list --project default`, `experiments list --project default`, `releases list --project default`
   - Blocked (per-resource action constraint):
     - `metrics get my-metric --project default`
   - Blocked (missing required scope):
     - `flags list` (no `--project`)
     - `environments list` (no `--project`)
   - Blocked (flag denylist):
     - `flags list --project default --access-token leaked`
     - `flags get my-flag --project default --data '{"on":true}'`
     - `flags list --project default --output-file /tmp/x`
     - `flags list --project default --curl`
     - `flags list --project default --config /tmp/evil.yml`
   - Edge cases: empty args, non-array args, single bare unknown resource

**Exit criteria:**

- [ ] `corepack pnpm -r build` succeeds
- [ ] `corepack pnpm -r typecheck` succeeds
- [ ] `corepack pnpm test` passes (including new policy tests)
- [ ] `POST /exec/ldcli` with `["flags", "list", "--project", "default", "--limit", "5"]` returns flag JSON
- [ ] `POST /exec/ldcli` with `["flags", "create", ...]` is rejected with a clear policy error
- [ ] `POST /exec/ldcli` with `["flags", "list"]` (no `--project`) is rejected with a clear policy error

### Phase 2 — Docker + OpenCode wrapper

1. **Update `docker-compose.yml`** — add `LD_ACCESS_TOKEN`, optional `LD_BASE_URI`, `LD_PROJECT`, `LD_ENVIRONMENT` to the `remote-cli` service `environment` block (mirror the `LANGFUSE_*` entries).

2. **Update `.env.example`** — add the same entries with placeholder values and a comment pointing at the LaunchDarkly access-tokens admin page. Note that the token only needs **Reader** role (not Writer/Admin) for this plan.

3. **Add OpenCode wrapper** at `docker/opencode/bin/ldcli`
   - Two-line shell script:
     ```sh
     #!/bin/sh
     exec node /usr/local/bin/remote-cli.mjs ldcli "$@"
     ```
   - Wrapper named `ldcli` (matches the binary, the endpoint, and LD's own docs).

4. **Update `Dockerfile`** — ensure the new wrapper is copied to the OpenCode image and made executable (same pattern as `git`, `gh`, `langfuse`).

**Exit criteria:**

- [ ] `ldcli flags list --project default --limit 5` works from inside the OpenCode container and returns JSON
- [ ] `ldcli flags create ...` is rejected by policy with a clear error
- [ ] `LD_ACCESS_TOKEN` is not visible inside the OpenCode container (only inside remote-cli)

### Phase 3 — Skill + docs

1. **Create LaunchDarkly skill** at `/workspace/memory/launchdarkly.md` (or bundled in the Docker image, matching the Langfuse precedent)
   - CLI syntax: `ldcli <resource> <action> [options]`
   - Discovery: `ldcli <resource> --help` (the `ldcli resources` enumeration command is denied by policy — refer to this skill doc for the supported resource list)
   - Auth model: token is server-side; never pass `--access-token`
   - Output: `--output json` is auto-appended; inspect JSON fields directly
   - Scope: scoped resource calls for `flags`, `environments`, `segments`, and `metrics` require `--project <key>`; flag/segment lookups also typically need `--environment <key>`
   - Cheat sheet (top read-only queries):
     - List flags in a project: `ldcli flags list --project default --limit 50`
     - Get one flag's full state: `ldcli flags get <flag-key> --project default --environment production`
     - List environments in a project: `ldcli environments list --project default`
     - List segments for an env: `ldcli segments list --project default --environment production`
     - List metrics in a project: `ldcli metrics list --project default`
   - Gotchas:
     - `--project` is mandatory by policy; omitting it gets a 400 from remote-cli, not from LD
     - `ldcli flags get` returns per-environment state in `environments[<env-key>]`
     - Strictly read-only — `toggle` / `update` / `create` / `delete` are all denied. Surface that limitation up to the human if a mutation is needed.

2. **Add `ldcli` to `docker/opencode/config/agents/build.md` Environment section** — one-line addition to the tools list (next to `gh`, `langfuse`, `metabase`).

3. **Update `docs/feat/mvp.md`** — add LaunchDarkly to the integration list.

**Exit criteria:**

- [ ] LaunchDarkly skill file exists with syntax, cheat sheet, gotchas
- [ ] `build.md` lists `ldcli` in available tools
- [ ] Architecture docs reflect the new integration

## Decision Log

| #   | Decision                                                                                 | Reason                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Remote-CLI pattern, not MCP server                                                       | Consistent with `langfuse`/`metabase`/`gh`. MCP's main value is structured mutation tools; this plan has no mutations.                                                                  |
| 2   | Official `@launchdarkly/ldcli` (not custom REST client)                                  | Maintained by LD, covers every API resource, handles auth + JSON output. Same reasoning as `langfuse-cli`.                                                                              |
| 3   | Strictly read-only policy                                                                | Mutating LD state has real production blast radius. Land safe read access first; any mutation work gets its own plan with approval-flow integration.                                    |
| 4   | Use `ldcli` everywhere (wrapper name, endpoint name, env prefix `LD_*`, policy function) | Consistency with the upstream binary and LD's own docs. Reduces translation cost when the agent reads LD docs vs. invokes the wrapper.                                                  |
| 5   | Drop `members`, `teams`, `config` from the resource allowlist                            | `members`/`teams` are PII without a current debugging need. `config` could leak the injected access-token surface even if the value itself is redacted; no read-only workflow needs it. |
| 6   | `metrics` restricted to `list` only (no `get`)                                           | Listing alone covers the cross-reference workflow. Drop `get` until a concrete need appears — easier to widen than narrow.                                                              |
| 7   | Drop `resources` (the LD discovery command)                                              | The skill doc and policy allowlist already enumerate every supported resource. Runtime enumeration would advertise resources the policy denies, which is misleading.                    |
| 8   | Mandatory `--project` scope for `flags`, `environments`, `segments`, `metrics`           | Forces the agent to be explicit, prevents accidental org-wide scans, and gives clearer audit logs.                                                                                      |
| 16  | Drop `audit-log` from the allowlist                                                      | No concrete read-only debugging workflow currently needs it; cross-referencing recent flag changes can be done via `flags list` ordering. Re-add later if a need appears.               |
| 9   | Block `dev-server`, `login`, `setup`, `sourcemaps`                                       | Interactive / port-binding / write-only — none usable inside an automated container.                                                                                                    |
| 10  | Block `--access-token`, `--config`, `--data`, `--data-file`, `--output-file`, `--curl`   | Defense in depth. `--curl` is specifically denied because ldcli will print the access token in the rendered command.                                                                    |
| 11  | Always append `--output json`                                                            | Agent needs machine-readable output, mirrors langfuse `--json` precedent.                                                                                                               |
| 12  | 1 MB output buffer for the ldcli endpoint                                                | Flag lists in mature projects can run to hundreds of KB; default 256 KB risks silent truncation. Same as langfuse.                                                                      |
| 13  | Pin `@launchdarkly/ldcli` to `2.2.0`                                                     | Prevent surprise breaking changes from unpinned global install, and use the latest version actually published on npm during implementation.                                             |
| 14  | Credentials only on remote-cli service                                                   | Same isolation pattern as `GH_TOKEN`, `LANGFUSE_*`, `METABASE_*` — agent container never sees the token.                                                                                |
| 15  | Token requires only Reader role                                                          | Strictly read-only policy means a Reader token is sufficient and minimises blast radius if the env leaks.                                                                               |

## Out of Scope

- **Any mutation** — `toggle`, `update`, `create`, `delete`, `replace` are all denied by policy. A future plan can revisit, with approval-flow integration and per-environment guardrails.
- LaunchDarkly MCP server transport — only relevant once mutations are in scope.
- `members`, `teams`, `config`, `dev-server`, `sourcemaps`, `audit-log`, `experiments`, `holdouts`, `releases`, `release-pipelines`, `webhooks`, `code-refs`, `ai-configs` resources — add to allowlist when a concrete read-only need appears.
- `metrics get` — widen if listing alone proves insufficient.
- Multi-project / multi-account support beyond a single `LD_ACCESS_TOKEN` — single project sufficient for now.
- Federal endpoint (`app.launchdarkly.us`) — supported via optional `LD_BASE_URI` env var, but not exercised in tests.
- Opinionated investigation skills (`why-is-flag-X-on-for-env-Y`, `what-changed-in-the-last-hour`) — separate plan once raw access is validated.
