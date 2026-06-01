# langfuse remote MCP (profile-aware)

Replace the read-only Langfuse **CLI** integration (`/exec/langfuse` + `langfuse-cli` npm
global + `langfuse` wrapper) with Langfuse's hosted **remote MCP server**, so Langfuse
joins `atlassian` / `grafana` / `posthog` in the profile-aware MCP proxy registry and is
reachable through the existing `mcp` CLI. This supersedes `2026041502_langfuse-cli.md`.

## Why

The CLI integration predates profile-based integration routing
(`2026052701_profile-based-integration-routing.md`). It resolves a single global
`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` triple and cannot route
credentials per Thor profile. Langfuse now ships a hosted remote MCP server
(`{host}/api/public/mcp`, streamable HTTP, `Authorization: Basic base64(pk:sk)`), so we can
drop the bespoke CLI surface and reuse the `resolveProxyConfig` credential-routing path that
already gives PostHog/Grafana profile suffixes (`*_<PROFILE>` → global fallback).

## Scope

**In scope**

- Add `langfuse` to `PROXY_NAMES` with a **read-only** allow list and no approve/write tools
  (preserves the prior CLI's read-only posture).
- Resolve the Langfuse upstream in `resolveProxyConfig`: `LANGFUSE_PUBLIC_KEY` +
  `LANGFUSE_SECRET_KEY` are a strict credential bundle (profile suffix first, global fallback,
  fail hard on a half-scoped pair per profile-routing Decision 12); `LANGFUSE_HOST` is a single
  required global env var, validated https, fail fast if unsafe, no default.
- Remove the CLI surface end to end: `/exec/langfuse` endpoint, `validateLangfuseArgs` +
  tests, the `langfuse` OpenCode wrapper, the `langfuse-cli` npm global, the `langfuse: 4`
  `KNOWN_BINS` entry, and the standalone-binary skill instructions.
- Rewrite the `langfuse` skill and `build.md` mention to use `mcp langfuse <tool>`.
- Update README integration/env tables, `.env.example`, and `security-model.md`.

**Out of scope**

- Langfuse **write** tools (prompt/dataset/score/annotation mutations). Keep langfuse
  read-only; revisit approvals separately if a write use case appears.
- Per-profile tool allow/approve policy (stays global per integration, per profile routing
  Decision 6).
- Changing the `profiles` config shape, Slack admission, or the strict resolver.
- A `grafana-mcp`-style sidecar — Langfuse MCP is hosted remote like PostHog/Atlassian, so it
  connects directly with no new compose service.

## Environment resolution contract

For a profile `LABS`, the **credential bundle** is `pk+sk` (strict — both or neither scoped):

- `LANGFUSE_PUBLIC_KEY_LABS` + `LANGFUSE_SECRET_KEY_LABS`
- else `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`
- else disabled.
- If exactly one of the `*_LABS` pk/sk pair is set → throw (no silent mix of profile and
  global credential scopes).

The **host** is a single required global env var — `LANGFUSE_HOST`. There is no per-profile
host override and no default: if `LANGFUSE_HOST` is unset, Langfuse is disabled (same as
missing credentials). The host **must be https**, since the key pair is sent as HTTP Basic;
a non-https or malformed `LANGFUSE_HOST` **throws** (fail fast) rather than connecting and
leaking credentials in cleartext.

Upstream: `url = ${LANGFUSE_HOST}/api/public/mcp`, `headers.Authorization = Basic base64(pk:sk)`.

## Allow list (read-only)

Observability/debugging read tools only: `listObservations`, `getObservation`,
`getObservationFieldSchema`, `getObservationFilterSchema`, `getObservationFilterValues`,
`queryMetrics`, `getMetricsSchema`, `listScores`, `getScore`, `listScoreConfigs`,
`getScoreConfig`. Write/delete tools (create/update/upsert/delete on prompts, datasets,
scores, annotation queues, comments, models) are intentionally excluded → they classify as
`hidden` and are unreachable. Read-only model, prompt, health, and media tools are also left
out because they are not part of Thor's normal Langfuse debugging surface.

### Parity with the old CLI policy

The old `validateLangfuseArgs` allowed `list`/`get`/`--help` on `traces`, `sessions`,
`observations`, `metrics`, `models`, `prompts`, plus `__schema`. The MCP allow list is **not
a 1:1 port** — it preserves the read-only posture but the tool coverage differs:

| Old CLI resource | MCP allow-list equivalent                                            | Note                                                                                                           |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `observations`   | `listObservations`, `getObservation` (+ field/filter schema helpers) | covered                                                                                                        |
| `metrics`        | `queryMetrics`, `getMetricsSchema`                                   | covered                                                                                                        |
| `models`         | _(none)_                                                             | omitted from the normal MCP surface because current Thor use cases do not rely on it                           |
| `prompts`        | _(none)_                                                             | omitted from the normal MCP surface because current Thor use cases do not rely on it                           |
| `__schema`       | `--help` + `getObservationFilterSchema` / `getMetricsSchema`         | per-tool schema, not a single resource                                                                         |
| `traces`         | _(none)_                                                             | the hosted MCP server exposes no dedicated trace tool; query traces via `listObservations` (carries `traceId`) |
| `sessions`       | _(none)_                                                             | likewise no session tool; filter observations by `sessionId`                                                   |

Deliberate differences from the old scope:

- **Wider:** `listScores` / `getScore` / `listScoreConfigs` / `getScoreConfig` are exposed
  even though the old CLI never had them. They are read-only and fit the
  observability/debugging goal.
- **Narrower (upstream-driven, not a policy choice):** the old `traces` and `sessions`
  resources have no dedicated MCP tool, so that exact capability is not represented;
  `listObservations` filtering is the replacement path.
- **Narrower (policy choice):** read-only model, prompt, health, and media MCP tools are not
  exposed until there is a demonstrated Thor use case.

Tool names are transcribed from the published MCP reference and are cross-checked at connect
time by `validatePolicy` (warns in production, throws in dev on drift). Verify against the
live endpoint if names diverge.

## Decision log

| #   | Decision                                                                         | Rationale                                                                                                                                                                                                                                                                                                                                                                                            | Rejected                                                                                                                                     |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Langfuse becomes an MCP proxy, not a profile-aware CLI                           | Hosted remote MCP exists; reusing `resolveProxyConfig` gets profile routing for free and deletes the bespoke `/exec/langfuse` + policy surface                                                                                                                                                                                                                                                       | Keep the CLI and bolt profile-suffix env resolution onto `/exec/langfuse`                                                                    |
| 2   | Keep langfuse read-only (allow reads, no approve list)                           | Matches the prior CLI's hard read-only policy; no write use case today; keeps `APPROVAL_TOOL_NAMES` assertion unchanged                                                                                                                                                                                                                                                                              | Expose write tools behind approvals now                                                                                                      |
| 3   | Treat pk+sk as a strict credential bundle (both profile-scoped, or both global)  | A half-scoped credential pair is almost certainly an operator typo; failing hard beats silently mixing a profile pk with a global sk                                                                                                                                                                                                                                                                 | Single-var soft fallback per key (could mix profile pk with global sk)                                                                       |
| 5   | `LANGFUSE_HOST` is a single required global env var, validated https, no default | Simplest model — one endpoint per deployment, set explicitly. Avoids the "which host pairs with scoped creds" ambiguity entirely. Fail fast on a non-https/malformed host because the key pair is sent as HTTP Basic and would otherwise leak in cleartext. Unset host → integration disabled. Supersedes the per-profile host / `us` default / fallback designs explored during the PR #178 review. | `us` default; per-profile `LANGFUSE_HOST_<PROFILE>`; scoped→global→default fallback (all add ambiguity for a single per-deployment endpoint) |
| 4   | Insert `langfuse` alphabetically in `PROXY_NAMES`                                | Stable, predictable ordering in listings/health; only the one order assertion in `proxies.test.ts` changes                                                                                                                                                                                                                                                                                           | Append at end                                                                                                                                |

## Phases

### Phase 1 — Registry + credential routing (`@thor/common`)

Add `langfuse` to `PROXY_NAMES`, the read-only `LANGFUSE_ALLOW`, and the `resolveProxyConfig`
bundle branch. Update `proxies.test.ts` (order assertion + langfuse profile/global/partial
cases).

**Exit:** `pnpm --filter @thor/common test` green; langfuse resolves profile-first with global
fallback and throws on a partial profile bundle.

### Phase 2 — Remove the CLI surface (`@thor/remote-cli`, `@thor/runner`)

Delete `/exec/langfuse`, `validateLangfuseArgs` + its tests + imports, and the `langfuse: 4`
`KNOWN_BINS` entry.

**Exit:** `pnpm --filter @thor/remote-cli test` and `pnpm --filter @thor/runner test` green;
no remaining `validateLangfuseArgs` references.

### Phase 3 — Container + wrappers

Delete `docker/opencode/bin/langfuse`, its Dockerfile `COPY`, and `langfuse-cli@0.0.8` from
the npm global install.

**Exit:** no `langfuse` standalone binary shipped; `mcp` wrapper unchanged.

### Phase 4 — Skills, prompt, docs, env

Rewrite the `langfuse` skill for `mcp langfuse <tool>`; update `build.md`, README
(integration row → MCP, env var Service column), `.env.example` (profile-scoped example +
MCP note), and `security-model.md`.

**Exit:** docs describe MCP access only; no doc implies a `langfuse` CLI or `/exec/langfuse`.

### Phase 5 — Integration verification

Push branch, let core/sandbox e2e run (LANGFUSE\_\* CI env stays valid), open PR against `main`
once green.

## Test plan

- `pnpm --filter @thor/common test`
- `pnpm --filter @thor/remote-cli test`
- `pnpm --filter @thor/runner test`
- Build typecheck across workspace.
- e2e: langfuse appears in `mcp` listing only when creds are configured; absent for profiles
  without resolvable creds.

## Migration notes

- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` keep their names and global
  meaning; profile variants add `_<PROFILE>` suffixes. No flag day.
- Existing prompts/skills that shelled out to `langfuse api ...` must switch to
  `mcp langfuse <tool>`; the standalone binary is removed.
