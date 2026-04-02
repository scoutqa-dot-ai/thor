<!-- /autoplan restore point: /Users/son.dao/.gstack/projects/scoutqa-dot-ai-thor/dynamic-config-autoplan-restore-20260401-065138.md -->

# Dynamic Workspace Config

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
        "headers": { "Authorization": "Basic ${ATLASSIAN_BASIC_AUTH}" }
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

## /autoplan Review Findings

### NOT in scope

- Config management UI/API (Phase 3 vision, not needed now)
- fs.watch + in-memory cache for config reads (current readFileSync is sub-ms, revisit at scale)
- Per-upstream circuit breakers / concurrency limits (single process is fine for 4 upstreams)
- Config write atomicity / file locking (single writer today, revisit if multiple writers emerge)
- Prometheus metrics endpoint (Grafana MCP already provides observability)
- Config validation CLI command (schema validation runs at load time with clear errors)

### What already exists

- `createConfigLoader` — shared config loader with lastGood fallback (extended, not rebuilt)
- `connectUpstream` — MCP client connection (unchanged, added onDisconnect callback)
- `ApprovalStore` — per-upstream approval persistence (parameterized with fallback dirs)
- `classifyTool` / `validatePolicy` — policy enforcement (unchanged)
- `writeToolCallLog` — structured tool call logging (unchanged)
- `interpolateHeaders` — env var substitution in headers (moved to common, unchanged logic)

### Failure Modes Registry

| Codepath                 | Failure Mode            | Rescued?               | Test? | User Sees?                     | Logged?  |
| ------------------------ | ----------------------- | ---------------------- | ----- | ------------------------------ | -------- |
| Config read (first load) | File missing            | N (throws)             | N     | Process crash → Docker restart | Y        |
| Config read (subsequent) | File corrupt            | Y (lastGood)           | N     | Nothing                        | Y (warn) |
| Upstream connect         | Unreachable             | Y (not cached)         | N     | 404 on request                 | Y        |
| Upstream disconnect      | Connection drop         | Y (reconnect in-place) | N     | Brief interruption             | Y        |
| Upstream reconnect       | Reconnect fails         | Y (evict)              | N     | Next request retries           | Y        |
| MCP session              | Client crash (no close) | N (transport leaks)    | N     | Memory leak                    | N        |
| Approval resolve         | Upstream call fails     | Y (error on action)    | Y     | Error shown                    | Y        |
| Route collision          | POST /health            | Y (404 harmless)       | N     | "Unknown upstream: health"     | N        |
| Path traversal           | Malicious upstream name | N                      | N     | Depends on fs                  | N        |

**CRITICAL GAPS:**

1. MCP session leak (no reaper for abandoned transports)
2. No upstream name validation (path traversal via approval store filesystem paths)

### TODOs from review

1. **Add workspace-config.ts unit tests** — 0% coverage on the shared config layer used by 3 services. P1.
2. **Add session reaper** — Sweep abandoned transports after idle timeout. Prevents memory leak from crashed clients. P2.
3. **Validate upstream names** — Reject names that collide with reserved paths ("health") or contain path-traversal chars. Alphanumeric + hyphens only. P2.
4. **Add reconnect backoff** — Exponential backoff on upstream reconnect failure. Currently retries once then evicts. P3.
5. **Remove v1 approval button compat** — Safe after 2026-05-01 when all in-flight approvals have drained. P3.

<!-- AUTONOMOUS DECISION LOG -->

## Decision Audit Trail

| #   | Phase | Decision                                            | Principle                     | Rationale                                                                                                           | Rejected                       |
| --- | ----- | --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | CEO   | SELECTIVE EXPANSION mode                            | P3 Pragmatic                  | Feature enhancement on existing system, not greenfield                                                              | EXPANSION, HOLD, REDUCTION     |
| 2   | CEO   | Approach A (single config, single process)          | P1 Completeness + P5 Explicit | Already implemented and tested. Approach B is shortcut, C is ocean                                                  | Approach B, C                  |
| 3   | CEO   | Defer health endpoint improvement                   | P3 Pragmatic                  | Current /health is adequate for Docker healthchecks                                                                 | Build now                      |
| 4   | CEO   | Defer config validation CLI                         | P5 Explicit                   | Schema validation already runs at load time                                                                         | Build now                      |
| 5   | CEO   | Defer Prometheus metrics                            | P3 Pragmatic                  | Grafana MCP already in stack                                                                                        | Build now                      |
| 6   | CEO   | Accept readFileSync in hot path                     | P6 Action                     | User explicitly decided against caching. Sub-ms at current scale                                                    | fs.watch cache                 |
| 7   | CEO   | Accept single-process fault isolation tradeoff      | P6 Action                     | 4 upstreams, low traffic. Docker restart handles crashes                                                            | Per-upstream process isolation |
| 8   | Eng   | Flag workspace-config tests as P1 TODO              | P1 Completeness               | 0% coverage on shared layer used by 3 services                                                                      | Skip tests                     |
| 9   | Eng   | Flag session reaper as P2 TODO                      | P1 Completeness               | Transport leak is a real bug at scale                                                                               | Ignore                         |
| 10  | Eng   | Flag upstream name validation as P2 TODO            | P1 Completeness               | Path traversal defense in depth                                                                                     | Ignore                         |
| 11  | Eng   | Defer reconnect backoff                             | P3 Pragmatic                  | Current one-retry-then-evict is adequate for 4 upstreams                                                            | Build now                      |
| 12  | Eng   | Skip classifyTool Set conversion                    | P3 Pragmatic                  | 15 tools, nanoseconds per call                                                                                      | Optimize                       |
| 13  | Eng   | Accept plan documentation of eager+lazy (both true) | P5 Explicit                   | Startup eagerly connects configured upstreams. New upstreams added to config later connect lazily. No contradiction | Rewrite plan                   |

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status                       | Findings                                                             |
| ------------- | --------------------- | ------------------------------- | ---- | ---------------------------- | -------------------------------------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 1    | CLEAR (via /autoplan)        | SELECTIVE EXPANSION, 0 critical gaps, 3 expansions deferred          |
| Codex Review  | `/codex review`       | Independent 2nd opinion         | 2    | issues_found (via /autoplan) | CEO: 10 concerns, Eng: 8 findings                                    |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 1    | CLEAR (via /autoplan)        | 0 blockers, 2 critical gaps (session leak, name validation), 5 TODOs |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 0    | SKIPPED                      | No UI scope                                                          |

**CROSS-MODEL:** Both Codex and Claude flagged: readFileSync in hot path, route collision /health vs /:upstream, session lifecycle gaps. Agreement strengthens these findings.
**UNRESOLVED:** 0 decisions unresolved.
**VERDICT:** CEO + ENG CLEARED — ready to implement. 5 TODOs captured for follow-up.
