# 1Password authenticated browser

Thor uses one dedicated 1Password vault as Neo's browser credential store. Neo can find a Login matching an HTTPS website, ask for Slack approval, autofill it inside a broker-owned Chromium process, and continue through restricted browser controls.

The service-account token, username, password, TOTP secret/current code, cookies, browser storage, and browser debugging connection are never returned to Neo or Slack. The website's normal visible content is returned in sanitized accessibility snapshots, so request only data the Slack task is authorized to access.

## Trust boundary

The broker is a sandboxed stdio MCP child of `remote-cli`. It is intentionally **not** configured in OpenCode: OpenCode and its browser tools are untrusted and must not receive `OP_SERVICE_ACCOUNT_TOKEN`, cookies, storage state, or CDP access.

`remote-cli` transfers the token over anonymous descriptor 3. `bwrap` copies it to a private tmpfs file that broker startup consumes and unlinks before Chromium can start. The broker child receives no token in environment or argv, and Chromium receives a separate fixed credential-free environment.

Browser sessions:

- stay entirely inside the broker process;
- are bound to the Thor session that obtained approval;
- are limited to one active browser per Thor session and eight globally;
- expire after ten minutes of inactivity;
- are destroyed on explicit close, broker disconnect, or process shutdown.

## 1. Provision the dedicated vault

1. Create a user-created vault such as **Neo Browser Logins**. Do not use Personal, Private, Employee, or a general Shared vault.
2. Create a 1Password service account with **Read Items only** access to that vault. Grant no write/share/delete permission and no access to other vaults.
3. Add a standard **Login** item for each non-production website Neo may use.
4. For each Login item:
   - keep exactly one Website URL;
   - use HTTPS and omit query parameters and fragments;
   - prefer **Only on this exact domain**; **Fill anywhere on this website** is also accepted, but Thor still matches only the Website URL's exact origin;
   - use the built-in `username` field and built-in concealed `password` field;
   - optionally add exactly one 1Password one-time-password field for approval-gated automated TOTP; do not add recovery codes, another MFA field, or another website.
5. Record the 26-character vault ID and the owner/rotation procedure for the service account.

The Website URL is the login entry point. The requested destination may use another path on the same exact origin. Standard one-page and username-then-password forms are detected semantically; Thor does not accept selectors or secret references from the model.

Adding or changing a Login item in this vault does **not** require a Thor configuration change or restart. Changing the vault or service-account token does.

## 2. Configure the vault ID

Set the non-secret vault ID for `remote-cli`:

```bash
export ONEPASSWORD_BROWSER_VAULT_ID='<26-character-vault-id>'
```

Do not add a direct MCP entry to `docker/opencode/config/opencode.json`. The existing `mcp` wrapper reaches the broker through `remote-cli`, which owns approval and session binding.

## 3. Inject the service-account token

Inject `OP_SERVICE_ACCOUNT_TOKEN` into `remote-cli` only through the deployment secret store.

Do **not** put it in Git, Slack, OpenCode configuration, command arguments, a shared Compose `.env`, or the browser environment. For a local one-off test, read it without shell echo/history and export it only in the shell starting Compose:

```bash
read -rsp '1Password service-account token: ' OP_SERVICE_ACCOUNT_TOKEN
echo
export OP_SERVICE_ACCOUNT_TOKEN
docker compose up --build -d remote-cli opencode runner gateway
unset OP_SERVICE_ACCOUNT_TOKEN
```

`ONEPASSWORD_BROWSER_VAULT_ID` and `OP_SERVICE_ACCOUNT_TOKEN` must be set together. Leaving both unset disables the integration. Restart `remote-cli` after changing either value.

## 4. Use it through Neo

A normal Slack request can be phrased naturally:

> Open `https://accounts.example.com/dashboard`, use the matching Login from the Neo Browser Logins vault, and inspect the current report.

The agent-facing commands underneath that flow are:

### Find matching Login items

```bash
mcp onepassword-browser find_login_items \
  '{"url":"https://accounts.example.com/dashboard"}'
```

This reads active item overviews only and returns matching item IDs, titles, and the exact origin. It never returns fields, values, notes, tags, or Website paths. If multiple accounts match an origin, Neo must select the intended item ID from these safe choices.

### Request an authenticated browser

```bash
mcp onepassword-browser browser_open_authenticated \
  '{"item_id":"<matching-item-id>","url":"https://accounts.example.com/dashboard"}'
```

For a Login containing one TOTP field, request that additional capability explicitly:

```bash
mcp onepassword-browser browser_open_authenticated \
  '{"item_id":"<matching-item-id>","url":"https://accounts.example.com/dashboard","automate_totp":true}'
```

Before posting the Slack card, `remote-cli` asks the broker to resolve the selected item title for that exact origin. The model cannot supply the displayed title. The card explicitly shows whether automated TOTP is enabled. On **Approve**, the broker re-reads the item, verifies the approved title/item/origin and credential shape, fills the Login, and returns an opaque `browser_session_id`.

When `automate_totp` is true, the approved item must contain exactly one TOTP field. The broker submits username/password first, requires the password control to disappear, validates one semantic same-origin TOTP form, revalidates the active item, obtains a fresh SDK-computed 6–8 digit code, and injects it once. The code remains wrapped in broker memory solely to redact browser output until session cleanup. Omitting or setting `automate_totp` to false keeps TOTP items denied.

The 1Password full-item API returns all item fields together, so the approved initial credential read necessarily brings the TOTP field into broker memory. Thor first revalidates the active overview and does not use the initial code; after the challenge, it revalidates active status again and performs a second full read to minimize expiry risk. There is no field-level separation when password and TOTP share the item and service-account vault permission.

Automated TOTP places the password and TOTP generator behind the same service-account token. Use it only for dedicated low-privilege automation accounts; it is approval-gated automation, not an independent second factor against broker or token compromise.

The approval grants a ten-minute broker-owned interaction session on the displayed exact origin. Click **Reject** if either the Login title, item ID, or destination is unexpected.

### Inspect and interact

```bash
mcp onepassword-browser browser_snapshot \
  '{"browser_session_id":"<browser-session-id>"}'

mcp onepassword-browser browser_click \
  '{"browser_session_id":"<browser-session-id>","snapshot_id":"<snapshot-id>","ref":"<ref>"}'

mcp onepassword-browser browser_type \
  '{"browser_session_id":"<browser-session-id>","snapshot_id":"<snapshot-id>","ref":"<ref>","text":"report name"}'

mcp onepassword-browser browser_navigate \
  '{"browser_session_id":"<browser-session-id>","url":"https://accounts.example.com/reports"}'

mcp onepassword-browser browser_close \
  '{"browser_session_id":"<browser-session-id>"}'
```

Every click or type consumes the current snapshot refs. Take a new snapshot before the next ref action. Navigation accepts only HTTPS URLs without credentials, query parameters, or fragments and only on the authenticated browser's exact origin.

Browser action responses expose only the opaque session ID and approved origin, not the current page path, query, fragment, redirect URL, cookies, or storage.

`browser_type` accepts ordinary text/email/search/telephone/URL inputs. Password, passcode, OTP/MFA, secret/token, hidden, file, and payment fields are denied. It never echoes or logs typed text.

## Browser security behavior

For every approved open, the broker:

1. Lists safe Login overviews from only the configured vault and exact origin.
2. Revalidates the selected active overview and fetches the full item only after approval.
3. Revalidates vault, item ID, title, Login category, one allowed Website, built-in username/concealed password fields, and zero TOTP fields unless automated TOTP was explicitly approved, in which case exactly one is required. `ExactDomain` and `AnywhereOnWebsite` are accepted, but Thor independently enforces the Website URL's exact origin.
4. Launches headless Chromium with TLS verification enabled and a credential-free environment.
5. Blocks requests outside the exact origin, service workers, WebSockets, WebRTC/WebTransport, downloads, dialogs, and popups.
6. Fills wrapped credentials only at the final Playwright input operation.
7. For explicitly approved automated TOTP, accepts one semantic TOTP input owned by a same-origin self-targeting POST form, obtains a fresh bounded code only after the challenge appears, and attempts it once.
8. Rejects ambiguous forms, cross-origin redirects, unapproved/remaining MFA challenges, and unconfirmed login state.
9. Clears attached credential/TOTP fields before retaining the session and retains their wrapped values only for output redaction.
10. Rechecks the exact origin and absence of login/MFA fields before and after every continued action.

Raw Playwright accessibility output is never returned. Thor allowlists accessibility properties, removes all editable values, replaces link targets with same-origin/blocked markers, redacts known username/password substrings, bounds output size/depth, and issues short-lived opaque element refs. Sessions that used TOTP additionally redact all decimal text and numeric accessibility values so formatted or split code reflections cannot cross the boundary.

Thor exposes no tool for page HTML/source, arbitrary selectors, JavaScript evaluation, screenshots, tracing, console/network capture, headers, cookies, local/session storage, IndexedDB, downloads, profiles, or CDP.

## Unsupported flows

The broker fails closed for:

- SSO, passkeys, recovery codes, push/SMS/email MFA, TOTP without explicit approval, multiple TOTP fields, split-code inputs, and repeated TOTP attempts;
- cross-origin redirects or resources, including different subdomains;
- multiple Website entries, **Never fill on this website**, or Website URLs containing query/fragment data;
- forms with ambiguous controls, missing form ownership, non-POST submission, non-self targets, or unsafe submit overrides;
- unusual login flows that semantic detection cannot identify.

A future trusted site adapter may support a specific unusual login flow without widening the model-facing API. Do not solve these cases by exposing selectors, CDP, cookies, or arbitrary JavaScript.

## Audit and verification

Broker audit events contain only timestamp, action, outcome, configured vault ID, exact origin, safe item/browser IDs, Thor session ID, and a classified error code. Credential-browser worklogs discard item titles, typed text, snapshots, full URLs, upstream errors, and unexpected fields.

After a non-production test:

1. Confirm the Slack card showed the expected Login title/item ID and exact destination.
2. Confirm the authenticated browser could snapshot/interact and then close or expire.
3. Search service logs and `/workspace/worklog` for known token/credential canaries; there must be no match.
4. Check the 1Password service-account usage report for the selected item read.
5. Revoke the service account and verify a new open request fails.
6. Rotate/revoke the temporary website account after testing.

Local source/artifact checks:

```bash
git grep -nE 'ops_[A-Za-z0-9_=-]{20,}' -- ':!docs/onepassword-browser.md'
git diff --check
mise x node@24.11.1 -- corepack pnpm audit --prod
```

Live verification remains operator-gated because real vault/item details and the service-account token must never be committed or sent through Slack.
