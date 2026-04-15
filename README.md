# Thor

An event-driven AI team member that monitors Slack, Atlassian, and PostHog, then takes action through OpenCode sessions with policy-enforced tool access.

## Architecture

```
                        ┌─────────┐
                        │ ingress │
                        │ (nginx) │
                        └────┬────┘
                  ┌──────────┴─────────┐
                  ▼                    ▼
           ┌──────────┐          ┌───────────┐
           │ gateway  │          │ opencode  │
           │ webhooks │          │ AI engine │
           └────┬─────┘          └──┬─────┬──┘
                │               MCP │     │ CLI
                ▼                   ▼     ▼
           ┌─────────┐    ┌──────────┐   ┌──────────────┐
           │ runner  │    │  proxy   │   │ remote-cli │
           │ sessions│    │ policy   │   │ git/gh CLI   │
           └─────────┘    └────┬─────┘   └──────────────┘
                               │
                    ┌──────────┼──────────┬──────────┐
                    ▼          ▼          ▼          ▼
                Atlassian   PostHog     Slack     Grafana
                 (hosted)   (hosted)     MCP       MCP
```

Gateway receives events and triggers the runner. OpenCode connects to proxy instances for tool access and uses remote-cli for git/gh CLI operations.

## Services

| Service         | Port      | Package            | Role                                                                     |
| --------------- | --------- | ------------------ | ------------------------------------------------------------------------ |
| **cron**        | —         | `docker/cron`      | BusyBox crond for scheduled `hey-thor` prompts                           |
| **data**        | 3080      | `docker/data`      | Nginx credential proxy for internal APIs (requires custom config)        |
| **gateway**     | 3002      | `@thor/gateway`    | Slack webhook ingestion, event batching, trigger orchestration           |
| **remote-cli**  | 3004      | `@thor/remote-cli` | Git/GitHub CLI proxy with PAT credential isolation                       |
| **grafana-mcp** | 8000      | Docker image       | Grafana MCP server for Loki/Tempo queries                                |
| **ingress**     | 8080      | `docker/ingress`   | Nginx reverse proxy with Vouch SSO                                       |
| **opencode**    | 4096      | Docker image       | AI agent runtime (headless server)                                       |
| **proxy**       | 3010–3013 | `@thor/proxy`      | MCP tool allow-listing, credential injection, audit logging              |
| **runner**      | 3000      | `@thor/runner`     | OpenCode session management, prompt execution, NDJSON progress streaming |
| **slack-mcp**   | 3003      | `@thor/slack-mcp`  | Slack API MCP server, progress message lifecycle                         |
| **vouch**       | 9090      | Docker image       | OAuth/SSO authentication proxy (Vouch Proxy)                             |

## How It Works

1. **Events arrive** — Slack mentions and cron schedules hit the gateway
2. **Smart batching** — Events are queued per correlation key (e.g., Slack thread) with configurable delays (3s for mentions and engaged threads, immediate for cron). Non-mention Slack messages are only forwarded if Thor has already replied in the thread.
3. **Session continuity** — The runner maps correlation keys to persistent OpenCode sessions, resuming context across interactions
4. **Policy-enforced tools** — OpenCode accesses integrations through proxy instances that enforce allow-lists and log every tool call
5. **Progress visibility** — Tool activity streams back to Slack as live-updating progress messages that auto-clean when the bot replies

## Quick Start

### Prerequisites

- Docker & Docker Compose
- pnpm 9.x (for local development)
- Node.js 22+

### Running with Docker Compose

```bash
# Set required environment variables
export ATLASSIAN_BASIC_AUTH=base64_encoded_email:token
export GITHUB_PAT=github_pat_...
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_...
export GRAFANA_URL=https://your-instance.grafana.net
export POSTHOG_API_KEY=phx_...
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_BOT_USER_ID=U...
export SLACK_SIGNING_SECRET=...
export VOUCH_DOMAINS=example.com
export VOUCH_GOOGLE_CLIENT_ID=...
export VOUCH_GOOGLE_CLIENT_SECRET=...
export VOUCH_JWT_SECRET=...
export VOUCH_WHITELIST=alice@example.com,bob@example.com

# Start all services
docker compose up --build -d

# Verify health
curl http://localhost:8080/health

# View logs
docker compose logs -f

# Stop
docker compose down
```

### Deployment Configuration

Thor ships with generic defaults. A new deployment needs the following configuration:

#### 1. Environment variables (`.env`)

Copy `.env.example` to `.env` and fill in:

| Variable                            | Required | Service       | Purpose                                                          |
| ----------------------------------- | -------- | ------------- | ---------------------------------------------------------------- |
| `ATLASSIAN_BASIC_AUTH`              | Yes      | proxy         | Base64-encoded `email:api-token` for Atlassian API access        |
| `CRON_SECRET`                       | Yes      | gateway, cron | Shared secret for cron endpoint auth                             |
| `DATA_ROUTES`                       | No       | data          | Comma-separated list of data proxy routes (see below)            |
| `GIT_USER_EMAIL`                    | No       | remote-cli    | Git author email (default: `thor@localhost`)                     |
| `GIT_USER_NAME`                     | No       | remote-cli    | Git author name (default: `thor`)                                |
| `GITHUB_PAT`                        | Yes      | remote-cli    | GitHub fine-grained PAT                                          |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN`     | Yes      | grafana-mcp   | Grafana service account token                                    |
| `GRAFANA_URL`                       | Yes      | grafana-mcp   | Grafana instance URL                                             |
| `INGRESS_PORT`                      | No       | ingress       | Host port (default: `8080`)                                      |
| `METABASE_ALLOWED_SCHEMAS`          | No       | remote-cli    | Comma-separated schema allowlist for discovery filtering         |
| `METABASE_API_KEY`                  | No       | remote-cli    | Metabase API key (must be scoped to read-only DB role)           |
| `METABASE_DATABASE_ID`              | No       | remote-cli    | Metabase database ID to query                                    |
| `METABASE_URL`                      | No       | remote-cli    | Metabase instance URL                                            |
| `OPENCODE_CPU_LIMIT`                | No       | opencode      | CPU limit for OpenCode container (default: `3`)                  |
| `OPENCODE_MEMORY_LIMIT`             | No       | opencode      | Memory limit for OpenCode container (default: `4g`)              |
| `OPENCODE_URL`                      | No       | runner        | OpenCode server URL (default: `http://opencode:4096`)            |
| `POSTHOG_API_KEY`                   | Yes      | proxy         | PostHog API access                                               |
| `SESSION_CWD`                       | No       | runner        | Working directory for new sessions (default: `/workspace`)       |
| `SLACK_BOT_TOKEN`                   | Yes      | slack-mcp     | Slack app bot token (`xoxb-...`)                                 |
| `SLACK_BOT_USER_ID`                 | Yes      | gateway       | Bot's Slack user ID — used to ignore own messages                |
| `SLACK_SIGNING_SECRET`              | Yes      | gateway       | Webhook signature verification                                   |
| `SLACK_TIMESTAMP_TOLERANCE_SECONDS` | No       | gateway       | Signature timestamp tolerance (default: `300`)                   |
| `VOUCH_CALLBACK_URL`                | No       | vouch         | OAuth callback URL (default: `http://localhost:8080/vouch/auth`) |
| `VOUCH_COOKIE_DOMAIN`               | No       | vouch         | Cookie domain (default: `localhost`)                             |
| `VOUCH_DOMAINS`                     | Yes      | vouch         | Allowed domain for Vouch login (e.g., `example.com`)             |
| `VOUCH_GOOGLE_CLIENT_ID`            | Yes      | vouch         | Google OAuth client ID                                           |
| `VOUCH_GOOGLE_CLIENT_SECRET`        | Yes      | vouch         | Google OAuth client secret                                       |
| `VOUCH_JWT_SECRET`                  | Yes      | vouch         | Session JWT signing secret                                       |
| `VOUCH_WHITELIST`                   | Yes      | vouch         | Comma-separated email allowlist for Vouch login                  |

#### 2. Data proxy routes (`.env`)

If you have internal APIs that Thor should access with injected credentials, add routes to `.env`:

```bash
DATA_ROUTES=billing,analytics
DATA_ROUTE_billing_UPSTREAM=https://billing.example.com/
DATA_ROUTE_billing_KEY=sk-your-api-key
DATA_ROUTE_billing_HEADER=X-Custom-Auth    # optional, defaults to X-API-Key
DATA_ROUTE_analytics_UPSTREAM=https://analytics.example.com/
DATA_ROUTE_analytics_KEY=sk-your-other-key
```

The data container generates its nginx config from these vars at startup. When `DATA_ROUTES` is empty, it proxies to httpbin.org as a no-op fallback. See `docker/data/default.conf.template.example` for the equivalent static config.

#### 3. Agent context (OpenCode memory)

The bundled agent prompt (`docker/opencode/agents/build.md`) contains only generic behavior rules — no team-specific context. After starting Thor, open the OpenCode web UI and tell Thor about your team in conversation. Ask it to remember key facts — Thor writes them to its persistent memory directory automatically. Things to tell it:

- Your team name, Slack bot ID, and key channel IDs
- Team members — names, Slack IDs, GitHub usernames, and roles
- Which repos are mounted, default branches, CI conventions
- If using the data proxy, the available routes and their API schemas

#### 4. Source repos

Exec into the remote-cli container to clone repos — this runs as the `thor` user with the correct PAT credentials, avoiding permission issues:

```bash
docker compose exec remote-cli git clone https://github.com/your-org/your-repo.git /workspace/repos/your-repo
```

Repos in `/workspace/repos/` are mounted read-only into OpenCode. Thor creates worktrees under `/workspace/worktrees/` for code changes.

#### 5. Per-workspace MCP servers

Slack is available globally (configured in the base `docker/opencode/opencode.json`). Other MCP servers are configured **per repo** via `.opencode/opencode.json` in the repo root.

```bash
# Example: give a repo access to Atlassian and Grafana
mkdir -p docker-volumes/workspace/repos/your-repo/.opencode
cat > docker-volumes/workspace/repos/your-repo/.opencode/opencode.json << 'EOF'
{
  "mcp": {
    "atlassian": {
      "type": "remote",
      "url": "http://proxy:3010/mcp",
      "enabled": true
    },
    "grafana": {
      "type": "remote",
      "url": "http://proxy:3013/mcp",
      "enabled": true
    }
  }
}
EOF
```

Available MCP servers (all policy-proxied):

| Name      | URL                     | Tools                       |
| --------- | ----------------------- | --------------------------- |
| slack     | `http://proxy:3012/mcp` | Messaging, progress updates |
| atlassian | `http://proxy:3010/mcp` | Jira issues, Confluence     |
| posthog   | `http://proxy:3011/mcp` | Product analytics           |
| grafana   | `http://proxy:3013/mcp` | Loki/Tempo log queries      |

OpenCode merges per-repo config with the global config. A repo without `.opencode/` gets only Slack.

#### 6. Cron jobs (optional)

Add scheduled prompts to `docker-volumes/workspace/cron/crontab`. Each line triggers Thor with a prompt on a schedule. See `docs/plan/2026031204_cron-triggers.md` for examples.

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all services in dev mode (watch)
pnpm dev

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Type checking
pnpm typecheck

# Format code
pnpm format
```

### Project Structure

```
thor/
├── packages/
│   ├── common/        # Shared: logging (pino), Zod schemas, worklog utilities
│   ├── gateway/       # Webhook ingestion, event queue, trigger orchestration
│   ├── runner/        # OpenCode session management, progress streaming
│   ├── proxy/         # MCP policy proxy (one instance per integration)
│   ├── slack-mcp/     # Slack MCP server + progress message manager
│   └── remote-cli/  # Git/GitHub CLI proxy with credential isolation
├── docker/
│   ├── opencode/      # OpenCode container image
│   ├── ingress/       # Nginx ingress config
│   ├── cron/          # BusyBox crond for scheduled prompts
│   └── data/          # Internal API credential proxy
├── docs/
│   ├── feat/          # Feature specs and architecture
│   └── plan/          # Implementation plans (chronological)
├── scripts/           # Test and utility scripts
├── docker-compose.yml
├── Dockerfile         # Multi-stage build for all Node.js services
└── AGENTS.md          # AI agent workflow instructions
```

### Proxy Configuration

Each integration has a policy config file (e.g., `proxy.atlassian.json`):

```json
{
  "upstream": {
    "url": "https://mcp.atlassian.com/v1/mcp",
    "headers": {
      "Authorization": "Basic ${ATLASSIAN_BASIC_AUTH}"
    }
  },
  "allow": ["get_issue", "list_issues", "list_projects"]
}
```

The allow list uses exact tool names. Environment variables in headers are interpolated at startup. Unmatched tools are blocked, and all decisions are audit-logged.

### Proxy Instances

| Port | Config                 | Upstream             |
| ---- | ---------------------- | -------------------- |
| 3010 | `proxy.atlassian.json` | Atlassian hosted MCP |
| 3011 | `proxy.posthog.json`   | PostHog hosted MCP   |
| 3012 | `proxy.slack.json`     | `slack-mcp:3003`     |
| 3013 | `proxy.grafana.json`   | `grafana-mcp:8000`   |

Environment variables are documented in the Deployment Configuration section above.

## Security

Thor runs an AI agent with access to external APIs, so security is enforced in layers — no single component is trusted in isolation.

### Credential Isolation

Each service holds only the credentials it needs. OpenCode has no direct access to any API token.

- **Proxy** — Injects API keys into upstream MCP requests via config-time `${ENV_VAR}` interpolation. Credentials never reach OpenCode.
- **remote-cli** — Injects `GITHUB_PAT` at execution time via `GIT_ASKPASS` (a temporary script). The PAT is never passed as a CLI argument or environment variable visible to the git process.
- **data** — Nginx sidecar that injects API keys into proxied requests. Routes are configured via `DATA_ROUTES` env vars in `.env` (see `.env.example`). The entrypoint generates the nginx config at startup — no manual template editing needed. Falls back to httpbin.org when no routes are set. **Trade-off:** the data container receives the full `.env` via `env_file` so that admins can add new proxy targets without editing `docker-compose.yml`. This means all env vars (including unrelated secrets like `SLACK_BOT_TOKEN`) are visible inside the container. This is acceptable because the data container runs stock nginx, which does not expose environment variables to proxied requests or logs. If stricter isolation is needed, use a dedicated `data.env` file instead.
- **slack-mcp** — Holds `SLACK_BOT_TOKEN` exclusively; no other service touches Slack's API directly.

### Tool Policy Enforcement

The proxy sits between OpenCode and every upstream MCP server. Each proxy instance loads an allow-list of exact tool names from its config file.

- Tools not in the allow-list are **never listed** to OpenCode and **never executed**
- Blocked calls return an error: `"Unknown tool: <name>"`
- Policy drift detection at startup — if an allow-list entry doesn't match any upstream tool, the proxy warns (dev) or refuses to start (production)
- remote-cli blocks `clone` and `init` commands server-side — Thor can only work with repos that an admin has explicitly cloned into `/workspace/repos/`. This prevents the agent from fetching arbitrary repositories that could contain malicious instructions or prompt injection in READMEs, issue templates, or commit messages

### Webhook Authentication

- **Slack** — HMAC-SHA256 signature verification using `crypto.timingSafeEqual` with configurable timestamp tolerance (default 300s)

### SSO and Access Control

- **Vouch Proxy** — Google OAuth SSO in front of OpenCode's web UI
- **Nginx ingress** — `auth_request` directive validates sessions via Vouch; unauthenticated users are redirected to login
- **Unprotected paths** — Only `/slack/*` (webhook endpoint with its own auth) and static assets bypass SSO

### Non-Root Containers

All custom-built containers run as a dedicated `thor` user (uid/gid 1001) instead of root. This limits the blast radius if a container is compromised — the process cannot modify system files, install packages, or escalate privileges. The only exception is the cron container, which requires root for `crond`.

### Network Isolation

All internal services bind to `127.0.0.1` in Docker Compose. Only the ingress proxy (port 8080) is exposed to the network. Inter-service communication happens over Docker's internal network.

### Filesystem Sandboxing

OpenCode's container mounts are scoped:

| Mount                  | Access     | Purpose                                   |
| ---------------------- | ---------- | ----------------------------------------- |
| `/workspace/cron`      | read-write | Crontab for scheduled jobs                |
| `/workspace/memory`    | read-write | Persistent agent memory                   |
| `/workspace/repos`     | read-only  | Source code — cannot be modified directly |
| `/workspace/worklog`   | read-only  | Audit logs — cannot be tampered with      |
| `/workspace/worktrees` | read-write | Git worktrees for changes                 |

### Audit Logging

Every proxy tool call is logged to day-partitioned JSON files under `/workspace/worklog/`:

```
worklog/2026-03-12/json/1710244800000_tool-call_list-issues.json
```

Each record includes: tool name, decision (`allowed`/`blocked`), arguments (truncated to 4KB), result (truncated to 4KB), duration, and any error. All services also emit structured JSON logs via pino.

### Input Validation

Zod schemas validate requests at every service boundary:

- Gateway validates Slack event envelopes before processing
- Runner validates trigger requests (`prompt`, `correlationKey`, `sessionId`)
- slack-mcp enforces upper bounds on thread reads (200 replies), channel history (100 messages), and file downloads (20MB)
- Progress events from the runner are validated against a discriminated union schema before forwarding

## Testing

```bash
pnpm test              # Unit tests (vitest)
pnpm test:proxy        # Integration: proxy → upstream MCP
pnpm test:e2e          # End-to-end via Docker Compose
```
