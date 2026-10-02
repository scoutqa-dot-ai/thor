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

## 2026-10-02 — Diagnose blocked onboarding before claiming a DM

Second live screenshot still shows the pre-DM verified-member denial, with misleading advice to open a link never sent. The previous tests verified the injected app path, not the server's actual denial cause. Preserve all identity checks; do not guess or weaken them without server evidence.

One fix phase: classify missing/invalid OAuth setup separately from Slack member/profile/scope/workspace/active-turn failures; expose secret-free setup diagnostics and an internal-secret-gated per-member probe for operators; require Slack-confirmed DM delivery before reporting a link sent. Add agent guidance distinguishing 'not sent' from 'sent'. Cover real production startup env loading, missing config/scopes, workspace mismatch, failed/misdirected DM and successful onboarding with real HTTP fixtures. Request safe health/rejection output from the Ubuntu server; do not claim live success until confirmed.

Decision: setup metadata may expose missing/invalid variable names, not values or credentials. Provider errors are reduced to allowlisted categories. No automatic account fallback, no new application env vars, no Ubuntu policy changes, and no OAuth link/token in diagnostics or normal worklogs.

### User clarification — requester-owned OAuth, no profile-email prerequisite

The user explicitly clarified the required flow: detect the requesting Slack user, DM that user the OAuth link, then use the resulting token for their Google Workspace access. The profile-email authority from the prior fix is superseded: trusted active Slack attribution selects the recipient/account slot; identity is learned during private browser OAuth, not through `users.info`. Optional Google pins remain restrictions; Jira email and agent/browser account selectors never choose the Slack owner.

Decision: the random private DM link is a single-use invitation capability. Without an operator pin, the Vouch-authenticated browser must explicitly confirm the Google email and exact Slack user/workspace via an HMAC/CSRF-protected POST before Google authorization. The page tells the recipient to proceed only for their own Slack account and never forward the link. Google must verify that confirmed email; PKCE, state, same-browser cookie, encrypted grants and owner-only command approval remain mandatory. New authorization gets a new connection ID so old approvals/results cannot reuse a replaced grant. No Slack email-read scope is needed; the manifest enables Messages Tab for DM delivery. A server operator must still supply valid Google OAuth setup.

Implementation: remove the profile client/lookup from the authorization path instead of keeping an unused alternative identity authority. Resolve the trusted requester and optional pin synchronously, load the grant by workspace+Slack ID and bind command approvals to its verified Google email/connection. Private result retrieval also checks the current connection. Setup health/probe expose only setting names and booleans; the probe is internal-secret gated. Slack POSTs do not follow redirects, require HTTP 200 and confirm a DM response before reporting link delivery. Agent guidance distinguishes not-sent/unconfirmed from sent.

Exit criteria: production env loader + actual HTTP Slack fixture issue a DM without email permission/profile/directory/mapping; real embedded Pi reaches private confirmation→Google callback→same-user token execution→owner-only one-use result. Wrong confirmation/browser/Google account, stale/non-Slack turn, wrong owner, changed pin/grant and malformed/redirected DM deny safely. Existing encrypted/pinned grants remain usable. Run full unit suite, typechecks/builds and rebuilt GWS/Drata/Pi container contracts; live server acceptance and GitHub checks remain unverified.

Validation: 68 files / 900 unit tests passed under Node 24; recursive workspace typechecks and builds passed. Production env-loading HTTP tests prove no profile/email permission dependency and confirmed private delivery, with missing/invalid setup, secret-gated diagnostics and no redirect forwarding. Real Pi integration proves private confirmation and cross-browser proof rejection, Google callback, owner grant, owner-only approval and one-use output; another human gets their own DM rather than the prior participant's grant. Pinned/unpinned execution tests deny replaced connections and changed restrictions before execution. Rebuilt isolated GWS/Drata container contract and Pi container E2E (signed Slack routing, mount isolation, SIGKILL recovery) passed. No live Google/Slack or Ubuntu deployment was exercised. Current GitHub gates/PR and deployment acceptance remain pending; commit only, no push.

### Browser-context rejection reported after DM delivery

The live screenshot at `/google-workspace/connect/authorize` says only 'The connection link is invalid.' This exact branch means a missing/expired connection cookie or missing forwarded SSO email; it is before Google authorization and does not establish which condition occurred. Separate the two page messages and log only boolean presence flags under `gws_oauth_browser_context_missing`. Preserve a valid connection cookie when SSO identity is missing so correcting ingress does not destroy the invitation. Keep all authorization checks. A real HTTP regression stages the original DM link, proves distinct failures, and retries successfully with restored SSO identity. Actual browser/server cause still needs the operator's secret-free log flags; never request the private link, cookie or token.

Browser-context follow-up validation: 68 files / 901 tests, all recursive typechecks/builds and rebuilt isolated GWS/Drata container contract passed. No server cookie/header evidence has yet been supplied, so the actual deployment cause remains unconfirmed. Commit only; no push or server changes.
