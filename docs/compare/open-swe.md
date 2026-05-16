# Open SWE: Technical Overview

**Local path**: `/Users/son.dao/repos/daohoangson/open-swe`  
**Repository**: github.com/langchain-ai/open-swe  
**License**: MIT  
**Built on**: LangGraph, Deep Agents, LangSmith

---

## 1. Purpose & Positioning

Open SWE is an **open-source framework for building internal coding agents** — autonomous bots that automate software engineering tasks. It targets elite engineering orgs (Stripe, Ramp, Coinbase) that build proprietary agent infrastructure, offering a composable, battle-tested alternative to building from scratch.

**Core pattern**: Task runs in an isolated sandbox → agent executes with full permissions inside → results surface via Slack, Linear, or GitHub PR comments.

**Key claim**: Matches the architecture of three major internal agents (Stripe's Minions, Ramp's Inspect, Coinbase's Cloudbot) but as composable open-source framework that can be forked and customized per org.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Invocation Layer                           │
│  ┌──────────────┬───────────────┬──────────────┬─────────────┐  │
│  │ Slack Thread │ Linear Issue  │ GitHub PR    │ Webhook     │  │
│  │  (@openswe)  │  (@openswe)   │ Comments     │ Server      │  │
│  └───┬──────────┴───┬───────────┴───────┬──────┴─────┬───────┘  │
│      │              │                   │            │           │
│      └──────────────┴───────────────────┴────────────┘           │
│                         │                                         │
│                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │        FastAPI Webhook Server (agent/webapp.py)        │    │
│  │  • Signature verification (GitHub, Slack, Linear)      │    │
│  │  • Deterministic thread_id derivation                  │    │
│  │  • LangGraph SDK client trigger/stream                 │    │
│  └──────────┬──────────────────────────────────────────────┘    │
└─────────────┼─────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│              LangGraph Execution (agent/server.py)              │
│  • Graph factory per thread: get_agent(config)                │
│  • Resolves GitHub token (user OAuth or App bot token)         │
│  • Creates/reuses sandbox (thread-scoped)                      │
│  • Constructs deep agent with middleware stack                 │
│  • Agent runs 1-N model calls (bounded by recursion limit)     │
└──────────┬────────────────────────────────┬─────────────────────┘
           │                                │
           ▼                                ▼
  ┌──────────────────┐          ┌─────────────────────────┐
  │  Deep Agents     │          │  Middleware Stack       │
  │  (LangGraph+     │          │  • ToolErrorMiddleware  │
  │   LLM loop)      │          │  • MessageQueue check   │
  │                  │          │  • Step limit notify    │
  │  Tools:          │          │  • Sandbox circuit      │
  │  • execute       │          │    breaker              │
  │  • read/write    │          │                         │
  │  • fetch_url     │          └─────────────────────────┘
  │  • http_request  │
  │  • linear_*      │
  │  • slack_*       │
  │  • task          │
  └──────┬───────────┘
         │
         ▼
   ┌──────────────────┐
   │ Sandbox Backend  │
   │ (isolated CLI)   │
   │                  │
   │ LangSmith proxy  │
   │ GitHub auth      │
   └──────────────────┘
```

**Dual entry points, one process**:
- **`agent/server.py:get_agent(config)`** — LangGraph graph factory. Called per-thread. Constructs fresh `create_deep_agent()` with full tool list + middleware. Manages sandbox lifecycle (create/reconnect/refresh).
- **`agent/webapp.py`** — FastAPI routes for webhooks (GitHub, Linear, Slack) + dashboard admin routes. Runs alongside LangGraph server. Resolves thread ID from webhook payload, triggers run via `langgraph_sdk` client.

Both declared in `langgraph.json` and served together by `langgraph dev`.

---

## 3. Repo Layout

```
open-swe/
├── agent/                          # Core agent logic
│   ├── server.py                   # Graph factory (501 lines)
│   ├── webapp.py                   # Webhook routes (2525 lines)
│   ├── prompt.py                   # System prompt construction (414 lines)
│   ├── reviewer.py                 # Code review graph factory (358 lines)
│   ├── reviewer_findings.py        # Finding state management (314 lines)
│   ├── reviewer_diff.py           # Diff computation (239 lines)
│   ├── reviewer_publish.py         # GitHub review surfacing (310 lines)
│   ├── encryption.py               # Token encryption at rest (71 lines)
│   ├── tools/                      # Tool implementations (~18 tools)
│   │   ├── execute, read_file, write_file  (deepagents built-in)
│   │   ├── http_request.py         # Generic HTTP client
│   │   ├── fetch_url.py            # Web page to markdown
│   │   ├── linear_comment.py       # Post to Linear
│   │   ├── linear_get_issue.py     # Fetch Linear issue
│   │   ├── slack_thread_reply.py   # Reply in Slack thread
│   │   ├── add_finding.py          # Reviewer: add code issue
│   │   ├── update_finding.py       # Reviewer: update finding
│   │   ├── publish_review.py       # Reviewer: post to GitHub PR
│   │   └── web_search.py           # Exa web search
│   ├── middleware/                 # Middleware hooks
│   │   ├── tool_error_handler.py
│   │   ├── check_message_queue.py
│   │   ├── notify_step_limit.py
│   │   ├── sandbox_circuit_breaker.py
│   │   ├── model_fallback.py
│   │   └── refresh_slack_status.py
│   ├── integrations/               # Sandbox providers
│   │   ├── langsmith.py            # LangSmith cloud sandbox (default)
│   │   ├── daytona.py
│   │   ├── modal.py
│   │   ├── runloop.py
│   │   └── local.py                # Dev-only, no isolation
│   ├── dashboard/                  # Admin UI routes
│   │   ├── routes.py
│   │   ├── profiles.py
│   │   ├── oauth.py
│   │   └── agent_overrides.py
│   ├── utils/                      # Supporting utilities
│   │   ├── auth.py                 # GitHub token resolution
│   │   ├── github_app.py           # App installation token
│   │   ├── sandbox.py              # Sandbox factory
│   │   ├── sandbox_state.py        # Thread metadata
│   │   ├── github_comments.py      # GitHub webhook parsing
│   │   ├── slack.py                # Slack webhook parsing
│   │   ├── linear.py               # Linear webhook parsing
│   │   ├── model.py                # Model instantiation (OpenAI, Anthropic)
│   │   └── ...
│   └── utils/
├── ui/                             # React dashboard (TanStack Router)
│   ├── src/
│   │   ├── routes/
│   │   │   ├── admin.tsx           # Admin panel
│   │   │   ├── profile.tsx
│   │   │   └── login.tsx
│   │   └── components/
│   ├── vite.config.ts
│   ├── package.json
│   └── README.md
├── evals/                          # Evaluation scripts
│   └── reviewer/
├── tests/                          # Unit tests (pytest)
├── scripts/                        # Utility scripts
├── AGENTS.md                       # Guide for agents working on open-swe repo
├── CLAUDE.md                       # Codebase documentation
├── INSTALLATION.md                 # Setup guide (23k)
├── CUSTOMIZATION.md                # Forking guide (19k)
├── REVIEWER_DESIGN.md              # Reviewer agent design
├── Dockerfile                      # Sandbox image (Python, Node, Go, Docker CLI, GitHub CLI)
├── langgraph.json                  # LangGraph config (graphs: agent, reviewer)
├── pyproject.toml                  # Python deps (deep agents, fastapi, langsmith, etc.)
├── Makefile
└── README.md                       # Main docs
```

**Key file sizes**: webapp.py (2.5k lines) and prompt.py dominate; agent core loop is kept intentionally small and modular.

---

## 4. Tech Stack

### Backend
- **Python 3.11–3.13** (not 3.14 yet)
- **LangGraph** (1.1.10+) — state machine & agentic orchestration
- **Deep Agents** (0.5.7+) — composable agent framework from LangChain
- **FastAPI** (0.136.1+) — webhook server
- **LangSmith SDK** (0.8.3+) — sandbox execution + tracing
- **Uvicorn** — ASGI server
- **PyJWT, cryptography** — token encryption at rest

### LLM Integrations
- **OpenAI** (default: GPT-5.5 with medium reasoning)
- **Anthropic** (Claude Sonnet 4.6+ supported)
- Pluggable via `provider:model` format

### Sandbox Providers (pluggable)
- **LangSmith** (default) — cloud Linux environment, GitHub proxy, pre-built snapshots
- **Daytona** — similar to LangSmith
- **Modal** — serverless containers
- **Runloop** — dev environment orchestration
- **Local** — direct host execution (dev-only)

### Frontend
- **React 19** (TanStack Router)
- **TypeScript**
- **Tailwind CSS** (components.json configured)
- **Vite** (build tool)

### DevOps
- **Docker** — sandbox image (Python 3.14, Node 22, Go 1.23, GitHub CLI 2.83)
- **uv** — package manager (Python)
- **Ruff** — linter/formatter (line-length 100, target py311)
- **Pytest** — testing (asyncio_mode="auto")

### External APIs
- GitHub OAuth + GitHub App (bot identity)
- Slack OAuth + webhook verification
- Linear OAuth + webhook verification
- Exa API (web search tool)

---

## 5. Agent Execution Model

### The Loop (Deep Agents + LangGraph)
1. **Thread spawning** — webhook resolves deterministic `thread_id` (from PR number, issue ID, Slack thread, etc.)
2. **Graph instantiation** — `get_agent(config)` called; constructs fresh `create_deep_agent(...)`
3. **Sandbox lifecycle** — thread_id maps to sandbox_id in-memory cache or thread metadata:
   - Cache hit → ping (`echo ok`); recreate on `SandboxClientError`
   - No cache, metadata says `__creating__` → poll until ready
   - No sandbox → create new, set `__creating__` sentinel, update to real id
   - Metadata stale → reconnect; fall back to recreate on failure
4. **Model loop** — LLM is called repeatedly (middleware hooks run around each call):
   - Agent sees tools, current state, user message, thread history
   - Agent generates tool calls or final answer
   - Tools execute in sandbox; output returned to agent
   - Repeat until agent stops or hits `ModelCallLimitMiddleware` (default recursion limit ~25)
5. **Termination** — agent writes results (PR, comment, linear issue) via tools; returns

### Sandbox Execution Model
- **Per-thread, persistent, reused** — same sandbox for follow-ups to the same issue/thread
- **Full isolation** — Linux container with cloned repo, full shell access
- **No human-in-loop gates** — agent has full permissions; validation is prompt-driven (linters, tests, formatters run inside agent steps)
- **Timeout-based** — default 5 minutes per command; agent can specify longer via `timeout=<seconds>` parameter

### Planning
- **No explicit planning node** — system prompt encodes behavior; agent learns to plan implicitly via tool use
- **Repo context injection** — `AGENTS.md` file (if present in target repo) is read from sandbox and injected into system prompt. Repo-level rules and conventions encoded here (like Stripe's rule files)
- **Source context assembly** — full Linear issue/Slack thread history passed to agent before first model call

### Tool Use
- **Deep Agents built-in**: `execute`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `ls` (file ops); `task` (spawn subagents)
- **Custom Open SWE tools** (~15): `http_request`, `fetch_url`, `linear_*`, `slack_*`, `web_search`, `request_pr_review`, reviewer tools (`add_finding`, etc.)
- **Curated, not accumulated** — small toolset forces intentional design; tools are high-level (not per-API-endpoint)

### Subagents
- Deep Agents natively supports `task(description, ...)` tool
- Main agent can fan out independent subtasks to isolated child agents
- Each subagent gets its own middleware stack, todo list, file operations
- Similar to Ramp's child sessions for parallel work

### Sandbox Approach
- **No confirmation prompts** — agent has full repo access; trust boundary is the sandbox container itself
- **Blast radius contained** — mistakes are isolated to one sandbox; no production access
- **GitHub proxy** (LangSmith only) — agent runs `GH_TOKEN=dummy gh <command>`; proxy injects real credentials at request time. Same for REST API calls. Token stored encrypted in thread metadata at rest.

---

## 6. LLM Integration

### Model Selection
```python
# agent/server.py: get_agent()
model_id = os.environ.get("LLM_MODEL_ID", DEFAULT_LLM_MODEL_ID)
# DEFAULT_LLM_MODEL_ID = "openai:gpt-5.5"
# DEFAULT_LLM_REASONING = "medium"
# DEFAULT_LLM_MAX_TOKENS = 4096 (default completion budget)

model = make_model(model_id, **model_kwargs)
```

Supports `provider:model` format. Tested with:
- **OpenAI**: `openai:gpt-5.5` (default, reasoning models supported)
- **Anthropic**: `anthropic:claude-sonnet-4-6` (thinking models supported via `AnthropicThinking`)

### Prompting Strategy
- **System prompt** (`agent/prompt.py`): ~400 lines, constructed at runtime with:
  - Working environment section (sandbox path, timeout, tool explanations)
  - Task overview
  - Self-awareness section (tells agent it's Open SWE, when to target `langchain-ai/open-swe`)
  - Repository setup (clone, git identity, branch strategy)
  - Tool-specific guidance
  - `AGENTS.md` from target repo (if present, injected verbatim)
  - Custom instructions from `default_prompt.md` (org-specific rules)

- **User message**: assembled from source context:
  - Linear issue: full title, description, comments
  - Slack thread: selected context messages (not entire history)
  - GitHub PR: issue number, title, base/head branches, author
  - Deterministic thread messages pulled mid-run via `check_message_queue_before_model` middleware

### Tool Binding
- Tools are passed to `create_deep_agent(tools=[...])` as a list
- LLM sees tool schemas (name, description, args)
- Tool execution happens in agent's main loop; failures surfaced via `ToolErrorMiddleware`

### Multimodal
- **Image handling**: Open SWE supports images in Slack threads and GitHub comments
- Fetches images from URLs, converts to vision-compatible formats, passes to model if model supports vision

---

## 7. UI / UX Surfaces

### Invocation
1. **Slack** — mention `@openswe` in any thread with optional `repo:owner/name` syntax
   - Bot reacts 👀 when it picks up the message (instant ack)
   - Status updates posted in-thread
   - Follow-up messages picked up mid-run via middleware
   - Final PR link posted in thread

2. **Linear** — comment `@openswe` on any issue
   - Bot reacts 👀 on the comment
   - Results posted back as Linear comments
   - Full issue context (title, description, prior comments) included in agent context

3. **GitHub PR comments** — tag `@openswe` to trigger reviewer or request fixes
   - Agent reads PR diff, produces findings
   - Opens/updates draft PR on main agent tasks
   - Publishes review comments on reviewer tasks

### Admin Dashboard (React, TanStack Router)
Located in `ui/src/routes/`:
- **`admin.tsx`** — admin panel (likely user/org management)
- **`profile.tsx`** — user profile (OAuth, preferences)
- **`login.tsx`** — authentication flow
- OAuth flow handled in `agent/dashboard/oauth.py`

### Tracing & Observability
- All runs logged to LangSmith by default
- Agent traces visible at `smith.langchain.com` with full state, tool calls, LLM inputs/outputs
- Each thread maps to one LangSmith thread_id; sandbox maps to thread metadata

---

## 8. Integrations

### GitHub
- **OAuth** (per-user optional) — when enabled, PRs/commits show user identity
- **App bot identity** (always available) — fallback when no user token
- **GitHub CLI** (`gh`) — agent invokes as `GH_TOKEN=dummy gh <command>` inside sandbox
- **LangSmith GitHub proxy** — injects credentials for both git operations and REST API calls
- **PR operations** — agent can open, update, comment on PRs with inline suggestions
- **Webhook events** — PR comments (review requests), issue comments, PR reviews

### Slack
- **OAuth** — bot installed to workspace, reads thread messages, posts replies
- **Webhook events** — message mentions, reactions (feedback loop)
- **Reaction feedback** — agents can track emoji reactions to measure signal (❌ = bad, ✅ = good)
- **Status updates** — mid-run Slack status changes (looking at problem, running tests, etc.)

### Linear
- **OAuth** — bot reads/writes issues and comments
- **Webhook events** — issue comments
- **Team-to-repo mapping** — config maps Linear teams to GitHub repos (`agent/utils/linear_team_repo_map.py`)
- **Trace comments** — agent can post LangSmith trace link back to Linear

### MCP
- Not used in current codebase (but extensible via custom tools)
- Deep Agents tool protocol is similar enough that MCP tools could be wrapped

### Exa API
- Web search tool powered by Exa (web search integration, not full MCP)

---

## 9. Notable Features & Distinctive Aspects

### 1. **Composed on Deep Agents, not forked**
- Built on LangChain's Deep Agents framework, not a custom agent from scratch
- Upstream improvements automatically inherited; fork path is customization, not divergence
- Mirrors Ramp's approach (composing on OpenCode) vs. Stripe's (forking Goose)

### 2. **Middleware-driven extensibility**
- Not monolithic agent loop; hooks run around every model call
- `ToolErrorMiddleware`, `check_message_queue_before_model`, `notify_step_limit_reached`, circuit breaker, fallback models
- Middleware order matters; list is configuration, not code

### 3. **Findings-as-state for Reviewer**
- Reviewer agent maintains structured findings list in thread metadata (not in sandbox files)
- Findings survive sandbox eviction; thread state is the source of truth
- Single evolving list per PR; resolved findings kept (not pruned)
- Decoupled from publishing to GitHub (can filter by severity, add explanations, retry on API errors)

### 4. **Watch mode for Reviewer**
- Reviewer can be configured to re-review on new commits
- Compares previous findings against new diff; reconciles (open, resolved, updated)
- Resolves corresponding GitHub comment threads when findings move to resolved status

### 5. **Thread-deterministic routing**
- Each source (PR, issue, Slack thread) maps to deterministic thread_id
- Same issue/thread always routes to same running agent (or reused sandbox)
- Follow-up messages are picked up mid-run; no need to restart

### 6. **Sandbox-agnostic backend**
- Pluggable sandbox providers (LangSmith, Daytona, Modal, Runloop, local)
- Only LangSmith gets GitHub proxy; others rely on tokens in env
- Adding new provider: write factory function, register in `agent/utils/sandbox.py`

### 7. **AGENTS.md convention**
- Repos can include `AGENTS.md` at root; agent reads it from sandbox and injects into system prompt
- Org-level rules, architectural decisions, testing conventions all encoded in markdown
- Cleaner than embedding rules in agent hardcoded prompt

### 8. **Human-in-the-loop via message queue**
- Middleware checks for new Linear comments / Slack messages before each model call
- Agent picks up mid-run feedback without restarting
- Useful for course-correction ("focus on the login flow" mid-task)

### 9. **Reviewer agent is separate graph**
- `agent/reviewer.py:get_reviewer_agent()` — distinct from main `agent/server.py:get_agent()`
- Different tools (add_finding, publish_review, no PR-opening)
- Different system prompt (focuses on diff, severity thresholds, suggestion blocks)
- Can be deployed to separate LangGraph thread kinds or invoked separately

---

## 10. Deployment Story

### Local Development
```bash
make install          # uv sync
make dev              # langgraph dev (watches code, serves on :2024)
# Separately: ngrok http 2024 --url https://your-url.ngrok.dev
# Webhook URLs: https://your-url.ngrok.dev/webhooks/{github,slack,linear}
```

### Environment Configuration
- **GitHub**: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET`
- **Slack**: `SLACK_SIGNING_SECRET`, `SLACK_BOT_USER_ID`, `SLACK_BOT_USERNAME`
- **Linear**: `LINEAR_WEBHOOK_SECRET`
- **LangSmith**: `LANGSMITH_API_KEY_PROD`, `LANGSMITH_TENANT_ID_PROD`, `LANGSMITH_TRACING_PROJECT_ID_PROD`
- **Sandbox**: `SANDBOX_TYPE` (langsmith|daytona|modal|runloop|local), `DEFAULT_SANDBOX_SNAPSHOT_ID` (LangSmith only)
- **LLM**: `LLM_MODEL_ID` (default: `openai:gpt-5.5`), `ANTHROPIC_API_KEY` (if using Claude)

### Docker & Snapshots (LangSmith)
- **Dockerfile** — full dev image (Python 3.14, Node 22, Go 1.23, Docker CLI, GitHub CLI 2.83)
- **Sandbox snapshots** — built once from Dockerfile, referenced by UUID in `DEFAULT_SANDBOX_SNAPSHOT_ID`
- Pre-bake languages, frameworks, internal tools to reduce per-run setup time

### Production Deployment
1. **LangGraph Cloud** (recommended)
   - Push to git; LangGraph Cloud pulls and deploys
   - Automatic webhook routing, observability, scalability
   - Configuration via `langgraph.json` (two graphs: `agent`, `reviewer`)

2. **Self-hosted**
   - Run Docker image with `uvicorn agent.webapp:app --host 0.0.0.0 --port 8000`
   - Expose webhook endpoints to internet (or via reverse proxy)
   - Webhook secrets must match GitHub/Slack/Linear app config

3. **Scaling considerations**
   - Sandboxes are persistent per-thread; concurrent threads = concurrent sandboxes (isolates blast radius)
   - LangGraph handles queuing; FastAPI routes incoming webhooks to same thread
   - Each thread spawns one Deep Agent instance (lightweight)

### CI/CD Integration
- Tests run with `uv run pytest -vvv tests/`
- Linting with `ruff check`
- Formatting with `ruff format`
- No special CI gates in repo; but agents can be configured to fail on lint/test errors inside sandbox

### Observability
- **LangSmith traces** — all runs logged by default; visible in trace project UI
- **Structured metadata** — thread_id, sandbox_id, GitHub token (encrypted), reviewer findings all stored in thread metadata
- **Slack status updates** — middleware can post status to thread mid-run
- **Fallback models** — `ModelFallbackMiddleware` can retry on failure with a different model

---

## Summary Table: Open SWE vs Comparables

| Aspect | Open SWE | Stripe (Minions) | Ramp (Inspect) | Coinbase (Cloudbot) |
|---|---|---|---|---|
| **Harness** | Composed (Deep Agents) | Forked (Goose) | Composed (OpenCode) | Built from scratch |
| **Sandbox** | Pluggable (LangSmith default) | Pre-warmed EC2 | Pre-warmed Modal | In-house |
| **Tools** | ~15, curated | ~500, per-agent | OpenCode SDK | MCPs |
| **Context** | AGENTS.md + issue/thread | Rule files | Built-in | Linear-first |
| **Orchestration** | Subagents + middleware | Blueprints | Sessions | Three modes |
| **Invocation** | Slack, Linear, GitHub | Slack + buttons | Slack + web + Chrome ext | Slack-native |
| **Validation** | Prompt-driven (linters, tests) | 3-layer (local + CI + retry) | Visual DOM | Councils + auto-merge |
| **Reviewer** | Separate graph, findings-as-state | N/A | Built-in | N/A |

---

## Key Customization Points for Thor

When forking for Thor, these are the high-leverage customization targets:

1. **Sandbox provider** — `SANDBOX_TYPE` env var + `agent/integrations/`; Thor's Daytona integration already exists
2. **Tools** — `agent/tools/` + `server.py:get_agent()` and `reviewer.py:get_reviewer_agent()` tool lists
3. **Middleware** — `agent/middleware/` + order in `get_agent()`; add Thor-specific validation gates
4. **Prompting** — `agent/prompt.py:construct_system_prompt()` and `default_prompt.md`; inject Thor-specific conventions
5. **Invocation surfaces** — `agent/webapp.py` webhook handlers; add Thor's webhook gateway (MCP policy gateway)
6. **Models** — `LLM_MODEL_ID` env var; swap OpenAI for Anthropic or add model routing logic
7. **Dashboard** — `ui/` and `agent/dashboard/`; add Thor-specific admin views (policy enforcement, sandbox quotas, etc.)

---

**Document generated**: 2026-05-16  
**Source repo**: github.com/langchain-ai/open-swe (as of May 2026)
