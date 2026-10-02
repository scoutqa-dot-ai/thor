# Per-user Google Workspace OAuth

## Goal

Bind every agent-initiated Google Workspace operation to the Slack user driving the active turn, use only that user's connected Google account, require that same user to approve execution, and retain a secret-free audit record of who authorized the operation.

The design follows Junior's connected-account model: long-lived credentials stay outside OpenCode, authorization links are private and short-lived, callbacks are user/provider/conversation-bound and single-use, and only a short-lived provider credential reaches the command process.

## Security invariants

- Only an active Slack-triggered turn may request Google Workspace access. GitHub, cron, stale and unverified actors fail closed. Verified same-workspace Slack members can onboard without a directory entry.
- Google email comes from an optional explicit `google_workspace_email` pin or the trusted Slack profile, never Jira identity or agent input; Vouch and verified Google userinfo must match it exactly.
- OAuth connection links are sent privately to the resolved Slack user. They are short-lived, single-use, and bound to the Slack workspace/user, Thor session/trigger, expected Google email, PKCE verifier, browser nonce, and fixed redirect URI.
- Refresh tokens are encrypted at rest in remote-cli-only storage. OpenCode receives no OAuth client secret, refresh token, credential file, or encrypted store access.
- `gws` receives one short-lived access token through `GOOGLE_WORKSPACE_CLI_TOKEN` for one approved execution. It receives no credential file, OAuth client secret, refresh token, or shared authenticated config directory.
- Agent-facing `gws auth` and local file input/output command surfaces are rejected. Missing, expired, revoked, mismatched, or unreadable credentials never fall back to the global service identity.
- Every Google Workspace command requires approval by the same Slack user who owns the active turn. Approval is consumed before dispatch so uncertain provider outcomes cannot be retried with the same authorization.
- Slack cards and logs contain only a bounded command classification, argument count, keyed HMAC-SHA-256 command fingerprint, Slack identity, configured Google email, opaque connection/action IDs, correlation IDs, outcome, and HTTP/exit classifications. They never contain tokens, OAuth codes/state/verifiers, raw argv, request bodies, document contents, or provider response bodies.

## Phases

### Phase 1 — Identity, OAuth state, and credential storage

- Add an active-Slack-trigger resolver that never falls back to ended triggers or GitHub actors.
- Extend workspace users with explicit `google_workspace_email`.
- Add a cohesive Google Workspace OAuth service in remote-cli:
  - parse fixed deployment configuration;
  - create expiring connection requests;
  - generate PKCE authorization redirects;
  - validate one-time callback state and same-browser nonce;
  - exchange codes without redirects;
  - verify Google userinfo;
  - encrypt refresh grants with AES-256-GCM;
  - refresh short-lived access tokens without exposing response bodies.
- Add exact ingress routes for connect, disconnect, and callback. Connect/disconnect use Vouch identity; callback authenticity comes from state plus the same-browser nonce. Ingress overwrites the internal-auth header.

Exit criteria:

- State replay, expiry, browser mismatch, Vouch-email mismatch, Google-email mismatch, redirect responses, malformed provider responses, and corrupt encrypted records all fail safely.
- Stored records and diagnostics contain no plaintext token, code, verifier, client secret, or browser nonce.

### Phase 2 — Approval-gated GWS execution

- Reject `gws auth` at the remote-cli boundary.
- Replace global credentials with a per-user access-token input and an unauthenticated private command workspace.
- Create a `google_workspace_command` approval action with a safe presentation and private execution payload.
- Allow only the action's bound Slack user to approve it.
- Persist approval consumption before launching `gws`; return uncertain failures without making the approval reusable.
- Re-enter the Slack thread through the existing approval outcome path; keep raw command output encrypted and expose it once through a short-lived result capability delivered only after owner approval.

Exit criteria:

- Unconnected users receive a private link and no command runs.
- Connected commands do not run before approval, cannot be approved by another Slack user, and run once with only a short-lived access token.
- Cron, GitHub, stale, spoofed, replayed, cross-user, and global-credential fallback paths do not execute.

### Phase 3 — Deployment, documentation, and verification

- Add OAuth client, scope, encryption-key, public-base-URL, Slack-team, and private-store deployment surfaces.
- Document account connection, explicit retry after connect, revocation, approval, auditing, backups, and rebuild steps.
- Add deterministic provider/Slack/gws fixtures using dummy values only.
- Run focused tests, recursive typechecks/builds as required, formatting, and configuration checks in isolated validation.

Exit criteria:

- Operators can configure and rotate the OAuth client and encryption key without exposing them to OpenCode.
- Tests prove the identity, state, storage, token-injection, approval, replay, and redaction boundaries.
- No unrelated staged, unstaged, or untracked work is changed.

## Decision log

| #   | Decision                                                              | Rationale                                                                                                                                                              | Rejected                                                                                             |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Use Slack user ID plus deployment Slack team as the connection owner  | Slack verifies the triggering user; a thread may contain multiple humans, so ownership must be per active turn rather than per thread.                                 | Thread creator or display name as owner.                                                             |
| 2   | Require explicit `google_workspace_email` and verified-email equality | Existing `email` is documented as Jira identity and must not silently become Google authorization policy.                                                              | Accept whichever Google account completes OAuth.                                                     |
| 3   | Keep OAuth and refresh-token ownership in remote-cli                  | It already owns GWS execution and is outside OpenCode; this avoids moving long-lived credentials through the model-facing container.                                   | Run `gws auth login` in OpenCode or store one config directory per agent session.                    |
| 4   | Inject only `GOOGLE_WORKSPACE_CLI_TOKEN`                              | Pinned gws gives this source highest priority; the process needs no refresh token or credential file.                                                                  | Per-user plaintext credential files or encrypted gws stores reachable by unrestricted auth commands. |
| 5   | Require owner approval for every GWS execution initially              | It provides an unforgeable human action despite agent-controlled session headers and avoids an unsafe read/write classifier. The policy can later exempt proven reads. | Trust agent-supplied session IDs or method-name heuristics.                                          |
| 6   | Consume approval before dispatch                                      | A lost response does not prove a provider mutation failed; replay could duplicate an already committed change.                                                         | Mark approved only after a successful response.                                                      |
| 7   | Use exact ingress routes with internal header replacement             | Browser endpoints need public reachability, while direct Docker-network callers must not forge Vouch identity or callback authority.                                   | Expose remote-cli browser routes directly or trust client-supplied `X-Vouch-User`.                   |

## Out of scope

- Personal credentials for cron or GitHub-triggered automation.
- Domain-wide delegation or service-account fallback.
- Gmail, Calendar, or arbitrary scopes beyond the operator-configured fixed scope set.
- Automatically retrying an uncertain Google mutation.
- Treating the upstream gws binary as a filesystem sandbox.

## 2026-10-02 — Pi Slack DM onboarding fix

Observed on the Ubuntu deployment: Pi works, but missing `google_workspace_email` prevents the first GWS request from reaching the existing private OAuth DM flow.

Implementation phase: resolve missing pins from the bot-authenticated Slack `users.info` response for the active user in the configured workspace. Existing explicit pins remain authoritative; never infer Google identity from the Jira `email`, agent argv, or browser query. Verified same-workspace human members can onboard without a workspace directory entry; ambiguous/conflicting directory pins, missing profile email, deleted/bot/external users and Slack API failures deny access. Revalidate active turn after lookup and account identity at approval execution. Keep Vouch/Google verified-email equality, encrypted state, PKCE, browser nonce and owner approval/one-use results. Disconnect must resolve the verified Google identity from encrypted grants even without a configured pin.

Exit criteria: real Pi request with no Google mapping gets a private DM and no execution; wrong Vouch/Google identity and profile/turn failures deny; connecting then retrying requires owner approval and executes once; disconnect/reconnect works without mapping; existing pinned-user paths still pass. Run focused/full tests, typechecks/builds and isolated container checks. No live credentials or Ubuntu security-policy changes.

Decision: Slack's verified membership/email directory is the default identity authority (existing manifest already includes `users:read`/`users:read.email`); optional explicit Google pins support intentional differences. This supersedes the original explicit-pin-only/unmapped-user rejection policy, not OAuth or approval ownership. New identity service consolidates lookup/revalidation shared by submission, resolution and private results; attribution for unrelated integrations remains unchanged. No new application environment variables.

Validation: 67 test files / 895 tests passed under Node 24, all recursive workspace typechecks/builds passed. Real embedded Pi→HTTP executor→wrapper→remote-cli test now requests GWS without a Google pin, receives its private DM, denies a wrong Vouch browser, completes the cookie/PKCE callback, retries for owner-only approval and one-use results. Real HTTP Slack profile tests reject missing email/scopes, mismatched user/workspace, bot/deleted/external users, redirect and pin conflicts, and turns ending during lookup. Both pinned and self-service approval/disconnect paths pass, including account changes before execution. Encrypted disconnect lookup tests preserve duplicate, corrupt/unreadable and owner/path-mismatched evidence. Rebuilt isolated GWS/Drata container contract passed with no Google pin and a Jira-only directory email. Independent read-only review found no confirmed new regression; its disconnect failure-coverage gap was closed. No live Google credentials, Slack messages or Ubuntu deployment changes; commit-only delivery, integrated GitHub gates remain pending.
