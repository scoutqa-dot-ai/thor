# profile-based integration routing

Replace Thor's current split channel-policy model (Slack private-channel allowlist in `thor.json`, per-channel repo override files in memory, hard-coded single-credential MCP upstreams in `PROXY_REGISTRY`) with a profile-based routing model. Profiles group channel-specific overrides once, non-public channels are admitted only when explicitly listed in a profile, and integration credentials resolve by profile suffix first and unsuffixed global env vars second.

## Goal

Let Thor route integrations by Slack channel without duplicating full credential blocks in config. Operators should be able to say “these channels are in profile `qa`” or “these channels are in profile `labs`”, then let runtime env resolution decide whether Atlassian, PostHog, Grafana, Metabase, Langfuse, or future CLI-backed integrations are enabled for that profile. A public channel outside any profile still works against global credentials; a non-public channel outside every profile is rejected.

## Scope

**In scope**

- New `profiles` config in `/workspace/config/thor.json` as the single operator-maintained source for channel-specific overrides.
- Drop `slack.private_channel_allowlist` in favor of “non-public channels must appear in some profile”.
- Keep unsuffixed env vars as global credentials; add profile-suffixed variants such as `POSTHOG_API_KEY_LABS`.
- Start with MCP-backed integrations (`atlassian`, `grafana`, `posthog`) and design the config/runtime shape so other `remote-cli` surfaces can adopt it later.
- Update Slack gating, tool advertisement, MCP routing, approval resolution, docs, and tests to match the new model.

**Out of scope**

- Replacing repo routing in the same change. Repo routing can stay on `SLACK_DEFAULT_REPO` + memory override files for now unless implementation pressure makes consolidation clearly worthwhile.
- Per-profile tool allow/approve policy. Keep policy global per integration unless a real use case appears.
- A new admin UX beyond whatever the existing raw-config editor already supports.
- Standalone non-Slack trigger profile selection beyond the safe fallback to unsuffixed global env vars. Phase 6 still lets an existing Slack-bound anchor carry its resolved profile across later non-Slack triggers.

## Proposed config shape

```json
{
  "profiles": {
    "QA": {
      "channels": ["C222"]
    },
    "LABS": {
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

For a profile `LABS`:

- PostHog: `POSTHOG_API_KEY_LABS` → fallback `POSTHOG_API_KEY` → disabled if neither exists.
- Grafana: resolve the full bundle by suffix first, then global fallback:
  - `GRAFANA_URL_LABS` + `GRAFANA_SERVICE_ACCOUNT_TOKEN_LABS` (+ optional `GRAFANA_ORG_ID_LABS`)
  - else `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` (+ optional `GRAFANA_ORG_ID`)
  - else disabled.

Rules:

1. Profile names are constrained at schema validation to match `/^[A-Z_]+$/`, so the name itself is the env-suffix — no normalization step at lookup time.
2. Unsuffixed env vars are the global fallback, not a “default profile”.
3. Missing global env var disables the integration globally, but profile-specific vars can still enable it for listed profiles.
4. Multi-var integrations resolve as bundles — never mix profile-scoped and global credentials within the same bundle. If a profile-scoped bundle is partially configured, fail hard instead of falling back to globals.

## Current-state constraints to replace

- `packages/common/src/workspace-config.ts` currently supports `slack.private_channel_allowlist` but no profile model.
- `packages/gateway/src/slack-channel-gate.ts` and related gateway flow assume allowlist-based admission for non-public Slack surfaces.
- `packages/common/src/proxies.ts` hard-codes one `ProxyConfig` per MCP integration with one credential source each.
- `packages/runner/src/tool-instructions.ts` advertises MCP tools globally from `PROXY_REGISTRY`, without thread/profile awareness.
- `packages/remote-cli/src/mcp-handler.ts` resolves upstreams by integration name only, not by Slack thread/profile.
- The earlier approval-routing design assumed creation-time stability after a card is posted; Phase 6 replaces this with click-time re-resolution and rejection on ambiguity or unavailable credentials.

## Decision log

| #   | Decision                                                                                                                 | Rationale                                                                                                                                                                                                                                                                              | Rejected                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Use `profiles` as the config term                                                                                        | Broad enough for environment splits (`qa`) and org/product splits (`labs`) without implying only team ownership or only deployment environment                                                                                                                                         | `zones`, `areas`, `teams`, `environments`                                                |
| 2   | Profiles list channels only; integration enablement lives in env resolution                                              | Keeps config small and future-proof for non-MCP integrations. Adding a new integration should not require a schema redesign.                                                                                                                                                           | Provider-specific routing blocks in config; full credential/header blocks in `thor.json` |
| 3   | Unsuffixed env vars are the global fallback, not a special profile                                                       | Matches the desired operator model: channels outside profiles use the global credential set.                                                                                                                                                                                           | A literal `default` profile in config                                                    |
| 4   | Non-public channel admission comes from profile membership, replacing `slack.private_channel_allowlist`                  | One source of truth for both routing and gated-channel admission is easier to explain and audit.                                                                                                                                                                                       | Keep a separate allowlist alongside profiles                                             |
| 5   | Start with MCP integrations but design the lookup helper as generic `remote-cli` profile resolution                      | The request explicitly expects future expansion beyond MCP.                                                                                                                                                                                                                            | MCP-only config naming such as `mcp.profiles`                                            |
| 6   | Keep per-integration tool allow/approve policy global for now                                                            | Credential routing and policy routing are separate concerns; mixing them now adds complexity without a concrete requirement.                                                                                                                                                           | Per-profile allow/approve lists                                                          |
| 7   | Approval actions snapshot the resolved integration target/profile at creation time                                       | A later config/env change must not redirect an already-requested write to a different credential set.                                                                                                                                                                                  | Re-resolve profile/env at approval-click time                                            |
| 8   | Send Grafana profile credentials through `mcp-grafana`'s documented per-request headers                                  | The Grafana MCP sidecar reads `X-Grafana-URL`, `X-Grafana-Service-Account-Token`, and `X-Grafana-Org-Id` from streamable HTTP requests for request-scoped routing.                                                                                                                     | Rely on `Authorization: Bearer ...` from `remote-cli`                                    |
| 9   | Profile resolution enumerates every `slack.thread` alias on the anchor and fails fast on ambiguity                       | "Best trigger wins" can silently flip credentials mid-session when an anchor accumulates triggers from multiple channels. Enumerating all bindings makes a mismatch loud instead of silent.                                                                                            | Pick the newest open Slack trigger; pick the trigger that opened the session             |
| 10  | Drop the legacy `slack.thread_id` alias type entirely                                                                    | Greenfield; the channel-qualified `slack.thread` form supersedes it. Keeping the legacy type allows a no-channel correlation key to bind anchors, which is incompatible with channel→profile resolution.                                                                               | Tolerate legacy reads for back-compat                                                    |
| 11  | Re-resolve approval routing at click time and reject if ambiguous, instead of snapshotting at creation                   | Decision 7's snapshot defends against config drift mid-flight, but it also lets an operator approve under a different credential than the one their channel maps to today. Re-resolving + failing on ambiguity is safer than either snapshot or silent re-route. Overrides Decision 7. | Snapshot routing at creation time                                                        |
| 12  | Single-var integrations keep "profile suffix → global fallback"; multi-var bundles fail hard on a partial profile suffix | A missing optional credential should be a soft-disable, not an error. But a bundle with one half profile-scoped and the other half global is almost certainly an operator typo — failing loud beats silently mixing credential scopes within one connection.                           | Single global fallback rule for all integrations; partial bundle = use whatever resolves |
| 13  | Temporarily whitelist known profile-routing approval failures in the gateway stderr sanitizer                            | The gateway currently gates nonzero approval results through a narrow safe-summary regex before re-entering the runner. Until approval resolution returns structured safe error codes, whitelist only the new system-authored profile ambiguity / unavailable-profile cases.           | Surface arbitrary resolver stderr; block system profile rejections from Slack/runner     |

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
- Originally planned to snapshot the resolved integration target on approval-required actions; Phase 6 supersedes this with click-time re-resolution.

**Exit criteria:** MCP tests prove `posthog`/`grafana` can resolve differently per profile. The original approval snapshot criterion is superseded by Phase 6's click-time re-resolution criteria.

### Phase 5 — Prompt/docs alignment and future-surface hooks

- Update `packages/runner/src/tool-instructions.ts` to advertise only integrations available for the current thread/profile.
- Update `README.md`, `docs/slack.md`, `docs/examples/thor.json`, and any integration docs that currently imply one global credential set only.
- Document how future `remote-cli` surfaces (for example Metabase or Langfuse) can opt into the same profile-scoped env resolver without changing the `profiles` config shape.

**Exit criteria:** documentation, prompt surface, and runtime behavior describe the same model; example config is minimal and valid.

### Phase 6 — Strict profile resolution and approval re-resolve

Hardens the model against silent profile flips by enumerating every Slack alias on the anchor instead of picking a single "best" trigger, drops the legacy `slack.thread_id` alias type, and moves approval routing from creation-time snapshot to click-time re-resolve.

- **Strict profile resolver.** Replace `findTriggerCorrelationKey` + `getProfileForSlackCorrelationKey` in the MCP path with a resolver that:
  1. Resolves `sessionId` → `anchorId` via `opencode.session` / `opencode.subsession`.
  2. Calls `reverseLookupAnchor(anchorId)` and keeps only `slack.thread` external keys (channel/ts shape).
  3. Maps each channel to a profile (`getProfileForSlackChannel`) and dedupes.
  4. Returns `{ profile: undefined }` if there are no Slack bindings; `{ profile: name }` if exactly one distinct profile is detected; `AmbiguousProfileError` if the set contains more than one distinct value (including any mix of "in profile" + "not in any profile" channels).
- **Drop `slack.thread_id` entirely.** Remove from `ALIAS_TYPES`, stop emitting it in `aliasForCorrelationKey`, simplify `buildSlackCorrelationKeys` to a single channel-qualified key, drop the admin views legacy chip, and migrate tests to the channel-qualified form. Old session-log lines with `aliasType: "slack.thread_id"` are tolerated implicitly because both readers use `safeParse` and skip unknown types — they just stop binding anchors.
- **Single-var env resolution stays soft.** `ATLASSIAN_AUTH_<PROFILE>` missing while `ATLASSIAN_AUTH` is set still falls back to global. Same for `POSTHOG_API_KEY`.
- **Multi-var bundles fail on partial profile coverage.** In `resolveProxyConfig` for Grafana, if any of `GRAFANA_URL_<PROFILE>` / `GRAFANA_SERVICE_ACCOUNT_TOKEN_<PROFILE>` / `GRAFANA_ORG_ID_<PROFILE>` is set but the URL+token pair is incomplete, throw — do not silently use the unsuffixed bundle. All-three-unset still falls back cleanly.
- **Drop the approval `routing` snapshot.** Remove the `routing` field from the approval schema (greenfield — ignore any stored data with that field). At approval-click time, re-resolve profile via the strict resolver using `action.origin.sessionId`. If the resolver returns ambiguous or the integration's env bundle won't load for the resolved profile, mark the action `rejected` with a system reason and surface it via the existing Slack rejection path. Otherwise execute against the freshly resolved target.
- **Surface ambiguity loudly in MCP listing and call paths.** `resolveProfileForContext` must return a result type the caller can fail on, not silently fall back to globals. Existing fallback-on-error behavior is preserved only for transient errors (config load failure), not for `AmbiguousProfileError`.

**Exit criteria:**

- Removing `slack.thread_id` from `ALIAS_TYPES` does not break any reader; existing unit tests pass after migration to `slack.thread`.
- A session anchor bound to two channels in different profiles fails the next `/exec/mcp` call with a clear ambiguity error; same anchor bound to one channel in a profile + one outside any profile fails identically.
- A partial Grafana profile bundle (e.g. only `GRAFANA_URL_QA` set) fails the MCP call instead of silently using globals.
- An approval action created with no `routing` field re-resolves cleanly when the resolver returns one profile, executes under the freshly resolved target, and is rejected with a system reason when the resolver returns ambiguous.
- Single-var integrations (Atlassian, PostHog) still fall back to globals when their `_<PROFILE>` suffix is unset.

## Open questions

- Should repo routing eventually move into the same `profiles` block, or stay separate because repo selection is agent-steerable while integration routing is operator policy?
- When a public channel belongs to a profile, should that profile also be able to override repo routing later, or should repo routing remain an independent mechanism?
- **Cron-triggered `hey-thor` sessions have no profile.** MCP profile resolution reads Slack thread aliases on the anchor via the strict resolver. Cron triggers do not carry a Slack thread alias, so they fall through to unsuffixed globals — consistent with the "standalone non-Slack triggers use unsuffixed globals only" rule, but it means there is no way today for a scheduled prompt to opt into a profile's credentials. Options to revisit: declare a profile per cron job in `thor.json`, attach a synthetic correlation key whose channel maps to a profile, or let the cron payload carry an explicit profile name. Pick one before adding cron jobs that need profile-scoped writes.
- **Atlassian (and any other integration reachable via direct HTTP) bypasses profile routing through mitmproxy.** Mitmproxy's `${ATLASSIAN_AUTH}` interpolation in `docker/mitmproxy/rules.py` is global and has no notion of session/profile, so an agent that shells out to `curl` or uses node `fetch` against `*.atlassian.net` will get the unsuffixed global credential even when the originating Slack channel belongs to a profile with `ATLASSIAN_AUTH_<PROFILE>` set. The MCP path respects the profile; the egress path does not. Pure-MCP integrations (PostHog, Grafana) do not have this gap because they have no mitmproxy rule. Needs a follow-up — likely per-session tagging from runner → OpenCode env → mitmproxy addon, so the addon can look up the right `ATLASSIAN_AUTH_<PROFILE>` with the same fallback rules as `resolveProxyConfig`. Until that lands, treat Atlassian profile suffixes as best-effort (correct for MCP, leaky for direct egress) and prefer PostHog as the canonical profile example in docs.

## Test plan

- `pnpm --filter @thor/common test`
- `pnpm --filter @thor/gateway test`
- `pnpm --filter @thor/remote-cli test`
- Targeted e2e or integration checks for:
  - public channel outside profiles → admitted, unsuffixed env resolution
  - private/DM/shared channel outside profiles → dropped
  - profile-scoped channel with suffixed env vars → profile credentials used
  - profile-scoped channel without suffixed env vars but with global env vars → global fallback used
  - approval created under one profile re-resolves at approval-click time; fresh profile credentials are used when available, and ambiguous or unavailable resolved profiles reject with a system reason

## Migration notes

- Existing `slack.private_channel_allowlist` entries migrate into one or more named profiles.
- Existing channel→repo memory overrides remain untouched in Phase 1.
- Existing unsuffixed env vars keep current behavior for all channels not explicitly assigned to a profile.
- Operators can adopt profile-specific env vars incrementally; no flag day is required as long as global vars remain present.
