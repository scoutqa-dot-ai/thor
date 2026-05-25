# Hard-code Upstream Registry

> **Superseded (2026-05-16):** The per-repo opt-in (`repos[name].proxies`) described
> here was dropped. The `repos` block has been removed from `WorkspaceConfigSchema`
> entirely, and every directory under `/workspace/repos/` now has access to every
> upstream in `PROXY_REGISTRY`. `getRepoUpstreams`, `RepoConfig`, and the
> per-repo `proxies` array no longer exist. The hard-coded registry (`PROXY_REGISTRY`,
> `PROXY_NAMES`, `getProxyConfig`) from this plan is still the source of truth.
> See `packages/common/src/workspace-config.ts` and `packages/common/src/proxies.ts`.

Move the top-level `proxies` block out of `config.json` and into a checked-in TypeScript constant in `@thor/common`. Keep per-repo opt-in (`repos[name].proxies: string[]`) as the user-facing switch.

## Motivation

The `proxies` block hard-codes three things that aren't really per-workspace choices:

- **Service endpoints** — `grafana-mcp:8000`, `slack-mcp:3003` are docker-compose service names. Changing them means topology changed, which is a code concern, not an ops concern.
- **Upstream URLs for SaaS upstreams** — fixed (`https://mcp.atlassian.com/v1/mcp`, `https://mcp.posthog.com/mcp`), identical across deployments.
- **`allow` / `approve` lists** — these are security policy. Every change wants a diff review, not an ops-side config edit. A misconfigured `allow` entry silently exposes a destructive tool to the agent; a misconfigured `approve` bypasses the Slack approval flow. Code review is the right gate.

Per-repo enablement (`repos[*].proxies: ["atlassian", "grafana"]`) stays in `config.json`: that's the legitimate per-workspace knob. Per-repo policy overrides are out of scope — we don't have that requirement today.

## Scope

**In scope:**

- New `PROXY_REGISTRY` constant in `@thor/common` containing four entries (atlassian, grafana, posthog, slack) with the expanded `upstream` / `allow` / `approve` values below.
- Keep `${ATLASSIAN_AUTH}` and `${POSTHOG_API_KEY}` interpolation in headers (reuse existing `interpolateHeaders`).
- Remove `proxies` field from `WorkspaceConfigSchema` and from `docs/examples/workspace-config.example.json`.
- Update `mcp-handler.ts` and `runner/src/index.ts` to read from the registry instead of `config.proxies`.
- Keep `repos[name].proxies: string[]` as-is; validate repo proxy references against registry keys instead of config keys.
- Delete now-unused helpers: `getProxyConfig`, `ProxyConfigSchema`, `ProxyUpstreamSchema`, reserved-proxy-name validation (names are no longer user input).

**Out of scope:**

- Per-repo policy overrides (allow/approve per repo).
- Adding upstreams beyond the four listed — future additions require a code change (by design).
- Changing the approval flow or MCP protocol surface.
- Renaming the field to `upstreams` in `repos[name].proxies` (cosmetic; keep current name to limit blast radius).

## Target shape

`packages/common/src/proxies.ts`:

```ts
import type { ProxyConfig } from "./workspace-config.js";

export const PROXY_REGISTRY: Record<string, ProxyConfig> = {
  atlassian: {
    upstream: {
      url: "https://mcp.atlassian.com/v1/mcp",
      headers: { Authorization: "${ATLASSIAN_AUTH}" },
    },
    allow: [
      "atlassianUserInfo",
      "getJiraIssue",
      "searchJiraIssuesUsingJql",
      "getConfluenceSpaces",
      "getConfluencePage",
      "searchConfluenceUsingCql",
      "getConfluencePageDescendants",
      "getConfluencePageFooterComments",
      "getConfluencePageInlineComments",
      "getConfluenceCommentChildren",
      "search",
      "fetch",
    ],
    approve: [
      "createJiraIssue",
      "addCommentToJiraIssue",
      "createConfluencePage",
      "createConfluenceFooterComment",
      "createConfluenceInlineComment",
    ],
  },
  grafana: {
    upstream: { url: "http://grafana-mcp:8000/mcp" },
    allow: [
      "list_datasources",
      "get_datasource",
      "query_loki_logs",
      "list_loki_label_names",
      "list_loki_label_values",
      "query_loki_stats",
      "query_loki_patterns",
      "tempo_traceql-search",
      "tempo_traceql-metrics-instant",
      "tempo_traceql-metrics-range",
      "tempo_get-trace",
      "tempo_get-attribute-names",
      "tempo_get-attribute-values",
      "tempo_docs-traceql",
    ],
    approve: [],
  },
  posthog: {
    upstream: {
      url: "https://mcp.posthog.com/mcp",
      headers: { Authorization: "Bearer ${POSTHOG_API_KEY}" },
    },
    allow: [
      "docs-search",
      "error-details",
      "list-errors",
      "feature-flag-get-all",
      "feature-flag-get-definition",
      "insight-query",
      "insight-get",
      "insights-get-all",
      "query-run",
      "query-generate-hogql-from-question",
      "event-definitions-list",
      "properties-list",
      "logs-query",
      "logs-list-attributes",
      "logs-list-attribute-values",
      "error-tracking-issues-list",
      "error-tracking-issues-retrieve",
      "entity-search",
      "cohorts-list",
      "cohorts-retrieve",
      "dashboard-get",
      "dashboard-reorder-tiles",
      "dashboards-get-all",
      "experiment-get",
      "experiment-get-all",
      "experiment-results-get",
      "surveys-global-stats",
      "update-issue-status",
    ],
    approve: [
      "create-feature-flag",
      "update-feature-flag",
      "experiment-create",
      "experiment-update",
      "dashboard-create",
      "dashboard-update",
      "add-insight-to-dashboard",
      "insight-create-from-query",
      "insight-update",
      "event-definition-update",
    ],
  },
  slack: {
    upstream: { url: "http://slack-mcp:3003/mcp" },
    allow: ["post_message", "read_thread", "get_channel_history", "get_slack_file"],
    approve: [],
  },
};

export function getProxyConfig(name: string): ProxyConfig | undefined {
  return PROXY_REGISTRY[name];
}

export const PROXY_NAMES: readonly string[] = Object.keys(PROXY_REGISTRY);
```

`ProxyConfig` / `ProxyUpstream` types stay in `workspace-config.ts` (still used by the registry). The _schemas_ (`ProxyConfigSchema`, `ProxyUpstreamSchema`) can be dropped since nothing parses that shape from JSON anymore.

After this change, `config.json` for a workspace shrinks to:

```json
{
  "repos": {
    "your-repo": {
      "channels": ["C0123456789"],
      "proxies": ["atlassian", "grafana", "slack"]
    }
  },
  "github_app": { "installations": [...] }
}
```

## Phases

### Phase 1 — Registry module + consumer swap

**Files:**

| File                                          | Action | Notes                                                                                                                                                                                                                        |
| --------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/proxies.ts`              | New    | `PROXY_REGISTRY`, `getProxyConfig(name)`, `PROXY_NAMES`.                                                                                                                                                                     |
| `packages/common/src/index.ts`                | Edit   | Export `PROXY_REGISTRY`, `PROXY_NAMES`, `getProxyConfig` from `./proxies.js`.                                                                                                                                                |
| `packages/common/src/workspace-config.ts`     | Edit   | Drop old `getProxyConfig`; keep `ProxyConfig` / `ProxyUpstream` types.                                                                                                                                                       |
| `packages/remote-cli/src/mcp-handler.ts`      | Edit   | Replace every `config.proxies?.[name]` / `Object.keys(config.proxies ?? {})` with registry.                                                                                                                                  |
| `packages/runner/src/index.ts`                | Edit   | `buildToolInstructions` reads registry instead of `config.proxies`.                                                                                                                                                          |
| `packages/common/src/proxies.test.ts`         | New    | Asserts registry keys (`atlassian`, `grafana`, `posthog`, `slack`), headers interpolation of `ATLASSIAN_AUTH` / `POSTHOG_API_KEY`, that no reserved names slip, and that `allow` / `approve` sets are disjoint per upstream. |
| `packages/remote-cli/src/mcp-handler.test.ts` | Edit   | Stop injecting `proxies` via mock config; rely on registry (or inject test registry via dep).                                                                                                                                |

**Implementation notes:**

- `mcp-handler.ts` currently accesses `getConfig().proxies` in six places: `getConfiguredUpstreamNames`, `getInstance`, `listVisibleTools`, `getAllowedUpstreamsForRepo` (filter step), `findApproval`, and `executeApproval`'s `list`. All become reads against `PROXY_REGISTRY` / `PROXY_NAMES`. `getConfig()` is still needed for repo allowlist lookups.
- `getAllowedUpstreamsForRepo` keeps its current behaviour (intersect repo's `proxies: []` with known upstream names) — it just intersects with `PROXY_NAMES` instead of `config.proxies`.
- To keep `McpService` testable, add an optional `registry?: Record<string, ProxyConfig>` field to `McpServiceDeps` that defaults to `PROXY_REGISTRY`. Tests inject a minimal registry; production passes nothing.

**Exit criteria:**

- `pnpm -r build` is clean.
- `pnpm -r test` is green. Existing mcp-handler tests pass after the dep-injection tweak.
- Agent can still list upstreams (`mcp`), list tools (`mcp slack`, `mcp posthog`), and call a tool end-to-end through remote-cli in `docker compose up`.
- `${ATLASSIAN_AUTH}` and `${POSTHOG_API_KEY}` interpolation works (verify via connect log showing redacted headers).
- `POSTHOG_API_KEY` is wired through `docker-compose.yml` to the `remote-cli` service (add if missing).

### Phase 2 — Drop schema + update docs/examples

**Files:**

| File                                            | Action    | Notes                                                                                                                                                                                                                                       |
| ----------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/workspace-config.ts`       | Edit      | Remove `proxies` field from `WorkspaceConfigSchema`. Remove `ProxyConfigSchema`, `ProxyUpstreamSchema`, reserved-proxy-name validation. Keep repo-level validation that `repos[*].proxies` refs a known name — check against `PROXY_NAMES`. |
| `packages/common/src/workspace-config.test.ts`  | Edit      | Drop tests asserting top-level `proxies` in config. Keep (and retarget) the "unknown proxy" test to reference registry names.                                                                                                               |
| `docs/examples/workspace-config.example.json`   | Edit      | Remove the entire `proxies: {}` block.                                                                                                                                                                                                      |
| `docs/plan/2026032102_workspace-config-file.md` | No change | Historical plan — leave as-is.                                                                                                                                                                                                              |
| `AGENTS.md`, `README.md`                        | Check     | Grep for `config.json` proxy examples and update if any.                                                                                                                                                                                    |

**Reserved-name validation:** the reserved list (`health`, `upstreams`, `tools`, `approval`, `approvals`) was to stop users colliding with endpoint paths. With hard-coded names, a code review catches this — drop the runtime check. Likewise the `^[a-z0-9][a-z0-9-]*$` name regex.

**Exit criteria:**

- A workspace config with a stray top-level `proxies` key fails zod validation (strict schema — see Decision #3).
- `loadWorkspaceConfig(docs/examples/workspace-config.example.json)` passes.
- `getRepoUpstreams` still returns the declared list; an unknown name in `repos[*].proxies` still throws with the list of registry names in the error.
- `grep -r "config.proxies" packages/` is empty.
- E2E: `scripts/test-e2e.sh` (if it exercises MCP) still passes.

## Decision Log

| #   | Decision                                                               | Reason                                                                                                                            |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Put registry in `@thor/common`, not `remote-cli`                       | `runner` also reads upstream allow/approve to build tool instructions. Sharing is the whole point.                                |
| 2   | Keep `repos[name].proxies: string[]` as a config field                 | That's the legitimate per-workspace knob — which repos talk to which upstreams. Not a security policy concern.                    |
| 3   | `WorkspaceConfigSchema` uses `.strict()` — reject extra top-level keys | Greenfield project, no backcompat. A stray `proxies: {...}` should fail loud at startup, not silently drift from reality.         |
| 4   | Keep `${ENV_VAR}` interpolation in the hard-coded headers              | Atlassian's auth token is still a deploy-time secret. Interpolation runs at connect time, same as today; nothing changes for ops. |
| 5   | No per-repo policy overrides                                           | Not needed today. Adding one later is a schema extension (`repos[name].allow?`), not a re-architecture. YAGNI.                    |
| 6   | Drop reserved-proxy-name validation and the name regex                 | Names are no longer user input. Code review catches `tools`/`health` collisions at review time.                                   |
| 7   | Injectable registry via `McpServiceDeps`                               | Preserves current test isolation (each test sets up its own upstreams). Zero-cost for production (default param).                 |
| 8   | Don't rename `repos[*].proxies` → `repos[*].upstreams`                 | Cosmetic. Out of scope; existing configs keep working.                                                                            |
| 9   | Keep `ProxyConfig` / `ProxyUpstream` type exports                      | Still referenced by `mcp-handler.ts` (`connectInstance` parameter) and the registry shape. Schemas are dropped; types stay.       |

## Risks

| Risk                                                                           | Mitigation                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Diverging `allow` lists per tenant in future                                   | Deferred (Decision #5). If it becomes real, add `repos[name].allow?` override merged on top of registry. |
| Hard-coded `grafana-mcp:8000` surprises someone running outside docker-compose | Same surprise exists today in the example config. Registry is a constant; local override is a patch.     |

## Out of scope

- Extracting upstream definitions into per-package modules (e.g., slack-mcp owns its own entry).
- A CLI/admin surface to list registered upstreams.
- Changing the approval store layout or approval flow.
- Cleaning up other config.json fields.

---
