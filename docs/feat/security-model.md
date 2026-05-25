# Security Model

How Thor contains untrusted input through layered controls. For integration-specific details, see [`slack.md`](../slack.md), [`github.md`](../github.md), and [`daytona.md`](../daytona.md).

## Threat model

Three things are assumed untrusted:

- **The agent.** OpenCode runs LLM-driven code; prompt-injection-shaped outputs and unintended tool calls are expected.
- **OpenCode-side wrappers.** Skill scripts and CLI shims inside the OpenCode container are reachable by the agent and can be coerced. They are convenience, not enforcement.
- **External webhook senders.** Inbound HTTP requests are hostile until a signature proves otherwise.

The docker network — gateway, runner, remote-cli, mitmproxy — is the trust boundary. Everything inside it is treated as equally trusted; everything outside must authenticate.

## Layer 1: Network boundary

- **Ingress + Vouch.** `ingress` terminates TLS and delegates auth to Vouch. Vouch admits Google-authenticated users whose email domain matches `VOUCH_ALLOWED_EMAIL_DOMAINS`. The OpenCode SPA root and `/admin/` additionally require membership in `THOR_ADMIN_EMAILS`; `/runner/` viewer routes remain open to any allowed-domain user. Static OpenCode assets bypass Vouch for performance.
- **Egress through mitmproxy.** All outbound HTTP(S) from OpenCode traverses mitmproxy. See Layer 1a for the routing path, built-in defaults, and custom rule format.
- **Host port hardening.** `remote-cli` binds `127.0.0.1:3004:3004` so it is unreachable from outside the host.

## Layer 1a: Outbound proxy (mitmproxy)

Thor's outbound HTTP(S) routing for operator-invoked clients is explicit:

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
- OpenAI and ChatGPT domains: passthrough only (no injected credentials).

The shared upstream registry and allow/approve policy are checked into [`packages/common/src/proxies.ts`](../../packages/common/src/proxies.ts).

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

| Source                | Mechanism                                                                   | Window |
| --------------------- | --------------------------------------------------------------------------- | ------ |
| Slack events / interactivity | `X-Slack-Signature` HMAC-SHA256 over `v0:<ts>:<raw-body>`             | 300s   |
| GitHub webhooks       | `X-Hub-Signature-256` HMAC over raw body, secret `GITHUB_WEBHOOK_SECRET`    | n/a    |
| Internal gateway↔remote-cli routes | `x-thor-internal-secret: $THOR_INTERNAL_SECRET`                | n/a    |

`THOR_INTERNAL_SECRET` authorizes policy-bypass internal operations — approval resolution (`POST /exec/mcp`) and arbitrary `POST /internal/exec`. Agents never receive it. Treat it with the same care as a root credential.

## Layer 3: Authorization gating

After authentication, events still face content-aware gates before they wake the agent:

- **Slack private-channel allowlist** — public non-shared channels admit by default; private channels, DMs, group DMs, and Slack Connect channels must appear in `slack.private_channel_allowlist` in `thor.json`. Fail-closed on lookup error. See `slack.md` §5.
- **GitHub mention-required for first contact** — pure issue comments require `@${GITHUB_APP_SLUG}`. Once a session exists for the issue, later follow-ups can wake without a mention. See `github.md` §4.
- **Self-loop guards** — events whose sender matches `SLACK_BOT_USER_ID` or `GITHUB_APP_BOT_ID` are dropped. Without these, every Thor-authored reply would re-trigger Thor.
- **CI wake gate.** `check_suite.completed` only wakes Thor when the head commit's author email matches the derived GitHub App bot email and an alias-backed session for that branch already exists. See `github.md` §4a.

## Layer 4: Server-side policy at remote-cli

remote-cli is the *only* place tool-level policy is enforced. OpenCode-side wrappers (skill scripts, CLI shims) are not trusted to filter their own arguments.

### MCP tool tiers

- **Allow-listed tools** execute immediately.
- **Approved tools** create an approval record, post an approval card to the triggering Slack thread, and return an action id. Status is available through `POST /exec/approval`.
- **Hidden tools** are never listed to the agent.

Approval creation **fails closed** when remote-cli cannot resolve or post to the triggering Slack thread. No usable pending approval is created without the operator-visible card.

### Command policy

`git`, `gh`, `langfuse`, `metabase`, `ldcli`, and `scoutqa` go through remote-cli `POST /exec/*` endpoints with server-side allowlists per command. The OpenCode-side wrappers are convenience — bypassing them by calling raw binaries inside OpenCode does not exist as a path because credentials live in remote-cli.

### Credential handling

- `git` uses GitHub App installation tokens minted on demand through `GIT_ASKPASS` when the target owner resolves from the command or repo remote.
- `gh` resolves GitHub App auth before execution and exports `GH_TOKEN` only with the short-lived installation token for the resolved owner.
- OpenCode never receives direct API credentials for MCP upstreams.

## Layer 5: Blast radius limits

If a policy layer fails, these limit what damage is reachable:

- **Read-only repo mounts.** `/workspace/repos` is read-only inside OpenCode. Writes go to `/workspace/worktrees`.
- **GitHub App scopes.** The app is granted the minimum permissions listed in `github.md` §3 — no admin, no settings write, no org-wide access.
- **Per-owner installation tokens.** GitHub installation tokens are scoped to a single owner and expire within an hour.
- **Daytona sandbox isolation.** Project builds and test runs execute in per-worktree Daytona sandboxes; `git` is blocked inside the sandbox so the agent cannot push from there.

## Layer 6: Audit trail

- `/workspace/worklog` — structured tool-call records, accept/ignore decisions, and gate reasons.
- `/workspace/data/approvals` — persisted approval records.
- Gateway worklog entries (`github-webhook-ignored`, `slack_event_ignored`, etc.) carry `reason` + `metadata` fields explaining each drop.

## Deferred to infrastructure

- **Rate limiting / DDoS protection.** Application code does not implement Express rate limiters. Enforcement is expected at the ingress / WAF layer. See `AGENTS.md` §8.
- **OpenCode harness boundaries.** Thor-side wrappers do not re-enforce timeouts, output caps, or transformations already handled by the OpenCode harness. See `AGENTS.md` §9.
