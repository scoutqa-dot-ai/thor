# Private Slack Channel Allowlist

## Goal

Stop Thor from reacting to or queuing work for Slack events in private channels unless the channel id is explicitly allowlisted in workspace config. Public channels, DMs (`im`), and group DMs (`mpim`) are unaffected — the gate is scoped narrowly to private channels (`group` in Slack RTM nomenclature).

The allowlist is operator-maintained config, not an env var, and is read on every event so changes take effect without restart.

## Architecture context

- Gateway is the only inbound surface for Slack webhooks (`packages/gateway/src/app.ts`). Reactions, message ingestion, and runner dispatch all flow through one handler that already enforces per-event filters before forwarding to the runner.
- Channel classification is split: most Slack event payloads include `channel_type` (`channel` | `im` | `group` | `mpim`), but a few (edited messages, some reaction events) omit it. When missing, we have to call `conversations.info` to read `is_private` / `is_im` / `is_mpim`.
- Workspace config is loaded through `createConfigLoader` (`packages/common/src/workspace-config.ts`), which re-reads `/workspace/config/thor.json` on every call. The gateway already consumes this loader for other config-driven behavior.

## Scope

- New optional `slack.private_channel_allowlist: string[]` key in `WorkspaceConfigSchema`.
- New `isSlackEventInPrivateChannelScope` and `isSlackPrivateChannelAllowed` helpers in `packages/gateway/src/slack-api.ts`.
- Webhook-path gate (`shouldIgnoreForPrivateChannel`) in `packages/gateway/src/app.ts` that runs before reactions or runner dispatch.
- Gateway picks up `CONFIG_PATH` (already used by `admin` and `runner`) so test setups can point at a throwaway config.

Out of scope:

- Per-user allowlists or role-based gating.
- Allowlisting by channel name (Slack rename is silent — id is the stable handle).
- DM / group-DM gating. If we want to gate those later, it's a separate decision.
- Audit logging of dropped events beyond the existing `private_channel_not_allowlisted` reason on the webhook history record.

## Decision log

| #   | Decision                                                                              | Why                                                                                                                                                          | Alternatives considered                                                       |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 1   | Allowlist lives in `thor.json`, not an env var                                        | The rest of channel-aware config (`SLACK_DEFAULT_REPO` overrides, user directory) is already file-based and hot-reloads. Env var would require a restart.   | New `SLACK_PRIVATE_CHANNEL_ALLOWLIST` env var.                                |
| 2   | Gate `group` only; leave `im` / `mpim` ungated                                        | DMs to the bot are explicit user intent and already require a Slack install + invite. MPIM is a small private conversation, same reasoning.                  | Gate all non-public surfaces. Rejected as too aggressive.                     |
| 3   | Fail closed on config load failure                                                    | If we cannot read the allowlist, we cannot prove the channel is permitted. Treat it the same as "not on the list" rather than crashing or returning 5xx.    | Fail open / crash gateway. Both worse.                                        |
| 4   | Fail closed on `conversations.info` timeout or error                                  | A slow Slack API must not leak unallowlisted private channels through. Slack will retry the webhook, and the operator can debug from `private_channel_not_allowlisted` history reasons. | Fail open after timeout.                                                      |
| 5   | 1.5s timeout on `conversations.info`                                                  | Slack requires us to ack webhooks in ~3s. The privacy lookup must comfortably fit inside that budget alongside downstream work.                              | Reuse the 10s default Slack Web API timeout. Too long for the ack window.     |
| 6   | Colocate the privacy lookup in `slack-api.ts` rather than a new module                | One-function helper. A new module would be premature abstraction for a single call site.                                                                     | Separate `slack-channel-privacy.ts`.                                          |
| 7   | Look up only when `channel_type` is missing or unknown                                | When the event already tells us the type, we trust it. Saves a Slack API call on the common path.                                                            | Always call `conversations.info`. Adds latency and Slack rate-limit pressure. |
| 8   | Trust `channel_type === "channel"` as definitively public (no lookup)                 | Slack routes `message.channels` with `channel_type: "channel"` and `message.groups` with `channel_type: "group"`. A real private-channel capture (`C0AK4C2SZAT`, see Verification) confirms `message*` events arrive as `group`, never `channel`. Known soft spot: Slack Connect / shared-channel envelopes are not exercised in this sample — revisit if Connect comes into scope. | Force a `conversations.info` lookup on `channel_type: "channel"` too. Rejected: doubles Slack API traffic on the hot public-channel path for a hypothetical leak. |
| 9   | Accept the lookup fan-out for events that omit `channel_type`                          | Empirically (12-event private-channel sample), `app_mention` and `reaction_added` lack `channel_type` and force a lookup; `message` / `message_changed` keep the fast path. A typical "mention + emoji" interaction is ~3 lookups. `conversations.info` is tier-3 (50/min) — comfortably above expected per-workspace traffic, and the 1.5s timeout caps worst case. | Cache privacy decisions per channel in memory. Rejected for now: extra state, invalidation question on public↔private conversion, and current traffic doesn't justify it. Revisit if rate-limit headroom shrinks. |
| 10  | Resolve missing-`channel_type` privacy asynchronously, after Slack ack — mirroring GitHub's `pending:branch-resolve:` pattern | The webhook handler currently runs `conversations.info` inline, inside Slack's 3s ack budget. GitHub handles the same shape (lookup needed before dispatch decision) by enqueueing with a `pending:branch-resolve:` correlation key, acking 200 immediately, and resolving in `planBatchDispatch` (`packages/gateway/src/github.ts:291-299`, `packages/gateway/src/app.ts:1812,1847`, `packages/gateway/src/service.ts:650-691`). Reusing the established pattern eliminates ack-budget pressure, removes the class of bug where a slow Slack API blows past the 3s window, and lets the privacy timeout grow toward the GitHub side's 5s `INTERNAL_EXEC_TIMEOUT_MS` (`service.ts:32`) without consequence. Conclusive `channel_type` values still take the synchronous fast path so cheap drops stay cheap and don't accrete onto the queue. | Add a per-channel privacy cache (#9). Still useful eventually, but doesn't address the ack-budget concern. Keep the inline lookup. Rejected: leaks Slack-API health into Slack-ack reliability. |

## Phases

### Phase 1 — Schema + helpers

- Add `SlackConfigSchema` with optional `private_channel_allowlist: string[]` (no duplicates, no empty strings) to `WorkspaceConfigSchema`.
- Export `getSlackPrivateChannelAllowlist(config)` from `packages/common/src/index.ts`.
- Add `isSlackEventInPrivateChannelScope(event, deps)` and `isSlackPrivateChannelAllowed(channel, allowlist)` to `packages/gateway/src/slack-api.ts`. The first short-circuits on known `channel_type`, falls back to `conversations.info` with a 1.5s timeout, and fails closed on error.
- Unit tests: schema accepts/rejects duplicates and empty entries; helper returns true/false/closed correctly on each `channel_type` branch and on the fallback lookup path.

Exit: `pnpm -r test` green.

### Phase 2 — Webhook gate

- Add `shouldIgnoreForPrivateChannel(event, eventId, history)` in `packages/gateway/src/app.ts`, called before reactions and runner dispatch.
- On rejection: write `history.reason = "private_channel_not_allowlisted"` plus channel metadata, return 200 to Slack, do not call the runner.
- Wire `configPath` through `loadGatewayEnv` so a `CONFIG_PATH` override works for tests.
- `app.test.ts`: cover public channel (admitted), allowlisted private (admitted), non-allowlisted private (dropped), missing `channel_type` with lookup returning private+allowlisted (admitted), missing `channel_type` with lookup timeout (dropped), config load failure (dropped).

Exit: `pnpm --filter @thor/gateway test` green.

### Phase 3 — Docs

- README Deployment Configuration: document the `slack.private_channel_allowlist` key, the fail-closed behavior, and the scope (`group` only, not `im` / `mpim`).
- `docs/examples/thor.json`: add a one-entry example.
- This plan doc.

Exit: README example matches the schema; canonical example file validates against `WorkspaceConfigSchema`.

### Phase 4 — Move missing-`channel_type` lookup off the Slack ack path

Mirror the GitHub `pending:branch-resolve:` pattern (`packages/gateway/src/github.ts:291-299`, `packages/gateway/src/app.ts:1812,1847`, `packages/gateway/src/service.ts:650-691`) for the Slack privacy fallback. Keep the synchronous fast path for events where `channel_type` is conclusive — those still decide drop/accept before the queue.

- **Hybrid gate split** (`packages/gateway/src/app.ts`):
  - `channel_type === "group"` → run allowlist check inline; drop or enqueue accordingly (no API call, current behavior).
  - `channel_type ∈ {"channel", "im", "mpim"}` → not private, enqueue (current behavior).
  - `channel_type` missing → enqueue under a new `pending:slack-privacy:` correlation key, ack 200 immediately, **do not** call `conversations.info` in the webhook handler.
- **Privacy correlation key** in `packages/gateway/src/slack.ts` (or alongside the existing helpers): `buildPendingSlackPrivacyKey(channel, eventId)` and `isPendingSlackPrivacyKey(key)`, modeled on `buildPendingBranchResolveKey` (`github.ts:293`). Channel id is in the key so the dispatcher can resolve once per channel per batch.
- **Resolver in `planBatchDispatch`** (`packages/gateway/src/service.ts`): before slack-event dispatch, group pending-privacy events by channel, call `isSlackEventInPrivateChannelScope` once per channel, then apply the allowlist. Dropped events are recorded with `reason: "private_channel_not_allowlisted"` against the original webhook history row via the existing audit-update path. Mirror `resolveGitHubPrHead` in shape (`service.ts:1059-1099`).
- **Move `addReaction(:eyes:)`** off the webhook handler for the missing-`channel_type` branches. Reactions for events that take the synchronous fast path stay inline; reactions for pending-privacy events post from the dispatcher *after* the gate clears, so we never visibly react to events we're about to drop. The fast-path branches keep current latency.
- **Timeout relaxation**: with the call no longer competing for the 3s Slack ack budget, raise the privacy lookup timeout from 1.5s toward parity with `INTERNAL_EXEC_TIMEOUT_MS = 5_000` (`service.ts:32`). Fail-closed behavior on timeout/error stays unchanged.
- **Tests** (`packages/gateway/src/app.test.ts`, `service.test.ts`):
  - Webhook handler: `channel_type: "group"` non-allowlisted → 200 + `private_channel_not_allowlisted` reason recorded inline (unchanged). Missing `channel_type` → 200 + `correlationKey` starts with `pending:slack-privacy:`. No `conversations.info` call from the handler.
  - Dispatcher: pending-privacy event → resolver invoked once per channel; allowlisted channel dispatches; non-allowlisted drops with audit reason; lookup timeout drops fail-closed.
- **Docs**: update README's "private channel allowlist" paragraph to drop the `conversations.info`-in-the-webhook framing in favor of "resolved asynchronously after acknowledgement, like GitHub branch resolution"; update the verification recipe to look for `correlationKey: "pending:slack-privacy:..."` in the webhook history for the missing-`channel_type` events.

Exit: `pnpm --filter @thor/gateway test` green; integration run against a non-allowlisted private channel shows webhook 200 in <100ms and a deferred drop with the correct audit reason; reaction emoji does not appear on dropped events.

Out of scope for Phase 4 (revisit if metrics demand): per-channel privacy cache from Decision #9 — Phase 4 already collapses lookups within a batch, so the marginal value of a TTL cache is smaller.

## Verification

- After deploying, invite the bot to a private channel that is **not** on the allowlist and post a message that would normally trigger Thor. Confirm the gateway logs the event with `reason: "private_channel_not_allowlisted"` and the runner is not called.
- Add the channel id to `slack.private_channel_allowlist` in `thor.json`. No restart. Repeat the trigger and confirm normal handling.
- Repeat the same two steps in a public channel to confirm the gate does not affect public-channel behavior.
- After Phase 4 ships: @-mention the bot in a non-allowlisted private channel (an `app_mention` event has no `channel_type`, so it takes the async path). Confirm the webhook returns 200 in <100ms, the corresponding queue entry is recorded with a `pending:slack-privacy:` correlation key, the dispatcher records `private_channel_not_allowlisted` against the original webhook history row, and **no** `:eyes:` reaction is posted to the message.
