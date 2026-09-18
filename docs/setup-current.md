# Thor & Mission Control — Current Setup

**Last updated:** 2026-03-30
**Domains:** `thor.huytieu.com` · `mc.huytieu.com`

---

## Overview

**Thor** is a self-hosted, event-driven AI team member that monitors Slack, GitHub, Linear, PostHog, and Grafana — then takes autonomous action through OpenCode sessions with policy-enforced tool access. It runs as a Docker Compose stack of 12 services.

**Mission Control** (`mc.huytieu.com`) is the visual task board and scheduler UI (from [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control)) used to dispatch work to Thor via a Kanban board, replacing cron-based Slack triggers with trackable tasks.

---

## Domains & Access

| Domain | Service | Auth | Port (internal) |
|--------|---------|------|-----------------|
| `thor.huytieu.com` | OpenCode web UI (via ingress) | Google SSO (Vouch Proxy) | 8080 → 4096 |
| `mc.huytieu.com` | Mission Control dashboard | Built-in login | 3100 → 3000 |

Thor's ingress uses **Vouch Proxy** with Google OAuth. Whitelisted emails are configured via `VOUCH_WHITELIST`. Slack/GitHub webhook paths (`/slack/`, `/github/`) and health checks bypass auth.

---

## Architecture

```
                        ┌─────────┐
                        │ ingress │  ← thor.huytieu.com (nginx + Vouch SSO)
                        │  :8080  │
                        └────┬────┘
              ┌──────────┬───┴────────┐
              ▼          ▼            ▼
       ┌──────────┐ ┌──────────┐ ┌───────────┐
       │ gateway  │ │ mission  │ │ opencode  │
       │ :3002    │ │ control  │ │ :4096     │
       │ webhooks │ │ :3100    │ │ AI engine │
       └────┬─────┘ └────┬─────┘ └──┬─────┬──┘
            │             │      MCP │     │ CLI
            │        ┌────┘          ▼     ▼
            ▼        ▼       ┌──────────┐  ┌──────────────┐
       ┌─────────────────┐   │  proxy   │  │ remote-cli   │
       │     runner      │   │ :3010-13 │  │ :3004        │
       │    :3000        │   │ policy   │  │ git/gh CLI   │
       └─────────────────┘   └────┬─────┘  └──────────────┘
                       ┌──────────┼──────────┬──────────┐
                       ▼          ▼          ▼          ▼
                    Linear     PostHog     Slack     Grafana
                    (proxy)    (proxy)      MCP       MCP
```

---

## Services (12 total)

| # | Service | Port | Image / Package | Role |
|---|---------|------|----------------|------|
| 1 | **ingress** | 8080 | `docker/ingress` (nginx) | Reverse proxy with Vouch SSO. Routes `/slack/` and `/github/` to gateway, everything else to opencode |
| 2 | **vouch** | 9090 | `quay.io/vouch/vouch-proxy:0.45.1` | Google OAuth SSO proxy. Cookie-based auth with JWT, 3-day max age |
| 3 | **opencode** | 4096 | Docker image (headless server) | AI agent runtime. Model: `opencode/big-pickle`. 4GB RAM / 3 CPU limit. Connects to 4 MCP proxies |
| 4 | **runner** | 3000 | `@thor/runner` | OpenCode session management. Maps correlation keys to persistent sessions. NDJSON progress streaming |
| 5 | **gateway** | 3002 | `@thor/gateway` | Slack & GitHub webhook ingestion. Smart batching (3s for @mentions, 60s for ambient, immediate for cron) |
| 6 | **proxy** | 3010–3013 | `@thor/proxy` | MCP tool allow-listing, credential injection, audit logging. 4 instances: Linear, PostHog, Slack, Grafana |
| 7 | **slack-mcp** | 3003 | `@thor/slack-mcp` | Slack API as MCP server. Handles progress message lifecycle |
| 8 | **remote-cli** | 3004 | `@thor/remote-cli` | Git/GitHub CLI proxy with PAT credential isolation |
| 9 | **grafana-mcp** | 8000 | `grafana/mcp-grafana:0.11.3` | Grafana MCP server for Loki/Tempo queries via streamable-http |
| 10 | **data** | 3080 | `docker/data` (nginx) | Credential-injecting reverse proxy for internal APIs |
| 11 | **cron** | — | `docker/cron` (BusyBox) | Scheduled `hey-thor` prompts via crond. Posts to gateway `/cron` endpoint |
| 12 | **mission-control** | 3100 | `ghcr.io/builderz-labs/mission-control:latest` | Next.js + SQLite Kanban board and task scheduler UI |
| 13 | **mc-bridge** | — | `@thor/mission-control` | Polls MC task queue, dispatches to runner, reports status back. Registers Thor as agent named `thor` |

---

## MCP Proxy Configuration

OpenCode connects to 4 MCP proxies, each with tool allow-listing and credential injection:

| Proxy Port | Config File | Upstream |
|-----------|-------------|----------|
| 3010 | `proxy.linear.json` | Linear API (via `LINEAR_API_KEY`) |
| 3011 | `proxy.posthog.json` | PostHog API (via `POSTHOG_API_KEY`) |
| 3012 | `proxy.slack.json` | Slack MCP (`http://slack-mcp:3003`) |
| 3013 | `proxy.grafana.json` | Grafana MCP (`http://grafana-mcp:8000`) |

OpenCode config (`opencode.json`):
```json
{
  "model": "opencode/big-pickle",
  "permission": "allow",
  "mcp": {
    "linear":  { "type": "remote", "url": "http://proxy:3010/mcp" },
    "posthog": { "type": "remote", "url": "http://proxy:3011/mcp" },
    "slack":   { "type": "remote", "url": "http://proxy:3012/mcp" },
    "grafana": { "type": "remote", "url": "http://proxy:3013/mcp" }
  }
}
```

---

## Event Flow

1. **Events arrive** — Slack @mentions, GitHub webhooks, cron schedules, or Mission Control tasks
2. **Smart batching** — Gateway queues events per correlation key with configurable delays:
   - Direct @mentions: 3s delay
   - Ambient Slack messages: 60s delay
   - GitHub events: 60s delay
   - Cron jobs: immediate
3. **Session continuity** — Runner maps correlation keys to persistent OpenCode sessions
4. **Policy-enforced tools** — OpenCode calls tools through proxy instances with allow-lists and audit logging
5. **Progress visibility** — Tool activity streams back to Slack as live-updating progress messages

---

## Mission Control Integration

**Status:** In Progress (as of 2026-03-27)

MC runs as a separate service (`mc.huytieu.com`) with the `mc-bridge` package connecting it to Thor:

- Bridge registers Thor as an agent on startup (`MC_AGENT_NAME=thor`)
- Polls `GET /api/tasks/queue` every 10s (configurable via `MC_POLL_INTERVAL_MS`)
- Dispatches tasks to runner's `POST /trigger` endpoint
- Reports completion/failure back via `PATCH /api/tasks/:id`
- SQLite data persisted in `docker-volumes/mission-control/`

### Recurring Task Templates
- **Daily standup summary** — weekdays 9:00 UTC, checks GitHub PRs + Linear issues + Slack decisions
- **Error spike monitor** — every 6h, checks PostHog error rates
- **Weekly retrospective** — Fridays 16:00 UTC, summarizes week's PRs and issues
- **Dependency audit** — Mondays 7:00 UTC, checks outdated deps and security advisories

---

## Cron System (`hey-thor`)

BusyBox crond runs scheduled prompts via the `hey-thor` script:

```sh
hey-thor [--key <correlation-key>] '<prompt>'
```

Posts JSON to `${GATEWAY_URL}/cron` with `Authorization: Bearer ${CRON_SECRET}`. Cron jobs are defined in `docker-volumes/workspace/cron/` (mounted read-only).

---

## Volume Mounts

| Host Path | Container Mount | Purpose |
|-----------|----------------|---------|
| `docker-volumes/home/thor` | `/home/thor` | Remote-cli home directory |
| `docker-volumes/workspace` | `/workspace` | Shared workspace (repos, memory, worklogs, cron configs) |
| `docker-volumes/opencode` | `/home/thor/.local/share/opencode` | OpenCode persistent data |
| `docker-volumes/mission-control` | `/app/.data` | Mission Control SQLite database |

---

## Environment Variables

### Required
| Variable | Service | Purpose |
|----------|---------|---------|
| `SLACK_BOT_TOKEN` | slack-mcp | Slack bot OAuth token (`xoxb-...`) |
| `SLACK_BOT_USER_ID` | gateway | Bot user ID for mention detection |
| `SLACK_SIGNING_SECRET` | gateway | Webhook signature verification |
| `GITHUB_PAT` | remote-cli | GitHub Personal Access Token |
| `LINEAR_API_KEY` | proxy | Linear workspace API key |
| `POSTHOG_API_KEY` | proxy | PostHog personal API key |
| `GRAFANA_URL` | grafana-mcp | Grafana instance URL |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | grafana-mcp | Grafana service account token |
| `CRON_SECRET` | gateway, cron | Shared secret for cron job auth |
| `VOUCH_GOOGLE_CLIENT_ID` | vouch | Google OAuth client ID |
| `VOUCH_GOOGLE_CLIENT_SECRET` | vouch | Google OAuth client secret |
| `VOUCH_JWT_SECRET` | vouch | JWT signing secret |
| `VOUCH_WHITELIST` | vouch | Comma-separated allowed emails |

### Optional
| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCODE_MEMORY_LIMIT` | `4g` | OpenCode container memory limit |
| `OPENCODE_CPU_LIMIT` | `3` | OpenCode container CPU limit |
| `SESSION_CWD` | — | Working directory for sessions |
| `INGRESS_PORT` | `8080` | Host port for ingress |
| `MC_API_KEY` | — | Mission Control API key |
| `MC_POLL_INTERVAL_MS` | `10000` | MC bridge polling interval |
| `SLACK_ALLOWED_CHANNEL_IDS` | — | Restrict bot to specific channels |
| `GIT_USER_NAME` | `thor` | Git commit author name |
| `GIT_USER_EMAIL` | `thor@localhost` | Git commit author email |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Docker Compose, Node.js 22+, pnpm 9.x monorepo |
| AI Engine | OpenCode (headless server, `opencode/big-pickle` model) |
| Task Board | Mission Control (Next.js + SQLite) |
| Auth | Vouch Proxy + Google OAuth |
| Ingress | Nginx |
| MCP Servers | Custom proxy (Linear, PostHog), Slack MCP, Grafana MCP |
| Scheduling | BusyBox crond + Mission Control scheduler |
| Observability | Grafana (Loki/Tempo via MCP) |

---

## Commands

```bash
# Start everything
docker compose up --build -d

# View logs
docker compose logs -f

# Run E2E tests
./scripts/test-e2e.sh

# Stop
docker compose down

# Dev mode (local)
pnpm dev
```

---

## Packages (pnpm monorepo)

| Package | Path | Description |
|---------|------|-------------|
| `@thor/common` | `packages/common/` | Shared types and utilities |
| `@thor/gateway` | `packages/gateway/` | Webhook ingestion and event batching |
| `@thor/mission-control` | `packages/mission-control/` | MC bridge — polls tasks, dispatches to runner |
| `@thor/proxy` | `packages/proxy/` | MCP policy proxy with allow-lists and audit logging |
| `@thor/remote-cli` | `packages/remote-cli/` | Git/GitHub CLI proxy with credential isolation |
| `@thor/runner` | `packages/runner/` | OpenCode session management and NDJSON streaming |
| `@thor/slack-mcp` | `packages/slack-mcp/` | Slack API as MCP server |
