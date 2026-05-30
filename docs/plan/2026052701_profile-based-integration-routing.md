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

| #   | Decision                                                                                                                                                                                                                                                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Rejected                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Use `profiles` as the config term                                                                                                                                                                                                                            | Broad enough for environment splits (`qa`) and org/product splits (`labs`) without implying only team ownership or only deployment environment                                                                                                                                                                                                                                                                                                                                                                | `zones`, `areas`, `teams`, `environments`                                                                                                                                                                     |
| 2   | Profiles list channels only; integration enablement lives in env resolution                                                                                                                                                                                  | Keeps config small and future-proof for non-MCP integrations. Adding a new integration should not require a schema redesign.                                                                                                                                                                                                                                                                                                                                                                                  | Provider-specific routing blocks in config; full credential/header blocks in `thor.json`                                                                                                                      |
| 3   | Unsuffixed env vars are the global fallback, not a special profile                                                                                                                                                                                           | Matches the desired operator model: channels outside profiles use the global credential set.                                                                                                                                                                                                                                                                                                                                                                                                                  | A literal `default` profile in config                                                                                                                                                                         |
| 4   | Non-public channel admission comes from profile membership, replacing `slack.private_channel_allowlist`                                                                                                                                                      | One source of truth for both routing and gated-channel admission is easier to explain and audit.                                                                                                                                                                                                                                                                                                                                                                                                              | Keep a separate allowlist alongside profiles                                                                                                                                                                  |
| 5   | Start with MCP integrations but design the lookup helper as generic `remote-cli` profile resolution                                                                                                                                                          | The request explicitly expects future expansion beyond MCP.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | MCP-only config naming such as `mcp.profiles`                                                                                                                                                                 |
| 6   | Keep per-integration tool allow/approve policy global for now                                                                                                                                                                                                | Credential routing and policy routing are separate concerns; mixing them now adds complexity without a concrete requirement.                                                                                                                                                                                                                                                                                                                                                                                  | Per-profile allow/approve lists                                                                                                                                                                               |
| 7   | Approval actions snapshot the resolved integration target/profile at creation time                                                                                                                                                                           | A later config/env change must not redirect an already-requested write to a different credential set.                                                                                                                                                                                                                                                                                                                                                                                                         | Re-resolve profile/env at approval-click time                                                                                                                                                                 |
| 8   | Send Grafana profile credentials through `mcp-grafana`'s documented per-request headers                                                                                                                                                                      | The Grafana MCP sidecar reads `X-Grafana-URL`, `X-Grafana-Service-Account-Token`, and `X-Grafana-Org-Id` from streamable HTTP requests for request-scoped routing.                                                                                                                                                                                                                                                                                                                                            | Rely on `Authorization: Bearer ...` from `remote-cli`                                                                                                                                                         |
| 9   | Profile resolution enumerates every `slack.thread` alias on the anchor and fails fast on ambiguity                                                                                                                                                           | "Best trigger wins" can silently flip credentials mid-session when an anchor accumulates triggers from multiple channels. Enumerating all bindings makes a mismatch loud instead of silent.                                                                                                                                                                                                                                                                                                                   | Pick the newest open Slack trigger; pick the trigger that opened the session                                                                                                                                  |
| 10  | Drop the legacy `slack.thread_id` alias type entirely                                                                                                                                                                                                        | Greenfield; the channel-qualified `slack.thread` form supersedes it. Keeping the legacy type allows a no-channel correlation key to bind anchors, which is incompatible with channel→profile resolution.                                                                                                                                                                                                                                                                                                      | Tolerate legacy reads for back-compat                                                                                                                                                                         |
| 11  | Re-resolve approval routing at click time and reject if ambiguous, instead of snapshotting at creation                                                                                                                                                       | Decision 7's snapshot defends against config drift mid-flight, but it also lets an operator approve under a different credential than the one their channel maps to today. Re-resolving + failing on ambiguity is safer than either snapshot or silent re-route. Overrides Decision 7.                                                                                                                                                                                                                        | Snapshot routing at creation time                                                                                                                                                                             |
| 12  | Single-var integrations keep "profile suffix → global fallback"; multi-var bundles fail hard on a partial profile suffix                                                                                                                                     | A missing optional credential should be a soft-disable, not an error. But a bundle with one half profile-scoped and the other half global is almost certainly an operator typo — failing loud beats silently mixing credential scopes within one connection.                                                                                                                                                                                                                                                  | Single global fallback rule for all integrations; partial bundle = use whatever resolves                                                                                                                      |
| 13  | Superseded by Decision 19: temporarily whitelist known profile-routing approval failures before raw stderr surfacing was accepted                                                                                                                            | This was an interim bridge while the gateway still treated arbitrary nonzero resolver results as unsafe. Decision 19 removes the whitelist and surfaces raw stderr from valid `ExecResult` responses.                                                                                                                                                                                                                                                                                                         | Directly surface arbitrary resolver stderr; block system profile rejections from Slack/runner                                                                                                                 |
| 14  | MCP profile routing requires a bound Thor session header before listing or calling tools                                                                                                                                                                     | OpenCode-side wrappers are convenience, not enforcement. Missing or unbound `x-thor-session-id` values fail closed so direct `/exec/mcp` calls cannot silently receive unsuffixed global credentials; runner-bound non-Slack sessions still use the global fallback.                                                                                                                                                                                                                                          | Treat missing or fake session context as "no profile" and use global credentials                                                                                                                              |
| 15  | Drop the runtime tool-instructions injection; document MCP via static `build.md` and live `mcp` CLI discovery                                                                                                                                                | The injected prompt mostly duplicated `build.md`, and its only unique value — per-profile filtering — is delivered more accurately by `mcp` discovery, which hits the live profile resolver instead of a session-start snapshot. The proxy already fails closed server-side, so the prompt-side suppression was belt-and-suspenders. Removes `tool-instructions.ts` + its test + the runner injection path.                                                                                                   | Keep generating per-profile tool instructions; statically enumerate allow/approve names in `build.md` (drift + violates AGENTS.md rule 10)                                                                    |
| 16  | Repos are a co-equal profile selector, resolved by a precedence chain (channel wins; repo fills in when the channel is silent; a channel/repo profile conflict fails fast)                                                                                   | Lets non-Slack/cron sessions and unlisted-channel sessions opt into a profile via the repo they operate on, while keeping the existing multi-channel ambiguity rule intact (the `undefined` "upgrade" only crosses the channel→repo boundary, never within the channel dimension). Satisfies the cron gap and the "a channel that configures a repo can switch profile" case without a flat set-union that would weaken Phase 6's anti-flip property.                                                         | Repos as a pure cross-check overlay (channels authoritative, repo only asserts); flat set-union of all channel+repo signals (silently resolves a multi-channel `{in,out}` mix that Phase 6 fails on)          |
| 17  | The repo profile signal is the trusted OpenCode session directory on the live MCP path, plus an immutable `repo` anchor alias stamped at trigger time for the approval-click path — never the agent-writable channel→repo override and never `process.cwd()` | If repo→profile resolved through an agent-reachable signal, an agent in a global channel could rewrite its repo binding (or `cd`) to self-escalate into another profile's credentials. `THOR_OPENCODE_DIRECTORY` already comes from OpenCode's session context (not `process.cwd()`) and is validated to `/workspace/repos/<repo>`. The anchor alias keeps Phase 6's click-time re-resolve stable (the Slack-button path has no live directory) and feeds a future admin report with session repo provenance. | Resolve via the `repo-by-slack-channel` memory file (agent-writable → self-escalation); snapshot the resolved profile onto the approval action (reintroduces the creation-time snapshot Decision 11 replaced) |
| 18  | Repos never grant Slack admission; admission stays channel-only                                                                                                                                                                                              | Admission is the trust boundary and is evaluated in the gateway at trigger time, before any repo context exists. Repo is a working-context signal; letting it admit a non-public channel would gate the trust boundary on something the agent influences. Repos affect credential resolution only.                                                                                                                                                                                                            | Let a repo's profile membership admit an otherwise-unlisted private/DM/shared channel                                                                                                                         |
| 19  | Surface raw `remote-cli` approval-resolve stderr instead of regex-whitelisting safe failure categories                                                                                                                                                       | Approval clicks call the internal `remote-cli` control-plane endpoint. When that endpoint returns a valid `ExecResult`, the gateway should re-enter the runner with the actual resolver/tool failure text so the agent and operator can see why the approved or rejected action failed. This supersedes Decision 13's temporary sanitizer.                                                                                                                                                                    | Treat unknown nonzero resolver results as transport failures; keep expanding stderr regexes until structured safe codes exist                                                                                 |

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

- Advertise MCP capabilities through static `build.md` + live `mcp` CLI discovery rather than a runtime-injected, profile-filtered prompt block (see Decision 15). `mcp` (no args) lists upstreams available to the session via the live profile resolver; `--help` surfaces each tool's `classification`. The `tool-instructions.ts` injection path is removed.
- Update `README.md`, `docs/slack.md`, `docs/examples/thor.json`, and any integration docs that currently imply one global credential set only.
- Document how future `remote-cli` surfaces (for example Metabase or Langfuse) can opt into the same profile-scoped env resolver without changing the `profiles` config shape.

**Exit criteria:** documentation, prompt surface, and runtime behavior describe the same model; example config is minimal and valid; MCP affordances live in `build.md` with no runtime injection.

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

### Phase 7 — Repo-based profile selection

Adds repos as a second profile selector alongside channels, so non-Slack/cron sessions and unlisted-channel sessions can opt into a profile via the repo they operate on. Channels stay authoritative; repos fill in when the channel is silent; a channel/repo conflict fails fast. Repos never affect Slack admission.

- **Schema.** Add `repos?: string[]` to `ProfileConfigSchema`; require at least one of `channels` / `repos` per profile. In the `superRefine`, reject duplicate repo membership across profiles (mirror the existing duplicate-channel check) and dedupe within a profile.
- **Repo→profile helper.** Add `getProfileForRepo(config, repoName)` symmetric to `getProfileForSlackChannel`.
- **Precedence resolver.** Generalize the strict resolver so resolution returns `cp ?? rp` where `cp` = strict channel→profile (unchanged, including the multi-channel `{in,out}` = ambiguous rule) and `rp` = strict repo→profile. Fail if either dimension is itself ambiguous, or if `cp` and `rp` are both defined and differ. The `undefined` "upgrade" only crosses the channel→repo boundary — it never relaxes the within-channel ambiguity rule.
- **Live MCP path uses the trusted directory.** In `resolveProfileForContext`, derive the repo from `extractRepoFromCwd(context.directory)` (already populated from `THOR_OPENCODE_DIRECTORY` and validated to `/workspace/repos/<repo>`) and feed it to the precedence resolver. No new wiring needed for list/call.
- **New `repo` alias for the approval-click path.** The Slack-button approval path re-resolves from `action.origin.sessionId` only and has no live directory. Add `"repo"` to `ALIAS_TYPES` and stamp it on the anchor at trigger time, then have the strict resolver enumerate `repo` keys alongside `slack.thread`. Cron triggers stamp their target repo and resolve a profile with no Slack binding at all.
  - **Landing point (traced):** stamp inside `resolveSession` in `packages/runner/src/index.ts` (~`:778-832`), after `anchorId` is determined. The validated `sessionDirectory` (required `TriggerRequestSchema.directory`, checked by `isAllowedDirectory` at `:748`, same value passed to OpenCode at `:764`) is in scope for **all** trigger types — Slack, cron, GitHub — so no gateway change is needed; the gateway already resolves the directory before the runner sees it. Use `extractRepoFromCwd(sessionDirectory)` for the alias value via the existing `appendAlias` primitive.
  - **Stamp once, idempotently.** The alias represents the anchor's repo, so write it only when the anchor has none yet (guard via `reverseLookupAnchor`). Cover both mint paths (`:790-791` correlation-key mint, `:794` fresh mint); leave the `requestedSessionId` resume path (`:779-784`) untouched so a resumed session keeps its original repo even if a later trigger's directory differs.
- **Admission unchanged.** The gateway Slack gate keeps using channel membership only; repos play no part in admitting non-public channels.

**Exit criteria:**

- A cron/non-Slack session whose anchor carries only a `repo` alias in a profile resolves to that profile; same session in an unprofiled repo resolves to globals.
- A public/unlisted channel whose session repo maps to a profile resolves to that profile (repo upgrade); the same channel listed in a different profile fails fast (channel/repo conflict).
- A private channel whose repo maps to a profile is still rejected at admission if the channel is not in any profile's `channels` (admission stays channel-only).
- Config validation rejects a repo assigned to two profiles, and a profile with neither `channels` nor `repos`.
- An approval action re-resolves the same profile at click time via the persisted `repo` alias when the session had no Slack binding.

## Open questions

- ~~Should repo routing eventually move into the same `profiles` block, or stay separate?~~ Resolved by Phase 7 (Decisions 16–17): repos enter the `profiles` block only as a **credential-routing selector** (`repos[]` → profile). Repo _work-routing_ (where the agent operates — `SLACK_DEFAULT_REPO` + the channel→repo memory override) stays a separate, agent-steerable mechanism and is deliberately **not** the profile signal; the profile signal is the operator/trigger-time repo stamped as the `repo` anchor alias.
- When a public channel belongs to a profile, should that profile also be able to override repo routing later, or should repo routing remain an independent mechanism?
- ~~**Cron-triggered `hey-thor` sessions have no profile.**~~ Resolved by Phase 7: the harness stamps a `repo` alias on the anchor from the cron job's target repo, and repo-based profile selection routes credentials from there. There is deliberately no direct profile selector — profile is a harness-side credential-routing concern, never an agent-facing arg or OpenCode/LLM-visible value (`hey-thor` has no `--profile`, by design; see Decision 17 and AGENTS.md rule 10). A cron job that needs a profile's credentials must point at a repo in that profile.
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
