# 1Password browser login

Thor can inject one approved 1Password login into a local ephemeral Chromium session without returning the service-account token, username, password, cookies, or browser storage to Neo.

This integration supports direct username/password login on one exact HTTPS origin. SSO, passkeys, TOTP/recovery codes, cross-origin login redirects, persistent sessions, and generic authenticated browsing are not supported.

## Trust boundary

The broker is a sandboxed stdio MCP child of `remote-cli`. It is intentionally **not** configured directly in OpenCode: OpenCode is untrusted and must not receive `OP_SERVICE_ACCOUNT_TOKEN` or a browser debugging/session handle.

`remote-cli` transfers the token to the sandbox through a one-shot anonymous file descriptor, not child environment or argv. `bwrap` copies it into a private tmpfs file that broker startup reads and unlinks before accepting MCP requests. Chromium receives a separate fixed environment containing no broker token or policy.

The agent-facing surface is:

```text
mcp onepassword-browser get_login_metadata '{"item_id":"<item-id>"}'
mcp onepassword-browser browser_login '{"item_id":"<item-id>","expected_origin":"https://accounts.lambdatest.com"}'
```

`get_login_metadata` is read-only and returns only item title, approved origin, and field names/types. `browser_login` creates a Slack approval card. Credential retrieval and browser launch happen only after a human approves it.

## 1. Provision a dedicated vault and account

1. Create a user-created vault such as **Neo SaaS Audit**. Do not use Personal, Private, Employee, or default Shared vaults.
2. Create a 1Password service account with **Read Items only** for that vault. Do not grant write, share, vault-create, or unrelated vault access.
3. Store only the temporary non-production TestMu AI audit login in that vault.
4. Give the Login item a website whose origin exactly matches the configured origin.
5. Keep MFA human-controlled. Do not store TOTP or recovery codes for this integration.
6. Record the vault ID, item ID, username/password field IDs, and service-account rotation/expiry owner.

The broker rejects items whose returned vault/item/category/website/field types do not match policy, any item with another website origin, and any item containing a TOTP field. The password field must be `Concealed`; the username field must be text or email.

## 2. Configure the non-secret login policy

Set `ONEPASSWORD_BROWSER_CONFIG` for `remote-cli`. It contains IDs, secret references, URLs, selectors, and success detection but no credential values:

```json
{
  "vault_id": "<26-character-vault-id>",
  "item_id": "<26-character-item-id>",
  "origin": "https://accounts.lambdatest.com",
  "login_url": "https://accounts.lambdatest.com/login",
  "username_ref": "op://<vault-id>/<item-id>/username",
  "password_ref": "op://<vault-id>/<item-id>/password",
  "selectors": {
    "username": "input[name=email]",
    "password": "input[name=password]",
    "submit": "button[type=submit]"
  },
  "success_path_prefix": "/dashboard",
  "timeout_ms": 30000
}
```

For a two-page same-origin flow, add `selectors.username_submit`. Every configured URL and every runtime navigation must remain on `origin`. `success_path_prefix` is path-segment aware: `/dashboard` matches `/dashboard` and `/dashboard/...`, not `/dashboard-other`.

Selectors are operator-controlled. They are never accepted from MCP arguments or Slack.

## 3. Inject the service-account token

Inject `OP_SERVICE_ACCOUNT_TOKEN` into the `remote-cli` service only through the deployment secret store.

Do **not** put it in Git, Slack, `opencode.json`, command arguments, `ONEPASSWORD_BROWSER_CONFIG`, or the repository `.env`. Thor's Compose file explicitly blanks this variable in other services as defense-in-depth, but the token should still originate from a service-scoped secret injection.

For a local one-off deployment, export it in the shell that starts Compose rather than writing it to `.env`:

```bash
export OP_SERVICE_ACCOUNT_TOKEN='<retrieve from approved secret store>'
docker compose up --build -d remote-cli opencode runner gateway
unset OP_SERVICE_ACCOUNT_TOKEN
```

Restart `remote-cli` after changing the token or policy. OpenCode does not need a direct MCP config change; its existing `mcp` wrapper discovers the integration through `remote-cli`.

## 4. Browser behavior

For every approved login, the broker:

1. Revalidates the item ID and exact canonical HTTPS origin.
2. Fetches the configured item and verifies vault, item, Login category, website origin, and expected fields.
3. Resolves only the configured username and password references.
4. Consumes and deletes the one-shot token file before browser launch.
5. Launches local headless Chromium with a minimal credential-free environment in a fresh, non-persistent context.
6. Blocks service workers, WebSockets, WebRTC, downloads, and HTTP(S) requests outside the exact approved origin.
7. Rechecks page origin immediately before username fill, password fill, and submit.
8. Requires the configured same-origin success path.
9. Closes the browser context and process on every result.

The broker never enables tracing, screenshots, video, console collection, network capture, profile persistence, or CDP access.

## 5. Audit and verification

Thor's MCP/approval worklog records the requesting session, approval action/reviewer, item ID, origin, action, and outcome. The broker emits only a safe structured audit event containing timestamp, session ID, vault/item IDs, origin, action, outcome, and error code.

After a test:

1. Confirm the approved login succeeded and the output contains only `status`, vault/item IDs, and origin.
2. Search service logs and `/workspace/worklog` for known credential canaries; there must be no match.
3. Check the 1Password service-account usage report for access to the configured item.
4. Revoke the service account and verify another approved request fails.
5. Rotate/revoke the temporary SaaS account after the audit.

Example local source/artifact checks:

```bash
git grep -nE 'ops_[A-Za-z0-9_=-]{20,}' -- ':!docs/onepassword-browser.md'
git diff --check
pnpm audit --prod
```

## 6. Live-test prerequisites

A live TestMu test requires:

- dedicated vault ID and item ID/reference paths, never field values;
- confirmation that the service account has Read Items only;
- service-scoped injection of `OP_SERVICE_ACCOUNT_TOKEN`;
- exact login origin, login URL, selectors, success path, and confirmation that login is a direct password flow;
- a temporary non-production account with no automated MFA secret.

Site-specific read-only audit actions require a separate allowlisted tool design. Do not expose generic click, evaluate, cookie/storage, CDP, or arbitrary navigation tools to reuse the authenticated context.
