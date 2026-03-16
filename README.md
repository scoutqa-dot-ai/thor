# Thor

An event-driven AI team member that monitors Slack, GitHub, Linear, and PostHog, then takes action through OpenCode sessions with policy-enforced tool access.

## Architecture

```
                        ┌─────────┐
                        │ ingress │ :8080
                        │ (nginx) │
                        └────┬────┘
                  ┌──────────┴──────────┐
                  ▼                      ▼
           ┌──────────┐          ┌───────────┐
           │ gateway  │ :3002    │ opencode  │ :4096
           │ webhooks │          │ AI engine │
           └────┬─────┘          └─────┬─────┘
                │                      │ MCP
                ▼                      ▼
           ┌─────────┐           ┌──────────┐
           │ runner  │ :3000     │  proxy   │ :3010–3014
           │ sessions│           │ policy   │
           └─────────┘           └────┬─────┘
                                      │
                    ┌────────┬────────┼────────┬────────┐
                    ▼        ▼        ▼        ▼        ▼
                 Linear  PostHog    Slack    GitHub    Git
                 (hosted) (hosted)   MCP    (hosted)   MCP
                                    :3003             :3004
```

Gateway receives events and triggers the runner. OpenCode connects to proxy instances for tool access.

## Services

| Service       | Port      | Package           | Role                                                                     |
| ------------- | --------- | ----------------- | ------------------------------------------------------------------------ |
| **ingress**   | 8080      | `docker/ingress`  | Nginx reverse proxy with Vouch SSO                                       |
| **gateway**   | 3002      | `@thor/gateway`   | Slack & GitHub webhook ingestion, event batching, trigger orchestration  |
| **runner**    | 3000      | `@thor/runner`    | OpenCode session management, prompt execution, NDJSON progress streaming |
| **opencode**  | 4096      | Docker image      | AI agent runtime (headless server)                                       |
| **proxy**     | 3010–3014 | `@thor/proxy`     | MCP tool allow-listing, credential injection, audit logging              |
| **slack-mcp** | 3003      | `@thor/slack-mcp` | Slack API MCP server, progress message lifecycle                         |
| **git-mcp**   | 3004      | `@thor/git-mcp`   | Git command execution with PAT credential isolation                      |
| **data**      | 3080      | `docker/data`     | Nginx credential proxy for internal APIs (requires custom config)        |
| **vouch**     | 9090      | `docker/vouch`    | OAuth/SSO authentication proxy                                           |

## How It Works

1. **Events arrive** — Slack mentions and GitHub webhooks hit the gateway
2. **Smart batching** — Events are queued per correlation key (e.g., Slack thread) with configurable delays (3s for direct mentions, 60s for unaddressed messages and GitHub events)
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
export GITHUB_PAT=github_pat_...
export LINEAR_API_KEY=lin_api_...
export POSTHOG_API_KEY=phx_...
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_SIGNING_SECRET=...
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

| Variable                            | Required | Service            | Purpose                                                          |
| ----------------------------------- | -------- | ------------------ | ---------------------------------------------------------------- |
| `DATA_ROUTES`                       | No       | data               | Comma-separated list of data proxy routes (see below)            |
| `GIT_USER_NAME`                     | No       | git-mcp            | Git author name (default: `thor`)                                |
| `GIT_USER_EMAIL`                    | No       | git-mcp            | Git author email (default: `thor@localhost`)                     |
| `GITHUB_PAT`                        | Yes      | proxy, git-mcp     | GitHub fine-grained PAT                                          |
| `INGRESS_PORT`                      | No       | ingress            | Host port (default: `8080`)                                      |
| `LINEAR_API_KEY`                    | Yes      | proxy              | Linear API access                                                |
| `OPENCODE_URL`                      | No       | runner             | OpenCode server URL (default: `http://opencode:4096`)            |
| `POSTHOG_API_KEY`                   | Yes      | proxy              | PostHog API access                                               |
| `SESSION_CWD`                       | No       | runner             | Working directory for new sessions (default: `/workspace`)       |
| `SLACK_ALLOWED_CHANNEL_IDS`         | No       | gateway, slack-mcp | Comma-separated channel IDs to restrict the bot to               |
| `SLACK_BOT_TOKEN`                   | Yes      | slack-mcp          | Slack app bot token (`xoxb-...`)                                 |
| `SLACK_SIGNING_SECRET`              | Yes      | gateway            | Webhook signature verification                                   |
| `SLACK_TIMESTAMP_TOLERANCE_SECONDS` | No       | gateway            | Signature timestamp tolerance (default: `300`)                   |
| `VOUCH_CALLBACK_URL`                | No       | vouch              | OAuth callback URL (default: `http://localhost:8080/vouch/auth`) |
| `VOUCH_COOKIE_DOMAIN`               | No       | vouch              | Cookie domain (default: `localhost`)                             |
| `VOUCH_GOOGLE_CLIENT_ID`            | Yes      | vouch              | Google OAuth client ID                                           |
| `VOUCH_GOOGLE_CLIENT_SECRET`        | Yes      | vouch              | Google OAuth client secret                                       |
| `VOUCH_JWT_SECRET`                  | Yes      | vouch              | Session JWT signing secret                                       |
| `VOUCH_WHITELIST`                   | Yes      | vouch              | Comma-separated email allowlist for Vouch login                  |

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

Exec into the git-mcp container to clone repos — this runs as the `thor` user with the correct PAT credentials, avoiding permission issues:

```bash
docker compose exec git-mcp git clone https://github.com/your-org/your-repo.git /workspace/repos/your-repo
```

Repos in `/workspace/repos/` are mounted read-only into OpenCode. Thor creates worktrees under `/workspace/worktrees/` for code changes.

#### 5. GitHub webhook setup

Copy `docs/notify-thor.example.yml` to `.github/workflows/notify-thor.yml` in any source repository you want Thor to monitor. Add `THOR_GATEWAY_URL` as a repository variable pointing to the gateway endpoint.

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
│   └── git-mcp/       # Git MCP server with credential isolation
├── docker/
│   ├── opencode/      # OpenCode container image
│   ├── ingress/       # Nginx ingress config
│   ├── vouch/         # Vouch SSO proxy config
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

Each integration has a policy config file (e.g., `proxy.linear.json`):

```json
{
  "upstream": {
    "url": "https://mcp.linear.app/mcp",
    "headers": {
      "Authorization": "Bearer ${LINEAR_API_KEY}"
    }
  },
  "allow": ["get_issue", "list_issues", "list_teams"]
}
```

The allow list uses exact tool names. Environment variables in headers are interpolated at startup. Unmatched tools are blocked, and all decisions are audit-logged.

### Proxy Instances

| Port | Config               | Upstream           |
| ---- | -------------------- | ------------------ |
| 3010 | `proxy.linear.json`  | Linear hosted MCP  |
| 3011 | `proxy.posthog.json` | PostHog hosted MCP |
| 3012 | `proxy.slack.json`   | `slack-mcp:3003`   |
| 3013 | `proxy.github.json`  | GitHub hosted MCP  |
| 3014 | `proxy.git.json`     | `git-mcp:3004`     |

Environment variables are documented in the Deployment Configuration section above.

## Security

Thor runs an AI agent with access to external APIs, so security is enforced in layers — no single component is trusted in isolation.

### Credential Isolation

Each service holds only the credentials it needs. OpenCode has no direct access to any API token.

- **Proxy** — Injects API keys into upstream MCP requests via config-time `${ENV_VAR}` interpolation. Credentials never reach OpenCode.
- **git-mcp** — Injects `GITHUB_PAT` at execution time via `GIT_ASKPASS` (a temporary script). The PAT is never passed as a CLI argument or environment variable visible to the git process.
- **data** — Nginx sidecar that injects API keys into proxied requests. Routes are configured via `DATA_ROUTES` env vars in `.env` (see `.env.example`). The entrypoint generates the nginx config at startup — no manual template editing needed. Falls back to httpbin.org when no routes are set. **Trade-off:** the data container receives the full `.env` via `env_file` so that admins can add new proxy targets without editing `docker-compose.yml`. This means all env vars (including unrelated secrets like `SLACK_BOT_TOKEN`) are visible inside the container. This is acceptable because the data container runs stock nginx, which does not expose environment variables to proxied requests or logs. If stricter isolation is needed, use a dedicated `data.env` file instead.
- **slack-mcp** — Holds `SLACK_BOT_TOKEN` exclusively; no other service touches Slack's API directly.

### Tool Policy Enforcement

The proxy sits between OpenCode and every upstream MCP server. Each proxy instance loads an allow-list of exact tool names from its config file.

- Tools not in the allow-list are **never listed** to OpenCode and **never executed**
- Blocked calls return an error: `"Unknown tool: <name>"`
- Policy drift detection at startup — if an allow-list entry doesn't match any upstream tool, the proxy warns (dev) or refuses to start (production)
- git-mcp blocks `clone` and `init` commands server-side — Thor can only work with repos that an admin has explicitly cloned into `/workspace/repos/`. This prevents the agent from fetching arbitrary repositories that could contain malicious instructions or prompt injection in READMEs, issue templates, or commit messages

### Webhook Authentication

- **Slack** — HMAC-SHA256 signature verification using `crypto.timingSafeEqual` with configurable timestamp tolerance (default 300s)
- **GitHub** — Events are delivered via GitHub Actions workflow (`notify-thor.example.yml`), not direct webhooks, so payloads arrive from a trusted CI context

### SSO and Access Control

- **Vouch Proxy** — Google OAuth SSO in front of OpenCode's web UI
- **Nginx ingress** — `auth_request` directive validates sessions via Vouch; unauthenticated users are redirected to login
- **Unprotected paths** — Only `/slack/*` and `/github/*` (webhook endpoints with their own auth) and static assets bypass SSO

### Non-Root Containers

All custom-built containers run as a dedicated `thor` user (uid/gid 1001) instead of root. This limits the blast radius if a container is compromised — the process cannot modify system files, install packages, or escalate privileges. The only exception is the cron container, which requires root for `crond`.

### Network Isolation

All internal services bind to `127.0.0.1` in Docker Compose. Only the ingress proxy (port 8080) is exposed to the network. Inter-service communication happens over Docker's internal network.

### Filesystem Sandboxing

OpenCode's container mounts are scoped:

| Mount                  | Access     | Purpose                                   |
| ---------------------- | ---------- | ----------------------------------------- |
| `/workspace/repos`     | read-only  | Source code — cannot be modified directly |
| `/workspace/worktrees` | read-write | Git worktrees for changes                 |
| `/workspace/worklog`   | read-only  | Audit logs — cannot be tampered with      |

### Audit Logging

Every proxy tool call is logged to day-partitioned JSON files under `/workspace/worklog/`:

```
worklog/2026-03-12/json/1710244800000_tool-call_list-issues.json
```

Each record includes: tool name, decision (`allowed`/`blocked`), arguments (truncated to 4KB), result (truncated to 4KB), duration, and any error. All services also emit structured JSON logs via pino.

### Input Validation

Zod schemas validate requests at every service boundary:

- Gateway validates Slack event envelopes and GitHub payloads before processing
- Runner validates trigger requests (`prompt`, `correlationKey`, `sessionId`)
- slack-mcp enforces upper bounds on thread reads (200 replies), channel history (100 messages), and file downloads (20MB)
- Progress events from the runner are validated against a discriminated union schema before forwarding

## Testing

```bash
pnpm test              # Unit tests (vitest)
pnpm test:proxy        # Integration: proxy → upstream MCP
pnpm test:e2e          # End-to-end via Docker Compose
```
