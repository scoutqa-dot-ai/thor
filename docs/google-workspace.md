# Google Workspace

Use Neo as the existing Google OAuth consent application's display name. Preserve
its Web client ID/secret, registered callback and encryption key. Google's account
security list may retain the legacy name until that operator-side display update.

Neo installs [`@googleworkspace/cli`](https://github.com/googleworkspace/cli), pinned in `Dockerfile`. The agent's `gws` wrapper sends argv to trusted `remote-cli`; Pi and OpenCode never receive Google refresh credentials, OAuth client secrets or connection storage.

Public CLI discovery (`gws --help`, `--version`, scoped help and `gws schema`)
runs without a Google grant or an authentication DM. Account API operations alone
use the requester-owned credential flow below. Automatic task continuation is
provided by the Pi runtime; legacy OpenCode does not consume the auth outbox.

## Security and ownership model

Each command is owned by the human who started the **currently active Slack turn**:

1. `remote-cli` resolves the latest open trigger bound to the Neo session.
2. The trigger must be Slack-only. Cron, GitHub, missing, ended, superseded, or ambiguous triggers fail closed.
3. The trusted Slack user ID selects the DM recipient and account slot in `SLACK_TEAM_ID`. Neither a directory entry, a Slack profile email nor email-read permissions are required. An explicit `google_workspace_email` is an optional restriction on account choice; conflicting pins fail closed. Jira `email`, agent argv and browser query parameters never choose the credential owner.
4. Neo loads only that Slack user's encrypted Google grant. There is no global account or service-account fallback.
5. Connected commands execute directly, without per-command approval cards. Missing or definitively revoked credentials create an encrypted continuation containing only the exact parsed, unexecuted Google argv and the requesting workspace/user/session/anchor/trigger.
6. A confirmed private OAuth DM is required before a wait is resumable. Identical requests in the same turn reuse the current invitation. An uncertain provider execution is reported, never automatically retried as an auth failure.
7. `remote-cli` refreshes one short-lived access token and revalidates its Google email and subject. Ordinary API commands receive only `GOOGLE_WORKSPACE_CLI_TOKEN` in a fresh private `gws` cwd, deleted after execution. Drive downloads use trusted direct Drive API requests with that same requester-owned token, without a credential-bearing child or broker filesystem output.

`gws auth`, including login, logout, and credential export, is blocked at the agent-facing boundary. Local file input/output flags, absolute/file-URI/response-file arguments, and upload/import/export/send helpers remain blocked so the credential-bearing child cannot read or export other `remote-cli` files. The sole download exception is the exact `gws drive +download --file-id FILE_ID` command described below, with no local path input. OAuth client credentials, refresh tokens, authorization codes, PKCE verifiers, state, cookies, raw argv, and OAuth response bodies are not returned to Pi, OpenCode or Slack and are not written to normal worklogs.

Outside those credential and local-filesystem exclusions, Neo does not reinterpret upstream Google API commands. The active Slack requester, Google OAuth scopes, Google resource permissions and Workspace policy define authority. Command output still reaches the requesting session and can contain sensitive Workspace data.

## Drive downloads

```bash
gws drive +download --file-id FILE_ID
```

The ID can identify a normal file or folder, not a URL or the whole-drive `root`
alias. Folders recurse automatically, preserving empty directories. Shared-drive
access uses the same requester's permissions. Native Docs export to `.txt`, Sheets
to `.xlsx`, Slides to `.pptx`, and Drawings to `.pdf`; unsupported native types and
shortcut roots fail. Child shortcuts are reported/skipped, never followed.

Downloads are bounded to **50 MiB decoded total**, **1,000 entries** (root,
directories, files and skipped shortcuts), and **depth 32**. Names are made portable
and collisions disambiguated. Any provider, inconsistent-tree, or resource-limit
failure returns no artifact; narrow the request
to a smaller subfolder rather than relying on truncation. Drive HTTP requests use
fixed Google endpoints without followed redirects and a 60-second per-request
deadline. No new environment variable or endpoint override is provided.

The broker returns a dedicated versioned binary manifest, not stdout. The shared
Pi/OpenCode wrapper bounds the buffered HTTP body, validates the whole manifest
and verifies every SHA-256 before creating a fresh mode-0700 `neo-drive-` temporary
directory **inside the agent's filesystem**. Directories are mode 0700, files 0600
and writes exclusive. A write failure removes the entire unique directory.
Success prints only `{path, files, directories, bytes, skipped}` JSON, plus a
shortcut warning when needed; no base64, content or digest is printed. Use the
reported local path with normal file tools or `mv`/`cp`. Successful downloads
remain until the agent removes them or its temporary filesystem is discarded.

**Upgrade both sides:** rebuild/redeploy `remote-cli` and the active agent image:
`pi-executor` for Pi or `opencode` for OpenCode. They both bundle the shared
wrapper; rebuilding the broker alone does not add local downloads to an old
wrapper. Conversely a new wrapper rejects a successful old-broker response
without the artifact with an explicit rebuild message. Preserve existing OAuth
storage/key and deployment configuration; no new env var is required.

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

On the first `gws` request for an unconnected user, Neo sends a private Slack DM containing a random, single-use link that expires after ten minutes. The link is bound to Slack workspace, Slack user, Neo session, anchor and trigger, plus any optional Google pin. Slack must confirm delivery to a DM before the tool reports a link sent. The private link is an invitation capability: do not forward it.

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

After the page reports success, Neo automatically continues the waiting task once the runner admits its matching original request. No manual command approval or retry notification is sent. The broker saves the verified grant before publishing readiness. Browser completion does not itself prove the Google operation succeeded.

Pi polls a secret-gated durable outbox and admits only the still-current persisted original request with the same workspace, Slack requester, session, anchor and trigger. Busy original turns defer admission; a newer human turn or interrupt abandons the old wait. Its deterministic continuation receipt is stored before acknowledgement and normal model submission, allowing retry of admission/acknowledgement after restart without creating another task. The model receives original history plus exact blocked `gws` argv as scoped system context; it never replays a compound shell command or an uncertain earlier effect. This is at-most-once task admission, not an exactly-once Google mutation guarantee. Automatic continuation is implemented in Pi mode; legacy OpenCode keeps direct execution and historical handlers but has no automatic runner poller.

Readiness is withdrawn when its connected grant is disconnected or replaced. A resumed trigger remains bound to the original `connectionId`; refresh/identity and dispatch recheck that binding. Encrypted minimal dispatch tombstones retain negative authority beyond outbox expiry (with argv removed), so a later replacement account cannot execute an expired resumed trigger. Protect and retain these tombstones alongside broker ownership records; do not delete them while that Pi conversation can still execute.

The secret-gated broker outbox uses only `x-thor-internal-secret`: `GET /internal/google-workspace/continuations` returns `{continuations: [...]}`, and `POST /internal/google-workspace/continuations/:id/ack` returns `{acknowledged: true}`. A ready record contains `id` (the invitation request ID), `slackTeamId`, `slackUserId`, `sessionId`, `anchorId`, `triggerId`, `args`, `connectionId`, `createdAtMs` and `expiresAtMs`. Readiness expires 24 hours after successful authorization; acknowledgement is durable and idempotent. These private records authorize runner admission, not blind shell replay. The informational 428 exec response adds `authWait: {type: "google_auth_wait", id, expiresAtMs}` alongside the existing ExecResult fields; model/tool output is not readiness authority.

Historic approvals and encrypted results remain readable through the existing same-owner handlers and single-use result capabilities. New Google calls never create those approvals.

If the original still-running turn dispatches its exact blocked operation after sign-in but before runner admission, the broker retires that matching ready record before execution. Even an uncertain execution cannot leave the old wait available for later replay.

## Disconnect and revoke

A connected user can open:

```text
https://<thor-host>/google-workspace/disconnect
```

Vouch must authenticate the connected Google email. Neo finds its unique encrypted grant, including accounts connected without a config pin. The page requires an explicit same-browser POST confirmation protected by a five-minute CSRF nonce; merely opening the URL does not mutate state. Neo deletes only that grant. The user should also revoke Neo from Google Account security settings; local deletion alone does not revoke the provider-side grant.

An operator responding to compromise should revoke the OAuth client or user grant at Google, stop `remote-cli`, preserve only the secret-free audit trail required by policy, delete the `google-workspace-oauth-data` volume, rotate `GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY` and the client secret, then recreate `remote-cli`.

## Storage, execution, and audit

- Encrypted requests, OAuth state, grants, auth continuations and historic pending commands live in the remote-cli-only `google-workspace-oauth-data` volume. Files are mode 0600 under mode 0700 directories and use AES-256-GCM with path-bound additional authenticated data.
- The named volume and encryption key are both required to decrypt a grant. Neither is mounted into OpenCode.
- Refresh tokens stay encrypted at rest and are revealed only inside the broker during refresh. The resulting short-lived access token is used only by trusted broker Drive requests or the isolated `gws` child environment; neither runtime receives it.
- Request cwd is ignored. `gws` receives a fresh empty HOME/config directory, selected PATH, optional project ID, and the access token—no Slack token, OAuth client secret, credential file, inherited cached auth, or shared `.env`.
- Direct execution audit records contain requester Slack ID, connection ID, argument count, status/exit code and Neo correlation IDs. Historic approval records additionally retain reviewer/action IDs and keyed command fingerprints. Logs omit raw argv, tokens, OAuth parameters/responses and document contents.
- OAuth requests/state expire after 10 minutes; successful auth readiness lasts up to 24 hours. Encrypted dispatch tombstones retain only identity/grant/lease bindings, without argv, to reject late resumed operations after expiry or account replacement. Historic private commands/results expire after 30 minutes; their result retrieval remains single-use and same-owner-bound.
- Secret-free approval summaries and structural outcome logs follow the deployment's normal approval/worklog retention policy. Operators should set that policy to their audit requirement; increasing it does not retain raw argv or OAuth material.

## Troubleshooting

- **No OAuth DM was sent:** the turn is not an active Slack request, optional pins conflict, or OAuth setup is incomplete. Do not look for a nonexistent link. `/health` → `googleWorkspaceOAuth` reports missing/invalid variable names, never values.
- **Private OAuth DM delivery unconfirmed:** check `chat:write`, the installed bot token and App Home → Messages Tab. A public-channel response or incomplete Slack response is not accepted as confirmed DM delivery.
- **Google Workspace connection required / link sent:** open the private DM, verify the displayed Google account and Slack recipient, and authorize. Neo will continue the waiting task automatically. No Slack email or Google mapping is needed.
- **Connection link rejected:** request expired, was already used, violates an optional pin, has a mismatched confirmation proof/browser, or returned without the same-browser cookie. Request a new link; do not reuse callback URLs.
- **Resume connection after sign-in:** click **Continue securely in this browser**. A login return can temporarily withhold a stored Lax cookie; the same-site click retries without deleting it or bypassing authorization. If the cookie remains absent, open a fresh original DM link in the same browser and check cookie blocking/browser switching. `gws_oauth_browser_context_missing` logs only cookie/SSO presence booleans. A missing SSO identity needs ingress/Vouch investigation. Never share the link or cookie values.
- **Account access unavailable:** only the trusted OAuth refresh response's `invalid_grant` or a 401 identity probe starts reconnection. Permission 403, network/provider failure, malformed responses and CLI stderr do not authorize an automatic retry.
- **503 / exit 2:** check OAuth environment, exact public HTTPS origin, fixed scopes, encryption-key length, named-volume permissions, and UID/GID 1001 ownership.

An operator can probe a member's optional pin/connection status without triggering OAuth, reading profile email or revealing credentials:

```bash
# Replace U01234567 with the requesting Slack member ID; run on the deployment host.
docker compose exec -T remote-cli node -e 'fetch("http://127.0.0.1:3004/internal/google-workspace/diagnostics", {method:"POST", headers:{"content-type":"application/json","x-thor-internal-secret":process.env.THOR_INTERNAL_SECRET},body:JSON.stringify({slackUserId:"U01234567"})}).then(r=>r.json()).then(r=>console.log(JSON.stringify(r,null,2)))'
```

Tests cover PKCE/state/cookie ownership, replay, expiry, identity mismatch, encrypted storage, redirects, confirmed DM delivery, automatic Pi continuation/restart/deduplication, superseded turns, grant replacement, public credential-free discovery, blocked auth commands, child environment isolation and historic approval compatibility. Live Google verification remains an operator deployment step; no production OAuth credential belongs in tests, Slack messages, repository files or agent memory.

Real browser cookie regression (requires Chromium and `openssl`, uses only local HTTPS fixtures):

```bash
node --import ./packages/runner/node_modules/tsx/dist/loader.mjs scripts/test-gws-browser-cookie.mjs /path/to/chromium
```

Full ingress/browser regression (Linux Docker, Chromium and `openssl`; uses the shipped Nginx template and local fake SSO/Google providers, not live accounts):

```bash
node --import ./packages/runner/node_modules/tsx/dist/loader.mjs scripts/test-gws-ingress-browser.mjs /path/to/chromium
```

If the real browser still loses the invitation cookie while the local flow passes, try a fresh DM link in an incognito window. For diagnosis inspect Chrome DevTools → Network → the initial `/google-workspace/connect` response → Cookies for a blocked-cookie reason, and Application → Cookies for the presence of `thor_gws_connect_request`. Share only names/presence/reasons, never link or cookie values. The old browser profile, a browser switch or a deployment-specific proxy can differ from the isolated regression; local success does not establish live account readiness.
