# Hermes Personal Assistant — Implementation Plan

**Status:** Phase 1-6 COMPLETE. Awaiting: (1) Slack token scopes fix, (2) Atlassian API token.
**Last updated:** 2026-03-30T15:50Z
**VM:** `azureuser@40.65.145.234` — `/home/azureuser/thor/`

---

## Overview

Hermes is Huy's personal AI agent running on the same Azure VM as Thor, reachable via Telegram. It has read-only access to Slack, Jira, Confluence, GitHub, and Grafana — plus read/write access to Huy's personal Obsidian vault (synced via git).

## Architecture

```
Azure VM
├── Thor (docker compose) ─── team agent
│   ├── slack-mcp:3003         xoxb- bot token
│   ├── proxy:3010-3013        Linear, PostHog, Slack(bot), Grafana
│   ├── personal-slack-mcp:3020  xoxp- user token
│   └── ... other services
│
├── Hermes (systemd) ─── personal assistant
│   ├── terminal: docker        sandboxed execution
│   ├── gateway: Telegram       allowlist: Huy's ID only
│   ├── cron: 7am daily         morning briefing
│   ├── SOUL.md                 comprehensive persona + context
│   └── MCPs (6 servers)
│       ├── personal-slack      127.0.0.1:3020 (HTTP, read-only)
│       ├── grafana             127.0.0.1:3013 (HTTP, read-only)
│       ├── atlassian-jira      stdio (npx, read-only: jira_get)
│       ├── atlassian-confluence stdio (npx, read-only: conf_get)
│       └── github              stdio (npx, read-only: 14 tools)
│
└── /home/azureuser/light-personal-agent/ ─── Obsidian vault (git clone)
    ├── Auto-pull: */30 * * * * (cron)
    ├── Push: Hermes commits after writing braindumps/meeting notes
    └── Remote: https://github.com/tieuquanghuy/light-personal-agent
```

## Security Constraints

- **Read-only Slack**: No `chat:write` scope, no `post_message` tool. Hermes can read but NOT post.
- **Read-only Jira/Confluence**: Only `jira_get` and `conf_get` tools enabled. No create/update/delete.
- **Read-only GitHub**: Only search, list, and get tools. No push, create PR, or merge capabilities.
- **Token isolation**: All tokens in env files (never logged, never exposed).
- **Network isolation**: HTTP MCPs bound to `127.0.0.1` — not publicly accessible.
- **No auto-posting**: Hermes does NOT post to Slack automatically. Morning briefing goes to Telegram only.
- **Telegram allowlist**: Only Huy's Telegram user ID can interact with the bot.
- **Vault writes OK**: Braindumps, meeting notes, check-ins are personal data — Hermes can write and push these.

---

## Phase 1 — Personal Slack MCP Service ✅ COMPLETE

Build `packages/personal-slack-mcp` — a read-only TypeScript MCP server.

### Files on VM (`/home/azureuser/thor/packages/personal-slack-mcp/`):

| File | Status | Description |
|------|--------|-------------|
| `package.json` | ✅ | Dependencies match `@thor/slack-mcp` pattern |
| `tsconfig.json` | ✅ | Extends `../../tsconfig.base.json` |
| `src/slack-client.ts` | ✅ | Shared WebClient wrapper |
| `src/tools/channels.ts` | ✅ | `list_channels`, `get_channel_history` |
| `src/tools/messages.ts` | ✅ | `search_messages`, `get_thread_replies` |
| `src/tools/dms.ts` | ✅ | `list_dms`, `get_dm_history` |
| `src/tools/users.ts` | ✅ | `list_users`, `get_user_profile` |
| `src/server.ts` | ✅ | MCP Server setup, 8 tools registered with Zod validation |
| `src/index.ts` | ✅ | Express app + streamable HTTP MCP transport on port 3020 |

### Tools (all read-only):

| Tool | Slack API | Zod Schema |
|------|-----------|------------|
| `list_channels` | `conversations.list` | `ListChannelsInput` |
| `get_channel_history` | `conversations.history` | `GetChannelHistoryInput` |
| `search_messages` | `search.messages` | `SearchMessagesInput` |
| `get_thread_replies` | `conversations.replies` | `GetThreadRepliesInput` |
| `list_dms` | `conversations.list` (im,mpim) | `ListDmsInput` |
| `get_dm_history` | `conversations.history` | `GetDmHistoryInput` |
| `list_users` | `users.list` | `ListUsersInput` |
| `get_user_profile` | `users.profile.get` | `GetUserProfileInput` |

### Phase 1 checklist:

- [x] All 9 source files created
- [x] TypeScript compiles cleanly (`pnpm -r build` passes)
- [x] Docker image builds successfully (`docker compose build personal-slack-mcp`)
- [ ] Add `PERSONAL_SLACK_TOKEN` to `.env` on VM (requires manual Slack app setup — Phase 5)
- [ ] `docker compose up personal-slack-mcp -d` (needs token to pass healthcheck)
- [ ] Verify `curl http://localhost:3020/health` returns `200`
- [ ] Verify MCP tools work with real token

---

## Phase 2 — Docker Compose Integration ✅ COMPLETE

All infrastructure changes applied on the VM.

### docker-compose.yml addition (applied):

```yaml
personal-slack-mcp:
  build:
    context: .
    target: personal-slack-mcp
  restart: unless-stopped
  ports:
    - "127.0.0.1:3020:3020"
  environment:
    - NODE_ENV=production
    - PERSONAL_SLACK_TOKEN=${PERSONAL_SLACK_TOKEN}
  healthcheck:
    test: ["CMD", "node", "-e", "fetch('http://localhost:3020/health').then(r=>{if(!r.ok)throw 1})"]
    interval: 5s
    timeout: 3s
    retries: 10
```

### Dockerfile addition (deps stage):

```dockerfile
COPY packages/personal-slack-mcp/package.json packages/personal-slack-mcp/
```

### Dockerfile addition (new target):

```dockerfile
FROM build AS personal-slack-mcp
USER thor
ENV PORT=3020
EXPOSE 3020
CMD ["node", "/app/packages/personal-slack-mcp/dist/index.js"]
```

### .env.example addition (applied):

```
# Personal Slack MCP (Hermes) — user token for read-only access
# PERSONAL_SLACK_TOKEN=xoxp-...
```

### Phase 2 checklist:

- [x] Dockerfile: added `personal-slack-mcp` package.json to deps stage (line 25)
- [x] Dockerfile: added `personal-slack-mcp` build target (lines 83-87)
- [x] docker-compose.yml: added `personal-slack-mcp` service bound to `127.0.0.1:3020`
- [x] .env.example: added `PERSONAL_SLACK_TOKEN` placeholder
- [x] pnpm-lock.yaml: updated via `pnpm install --no-frozen-lockfile`
- [x] `docker compose build personal-slack-mcp` succeeds
- [ ] `docker compose up personal-slack-mcp -d` (needs token — Phase 5)

### Important: these changes are NOT committed to git yet.

To commit on the VM:
```bash
cd /home/azureuser/thor
git add packages/personal-slack-mcp/ Dockerfile docker-compose.yml .env.example pnpm-lock.yaml
git commit -m "Add personal-slack-mcp package for Hermes read-only Slack access"
```

---

## Phase 3 — Install and Configure Hermes ✅ COMPLETE

**Prerequisite:** Phase 5 credentials must be ready.

Hermes is a **Python agent** (not Node.js). Installed via `uv`/pip. Runs as a systemd user service on the VM host.

### Step 3.1 — Install Hermes

```bash
# On the VM as azureuser
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

This installs to `~/.hermes/hermes-agent/`, creates the `~/.hermes/` directory tree (cron/, sessions/, logs/, pairing/, hooks/, memories/, skills/), and installs Python deps + Node.js + Playwright.

### Step 3.2 — Run interactive setup

```bash
hermes setup
```

During setup, select:
- **Model:** `anthropic/claude-opus-4.6` (or Sonnet for cost efficiency)
- **Terminal backend:** `docker` (sandboxed execution)
- **Provider:** Anthropic (requires `ANTHROPIC_API_KEY` in `~/.hermes/.env`)

### Step 3.3 — Add MCP servers

```bash
hermes mcp add
```

Or manually edit `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  personal-slack:
    url: "http://127.0.0.1:3020/mcp"
    enabled: true

  linear:
    url: "http://127.0.0.1:3010/mcp"
    enabled: true

  posthog:
    url: "http://127.0.0.1:3011/mcp"
    enabled: true

  grafana:
    url: "http://127.0.0.1:3013/mcp"
    enabled: true
```

Hermes auto-detects streamable HTTP from the `url` field — no explicit `transport` key needed.

### Step 3.4 — Write SOUL.md

Create `~/.hermes/SOUL.md`:

```markdown
You are Huy's personal AI assistant. Huy is AI Initiative Lead at Katalon, running the True Platform AI initiative and the Kai agent team.

## Communication style
- Respond in plain text, no markdown formatting (Telegram renders it poorly)
- Be concise and direct
- Vietnamese is fine for casual messages, English for technical content

## Morning Briefing Format
When asked for a morning briefing, cover in order:
1. Slack — summarize messages from last 24h in #ai-platform, any DMs requiring response. Skip FYI threads.
2. Linear — TO project: P0/P1 issues, blocked, overdue, or assigned to Huy
3. PostHog — key metrics: active users, feature adoption vs prior 7 days
4. Grafana — active firing alerts only, not resolved

Keep the full briefing under 15 bullet points total. If nothing notable in a section, say so in one line.

## Safety rules
- NEVER post messages to Slack. You have read-only access.
- NEVER create or modify Linear issues unless Huy explicitly asks.
- NEVER push code, create PRs, or modify repos.
- Thor is a separate AI team member that handles engineering tasks. Don't overlap with Thor.

## Context
- Huy's Slack workspace is Katalon. His team channel is #ai-platform (C09J7CHT0DS).
- When Huy says "create an issue", use Linear. When he says "check metrics", use PostHog.
- The Kai team builds the AI-native testing platform (True Platform).
```

### Step 3.5 — Configure `~/.hermes/.env`

```bash
ANTHROPIC_API_KEY=<key>
TELEGRAM_BOT_TOKEN=<from BotFather>
```

### Step 3.6 — Verify

```bash
hermes mcp configure    # Should list all 4 MCP servers as connected
hermes                  # Interactive CLI — test "list my Slack channels"
```

### Phase 3 checklist:

- [ ] Install Hermes via install script
- [ ] Run `hermes setup` (model, terminal, provider)
- [ ] Add 4 MCP servers to config.yaml
- [ ] Write SOUL.md
- [ ] Add API keys to .env
- [ ] Verify MCP connections
- [ ] Test a query ("list my Slack channels")

---

## Phase 4 — Telegram Gateway + Cron ✅ COMPLETE

### Step 4.1 — Setup Telegram gateway

```bash
hermes gateway setup    # Enter bot token from BotFather
```

### Step 4.2 — Install as systemd service

```bash
hermes gateway install  # Creates ~/.config/systemd/user/hermes-gateway.service
hermes gateway start
hermes gateway status   # Should show active (running)
```

On a headless server (no graphical session), enable linger:
```bash
sudo loginctl enable-linger azureuser
```

### Step 4.3 — Pair your Telegram account

Hermes uses a **cryptographic pairing system** (not a static allowlist):
1. Message the bot from your Telegram account
2. Bot generates an 8-character pairing code
3. Run `hermes` CLI on the VM — it shows the pending pairing request
4. Approve it
5. Your Telegram user ID is saved to `~/.hermes/pairing/telegram-approved.json` (chmod 0600)

Any unapproved users are silently ignored. Max 3 pending codes, 1-hour expiry.

### Step 4.4 — Create morning cron job

```bash
hermes cron create \
  --name "morning-briefing" \
  --schedule "every day at 7am" \
  --prompt "Run my morning briefing" \
  --deliver telegram
```

This stores the job in `~/.hermes/cron/jobs.json`. The gateway service executes cron ticks automatically.

### Step 4.5 — Test

```bash
hermes cron run morning-briefing   # Trigger manually to verify
hermes cron list                    # Should show job as scheduled
```

### Phase 4 checklist:

- [ ] `hermes gateway setup` with Telegram bot token
- [ ] `hermes gateway install` + `hermes gateway start`
- [ ] Enable linger for headless service (`sudo loginctl enable-linger azureuser`)
- [ ] Pair Telegram account (message bot, approve pairing code)
- [ ] Verify Telegram ↔ Hermes communication (send test message)
- [ ] Create morning cron job
- [ ] Verify cron fires (manual run first, then wait for scheduled)

---

## Phase 5 — Credential Provisioning (MANUAL — Huy must do)

### 1. Slack App (User Token)

1. https://api.slack.com/apps → Create New App → From Scratch
2. Name: `Huy Personal MCP`
3. OAuth & Permissions → **User Token Scopes** (NOT Bot Token Scopes):
   - `channels:history`, `channels:read`
   - `groups:history`, `groups:read`
   - `im:history`, `im:read`
   - `mpim:history`, `mpim:read`
   - `search:read`, `users:read`
4. **Do NOT add `chat:write`** — read-only by design
5. Install to Workspace → copy **User OAuth Token** (`xoxp-...`)
6. Add to Thor's `.env` on VM: `PERSONAL_SLACK_TOKEN=xoxp-...`
7. Then: `cd /home/azureuser/thor && docker compose up --build personal-slack-mcp -d`

### 2. Telegram Bot

1. Message @BotFather on Telegram → `/newbot`
2. Name it something like "Hermes Personal"
3. Save the bot token
4. Add to `~/.hermes/.env`: `TELEGRAM_BOT_TOKEN=<token>`

### 3. Anthropic API Key

1. Get key from https://console.anthropic.com/
2. Add to `~/.hermes/.env`: `ANTHROPIC_API_KEY=<key>`

---

## Implementation Order

```
Phase 1 (build personal-slack-mcp)      ✅ DONE
Phase 2 (docker-compose integration)    ✅ DONE
Phase 3 (install Hermes, configure)     ✅ DONE — openai-codex auth, gateway, cron
Phase 4 (Telegram + cron)              ✅ DONE — gateway running, morning cron at 7am UTC
Phase 5 (Slack token)                  ⬜ PENDING — Huy must fix Slack app scopes
Phase 6 (SOUL + vault + MCPs upgrade)  ✅ DONE — 2026-03-30
Phase 7 (Atlassian credentials)        ⬜ PENDING — Huy must provide API token
```

---

## Phase 6 — SOUL + Vault + MCP Upgrade ✅ COMPLETE (2026-03-30)

### What was done:

1. **SOUL.md rewritten** — Comprehensive persona with:
   - Detailed profile of Huy (role, style, people, context)
   - Vault structure and how-to-use guide
   - Capability definitions (morning briefing, braindump, meeting processing, etc.)
   - Communication rules (Telegram-optimized, tone examples)
   - Safety rules (read-only by default, vault writes OK)
   - Integration context (Jira, Slack, Confluence, GitHub, Grafana, PostHog)
   - Current strategic context (True Platform launch April 7)

2. **Obsidian vault cloned** to `/home/azureuser/light-personal-agent/`
   - Git remote configured with GITHUB_PAT for push/pull
   - Auto-pull cron: `*/30 * * * * git pull --ff-only`
   - Hermes can commit and push after writing braindumps/meeting notes
   - User name: "Hermes", email: "hermes@huy.tieu"

3. **MCP servers upgraded** (6 total):
   - `personal-slack` — HTTP, read-only (existing, needs token fix)
   - `grafana` — HTTP, read-only (existing, working)
   - `atlassian-jira` — stdio via npx, **restricted to `jira_get` only**
   - `atlassian-confluence` — stdio via npx, **restricted to `conf_get` only**
   - `github` — stdio via npx, **restricted to 14 read-only tools** (search, list, get)
   - `linear` — **REMOVED** (retired per project decision)

4. **Environment variables added** to `~/.hermes/.env`:
   - `GITHUB_PERSONAL_ACCESS_TOKEN` — reused from Thor's PAT
   - `ATLASSIAN_SITE_NAME=katalon` — pre-configured
   - `ATLASSIAN_USER_EMAIL` — ⬜ NEEDS HUY'S EMAIL
   - `ATLASSIAN_API_TOKEN` — ⬜ NEEDS HUY'S TOKEN

---

## Phase 7 — Remaining Manual Steps (Huy must do)

### 1. Fix Slack Token Scopes

The current `PERSONAL_SLACK_TOKEN` in `/home/azureuser/thor/.env` is missing required scopes.

1. Go to https://api.slack.com/apps → find your app
2. OAuth & Permissions → **User Token Scopes** → add:
   - `channels:history`, `channels:read`
   - `groups:history`, `groups:read`
   - `im:history`, `im:read`
   - `mpim:history`, `mpim:read`
   - `search:read`, `users:read`
3. **Reinstall** the app to workspace
4. Copy new **User OAuth Token** (`xoxp-...`)
5. SSH to VM: `ssh azureuser@40.65.145.234`
6. Update: `nano /home/azureuser/thor/.env` → replace `PERSONAL_SLACK_TOKEN`
7. Restart: `cd /home/azureuser/thor && docker compose restart personal-slack-mcp`

### 2. Provide Atlassian API Token

For Jira and Confluence read access:

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Create API token
3. SSH to VM: `ssh azureuser@40.65.145.234`
4. Edit: `nano /home/azureuser/.hermes/.env`
5. Replace `ATLASSIAN_USER_EMAIL=NEEDS_YOUR_EMAIL` with your Katalon email
6. Replace `ATLASSIAN_API_TOKEN=NEEDS_YOUR_TOKEN` with the token
7. Restart: `export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:$PATH" && hermes gateway restart`

---

## Key Files on VM

| Path | Purpose |
|------|---------|
| `/home/azureuser/.hermes/SOUL.md` | Hermes persona and instructions |
| `/home/azureuser/.hermes/config.yaml` | MCP servers, model, tools config |
| `/home/azureuser/.hermes/.env` | Hermes secrets (Telegram, GitHub, Atlassian) |
| `/home/azureuser/thor/.env` | Thor secrets (includes PERSONAL_SLACK_TOKEN) |
| `/home/azureuser/thor/packages/personal-slack-mcp/` | Personal Slack MCP package |
| `/home/azureuser/light-personal-agent/` | Obsidian vault (git clone, auto-synced) |

## Decision Log

| Decision | Reason |
|----------|--------|
| Read-only (no chat:write) | Hermes should never post as Huy without explicit instruction |
| xoxp- validation at startup | Prevents accidental use of bot token |
| 127.0.0.1 binding | Token never exposed outside VM |
| Separate from Thor's proxy:3012 | Thor proxy uses bot token + allowlist; personal needs user token |
| Hermes pairing (not allowlist) | Hermes uses cryptographic pairing codes, not static user ID lists |
| SOUL.md includes safety rules | Explicitly forbids posting to Slack, creating PRs, modifying repos |
| Jira/Confluence/GitHub read-only | Only GET/search tools enabled — prevents accidental writes |
| Linear removed | Linear retired per project decision (2026-03-18), Jira is primary |
| Vault synced via git | Hermes can read and write to vault, push/pull for bidirectional sync |
| Vault auto-pull every 30 min | Keeps Hermes current with local Obsidian changes |
| GitHub PAT reused from Thor | Single PAT, no credential sprawl |

---

## Troubleshooting

- **Slack MCP errors**: Check `docker compose logs personal-slack-mcp` — likely missing/wrong scopes on `PERSONAL_SLACK_TOKEN`
- **Jira/Confluence "missing credentials"**: Check `ATLASSIAN_*` vars in `~/.hermes/.env`
- **GitHub MCP errors**: Check `GITHUB_PERSONAL_ACCESS_TOKEN` in `~/.hermes/.env`
- **Vault out of date**: Run `cd /home/azureuser/light-personal-agent && git pull`
- **Hermes gateway down**: `export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:$PATH" && hermes gateway status` then `hermes gateway restart`
- **MCP test**: `hermes mcp test <server-name>` to verify connectivity
- **Hermes can't reach HTTP MCPs**: All ports (3013, 3020) are bound to `127.0.0.1` — Hermes must run on the same host
