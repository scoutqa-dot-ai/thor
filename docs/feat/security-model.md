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
- **Egress through mitmproxy.** All outbound HTTP(S) from OpenCode traverses mitmproxy. See README "Outbound HTTP(S) proxy path" for the inspectable-vs-passthrough split.
- **Host port hardening.** `remote-cli` binds `127.0.0.1:3004:3004` so it is unreachable from outside the host.

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
- **CI wake gate.** `check_suite.completed` only wakes Thor when the head commit's author email matches the derived GitHub App bot email and a notes-backed session for that branch already exists. See `github.md` §4a.

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
