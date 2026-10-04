# Security Model

How Neo contains untrusted input through layered controls. For integration-specific details, see [`slack.md`](../slack.md), [`github.md`](../github.md), and [`daytona.md`](../daytona.md).

## Threat model

Three things are assumed untrusted:

- **The agent.** OpenCode runs LLM-driven code; prompt-injection-shaped outputs and unintended tool calls are expected.
- **OpenCode-side wrappers.** Skill scripts and CLI shims inside the OpenCode container are reachable by the agent and can be coerced. They are convenience, not enforcement.
- **External webhook senders.** Inbound HTTP requests are hostile until a signature proves otherwise.

The Docker network carries trusted services and the untrusted OpenCode runtime. Internal services authenticate or constrain OpenCode at their own boundary; external callers must authenticate at ingress.

## Layer 1: Network boundary

- **Ingress + Vouch.** `ingress` terminates TLS and delegates auth to Vouch. Vouch admits Google-authenticated users whose email domain matches `VOUCH_ALLOWED_EMAIL_DOMAINS`. The OpenCode SPA root and `/admin/` additionally require membership in `THOR_ADMIN_EMAILS`; `/runner/` viewer routes remain open to any allowed-domain user. Static OpenCode assets bypass Vouch for performance.
- **Egress through mitmproxy.** External HTTP(S) initiated by OpenCode and codex-lb traverses mitmproxy. OpenCode's internal model request to codex-lb is explicitly bypassed; codex-lb then reaches ChatGPT through the proxy. See Layer 1a for the routing path, built-in defaults, and custom rule format.
- **Credentialed browser isolation.** The 1Password browser MCP runs as a `remote-cli`-owned stdio child inside `bwrap`; its local Chromium and service-account token are not present in OpenCode or Daytona. The child has no workspace or remote-cli state mounts. See [`../onepassword-browser.md`](../onepassword-browser.md).
- **Google Workspace user-grant isolation.** `remote-cli` binds encrypted refresh grants to verified Slack users, requires the same user to approve each exact command fingerprint, and injects only a refreshed short-lived access token into a fresh `gws` child. Agent-authored session headers cannot execute with a grant without the out-of-band owner approval; there is no global fallback. See [`../google-workspace.md`](../google-workspace.md).
- **Model credential isolation.** codex-lb owns the pooled ChatGPT/Codex OAuth tokens and routes model requests. OpenCode receives only the non-secret `codex-lb-local` placeholder accepted from private Docker CIDRs; it receives no subscription token. See [`../codex-lb.md`](../codex-lb.md).
- **Host port hardening.** `remote-cli` and codex-lb's direct dashboard/API and OAuth callback ports bind to host loopback. Office dashboard access goes through the Vouch/admin-email-protected ingress on port 8080.

## Layer 1a: Outbound proxy (mitmproxy)

Neo's outbound HTTP(S) routing for operator-invoked clients is explicit:

```text
opencode -> HTTP(S)_PROXY -> mitmproxy -> upstream
```

- `opencode` sets both lowercase and uppercase proxy env vars (`http_proxy`, `https_proxy`, `HTTP_PROXY`, `HTTPS_PROXY`, with matching `NO_PROXY` forms).
- Supported outbound clients in this workflow are `curl` and built-in `fetch()`.
- This is env-proxy routing, not transparent interception or firewall-style egress enforcement.
- The mitmproxy CA private key stays on the host (initialized once via `./scripts/mitmproxy-ca-init.sh`); only the public trust bundle is exposed inside `opencode`.

### Built-in defaults

Built-in defaults are intentionally narrow:

- Atlassian: injected auth for `api.atlassian.com` and `*.atlassian.net`, read-only by default. Jira attachment uploads (`POST .../rest/api/3/issue/{key}/attachments` on `*.atlassian.net`, and `POST .../ex/jira/{cloudId}/rest/api/3/issue/{key}/attachments` on `api.atlassian.com`) are allowed as a POST-only narrow write exception.
- Atlassian media redirects: `api.media.atlassian.com` passthrough.
- Slack API: injected auth only for thread/history reads, `reactions.add`, `files.info`, and the upload setup/complete endpoints on `slack.com/api/...`; message writes must use `slack-post-message`.
- Slack files: read-only downloads on `files.slack.com/files-pri/...` and upload flow support on `files.slack.com/upload/v1/...`.
- OpenAI and ChatGPT domains: passthrough only (no injected credentials). codex-lb uses this path and trusts the mounted mitmproxy public CA.

OpenCode's configured model provider does not use those public passthroughs: it
connects directly to `http://codex-lb:2455`, which is listed in `NO_PROXY`.
codex-lb then makes its upstream ChatGPT connection through mitmproxy; the
public OpenAI/ChatGPT rules are also available for ordinary agent-initiated
HTTP reads.

Bundled upstream defaults/policy remain in [`packages/common/src/proxies.ts`](../../packages/common/src/proxies.ts).
The separate [operator MCP catalog](../mcp-catalog.md) adds complete HTTP
definitions through broker-private files; it does not reuse mitmproxy environment
interpolation or agent-controlled URLs/headers. Generic approvals use versioned,
server-qualified frozen proof, trusted requester-only Slack DM review and a
broker-lifetime kernel owner fence. Their new `mcp-approval-state` volume is mounted
only in remote-cli at `/var/lib/remote-cli/mcp-approvals` (0700 directories / 0600
files), including stable action lock inodes and atomically flushed replacements.
Every activation invalidates pending generic authority; consumed records lacking
confirmed results are uncertain, never retryable. Private read/result/continuation
edges authenticate host/gateway readers and check stored requester/team/repo/source.
Legacy CLI attribution grants no generic reader/reviewer authority or raw fallback.
These protections do not retroactively make `/workspace/data/approvals` private,
encrypt/erase native history, or establish provider exactly-once execution.

### Custom rules

Custom credential rules and passthrough hosts live in `/workspace/config/thor.json` under `mitmproxy[]` and `mitmproxy_passthrough[]`. Keep secrets in `.env` only and reference them in config via `${ENV_VAR}`. Rules can match either an exact `host` or a `host_suffix`, and can optionally add `path_prefix` and/or `path_suffix` when one domain needs different headers by URL prefix or suffix.

```json
{
  "mitmproxy": [
    {
      "host": "billing.example.com",
      "path_prefix": "/v1/",
      "headers": { "X-Custom-Auth": "${BILLING_API_KEY}" }
    },
    {
      "host_suffix": ".internal.example",
      "headers": { "Authorization": "Bearer ${INTERNAL_API_TOKEN}" },
      "readonly": true
    }
  ],
  "mitmproxy_passthrough": ["api.openai.com", ".anthropic.com"]
}
```

mitmproxy evaluates user rules first, then built-in defaults. Rules match by exact host or suffix first, then by optional `path_prefix` and `path_suffix`.

## Layer 2: Inbound authentication

Every external request that reaches the gateway must prove origin before any work happens.

| Source                             | Mechanism                                                                | Window |
| ---------------------------------- | ------------------------------------------------------------------------ | ------ |
| Slack events / interactivity       | `X-Slack-Signature` HMAC-SHA256 over `v0:<ts>:<raw-body>`                | 300s   |
| GitHub webhooks                    | `X-Hub-Signature-256` HMAC over raw body, secret `GITHUB_WEBHOOK_SECRET` | n/a    |
| Internal gateway↔remote-cli routes | `x-thor-internal-secret: $THOR_INTERNAL_SECRET`                          | n/a    |

`THOR_INTERNAL_SECRET` authorizes trusted internal operations — approval resolution
(`POST /exec/mcp`) and typed git/gh workspace repair through `POST /internal/exec`.
Internal exec does not accept arbitrary binaries, shells or leading global options;
its children use the same filesystem/proc/environment sandbox as broker CLI tools.
Agents never receive this secret. Treat it as a privileged service credential.

## Layer 3: Authorization gating

After authentication, events still face content-aware gates before they wake the agent:

- **Slack private-channel allowlist** — public non-shared channels admit by default; private channels, DMs, group DMs, and Slack Connect channels must appear in `slack.private_channel_allowlist` in `thor.json`. Fail-closed on lookup error. See `slack.md` §5.
- **GitHub mention-required for first contact** — pure issue comments require `@${GITHUB_APP_SLUG}`. Once a session exists for the issue, later follow-ups can wake without a mention. See `github.md` §4.
- **Self-loop guards** — events whose sender matches `SLACK_BOT_USER_ID` or `GITHUB_APP_BOT_ID` are dropped. Without these, every Neo-authored reply would re-trigger Neo.
- **CI wake gate.** `check_suite.completed` only wakes Neo when the head commit's author email matches the derived GitHub App bot email and an alias-backed session for that branch already exists. See `github.md` §4a.

## Layer 4: Server-side policy at remote-cli

remote-cli is the _only_ place tool-level policy is enforced. OpenCode-side wrappers (skill scripts, CLI shims) are not trusted to filter their own arguments.

### MCP tool tiers

- **Allow-listed tools** execute immediately.
- **Approved tools** create an approval record, post an approval card to the triggering Slack thread, and return an action id. Status is available through `POST /exec/approval`.
- **Hidden tools** are never listed to the agent.

Approval creation **fails closed** when remote-cli cannot resolve or post to the triggering Slack thread. No usable pending approval is created without the operator-visible card.

### Command policy

`git`, `gh`, `langfuse`, `metabase`, `ldcli`, and `scoutqa` go through remote-cli `POST /exec/*` endpoints with server-side allowlists per command. The OpenCode-side wrappers are convenience — bypassing them by calling raw binaries inside OpenCode does not exist as a path because credentials live in remote-cli.

### Credential handling

Custom MCP bearer files/catalog directories are remote-cli-only immutable startup
snapshots. Enabled credential failures stop startup; offline servers are isolated.
Endpoint-pinned SDK HTTP refuses redirects for initialization/call/SSE/session
teardown and never performs OAuth/resource discovery. Broker children have no
catalog/MCP-secret/private OAuth mounts or parent procfs and receive only their
own integration environment. Shared file readers pin and check the opened inode.
See [the operator security/activation contract](../mcp-catalog.md#child-and-container-boundary),
including the broker-only rootless-proc Docker setting and dedicated legacy
GitHub adapter grant. These controls are not a claim that unauthenticated internal
services are unreachable directly from every runtime.

- `git` uses GitHub App installation tokens minted on demand through `GIT_ASKPASS` when the target owner resolves from the command or repo remote.
- `gh` resolves GitHub App auth before execution and exports `GH_TOKEN` only with the short-lived installation token for the resolved owner.
- OpenCode never receives direct API credentials for MCP upstreams.
- **Model credentials are brokered separately.** OpenCode holds only the non-secret `codex-lb-local` placeholder. codex-lb admits it by source CIDR on the private network and retains subscription OAuth tokens in `codex-lb-data`. Direct OpenAI credentials must be removed from OpenCode's persistent `auth.json` after migration. The dashboard's application auth is disabled in this topology; Vouch and `THOR_ADMIN_EMAILS` protect its office-facing ingress route, while direct port 2455 remains host-loopback-only.

This copied topology does not isolate codex-lb's dashboard API from OpenCode on
the shared Docker network: dashboard application auth is disabled so the
ingress can own browser auth, while OpenCode must reach the same port for model
requests. Treat that as an explicit trust-boundary limitation, not as protection
from a compromised agent. Pi's override places its executor on a separate
internal network without codex-lb, while the trusted runner retains model access.

- **1Password browser credentials stay in the broker.** `OP_SERVICE_ACCOUNT_TOKEN` exists only in `remote-cli`; a dedicated stdio transport sends it to the sandbox over anonymous fd 3, where broker startup consumes and unlinks a private tmpfs file before accepting MCP requests. The broker lists only safe exact-origin Login metadata from one dedicated vault and reads credential-bearing fields only after Slack approval. If the approval explicitly enables automated TOTP, the broker re-reads one fresh SDK-computed code only after validating one same-origin MFA challenge and attempts it once. Authenticated Chromium remains broker-owned, credential-free in its process environment, exact-origin, Neo-session-bound, ref-controlled, and limited by a ten-minute inactivity lease. No credential, TOTP secret/code, cookie/storage value, full browser handle, or raw Playwright snapshot crosses the boundary.

## Layer 5: Blast radius limits

If a policy layer fails, these limit what damage is reachable:

- **Read-only repo mounts.** `/workspace/repos` is read-only inside OpenCode. Writes go to `/workspace/worktrees`.
- **GitHub App scopes.** The app is granted the minimum permissions listed in `github.md` §3 — no admin, no settings write, no org-wide access.
- **Per-owner installation tokens.** GitHub installation tokens are scoped to a single owner and expire within an hour.
- **Daytona sandbox isolation.** Project builds and test runs execute in per-worktree Daytona sandboxes; `git` is blocked inside the sandbox so the agent cannot push from there.
- **Credential broker allowlist.** The 1Password integration reaches one configured dedicated vault. A credential-free browser may discover one application → credential → exact application callback route and freeze it in an owner-bound, short-lived approval plan. Credentials are injected only at the approved credential origin; after callback, continued access is restricted to the application origin and sanitized accessibility snapshots, latest-snapshot click/type refs, same-origin navigation, and close. It exposes no generic vault/secret reads, redirect parameters, arbitrary references/selectors/JavaScript, cross-origin continued browsing, persistent profile, CDP, cookie/storage, screenshot, trace, or download surface.
- **Model pool scope.** codex-lb dashboard policy controls eligible accounts and models. Fresh sessions may fail over; account-bound continuation state fails closed when its owning account is unavailable. The persistent `codex-lb-data` volume contains OAuth tokens, the default encryption key, configuration, and request metadata and is handled as secret state.

## Layer 6: Audit trail

- `/workspace/worklog` — structured tool-call records, accept/ignore decisions, and gate reasons.
- `/workspace/data/approvals` — persisted approval records.
- Gateway worklog entries (`github-webhook-ignored`, `slack_event_ignored`, etc.) carry `reason` + `metadata` fields explaining each drop.

## Deferred to infrastructure

- **Rate limiting / DDoS protection.** Application code does not implement Express rate limiters. Enforcement is expected at the ingress / WAF layer. See `AGENTS.md` §8.
- **OpenCode harness boundaries.** Neo-side wrappers do not re-enforce timeouts, output caps, or transformations already handled by the OpenCode harness. See `AGENTS.md` §9.

## Opt-in Pi execution boundary

In [Pi mode](../pi-runtime.md), runner owns Durable conversations and private SQLite state; tools execute only through the credential-free `pi-executor` container. Its filesystem mounts preserve read-only repos/config and writable worktrees/memory. It has no runner private-state mount, credential env file or published port; the internal tools network reaches remote-cli and mitmproxy but not codex-lb or direct public egress.

Pi trigger admission requires the existing internal secret, supplied by gateway and never sent to executor. Actor fields from an unauthenticated executor-origin request cannot become trusted approval/attribution context. Remote-cli remains the authorization owner; wrapper IDs still provide correlation, not standalone authority. Unsafe tool calls are not automatically replayed after an uncertain outcome. Trusted runner Slack progress bypasses the agent-tool proxy policy, without granting that bypass to executor.
