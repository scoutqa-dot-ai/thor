# Slack Operator Runbook

This runbook covers the minimum setup for Slack intake in Thor (`POST /slack/events`, `POST /slack/interactivity`) and common failure modes seen in gateway logs.

Thor uses the **HTTP Events API** only. Socket Mode is not supported.

## 1) Environment variables

Set these in `.env` (or your deployment secret store):

| Variable                | Required | Used by                                | What it is                                                                | Where to find it in Slack UI                                              |
| ----------------------- | -------- | -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`       | Yes      | gateway, runner, remote-cli, mitmproxy | Bot user OAuth token (`xoxb-…`) for all Web API calls                     | Slack app → **OAuth & Permissions** → Bot User OAuth Token                |
| `SLACK_SIGNING_SECRET`  | Yes      | gateway                                | HMAC secret used to verify `X-Slack-Signature` on webhook requests        | Slack app → **Basic Information** → Signing Secret                        |
| `SLACK_BOT_USER_ID`     | Yes      | gateway, admin                         | Bot user id; used for mention detection and self-loop guard               | Run `curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test` and read `user_id` |
| `SLACK_DEFAULT_REPO`    | Yes      | gateway                                | Repo basename under `/workspace/repos/<name>` used when a channel has no per-channel override | User-supplied; must match an existing local clone                         |
| `SLACK_TEAM_ID`         | No       | runner, admin                          | Workspace team id; enables permalink rendering in the viewer and admin UI | Any Slack URL: `https://app.slack.com/client/<TEAM_ID>/...`               |
| `SLACK_API_BASE_URL`    | No       | gateway, runner, remote-cli, mitmproxy | Override for the Slack Web API base; defaults to `https://slack.com/api`  | Infrastructure / proxy config                                             |

## 2) Slack app manifest

A complete, deployable manifest lives at [`docs/examples/slack.json`](./examples/slack.json). Import it from **Your Apps → Create New App → From an app manifest** and edit the request URLs to point at your gateway host.

Three gateway routes must be reachable from Slack:

| Purpose                  | URL                                    | Where in manifest                                  |
| ------------------------ | -------------------------------------- | -------------------------------------------------- |
| Event subscriptions      | `https://<gateway-host>/slack/events`        | `settings.event_subscriptions.request_url`         |
| Interactivity (approval buttons) | `https://<gateway-host>/slack/interactivity` | `settings.interactivity.request_url`         |
| OAuth redirect           | `https://<gateway-host>/slack/redirect`      | `oauth_config.redirect_urls`                       |

Content type for event delivery is **`application/json`**.

## 3) Required bot scopes

The manifest defines the full set. Minimum scopes for app-mention-only operation:

| Scope                | Why                                                                |
| -------------------- | ------------------------------------------------------------------ |
| `app_mentions:read`  | Receive `app_mention` events                                       |
| `chat:write`         | Post progress, approval cards, and replies via `chat.postMessage`  |
| `channels:read`, `groups:read`, `im:read`, `mpim:read` | Introspect channel privacy / shared-channel status (private channel gate, §5) |
| `reactions:write`    | Receipt reactions (`:eyes:`, `:lock:`, `:x:`)                      |
| `reactions:read`     | Read user reactions when scripted flows depend on them             |

Add `*:history` (`channels:history`, `groups:history`, `im:history`, `mpim:history`) when Thor needs to read prior thread context. Add `files:read` / `files:write` when working with attachments. See the manifest for the full list.

## 4) Required event subscriptions

Subscribe to:

- `app_mention`
- `message.channels`, `message.groups`, `message.im`, `message.mpim` (engaged-thread follow-ups in non-mention messages)
- `reaction_added`, `reaction_removed`

Only `app_mention` is required for first-contact triggers. The `message.*` events are needed once a thread is already engaged so follow-up replies without `@mention` still wake Thor.

## 5) Workspace config: profiles for gated channels

Public, non-shared channels can trigger Thor without configuration. Private channels (`group`), DMs (`im`), group DMs (`mpim`), and Slack Connect / shared channels are **fail-closed by default** — they only admit if the channel id appears in a `profiles.<name>.channels[]` list in `/workspace/config/thor.json`:

```json
{
  "profiles": {
    "qa": {
      "channels": ["C0123456789", "C9876543210"]
    }
  }
}
```

Profile edits hot-reload — no service restart needed. Events from gated channels that are not listed in any profile are dropped with `private_channel_not_allowlisted` (§10). The profile also selects profile-scoped MCP credentials when present; public channels outside profiles use unsuffixed global credentials.

## 6) Per-channel repo override

By default a Slack channel routes to `SLACK_DEFAULT_REPO`. To route a specific channel to a different repo, drop a file at:

```
/workspace/memory/thor/repo-by-slack-channel/<channel-id>.txt
```

containing the repo basename (matching a directory under `/workspace/repos/`). The override takes effect immediately on the next event.

## 7) Bot identity and signature verification

- **Sender identity** — the gateway uses `SLACK_BOT_USER_ID` to filter self-authored events (self-loop guard) and to detect mentions.
- **Signature verification** — `X-Slack-Signature` is computed as `v0=HMAC_SHA256(SLACK_SIGNING_SECRET, "v0:" + X-Slack-Request-Timestamp + ":" + raw_body)`. Requests older than 300 seconds (`SLACK_TIMESTAMP_TOLERANCE_SECONDS`) are rejected.
- **URL verification** — Slack's one-time `url_verification` challenge is answered automatically; no manual step is needed when first pointing the app at the gateway.

## 8) Secret rotation

1. Generate a new signing secret in **Basic Information → Signing Secret**.
2. Update `SLACK_SIGNING_SECRET` in Thor deployment immediately after.
3. Trigger any Slack event (a test message in a profiled private channel or public channel) and confirm acceptance with no `signature_invalid` entries.

Bot token rotation: re-install the app to the workspace, copy the new `xoxb-…` token, update `SLACK_BOT_TOKEN`, and restart the services that hold it in memory (`gateway`, `runner`, `remote-cli`, `mitmproxy`). Use a short overlap window so in-flight replies still resolve.

## 9) Local dev

Slack requires a public HTTPS URL — there is no smee.io-equivalent. For local development:

1. Run gateway locally on `3002`.
2. Expose it through a tunnel (ngrok, Cloudflare Tunnel, etc.):

   ```bash
   ngrok http 3002
   ```

3. Update the Slack app's Event Subscriptions, Interactivity, and OAuth redirect URLs to the tunnel URL.
4. Send a test mention from any profiled private channel or public channel and verify gateway logs.

Remember to revert URLs back to your shared deployment when you're done — only one URL set per app.

## 10) Troubleshooting (`slack_event_ignored`)

| Reason                            | What it means                                                                       | How to fix                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `signature_invalid`               | HMAC verification failed, signature header missing, or timestamp outside tolerance  | Verify `SLACK_SIGNING_SECRET`; check clock skew; ensure raw body is unmodified by proxies               |
| `private_channel_not_allowlisted` | Event came from a gated channel (private / DM / group-DM / Slack Connect) not in any profile | Add the channel id to `profiles.<name>.channels[]` in `thor.json`                                       |
| `schema_validation_failed`        | Payload did not match the expected Slack event schema                               | Likely a Slack API change or a malformed delivery; inspect the gateway log entry for the failing path   |
| `json_parse_error`                | Request body was not valid JSON                                                     | Confirm the app delivers `application/json`; check upstream proxies for body rewriting                  |
| `self_sender`                     | Event sender id matches `SLACK_BOT_USER_ID`                                         | Self-loop guard — expected when Thor posts replies or reactions                                         |

Channel-privacy lookups (`conversations.info`) are cached for 60 minutes; failures fail closed and drop the event under `private_channel_not_allowlisted`. If a private channel that should admit is being rejected, confirm the bot is invited to the channel, the channel id appears in exactly one profile, and the `*:read` scopes are granted.
