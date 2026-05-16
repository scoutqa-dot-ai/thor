# Open-Inspect: Background Agents Technical Overview

**Local path**: `/Users/son.dao/repos/daohoangson/background-agents`

**Context**: Background-Agents is an open-source hosted background coding agent system inspired by [Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent). It enables asynchronous code execution in isolated cloud sandboxes, with multi-user collaboration, persistent state, and tight integration with development tools.

---

## 1. Purpose & Positioning

Open-Inspect is a **background coding agent orchestration system** designed for teams that need AI-assisted coding without blocking user attention. Core value propositions:

- **Async-first model**: Fire a prompt, close your laptop, check results later. No real-time supervision required
- **Single-tenant deployment**: All users are trusted org members sharing GitHub App credentials
- **Multiplayer sessions**: Real-time collaboration with commit attribution to individual prompts
- **Parallel execution**: Spawn sub-tasks into independent sandboxes (see Section 5)
- **Broad integrations**: Web UI, Slack, GitHub PRs/issues, Linear, webhooks, cron automations
- **Multi-model flexibility**: Anthropic Claude, OpenAI GPT, OpenCode Zen with per-session reasoning controls

Unlike interactive coding assistants, the system's control plane and data plane operate independently—users can disconnect mid-session and return days later. State persists in Cloudflare Durable Objects; work continues in Modal/Daytona sandboxes.

---

## 2. High-Level Architecture

### Three-Tier Design Spanning Multiple Cloud Providers

**Control Plane** (Cloudflare Workers + Durable Objects)
- Session state coordination: SQLite per session in Durable Objects
- WebSocket multiplexing for real-time streaming to all connected clients
- GitHub integration: OAuth token refresh, PR creation, repo listing
- Authentication: JWT tokens for web clients, webhook keys for automations
- Sandbox orchestration: spawn/restore/snapshot lifecycle management
- Location: Cloudflare global edge network

**Data Plane** (Modal OR Daytona)
- Isolated sandboxes with full dev environments (Node.js 22, Python 3.12, git, browser automation)
- OpenCode agent server running in each session
- **Modal backend** (primary): Container-based, near-instant startup + filesystem snapshot restore
- **Daytona backend** (alternative): Persistent sandboxes with REST API integration
- Bridge component: WebSocket tunnel back to control plane
- Location: Modal Workspace USA / Daytona API (configurable)

**Client Layer**
- **Web UI** (Next.js on Vercel or Cloudflare Workers): Full session control, settings, analytics
- **Slack Bot** (Cloudflare Worker): Message parsing, repo selection, thread-to-session mapping
- **GitHub Bot** (Cloudflare Worker): PR auto-review, @mention comment handling, webhook delivery
- **Linear Bot** (Cloudflare Worker): Issue-to-session creation, activity posting
- **Webhook endpoint**: Trigger automations via authenticated HTTP POST

Architectural diagram from README: Client traffic → Control Plane (D1 for shared state, Durable Objects for per-session SQLite) → Data Plane (full dev environment + OpenCode agent).

---

## 3. Repo Layout

```
background-agents/
├── packages/
│   ├── control-plane/          # Cloudflare Workers (TypeScript)
│   │   └── src/
│   │       ├── router.ts               # HTTP endpoint routing
│   │       ├── auth/                   # JWT, GitHub OAuth, webhook auth, crypto
│   │       ├── scheduler/              # Durable Object for cron automations + session state
│   │       ├── github/                 # GitHub API + App token management
│   │       ├── source-control/         # SCM provider abstraction (GitHub, GitLab future)
│   │       └── (integrations)          # Slack, Linear webhook handlers
│   ├── web/                    # Next.js web client (React/TypeScript)
│   │   └── src/
│   │       ├── app/                    # Route groups: (app), (auth), API routes
│   │       ├── app/(app)/               # Authenticated pages: sessions, settings, automations
│   │       └── app/api/                 # BackendForFrontend: repos, secrets, sessions, auth
│   ├── modal-infra/            # Modal sandbox deployment (Python)
│   │   └── src/
│   │       ├── app.py                  # Modal app definition, image/secrets config
│   │       ├── web_api.py               # FastAPI endpoint for session lifecycle
│   │       ├── sandbox/manager.py       # Sandbox creation, snapshot/restore logic
│   │       ├── images/                  # Image builder for pre-built repo snapshots
│   │       └── scheduler/               # Cron job scheduler (Modal Function)
│   ├── daytona-infra/          # Daytona sandbox orchestration (Python)
│   ├── slack-bot/              # Slack message handler (Cloudflare Worker, TypeScript)
│   ├── github-bot/             # GitHub webhook handler (Cloudflare Worker, TypeScript)
│   ├── linear-bot/             # Linear action handler (Cloudflare Worker, TypeScript)
│   ├── sandbox-runtime/        # Agent tools available inside sandbox (Python)
│   │   └── src/
│   │       ├── tools/          # OpenCode agent tool definitions
│   │       └── webhooks.py      # Slack notification helper
│   └── shared/                 # Types, triggers, automation logic (TypeScript)
│       └── src/
│           ├── types/          # Session, automation, integration types
│           └── triggers/       # Cron, webhook, condition evaluation
├── terraform/                  # Infrastructure-as-code deployment
│   └── environments/production/
│       ├── terraform.tfvars    # Configuration (credentials, model, deployment name)
│       └── *.tf                # Cloudflare, Vercel/Cloudflare, Modal/Daytona resources
├── docs/
│   ├── HOW_IT_WORKS.md         # Detailed architecture & session lifecycle
│   ├── GETTING_STARTED.md      # Terraform deployment walkthrough
│   ├── AUTOMATIONS.md          # Cron + webhook + Sentry triggers
│   ├── SECRETS.md              # Global/repo-scoped secret encryption
│   ├── IMAGE_PREBUILD.md       # Pre-built snapshot rebuild automation
│   ├── OPENAI_MODELS.md        # ChatGPT subscription OAuth integration
│   ├── DEBUGGING_PLAYBOOK.md   # Structured logging + troubleshooting
│   ├── integrations/           # SLACK.md, GITHUB.md, LINEAR.md
│   └── adr/                    # Architecture decision records
└── scripts/
```

**Key monorepo structure**: npm workspaces with shared build/test/lint pipelines. Terraform references pre-built control-plane, slack-bot, github-bot dist bundles at deploy time. Modal and Daytona use pyproject.toml with uv for dependency management.

---

## 4. Tech Stack

### Control Plane (Cloudflare Workers)
| Layer | Tech |
|-------|------|
| Runtime | Cloudflare Workers (V8 engine, 30MB code limit) |
| Language | TypeScript (esbuild bundled to ESM) |
| State Store | Cloudflare Durable Objects (per-session SQLite) |
| Shared Data | D1 Database (repos, automations, encrypted secrets) |
| Storage | Cloudflare R2 (artifacts, snapshots metadata) |
| Auth | JWT (signed with `nextauth_secret`), GitHub OAuth, webhook HMAC-SHA256 |
| HTTP | Hono or @cloudflare/workers-types (Request/Response API) |
| Testing | Vitest with @cloudflare/vitest-pool-workers |

**Key dependencies** (`control-plane/package.json`): `@cloudflare/workers-types`, shared package, esbuild for build.

### Web Application
| Layer | Tech |
|-------|------|
| Framework | Next.js 16 (App Router, React 19) |
| Deployment | Vercel (default) OR Cloudflare Workers (OpenNext build) |
| Auth | NextAuth.js 4 (GitHub OAuth provider) |
| UI | Radix UI (headless components) + Tailwind CSS |
| Styling | Tailwind CSS + CVA for variant management |
| Charts | Recharts for automation analytics |
| Markdown | react-markdown + remark-gfm + rehype-highlight |
| Real-time | SWR for data fetching, WebSocket via session API |
| Testing | Vitest + React Testing Library |

**Page structure**: `/session/[id]` for session detail, `/automations` for CRUD, `/settings` for integrations/secrets.

### Data Plane - Modal Backend (Python)
| Layer | Tech |
|-------|------|
| Orchestration | Modal.com (container + function as a service) |
| Language | Python 3.12 |
| Agent Runtime | [OpenCode](https://opencode.ai) (coding agent server) |
| Image Building | Modal Image API (apt_install, pip_install, add_local_dir) |
| Snapshots | Modal filesystem snapshots (near-instant restore) |
| HTTP/WS | httpx, websockets, FastAPI (for web_api.py) |
| JWT Auth | PyJWT with RS256 verification |
| Sandbox Config | Pydantic models for validation |
| Testing | pytest + pytest-asyncio |

**Package** (`modal-infra/pyproject.toml`): modal>=0.73.0, sandbox_runtime (sibling), httpx, websockets, pydantic, fastapi.

### Data Plane - Daytona Backend (Python)
| Layer | Tech |
|-------|------|
| Orchestration | Daytona API (persistent sandbox management) |
| Language | Python 3.12 |
| Control Flow | Direct REST API calls from control-plane |
| Secrets | Manual `.env` injection via Daytona API (LLM keys not auto-injected like Modal) |

### Shared Packages
| Package | Purpose |
|---------|---------|
| `@open-inspect/shared` | Type definitions (Session, Message, Event, Automation), trigger evaluation, webhook condition parsing |
| `sandbox_runtime` | OpenCode agent tool bindings + Slack webhook notification helper |

---

## 5. Agent Execution Model

### Prompt Flow

```
User prompt (Web/Slack/GitHub) 
    → Control Plane queues message
    → Sandbox spawned if not running (or restored from snapshot)
    → Sandbox receives prompt + author info via WebSocket
    → OpenCode agent processes (reads files, edits, runs commands, git ops)
    → Events stream back (tool calls, token streams, status updates)
    → Control Plane broadcasts to all connected clients
    → On completion, snapshot taken; agent awaits next prompt
```

**Prompt queuing** is sequential—if Agent is processing Prompt 1, Prompt 2 is queued and processed after Prompt 1 finishes. Users can send multiple follow-ups while the agent works.

### Sandbox Lifecycle (Modal)

1. **Fresh Start** (no prior snapshot)
   - Container from base image spun up (~5-10s)
   - Git clone via GitHub App token (~10-30s depending on repo size)
   - `.openinspect/setup.sh` if present (~30s-5min for npm/pip installs)
   - `.openinspect/start.sh` if present (~30s for docker/services startup)
   - OpenCode agent connects back to control plane
   - **Total: 1-10 minutes**

2. **Restore from Snapshot**
   - Filesystem restored from previous session image (seconds)
   - Quick git sync: `git pull` only new commits (~5s)
   - `.openinspect/start.sh` runs if present
   - OpenCode agent ready
   - **Total: 10-30 seconds**

3. **Pre-Built Repo Image Start**
   - Modal loads pre-built snapshot (built on 30-min schedule)
   - Fast git sync to latest branch commit
   - Setup skipped (already ran during image build)
   - Start script runs for per-session runtime setup
   - **Total: 5-15 seconds**

**Proactive warming**: Control plane begins spinning up a sandbox as user types, reducing perceived latency.

### Sub-Task Spawning

Agents can decompose work into parallel child sessions via agent tool:

```python
spawn_task(
    repo="owner/repo",
    branch="feature",
    instructions="...",
    depth_limit=2  # prevent runaway recursion
)
```

- Returns immediately; parent continues
- Child runs in separate sandbox on separate branch
- `get_task_status()` and `cancel_task()` for coordination
- Guardrails: per-repo depth limits enforced by control plane

### Repository Lifecycle Scripts

**`.openinspect/setup.sh`** (provisioning)
- Runs on: fresh sessions, image builds
- Skipped on: repo-image restore, snapshot restore
- Failures: non-fatal for fresh sessions, fatal for builds
- Default timeout: 300s (configurable `SETUP_TIMEOUT_SECONDS`)

**`.openinspect/start.sh`** (runtime startup)
- Runs on: every non-build session start
- Failures: strict—session fails if this exits nonzero
- Default timeout: 120s (configurable `START_TIMEOUT_SECONDS`)
- Both receive `OPENINSPECT_BOOT_MODE` env var: `build` | `fresh` | `repo_image` | `snapshot_restore`

**Example setup.sh**:
```bash
#!/bin/bash
npm install
npm run build
pip install -r requirements.txt
```

---

## 6. LLM Integration

### Multi-Provider Model Support

| Provider | Models | Auth | Reasoning |
|----------|--------|------|-----------|
| **Anthropic** | Haiku 4.5, Sonnet 4.5/4.6, Opus 4.5/4.6/4.7 | API key in global secrets | Per-session effort level |
| **OpenAI** | GPT 5.2, 5.4, 5.5, + Codex variants | OAuth via ChatGPT subscription | N/A (Codex models only) |
| **OpenCode Zen** | Kimi K2.5, MiniMax M2.5, GLM 5 (opt-in) | API key in global secrets | N/A |

**Per-session controls**:
- Model selection in web UI or Slack App Home (user preference)
- Reasoning effort (when supported): low | medium | high
- LLM API keys stored as **global secrets** (all repos) in D1 encrypted (AES-256-GCM)

**Modal integration**: LLM API keys injected as env vars at sandbox startup from `llm_secrets` Modal Secret (auto-injected).

**Daytona integration**: Keys NOT auto-injected; must be added as global secrets in web UI before Daytona sessions can start (see SECRETS.md).

### API Key Management

- **Global secrets** (e.g., `ANTHROPIC_API_KEY`): Encrypted D1 entry, injected into all sandboxes
- **Repo-scoped secrets**: Override global with same key name, repo-specific injection
- Never exposed to clients; only key names visible in UI
- Encryption: AES-256-GCM with `repo_secrets_encryption_key`

---

## 7. UI / UX Surfaces

### Web Dashboard (Next.js, Vercel/Cloudflare)

**Authenticated pages** (`/app` route group):
- **Sessions list** (`/`): Real-time session grid, filter by repo/status
- **Session detail** (`/session/[id]`): Live message stream, WebSocket streaming, terminal panel, file explorer
- **Settings** (`/settings`):
  - Models: Enable/disable providers, set defaults
  - Integrations: GitHub auto-review config, Slack preferences (per-user in App Home), Linear auth
  - Secrets: Global and repo-scoped env var management, bulk `.env` import
  - Images: Pre-built repo snapshot status, rebuild triggers
- **Automations** (`/automations`): CRUD schedule/webhook/Sentry triggers, run history, pause/resume
- **Analytics** (`/analytics`): Session counts, model distribution, success rate charts (Recharts)

**Real-time features**:
- WebSocket connection to Control Plane for event streaming
- Presence indicators (who's viewing this session)
- Terminal output live rendering

### Slack Bot

**App Home**:
- Model preference selector (uses web app enabled models fallback)
- Reasoning effort picker
- Global + per-repo branch overrides

**In-channel workflow**:
- `@BotName fix the failing tests in acme/web` → starts session, posts working reply + View Session button
- Reply in thread → follow-up prompt in same session
- Completion reply includes: summary, artifacts (PRs), key actions, status, View Session button

**DM workflow**: Direct message without @mention, thread replies for follow-ups, 24-hour mapping expiry.

### GitHub Bot

**Auto-review**: Non-draft PR opened → session spawned → review comment posted (approve/request changes/inline comments).

**@mention in PR comment**: `@my-app[bot] explain this failing test` → session spawned → response posted in PR thread or summary comment.

**Acknowledgment**: Eyes reaction on accepted webhook, completion posted as PR comment or review.

### Linear Bot

**Triggering**: Assign or mention agent on Linear issue → session starts with issue context.

**Activity posting**: Agent can post progress updates as Linear comments (if enabled).

**PR linking**: Agent can link resulting PR back to the Linear issue.

---

## 8. Integrations

### GitHub App (Single App, Dual-Purpose)

| Purpose | Token | Scope |
|---------|-------|-------|
| **Clone repos** | GitHub App Installation Token (generated from Private Key) | All repos where App installed |
| **PR creation** | User OAuth token (from NextAuth GitHub provider) | User's permitted repos |
| **PR review** | Generated by agent during session | Repo's PR API |

**GitHub App setup** (terraform step):
- OAuth: Callback URL = `https://open-inspect-{deployment_name}.vercel.app/api/auth/callback/github`
- Permissions: Contents RW, Issues RW, PRs RW, Metadata R
- Install on: Selected repos only (single-tenant safety)
- Installation ID + Private Key → control plane config

**Token architecture**: App token for git ops; user OAuth ensures PR attribution and respects user's repo access.

### Slack Integration

**Entry points**:
- Channel @mention: `@Open-Inspect <request>` (bot must be invited)
- DM: Direct message without mention
- App Home: Model/branch preferences

**Repo selection**: Bot infers from message context or lets user choose from dropdown (1-hour expiry).

**Threading**: Replies in same Slack thread continue same session (24-hour mapping).

**Limitations**: Reads recent thread context for follow-ups; slide/command-style shortcuts not yet supported.

### Linear Integration

**Workflow**: Assign or mention agent on issue → Creates session with issue context → Posts activity comments → Links PR back to issue.

**Bot permissions**: Requires Linear OAuth + API token for issue reads/comments.

### Webhooks (Event-Driven Automations)

**Trigger types**:
1. **Inbound Webhook**: Any external system POSTs JSON → conditions filter → automation runs
2. **Schedule (Cron)**: 5-field format, min 15-min interval, timezone support
3. **Sentry Alert**: Sentry Custom Integration → Modal scheduler processes

**Webhook request**:
```bash
curl -X POST "https://.../webhooks/automation/{automation-id}" \
  -H "Authorization: Bearer {api-key}" \
  -H "Content-Type: application/json" \
  -d '{"event":"deploy.failed","service":"api"}'
```

**Conditions**: JSONPath + simple comparisons (eq, neq, gt, exists, contains). All conditions must match.

**Concurrency**: Scheduled/manual triggers: 1 active per automation (others skipped). Webhook triggers with `idempotencyKey`: deduplication.

**Auto-pause**: 3 consecutive failures → paused state; manual resume resets counter.

---

## 9. Notable Features

### Fast Startup via Multi-Layer Warming

1. **Proactive sandbox warming**: Control plane spins up sandbox as user types (before Enter)
2. **Filesystem snapshots** (Modal): Session saves state after each prompt; next session restores in seconds
3. **Pre-built repo images** (Modal): Scheduled rebuild every 30 min of latest dependencies + build artifacts; new sessions start fresh + fast sync
4. **Skip setup on restore**: Setup script only runs on build/fresh; skipped on snapshot/image restore

**Result**: First session ~2-5 min (depends on repo), follow-ups ~10-30s.

### Multiplayer Sessions

- Multiple users join same session via shared URL
- Real-time presence indicators (who's watching)
- Each prompt attributed to the user who sent it
- Commits properly authored by prompt sender
- WebSocket broadcasts all events to all connected clients

### Sub-Task Spawning

Agent can spawn parallel work:
```
Parent task (main branch)
  ├── Child task 1 (branch-1, separate sandbox)
  ├── Child task 2 (branch-2, separate sandbox)
  └── get_task_status(), cancel_task() for coordination
```

Depth limits per-repo prevent infinite recursion; each child runs independently.

### Commit Attribution

Git commits include:
```
Author: Jane Developer <jane@example.com>
Committer: Open-Inspect <bot@open-inspect.dev>
```

Control plane configures git identity per prompt before agent creates commits. User OAuth ensures PR creation is attributed to the user.

### Sandbox Customization

**Repository hooks** (`.openinspect/` directory):
- `setup.sh`: Provisioning (npm/pip install, build)
- `start.sh`: Runtime startup (docker, services)

**Port tunneling**: Expose up to 10 dev server ports via encrypted tunnels (accessible from web UI).

**Code-server** (optional): Browser-based VS Code connected to session workspace.

**ttyd terminal**: Web terminal panel in session UI.

**agent-browser**: Headless Chromium for visual diffs, screenshots, UI verification.

### Automation Guardrails

- **Auto-pause after 3 failures**: Prevents runaway failure loops
- **90-minute timeout**: Sessions auto-killed; counts as failure toward auto-pause
- **Run history**: Full visibility into past executions + error messages
- **Trigger now**: Manual one-off runs for testing

### Repo Image Pre-Building

**How it works**:
- Scheduler checks every 30 min for new commits on default branch
- If new commits found, rebuilds image (clone + setup.sh)
- Sessions start from image instead of scratch
- Setup skipped (already ran); start.sh still runs

**UI status**: Ready (green) | Building (amber) | Failed (red) | No image | Disabled.

### Secrets Encryption & Scope

- **Global**: Apply to all repos, encrypted in D1
- **Repo-scoped**: Override global for specific repo
- **Injection**: At sandbox spawn time via env vars
- **Encryption**: AES-256-GCM (never exposed to clients)

---

## 10. Deployment Story

### Infrastructure-as-Code (Terraform)

**Two-phase deployment** (Durable Objects + service bindings require separate init):

**Phase 1 - Initial Deploy**:
```bash
terraform init -backend-config=backend.tfvars
terraform apply
# Creates workers, D1, R2, Durable Objects WITHOUT bindings enabled
```

**Phase 2 - Enable Bindings**:
```hcl
enable_durable_object_bindings = true
enable_service_bindings        = true
```
```bash
terraform apply  # Re-deploys with bindings
```

### Prerequisites & Setup (from GETTING_STARTED.md)

1. **Create cloud accounts**: Cloudflare (R2 + D1), Vercel/keep Cloudflare, Modal/Daytona, GitHub, Anthropic, Slack (optional), Linear (optional)

2. **Generate credentials** (terraform.tfvars):
   - Cloudflare: Account ID, Worker subdomain, API token
   - Vercel: Team ID, API token (only if web_platform="vercel")
   - Modal: Token ID/secret, workspace name
   - Daytona: API key, API URL
   - GitHub App: Create app → Install on repos → note App ID, Client ID, Client Secret, Private Key (PKCS#8), Installation ID
   - Anthropic: API key
   - Security secrets: Random `token_encryption_key`, `repo_secrets_encryption_key`, `internal_callback_secret`, `modal_api_secret`, `nextauth_secret`
   - Slack (optional): Bot token, signing secret
   - GitHub bot (optional): Webhook secret

3. **Terraform config** (terraform.tfvars):
   - `deployment_name`: Globally unique (used in Vercel/Cloudflare URLs)
   - `web_platform`: "vercel" or "cloudflare" (OpenNext)
   - `sandbox_provider`: "modal" (default) or "daytona"
   - `allowed_users` / `allowed_email_domains`: Access control lists

4. **Build workers before Terraform**:
   ```bash
   npm run build -w @open-inspect/shared
   npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot -w @open-inspect/github-bot
   ```

5. **Vercel deploy** (if using Vercel platform):
   ```bash
   npx vercel link --project open-inspect-{deployment_name}
   npx vercel --prod
   ```
   Alternatively, link git repo for auto-deploy on main push.

6. **Slack setup** (if enabled):
   - Enable App Home (Home Tab toggle)
   - Configure Event Subscriptions: Request URL = `https://open-inspect-slack-bot-{deployment_name}.{subdomain}.workers.dev/events`
   - Configure Interactivity: Request URL = `https://open-inspect-slack-bot-{deployment_name}.{subdomain}.workers.dev/interactions`
   - Subscribe to bot events: app_mention, message.im, etc.
   - Invite bot to channels

7. **GitHub bot setup** (if enabled):
   - GitHub App webhook: Active, URL = `https://open-inspect-github-bot-{deployment_name}.{subdomain}.workers.dev/webhooks/github`
   - Subscribe to: pull_requests, issue_comments, pull_request_review_comments
   - Ensure `github_bot_username` matches bot's login (e.g., `my-app[bot]`)

8. **Post-deploy verification**:
   ```bash
   curl https://open-inspect-control-plane-{deployment_name}.{subdomain}.workers.dev/health
   ```

### CI/CD Automation (GitHub Actions)

Set up repository secrets for auto-deploy on main push:
- Terraform: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, etc.
- Deployment: VERCEL_API_TOKEN, VERCEL_PROJECT_ID (if Vercel platform)
- Modal: MODAL_TOKEN_ID, MODAL_TOKEN_SECRET
- GitHub/Slack/etc: All secrets from terraform.tfvars

Workflow runs `terraform plan` on PRs, `terraform apply` on main merge.

### Scaling Considerations

**Single-tenant design implications**:
- All users share GitHub App installation → no per-user access validation
- Trust boundary is the entire organization
- Token architecture: App token for git ops, user OAuth for PR attribution
- For multi-tenant, would require: per-tenant GitHub Apps, access control layer, tenant isolation in D1 schema

**Performance**:
- Durable Objects provide per-session SQLite isolation
- Cloudflare KV Hibernation keeps WebSocket connections alive during idle
- Modal auto-scales container startup; Daytona uses persistent sandbox resume
- D1 Database for shared state (repos, automations)

**Limits**:
- Vercel function timeout: ~10 minutes
- Modal sandbox timeout: Configurable (typically 120-180 min for sessions, varies for builds)
- Session execution timeout: 90 minutes (auto-pause on exceed)
- Webhook payload: 64 KB max
- Automation instructions: 10,000 characters max

---

## 11. Security Model & Single-Tenant Constraints

### Token Architecture

| Token | Purpose | Scope | Lifespan |
|-------|---------|-------|----------|
| **GitHub App Token** | Clone repos, push commits | All repos where App installed | ~1 hour, auto-refreshed |
| **User OAuth Token** | Create PRs, identify users | Repos user has access to | Long-lived, stored encrypted in D1 |
| **Sandbox Auth Token** | Sandbox ↔ control plane WebSocket | Single session | Session lifetime |
| **WebSocket Token** | Client ↔ control plane connection | Single session | Connection lifetime |

### Secrets Storage

- **D1 Database**: Encrypted with `repo_secrets_encryption_key` (AES-256-GCM)
- **Cloudflare R2** (artifacts, snapshots metadata): No encryption at rest (transport TLS)
- **Modal Secrets**: `llm-api-keys`, `github-app`, `internal-api` (never stored in snapshots)
- **Daytona**: No auto-injection of LLM keys; must add to global secrets in web UI

### Single-Tenant Constraints

**Why single-tenant only**:
- Shared GitHub App installation: Any user can access any repo the App is installed on
- No per-user repository access validation in control plane
- User OAuth tokens used for PR creation (ensures proper attribution)
- All users trusted members of same organization

**Deployment recommendations**:
1. Deploy behind organization SSO/VPN
2. Install GitHub App only on intended repositories (use "Select repositories" option)
3. Use GitHub's repository selection to limit scope
4. Review `allowed_users` and `allowed_email_domains` in terraform.tfvars

**Multi-tenant roadmap**: Would require per-tenant GitHub Apps, access control layer in D1, tenant isolation in all schemas. Not currently supported.

### Data Isolation

- **Sessions**: Isolated Durable Object per session (SQLite state)
- **Sandboxes**: Isolated containers per session (no inter-session filesystem access)
- **Snapshots**: Per-repo, per-branch; pulled only when starting same session
- **Secrets**: Encrypted D1 entries, injected only at spawn time

---

## 12. Integration with Thor

### Alignment with Multi-Agent Platform

**How background-agents fits Thor's architecture**:

1. **Agent execution substrate**: Open-Inspect provides the **sandbox execution layer** that Thor can delegate code tasks to. Thor acts as the orchestrator (multi-provider gateway); Open-Inspect is the **coding executor**.

2. **Webhook gateway pattern**: Open-Inspect's inbound webhooks (Section 8) align with Thor's **webhook gateway** pattern. Thor can trigger Open-Inspect automations via authenticated POST.

3. **MCP policy gateway**: Open-Inspect's **sandbox-runtime** package (Python tools available to agents) is analogous to an MCP server. Agents use fixed tool set; future versions could expose tool registry.

4. **Session persistence & multiplayer**: Open-Inspect's Durable Objects per-session state + real-time streaming (WebSocket) matches Thor's multi-user collaboration model.

5. **Deployment flexibility**:
   - Web platform choice: Vercel OR Cloudflare Workers
   - Sandbox backend choice: Modal (fast startup + snapshots) OR Daytona (persistent sandboxes)
   - Single Terraform config manages all infrastructure

### Key Differences from Thor's Goals

| Aspect | Background-Agents | Thor (Implied) |
|--------|-------------------|---|
| **Orchestration** | Single-provider (GitHub only, GitLab planned) | Multi-provider (Slack, GitHub, webhooks, MCP) |
| **Runtime model** | Async background (fire-and-forget) | Likely event-driven + optional real-time |
| **Agent** | OpenCode (fixed, open-source) | Pluggable (could be Claude via Anthropic SDK, OpenCode, other) |
| **Sandbox backend** | Modal or Daytona | Daytona (OpenCode runner implied) |
| **Access control** | Single-tenant only | Multi-tenant (per-user/org isolation) |
| **Auth model** | Shared GitHub App | Per-user OAuth + MCP policy enforcement |

### Code References for Deep Dive

- **Session orchestration**: `/packages/control-plane/src/router.ts` (HTTP endpoints), `/packages/control-plane/src/scheduler/durable-object.ts` (session state machine)
- **Sandbox lifecycle**: `/packages/modal-infra/src/sandbox/manager.py` (spawn/restore), `/packages/modal-infra/src/images/` (pre-built snapshots)
- **Agent execution**: `/packages/sandbox-runtime/src/tools/` (OpenCode tool definitions)
- **Real-time streaming**: `/packages/control-plane/src/scheduler/durable-object.ts` WebSocket handler, `/packages/web/src/app/session/[id]/page.tsx` (client streaming)
- **Automations**: `/packages/shared/src/triggers/` (cron + condition evaluation), `/packages/modal-infra/src/scheduler/` (Modal Function cron runner)
- **GitHub integration**: `/packages/control-plane/src/github-app.ts` (token generation), `/packages/github-bot/src/` (PR webhook handler)

---

## Summary

Open-Inspect is a **production-ready background coding agent** designed for async execution with deep development tool integrations. Its three-tier architecture (Cloudflare control plane, Modal/Daytona data plane, multi-client web/Slack/GitHub layer) decouples user presence from agent work, enabling fire-and-forget workflows alongside real-time multiplayer collaboration.

For Thor engineers, the key takeaway is that background-agents provides a **proven implementation of async agent sandbox orchestration**—persistent sessions with snapshot-accelerated startup, multi-model AI selection, webhook-triggered automations, and tight GitHub/Slack integration. The single-provider (GitHub) constraint and shared app token model differ from Thor's multi-tenant/multi-provider vision, but the architecture patterns (Durable Objects for session state, Daytona for persistent sandboxes, WebSocket multiplexing for real-time streams) are directly applicable to Thor's design.

---

**Document compiled from**:
- README.md (architecture, security model, feature overview)
- HOW_IT_WORKS.md (session lifecycle, sandbox lifecycle, prompt flow, event model)
- GETTING_STARTED.md (deployment steps, infrastructure choices, troubleshooting)
- AUTOMATIONS.md (trigger types, webhook conditions, scheduling)
- SECRETS.md (encryption model, scope rules)
- IMAGE_PREBUILD.md (snapshot rebuild automation)
- Integration docs: SLACK.md, GITHUB.md, LINEAR.md
- ADR 0001 (single-provider decision)
- Package manifests and source layout
