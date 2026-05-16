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
- `remote-cli` exposes `POST /exec/*` endpoints for git, gh, sandbox, scoutqa, langfuse, metabase, MCP tool calls, and approval status/resolution.

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
2. Initialize the mitmproxy CA on the host:

```bash
./scripts/mitmproxy-ca-init.sh
```

This keeps the private key on the host and only exposes the public trust bundle
inside `opencode`.

3. Start the stack:

```bash
docker compose up --build -d
curl http://localhost:8080/health
```

4. Clone repos into the shared workspace from the `remote-cli` container:

```bash
docker compose exec remote-cli \
  git clone https://github.com/your-org/your-repo.git
```

5. Configure `/workspace/config.json` with repo-to-upstream access rules.

Example:

```json
{
  "repos": {
    "your-repo": {
      "channels": ["C12345678"],
      "proxies": ["atlassian", "grafana"]
    }
  }
}
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
`/workspace/config.json` under `mitmproxy[]` and `mitmproxy_passthrough[]`.
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

| Variable                            | Required | Service                              | Purpose                                                                                                              |
| ----------------------------------- | -------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ATLASSIAN_AUTH`                    | Yes      | `remote-cli`, `mitmproxy`            | Atlassian MCP auth header value and mitmproxy default injection                                                      |
| `CRON_SECRET`                       | Yes      | `gateway`, `cron`                    | Shared secret for cron endpoint auth                                                                                 |
| `GITHUB_APP_ID`                     | Yes      | `remote-cli`                         | GitHub App ID for GitHub App auth                                                                                    |
| `GITHUB_APP_BOT_ID`                 | Yes      | `remote-cli`, `gateway`              | GitHub App bot user ID (commit identity + CI wake author gate)                                                       |
| `GITHUB_APP_SLUG`                   | Yes      | `remote-cli`, `gateway`              | GitHub App slug (commit identity + mention detection)                                                                |
| `GITHUB_API_URL`                    | No       | `remote-cli`                         | GitHub API base URL override                                                                                         |
| `GITHUB_APP_PRIVATE_KEY_FILE`       | Yes      | `remote-cli`                         | GitHub App private key path                                                                                          |
| `GITHUB_WEBHOOK_SECRET`             | Yes      | `gateway`                            | GitHub webhook signature secret                                                                                      |
| `GITHUB_PAT`                        | No       | `remote-cli`                         | Optional fallback token for `git` / `gh` after GitHub App startup                                                    |
| `GRAFANA_ORG_ID`                    | No       | `grafana-mcp`                        | Grafana org ID (defaults to `1`)                                                                                     |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN`     | Yes      | `grafana-mcp`                        | Grafana service account token                                                                                        |
| `GRAFANA_URL`                       | Yes      | `grafana-mcp`                        | Grafana instance URL                                                                                                 |
| `INGRESS_PORT`                      | No       | `ingress`                            | Host port for the reverse proxy                                                                                      |
| `LANGFUSE_HOST`                     | No       | `remote-cli`                         | Langfuse host URL                                                                                                    |
| `LANGFUSE_PUBLIC_KEY`               | No       | `remote-cli`                         | Langfuse public key                                                                                                  |
| `LANGFUSE_SECRET_KEY`               | No       | `remote-cli`                         | Langfuse secret key                                                                                                  |
| `METABASE_ALLOWED_SCHEMAS`          | No       | `remote-cli`                         | Comma-separated schema allowlist                                                                                     |
| `METABASE_API_KEY`                  | No       | `remote-cli`                         | Metabase API key                                                                                                     |
| `METABASE_DATABASE_ID`              | No       | `remote-cli`                         | Metabase database ID                                                                                                 |
| `METABASE_URL`                      | No       | `remote-cli`                         | Metabase instance URL                                                                                                |
| `THOR_ADMIN_EMAILS`                 | Yes      | `ingress`                            | Comma-separated authenticated Google emails allowed for OpenCode-backed and `/admin/` ingress routes                 |
| `POSTHOG_API_KEY`                   | Yes      | `remote-cli`                         | PostHog MCP auth                                                                                                     |
| `RUNNER_BASE_URL`                   | Yes      | `remote-cli`                         | Public base URL for Thor trigger viewer links in PR/Jira content                                                     |
| `THOR_INTERNAL_SECRET`              | Yes      | `remote-cli`, `gateway`              | Secret-gates gateway↔remote-cli internal APIs                                                                        |
| `THOR_E2E_TEST_HELPERS`             | No       | `runner`                             | Enables secret-gated deterministic runner e2e helpers                                                                |
| `SLACK_BOT_TOKEN`                   | Yes      | `remote-cli`, `gateway`, `mitmproxy` | Slack bot token for controlled `slack-post-message`, gateway Slack calls, and mitmproxy default injection            |
| `SLACK_BOT_USER_ID`                 | Yes      | `gateway`                            | Bot user ID used to ignore our own messages                                                                          |
| `SLACK_SIGNING_SECRET`              | Yes      | `gateway`                            | Slack webhook verification                                                                                           |
| `SLACK_TIMESTAMP_TOLERANCE_SECONDS` | No       | `gateway`                            | Signature timestamp tolerance                                                                                        |
| `VOUCH_CALLBACK_URL`                | No       | `vouch`                              | OAuth callback URL                                                                                                   |
| `VOUCH_COOKIE_DOMAIN`               | No       | `vouch`                              | Cookie domain                                                                                                        |
| `VOUCH_ALLOWED_EMAIL_DOMAINS`       | No       | `compose -> vouch`                   | Thor/compose-facing input rendered into Vouch's `VOUCH_DOMAINS`; comma-separated email domains, default `scoutqa.cc` |
| `VOUCH_GOOGLE_CLIENT_ID`            | Yes      | `vouch`                              | Google OAuth client ID                                                                                               |
| `VOUCH_GOOGLE_CLIENT_SECRET`        | Yes      | `vouch`                              | Google OAuth client secret                                                                                           |
| `VOUCH_JWT_SECRET`                  | Yes      | `vouch`                              | Session JWT signing secret                                                                                           |

Use [`docs/github-app-webhooks.md`](docs/github-app-webhooks.md) for GitHub App webhook setup, required permissions/subscriptions, and troubleshooting.

Gateway and remote-cli derive the GitHub App bot commit identity from `GITHUB_APP_SLUG` and `GITHUB_APP_BOT_ID`: `${GITHUB_APP_BOT_ID}+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com`. Gateway uses that derived email to accept `check_suite.completed` CI wakes only for Thor-authored commits; no separate author-email env var is required.

Thor uses a shared workspace config file at `/workspace/config.json` inside the containers. On the host, that file lives at `docker-volumes/workspace/config.json`. Use [`docs/examples/workspace-config.example.json`](docs/examples/workspace-config.example.json) as the starting point, and use [`packages/common/src/proxies.ts`](packages/common/src/proxies.ts) as the reference for the built-in upstream catalog.

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

The `git` wrapper resolves installation tokens lazily through `GIT_ASKPASS`, and the `gh` wrapper resolves them before invoking `gh`. `remote-cli` now requires GitHub App env vars at startup; `GITHUB_PAT` is only an optional fallback for command execution after the service is up.

If you have internal APIs that Thor should access with injected credentials,
define rules in `/workspace/config.json` and keep only secret values in `.env`:

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

- Tell Thor about your team, repos, and channel conventions in the OpenCode UI after the stack is up. That context is stored in persistent memory.
- Clone source repos from the `remote-cli` container so git credentials and filesystem ownership stay consistent.
- Repos under `/workspace/repos` are mounted read-only into OpenCode. Thor creates edits in `/workspace/worktrees`.
- OpenCode and remote-cli share the same `/tmp` volume so temporary artifacts referenced by absolute path, such as `slack-post-message --blocks-file /tmp/...`, are readable by the posting service.
- Scheduled prompts live in `docker-volumes/workspace/cron/crontab`.

## Security Model

- OpenCode does not get direct API credentials for MCP upstreams.
- Vouch allows Google-authenticated users whose email domain matches
  `VOUCH_ALLOWED_EMAIL_DOMAINS`; the OpenCode SPA root and `/admin/` ingress
  routes additionally require one of `THOR_ADMIN_EMAILS`, while `/runner/`
  viewer routes remain available to any allowed-domain user. Static OpenCode
  assets (`/assets/`, `/oc-theme-preload.js`) bypass Vouch for performance.
- `remote-cli` enforces MCP allow/approve policy server-side and stores approvals under `/workspace/data/approvals`.
- Gateway↔remote-cli internal routes are secret-gated with `x-thor-internal-secret`, including `POST /exec/mcp` approval resolution and `POST /internal/exec`.
- `git` uses GitHub App installation tokens through `GIT_ASKPASS` when `owners.<owner>.github_app_installation_id` is configured and the target owner can be resolved; `GITHUB_PAT` is only a fallback during command execution.
- `gh` resolves GitHub App auth before execution and can fall back to inherited `GH_TOKEN` / `GITHUB_PAT` when no installation token is available, but the service itself still requires GitHub App env at startup.
- Source repos are mounted read-only into OpenCode; edits happen in `/workspace/worktrees`.
- Tool calls are audit-logged under `/workspace/worklog`.

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

`pnpm test:e2e` is deterministic and never calls `/trigger`. The clone repo env vars are required because the test exercises `remote-cli`'s `/exec/git clone` policy; the repo's owner must be present in `/workspace/config.json`'s `owners` map.

`pnpm test:create-jira-approval-e2e` requires live Slack/OpenCode credentials, a connected Atlassian MCP upstream, and a writable Slack test channel via `SLACK_E2E_CHANNEL_ID` (or `SLACK_CHANNEL_ID`). It intentionally leaves approvals pending for human inspection.

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
