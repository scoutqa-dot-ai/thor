# Thor

An event-driven AI team member that watches Slack and scheduled jobs, resumes OpenCode sessions through the runner, and reaches external systems through `remote-cli`.

## Architecture

```text
ingress -> gateway -> runner -> opencode
                           \
                            -> remote-cli -> MCP upstreams / CLI integrations
```

- `gateway` accepts Slack, GitHub webhook, and cron events, batches them, and forwards them to the runner.
- `runner` manages OpenCode session continuity and streams progress back out.
- `remote-cli` exposes `POST /exec/*` endpoints for git, gh, sandbox, scoutqa, langfuse, metabase, MCP tool calls, direct Slack approval-card posting, and approval status/resolution.

## Services

| Service       | Port | Package            | Role                                        |
| ------------- | ---- | ------------------ | ------------------------------------------- |
| `cron`        | -    | `docker/cron`      | Scheduled prompts                           |
| `mitmproxy`   | 3080 | `docker/mitmproxy` | Explicit outbound HTTP(S) proxy             |
| `gateway`     | 3002 | `@thor/gateway`    | Slack/GitHub webhook ingestion and batching |
| `remote-cli`  | 3004 | `@thor/remote-cli` | CLI + MCP policy gateway                    |
| `admin`       | 3005 | `@thor/admin`      | Admin dashboard and workspace configuration |
| `grafana-mcp` | 8000 | Docker image       | Grafana MCP server                          |
| `ingress`     | 8080 | `docker/ingress`   | Reverse proxy + Vouch integration           |
| `opencode`    | 4096 | Docker image       | Headless agent runtime                      |
| `runner`      | 3000 | `@thor/runner`     | Session lifecycle + NDJSON progress stream  |
| `vouch`       | 9090 | Docker image       | OAuth/SSO proxy                             |

## Quick Start

1. Copy `.env.example` to `.env` and fill in the required secrets.
   `SLACK_DEFAULT_REPO` must name an existing repo that is already present under
   `/workspace/repos` before you start the stack. Gateway routes every Slack
   channel to this repo unless a per-channel override file at
   `/workspace/memory/thor/repo-by-slack-channel/<channel>.txt` names a different
   existing repo directory. That override file is operational routing config,
   not general Thor memory: it must contain exactly one existing repo directory
   name and nothing else.
2. Initialize the mitmproxy CA on the host:

```bash
./scripts/mitmproxy-ca-init.sh
```

This keeps the private key on the host and only exposes the public trust bundle
inside `opencode`.

3. Create `/workspace/config/thor.json` with GitHub App installation IDs for each
   GitHub owner you need Thor to access, plus any mitmproxy rules. On the host,
   this file lives at `docker-volumes/workspace/config/thor.json`. See
   [`docs/examples/thor.json`](docs/examples/thor.json).
   MCP upstream access is enabled for every repo automatically — no per-repo
   config required.

4. Clone repos into the shared workspace:

```bash
docker compose run --rm remote-cli \
  git clone https://github.com/your-org/your-repo.git
```

If the stack is already running, you can clone the same repo from the
`remote-cli` container instead:

```bash
docker compose exec remote-cli \
  git clone https://github.com/your-org/your-repo.git
```

5. Start the stack:

```bash
docker compose up --build -d
curl http://localhost:8080/health
```

The shared upstream registry and allow/approve policy are checked into
[`packages/common/src/proxies.ts`](packages/common/src/proxies.ts).

## Outbound HTTP(S) proxy path

Thor's outbound HTTP(S) routing for operator-invoked clients is explicit:

```text
opencode -> HTTP(S)_PROXY -> mitmproxy -> upstream
```

- `opencode` sets both lowercase and uppercase proxy env vars (`http_proxy`,
  `https_proxy`, `HTTP_PROXY`, `HTTPS_PROXY`, with matching `NO_PROXY` forms).
- Supported outbound clients in this workflow are `curl` and built-in `fetch()`.
- This is env-proxy routing, not transparent interception or firewall-style
  egress enforcement.
- OpenAI and ChatGPT domains are passthrough by default (no injected
  credentials).

Custom credential rules and passthrough hosts live in
`/workspace/config/thor.json` under `mitmproxy[]` and `mitmproxy_passthrough[]`.
Keep secrets in `.env` only, then reference them in config via `${ENV_VAR}`.
Rules can match either an exact `host` or a `host_suffix`, and can optionally
add `path_prefix` and/or `path_suffix` when one domain needs different headers
by URL prefix or suffix.

Built-in defaults are intentionally narrow:

- Atlassian: injected auth for `api.atlassian.com` and `*.atlassian.net`,
  read-only by default. Jira attachment uploads
  (`POST .../rest/api/3/issue/{key}/attachments` on `*.atlassian.net`, and
  `POST .../ex/jira/{cloudId}/rest/api/3/issue/{key}/attachments` on
  `api.atlassian.com`) are allowed as a POST-only narrow write exception
- Atlassian media redirects: `api.media.atlassian.com` passthrough
- Slack API: injected auth only for thread/history reads, `reactions.add`,
  `files.info`, and the upload setup/complete endpoints on `slack.com/api/...`;
  message writes must use `slack-post-message`
- Slack files: read-only downloads on `files.slack.com/files-pri/...` and
  upload flow support on `files.slack.com/upload/v1/...`
- OpenAI and ChatGPT domains: passthrough only

## Deployment Configuration

Thor ships with generic defaults. A new deployment typically needs:

| Variable                            | Required | Service                                        | Purpose                                                                                                                                                                   |
| ----------------------------------- | -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATLASSIAN_AUTH`                    | Yes      | `remote-cli`, `mitmproxy`                      | Atlassian MCP auth header value and mitmproxy default injection                                                                                                           |
| `CRON_SECRET`                       | Yes      | `gateway`, `cron`                              | Shared secret for cron endpoint auth                                                                                                                                      |
| `GITHUB_APP_ID`                     | Yes      | `remote-cli`                                   | GitHub App ID for GitHub App auth                                                                                                                                         |
| `GITHUB_APP_BOT_ID`                 | Yes      | `remote-cli`, `gateway`                        | GitHub App bot user ID (commit identity + CI wake author gate)                                                                                                            |
| `GITHUB_APP_SLUG`                   | Yes      | `remote-cli`, `gateway`                        | GitHub App slug (commit identity + mention detection)                                                                                                                     |
| `GITHUB_API_URL`                    | No       | `remote-cli`                                   | GitHub API base URL override                                                                                                                                              |
| `GITHUB_APP_PRIVATE_KEY_FILE`       | Yes      | `remote-cli`                                   | GitHub App private key path                                                                                                                                               |
| `GITHUB_WEBHOOK_SECRET`             | Yes      | `gateway`                                      | GitHub webhook signature secret                                                                                                                                           |
| `GRAFANA_ORG_ID`                    | No       | `grafana-mcp`                                  | Grafana org ID (defaults to `1`)                                                                                                                                          |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN`     | Yes      | `grafana-mcp`                                  | Grafana service account token                                                                                                                                             |
| `GRAFANA_URL`                       | Yes      | `grafana-mcp`                                  | Grafana instance URL                                                                                                                                                      |
| `INGRESS_PORT`                      | No       | `ingress`                                      | Host port for the reverse proxy                                                                                                                                           |
| `LANGFUSE_HOST`                     | No       | `remote-cli`                                   | Langfuse host URL                                                                                                                                                         |
| `LANGFUSE_PUBLIC_KEY`               | No       | `remote-cli`                                   | Langfuse public key                                                                                                                                                       |
| `LANGFUSE_SECRET_KEY`               | No       | `remote-cli`                                   | Langfuse secret key                                                                                                                                                       |
| `METABASE_ALLOWED_SCHEMAS`          | No       | `remote-cli`                                   | Comma-separated schema allowlist                                                                                                                                          |
| `METABASE_API_KEY`                  | No       | `remote-cli`                                   | Metabase API key                                                                                                                                                          |
| `METABASE_DATABASE_ID`              | No       | `remote-cli`                                   | Metabase database ID                                                                                                                                                      |
| `METABASE_URL`                      | No       | `remote-cli`                                   | Metabase instance URL                                                                                                                                                     |
| `THOR_ADMIN_EMAILS`                 | Yes      | `ingress`                                      | Comma-separated authenticated Google emails allowed for OpenCode-backed and `/admin/` ingress routes                                                                      |
| `POSTHOG_API_KEY`                   | Yes      | `remote-cli`                                   | PostHog MCP auth                                                                                                                                                          |
| `RUNNER_BASE_URL`                   | Yes      | `remote-cli`                                   | Public base URL for Thor trigger viewer links in PR/Jira content                                                                                                          |
| `THOR_INTERNAL_SECRET`              | Yes      | `remote-cli`, `gateway`                        | Secret-gates gateway↔remote-cli internal APIs                                                                                                                             |
| `THOR_E2E_TEST_HELPERS`             | No       | `runner`                                       | Enables secret-gated deterministic runner e2e helpers                                                                                                                     |
| `SLACK_BOT_TOKEN`                   | Yes      | `remote-cli`, `gateway`, `runner`, `mitmproxy` | Slack bot token for remote-cli approval cards, controlled `slack-post-message`, gateway Slack calls, runner-owned Slack progress updates, and mitmproxy default injection |
| `SLACK_API_BASE_URL`                | No       | `remote-cli`, `gateway`, `runner`              | Slack Web API base URL for approval cards, controlled Slack posting, gateway Slack calls, and runner Slack progress updates; defaults to `https://slack.com/api`          |
| `SLACK_BOT_USER_ID`                 | Yes      | `gateway`                                      | Bot user ID used to ignore our own messages                                                                                                                               |
| `SLACK_DEFAULT_REPO`                | Yes      | `gateway`                                      | Existing `/workspace/repos/<repo>` directory name used for every Slack channel unless a per-channel override file selects a different repo directory                      |
| `SLACK_SIGNING_SECRET`              | Yes      | `gateway`                                      | Slack webhook verification                                                                                                                                                |
| `SLACK_TIMESTAMP_TOLERANCE_SECONDS` | No       | `gateway`                                      | Signature timestamp tolerance                                                                                                                                             |
| `SLACK_TEAM_ID`                     | No       | `admin`, `runner`                              | Slack workspace team id; enables clickable thread permalinks on the admin sessions dashboard and the runner trigger viewer source link                                    |
| `VOUCH_CALLBACK_URL`                | No       | `vouch`                                        | OAuth callback URL                                                                                                                                                        |
| `VOUCH_COOKIE_DOMAIN`               | No       | `vouch`                                        | Cookie domain                                                                                                                                                             |
| `VOUCH_ALLOWED_EMAIL_DOMAINS`       | No       | `compose -> vouch`                             | Thor/compose-facing input rendered into Vouch's `VOUCH_DOMAINS`; comma-separated email domains, default `scoutqa.cc`                                                      |
| `VOUCH_GOOGLE_CLIENT_ID`            | Yes      | `vouch`                                        | Google OAuth client ID                                                                                                                                                    |
| `VOUCH_GOOGLE_CLIENT_SECRET`        | Yes      | `vouch`                                        | Google OAuth client secret                                                                                                                                                |
| `VOUCH_JWT_SECRET`                  | Yes      | `vouch`                                        | Session JWT signing secret                                                                                                                                                |

Use [`docs/github-app-webhooks.md`](docs/github-app-webhooks.md) for GitHub App webhook setup, required permissions/subscriptions, and troubleshooting.

Gateway and remote-cli derive the GitHub App bot commit identity from `GITHUB_APP_SLUG` and `GITHUB_APP_BOT_ID`: `${GITHUB_APP_BOT_ID}+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com`. Gateway uses that derived email to accept `check_suite.completed` CI wakes only for Thor-authored commits; no separate author-email env var is required.

Thor uses a shared workspace config file at `/workspace/config/thor.json` inside the containers. On the host, that file lives at `docker-volumes/workspace/config/thor.json`. Use [`docs/examples/thor.json`](docs/examples/thor.json) as the starting point, and use [`packages/common/src/proxies.ts`](packages/common/src/proxies.ts) as the reference for the built-in upstream catalog.

GitHub App installation entries live under `owners.<owner>.github_app_installation_id` in that config:

```json
{
  "owners": {
    "acme": {
      "github_app_installation_id": 12345678
    }
  }
}
```

The `git` wrapper resolves installation tokens lazily through `GIT_ASKPASS`, and the `gh` wrapper resolves them before invoking `gh`. `remote-cli` requires GitHub App env vars at startup and does not support static PAT fallback auth.

Human attribution entries live under `users[]`. `email` must be the Jira account email; Thor may write the name/email into `Co-authored-by:` commit trailers and use the email to resolve Jira assignees. Config hot-reloads, so no restart is needed after edits.

```json
{
  "users": [
    { "email": "alice@example.com", "name": "Alice", "slack": "UABCDEF1", "github": "alice" },
    { "email": "bob@example.com", "name": "Bob" }
  ]
}
```

To verify your entry, trigger Thor from Slack and look for `attribution_applied` with `outcome: "applied"` and your Slack id; `skipped_no_user_record` means the configured Slack id did not match the trigger. See [`docs/feat/users-directory-provenance.md`](docs/feat/users-directory-provenance.md) for registry provenance.

Every Slack surface other than a regular public, non-shared channel is gated by an explicit allowlist under `slack.private_channel_allowlist`. Private channels, DMs (`im`), group DMs (`mpim`), and Slack Connect/shared channels must all have their conversation id on the list. List every conversation id that Thor is permitted to act in:

```json
{
  "slack": {
    "private_channel_allowlist": ["C0123456789", "D0123456789", "G0123456789"]
  }
}
```

The config key name predates a scope broadening; the list now accepts DM (`D…`) and group-DM (`G…`) ids alongside private-channel and Slack Connect ids. Public, non-shared channel ids in the list are accepted but unnecessary.

When the channel type is not present on the Slack event (always true for `app_mention` in observed Slack payloads), or when the event says `channel_type === "channel"` and Thor still has to rule out Slack Connect/shared-channel flags, the webhook acknowledges immediately and enqueues the event under a `pending:slack-privacy:` correlation key, mirroring the GitHub `pending:branch-resolve:` pattern. The dispatcher then calls `conversations.info` off the ack path to resolve the surface; successful classifications are cached for 60 minutes. If the lookup fails, or if the workspace config cannot be loaded, the gate fails closed and the event is dropped with reason `private_channel_not_allowlisted`. The same audit reason fires for non-allowlisted DMs and MPIMs even though the string still says "private channel"; it is retained for log-grep continuity. For app mentions, Thor posts `:eyes:` immediately to show receipt before privacy resolution; any channel-gate rejection adds `:lock:` to mark a policy block. `:x:` remains reserved for processing failures. Omitting the `slack` key (or leaving the list empty) means every non-public or shared surface is rejected.

If you have internal APIs that Thor should access with injected credentials,
define rules in `/workspace/config/thor.json` and keep only secret values in `.env`:

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

mitmproxy evaluates user rules first, then built-in defaults. OpenAI and
ChatGPT domains are already allowed as passthrough by default.
Rules match by exact host or suffix first, then by optional `path_prefix` and
`path_suffix`.

## Operations Notes

- Tell Thor about your team, repos, and reusable operating context in the OpenCode UI after the stack is up. That context is stored in persistent memory.
- Clone source repos from the `remote-cli` container so git credentials and filesystem ownership stay consistent.
- Repos under `/workspace/repos` are mounted read-only into OpenCode. Thor creates edits in `/workspace/worktrees`.
- OpenCode and remote-cli share the same `/tmp` volume so temporary artifacts referenced by absolute path, such as `slack-post-message --blocks-file /tmp/...`, are readable by the posting service.
- Scheduled prompts live in `docker-volumes/workspace/cron/crontab`.

## Security Model

Thor contains untrusted input — agent, OpenCode wrappers, external webhooks — through layered controls. In short:

- Vouch SSO + mitmproxy bound the network; remote-cli binds to `127.0.0.1` only.
- Inbound webhooks are HMAC-verified (Slack signing secret, GitHub `X-Hub-Signature-256`); internal gateway↔remote-cli routes are gated with `x-thor-internal-secret`.
- Channel/mention/self-loop gates filter authenticated traffic before it wakes the agent.
- `remote-cli` is the only place tool policy is enforced: MCP allow/approve/hidden tiers, command allowlists, GitHub App installation tokens. OpenCode never holds direct upstream credentials.
- Repos mount read-only into OpenCode; edits happen in `/workspace/worktrees`. Tool calls are audit-logged under `/workspace/worklog`.

See [`docs/feat/security-model.md`](docs/feat/security-model.md) for the full layered breakdown.

## Testing

```bash
pnpm test
pnpm test:mcp
REMOTE_CLI_GIT_REPO_URL=https://github.com/owner/repo \
REMOTE_CLI_GITHUB_REPO=owner/repo \
  pnpm test:e2e
pnpm test:create-jira-approval-e2e # live Slack/OpenCode approval-card e2e for Atlassian approval-required tools
pnpm test:opencode-e2e # separate explicit OpenCode/LLM smoke path
pnpm typecheck
```

## Project Structure

```text
thor/
├── packages/
│   ├── common/
│   ├── gateway/
│   ├── opencode-cli/
│   ├── remote-cli/
│   ├── runner/
│   └── admin/
├── docker/
│   ├── cron/
│   ├── mitmproxy/
│   ├── ingress/
│   └── opencode/
├── docs/
├── scripts/
├── docker-compose.yml
├── Dockerfile
└── AGENTS.md
```
