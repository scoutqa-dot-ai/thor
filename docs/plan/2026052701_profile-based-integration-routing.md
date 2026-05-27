# profile-based integration routing

Replace Thor's current split channel-policy model (Slack private-channel allowlist in `thor.json`, per-channel repo override files in memory, hard-coded single-credential MCP upstreams in `PROXY_REGISTRY`) with a profile-based routing model. Profiles group channel-specific overrides once, non-public channels are admitted only when explicitly listed in a profile, and integration credentials resolve by profile suffix first and unsuffixed global env vars second.

## Goal

Let Thor route integrations by Slack channel without duplicating full credential blocks in config. Operators should be able to say “these channels are in profile `qa`” or “these channels are in profile `labs`”, then let runtime env resolution decide whether Atlassian, PostHog, Grafana, Metabase, Langfuse, or future CLI-backed integrations are enabled for that profile. A public channel outside any profile still works against global credentials; a non-public channel outside every profile is rejected.

## Scope

**In scope**

- New `profiles` config in `/workspace/config/thor.json` as the single operator-maintained source for channel-specific overrides.
- Drop `slack.private_channel_allowlist` in favor of “non-public channels must appear in some profile”.
- Keep unsuffixed env vars as global credentials; add profile-suffixed variants such as `ATLASSIAN_AUTH_LABS` and `POSTHOG_API_KEY_LABS`.
- Start with MCP-backed integrations (`atlassian`, `grafana`, `posthog`) and design the config/runtime shape so other `remote-cli` surfaces can adopt it later.
- Update Slack gating, tool advertisement, MCP routing, approval resolution, docs, and tests to match the new model.

**Out of scope**

- Replacing repo routing in the same change. Repo routing can stay on `SLACK_DEFAULT_REPO` + memory override files for now unless implementation pressure makes consolidation clearly worthwhile.
- Per-profile tool allow/approve policy. Keep policy global per integration unless a real use case appears.
- A new admin UX beyond whatever the existing raw-config editor already supports.
- Non-Slack trigger routing policy beyond a safe fallback to unsuffixed global env vars.

## Proposed config shape

```json
{
  "profiles": {
    "qa": {
      "channels": ["C222"]
    },
    "labs": {
      "channels": ["C333", "D444"]
    }
  }
}
```

Interpretation:

- Channel in `profiles.<name>.channels[]` → active profile is `<name>`.
- Public non-shared channel not listed in any profile → admitted, use unsuffixed env vars only.
- Private channel / DM / MPIM / Slack Connect channel not listed in any profile → rejected.
- Profile lookup affects integration resolution only; it does not require every integration to define a profile-specific env var.

## Environment resolution contract

For a profile `labs`:

- Atlassian: `ATLASSIAN_AUTH_LABS` → fallback `ATLASSIAN_AUTH` → disabled if neither exists.
- PostHog: `POSTHOG_API_KEY_LABS` → fallback `POSTHOG_API_KEY` → disabled if neither exists.
- Grafana: resolve the full bundle by suffix first, then global fallback:
  - `GRAFANA_URL_LABS` + `GRAFANA_SERVICE_ACCOUNT_TOKEN_LABS` (+ optional `GRAFANA_ORG_ID_LABS`)
  - else `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` (+ optional `GRAFANA_ORG_ID`)
  - else disabled.

Rules:

1. Profile names are normalized to env-safe uppercase with non-alphanumerics converted to `_`.
2. Unsuffixed env vars are the global fallback, not a “default profile”.
3. Missing global env var disables the integration globally, but profile-specific vars can still enable it for listed profiles.
4. Multi-var integrations resolve as bundles — never mix profile-scoped and global credentials within the same bundle unless that bundle explicitly allows partial fallback.

## Current-state constraints to replace

- `packages/common/src/workspace-config.ts` currently supports `slack.private_channel_allowlist` but no profile model.
- `packages/gateway/src/slack-channel-gate.ts` and related gateway flow assume allowlist-based admission for non-public Slack surfaces.
- `packages/common/src/proxies.ts` hard-codes one `ProxyConfig` per MCP integration with one credential source each.
- `packages/runner/src/tool-instructions.ts` advertises MCP tools globally from `PROXY_REGISTRY`, without thread/profile awareness.
- `packages/remote-cli/src/mcp-handler.ts` resolves upstreams by integration name only, not by Slack thread/profile.
- Approval resolution must remain stable even if profile routing changes after an approval card is posted.

## Decision log

| #   | Decision                                                                                                | Rationale                                                                                                                                                          | Rejected                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1   | Use `profiles` as the config term                                                                       | Broad enough for environment splits (`qa`) and org/product splits (`labs`) without implying only team ownership or only deployment environment                     | `zones`, `areas`, `teams`, `environments`                                                |
| 2   | Profiles list channels only; integration enablement lives in env resolution                             | Keeps config small and future-proof for non-MCP integrations. Adding a new integration should not require a schema redesign.                                       | Provider-specific routing blocks in config; full credential/header blocks in `thor.json` |
| 3   | Unsuffixed env vars are the global fallback, not a special profile                                      | Matches the desired operator model: channels outside profiles use the global credential set.                                                                       | A literal `default` profile in config                                                    |
| 4   | Non-public channel admission comes from profile membership, replacing `slack.private_channel_allowlist` | One source of truth for both routing and gated-channel admission is easier to explain and audit.                                                                   | Keep a separate allowlist alongside profiles                                             |
| 5   | Start with MCP integrations but design the lookup helper as generic `remote-cli` profile resolution     | The request explicitly expects future expansion beyond MCP.                                                                                                        | MCP-only config naming such as `mcp.profiles`                                            |
| 6   | Keep per-integration tool allow/approve policy global for now                                           | Credential routing and policy routing are separate concerns; mixing them now adds complexity without a concrete requirement.                                       | Per-profile allow/approve lists                                                          |
| 7   | Approval actions snapshot the resolved integration target/profile at creation time                      | A later config/env change must not redirect an already-requested write to a different credential set.                                                              | Re-resolve profile/env at approval-click time                                            |
| 8   | Send Grafana profile credentials through `mcp-grafana`'s documented per-request headers                 | The Grafana MCP sidecar reads `X-Grafana-URL`, `X-Grafana-Service-Account-Token`, and `X-Grafana-Org-Id` from streamable HTTP requests for request-scoped routing. | Rely on `Authorization: Bearer ...` from `remote-cli`                                    |

## Phases

### Phase 1 — Workspace config schema and profile lookup

- Add `profiles` to `WorkspaceConfigSchema`, likely as `Record<string, { channels: string[] }>` with duplicate-channel validation across profiles.
- Add helpers that resolve `channel -> profile?` and answer whether a gated Slack channel is explicitly configured.
- Remove `slack.private_channel_allowlist` from schema, examples, and docs in the same change.

**Exit criteria:** config validation rejects duplicate channel membership; helper tests cover public/unlisted, private/listed, and private/unlisted cases.

### Phase 2 — Slack gating and routing semantics

- Update Slack gate logic so public non-shared channels still admit without profile membership, but private / DM / MPIM / shared channels require membership in some profile.
- Preserve the current fail-closed behavior on Slack channel classification lookup errors.
- Update operator docs to explain that profiles now serve as the allowlist for non-public surfaces.

**Exit criteria:** gateway tests cover listed and unlisted cases for public, private, DM, MPIM, and shared channels.

### Phase 3 — Generic profile-scoped env resolution in `remote-cli`

- Add a shared helper that resolves profile-scoped env vars and integration bundles.
- For Slack-triggered sessions, derive profile from the Slack correlation key's channel.
- For non-Slack triggers, use unsuffixed env vars only unless/until another trigger source gains explicit profile mapping.

**Exit criteria:** unit tests cover suffix normalization, profile-first fallback, global fallback, and disabled-on-missing behavior.

### Phase 4 — MCP routing on top of profile resolution

- Replace single-instance `PROXY_REGISTRY` credential assumptions with profile-aware runtime resolution while preserving global tool policy.
- Key live upstream connections by integration + resolved credential target so multiple profile variants can coexist.
- Update MCP listing and execution so unavailable integrations do not appear for the current thread/profile.
- Snapshot the resolved integration target on approval-required actions.

**Exit criteria:** MCP tests prove `atlassian`/`posthog`/`grafana` can resolve differently per profile and that approvals execute against the originally resolved target.

### Phase 5 — Prompt/docs alignment and future-surface hooks

- Update `packages/runner/src/tool-instructions.ts` to advertise only integrations available for the current thread/profile.
- Update `README.md`, `docs/slack.md`, `docs/examples/thor.json`, and any integration docs that currently imply one global credential set only.
- Document how future `remote-cli` surfaces (for example Metabase or Langfuse) can opt into the same profile-scoped env resolver without changing the `profiles` config shape.

**Exit criteria:** documentation, prompt surface, and runtime behavior describe the same model; example config is minimal and valid.

## Open questions

- Should repo routing eventually move into the same `profiles` block, or stay separate because repo selection is agent-steerable while integration routing is operator policy?
- For bundle-based integrations, do we allow partial fallback (for example profile-specific token with global URL), or require the whole profile bundle to exist before using it?
- When a public channel belongs to a profile, should that profile also be able to override repo routing later, or should repo routing remain an independent mechanism?

## Test plan

- `pnpm --filter @thor/common test`
- `pnpm --filter @thor/gateway test`
- `pnpm --filter @thor/remote-cli test`
- Targeted e2e or integration checks for:
  - public channel outside profiles → admitted, unsuffixed env resolution
  - private/DM/shared channel outside profiles → dropped
  - profile-scoped channel with suffixed env vars → profile credentials used
  - profile-scoped channel without suffixed env vars but with global env vars → global fallback used
  - approval created under one profile, config later changed, approval still resolves against original target

## Migration notes

- Existing `slack.private_channel_allowlist` entries migrate into one or more named profiles.
- Existing channel→repo memory overrides remain untouched in Phase 1.
- Existing unsuffixed env vars keep current behavior for all channels not explicitly assigned to a profile.
- Operators can adopt profile-specific env vars incrementally; no flag day is required as long as global vars remain present.
