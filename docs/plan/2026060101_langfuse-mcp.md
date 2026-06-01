# langfuse remote MCP (profile-aware)

Replace the read-only Langfuse **CLI** integration (`/exec/langfuse` + `langfuse-cli` npm
global + `langfuse` wrapper) with Langfuse's hosted **remote MCP server**, so Langfuse
joins `atlassian` / `grafana` / `posthog` in the profile-aware MCP proxy registry and is
reachable through the existing `mcp` CLI. This supersedes `2026041502_langfuse-cli.md`.

## Why

The CLI integration predates profile-based integration routing
(`2026052701_profile-based-integration-routing.md`). It resolves a single global
`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` triple and cannot route
credentials per Thor profile. Langfuse now ships a hosted remote MCP server
(`{host}/api/public/mcp`, streamable HTTP, `Authorization: Basic base64(pk:sk)`), so we can
drop the bespoke CLI surface and reuse the `resolveProxyConfig` credential-routing path that
already gives PostHog/Grafana profile suffixes (`*_<PROFILE>` → global fallback).

## Scope

**In scope**

- Add `langfuse` to `PROXY_NAMES` with a **read-only** allow list and no approve/write tools
  (preserves the prior CLI's read-only posture).
- Resolve the Langfuse upstream in `resolveProxyConfig`: `LANGFUSE_PUBLIC_KEY` +
  `LANGFUSE_SECRET_KEY` + `LANGFUSE_BASE_URL` are one strict bundle (profile suffix first, global
  fallback, fail hard on a partial bundle per profile-routing Decision 12). The resolved host is
  normalized via the shared `envBaseUrl` helper (trailing slash stripped); no default. The scheme
  is not enforced — http is accepted for self-hosted instances inside a trusted network.
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

For a profile `LABS`, the **bundle** is all three of `pk`, `sk`, and base URL — strict (all
three scoped, or none):

- `LANGFUSE_PUBLIC_KEY_LABS` + `LANGFUSE_SECRET_KEY_LABS` + `LANGFUSE_BASE_URL_LABS`
- else the global `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` + `LANGFUSE_BASE_URL`
- else disabled.
- If any of the three `*_LABS` vars is set but not all three → throw, naming the missing legs
  (no silent mix of profile and global scopes, and no scoped keys routed at the global host).

A region/instance profile thus carries its own host alongside its own keys, so it authenticates
against the matching endpoint and is a distinct upstream target. There is no default: if no
bundle resolves, Langfuse is disabled. The resolved host is normalized at the boundary via the
shared `envBaseUrl` helper (trailing slashes stripped). The scheme is **not enforced**: Langfuse
Cloud uses https, but a self-hosted instance may legitimately run on http inside a trusted
network (e.g. behind a VPC), so requiring https in code would wrongly reject a valid deployment.

Upstream: `url = ${host}/api/public/mcp`, `headers.Authorization = Basic base64(pk:sk)`.

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

| #   | Decision                                                                                                            | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rejected                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Langfuse becomes an MCP proxy, not a profile-aware CLI                                                              | Hosted remote MCP exists; reusing `resolveProxyConfig` gets profile routing for free and deletes the bespoke `/exec/langfuse` + policy surface                                                                                                                                                                                                                                                                                                                                                                   | Keep the CLI and bolt profile-suffix env resolution onto `/exec/langfuse`                                                                                                                                                                           |
| 2   | Keep langfuse read-only (allow reads, no approve list)                                                              | Matches the prior CLI's hard read-only policy; no write use case today; keeps `APPROVAL_TOOL_NAMES` assertion unchanged                                                                                                                                                                                                                                                                                                                                                                                          | Expose write tools behind approvals now                                                                                                                                                                                                             |
| 3   | Treat pk + sk + base URL as one strict bundle (all three profile-scoped, or all three global)                       | A half-scoped bundle is almost certainly an operator typo; failing hard beats silently mixing a profile pk with a global sk, or routing scoped keys at the global host. Folding the host into the bundle (vs. an independent host with its own fallback) means every profile is fully self-describing — there is no exception where a profile borrows the global host — which is the desired contract                                                                                                            | Independent per-key/per-host fallback (could mix a profile pk with a global sk, or send scoped keys to the wrong host)                                                                                                                              |
| 5   | The host (`LANGFUSE_BASE_URL`) is part of the strict bundle — every profile sets its own, no exception              | A region/instance profile (e.g. `EU`) must route its scoped keys at the matching host, or it silently sends EU keys to the global US host and fails to authenticate. Earlier iterations tried global-only host (made a regional profile impossible) and an independently-scoped host with a global fallback (allowed scoped-creds-on-global-host); both are superseded by requiring all three together. A scoped bundle is a distinct upstream target; the no-default rule applies to whichever bundle resolves. | Global-only host (cannot route regional profiles; the EU example was dead config); independently-scoped host with global fallback (allows a profile with no host of its own — the "no exception" rule forbids it)                                   |
| 6   | Don't enforce https on the base URL; accept http too; normalize trailing slashes via the shared `envBaseUrl` helper | A self-hosted Langfuse instance may legitimately run on http inside a trusted network (e.g. behind a VPC), so enforcing https in code would wrongly reject a valid deployment. `LANGFUSE_*` are operator-set env vars on the trusted remote-cli service, so the scheme is the operator's call. Trailing-slash stripping stays in code because it is a correctness concern (avoids `${host}//api/public/mcp`) and matches the repo-wide `envBaseUrl` convention.                                                  | Throwing on a non-https/malformed host in code (breaks valid http self-hosted deployments); leaving the bespoke `trimTrailingSlashes` (duplicated the shared `envBaseUrl`); dropping trailing-slash handling entirely (produces a double-slash URL) |
| 4   | Insert `langfuse` alphabetically in `PROXY_NAMES`                                                                   | Stable, predictable ordering in listings/health; only the one order assertion in `proxies.test.ts` changes                                                                                                                                                                                                                                                                                                                                                                                                       | Append at end                                                                                                                                                                                                                                       |

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

- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` keep their names and global meaning; the host var
  is renamed `LANGFUSE_HOST` → `LANGFUSE_BASE_URL` (a deployment that set only `LANGFUSE_HOST`
  must rename it). All three form one profile bundle via `_<PROFILE>` suffixes — a profile sets
  all three or none.
- Existing prompts/skills that shelled out to `langfuse api ...` must switch to
  `mcp langfuse <tool>`; the standalone binary is removed.
