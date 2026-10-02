# Google Workspace

Thor installs [`@googleworkspace/cli`](https://github.com/googleworkspace/cli), pinned in `Dockerfile`. The agent's `gws` wrapper sends argv to trusted `remote-cli`; Pi and OpenCode never receive Google refresh credentials, OAuth client secrets or connection storage.

## Security and ownership model

Each command is owned by the human who started the **currently active Slack turn**:

1. `remote-cli` resolves the latest open trigger bound to the Thor session.
2. The trigger must be Slack-only. Cron, GitHub, missing, ended, superseded, or ambiguous triggers fail closed.
3. The trusted Slack user ID selects the DM recipient and account slot in `SLACK_TEAM_ID`. Neither a directory entry, a Slack profile email nor email-read permissions are required. An explicit `google_workspace_email` is an optional restriction on account choice; conflicting pins fail closed. Jira `email`, agent argv and browser query parameters never choose the credential owner.
4. Thor loads only that Slack user's encrypted Google grant. There is no global account or service-account fallback.
5. Thor stores exact argv in encrypted private state and posts a secret-free Slack approval containing the operation, argument count, expected Google account, Slack user, and keyed HMAC-SHA-256 command fingerprint.
6. Only the same Slack user can approve or reject the action. The private command is consumed before execution, so an uncertain result is never replayed from the same approval.
7. `remote-cli` refreshes one short-lived access token, revalidates its Google email and subject, and injects only `GOOGLE_WORKSPACE_CLI_TOKEN` into a fresh private `gws` cwd. The cwd is deleted after execution.

`gws auth`, including login, logout, and credential export, is blocked at the agent-facing boundary. Local file input/output flags, absolute/file-URI/response-file arguments, and upload/download/import/export/send helpers are also blocked so the credential-bearing child cannot be used to read or export other `remote-cli` files. OAuth client credentials, refresh tokens, authorization codes, PKCE verifiers, state, cookies, raw argv, and OAuth response bodies are not returned to OpenCode or Slack and are not written to normal worklogs.

Outside those credential and local-filesystem exclusions, Thor does not reinterpret upstream Google API commands. Google OAuth scopes, Google resource permissions, Workspace policy, and the explicit Slack approval jointly define authority. Command output still reaches the requesting session and can contain sensitive Workspace data.

## Configure Google OAuth

1. In Google Cloud, enable the Drive, Docs, and Sheets APIs.
2. Configure the OAuth consent screen for the intended Workspace users.
3. Create a **Web application** OAuth client and register exactly:

   ```text
   https://<thor-host>/google-workspace/oauth/callback
   ```

4. Set the remote-cli-only values in `.env`:

   ```dotenv
   GOOGLE_WORKSPACE_OAUTH_CLIENT_ID=...
   GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET=...
   # Exact HTTPS origin; no path or trailing slash.
   GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL=https://thor.example.com
   GOOGLE_WORKSPACE_OAUTH_SCOPES=https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/documents,https://www.googleapis.com/auth/spreadsheets
   GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY=<32-byte-base64-value>
   # Optional quota/billing project:
   # GOOGLE_WORKSPACE_PROJECT_ID=your-project-id
   ```

   Generate a dedicated encryption key, for example with `openssl rand -base64 32`. Store and back it up as a production credential. Losing or changing it invalidates every stored connection. Do not reuse `THOR_INTERNAL_SECRET`, Vouch secrets, or the Google client secret.

5. Set `SLACK_TEAM_ID` to your workspace ID. Enable **App Home → Messages Tab** in the Slack app and allow messages from users (included in the example manifest). The bot needs `chat:write` for the private DM; Google onboarding does not require `users:read.email`. Optionally restrict a user's Google account in workspace config:

   ```json
   {
     "email": "alice@example.com",
     "name": "Alice",
     "slack": "U01234567",
     "github": "alice",
     "google_workspace_email": "alice@example.com"
   }
   ```

   Credential selection always starts from the trusted active Slack ID; the agent cannot select an account by supplying an email.

6. On an existing Pi deployment, preserve `.env`, the Compose project and all data, then rebuild:

   ```bash
   docker compose build remote-cli runner pi-executor
   docker compose up -d
   docker compose ps remote-cli runner pi-executor
   curl -fsS http://127.0.0.1:3004/health | jq
   ```

   For the legacy runtime, rebuild `remote-cli` and `opencode` instead. Initial Google setup also needs the ingress configuration described above.

## Connect and execute

On the first `gws` request for an unconnected user, Thor sends a private Slack DM containing a random, single-use link that expires after ten minutes. The link is bound to Slack workspace, Slack user, Thor session, anchor and trigger, plus any optional Google pin. Slack must confirm delivery to a DM before the tool reports a link sent. The private link is an invitation capability: do not forward it.

Ingress first moves the private request ID into a scoped `HttpOnly` cookie and redirects to a query-free authorization path, so the capability does not pass through Vouch URLs or normal access/error logs. The browser flow then requires:

- a Vouch-authenticated browser email, matching any explicit Google pin;
- for an unpinned connection, a confirmation page displaying that Google email and the exact Slack user/workspace; an explicit CSRF-protected POST confirms the association before Google authorization;
- exact OAuth state and PKCE verifier;
- a same-browser `HttpOnly`, `Secure`, `SameSite=Lax` nonce cookie;
- Google's verified userinfo email equal to the confirmed browser address, never a Slack profile assumption;
- the exact registered callback path;
- no followed HTTP redirects during Slack DM, OAuth token or userinfo calls.

The verified Google grant is encrypted under that Slack user's account slot. Later requests use it directly without another Slack email lookup. Refresh rechecks Google's email and subject. New authorizations get a new connection binding, invalidating approvals/results for a replaced connection.

For an unpinned account, the expected sequence is browser SSO → confirm the displayed Google/Slack association → Google's account picker and consent → **Google Workspace connected**. The authorization request explicitly uses `prompt=select_account consent`. The confirmation page's CSP permits only same-origin form submission and the trusted Google authorization origin for its redirect. A Resume/error page is not completed authorization; connection-required tool responses remain authoritative.

After the page reports success, return to Slack and retry the original request. Thor then posts the command approval in the originating thread. The command fingerprint binds the card and audit trail to the exact encrypted argv without putting argv or document contents in Slack. After resolution, the trusted gateway gives the re-entered turn a short-lived, single-use result capability. The agent retrieves command output with `approval result <action-id> <capability>`; output remains encrypted until that retrieval and never enters the Slack card or gateway resolution log. The capability is not returned by approval list/status and must never be quoted to Slack or reused.

## Disconnect and revoke

A connected user can open:

```text
https://<thor-host>/google-workspace/disconnect
```

Vouch must authenticate the connected Google email. Thor finds its unique encrypted grant, including accounts connected without a config pin. The page requires an explicit same-browser POST confirmation protected by a five-minute CSRF nonce; merely opening the URL does not mutate state. Thor deletes only that grant. The user should also revoke Thor from Google Account security settings; local deletion alone does not revoke the provider-side grant.

An operator responding to compromise should revoke the OAuth client or user grant at Google, stop `remote-cli`, preserve only the secret-free audit trail required by policy, delete the `google-workspace-oauth-data` volume, rotate `GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY` and the client secret, then recreate `remote-cli`.

## Storage, execution, and audit

- Encrypted requests, OAuth state, grants, and pending commands live in the remote-cli-only `google-workspace-oauth-data` volume. Files are mode 0600 under mode 0700 directories and use AES-256-GCM with path-bound additional authenticated data.
- The named volume and encryption key are both required to decrypt a grant. Neither is mounted into OpenCode.
- Refresh tokens stay encrypted at rest and are revealed only inside the broker during refresh. Only the resulting short-lived access token enters the isolated `gws` child environment.
- Request cwd is ignored. `gws` receives a fresh empty HOME/config directory, selected PATH, optional project ID, and the access token—no Slack token, OAuth client secret, credential file, inherited cached auth, or shared `.env`.
- Audit records contain action ID, reviewer Slack ID, owner Slack ID, Google email/subject connection ID, operation category, argument count, command fingerprint, approval/outcome status, and Thor correlation IDs. They omit raw argv, tokens, OAuth parameters/responses, and document contents.
- OAuth requests/state expire after 10 minutes; encrypted private command payloads, results, and result capabilities expire after 30 minutes and are pruned during broker activity. Result retrieval is single-use. Wrong-user review does not execute or consume the command; successful dispatch consumes it before the external side effect.
- Secret-free approval summaries and structural outcome logs follow the deployment's normal approval/worklog retention policy. Operators should set that policy to their audit requirement; increasing it does not retain raw argv or OAuth material.

## Troubleshooting

- **No OAuth DM was sent:** the turn is not an active Slack request, optional pins conflict, or OAuth setup is incomplete. Do not look for a nonexistent link. `/health` → `googleWorkspaceOAuth` reports missing/invalid variable names, never values.
- **Private OAuth DM delivery unconfirmed:** check `chat:write`, the installed bot token and App Home → Messages Tab. A public-channel response or incomplete Slack response is not accepted as confirmed DM delivery.
- **Google Workspace connection required / link sent:** open the private DM, verify the displayed Google account and Slack recipient, authorize, then retry from Slack. No Slack email or Google mapping is needed.
- **Connection link rejected:** request expired, was already used, violates an optional pin, has a mismatched confirmation proof/browser, or returned without the same-browser cookie. Request a new link; do not reuse callback URLs.
- **Resume connection after sign-in:** click **Continue securely in this browser**. A login return can temporarily withhold a stored Lax cookie; the same-site click retries without deleting it or bypassing authorization. If the cookie remains absent, open a fresh original DM link in the same browser and check cookie blocking/browser switching. `gws_oauth_browser_context_missing` logs only cookie/SSO presence booleans. A missing SSO identity needs ingress/Vouch investigation. Never share the link or cookie values.
- **Approval rejected:** only the Slack user who owns the connected account can approve.
- **Account access unavailable:** refresh failed or the stored grant is invalid. Disconnect/revoke, reconnect, and submit a new command.
- **503 / exit 2:** check OAuth environment, exact public HTTPS origin, fixed scopes, encryption-key length, named-volume permissions, and UID/GID 1001 ownership.

An operator can probe a member's optional pin/connection status without triggering OAuth, reading profile email or revealing credentials:

```bash
# Replace U01234567 with the requesting Slack member ID; run on the deployment host.
docker compose exec -T remote-cli node -e 'fetch("http://127.0.0.1:3004/internal/google-workspace/diagnostics", {method:"POST", headers:{"content-type":"application/json","x-thor-internal-secret":process.env.THOR_INTERNAL_SECRET},body:JSON.stringify({slackUserId:"U01234567"})}).then(r=>r.json()).then(r=>console.log(JSON.stringify(r,null,2)))'
```

Focused tests cover PKCE/state/cookie ownership, replay, expiry, identity mismatch, encrypted storage, redirect rejection, same-user command consumption, blocked auth commands, child environment isolation, approval presentation, and active-trigger fail-closed behavior. Live Google verification remains an operator deployment step; no production OAuth credential belongs in tests, Slack messages, repository files, or agent memory.

Real browser cookie regression (requires Chromium and `openssl`, uses only local HTTPS fixtures):

```bash
node --import ./packages/runner/node_modules/tsx/dist/loader.mjs scripts/test-gws-browser-cookie.mjs /path/to/chromium
```

Full ingress/browser regression (Linux Docker, Chromium and `openssl`; uses the shipped Nginx template and local fake SSO/Google providers, not live accounts):

```bash
node --import ./packages/runner/node_modules/tsx/dist/loader.mjs scripts/test-gws-ingress-browser.mjs /path/to/chromium
```

If the real browser still loses the invitation cookie while the local flow passes, try a fresh DM link in an incognito window. For diagnosis inspect Chrome DevTools → Network → the initial `/google-workspace/connect` response → Cookies for a blocked-cookie reason, and Application → Cookies for the presence of `thor_gws_connect_request`. Share only names/presence/reasons, never link or cookie values. The old browser profile, a browser switch or a deployment-specific proxy can differ from the isolated regression; local success does not establish live account readiness.
