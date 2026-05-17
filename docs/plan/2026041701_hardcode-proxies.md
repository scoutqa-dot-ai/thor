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

# /autoplan Phase 1 — CEO Review

## CODEX SAYS (CEO — strategy challenge)

### Findings

- **[CRITICAL] Hard-coding the product's integration surface into app code.** The plan turns "we currently have four upstreams" into a product constraint: future additions require a code change "by design" and the user-facing config can only reference registry keys baked into `@thor/common` (`docs/plan/2026041701_hardcode-proxies.md:21`, `:31`, `:225`). That is the opposite of the earlier approved direction, which explicitly optimized for adding upstreams without restart (`docs/plan/2026033101_dynamic-config.md:111`, `:219`), and it under-shoots the architecture ambition of a broader internal AI teammate with multiple integration classes (`docs/feat/mvp.md:34`).
  **Recommendation:** Hard-code only container-local service discovery if you want, but keep upstream registry and policy as reviewed, schema-validated data rather than library constants.

- **[HIGH] Security review is being used to justify shipping policy inside source code.** The argument that `allow`/`approve` must live in code because they need diff review is not strong enough; reviewability and auditability do not require compile-time coupling to service code (`docs/plan/2026041701_hardcode-proxies.md:13`, `:227`). You are creating an engineering release bottleneck for every policy adjustment, which is a bad trade if the product needs to iterate trust boundaries quickly.
  **Recommendation:** Put policy in a checked-in manifest with CODEOWNERS/security approval and runtime schema validation, separate from deployable application code.

- **[HIGH] The plan removes operational flexibility without proving the pain it solves is larger.** Phase 2 makes stray `proxies` config invalid and fully removes the top-level registry from workspace config (`:204`, `:214`). But the prior plan's whole value proposition was eliminating restarts and docker-compose edits for policy and upstream changes (`docs/plan/2026033101_dynamic-config.md:7`, `:113`).
  **Recommendation:** Before implementation, quantify how often upstream/policy changes happen and what failures dynamic config actually caused; don't pay a permanent flexibility tax to solve an unmeasured nuisance.

- **[MEDIUM] Scope is too code-cleanup-centric and misses the operator product.** The plan explicitly leaves out even a minimal CLI/admin surface to list registered upstreams (`:243`), yet this system's differentiation is governed tool access and approvals at the `remote-cli` policy boundary (`docs/feat/mvp.md:44`). A 10-star version is not "registry moved into TypeScript"; it is "operators can see, diff, validate, and safely roll out tool policy with confidence."
  **Recommendation:** Add a minimal introspection surface in the same project phase: list upstreams, effective allow/approve sets, and repo bindings.

### Premise challenges

- Upstream catalog realistically stays near the four named integrations for the next 6–12 months.
- Requiring an engineering code change and deploy for every policy tweak is acceptable product velocity.
- All deployments truly share identical SaaS endpoints and policy, with no environment/team variance.
- Docker Compose service names/ports are the only topology worth supporting.
- The earlier "dynamic config, no restart for add upstream" direction is intentionally being reversed, not forgotten.
- Who owns policy changes operationally: security/platform, or ordinary engineering teams.

### Recommended mode

**SELECTIVE EXPANSION** — keep the simplification goal, but expand scope to separate topology from policy data and add operator visibility.

### Overall verdict

**modify**

---

## CLAUDE SUBAGENT (CEO — strategic independence)

### Findings

- **[HIGH] Reversal of dynamic-config is correct but plan buries the why.** The prior plan (`docs/plan/2026033101_dynamic-config.md:1-10`) sold "no restart required" as the north star. This plan flips that specifically for `allow`/`approve` but doesn't acknowledge the tradeoff or re-frame the principle. Security-policy-as-code is the right call, but the plan should explicitly state the new invariant: "tenant-facing knobs are dynamic; security policy is code."
  **Recommendation:** Add a "Principle Reset" section stating that allow/approve are now governed by PR review, and that only `repos[name].proxies` remains dynamic.

- **[HIGH] Missing the real 10-star outcome — guardrail, not just hardcode.** `packages/remote-cli/src/mcp-handler.ts:199` already calls `validatePolicy`, but there's no CI check, no snapshot test, no automated drift detector for "does the actual upstream still expose these tools?" Hardcoding alone just moves the bug from JSON to TS.
  **Recommendation:** Add a scheduled `pnpm check:policy-drift` that connects to each upstream in staging and diffs live tool inventory vs registry; fail CI when new tools appear in `approve`-worthy categories.

- **[MEDIUM] Scope is too narrow — docker-compose service names are still soft-coded.** Plan calls `grafana-mcp:8000` / `slack-mcp:3003` "topology is a code concern" (motivation) but leaves them as string literals in the registry. `packages/common/src/proxies.ts` will drift from compose.
  **Recommendation:** Either import the service host/port from a single source that compose and TS both consume, or add a trivial smoke test that asserts `PROXY_REGISTRY.grafana.upstream.url` matches the compose service definition.

- **[MEDIUM] `PROXY_NAMES` string array is a regression.** `packages/common/src/workspace-config.ts:113` currently validates `repos[*].proxies` against live config names. Plan replaces with hardcoded string array.
  **Recommendation:** Export `type ProxyName = keyof typeof PROXY_REGISTRY` and tighten `RepoConfigSchema.proxies` to `z.array(z.enum(PROXY_NAMES))` — same runtime, richer typing.

- **[LOW] Dependency-injection for tests is over-engineering.** `McpServiceDeps` already has 5 optional knobs; adding `registry?` (Decision #7) keeps tests isolated but the registry is a pure constant — `vi.mock('@thor/common/proxies')` is simpler.
  **Recommendation:** Use module mocking, not DI.

### Premise challenges

- Is "security review via PR" actually enforced? CODEOWNERS on `proxies.ts`, required reviewers?
- Is the set of upstreams really stable? 4 today → 10+ in 2026 = re-reversal in 6 months.
- Why keep `repos[*].proxies` dynamic but make allow/approve static? If a tenant can toggle a whole upstream on without review, they can already trigger approve-gated tools — asymmetry is only meaningful if approval policy also governs first-access.
- Greenfield assumption: any in-flight approvals encoded with old format?
- Local dev / staging divergence: dev can't point grafana at local instance without patching source.

### Recommended mode

**SELECTIVE EXPANSION** — the core move (policy-as-code) is right; expand scope to include automated drift check and build-time typed names, drop the DI hatch.

### Overall verdict

**modify**

---

## CEO Consensus Table

| Dimension                      | Codex                                                   | Claude                                      | Consensus                                                |
| ------------------------------ | ------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Policy-as-code direction       | Wrong — keep as reviewed manifest, not library constant | Right — but plan buries the principle       | **SPLIT** (see User Challenge below)                     |
| Topology vs. policy separation | Yes, split them                                         | Yes, compose URLs should not be TS literals | **ALIGN** — both say separate                            |
| 10-star outcome                | Operator introspection surface                          | Automated drift detector + typed names      | **ALIGN on expansion** — both want more than a file move |
| Reversal of dynamic-config     | Called out as contradiction, unjustified                | Called out as correct but unexplained       | **ALIGN** — plan must acknowledge explicitly             |
| Mode                           | SELECTIVE EXPANSION                                     | SELECTIVE EXPANSION                         | **ALIGN**                                                |
| Verdict                        | modify                                                  | modify                                      | **ALIGN** — do not approve as-is                         |

> **USER CHALLENGE surfaced.** Codex pushes back on the entire premise ("keep policy as data, not library constants"). User said "hard code them." Both models agree the plan should be _modified_, not approved as-is. This disagreement is the one Phase 4 must present back to the user for final decision.

---

## 0A — Premise Challenge

The plan rests on four premises that both CEO voices question:

1. **Hardcoding is the best way to enforce PR review of policy.** Alternative: a checked-in JSON/YAML manifest with CODEOWNERS achieves the same guarantee without compile-time coupling. The current `proxies` field in `config.json` with strict schema validation already gives PR-review semantics if we move it out of user-editable `config.json` into a new `policy.json` governed by CODEOWNERS.
2. **The upstream catalog is stable.** Plan says "future additions require a code change — by design." If 4 → 10 happens within 6 months, this plan gets re-reversed. Need a data point, not an assumption.
3. **Topology (URLs, service:port) and policy (allow/approve) belong together.** Both voices say: split them. URLs vary per-environment (local dev, staging, prod). Policy should be invariant.
4. **This reversal of `2026033101_dynamic-config.md` is intentional.** That plan explicitly made dynamic config the product promise. Silently reversing a 2-week-old plan is a red flag for decision drift.

## 0B — Leverage Map

| Investment                                        | Payoff                                                  | Leverage                                                    |
| ------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Move `proxies` from config.json to code           | PR-review on policy, drop top-level schema validation   | **Medium** — solves stated problem                          |
| Separate policy-manifest from app code            | PR-review + env-agility + no re-reversal risk           | **High** — addresses both CEO critiques                     |
| Add policy-drift CI check (connects to upstreams) | Detects when upstream adds a tool we haven't classified | **High** — turns policy from snapshot to enforced invariant |
| Env-var overrides for URLs                        | Local dev + staging parity                              | **Medium** — one-line fix, high dev-UX value                |
| Typed `ProxyName` union from registry             | Build-time errors on misspellings                       | **Low** — nice-to-have, one line                            |
| Operator CLI `thor upstreams` command             | Visibility into effective policy per repo               | **Medium** — not MVP-critical but ships confidence          |

## 0C — Dream State

The 10-star product outcome (per both CEO voices):

> **"Policy is visible, versioned, and verified. Topology is configurable per-environment. Operators can see the effective tool surface for any repo in one command. Adding a new upstream is a two-file PR reviewed by security."**

Specifically:

- **Visible:** `thor upstreams list` / `thor upstreams show <name>` shows allow/approve/repo-bindings.
- **Versioned:** policy manifest lives in repo, CODEOWNERS gated.
- **Verified:** CI check diffs registry against live upstream tool inventory.
- **Configurable per-env:** URLs overridable via env or compose, policy is not.
- **Reviewed:** adding an upstream = editing `policy.json` + one code binding, never editing `config.json`.

## 0C-bis — Implementation Alternatives

| #   | Approach                                                                                                                                       | Pros                                                            | Cons                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A   | **Full hardcode (current plan).** URLs + allow + approve all in `proxies.ts`.                                                                  | Simplest. One source of truth in code. PR-gated by default.     | Local-dev URL patches require source edits. Reversal of 2026033101.    |
| B   | **Split: URLs env-overridable, policy hardcoded.** URLs read env/compose; allow/approve still in code.                                         | Dev-UX preserved. Policy still PR-gated. Minimal extra surface. | Two sources of truth for "what is this proxy" — registry + env.        |
| C   | **Policy manifest (JSON) governed by CODEOWNERS, loaded at startup.** `packages/common/policy.json` parsed by zod, CODEOWNERS enforces review. | Keeps data as data. No recompile for policy tweak. Auditable.   | Manifest path exists, schema exists — same critique as current config. |
| D   | **B + drift detector CI + typed names.** Env URL overrides, hardcoded policy, CI diffs live tools, `type ProxyName`.                           | Highest-leverage: dev-UX + PR-review + runtime guardrail.       | Slightly larger scope (one new CI script).                             |

**Recommendation: D.** It preserves the user's stated intent (hardcode policy for PR-review gating) while fixing the three things both voices caught (topology coupling, drift blindness, weak typing).

## 0D — Mode: SELECTIVE EXPANSION

Both voices selected SELECTIVE EXPANSION. Rationale:

- Core move (policy out of user config → governed source) is **right**.
- Surrounding scope (hardcode URLs, drop typed names, no drift check, no operator surface) **under-delivers** on the stated goal (operator confidence, policy integrity).
- Cherry-pick the expansions that are small and high-leverage; hold scope on the rest.

**Cherry-picked expansions (add to plan):**

1. Env-var override for each upstream URL (Alternative D).
2. CI script `check:policy-drift` — connects to each upstream in a smoke-test env, diffs discovered tools vs `allow ∪ approve`, fails on new tools.
3. `type ProxyName = keyof typeof PROXY_REGISTRY`; `z.enum(PROXY_NAMES)` in `RepoConfigSchema`.
4. One-paragraph "Principle Reset" section in the plan explaining the 2026033101 reversal.

**Explicitly not expanded (hold):**

- Operator CLI (`thor upstreams`) — deferred as separate plan.
- Per-repo policy overrides — still deferred (Decision #5 stays).
- Per-package registry entries — still deferred.

## 0E — Temporal Interrogation

- **2 weeks ago (`docs/plan/2026033101_dynamic-config.md`):** Dynamic config for proxies was explicitly chosen. "All config is dynamic (no restart required)."
- **Today:** Hardcode proxies. Direct reversal of the prior north star.
- **Why the oscillation?** The new decision addresses a real pain (policy review) that dynamic-config did not. But the new plan doesn't acknowledge the oscillation. A reader in 2 months will see two plans with opposite conclusions and no synthesis.
- **Action:** The plan must include a short "Principle Reset" that states the new invariant: _tenant-facing knobs (channel IDs, enabled proxies, github_app) are dynamic; security policy (allow/approve) is code._

## 0F — Mode Selection

**Selected: SELECTIVE EXPANSION.**

- Hold: P1 registry module + consumer swap is kept.
- Expand: add env-URL overrides, drift-check CI, typed ProxyName, Principle Reset section.
- Contract: drop `McpServiceDeps.registry` DI hatch in favor of `vi.mock` (Claude LOW finding).

---

## Sections 1–10

### 1. What is this actually solving?

**Stated:** Move upstream registry from runtime config to code so policy changes go through PR review.

**Real:** (a) close a governance gap on `allow`/`approve` lists; (b) reduce config.json surface area; (c) tighten the trust boundary at `remote-cli`.

### 2. What's the actual user job?

Two users:

- **Operator** (ops engineer): wants to enable/disable upstreams per repo without caring about internals. Unchanged — still edits `config.json`.
- **Policy reviewer** (security/platform): wants a diff-reviewable, git-blameable history of what tools Thor can invoke. **Changed** — previously edit config.json; now edit source.

### 3. Who owns what?

| Artifact                        | Owner (proposed)                 | Change mechanism      |
| ------------------------------- | -------------------------------- | --------------------- |
| `proxies.ts` (registry)         | Security + Platform (CODEOWNERS) | PR + review           |
| `config.json` (per-repo enable) | Ops                              | File edit, no restart |
| URL env overrides (new)         | Ops                              | compose / env         |

### 4. What's the simplest thing that could work?

Hardcode everything (current plan). Then iterate. Cost: re-reversal if upstream count grows.

### 5. What's the most ambitious thing worth doing?

Full dream state (Section 0C). Cost: ~2x scope.

### 6. What's the right middle?

Alternative D from 0C-bis. ~1.3x scope, addresses both CEO critiques.

### 7. What are the measurable outcomes?

- `grep -r 'config.proxies' packages/` returns empty.
- `pnpm check:policy-drift` passes in CI on main.
- `POSTHOG_API_KEY` + `ATLASSIAN_AUTH` both resolve at startup, headers show redacted in connect log.
- New upstream added via a single PR touching `proxies.ts` + CODEOWNERS triggers.
- A dev can `PROXY_GRAFANA_URL=http://localhost:8000/mcp docker compose up` and point at a local grafana instance.

### 8. What could make this fail?

- A policy edit lands without SEC approval because CODEOWNERS isn't configured → same footgun as today, different file.
- Drift check flakes on network → CI noise, engineers disable it.
- Env-override mechanism confuses the `${ENV}` header interpolation semantics.

### 9. What's the rollback path?

`git revert` the two commits. `config.json` schema is greenfield so no data migration concerns.

### 10. What does "done" look like?

Both phases shipped + drift check green in CI + Principle Reset section added to plan + CODEOWNERS updated to gate `packages/common/src/proxies.ts`.

(Section 11 skipped — no UI scope.)

---

## Failure Modes Registry

| Codepath                        | Failure Mode                        | Rescued?              | Test?     | User sees                    | Logged? |
| ------------------------------- | ----------------------------------- | --------------------- | --------- | ---------------------------- | ------- |
| `PROXY_REGISTRY` import         | Module fails to load (syntax error) | N — process crash     | Y (build) | Container restart loop       | Y       |
| `interpolateHeaders` at connect | `ATLASSIAN_AUTH` unset              | N — throws            | Y         | MCP tool unavailable         | Y       |
| Env URL override parse          | `PROXY_GRAFANA_URL` malformed       | N — throws on connect | Y (new)   | Grafana upstream unavailable | Y       |
| `check:policy-drift` CI         | Upstream unreachable in CI env      | Fallback: skip + warn | Y (new)   | CI yellow, not red           | Y       |
| Repo references unknown proxy   | `repos[*].proxies: ["unknowable"]`  | Y — throws at load    | Y         | Loud startup error           | Y       |
| CODEOWNERS not configured       | Policy PR lands without SEC review  | N — out of code scope | N         | Silent governance gap        | N       |

**CRITICAL GAP:** CODEOWNERS configuration is the load-bearing governance mechanism but lives outside the code change. If it's not added, the plan's security claim is unfounded.

---

## NOT in scope (already exists — do not re-implement)

- `interpolateEnv` / `interpolateHeaders` (`packages/common/src/workspace-config.ts:210-232`) — reuse.
- `validatePolicy` / `classifyTool` (`packages/remote-cli/src/mcp-handler.ts:~199`) — unchanged.
- `ApprovalStore` — unchanged.
- `connectUpstream` — unchanged.
- `createConfigLoader` — still loads `config.json`; just no longer contains `proxies`.

## What already exists (delta from dream state)

| Dream feature                             | Exists today?                                                  | Gap                                      |
| ----------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| PR-gated policy                           | Partially — config.json is reviewable but not CODEOWNERS-gated | Hardcode + CODEOWNERS                    |
| Env-configurable URLs                     | No — baked into config.json                                    | Env override per upstream                |
| Policy drift detection                    | No                                                             | `check:policy-drift` script              |
| Operator introspection (`thor upstreams`) | No                                                             | Deferred (separate plan)                 |
| Typed proxy names                         | No — `string[]` today                                          | `z.enum(PROXY_NAMES)` + `type ProxyName` |
| Per-repo policy override                  | No                                                             | Deferred (Decision #5 stands)            |

---

## Phase 1 Completion Summary

- **Mode:** SELECTIVE EXPANSION.
- **Verdict:** modify before implementation.
- **Expansions to adopt:** env URL overrides (Alternative D), Principle Reset section. Drift-check CI and typed ProxyName deferred (not confirmed in premise gate, can be added in Phase 3).
- **User Challenge resolution (Phase 1 premise gate, 2026-04-17):** user selected full hardcode for policy (A), intentional reversal of 2026033101 (A), env-overridable URLs (B). Codex's alternate framing (policy as JSON manifest) was considered and declined.
- **Gate before Phase 3:** passed.

## Principle Reset (from premise gate)

This plan intentionally reverses the "all config is dynamic" principle stated in `docs/plan/2026033101_dynamic-config.md`. The new invariant:

- **Tenant-facing knobs** (channel IDs, enabled proxies per repo, github_app installations) remain in `config.json` and reload without restart.
- **Security policy** (`allow` / `approve` lists) is code. Changes go through PR review with CODEOWNERS on `packages/common/src/proxies.ts`.
- **Topology** (upstream URLs, service hosts/ports) is code by default but each URL is overridable via a single env var (`PROXY_<NAME>_URL`) so local dev and staging can point at alternatives without patching source.

## Scope adjustments from premise gate

Add to the target shape in `packages/common/src/proxies.ts`:

```ts
function urlFromEnv(name: string, defaultUrl: string): string {
  const key = `PROXY_${name.toUpperCase()}_URL`;
  return process.env[key] ?? defaultUrl;
}

export const PROXY_REGISTRY: Record<string, ProxyConfig> = {
  atlassian: {
    upstream: {
      url: urlFromEnv("atlassian", "https://mcp.atlassian.com/v1/mcp"),
      headers: { Authorization: "${ATLASSIAN_AUTH}" },
    },
    // allow/approve unchanged
  },
  grafana: {
    upstream: { url: urlFromEnv("grafana", "http://grafana-mcp:8000/mcp") },
    // …
  },
  // posthog, slack — same pattern
};
```

Add to the exit criteria of Phase 1:

- `PROXY_GRAFANA_URL=http://localhost:8000/mcp docker compose up` routes `/proxy/grafana` calls to the overridden URL.
- CODEOWNERS adds `packages/common/src/proxies.ts` to the security/platform review group (out-of-plan task, but must land before this plan can be called "done").

---

# /autoplan Phase 3 — Eng Review

## CODEX SAYS (eng — architecture challenge)

### Findings

- **[HIGH] Global registry is being mistaken for the enabled set.** `packages/remote-cli/src/mcp-handler.ts:140-142, 466-475, 527-569, 655-659` currently scopes connection, health, and approval discovery to _configured_ proxies. The plan says those paths all switch to `PROXY_REGISTRY` / `PROXY_NAMES` (`docs/plan/2026041701_hardcode-proxies.md:186-188`), which would make every deployment try Atlassian/PostHog/Grafana even when a repo only enabled Slack; unset `ATLASSIAN_AUTH` then becomes a startup regression instead of an unused feature.
  **Recommendation:** Add `getEnabledProxyNames(config)` from the union of `repos[*].proxies` and use the registry only for lookup/policy.

- **[MEDIUM] Common registry carries topology side effects into a consumer that does not connect upstreams.** `packages/runner/src/index.ts:84-133` only needs allow/approve metadata, but the plan's `urlFromEnv()` is evaluated inside `PROXY_REGISTRY` in `@thor/common`. That makes env-driven topology part of a shared import surface and creates brittle import-order behavior in tests for no product gain.
  **Recommendation:** Keep policy data in `@thor/common`; resolve `PROXY_*_URL` lazily in `remote-cli` only.

- **[MEDIUM] Env URL overrides are a real SSRF expansion and the plan under-specifies controls.** The new override mechanism opens outbound MCP connections to whatever URL string lands there (`packages/remote-cli/src/upstream.ts:18-38`). Operator-controlled, not agent-controlled, but still widens the blast radius of bad env injection or copy-paste mistakes.
  **Recommendation:** Validate overrides at startup and reject malformed or non-`http(s)` URLs, with a loud log when an override is active.

- **[MEDIUM] `McpServiceDeps.registry` hatch is hidden complexity with no production value.** Current seams in `packages/remote-cli/src/mcp-handler.ts:53-60` inject I/O, not policy source. The plan adds `registry?` purely for tests, which recreates runtime configurability through the back door and makes the service API wider than the intended product model.
  **Recommendation:** Drop the DI hatch; mock the proxy module in tests (`vi.mock('@thor/common')`).

### Architecture concerns

- `PROXY_REGISTRY` in `@thor/common` is reasonable for shared policy, but the plan needs a hard distinction between **catalog** (registry), **enabled set** (derived from `repos[*].proxies`), and **live connection state** (McpService instances).
- `runner` should depend on policy metadata only; it should not import URL-bearing topology resolution.
- `repos[*].proxies` remains stringly typed across `workspace-config`, `remote-cli`, and `runner`; a derived `ProxyName` would reduce drift without changing the user-facing config format.
- CODEOWNERS is load-bearing for the "policy is code" claim; treating it as an external follow-up is weak.

### Test gaps

- Rewrite `packages/common/src/workspace-config.test.ts:40-68, 197-203, 281-299` — those assert top-level `config.proxies` and `getProxyConfig`.
- Add a Phase 2 test that a stray top-level `proxies` key is rejected (requires `.strict()`; `workspace-config.ts:36-40` is not strict today).
- `remote-cli`: only Slack is enabled and `ATLASSIAN_AUTH` is unset — startup and `/health` still work.
- `remote-cli`: malformed `PROXY_GRAFANA_URL` — Grafana fails cleanly without breaking Slack paths.
- Approval discovery tests for `approval list` / `approval status` for disabled upstreams.
- Runner tests for `buildToolInstructions` (no current tests cover this codepath).

### Recommended scope adjustments

- Add `getEnabledProxyNames(config)` and use it in `mcp-handler` for connect, health, and approval discovery.
- Remove `registry` from `McpServiceDeps`; use `vi.mock` against the proxy module.
- Move URL override resolution out of the common constant or behind a remote-cli helper.
- Reconcile drift-check CI (plan currently says "deferred" in one place and references `check:policy-drift` in another — pick one).
- Make CODEOWNERS gating part of completion, not an out-of-plan dependency.

### Overall verdict

**modify**

---

## CLAUDE SUBAGENT (eng — independent review)

### Findings

- **[HIGH] Env-override at import-time breaks testability and hot-reload.** Reading `process.env[...]` when `proxies.ts` is first evaluated freezes `PROXY_REGISTRY` to whatever env was present at first import. Vitest specs that set env in `beforeEach` will see no effect.
  **Recommendation:** Make `upstream.url` a getter, or compute it inside `getProxyConfig(name)` / at `connectInstance` time — lazy env reads only.

- **[HIGH] Plan retains `McpServiceDeps.registry?` injection — over-engineering.** `mcp-handler.ts:53-60` already has 5 optional deps. A hardcoded module constant is the textbook case for `vi.mock('@thor/common/proxies')`.
  **Recommendation:** Drop Decision #7; use module mocking in tests.

- **[HIGH] Empty-string env override replaces valid default with broken URL.** With `process.env[key] ?? defaultUrl`, an empty `PROXY_GRAFANA_URL=""` in docker-compose (common misconfiguration) passes the nullish check and yields an unparseable URL at `connectUpstream`.
  **Recommendation:** Treat empty string as unset (`env[key]?.trim() || defaultUrl`); validate final URL with `new URL(...)` at first connect.

- **[MEDIUM] `buildToolInstructions` silently drops upstreams on config errors.** `packages/runner/src/index.ts:92-97` swallows config load errors. Post-swap, if `config.json` is missing but registry exists, all repos lose tool instructions.
  **Recommendation:** Split the concern — load config for repo list; read allow/approve strictly from `PROXY_REGISTRY`; log when a repo references an unknown name.

- **[MEDIUM] `getAllowedUpstreamsForRepo` dual-filter becomes dead code.** `mcp-handler.ts:266-273` filters repo-declared names against `config.proxies?.[name]`. Post-swap + Phase 2 load-time validation (`workspace-config.ts:113-122`), the runtime filter is redundant.
  **Recommendation:** Remove the runtime `.filter(...)` — load-time validation covers it and makes unknown names fail loud.

- **[MEDIUM] Repo-level validation against `PROXY_NAMES` creates package-level circular-dep risk.** Plan moves the `repos[*].proxies` validator to check against `PROXY_NAMES` from `./proxies.js`. `proxies.ts` imports types from `workspace-config.ts` — two-way import. `import type` is erased at runtime, but verify.
  **Recommendation:** Confirm `import type` stays type-only at runtime; otherwise extract shared types to a third file.

- **[LOW] `proxies.test.ts` "allow/approve disjoint" assertion duplicates `validatePolicy`.** `packages/remote-cli/src/policy-mcp.ts`'s `PolicyOverlapError` already covers this at `mcp-handler.ts:207`.
  **Recommendation:** OK to keep the registry-level test as a second net, but note overlap.

### Architecture concerns

- Env override belongs at **connect-time**, not at module import.
- Ownership split is right (common owns registry, remote-cli + runner consume), but the runner now reads registry _and_ config — two sources of truth per repo; make the split explicit.
- `PROXY_NAMES` as `readonly string[]` loses type narrowing. `type ProxyName = keyof typeof PROXY_REGISTRY` + `z.enum(PROXY_NAMES)` is a one-line typing win; worth doing in P1.
- CODEOWNERS on `packages/common/src/proxies.ts` is ship-blocker, not code-blocker — plan acknowledges.

### Test gaps

- `PROXY_<NAME>_URL` env override resolution (empty, unset, valid, malformed).
- Removing `proxies` from `config.json` but keeping `repos[*].proxies` still produces working MCP call (integration path).
- Unknown name in `repos[*].proxies` throws at `loadWorkspaceConfig` with helpful error listing `PROXY_NAMES`.
- Regression: `getHealth()` still reports correct `configured` count from registry.
- Runner test for `buildToolInstructions` reading from registry when `config.proxies` absent.
- Assertion that `ATLASSIAN_AUTH` / `POSTHOG_API_KEY` interpolation still runs.
- `WorkspaceConfigSchema.strict()` rejects stray top-level `proxies: {...}`.

### Scope adjustments

**Add:**

- Lazy env override resolution (compute URL at `connectInstance`).
- Empty-string env handling + `new URL(...)` validation.
- `type ProxyName = keyof typeof PROXY_REGISTRY` and `z.enum([...PROXY_NAMES])` on `RepoConfigSchema.proxies`.
- CODEOWNERS as an exit criterion, not a post-hoc task.
- Startup header-interpolation smoke check for `ATLASSIAN_AUTH`/`POSTHOG_API_KEY`.

**Remove:**

- `McpServiceDeps.registry?` (Decision #7).
- Runtime `.filter(...)` in `getAllowedUpstreamsForRepo`.

### Verdict

**modify**

---

## Eng Dual Voices — Consensus Table

| Dimension                       | Codex     | Claude  | Consensus                                      |
| ------------------------------- | --------- | ------- | ---------------------------------------------- |
| 1. Architecture sound?          | Modify    | Modify  | **CONFIRMED** — separate catalog/enabled/live  |
| 2. Test coverage sufficient?    | No        | No      | **CONFIRMED** — 7+ gaps                        |
| 3. Performance risks addressed? | N/A       | N/A     | N/A — refactor, not perf-sensitive             |
| 4. Security threats covered?    | No (SSRF) | Partial | **CONFIRMED** — env URL validation required    |
| 5. Error paths handled?         | No        | No      | **CONFIRMED** — empty-env, missing-config gaps |
| 6. Deployment risk manageable?  | Yes       | Yes     | **CONFIRMED** — rollback is `git revert`       |

Cross-phase themes:

- **Topology/policy separation** (CEO + Eng) — both phases, both voices. High-confidence signal: don't put URL resolution in common.
- **CODEOWNERS criticality** (CEO + Eng) — load-bearing for the security claim; must be a completion gate.
- **Hidden DI complexity (McpServiceDeps.registry)** — Claude CEO (LOW) + both Eng voices (MEDIUM/HIGH). Drop it.

---

## Section 1 — Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ @thor/common (pure policy data, no I/O)                          │
│   proxies.ts                                                     │
│   ├── PROXY_REGISTRY: Record<ProxyName, ProxyConfig>  (catalog)  │
│   ├── type ProxyName = keyof typeof PROXY_REGISTRY               │
│   └── PROXY_NAMES: readonly ProxyName[]                          │
│   workspace-config.ts (unchanged except: validates against       │
│                        PROXY_NAMES, drops top-level proxies)     │
└────────────────┬─────────────────────────────┬───────────────────┘
                 │                             │
                 │ imports policy only         │ imports policy only
                 ▼                             ▼
   ┌─────────────────────────┐      ┌──────────────────────────┐
   │ @thor/runner            │      │ @thor/remote-cli         │
   │   buildToolInstructions │      │   mcp-handler.ts         │
   │   (allow/approve only)  │      │   ├── enabledNames(cfg)  │
   │                         │      │   │    = union repos[*]  │
   │                         │      │   ├── resolveUrl(name)   │
   │                         │      │   │    = env ?? default  │
   │                         │      │   │       + URL validate │
   │                         │      │   └── connectInstance(n) │
   │                         │      │        lazy URL resolve  │
   └─────────────────────────┘      └──────────────────────────┘
```

**Key invariants:**

- Catalog (`PROXY_REGISTRY`): superset. Every known upstream.
- Enabled set (`getEnabledProxyNames(config)`): runtime. Union of `repos[*].proxies`.
- Live connections: only upstreams in the enabled set get `getInstance` / `connectConfiguredUpstreams`.
- URL resolution: `remote-cli`-only. `@thor/common/proxies.ts` has **no** env reads.

## Section 3 — Test Diagram

| New/changed codepath                        | Unit test                          | Integration test                 | Exists? | Gap?                                                                |
| ------------------------------------------- | ---------------------------------- | -------------------------------- | ------- | ------------------------------------------------------------------- |
| `PROXY_REGISTRY` literal                    | `proxies.test.ts`: shape assertion | —                                | New     | Add: 4 keys, header env refs                                        |
| `type ProxyName` / `z.enum(PROXY_NAMES)`    | `workspace-config.test.ts`         | —                                | Partial | Rewrite existing unknown-proxy test                                 |
| `getEnabledProxyNames(config)`              | `mcp-handler.test.ts` (new)        | —                                | No      | Add: empty, 1 repo, overlap, unknown repo                           |
| `resolveUrl(name)` (remote-cli helper)      | `mcp-handler.test.ts` (new)        | `e2e/mcp-grafana-override.sh`    | No      | Add: unset, empty, valid, malformed, non-http scheme                |
| `connectConfiguredUpstreams` → enabled-only | `mcp-handler.test.ts`              | existing e2e                     | Partial | Add: Atlassian disabled + `ATLASSIAN_AUTH` unset = no error at boot |
| `buildToolInstructions` registry read       | `runner/index.test.ts` (new)       | `scripts/test-e2e.sh` or similar | No      | Add: reads from registry with config absent                         |
| `getAllowedUpstreamsForRepo`                | `mcp-handler.test.ts`              | —                                | Yes     | Rewrite after removing runtime filter                               |
| `WorkspaceConfigSchema.strict()`            | `workspace-config.test.ts`         | —                                | No      | Add: stray top-level `proxies` rejected                             |
| `getProxyConfig(name)` (new, in proxies.ts) | `proxies.test.ts`                  | —                                | No      | Add: known name, unknown name                                       |
| Approval store for disabled upstream        | `mcp-handler.test.ts`              | —                                | Partial | Add: `approval list` when upstream disabled                         |

## Section 4 — Performance

No perf-sensitive paths changed. Registry is module-init and reads a static object; env resolution adds one `process.env` lookup per `connectInstance` (rare, amortized). Nothing to benchmark.

## Failure Modes Registry (updated from Phase 1)

| Codepath                               | Failure mode                                         | Rescued?                           | Test?        | User sees                         | Logged? |
| -------------------------------------- | ---------------------------------------------------- | ---------------------------------- | ------------ | --------------------------------- | ------- |
| `PROXY_REGISTRY` module load           | Syntax / type error                                  | N — process crash                  | Y (build)    | Container restart loop            | Y       |
| `interpolateHeaders` at connect        | `ATLASSIAN_AUTH` unset + Atlassian disabled for repo | Y — upstream never connects        | Y (new)      | Nothing                           | N       |
| `interpolateHeaders` at connect        | `ATLASSIAN_AUTH` unset + Atlassian enabled           | N — throws at first call           | Y (new)      | MCP tool unavailable, 500 on call | Y       |
| `resolveUrl` — env empty string        | `PROXY_GRAFANA_URL=""`                               | Y — treat as unset → default       | Y (new)      | Grafana routes to default         | Y       |
| `resolveUrl` — malformed URL           | `PROXY_GRAFANA_URL=notaurl`                          | N — throws `new URL()`             | Y (new)      | Loud startup error for grafana    | Y       |
| `resolveUrl` — non-http scheme         | `PROXY_GRAFANA_URL=file:///etc/passwd`               | N — throws (scheme check)          | Y (new)      | Loud startup error                | Y       |
| Repo references unknown proxy          | `repos[*].proxies: ["typo"]`                         | Y — throws at `loadConfig`         | Y            | Loud startup error                | Y       |
| Stray top-level `proxies` in config    | Leftover from old format                             | Y — zod rejects (`.strict()`)      | Y (new)      | Loud startup error                | Y       |
| `buildToolInstructions` config missing | `config.json` absent                                 | Y (today: silent); after: Y (loud) | Y (new)      | No tool instructions in session   | Y       |
| CODEOWNERS not configured              | Policy PR merges without SEC review                  | N — out of code scope              | N (gh check) | Silent governance gap             | N       |

**CRITICAL GAPS:**

1. **CODEOWNERS** — load-bearing governance. Must be enforced as a completion check via `gh api repos/$OWNER/$REPO/codeowners/errors` or similar, not treated as "out of plan."
2. **URL scheme validation** — plan did not originally specify; must reject `file://`, `javascript:`, etc.

## NOT in scope (Phase 3 confirmed)

- Drift-check CI (deferred; remove references in Phase 1 target shape).
- Operator CLI (`thor upstreams`).
- Per-repo policy overrides.
- Per-package registry splits.
- Approval store layout changes.

## What already exists (Phase 3 confirmed)

- `interpolateEnv` / `interpolateHeaders` (`packages/common/src/workspace-config.ts:210-232`).
- `validatePolicy` / `classifyTool` / `PolicyOverlapError` (`packages/remote-cli/src/policy-mcp.ts`) — registry disjoint check is duplicative.
- `ApprovalStore` — unchanged.
- `connectUpstream` (`packages/remote-cli/src/upstream.ts:18-38`) — unchanged.
- `createConfigLoader` — loads `config.json` still; no `proxies` field.
- `McpServiceDeps.configLoader` — unchanged.

## Phase 3 Scope Additions (confirmed)

Apply these changes to the plan (Phase 1 target shape) before implementation:

1. **Move `urlFromEnv` out of `@thor/common`.** Put `resolveUrl(name)` in `packages/remote-cli/src/mcp-handler.ts` or a new `packages/remote-cli/src/proxy-url.ts`. Common stays pure data.
2. **Add `getEnabledProxyNames(config)` in `@thor/common`.** Used by `mcp-handler` for connect / health / approval discovery. Catalog ≠ enabled set.
3. **Drop `McpServiceDeps.registry?` (Decision #7).** Use `vi.mock('@thor/common/proxies')` in tests.
4. **Add URL validation** in `resolveUrl`: treat empty string as unset; validate via `new URL(...)`; reject non-`http(s)` scheme; log loud when override active.
5. **Add `type ProxyName = keyof typeof PROXY_REGISTRY`**; tighten `RepoConfigSchema.proxies` to `z.array(z.enum(PROXY_NAMES))`.
6. **Remove the runtime `.filter(...)` in `getAllowedUpstreamsForRepo`** — load-time validation covers it.
7. **CODEOWNERS is an exit criterion**, not a follow-up. Exit criteria: `gh api repos/{owner}/{repo}/codeowners/errors` returns empty, and `packages/common/src/proxies.ts` has a matching rule.
8. **Remove drift-check CI references** — plan mentioned it inconsistently; it's out of scope per user premise gate. Delete from Phase 1 Completion Summary and 0C Dream State.
9. **Don't fail boot when an enabled upstream's secret is unset.** Add a startup warning log; let first-call failure surface the actual error.

## Phase 3 Completion Summary

- **Verdict:** modify (9 scope additions, all small).
- **Dual voices:** Codex 4 findings (1H, 3M). Claude 7 findings (3H, 3M, 1L). Consensus on: enabled-set vs catalog, lazy URL resolution, empty-string handling, drop DI hatch, CODEOWNERS as exit criterion, 7+ test gaps.
- **Cross-phase theme:** topology/policy separation surfaced in both CEO and Eng. Strong signal.

---

# /autoplan Phase 3.5 — DX Review

**DX scope trigger:** AI agent is primary user of MCP tool surface; engineers will need to add new upstreams via this codepath.

## CODEX SAYS (DX — developer experience challenge)

### Findings

- **[HIGH] Missing upgrade path for `config.json` migration.** Plan deliberately makes old top-level `proxies` fail `.strict()` validation (`docs/plan/2026041701_hardcode-proxies.md:214-216`), but does not include an operator migration note or rollout step; repo docs still show the old shape (`README.md:55`, `docs/examples/workspace-config.example.json:1`).
  **Recommendation:** Add a "Migrating from v(N-1)" section with before/after JSON, failure symptom, and required edit.

- **[MEDIUM] Add-new-upstream workflow is implied, not documented.** Plan lists touched files but leaves sequence unstated across `proxies.ts`, exports, tests, docs, and CODEOWNERS.
  **Recommendation:** Add a "How to add an upstream" checklist in-order, with required files and acceptance checks.

- **[MEDIUM] Local-dev override knob is not discoverable.** `PROXY_GRAFANA_URL` appears in plan but nowhere in user-facing docs, `.env.example`, or compose comments.
  **Recommendation:** Document `PROXY_<NAME>_URL` in README and `.env.example`, with one concrete local-dev example.

- **[MEDIUM] Public API discoverability is fuzzy.** Plan exports `getProxyConfig` and `PROXY_NAMES`, but `ProxyName` only appears as a Phase 3 scope addition, not in the primary target shape.
  **Recommendation:** Promote `ProxyName` into the main target shape and show one canonical import snippet.

- **[LOW] Error messaging is only partly specified.** Unknown `repos[*].proxies` is actionable (plan line 216). But no explicit operator-facing message for stale top-level `proxies` or invalid `PROXY_*_URL`.
  **Recommendation:** Add expected error text examples for those two cases.

### Verdict

**modify**

---

## CLAUDE SUBAGENT (DX — independent review)

### Findings

- **[HIGH] No CODEOWNERS file exists today — policy-as-code claim is unenforced.** `.github/` directory does not exist; no `CODEOWNERS` at repo root. Plan's core security rationale depends entirely on this file.
  **Recommendation:** Create `.github/CODEOWNERS` with `packages/common/src/proxies.ts @security-team` as part of Phase 1 (not follow-up).

- **[HIGH] Env-override documentation is absent.** `PROXY_GRAFANA_URL` / `PROXY_ATLASSIAN_URL` / `PROXY_POSTHOG_URL` / `PROXY_SLACK_URL` appear nowhere in `README.md`, `AGENTS.md`, `.env.example`, or `docker-compose.yml`.
  **Recommendation:** Add all four `PROXY_*_URL` rows to README's "Deployment Configuration" table and commented examples to `.env.example`.

- **[HIGH] No migration error wording specified.** Zod default ("Unrecognized key: 'proxies'") gives problem + cause but no fix — operator doesn't know the field moved to code.
  **Recommendation:** Wrap `loadWorkspaceConfig` with a targeted check: if input contains top-level `proxies`, throw "proxies field moved to code (`packages/common/src/proxies.ts`) in 2026-04. Remove it from config.json. See docs/plan/2026041701_hardcode-proxies.md."

- **[MEDIUM] `docs/examples/workspace-config.example.json` still ships old shape.** Phase 2 removes `proxies` per plan line 206 but no sample points to the registry.
  **Recommendation:** Add a comment block or sibling reference in README after Phase 2 edit.

- **[MEDIUM] `ProxyName` type not explicitly re-exported.** Current `packages/common/src/index.ts:19-20` re-exports `ProxyConfig`, `ProxyUpstream`. Plan adds `PROXY_REGISTRY`, `PROXY_NAMES`, `getProxyConfig` but omits `ProxyName`.
  **Recommendation:** Explicitly list `ProxyName` in the Phase 1 index.ts edit.

- **[MEDIUM] Upstream onboarding runbook does not exist.** No file documents "to add X: (1) edit proxies.ts, (2) add tests, (3) request @security-team review, (4) update compose if new service, (5) add secret to .env.example".
  **Recommendation:** Add "Adding an Upstream" section to AGENTS.md during Phase 2.

- **[LOW] `POSTHOG_API_KEY` header pattern (`Bearer ${POSTHOG_API_KEY}`) differs from `ATLASSIAN_AUTH` (`${ATLASSIAN_AUTH}` — full value).** Engineers cloning the atlassian pattern will forget the `Bearer` prefix.
  **Recommendation:** Document or unify in the registry comment.

### TTHW assessment

- **Current steps to add a new upstream:** 6–7 files/actions — `proxies.ts`, `index.ts` re-export, `proxies.test.ts`, possibly `docker-compose.yml`, `.env.example`, `README.md`, `CODEOWNERS` review, possibly `mcp-handler.test.ts`.
- **Target:** under 3 files + 1 test file + 1 docs update.
- **Gap:** Plan does not document the ordered procedure. A new engineer reverse-engineers steps from git history.

### Verdict

**modify**

---

## DX Dual Voices — Consensus Table

| Dimension                         | Codex   | Claude  | Consensus                                              |
| --------------------------------- | ------- | ------- | ------------------------------------------------------ |
| 1. Getting started < 5 min?       | No      | No      | **CONFIRMED** — no onboarding runbook                  |
| 2. API/CLI naming guessable?      | Partial | Partial | **CONFIRMED** — `ProxyName` must be in primary surface |
| 3. Error messages actionable?     | Partial | Partial | **CONFIRMED** — migration + bad-URL text missing       |
| 4. Docs findable & complete?      | No      | No      | **CONFIRMED** — env vars undocumented                  |
| 5. Upgrade path safe?             | No      | No      | **CONFIRMED** — migration note required                |
| 6. Dev environment friction-free? | Partial | No      | **CONFIRMED** — `PROXY_*_URL` not discoverable         |

## Developer Journey Map

| Stage            | Current                                          | Target (after plan + DX fixes)                               |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| Discover feature | Read plan file (ephemeral)                       | "Adding an Upstream" in AGENTS.md                            |
| Read sample      | Old shape in `workspace-config.example.json`     | `proxies.ts` is the reference; README points at it           |
| Write code       | Edit 6-7 files; infer order                      | Edit 3 files; checklist in AGENTS.md                         |
| Run locally      | Patch source to point at local grafana           | `PROXY_GRAFANA_URL=http://localhost:8000 docker compose up`  |
| Test locally     | No template test; copy from neighboring upstream | `proxies.test.ts` has parameterized coverage                 |
| Hit error        | "Unrecognized key: 'proxies'" (unhelpful)        | "proxies field moved to code; remove from config.json. See…" |
| Get review       | Unknown reviewer group                           | CODEOWNERS auto-assigns `@security-team`                     |
| Ship             | Unknown exit checks                              | Test plan artifact + e2e smoke                               |
| Rollback         | Reverse 6-7 files                                | `git revert`                                                 |

## Developer Empathy Narrative

> "Hey, I want to add Linear MCP. Where do I start?"
>
> **Today:** Open the most recent commit that added an upstream (Slack? When was that?). Read the diff. Edit 6 files in the same shape. Run tests — one fails because I forgot `PROXY_LINEAR_URL` in `.env.example`. No, wait, `.env.example` doesn't have any `PROXY_*_URL`. Grep the repo. Find it in `proxies.ts`. Ask the team on Slack: "do I need to add a CODEOWNERS entry?" Silence. Merge anyway. Two weeks later a security engineer asks why they weren't tagged on review.
>
> **After DX fixes:** Open `AGENTS.md`. Scroll to "Adding an Upstream". Five-step checklist. I edit 3 files, run `pnpm test`, open PR. CODEOWNERS auto-tags security. CI runs. I ship in 20 minutes.

## DX Scorecard

| Dimension                       | Current | With plan | With plan + DX fixes |
| ------------------------------- | ------- | --------- | -------------------- |
| 1. Getting started (TTHW)       | 4/10    | 5/10      | 8/10                 |
| 2. API naming & discoverability | 5/10    | 6/10      | 8/10                 |
| 3. Error message quality        | 4/10    | 5/10      | 8/10                 |
| 4. Docs completeness            | 4/10    | 4/10      | 8/10                 |
| 5. Upgrade/migration safety     | 4/10    | 3/10      | 8/10                 |
| 6. Dev environment friction     | 5/10    | 6/10      | 8/10                 |
| 7. Escape hatches               | 6/10    | 7/10      | 8/10                 |
| 8. Competitive benchmark        | 5/10    | 6/10      | 8/10                 |
| **Overall**                     | **4.6** | **5.3**   | **8.0**              |

## DX Implementation Checklist (additions to plan)

Add these as Phase 2 tasks (documentation sweep):

1. **CODEOWNERS file:** create `.github/CODEOWNERS` with:

   ```
   packages/common/src/proxies.ts @security-team @platform-team
   ```

   Commit in Phase 1; enforce via branch protection separately.

2. **README.md — Deployment Configuration table:** add a row per `PROXY_<NAME>_URL` env var with default value and "override when pointing at a local MCP server".

3. **`.env.example`:** add commented lines:

   ```
   # PROXY_GRAFANA_URL=http://grafana-mcp:8000/mcp
   # PROXY_SLACK_URL=http://slack-mcp:3003/mcp
   # PROXY_ATLASSIAN_URL=https://mcp.atlassian.com/v1/mcp
   # PROXY_POSTHOG_URL=https://mcp.posthog.com/mcp
   ```

4. **AGENTS.md — "Adding an Upstream" section:**
   1. Add a registry entry in `packages/common/src/proxies.ts` (URL, headers, allow, approve).
   2. Add secret to `.env.example` and `docker-compose.yml` if needed.
   3. Add `PROXY_<NAME>_URL` to README's deployment table.
   4. Run `pnpm -r test` — failing tests point at specific coverage gaps.
   5. Open PR. CODEOWNERS auto-tags `@security-team` for policy review.

5. **Migration error wrapper:** in `loadWorkspaceConfig`, detect stray top-level `proxies` before `.strict()` catches it, and throw a targeted error:

   > "Top-level `proxies` has moved to code (`packages/common/src/proxies.ts`) as of 2026-04. Remove it from `config.json`. See `docs/plan/2026041701_hardcode-proxies.md` for the migration note."

6. **`ProxyName` in primary target shape:** move the `type ProxyName = keyof typeof PROXY_REGISTRY` declaration into the main `proxies.ts` target shape example (not a Phase 3 addendum). Re-export from `packages/common/src/index.ts`.

7. **Header pattern comment in `proxies.ts`:** add a one-line note above `atlassian` / `posthog` entries explaining the `Bearer` vs raw-value distinction.

8. **Update `docs/examples/workspace-config.example.json`:** after Phase 2 removes the `proxies` block, add a header comment pointing to `packages/common/src/proxies.ts`.

## Phase 3.5 Completion Summary

- **Verdict:** modify (8 DX fixes, all small — about 2-3 hours of docs + a 20-line migration wrapper).
- **Dual voices:** Codex 5 findings (1H, 3M, 1L). Claude 7 findings (3H, 3M, 1L). Strong consensus — every finding is backed by both or clearly complementary.
- **TTHW:** 6-7 steps → 3 files + 1 test + 1 docs update. Requires "Adding an Upstream" runbook.
- **Overall DX score:** 4.6 → 5.3 (with plan as-is) → 8.0 (with DX fixes). Plan WITHOUT the DX fixes _regresses_ the migration-safety dimension because `.strict()` rejection will surface unhelpful error text by default.

---

<!-- AUTONOMOUS DECISION LOG -->

## Decision Audit Trail

| #   | Phase     | Decision                                                           | Classification           | Principle         | Rationale                                                                                              | Rejected                                         |
| --- | --------- | ------------------------------------------------------------------ | ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 1   | Phase 1   | Mode: SELECTIVE EXPANSION                                          | Mechanical               | P2 (boil lakes)   | Both CEO voices agreed; expansions are in blast radius + < 1 day CC                                    | SCOPE EXPANSION (over-scope), HOLD (under-scope) |
| 2   | Phase 1   | Policy hardcoded in `proxies.ts` (not JSON manifest)               | User Gate                | —                 | User answered A at premise gate                                                                        | Codex's JSON-manifest alternative                |
| 3   | Phase 1   | Reversal of 2026033101 is intentional; add Principle Reset section | User Gate                | —                 | User answered A at premise gate                                                                        | Re-open 2026033101 first                         |
| 4   | Phase 1   | Env-overridable URLs (Alternative D)                               | User Gate                | —                 | User answered B at premise gate                                                                        | Fully hardcoded URLs                             |
| 5   | Phase 3   | Split catalog (registry) from enabled set (`getEnabledProxyNames`) | Mechanical               | P5 (explicit)     | Both Eng voices HIGH; without it, unset `ATLASSIAN_AUTH` = startup regression                          | N/A — clearly correct                            |
| 6   | Phase 3   | Move `urlFromEnv` out of `@thor/common` into `remote-cli`          | Mechanical               | P5 (explicit)     | Runner doesn't need topology. Common stays pure data. Both Eng voices concurred.                       | Keep in common (import-time side effects)        |
| 7   | Phase 3   | Drop `McpServiceDeps.registry?` (Decision #7 in original plan)     | Auto (on behalf of user) | P3+P5             | Both Eng voices flagged as over-engineering. Use `vi.mock`. User implicitly accepted via no-challenge. | Keep DI hatch                                    |
| 8   | Phase 3   | URL validation (empty-string, malformed, non-http scheme)          | Mechanical               | P1 (completeness) | SSRF expansion surface; validation cost is 3 lines                                                     | Skip (ship fast)                                 |
| 9   | Phase 3   | `type ProxyName` + `z.enum(PROXY_NAMES)`                           | Mechanical               | P5 (explicit)     | One-line typing win; both voices concurred                                                             | `string[]` (regression vs today)                 |
| 10  | Phase 3   | Remove runtime `.filter(...)` in `getAllowedUpstreamsForRepo`      | Mechanical               | P4 (DRY)          | Load-time validation covers it; runtime filter is dead code                                            | Keep redundant filter                            |
| 11  | Phase 3   | CODEOWNERS as exit criterion (not follow-up)                       | Mechanical               | P1 (completeness) | Load-bearing for the security claim. Without it, the governance premise is unfounded.                  | Defer to post-ship                               |
| 12  | Phase 3   | Remove drift-check CI references                                   | Auto                     | P3 (pragmatic)    | User deferred in premise gate; keep plan internally consistent                                         | Keep as "deferred" mentions                      |
| 13  | Phase 3   | Startup warning (not boot failure) for unset secrets               | Mechanical               | P3 (pragmatic)    | Atlassian-disabled repos shouldn't crash on missing `ATLASSIAN_AUTH`                                   | Fail boot                                        |
| 14  | Phase 3.5 | Add CODEOWNERS file in Phase 1                                     | Mechanical               | P1 (completeness) | Claude DX HIGH — file doesn't exist today                                                              | Assume CODEOWNERS exists                         |
| 15  | Phase 3.5 | Document `PROXY_*_URL` in README + `.env.example`                  | Mechanical               | P1                | Both DX voices HIGH/MEDIUM                                                                             | Plan-file-only docs                              |
| 16  | Phase 3.5 | Migration error wrapper in `loadWorkspaceConfig`                   | Mechanical               | P1+P5             | Zod default message is unhelpful for schema migration                                                  | Rely on `.strict()` default                      |
| 17  | Phase 3.5 | "Adding an Upstream" runbook in AGENTS.md                          | Mechanical               | P1                | Both DX voices MEDIUM; TTHW 6-7 → 3 files                                                              | Rely on git history                              |
| 18  | Phase 3.5 | Promote `ProxyName` into primary target shape                      | Mechanical               | P5                | Both DX voices MEDIUM; API surface clarity                                                             | Keep as Phase 3 addendum                         |
| 19  | Phase 3.5 | Header pattern comment (Bearer vs raw)                             | Mechanical               | P5                | Prevents future typo; 2-line comment                                                                   | Skip                                             |

---

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                       | Runs | Status      | Findings                                                           |
| ------------- | --------------------- | ------------------------- | ---- | ----------- | ------------------------------------------------------------------ |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy          | 1    | issues_open | 10 findings (1 CRITICAL, 4 HIGH, 3 MEDIUM, 2 LOW); verdict: modify |
| Codex Review  | `codex exec`          | Independent 2nd opinion   | 3    | issues_open | CEO 4, Eng 4, DX 5 — all "modify" verdicts                         |
| Eng Review    | `/plan-eng-review`    | Architecture & tests      | 1    | issues_open | 11 findings (4 HIGH, 6 MEDIUM, 1 LOW); 9 scope additions           |
| Design Review | `/plan-design-review` | UI/UX gaps                | 0    | skipped     | No UI scope in plan                                                |
| DX Review     | `/plan-devex-review`  | Developer experience gaps | 1    | issues_open | 12 findings (4 HIGH, 6 MEDIUM, 2 LOW); 8 scope additions           |

**VERDICT:** MODIFY-RECOMMENDED — strong consensus across all voices. 19 auto-decisions logged. Premise gate passed. All scope additions are small (< 1 day CC); without them plan regresses migration-safety DX dimension.

---

## STATUS

- **Autoplan:** approved as-is on 2026-04-17 (all 17 auto-decided scope additions accepted)
- **Mode:** SELECTIVE EXPANSION
- **Next step:** `/ship` — implement Phase 1 (hardcoded `PROXY_REGISTRY` + `repos[].proxies` + CODEOWNERS + migration error + README/.env.example), one commit per phase per AGENTS.md
