# Dynamic Workspace Config

Make workspace configuration dynamic so changes take effect immediately without restarting services.

## Motivation

Config from `repos.json` was loaded once at startup and baked into module-level constants. Adding a Slack channel, changing repo mappings, or any config edit required restarting gateway and slack-mcp containers. This is painful when iterating on channel setup.

## Changes

### 1. Rename `repos.json` → `config.json`

Better reflects that this file configures the entire workspace, not just repos.

### 2. `createConfigLoader` in `@thor/common`

A loader that re-reads `/workspace/config.json` on every call. The file is <1KB so there's no performance concern. If the file is temporarily invalid (mid-write, syntax error), falls back to the last good config and logs a warning.

### 3. `WORKSPACE_CONFIG_PATH` constant in `@thor/common`

Single source of truth for the config file path. Replaces the `WORKSPACE_CONFIG` env var that gateway and slack-mcp each defined independently.

### 4. Gateway uses dynamic config

Replaced static `allowedChannelIds` array and `channelRepos` map with `isChannelAllowed()` and `getChannelRepos()` functions that read through the config loader on each request.

### 5. Slack MCP uses dynamic config

Same pattern — replaced static `allowedChannelIds` Set with `isChannelAllowed()` that reads through the config loader on each tool call / REST endpoint.

## Decision Log

| #   | Decision                                    | Reason                                                                                                                                                        |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No TTL cache                                | File is tiny (<1KB), readFileSync + JSON.parse is sub-millisecond. Immediate consistency beats marginal perf.                                                 |
| 2   | Fall back to last good config on read error | Prevents a transient write (e.g. editor save) from breaking running services. Logged as warning.                                                              |
| 3   | No eager validation at startup              | Services should start even if config.json doesn't exist yet. First request that needs config will surface the error.                                          |
| 4   | Hardcoded path, no env var                  | One constant in common. No reason for the path to vary per environment — it's always `/workspace/config.json` inside the container.                           |
| 5   | Proxy config stays static                   | Proxy config (`proxy.*.json`) involves upstream tool discovery and policy validation. Less frequently changed, higher complexity to reload. Not worth it now. |
