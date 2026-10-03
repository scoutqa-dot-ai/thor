# Google Workspace CLI uses per-Slack-user OAuth behind remote-cli

## Decision

Keep the pinned upstream `gws` binary behind `remote-cli`, but do not delegate credential selection to upstream CLI state. A trusted broker resolves only the latest active Slack actor, maps that verified Slack ID to `google_workspace_email`, stores the user's refresh grant encrypted outside OpenCode, and injects one refreshed `GOOGLE_WORKSPACE_CLI_TOKEN` into a fresh private execution directory.

There is no global identity, service-account fallback, inherited gws credential cache, or agent-facing `gws auth`. GitHub, cron, missing, ended, superseded, and ambiguous actors fail closed.

Every command is stored privately and bound to a Slack approval by action ID and keyed HMAC-SHA-256 fingerprint. Only the same Slack user may approve. The private payload is consumed before dispatch so uncertain writes cannot be replayed from one approval. Audit records contain safe identity, operation, fingerprint, correlation, and outcome fields—not argv, document contents, OAuth parameters, tokens, or provider response bodies.

The broker owns private, expiring, single-use connection links; PKCE and OAuth state; same-browser nonce binding; exact callback routing; Vouch email comparison; verified Google userinfo comparison; token refresh; local disconnect; and encrypted grant storage. OpenCode receives only normal `gws` output.

Google Drive, Docs, and Sheets scopes are a fixed configuration allowlist. Google resource permissions and Workspace policy remain additional authorization layers; Neo does not rewrite supported API argv after blocking credential-management and local-filesystem command surfaces.

This supersedes both the initial read-only command allowlist and the later one-global-identity design. See [deployment and security guidance](../google-workspace.md) and the [per-user OAuth plan](../plan/2026092901_google-workspace-user-oauth.md).
