# Workspace Config File

Replace env-var-based repo/channel configuration with a single JSON config file (`/workspace/repos.json`) parsed by a shared zod schema in `@thor/common`.

## Motivation

The current approach uses three env vars (`SLACK_CHANNEL_REPOS`, `SLACK_ALLOWED_CHANNEL_IDS`, `SESSION_CWD`) spread across gateway and runner. As we add more per-repo config (branch filters, event filters, prompt prefixes), this format becomes fragile and hard to maintain. A JSON file is easier to validate, extend, and reason about.

## Phases

### Phase 1: Config schema and parser in `@thor/common`

**What:**

- Create `packages/common/src/workspace-config.ts`
- Zod schema: `WorkspaceConfigSchema` with `defaultDirectory` (optional string) and `repos` (record of repo name → `{ channels?: string[] }`)
- `loadWorkspaceConfig(path: string)`: reads file, parses JSON, validates with zod, throws descriptive error on failure
- `getAllowedChannelIds(config)`: returns `Set<string>` — union of all `channels` arrays across repos
- `getChannelRepoMap(config)`: returns `Map<string, string>` — channel ID → repo name
- `getRepoDirectory(config, repoName)`: returns `/workspace/repos/{name}`
- `resolveRepoDirectory(config, repoName)`: returns the directory path if it exists on disk, `undefined` if not (caller logs warning and drops the event). Path is constructed from config — never from user/webhook input — so path traversal is not possible
- `isAllowedDirectory(config, directory)`: validates a directory string is under an allowed prefix (`/workspace/repos/` or `/workspace/worktrees/`) and resolves to a known repo. Used by runner to reject arbitrary paths from trigger requests
- Export everything from `packages/common/src/index.ts`

**Exit criteria:**

- `loadWorkspaceConfig` throws with a clear message for: missing file, invalid JSON, schema violation (missing required field, wrong type)
- Duplicate channel IDs across repos cause `loadWorkspaceConfig` to throw (fail fast)
- Unit-testable without filesystem (schema validation)

### Phase 2: Integrate into gateway

**What:**

- `packages/gateway/src/index.ts`: load config from `WORKSPACE_CONFIG` env var (default `/workspace/repos.json`), derive `allowedChannelIds` and `channelRepos` from config instead of parsing env vars
- Remove `SLACK_ALLOWED_CHANNEL_IDS` and `SLACK_CHANNEL_REPOS` env vars from gateway in `docker-compose.yml`
- Mount config file (or rely on existing `/workspace` volume mount)
- Log loaded config summary at startup
- When resolving directory for a Slack/GitHub event, use `resolveRepoDirectory` — if it returns `undefined`, log a warning and drop the event

**Exit criteria:**

- Gateway starts and correctly filters channels based on config file
- Removing a channel from config causes it to be rejected
- Gateway fails fast with clear error if config file is missing or invalid
- Events targeting a non-existent repo directory are logged and dropped (not forwarded to runner)

### Phase 3: Integrate into runner

**What:**

- `packages/runner/src/index.ts`: load config at startup, use `defaultDirectory` as fallback for `SESSION_DIRECTORY`
- Remove `SESSION_CWD` env var from runner in `docker-compose.yml`
- No startup validation of repo directories — checked at resolve time instead

**Exit criteria:**

- Runner uses `defaultDirectory` from config as session fallback
- Runner still accepts `directory` override from trigger request (for GitHub events)
- Runner validates `directory` with `isAllowedDirectory` — rejects paths outside allowed prefixes with 400
- If directory doesn't exist at trigger time, runner returns 400 (existing behavior)

### Phase 4: Remove old parsing code

**What:**

- Remove `parseAllowedChannelIds` and `parseChannelRepoMap` from `packages/common/src/channel-filter.ts`
- Remove unused env var references
- Clean up `packages/common/src/index.ts` exports if functions are no longer needed
- Keep `createChannelFilter` — it's still useful, just fed from config instead of env var

**Exit criteria:**

- No references to `SLACK_CHANNEL_REPOS` or `SLACK_ALLOWED_CHANNEL_IDS` in gateway code
- No reference to `SESSION_CWD` in runner code
- `parseAllowedChannelIds` and `parseChannelRepoMap` removed
- TypeScript compiles cleanly

## Decision Log

| #   | Decision                                          | Reason                                                                                                                                                |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | JSON file at `/workspace/repos.json`              | Already mounted via `./docker-volumes/workspace:/workspace`. No new volume needed.                                                                    |
| 2   | Zod schema in `@thor/common`                      | Both gateway and runner depend on common. Single source of truth for validation.                                                                      |
| 3   | Fail fast on invalid config                       | Better to crash at startup than silently misbehave.                                                                                                   |
| 4   | Detect duplicate channel IDs                      | One channel mapping to two repos is always a bug. Catch it early.                                                                                     |
| 5   | `defaultDirectory` is optional                    | Defaults to `/workspace` if omitted. Keeps minimal configs minimal.                                                                                   |
| 6   | Warn + drop at resolve time for missing repo dirs | Repos may be cloned after container starts. Don't crash at startup, but don't forward events to a non-existent directory either.                      |
| 7   | Validate directory paths against allowed prefixes | Prevents path traversal attacks via crafted webhook payloads. Runner normalizes and checks against `/workspace/repos/` and `/workspace/worktrees/`.   |
| 8   | Per-repo MCP via `.thor.opencode/`                | Forked OpenCode natively resolves `.thor.opencode/opencode.json` from the working directory. Slack stays global; other MCP servers are per-workspace. |
| 9   | Slack in global config only                       | Global `opencode.json` sets model + permission + Slack MCP. Other servers configured per workspace so repos only get the tools they need.             |

## Per-repo MCP configuration

MCP servers are configured per repo using `.thor.opencode/opencode.json` in the repo root. The forked OpenCode natively looks for this directory in the working directory and merges it with the global config when a session starts.

**Override semantics:** If a repo has both `.opencode/` and `.thor.opencode/`, Thor merges them with `.thor.opencode/` values taking precedence. This lets humans use OpenCode normally with `.opencode` while Thor gets its own config overlay. For agent instructions, if a repo has both `AGENTS.md` and `THOR.md`, Thor loads `THOR.md` first and ignores `AGENTS.md`/`CLAUDE.md`.

Slack is always available globally. Example `.thor.opencode/opencode.json` for a repo that also needs Atlassian and Grafana:

```json
{
  "mcp": {
    "atlassian": {
      "type": "remote",
      "url": "http://proxy:3010/mcp",
      "enabled": true
    },
    "grafana": {
      "type": "remote",
      "url": "http://proxy:3013/mcp",
      "enabled": true
    }
  }
}
```

Available MCP servers (all proxied):

| Name      | URL                     | Port |
| --------- | ----------------------- | ---- |
| slack     | `http://proxy:3012/mcp` | 3012 |
| atlassian | `http://proxy:3010/mcp` | 3010 |
| posthog   | `http://proxy:3011/mcp` | 3011 |
| grafana   | `http://proxy:3013/mcp` | 3013 |

## Out of scope

- Per-repo branch filters, event filters, prompt prefixes (future extensions to `RepoConfig`)
- Config hot-reload (restart to pick up changes is fine for now)
- Migration script from env vars to JSON (manual one-time change)
