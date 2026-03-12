# Thor

AI team member for the Acme team — an event-driven agent that monitors Slack, GitHub, Linear, and PostHog, then takes action through OpenCode sessions with policy-enforced tool access.

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
| **data**      | 3080      | `docker/data`     | Nginx credential proxy for internal Acme APIs                           |
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
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_SIGNING_SECRET=...
export LINEAR_API_KEY=lin_api_...
export POSTHOG_API_KEY=phx_...
export GITHUB_PAT=github_pat_...
export OAUTH_CLIENT_ID=...
export OAUTH_CLIENT_SECRET=...
export SSO_JWT_SECRET=...

# Start all services
docker compose up --build -d

# Verify health
curl http://localhost:8080/health

# View logs
docker compose logs -f

# Stop
docker compose down
```

### GitHub Webhook Setup

Copy `docs/notify-thor.example.yml` to `.github/workflows/notify-thor.yml` in any source repository you want Thor to monitor. Add `THOR_GATEWAY_URL` as a repository secret pointing to the gateway endpoint.

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

## Environment Variables

### Required

| Variable               | Service        | Description                          |
| ---------------------- | -------------- | ------------------------------------ |
| `SLACK_BOT_TOKEN`      | slack-mcp      | Slack app bot token (`xoxb-...`)     |
| `SLACK_SIGNING_SECRET` | gateway        | Slack webhook signature verification |
| `LINEAR_API_KEY`       | proxy          | Linear API access                    |
| `POSTHOG_API_KEY`      | proxy          | PostHog API access                   |
| `GITHUB_PAT`           | proxy, git-mcp | GitHub fine-grained PAT              |
| `OAUTH_CLIENT_ID`      | vouch          | OAuth provider client ID             |
| `OAUTH_CLIENT_SECRET`  | vouch          | OAuth provider client secret         |
| `SSO_JWT_SECRET`       | vouch          | Session JWT signing secret           |

### Optional

| Variable                            | Default                 | Description                         |
| ----------------------------------- | ----------------------- | ----------------------------------- |
| `INGRESS_PORT`                      | `8080`                  | Host port for ingress               |
| `OPENCODE_URL`                      | `http://127.0.0.1:4096` | OpenCode server URL                 |
| `SLACK_TIMESTAMP_TOLERANCE_SECONDS` | `300`                   | Slack signature timestamp tolerance |

## Security

Thor runs an AI agent with access to external APIs, so security is enforced in layers — no single component is trusted in isolation.

### Credential Isolation

Each service holds only the credentials it needs. OpenCode has no direct access to any API token.

- **Proxy** — Injects API keys into upstream MCP requests via config-time `${ENV_VAR}` interpolation. Credentials never reach OpenCode.
- **git-mcp** — Injects `GITHUB_PAT` at execution time via `GIT_ASKPASS` (a temporary script). The PAT is never passed as a CLI argument or environment variable visible to the git process.
- **data** — Nginx sidecar that injects internal Acme API keys into proxied requests.
- **slack-mcp** — Holds `SLACK_BOT_TOKEN` exclusively; no other service touches Slack's API directly.

### Tool Policy Enforcement

The proxy sits between OpenCode and every upstream MCP server. Each proxy instance loads an allow-list of exact tool names from its config file.

- Tools not in the allow-list are **never listed** to OpenCode and **never executed**
- Blocked calls return an error: `"Unknown tool: <name>"`
- Policy drift detection at startup — if an allow-list entry doesn't match any upstream tool, the proxy warns (dev) or refuses to start (production)
- git-mcp additionally blocks `clone` and `init` commands server-side; all repos are pre-mounted

### Webhook Authentication

- **Slack** — HMAC-SHA256 signature verification using `crypto.timingSafeEqual` with configurable timestamp tolerance (default 300s)
- **GitHub** — Events are delivered via GitHub Actions workflow (`notify-thor.example.yml`), not direct webhooks, so payloads arrive from a trusted CI context

### SSO and Access Control

- **Vouch Proxy** — Google OAuth SSO in front of OpenCode's web UI
- **Nginx ingress** — `auth_request` directive validates sessions via Vouch; unauthenticated users are redirected to login
- **Unprotected paths** — Only `/slack/*` and `/github/*` (webhook endpoints with their own auth) and static assets bypass SSO

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
