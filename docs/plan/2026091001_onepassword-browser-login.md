# 1Password-backed authenticated browser

## Goal

Use one dedicated 1Password vault as Neo's browser credential store. Neo can find a Login item matching an exact HTTPS website, request Slack approval to autofill it, optionally request approval-gated automated TOTP, and continue using a short-lived broker-owned browser without exposing the service-account token, username, password, TOTP secret/current code, cookies, browser storage, CDP, or arbitrary JavaScript to Slack, the model, OpenCode, repository files, command arguments, or logs.

Live verification requires an operator-created non-production Login item, a dedicated vault ID, confirmation that the service account has Read Items-only access to that vault, and service-scoped injection of `OP_SERVICE_ACCOUNT_TOKEN`.

## Architecture

```text
Slack -> gateway -> runner -> OpenCode (untrusted)
                              |
                              | mcp wrapper: website, safe item ID, opaque browser refs
                              v
                     remote-cli approval gate
                              |
                              | stdio + one-shot anonymous secret fd
                              v
       bwrap -> 1Password browser MCP -> 1Password SDK (one dedicated vault)
                                     -> broker-owned local Chromium
```

The MCP child and Chromium run inside the `remote-cli` trust boundary. `remote-cli` receives `OP_SERVICE_ACCOUNT_TOKEN`, transfers it through anonymous descriptor 3 into a private one-shot tmpfs file, and starts the broker with a credential-free environment. Broker startup consumes and unlinks the file before Chromium can start. Chromium receives a separate fixed environment.

The model can request credential-free discovery from an application URL and receive only an opaque login-plan ID, approved origins, and safe matching Login metadata. `browser_open_authenticated` is approval-gated. Its Slack card is enriched by `remote-cli` with the broker-resolved item title and application/credential/callback origins before the action is persisted. At click time, the broker consumes the plan, re-reads and revalidates the item, injects credentials only at the credential origin, accepts only the planned callback, and creates an opaque application-origin browser session bound to the originating Thor session.

Continued browser actions travel through the same trusted broker. No CDP endpoint or browser debugging handle crosses the boundary.

## Configuration

Configure the dedicated vault once:

```text
OP_SERVICE_ACCOUNT_TOKEN=<injected into remote-cli only>
ONEPASSWORD_BROWSER_VAULT_ID=<26-character dedicated vault ID>
```

`OP_SERVICE_ACCOUNT_TOKEN` must come from the deployment secret store. It must not be written to the repository `.env`, Slack, OpenCode configuration, browser environment, or command arguments.

Each usable item in the vault must be an active 1Password **Login** item with:

- exactly one HTTPS Website URL;
- standard `username` and concealed `password` fields;
- either no TOTP field or exactly one TOTP field used only when the approval explicitly enables automated TOTP;
- no additional website origin.

The broker treats the Website URL as the credential origin. Standard username/password forms and same-tab application → one credential origin → application OAuth/OIDC callbacks are detected without site-specific adapters. Ambiguous forms, arbitrary redirect chains, popup/multi-provider federation, unapproved MFA, and unusual flows fail closed.

## Public broker tools

- `find_login_items(url)` — prepares a credential-free login plan and returns its opaque ID, application/credential/callback origins, and matching item IDs/titles.
- `browser_open_authenticated(login_plan_id, item_id, automate_totp?)` — approval-gated and single-use; returns an opaque application-origin browser-session ID after successful autofill and, when explicitly enabled, one TOTP attempt.
- `browser_snapshot(browser_session_id)` — returns a bounded, sanitized accessibility snapshot and opaque element references.
- `browser_click(browser_session_id, snapshot_id, ref)` — clicks one element from the latest snapshot.
- `browser_type(browser_session_id, snapshot_id, ref, text)` — fills only ordinary non-secret text controls; never password, OTP, hidden, token, or payment controls.
- `browser_navigate(browser_session_id, url)` — navigates only within the authenticated session's exact HTTPS origin.
- `browser_close(browser_session_id)` — destroys the context and browser.

All tools receive a trusted `_thor_session_id` from `remote-cli`; it is not part of the public schema. A browser-session ID is unusable from another Thor session. Element references are valid only for the latest snapshot and are invalidated after every action.

## Phases

### Phase 1 — Vault-level credential discovery

- Replace per-item JSON policy with one parsed dedicated vault ID.
- List only active Login overviews from that vault and filter by exact HTTPS origin. Accept `ExactDomain` and `AnywhereOnWebsite` item settings, but never inherit 1Password's broader subdomain semantics.
- Return a safe projection containing item ID, title, and origin only.
- Revalidate the selected active overview, then re-read the item before credential use and validate vault, item, category, website, built-in credential fields, and the approved zero-or-one TOTP shape.
- Remove generic secret-reference resolution and all model/operator-supplied selectors.

Exit: configuring one vault supports multiple exact-origin Login items; malformed, mixed-origin, non-Login, archived, unapproved/multiple TOTP, ambiguous, and wrong-vault items fail closed without exposing values, notes, tags, or SDK causes.

### Phase 2 — Broker-owned authenticated browser sessions

- Replace one-shot login verification with a browser-session service that owns Chromium, context, page, credential redaction, refs, and cleanup.
- Detect standard login fields and submit controls semantically, requiring same-origin self-targeting POST forms with no unsafe submit override.
- Keep TLS verification enabled; block service workers, downloads, WebSockets, WebRTC, popups, and every request outside the exact approved origin.
- Confirm that the password form disappeared; if one TOTP field was explicitly approved and one semantic same-origin TOTP challenge appears, re-read a fresh SDK-computed code, inject it once, and confirm the challenge disappears before retaining the session.
- Clear credential fields after authentication when they remain attached.
- Permit at most one active browser per Thor session, cap global sessions, and close sessions after ten minutes of inactivity.

Exit: successful login returns only safe IDs and exact-origin metadata; credentials remain wrapped except at browser fill/output-redaction sinks; sessions close on explicit close, timeout, startup failure, process shutdown, and upstream termination.

### Phase 3 — Restricted continued-browser controls

- Produce bounded accessibility snapshots through an allowlisted sanitizer.
- Remove editable-control values, replace link targets with same-origin/blocked markers, redact known username/password substrings, and redact every decimal/numeric accessibility value in TOTP-authenticated sessions before returning snapshots.
- Return only opaque browser/snapshot IDs and the approved origin as browser location metadata; never return the current page URL or path.
- Require latest-snapshot IDs and opaque refs for click/type.
- Reject secret-bearing or payment form controls for type operations.
- Revalidate exact origin before and after every browser action.
- Sanitize credential-boundary worklogs so typed text, snapshots, full URLs, browser output, and upstream errors are never persisted.

Exit: no tool returns input values, cookies, storage, screenshots, page source, headers, CDP, selectors, or arbitrary script access; stale refs, wrong sessions, expired sessions, cross-origin navigation, popups, and disallowed inputs fail closed.

### Phase 4 — Approval integration, documentation, and verification

- Replace the old approval schema and proxy policy with `browser_open_authenticated`.
- Resolve safe matching metadata before posting the Slack approval card; bind the stored action to login-plan ID, item ID/title, complete origin chain, optional TOTP capability, and Thor session.
- Update Docker/Compose env surfaces, operator docs, and agent browser guidance.
- Run typechecks, tests, builds, formatting for changed files, dependency/source/config/artifact secret scans, Docker/bwrap/Chromium smoke tests, and Aikido scanning.
- Perform an opt-in non-production live login after the operator provisions the vault and token.

Exit: the Slack card displays only the trusted Login title/ID and complete origin chain; approval click creates a session usable only by the originating Thor session; local security/integration checks pass; revoking the service account blocks new login sessions.

### Phase 5 — Approval-bound delegated authentication origins

- Prepare each login in a credential-free browser before approval, starting from the requested application URL and allowing at most one discovered HTTPS credential origin.
- Parse an OAuth/OIDC `redirect_uri` only inside the broker, require it to return to the original application origin, and retain only the exact callback path in an opaque short-lived login plan.
- Discover Login items against the credential origin rather than assuming the application and credential origins are identical.
- Bind the Slack approval to the broker-issued login-plan ID, trusted item ID/title, application origin, credential origin, callback origin, and optional TOTP capability. The model cannot supply or alter those origins.
- Replay and revalidate the planned application → credential → callback transition after approval. Fill credentials only on the credential origin; require the callback to be observed and its query/fragment to be consumed before retaining a session restricted to the application origin.
- Fetch allowed responses without automatic redirect following. Reissue only validated top-level 301/302/303 transitions as isolated GET navigations; block 307/308 and resource redirects so credential-bearing request bodies cannot follow an unapproved redirect.
- Consume every browser-login approval before dispatch so uncertain credential submissions cannot be retried.
- Preserve the existing single-origin flow as the degenerate case where application, credential, and callback origins are identical.

Exit: standard same-tab OAuth/OIDC authorization-code redirects work without per-site Thor configuration; unexpected origins, extra redirect hops, unapproved callback paths, callback fragments, stale/foreign plans, and changed Login metadata fail closed without exposing full URLs or authorization parameters.

## Security invariants

- Only one configured vault is reachable, and the service account has Read Items-only access to it.
- The model cannot supply a vault ID, secret reference, selector, browser executable, success condition, credential value, or service-account token.
- The service-account token exists only in `remote-cli` memory/environment, anonymous fd 3, a short-lived private tmpfs file, and broker memory. It never enters broker/Chromium env, argv, Slack, worklogs, or repository files.
- Full item values are fetched only for the selected item at the approval-bound credential origin after a login action has been approved and its short-lived plan consumed.
- TOTP defaults to denied. Explicit automated-TOTP approval requires exactly one item field and one credential-origin self-targeting POST challenge; only a fresh code from a second item read after that challenge may be injected, and the approval is consumed before the single attempt. Popup/multi-provider federation, passkeys, recovery codes, push/SMS/email MFA, and human-entered MFA remain unsupported.
- Browser navigation follows only the approval-bound application → credential → callback transition. Credentials are submitted only to the exact credential origin; retained sessions and continued actions remain on the exact application origin. WebSockets, WebRTC, service workers, downloads, and popups are blocked.
- Browser state stays in broker memory and is short-lived, session-bound, and non-durable.
- Passwords, usernames, cookies, headers, storage, raw URLs with query/fragment, HTML, screenshots, SDK/browser causes, CDP endpoints, and arbitrary JavaScript are never returned or logged by the broker boundary.
- Snapshot output is an allowlisted accessibility projection. Editable values are removed, known credential substrings are redacted, and element refs expire after one action.
- `browser_open_authenticated` always uses the existing Slack approval workflow; denied or malformed requests never fetch credential-bearing item data or launch Chromium.

## Tests

- Vault-ID/token parsing and fixed token-file consumption.
- Exact HTTPS destination and website URL canonicalization.
- Active Login overview filtering, exact-origin matching, multiple-account selection, and safe metadata projection.
- Full item validation for vault/item/category/website/username/password and approval-bound zero-or-one TOTP invariants.
- Standard one-page and two-step semantic form detection, authentication confirmation, default MFA rejection, automated-TOTP challenge handling, and credential-field clearing.
- Same-origin request routing, popup/download/WebSocket/WebRTC blocking, and credential-free Chromium environment.
- Browser lifecycle, owner-session binding, global/session limits, inactivity cleanup, explicit close, and stale-ref invalidation.
- Snapshot allowlisting, input-value removal, credential substring redaction, URL sanitization, and output bounds.
- MCP public surface, hidden Thor context, strict argument parsing, safe errors, and absence of secret/cookie/storage/CDP tools.
- Approval preflight/title enrichment, Slack presentation, click-time revalidation, and idempotent approval handling.
- Worklog sanitization for every credential-browser tool.
- Credential-free same-origin and delegated-route discovery, plan owner/expiry/replay protection, exact callback enforcement, rejection of extra origins and callback mismatches, and application-only retained browsing.
- Representative credential/token strings do not appear in MCP responses, logs, generated artifacts, image history, or process environments.

## Acceptance criteria

- Neo can ask to open an HTTPS website, discover matching Login items from the dedicated vault, request approval, and continue in the broker-owned authenticated browser.
- Adding a standard Login item for another origin requires no Thor policy change or restart; only the dedicated vault remains configured.
- Multiple accounts for one origin are presented as safe choices and require an explicit item ID.
- No credential, token, cookie, storage value, browser handle, or arbitrary JavaScript capability crosses the trusted broker boundary.
- Any other vault, item, origin, unapproved redirect/callback, field shape, unapproved/ambiguous MFA or federation flow, browser owner, stale ref, or expired session is denied.
- Existing local changes are restored exactly. No push or PR is created.

## Decision log

| #   | Decision                                                                                                                              | Rationale                                                                                                                                                                                                                 | Rejected                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Host the broker behind `remote-cli`                                                                                                   | OpenCode is untrusted; direct wiring would expose credentials or bypass Thor approval/session policy.                                                                                                                     | Direct OpenCode MCP child                                                                        |
| 2   | Keep exact pins for `@1password/sdk` and Playwright                                                                                   | The SDK is pre-1.0 and browser protocol/runtime drift affects the security boundary.                                                                                                                                      | Floating dependency ranges; `op` CLI                                                             |
| 3   | Configure one dedicated vault ID, not per-site JSON policy                                                                            | Login items already own website and credential metadata; exact-origin matching removes restart/configuration work per website.                                                                                            | Item IDs, secret refs, selectors, and success paths in env                                       |
| 4   | Transfer the service-account token through one-shot fd 3                                                                              | Same-UID browser children can inspect process environments; fd-to-private-tmpfs consumption keeps the token out of broker/Chromium env and argv.                                                                          | Child env or argv token                                                                          |
| 5   | Use item overview listing for discovery and full item retrieval only after approval                                                   | Overviews support safe origin/title matching without loading field values; click-time retrieval revalidates authority before credential use.                                                                              | Vault enumeration output; full-item metadata discovery                                           |
| 6   | Use built-in `username` and `password` fields only                                                                                    | Standard Login fields are deterministic; accepting arbitrary secret refs or custom selectors would widen the secret-reading surface.                                                                                      | User/model-supplied references or selectors                                                      |
| 7   | Keep authenticated Chromium inside the broker                                                                                         | Handing CDP, cookies, or storage state to existing browser tooling would transfer the authenticated principal to the untrusted model boundary.                                                                            | CDP handoff; persistent profile; storage-state export                                            |
| 8   | Expose restricted ref-based controls with one active browser per Thor session                                                         | The user needs generic browser continuation; owner binding, exact-origin routing, stale-ref invalidation, bounded output, and inactivity cleanup contain the capability.                                                  | TestMu-specific MCP; unrestricted Playwright/CDP                                                 |
| 9   | Sanitize Playwright accessibility JSON before returning it                                                                            | Raw snapshots include text/password input values and full link URLs. An allowlisted projection can remove those fields and redact known credentials.                                                                      | Raw ARIA snapshot, DOM, HTML, screenshot                                                         |
| 10  | Enrich login approval cards with broker-resolved metadata                                                                             | The operator must approve a trusted item title and complete origin chain rather than model-authored labels or origins.                                                                                                    | Model-supplied title/origins; item ID-only card                                                  |
| 11  | Consume browser-login approval before dispatch and keep browser sessions ephemeral                                                    | A credential submission can succeed even if transport acknowledgement fails, so retries are unsafe; browser state also cannot survive process loss and expires quickly.                                                   | Retryable browser-open approval; durable browser profiles/session recovery                       |
| 12  | Permit only explicitly approved single-field automated TOTP; fail closed on other MFA, federation, ambiguous forms, and unusual flows | A fresh SDK-computed code can remain inside the broker, while explicit approval, credential-origin POST validation, and one attempt bound the weakened factor-separation tradeoff.                                        | Implicit/multiple TOTP, human codes in Slack, popup federation, heuristic retries across origins |
| 13  | Discover delegated authentication origins in a credential-free browser, then freeze them in an opaque approval-bound login plan       | OAuth/OIDC commonly separates the relying-party and credential origins. Dynamic discovery removes per-site configuration while Slack approval and broker replay prevent model-authored or post-approval origin expansion. | Global cross-origin allowlists; per-site MCP servers; model-supplied auth/callback origins       |
| 14  | Support only same-tab application → one credential origin → exact application callback flows                                          | A bounded state machine is reviewable and keeps credentials on one origin. Popup, federation chains, and arbitrary redirect graphs create authority and first-request races that need separate designs.                   | Arbitrary redirect following; popup OAuth; multi-IdP federation chains                           |

## Out of scope

- Production-account rollout before non-production verification.
- Recovery codes, passkeys, push/SMS/email MFA, human-entered TOTP, split-code inputs, repeated automated-TOTP attempts, popup OAuth, or multi-provider federation chains.
- Generic 1Password vault/item/secret read, write, share, delete, or archive operations.
- Cross-origin continued browsing, arbitrary JavaScript, arbitrary selectors, screenshots, page source, headers, cookies/storage, downloads, tracing, recording, or CDP access.
- Persistent browser profiles or recovery of sessions after broker/process restart.
- Site-specific TestMu MCP tools.
