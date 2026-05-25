# Dynamic Workspace Config

> **Partially superseded (2026-05-16):** The `repos` and channels blocks shown in
> this plan have been removed. The `createConfigLoader` mechanism still exists and
> still serves `owners` / `mitmproxy` / `mitmproxy_passthrough`. See current
> `packages/common/src/workspace-config.ts`.

Single `config.json` for the entire workspace — repos, channels, and MCP proxies. All config is dynamic (no restart required) except upstream connection details.

## Motivation

Config was scattered across `repos.json`, 4 `proxy.*.json` files, `PROXY_INSTANCES` env var, and `WORKSPACE_CONFIG` env var. Adding a Slack channel or a tool to an allow list required restarting containers. Adding a new MCP upstream required editing docker-compose.

## Phase 1: Dynamic repo/channel config (done)

Rename `repos.json` → `config.json`. Add `createConfigLoader` in `@thor/common` that re-reads the file on every call. Gateway and slack-mcp use it for channel allowlists. No caching — file is tiny.

## Phase 2: Merge proxy config into `config.json`

### Config shape

```json
{
  "repos": {
    "e2e-test": { "channels": ["C0APZ92A45U"] }
  },
  "proxies": {
    "atlassian": {
      "upstream": {
        "url": "https://mcp.atlassian.com/v1/mcp",
        "headers": { "Authorization": "${ATLASSIAN_AUTH}" }
      },
      "allow": [
        "atlassianUserInfo",
        "getJiraIssue",
        "searchJiraIssuesUsingJql",
        "addCommentToJiraIssue",
        "getConfluenceSpaces",
        "getConfluencePage",
        "searchConfluenceUsingCql",
        "getConfluencePageDescendants",
        "getConfluencePageFooterComments",
        "getConfluencePageInlineComments",
        "getConfluenceCommentChildren",
        "createConfluenceFooterComment",
        "createConfluenceInlineComment",
        "search",
        "fetch"
      ],
      "approve": ["createJiraIssue", "createConfluencePage"]
    },
    "slack": {
      "upstream": { "url": "http://slack-mcp:3003/mcp" },
      "allow": ["post_message", "read_thread", "get_channel_history", "get_slack_file"]
    },
    "posthog": {
      "upstream": {
        "url": "https://mcp.posthog.com/mcp",
        "headers": { "Authorization": "Bearer ${POSTHOG_API_KEY}" }
      },
      "allow": ["docs-search", "error-details", "list-errors", "..."],
      "approve": ["create-feature-flag", "update-feature-flag", "..."]
    },
    "grafana": {
      "upstream": { "url": "http://grafana-mcp:8000/mcp" },
      "allow": ["list_datasources", "query_loki_logs", "..."]
    }
  }
}
```

### Single process, single port, path-prefix routing

Collapse 4 proxy processes into one. Route by path prefix:

```
POST /atlassian      → MCP endpoint (atlassian upstream)
POST /slack          → MCP endpoint (slack upstream)
GET  /atlassian/approval/:id → approval status
POST /atlassian/approval/:id/resolve → approval resolution
GET  /health         → global health (all upstreams)
```

**What this kills:**

- `multi-proxy.sh`
- `PROXY_INSTANCES` env var
- 4 `proxy.*.json` files
- Port-per-upstream in docker-compose (4 port mappings → 1)
- `PROXY_CONFIG` env var

### Proxy internals

Replace module-level globals (`upstream`, `exposedTools`, `approveSet`) with a `Map<string, ProxyInstance>`:

```ts
interface ProxyInstance {
  name: string;
  upstream: UpstreamConnection;
  approvalStore: ApprovalStore;
}
```

Each instance holds its upstream connection and approval store. `allow`/`approve` lists are NOT cached on the instance — they're read from `config.json` on every `ListTools`/`CallTool` via the config loader.

On startup, the proxy reads `config.json`, connects to all upstreams, and populates the map. Express router extracts the upstream name from path:

```ts
app.post("/:upstream", mcpHandler);
app.get("/:upstream/approval/:id", approvalGetHandler);
app.post("/:upstream/approval/:id/resolve", approvalResolveHandler);
```

### Dynamic behavior

| What changed                | Restart needed? | How it works                                                                    |
| --------------------------- | --------------- | ------------------------------------------------------------------------------- |
| `allow`/`approve` lists     | No              | Re-read from config.json on every request                                       |
| Add new upstream            | No              | First request to `/:name` checks config, connects on the fly, caches connection |
| Remove upstream             | No              | Stop routing new sessions; existing ones drain naturally                        |
| Change upstream URL/headers | Yes             | Upstream connection is established once                                         |

### Approval flow changes

Currently the approval button value encodes `proxyPort` to route back: `v1:{actionId}:{proxyPort}`. With single port, encode the upstream name instead:

```
v1:{actionId}:{proxyPort}  →  v2:{actionId}:{upstreamName}
```

Proxy approval message changes:

```
Before: "Proxy-Port: 3010"
After:  "Proxy-Name: atlassian"
```

Touch points:

- `packages/proxy/src/index.ts` — emit `Proxy-Name` instead of `Proxy-Port`
- `packages/runner/src/index.ts` — parse `Proxy-Name` instead of `Proxy-Port`, emit in progress event
- `packages/common/src/progress-events.ts` — `proxyPort` → `proxyName` (string)
- `packages/slack-mcp/src/index.ts` — button value format `v2:{actionId}:{proxyName}`
- `packages/gateway/src/app.ts` — parse v2 button value, route to `http://{proxyHost}:{proxyPort}/{upstreamName}/approval/:id/resolve`

### Per-repo MCP config update

`.thor.opencode/opencode.json` uses name-based paths instead of port numbers:

```json
{
  "mcp": {
    "atlassian": {
      "type": "remote",
      "url": "http://proxy:3001/atlassian"
    }
  }
}
```

Global opencode config (`docker/opencode/opencode.json`) changes similarly:

```json
{
  "mcp": {
    "slack": {
      "type": "remote",
      "url": "http://proxy:3001/slack"
    }
  }
}
```

### docker-compose changes

```yaml
proxy:
  # ...
  ports:
    - "127.0.0.1:3001:3001" # single port
  environment:
    - NODE_ENV=production
    - POSTHOG_API_KEY=${POSTHOG_API_KEY}
    - ATLASSIAN_BASIC_AUTH=${ATLASSIAN_BASIC_AUTH}
    # PROXY_INSTANCES — removed
    # PROXY_CONFIG — removed
  volumes:
    - ./docker-volumes/workspace:/workspace
```

### Schema update in `@thor/common`

Extend `WorkspaceConfigSchema`:

```ts
const ProxyConfigSchema = z.object({
  upstream: z.object({
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }),
  allow: z.array(z.string()).default([]),
  approve: z.array(z.string()).default([]),
});

const WorkspaceConfigSchema = z.object({
  repos: z.record(z.string(), RepoConfigSchema),
  proxies: z.record(z.string(), ProxyConfigSchema).optional(),
});
```

`${ENV_VAR}` interpolation in header values stays — applied at upstream connect time.

## Decision Log

| #   | Decision                                    | Reason                                                                                                      |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | No TTL cache                                | File is tiny, readFileSync + JSON.parse is sub-millisecond. Immediate consistency.                          |
| 2   | Fall back to last good config on read error | Prevents transient writes from breaking running services. Logged as warning.                                |
| 3   | No eager validation at startup              | Services should start even if config.json doesn't exist yet.                                                |
| 4   | Hardcoded path constant, no env var         | Always `/workspace/config.json` inside the container.                                                       |
| 5   | Path prefix routing, not headers            | Visible in logs, easy to test with curl, simple MCP client config (just a URL).                             |
| 6   | No `/mcp` suffix in path                    | Proxy only does one thing. `/:upstream` is unambiguous.                                                     |
| 7   | Single port (3001)                          | One process, simpler docker-compose, no port allocation bookkeeping.                                        |
| 8   | Lazy upstream connect                       | New upstreams connect on first request, not at startup. Allows adding upstreams to config without restart.  |
| 9   | Upstream URL change requires restart        | Reconnecting with different credentials mid-session is complex and error-prone. Rare operation.             |
| 10  | v2 button value format                      | Encodes upstream name instead of port. Gateway parses version prefix to handle both formats during rollout. |
