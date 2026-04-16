# Thor

An event-driven AI team member that watches Slack and scheduled jobs, resumes OpenCode sessions through the runner, and reaches external systems through `remote-cli` and `slack-mcp`.

## Architecture

```text
ingress -> gateway -> runner -> opencode
                           \
                            -> remote-cli -> MCP upstreams / CLI integrations
                             \
                              -> slack-mcp
```

- `gateway` accepts Slack and cron events, batches them, and forwards them to the runner.
- `runner` manages OpenCode session continuity and streams progress back out.
- `remote-cli` exposes `POST /exec/*` endpoints for git, gh, scoutqa, langfuse, metabase, MCP tool calls, and approval status/resolution.
- `slack-mcp` owns Slack API access for progress updates and approval notifications.

## Services

| Service       | Port | Package            | Role                                       |
| ------------- | ---- | ------------------ | ------------------------------------------ |
| `cron`        | -    | `docker/cron`      | Scheduled prompts                          |
| `data`        | 3080 | `docker/data`      | Optional credential-injecting HTTP proxy   |
| `gateway`     | 3002 | `@thor/gateway`    | Slack webhook ingestion and batching       |
| `remote-cli`  | 3004 | `@thor/remote-cli` | CLI + MCP policy gateway                   |
| `grafana-mcp` | 8000 | Docker image       | Grafana MCP server                         |
| `ingress`     | 8080 | `docker/ingress`   | Reverse proxy + Vouch integration          |
| `opencode`    | 4096 | Docker image       | Headless agent runtime                     |
| `runner`      | 3000 | `@thor/runner`     | Session lifecycle + NDJSON progress stream |
| `slack-mcp`   | 3003 | `@thor/slack-mcp`  | Slack MCP server and progress lifecycle    |
| `vouch`       | 9090 | Docker image       | OAuth/SSO proxy                            |

## Quick Start

1. Copy `.env.example` to `.env` and fill in the required secrets.
2. Start the stack:

```bash
docker compose up --build -d
curl http://localhost:8080/health
```

3. Clone repos into the shared workspace from the `remote-cli` container:

```bash
docker compose exec remote-cli \
  git clone https://github.com/your-org/your-repo.git /workspace/repos/your-repo
```

4. Configure `/workspace/config.json` with repo-to-upstream access rules.

Example:

```json
{
  "repos": {
    "your-repo": {
      "channels": ["C12345678"],
      "proxies": ["slack", "atlassian", "grafana"]
    }
  },
  "proxies": {
    "slack": {
      "upstream": { "url": "http://slack-mcp:3003/mcp" },
      "allow": ["post_message", "read_thread"]
    },
    "atlassian": {
      "upstream": {
        "url": "https://mcp.atlassian.com/v1/mcp",
        "headers": { "Authorization": "${ATLASSIAN_AUTH}" }
      },
      "allow": ["get_issue", "list_issues"],
      "approve": ["update_issue", "create_issue"]
    }
  }
}
```

## Key Env Vars

| Variable                        | Required | Service                 | Purpose                               |
| ------------------------------- | -------- | ----------------------- | ------------------------------------- |
| `ATLASSIAN_AUTH`                | Yes      | `remote-cli`            | Atlassian MCP auth header value       |
| `CRON_SECRET`                   | Yes      | `gateway`, `cron`       | Cron endpoint auth                    |
| `GITHUB_PAT`                    | Yes      | `remote-cli`            | GitHub CLI auth                       |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | Yes      | `grafana-mcp`           | Grafana access token                  |
| `GRAFANA_URL`                   | Yes      | `grafana-mcp`           | Grafana base URL                      |
| `LANGFUSE_PUBLIC_KEY`           | No       | `remote-cli`            | Langfuse read-only auth               |
| `LANGFUSE_SECRET_KEY`           | No       | `remote-cli`            | Langfuse read-only auth               |
| `METABASE_API_KEY`              | No       | `remote-cli`            | Metabase access                       |
| `POSTHOG_API_KEY`               | Yes      | `remote-cli`            | PostHog MCP auth                      |
| `RESOLVE_SECRET`                | Yes      | `remote-cli`, `gateway` | Secret-gates approval resolution      |
| `SLACK_BOT_TOKEN`               | Yes      | `slack-mcp`             | Slack bot token                       |
| `SLACK_BOT_USER_ID`             | Yes      | `gateway`               | Used to ignore our own Slack messages |
| `SLACK_SIGNING_SECRET`          | Yes      | `gateway`               | Slack webhook verification            |

## Security Model

- OpenCode does not get direct API credentials for MCP upstreams.
- `remote-cli` enforces MCP allow/approve policy server-side and stores approvals under `/workspace/data/approvals`.
- Approval resolution is only available through `POST /exec/mcp` with `x-thor-resolve-secret`.
- Source repos are mounted read-only into OpenCode; edits happen in `/workspace/worktrees`.
- Tool calls are audit-logged under `/workspace/worklog`.

## Testing

```bash
pnpm test
pnpm test:mcp
pnpm test:e2e
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
│   └── slack-mcp/
├── docker/
├── docs/
├── scripts/
├── docker-compose.yml
├── Dockerfile
└── AGENTS.md
```
