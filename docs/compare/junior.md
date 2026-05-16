# Junior: Technical Overview for Thor Engineers

**Local path:** `/Users/son.dao/repos/daohoangson/junior`

**Status:** Active. Sentry-operated Slack bot runtime with rapidly evolving agent, prompt, and plugin infrastructure (v0.45.0+).

## 1. Purpose & Positioning

Junior is a **Slack-integrated agent runtime** powering conversation-driven developer workflows. It's designed to investigate issues, summarize context, and take action from Slack with connected provider tools—positioned as a reference multi-turn agent harness demonstrating modern turn-based reasoning, MCP integration, and capability-gated execution.

- **Core audience:** Teams using Slack who need agent-powered issue investigation, code lookup, and provider actions
- **Key differentiation:** Plugin-based architecture (skills + capabilities + credentials bundled), native MCP support, per-turn Pi agent reasoning via thinking levels, built on Vercel Sandbox for code execution
- **Deployment model:** Vercel Functions (nitro), Redis for state, webhook-driven from Slack (DMs, @mentions, subscribed threads, assistant-thread lifecycle)

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Slack Client (DMs, @mentions, subscribed threads, lifecycle)    │
└─────────────────────────┬───────────────────────────────────────┘
                          │ Webhook
                          ▼
         ┌────────────────────────────────┐
         │ HTTP Handlers / Ingress Router │
         │ packages/junior/src/handlers/* │
         │  - webhooks.ts                 │
         │  - oauth-callback.ts           │
         │  - turn-resume.ts              │
         │  - sandbox-egress-proxy.ts     │
         └────────────┬───────────────────┘
                      │
         ┌────────────▼──────────────────────┐
         │ Slack Runtime (Turn Orchestrator) │
         │ src/chat/runtime/slack-runtime.ts │
         │  - Turn preparation/context       │
         │  - Thread state persistence       │
         │  - Reply delivery/retries         │
         │  - Auth pause/resume flow         │
         └────────────┬──────────────────────┘
                      │
         ┌────────────▼──────────────────────────────────┐
         │ Pi Agent Harness (generateAssistantReply)     │
         │ src/chat/pi/client.ts (wrapped in turn.ts)    │
         │  - Thinking-level routing classifier          │
         │  - Durable conversation history management    │
         │  - Tool invocation + result handling          │
         │  - Timeout/resumable-turn management          │
         └────────────┬──────────────────────────────────┘
                      │
         ┌────────────▼────────────────────────────────────────┐
         │ Tool Registry & Execution (Sandbox/MCP/HTTP)        │
         │ src/chat/tools/*                                     │
         │  - Slack tools (post, react, thread context)        │
         │  - Web tools (search, fetch, image-gen)             │
         │  - Skill/MCP dispatcher (callMcpTool)               │
         │  - Sandbox command runner (bash/sh/system)          │
         │  - Advisor tool (context-scoped reflection)         │
         └────────────┬────────────────────────────────────────┘
                      │
         ┌────────────┴──────────────────────────────────────────┐
         │                                                       │
    ┌────▼─────────────┐    ┌──────────────────┐  ┌────────────▼────┐
    │ MCP Clients      │    │ Vercel Sandbox   │  │ Provider Brokers│
    │ (Plugin-defined) │    │ (Skill execution)│  │ (Cred issuance) │
    │                  │    │                  │  │                 │
    │ - HTTP/SSE       │    │ - Snapshot pkg   │  │ - OAuth bearer  │
    │ - Stdio          │    │ - Egress proxy   │  │ - GitHub App    │
    │ - Stdio over SSH │    │ - OIDC validate  │  │ - API headers   │
    └──────────────────┘    └──────────────────┘  └─────────────────┘
```

**Key Control Flows:**
1. **Inbound:** Slack webhook → ingress router → slack-runtime → turn executor
2. **Agent loop:** Turn context → Pi agent (thinking classifier → main agent) → tools
3. **Tool execution:** Tool invocation → sandbox/MCP/HTTP → response → agent loop
4. **Outbound:** Final assistant text → reply delivery (thread post + status + files + reactions)
5. **Async:** OAuth callbacks, turn resumption, sandbox-credential egress proxying

## 3. Repo Layout

**Monorepo structure** (pnpm workspaces):

```
junior/
├── packages/
│   ├── junior/                          # Core runtime (primary package)
│   │   ├── src/chat/
│   │   │   ├── app/                     # Composition root (factory.ts, production.ts)
│   │   │   ├── runtime/                 # Slack turn orchestration
│   │   │   ├── pi/                      # Pi agent client + streaming
│   │   │   ├── tools/                   # All tool implementations
│   │   │   │   ├── slack/               # Slack output tools
│   │   │   │   ├── sandbox/             # Bash/command execution
│   │   │   │   ├── web/                 # Search, fetch, image-gen
│   │   │   │   ├── skill/               # MCP dispatcher + load-skill
│   │   │   │   └── advisor/             # Reflection/decision-tree tool
│   │   │   ├── mcp/                     # MCP client, auth, OAuth
│   │   │   ├── sandbox/                 # Vercel Sandbox session mgmt
│   │   │   ├── plugins/                 # Plugin discovery, registry
│   │   │   ├── services/                # Domain services (conversation memory, etc)
│   │   │   ├── state/                   # State storage abstraction (Redis/memory)
│   │   │   ├── ingress/                 # Inbound routing normalization
│   │   │   ├── credentials/             # Credential brokers
│   │   │   ├── queue/                   # Job queue + worker (Redis Streams)
│   │   │   └── capabilities/            # Provider catalog + config
│   │   ├── src/handlers/                # HTTP route handlers (webhooks, OAuth, resume, proxy)
│   │   ├── src/cli/                     # CLI tools (jr-rpc)
│   │   ├── src/build/                   # Build-time dependency snapshots
│   │   └── src/instrumentation.ts       # OpenTelemetry setup
│   │
│   ├── junior-agent-browser/            # Plugin: browser automation (Playwright)
│   ├── junior-datadog/                  # Plugin: Datadog Pup CLI integration
│   ├── junior-github/                   # Plugin: GitHub issue/repo workflows
│   ├── junior-hex/                      # Plugin: Data warehouse (DuckDB SQL)
│   ├── junior-linear/                   # Plugin: Linear issue management
│   ├── junior-notion/                   # Plugin: Notion page search
│   ├── junior-sentry/                   # Plugin: Sentry event workflows
│   └── junior-evals/                    # End-to-end conversation evaluations
│
├── apps/
│   └── example/                         # Reference app (Vercel-deployable)
│       ├── app/
│       │   ├── plugins/                 # Local plugin definitions
│       │   └── skills/                  # Custom skills (if any)
│       ├── nitro.config.ts              # Vercel/Nitro config
│       └── plugin-packages.ts           # Virtual module injected at build time
│
├── specs/                               # Canonical contracts
│   ├── harness-agent-spec.md            # Pi agent + timeout contract
│   ├── slack-agent-delivery-spec.md     # Entry points, reply delivery, lifecycle
│   ├── skill-capabilities-spec.md       # Plugin perms, credential issuance
│   ├── agent-prompt-spec.md             # Prompt ownership + sections
│   ├── plugin-spec.md                   # Plugin manifest contract
│   ├── security-policy.md               # Sandbox, credential, token policy
│   ├── agent-execution-spec.md          # Codex execution rubric
│   ├── agent-session-resumability-spec.md # Multi-slice timeout recovery
│   └── oauth-flows-spec.md              # OAuth authorization contract
│
├── policies/                            # Repository policy docs
│   ├── code-comments.md                 # Docstring/JSDoc defaults
│   └── policy-template.md               # Policy-doc template
│
├── scripts/                             # Build/release/dev helpers
├── AGENTS.md                            # Engineering instructions for Claude Code
├── CONTRIBUTING.md                      # Local dev setup
└── .craft.yml                           # Craft release manifest (8 packages)
```

**File path conventions:**
- `packages/junior/src/chat/*` → chat composition, runtime, services, state
- `packages/junior/src/handlers/*` → HTTP entry points (webhooks, OAuth, resume)
- `specs/*` → Canonical contracts (read-first for implementation)
- `apps/example/` → Deployable reference; plugin discovery happens here via `plugin-packages.ts`

## 4. Tech Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| **Runtime** | Node.js 20+, TypeScript 5.9 | pnpm monorepo, tsup bundling |
| **Framework** | Hono 4.12 | Lightweight web framework |
| **Agent** | Pi (0.73.0), Vercel AI Gateway 3.0 | Thinking-level routing, streaming |
| **MCP** | @modelcontextprotocol/sdk 1.29.0 | HTTP, stdio, stdio-over-SSH transports |
| **Sandbox** | Vercel Sandbox (2.0.0-beta) | Container runtime for skill commands |
| **Slack Integration** | @chat-adapter/slack 4.28.1 | Chat SDK abstraction + Slack adapter |
| **State** | Redis (redis/node 4.x) or memory | Via @chat-adapter/state-redis/-memory |
| **Queue** | Redis Streams | Long-running turn execution + retry |
| **Credentials** | jose 6.2.2 (JWT signing) | OAuth OIDC, GitHub App JWT, API headers |
| **Monitoring** | @logtape/logtape 2.0.7, @sentry/node 10.50 | OpenTelemetry-based logging + tracing |
| **Testing** | vitest 4.1.5, MSW 2.14.3, vitest-evals | Unit, integration, eval layers |
| **Linting** | oxlint 1.63.0, prettier 3.8.3 | Fast async linting |
| **Bundling** | tsup 8.5.1 | Tree-shaking, multiple entry points |
| **Deployment** | Vercel (nitro), Nitro 3.0 | Serverless + queue workers |

**Key dependencies:**
- `bash-tool` (1.3.16) — command safety + escaping
- `just-bash` (2.14.2) — robust bash parsing
- `yaml` (2.8.4) — plugin.yaml parsing
- `zod` (4.4.3) — validation schemas
- `node-html-markdown` (2.0.0) — HTML→markdown for web fetch
- `ai` (6.0.175) — Vercel AI SDK (provider abstraction)
- `@sinclair/typebox` (0.34.49) — JSON Schema generation (tool schemas)

## 5. Agent Execution Model

**Turn execution contract** (specs/harness-agent-spec.md:38-72):

1. **Instantiation:** Fresh Pi `Agent` + restored durable conversation Pi message history + current turn user context
2. **Thinking-level routing:** Fast classifier determines reasoning budget (none/low/medium/high)
3. **Tool loop:** Agent generates, tools execute (bash, readFile, webSearch, skill/MCP, Slack actions), results fed back
4. **Timeout:** AGENT_TURN_TIMEOUT_MS (default 720s), aborts with resumable checkpoint if session available
5. **Terminal output:** Last assistant text after final tool result, joined by `\n`, trimmed
6. **Delivery:** Assembled text → Slack thread post + optional files/reactions + long-running status

**Thinking levels** (specs/harness-agent-spec.md:48-57):
- `none` — greetings, acks (no substantive work)
- `low` — deterministic one-step answers, no tools/facts/verification
- `medium` (default) — ordinary work, explanations, likely tool use, follow-ups
- `high` — code changes, debugging, research, non-trivial drafting

**Durable state management:**
- Conversation Pi message history persisted after each successful reply delivery
- Per-turn runtime context **not** stored in durable history (cleaned before persistence)
- Thread context seeded once from Slack history if empty; reuses persisted state thereafter
- Artifacts (images, code blocks) tracked separately in thread-scoped artifacts state

**Streaming contract:**
- Stream `message_update`/`text_delta` events from Pi Agent
- Insert `\n` between consecutive assistant messages (mirrors final join)
- Streaming callback failures logged, don't fail the turn

## 6. LLM Integration

**Provider abstraction** (via Vercel AI SDK + Gateway):
- `AI_MODEL` (default: openai/gpt-5.4) — main turn agent
- `AI_FAST_MODEL` (default: openai/gpt-5.4-mini) — thinking classifier, lightweight routing
- `AI_VISION_MODEL` — dedicated image understanding (optional)
- `AI_WEB_SEARCH_MODEL` (default: xai/grok-4-fast-reasoning) — webSearch tool

**Prompt architecture** (specs/agent-prompt-spec.md):
- **Static system prompt** (`buildSystemPrompt()` in src/chat/prompt.ts)
  - Identity, core operating rules, Slack output contract, tool safety boundaries
  - Byte-stable across conversations (enables prompt-prefix caching)
  - No runtime data, no requester identity, no conversation state
  
- **Turn-specific context** (`buildTurnContextPrompt(...)`)
  - Requester identity, thread background, resumed-turn metadata, current capabilities
  - Attached to user message (not stored in durable history)
  - Stripped before persisting conversation history to next turn

- **Tool definitions:** Generated from `@sinclair/typebox` schemas, kept in-prompt for each agent execution

**Tool invocation policy:**
- Model emits tool calls; harness executes immediately with result feeding
- No explicit "call tools before answering" instruction (implicit from execution contract)
- Tool results are intermediate; only final assistant text becomes user-visible output

## 7. UI / UX Surfaces

**Slack entry points** (specs/slack-agent-delivery-spec.md:59-72):
1. **DMs** → explicit-mention path, always reply-eligible
2. **Channel @mentions** → explicit-mention path (manual @junior)
3. **Subscribed-thread follow-ups** → passive subscribed-message path (may or may not reply)
4. **Assistant-thread lifecycle** (Slack native) → initialize/refresh assistant metadata + context

**Reply delivery mechanisms:**
- **Thread reply** → Primary user-visible output (assistant markdown → mrkdwn translation)
- **Status posts** → In-flight progress (e.g., "Analyzing stack trace...") + finalized-reply metadata footer
- **Continuation posts** → Resume after timeout/auth pause (optional follow-up confirmation)
- **Files** → Uploaded artifacts (screenshots, code, reports)
- **Reactions** → Processing indicator (`:hourglass_flowing_sand:` on incoming) or completion marker

**Auth UI:**
- Private auth link delivered via Slack DM when OAuth/credentials required (specs/slack-agent-delivery-spec.md:160+)
- OAuth callback resumes paused turn automatically after user authorizes
- No public "awaiting auth" message in thread (implicit from status absence)

**Diagnostics surfaces:**
- `/api/info` → Plugin names, skills, DESCRIPTION.md (public, no secrets)
- `/` → Dashboard (local dev only, not hardened for public deployment)

## 8. Integrations

**Plugin architecture** (specs/plugin-spec.md):
- **Definition:** YAML manifest + skills directory + optional credentials/OAuth/MCP
- **Discovery:** Explicit via `apps/example/plugin-packages.ts` (virtual module) or local `app/plugins/*/`
- **Auto-detection:** npm packages with `plugin.yaml` at root or `plugins/*/plugin.yaml`

**Bundled providers:**
- `@sentry/junior-sentry` — Sentry issue search/details
- `@sentry/junior-github` — GitHub issue/PR/repo workflows (GitHub App auth)
- `@sentry/junior-linear` — Linear issue CRUD (OAuth bearer)
- `@sentry/junior-notion` — Notion page search (OAuth)
- `@sentry/junior-hex` — Datadog data warehouse queries (Pup CLI)
- `@sentry/junior-agent-browser` — Playwright browser automation
- `@sentry/junior-datadog` — Datadog event investigation (Pup CLI)

**Credential models:**
- **OAuth bearer** (linear, notion) — Plugin declares endpoints, Junior handles authorization code flow
- **GitHub App** (github) — Installation token on host, JWT signed server-side
- **API headers** (sentry, datadog) — Non-secret placeholders in sandbox, host authenticates via egress proxy
- **Sandbox egress proxy** (specs/skill-capabilities-spec.md:75-80) — All sandbox requests to registered providers proxied with host-injected credentials

**MCP integration:**
- HTTP (url-only), stdio (command-based), stdio-over-SSH
- Per-plugin MCP allowlists (tools filtered by plugin)
- MCP OAuth callbacks (separate from provider callbacks)
- Stable dispatcher tools (callMcpTool, searchMcpTools, loadSkill)

## 9. Notable Features

1. **Thinking-level routing (specs/harness-agent-spec.md:48-57)**
   - Classifier pre-routes each turn to appropriate reasoning depth
   - Reduces latency for simple follow-ups while preserving depth for complex analysis

2. **Session resumability (specs/agent-session-resumability-spec.md)**
   - Multi-slice timeout recovery: agent pauses at safe boundaries, resumes with checkpoint context
   - Requester identity preserved; conversation coherence maintained across resumals

3. **Durable conversation history (harness-agent-spec.md:42-44)**
   - Persists conversation-level Pi message history after reply delivery
   - Per-turn runtime context stripped before storage (prevents stale data replay)

4. **Sandbox credential issuance (specs/security-policy.md:32-35, skill-capabilities-spec.md:75-80)**
   - Vercel Sandbox OIDC token validation + requester-bound session leasing
   - Short-lived provider credentials issued at command time, never written to sandbox env
   - API header transforms on host; sandbox sees placeholders only

5. **Plugin system with zero-core-changes (specs/plugin-spec.md)**
   - Adding a new provider requires YAML manifest + skills; zero core runtime changes
   - Manifest declares capabilities, OAuth, credentials, runtime dependencies, MCP endpoints
   - Plugin-level CLI dependency snapshots (versioned in build-time registry)

6. **Passive subscribed-thread filtering**
   - Explicit @mentions bypass all filtering (always reply)
   - Passive thread follow-ups checked against thread policy (may be silent)
   - Prevents spam in dormant threads

7. **Architecture discipline (AGENTS.md:75-90)**
   - Feature-based colocation (group by domain, not by tech role)
   - Service modules depend on small injected ports (not broad deps bags)
   - No barrel re-exports within feature subdirectories
   - Slack modules never import chat runtime; runtime never imports Slack directly

## 10. Deployment Story

**Development:**
```bash
pnpm install  # or: make install (runs dotagents install too)
pnpm dev      # Starts Vercel dev + Cloudflare tunnel
pnpm test     # Unit + integration tests
pnpm evals    # End-to-end conversation evals (requires Vercel sandbox access)
pnpm typecheck
pnpm skills:check  # Validates skill YAML syntax
```

**Vercel deployment:**
1. Create Vercel project, link to GitHub
2. Configure Slack app (bot token, signing secret)
3. Set `REDIS_URL` (Vercel Postgres or external Redis)
4. Pull env vars: `pnpm dev:env` or `vercel env pull`
5. Deploy: `git push` → GitHub Actions → `pnpm build` + `@vercel/functions` runtime
6. Slack webhook URL: `https://<vercel-url>/api/webhooks/slack`
7. OAuth callbacks: `/api/oauth/callback/:provider`, `/api/oauth/callback/mcp/:provider`

**Nitro build system:**
- Entry: `apps/example/server.ts` (Hono app)
- Output: Vercel Functions + edge middleware + background jobs (via Redis Streams + queue worker)
- Plugin packages resolved at build time via `plugin-packages.ts` virtual module
- Sandbox snapshot registry built during `pnpm build` (runtime-dependency versions pinned)

**Release process (Craft-managed):**
- 8 packages released in lockstep (major.minor.patch)
- Trigger via GitHub Actions (Release workflow)
- Bumps version in `.craft.yml`, scripts, and CI files
- npm publish via Craft (requires npm credentials)
- Check consistency: `pnpm release:check` (aligns `.craft.yml`, CI, docs, README)

**Monitoring:**
- OpenTelemetry spans + logs via @logtape (TELEMETRY.md roadmap)
- Sentry error tracking (optional via SENTRY_DSN)
- Health endpoint: `GET /health`
- Diagnostics dashboard: `GET /` (local dev only)

**Production security policy (specs/security-policy.md):**
- Sandbox OS: Amazon Linux 2023 (dnf package manager)
- Network: Explicit allowlist + credential-bearing requests proxied
- Secrets: Long-lived secrets in host secret storage only (never in skill dirs)
- Token issuance: Short-lived, requester-bound, activated per-command
- Containers: Ephemeral, untrusted filesystem

---

## Related Reading (Thor Alignment)

For Thor engineers building multi-agent orchestration:

- **Turn-based reasoning:** See specs/harness-agent-spec.md (Pi integration, thinking levels, timeout model)
- **Durable conversation state:** specs/agent-session-resumability-spec.md (conversation history persistence + multi-slice checkpoints)
- **MCP policy gateway:** specs/plugin-spec.md + mcp/tool-manager.ts (tool allowlists, per-plugin registration, OAuth isolation)
- **Sandbox isolation:** src/chat/sandbox/* (Vercel Sandbox session, OIDC validation, egress proxy)
- **Slack/webhook gateway:** src/chat/ingress/, src/chat/runtime/slack-runtime.ts, specs/slack-agent-delivery-spec.md
- **Execution discipline:** specs/agent-execution-spec.md (mandatory contract-first, vertical-slice, completion gates)
- **Security:** specs/security-policy.md (least privilege, short-lived credentials, sandbox isolation, no secrets in repo)

Key architectural patterns to reference:
1. **Service injection** (app/factory.ts) — Testable, composable services
2. **Feature-based colocation** (src/chat/tools/slack, tools/web, tools/skill) — Scalable module structure
3. **Durable state abstraction** (src/chat/state/adapter.ts) — Redis/memory agnostic
4. **Credential broker pattern** (src/chat/credentials/factory.ts) — OAuth + API headers + GitHub App
5. **MCP tool dispatcher** (tools/skill/call-mcp-tool.ts) — Safe, allowlist-based tool invocation

