# Workspace Config

> Consolidated 2026-05-26 from three plans: `2026032102_workspace-config-file.md`
> (original — JSON config file + zod schema), `2026033101_dynamic-config.md`
> (dynamic re-read + merged proxy config), and `2026041701_hardcode-proxies.md`
> (proxies moved to a TS constant). The other two files were deleted; their live
> decisions live here, their dead phases live in git history.

Single workspace config file (`/workspace/config/thor.json`) parsed by a shared zod schema in `@thor/common`. Read dynamically on every access (no restart for changes). MCP upstreams (atlassian, grafana, posthog, slack) are hard-coded in a `PROXY_REGISTRY` constant in `@thor/common`, not in the config file.

## Current state

### Config schema (`packages/common/src/workspace-config.ts`)

```ts
WorkspaceConfigSchema = {
  owners?:                Record<string, { github_app_installation_id: number }>,
  users?:                 Array<{ email, name, slack?, github? }>,
  slack?:                 { private_channel_allowlist?: string[] },
  mitmproxy?:             MitmproxyRule[],
  mitmproxy_passthrough?: string[],
}
```

No `repos` block. No `proxies` block. Channel→repo routing is handled outside the config file (see "Channel routing" below).

### Loader

- `loadWorkspaceConfig(path)` — read, parse JSON, validate with zod. Throws with a clear message on missing file / invalid JSON / schema violation.
- `createConfigLoader(path)` — returns a `() => WorkspaceConfig` that re-reads the file on every call. On read failure it falls back to the last good config and logs a warning; if no previous config exists, it throws.
- `WORKSPACE_CONFIG_PATH = "/workspace/config/thor.json"` — hard-coded path, no env var.

### Proxy registry (`packages/common/src/proxies.ts`)

`PROXY_REGISTRY: Record<string, ProxyConfig>` is a checked-in TypeScript constant with four entries (`atlassian`, `grafana`, `posthog`, `slack`). Each entry carries the upstream URL, optional headers (with `${ENV_VAR}` interpolation applied at connect time), and `allow` / `approve` tool lists. Every directory under `/workspace/repos/` has access to every upstream — there is no per-repo opt-in.

`getProxyConfig(name)` and `PROXY_NAMES` are exported. `ProxyConfig` / `ProxyUpstream` types live in `workspace-config.ts` (no zod schemas — nothing parses this shape from JSON).

### Single proxy process, path-prefix routing

One proxy process on port 3001. Routes:

```
POST /:upstream                       MCP endpoint
GET  /:upstream/approval/:id          approval status
POST /:upstream/approval/:id/resolve  approval resolution
GET  /health                          global health (all upstreams)
```

Approval button values use `v2:{actionId}:{upstreamName}` (encoding the upstream name, not a port). Proxy emits `Proxy-Name: {upstream}` headers.

### Channel routing

Slack channel → repo routing is **not** in the config file:

- `SLACK_DEFAULT_REPO` env var sets the fallback repo for every channel.
- `/workspace/memory/thor/repo-by-slack-channel/{channelId}.txt` files override the default per channel (agent-writable).
- `resolveSlackChannelRepoDirectory()` in `workspace-config.ts` reads the override file, falls back to the default, and returns the resolved on-disk directory.

### Per-repo MCP overlay

Per-repo overlays go in `.thor.opencode/opencode.json` in the repo root. The forked OpenCode merges this with the global config when a session starts. If a repo has both `.opencode/` and `.thor.opencode/`, `.thor.opencode/` wins. For agent instructions, `THOR.md` is loaded first and `AGENTS.md` / `CLAUDE.md` are ignored when `THOR.md` exists.

## Decision log

Live decisions only. Provenance column shows which original plan introduced the decision: **WC** = `2026032102_workspace-config-file`, **DC** = `2026033101_dynamic-config`, **HP** = `2026041701_hardcode-proxies`.

| #   | From | Decision                                                              | Rationale                                                                                                                                              |
| --- | ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | WC   | JSON config file mounted via the existing `/workspace` volume         | No new mount, no new bind volume. Path is hard-coded inside the container.                                                                             |
| 2   | WC   | Zod schema in `@thor/common`                                          | Gateway, runner, remote-cli all depend on common. Single source of truth.                                                                              |
| 3   | WC   | Fail fast on invalid config at startup                                | Better to crash with a clear error than silently misbehave.                                                                                            |
| 4   | WC   | Validate `directory` paths against `WORKSPACE_REPOS_ROOT`             | Prevents path traversal via crafted webhook payloads. `isAllowedDirectory` normalizes and prefix-checks.                                               |
| 5   | DC   | No TTL cache — re-read `config.json` on every access                  | File is tiny, `readFileSync + JSON.parse` is sub-millisecond. Immediate consistency.                                                                   |
| 6   | DC   | Fall back to last-good config on read error                           | Prevents transient writes (mid-edit, partial JSON) from breaking running services. Logged as warning.                                                  |
| 7   | DC   | Hard-coded config path constant, no env var                           | Always `/workspace/config/thor.json` inside the container.                                                                                             |
| 8   | DC   | Single proxy process, path-prefix routing on one port                 | Visible in logs, easy to test with curl, simple MCP client config (just a URL). One process, simpler docker-compose, no port allocation bookkeeping.   |
| 9   | DC   | `v2:{actionId}:{upstreamName}` approval button format                 | Encodes upstream name instead of port. Path-prefix routing requires a name, not a port.                                                                |
| 10  | DC   | Upstream URL/header changes require restart                           | Reconnecting with different credentials mid-session is complex and error-prone. Rare operation.                                                        |
| 11  | HP   | `PROXY_REGISTRY` in `@thor/common`, not in `config.json`              | Service endpoints (`grafana-mcp:8000`), SaaS URLs, and `allow`/`approve` lists are security policy. Code review is the right gate, not an ops edit.    |
| 12  | HP   | `${ENV_VAR}` interpolation in registry headers                        | Atlassian token and PostHog key are deploy-time secrets. Interpolation runs at connect time, same as when these were in JSON.                          |
| 13  | HP   | `WorkspaceConfigSchema` uses `.strict()` — reject extra top-level keys | Greenfield project. A stray `proxies: {...}` or `repos: {...}` should fail loud at startup, not silently drift from reality.                          |
| 14  | HP   | Injectable registry via `McpServiceDeps`                              | Preserves test isolation (each test sets up its own upstreams). Zero-cost for production (default param).                                              |
| 15  | HP   | No per-repo policy overrides                                          | Not needed today. Adding one later is a schema extension (`repos[name].allow?`), not a re-architecture.                                                |
| 16  | —    | Channel routing via memory files, not config                          | Channel → repo mapping is agent-mutable runtime state, not deploy-time config. Lives under `/workspace/memory/thor/repo-by-slack-channel/`.            |

## History

**2026-03-21 — Workspace config file introduced.** Replaced three env vars (`SLACK_CHANNEL_REPOS`, `SLACK_ALLOWED_CHANNEL_IDS`, `SESSION_CWD`) with a single JSON file (`/workspace/repos.json`) and a zod schema in `@thor/common`. Original shape had `defaultDirectory` and a `repos` block mapping repo name → `{ channels?: string[] }`. Per-repo MCP overlays moved to `.thor.opencode/opencode.json` at the same time.

**2026-03-31 — Dynamic config + merged proxy config.** Renamed `repos.json` → `config.json`. Added `createConfigLoader` (re-reads on every call, no cache, last-good fallback). Merged four `proxy.*.json` files and the `PROXY_INSTANCES` env var into a top-level `proxies` block in `config.json`. Collapsed four proxy processes into one with path-prefix routing on a single port. Approval button format went from `v1:{actionId}:{proxyPort}` to `v2:{actionId}:{upstreamName}`.

**2026-04-17 — Hard-coded upstream registry.** Moved the `proxies` block out of `config.json` and into `PROXY_REGISTRY` in `@thor/common`. Service endpoints, SaaS URLs, and `allow`/`approve` lists are security policy — code review is the right gate, not an ops-side config edit. Dropped `ProxyConfigSchema` / `ProxyUpstreamSchema` and the reserved-name validation (names are no longer user input). Per-repo opt-in (`repos[name].proxies`) survived this change.

**2026-05-16 — `repos` block removed entirely.** Per-repo opt-in dropped: every directory under `/workspace/repos/` now has access to every upstream in `PROXY_REGISTRY`. Channel→repo routing moved to `SLACK_DEFAULT_REPO` + per-channel override files under `/workspace/memory/thor/repo-by-slack-channel/`. `WorkspaceConfig` now carries only `owners`, `users`, `slack`, `mitmproxy`, and `mitmproxy_passthrough`.

## Out of scope

- Per-repo policy overrides (allow/approve per repo).
- Adding upstreams beyond the registry's four — future additions require a code change (by design).
- Config hot-reload of upstream URLs/headers (requires restart; documented above).
- A CLI/admin surface to list registered upstreams.
