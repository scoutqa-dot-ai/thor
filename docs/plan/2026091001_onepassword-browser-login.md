# 1Password-backed browser login

## Goal

Allow Neo to authenticate to one explicitly approved SaaS password login using credentials from one dedicated 1Password vault item, without exposing the service-account token, username, password, cookies, or browser storage to Slack, the model, OpenCode, repository files, command arguments, MCP responses, or logs.

The first deploy target is the temporary TestMu AI audit account. Live verification requires operator-provided vault/item IDs, secret references, exact login origin/URL/selectors, success condition, and a read-only 1Password service-account token.

## Architecture

```text
Slack -> gateway -> runner -> OpenCode (untrusted)
                              |
                              | mcp wrapper: item id + expected origin only
                              v
                     remote-cli approval gate
                              |
                              | stdio + one-shot anonymous secret fd
                              v
              bwrap -> 1Password browser MCP -> 1Password SDK
                                             -> local Chromium
```

The MCP child and Chromium run in the `remote-cli` trust boundary. `remote-cli` receives `OP_SERVICE_ACCOUNT_TOKEN`, then transfers it through an anonymous descriptor into a private one-shot tmpfs file that broker startup consumes and unlinks. The child environment contains only non-secret dedicated configuration, and Chromium receives a separate fixed environment. OpenCode receives only metadata and redacted outcomes. `browser_login` uses the existing Slack approval pipeline and re-resolves the configured upstream when approval is clicked.

## Configuration

`OP_SERVICE_ACCOUNT_TOKEN` is injected into the `remote-cli` service only by the deployment secret store. It must not be written to the repository `.env`: Compose uses that file for other services too.

Non-secret login policy is supplied through `ONEPASSWORD_BROWSER_CONFIG` as JSON:

```json
{
  "vault_id": "<dedicated-vault-id>",
  "item_id": "<approved-item-id>",
  "origin": "https://accounts.lambdatest.com",
  "login_url": "https://accounts.lambdatest.com/login",
  "username_ref": "op://<vault-id>/<item-id>/username",
  "password_ref": "op://<vault-id>/<item-id>/password",
  "selectors": {
    "username": "input[name=email]",
    "password": "input[name=password]",
    "submit": "button[type=submit]"
  },
  "success_path_prefix": "/dashboard"
}
```

An optional `selectors.username_submit` supports a same-origin two-step password flow. The broker accepts HTTPS only, exact canonical origins, 1Password IDs, references that resolve to the configured vault/item, non-empty selectors, and a bounded timeout.

## Phases

### Phase 1 — Metadata-only trusted connector

- Add `@thor/onepassword-browser-mcp`, with exact `@1password/sdk` pin and a local stdio MCP entrypoint.
- Parse environment configuration once at startup into constrained values.
- Add a 1Password adapter that translates SDK failures into safe typed outcomes.
- Expose only `get_login_metadata(item_id)`. Return title, approved origin, and field names/types; never values, notes, tags, service-account details, or unapproved websites.
- Register the upstream through `remote-cli`; do not configure it directly in OpenCode.
- Run the child in `bwrap` with a scrubbed explicit environment and no workspace, GitHub-key, or remote-cli state mounts.

Exit: the connector is unavailable when either configuration leg is absent; exact vault/item/reference/origin checks pass; metadata contains no item values; other 1Password tools do not exist.

### Phase 2 — Approved local browser injection

- Install local Chromium in the `remote-cli` image and use exact-pinned `playwright-core` from the broker.
- Add `browser_login(item_id, expected_origin)` to the approval tier.
- Resolve username/password only after approval, wrap them as redacted values, and unwrap only at `locator.fill`.
- Use a fresh non-persistent browser context with TLS verification enabled, service workers blocked, downloads disabled, no screenshots/traces/video, and request routing restricted to the approved exact origin.
- Revalidate origin immediately before username fill, password fill, and submit. Close the context/browser on every outcome.
- Return only authenticated/denied/error state plus vault/item/origin identifiers. MFA, SSO, cross-origin redirects, and missing or ambiguous fields fail closed.

Exit: approval card contains only item/origin; denied or malformed requests never read 1Password or launch Chromium; successful login output contains no credentials/cookies/storage; browser state is destroyed after verification.

### Phase 3 — Rollout and live verification

- Document dedicated-vault, read-only service-account, token injection, TestMu policy config, usage-report, rotation, and revocation steps.
- Add an opt-in live integration procedure using a temporary test item and non-production account.
- Run dependency/source/config/artifact secret scans and verify 1Password usage reporting.
- Add site-specific read-only audit tools in a follow-up once TestMu's allowed observations/actions are specified. Do not expose generic browser navigation, DOM scripting, cookie/storage access, or arbitrary clicks.

Exit: unit/in-process integration tests pass; the operator confirms a non-production login and no secret in process output/worklogs; revoking the service account prevents another approved login.

## Security invariants

- Exactly one configured vault, item, and HTTPS origin are reachable; the item cannot contain another website origin or a TOTP field.
- The model cannot supply a vault ID, secret reference, selector, login URL, success condition, or browser executable.
- The service-account token exists in `remote-cli` environment/memory, an anonymous descriptor and short-lived private tmpfs file, then broker memory; it never enters broker/Chromium environment or argv.
- 1Password values, raw SDK/browser causes, cookies, headers, page HTML, and browser storage are never logged or returned.
- `browser_login` always requires the existing Slack approval gate; metadata is read-only.
- Browser requests outside the configured origin are aborted, including redirects.
- MFA and SSO remain human-controlled and unsupported by this non-interactive password phase.

## Tests

- Configuration/reference/ID/HTTPS-origin/success-path parsing and canonicalization.
- Exact item/origin authorization before dependency calls.
- Metadata projection excludes values, notes, tags, and unapproved URLs.
- Missing token/config, malformed IDs, wrong item/origin, wrong category/site/field types, SDK failures, redirects, and browser failures return safe fail-closed results.
- Redacted values cannot reveal secrets through stringification or JSON serialization.
- MCP public surface lists only the two tools; `browser_login` is approval-gated.
- Proxy child receives the token through anonymous fd 3 and consumes/unlinks its private tmpfs file before MCP startup; broker and Chromium environments contain no token.
- Approval presentation shows only item ID and origin.
- Representative credential/token strings do not appear in MCP output, worklog payloads, or broker diagnostics.

## Acceptance criteria

- Neo can request metadata for only the approved TestMu item.
- Neo can request login only for the approved item/origin, and execution occurs only after Slack approval.
- Neither model/Slack output nor logs expose the service-account token, username, password, cookies, authorization headers, or browser storage.
- Any other vault, item, reference, origin, redirect, field shape, or auth mode is denied.
- No generic secret read, vault/item enumeration, arbitrary reference resolution, write/share/delete, browser scripting, cookie/storage, or destructive UI tool is exposed.
- 1Password usage reporting identifies access to the configured item; revocation blocks subsequent access.

## Decision log

| #   | Decision                                                                                  | Rationale                                                                                                                                                                                                                                   | Rejected                                                |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Host the stdio MCP child behind `remote-cli`, not directly in `opencode.json`/`.mcp.json` | OpenCode is explicitly untrusted; direct local configuration would either expose the token or bypass Thor's server-side approval/policy boundary. The existing `mcp` wrapper already provides discovery and session-bound approval routing. | Direct OpenCode MCP child                               |
| 2   | Use `@1password/sdk` `0.5.0` and `playwright-core` `1.63.0` as exact pins                 | The 1Password SDK is pre-1.0; browser protocol/runtime drift affects the security boundary.                                                                                                                                                 | Floating ranges / `op` CLI                              |
| 3   | Keep policy in one non-secret JSON env and the token in a service-only env injection      | Selectors and IDs must be operator-controlled but are not secrets; the token must not enter shared Compose `env_file` consumers.                                                                                                            | Slack args, repository config containing secrets, argv  |
| 4   | Put `browser_login` in the existing MCP approval tier                                     | Reuses persisted action binding, Slack cards, click-time re-resolution, and audit behavior rather than inventing a second approval system.                                                                                                  | Broker-internal yes/no flag                             |
| 5   | Use an ephemeral context and close after success verification                             | No generic post-login browser surface is safe enough yet; retaining a CDP/session handle would let untrusted callers reach cookies/storage or mutating UI.                                                                                  | Returning CDP URL/storage state; cloud sandbox transfer |
| 6   | Phase 3 read-only auditing needs site-specific tools                                      | `browser_login` alone cannot safely support an audit, while generic navigation/click/DOM tools cannot prove read-only behavior. TestMu's allowed observations must be specified before adding them.                                         | Generic authenticated browser control                   |
| 7   | Override vulnerable MCP/Express/Daytona transitives to patched versions                   | The production dependency scan found findings in schema validation, HTTP parsing, telemetry, and Daytona command parsing; API-compatible workspace overrides make the production audit clean without widening the broker surface.           | Shipping with known dependency findings                 |
| 8   | Transfer the token from `remote-cli` over a one-shot anonymous descriptor                 | A browser child can inspect same-UID process environments through container procfs. FD 3 plus consume-and-unlink tmpfs delivery keeps the token out of bwrap, broker, and Chromium environments and argv while preserving stdio for MCP.    | Passing the token in child env or argv                  |

## Out of scope

- Production accounts.
- SSO, TOTP, recovery codes, passkeys, or automated MFA.
- Generic 1Password read/list/write/share/delete tools.
- Persistent browser profiles, CDP exposure, storage-state export, cloud sandbox credentials.
- Generic authenticated browsing or claims that arbitrary UI actions are read-only.
