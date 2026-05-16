# Goose: Technical Overview for Thor Integration

**Audience:** Engineers building Thor — multi-agent coding orchestration platform (Slack/webhook gateway, MCP policy gateway, OpenCode runner in Daytona sandboxes).

**Local path:** `/Users/son.dao/repos/daohoangson/goose`

**Scope:** Comprehensive technical analysis of goose architecture, runtime model, integration patterns, and deployment story. Reference: goose v1.34.0 (AAIF-maintained open-source project).

---

## 1. Purpose & Positioning

Goose is a **general-purpose native AI agent** that runs on your machine (or in containers/remote environments). It's not exclusively for code—it handles research, writing, automation, data analysis, and general workflows.

- **License:** Apache 2.0
- **Governance:** Agentic AI Foundation (AAIF) at Linux Foundation (donated by Block, Jun 2024)
- **Repository:** [github.com/aaif-goose/goose](https://github.com/aaif-goose/goose)
- **Documentation:** https://goose-docs.ai/
- **Stack:** **Rust backend** (performant, portable) + **Electron desktop app** + **CLI** + **API (goosed server)**
- **Core Tagline:** Your native open source AI agent — desktop app, CLI, and API for code, workflows, and everything in between

Key positioning vs. competitors:
- MCP-first design (model context protocol standard integration)
- 15+ LLM provider support (Anthropic, OpenAI, Google, Ollama, local inference, etc.)
- 70+ MCP extensions (growing ecosystem)
- Runs locally by default, privacy-focused
- Strong on session management and context window optimization
- Recipe-based automation (YAML/JSON config files)

---

## 2. High-Level Architecture

### 2.1 Core Components

Goose operates using **three main components**:

1. **Interface Layer:** Desktop app (Electron+React), CLI (rustyline/cliclack), or API (goosed HTTP server)
2. **Agent Core:** Interactive loop orchestration, LLM chat, tool calling, context management
3. **Extensions:** MCP servers exposing tools (filesystem, terminal, web, memory, custom APIs)

```
┌────────────────────────────────────────────────┐
│  User Interface                                │
│  • Desktop App (Electron)  crates/  (none)    │
│  • CLI Terminal            goose-cli/          │
│  • HTTP API (WebSocket)    goosed server       │
└────────────────────────────────────────────────┘
         ▲                           ▼
         │                           │
         └───────────────────────────┘
              goosed: server binary
              (crates/goose-server)
         ▲                           ▼
    ┌────┴──────────────────────────┴────┐
    │                                    │
    │    Goose Agent Runtime             │
    │    • Interactive Loop              │
    │    • LLM Integration (Provider)    │
    │    • Tool Calling                  │
    │    • Context Management            │
    │    (crates/goose/src/agents)       │
    │                                    │
    └────────────┬───────────────────────┘
                 │ (ACP / MCP)
         ┌───────┴────────────┐
         ▼                    ▼
    ┌─────────────┐  ┌──────────────────┐
    │ Built-in   │  │ External MCP     │
    │ Extensions │  │ Servers (70+)    │
    │ • Filesystem│  │ • GitHub, Figma  │
    │ • Terminal │  │ • Brave, Playwright
    │ • Memory   │  │ • Custom APIs    │
    │ • Autovis  │  │ (via rmcp)       │
    │ (goose-mcp)│  │                  │
    └────────────┘  └──────────────────┘
```

#### Interactive Loop (Simplified)

1. **Human Request:** User gives a task/question
2. **Provider Chat:** goose sends request + available tools to LLM provider
3. **Model Tool Call:** LLM creates a tool call (JSON)
4. **Tool Execution:** goose runs the tool and gathers results
5. **Response to Model:** Results fed back to LLM
6. **Context Revision:** Stale/irrelevant context pruned (token management)
7. **Model Response:** LLM sends final answer, loop restarts

---

## 3. Repo Layout

```
goose/
├── crates/
│   ├── goose/              # Core agent logic (125K LOC), providers, extensions
│   │   ├── src/agents/     # Agent loop, interactive session management
│   │   ├── src/providers/  # LLM provider implementations (15+)
│   │   ├── src/conversation/ # Chat history, message formatting
│   │   ├── src/context_mgmt/ # Token budgeting, context revision
│   │   ├── src/execution/  # Tool calling, sandbox runtime
│   │   ├── src/session/    # Persistent session storage
│   │   ├── src/recipe/     # Recipe parsing (YAML/JSON)
│   │   ├── src/security/   # Prompt injection detection
│   │   └── src/acp/        # Agent Client Protocol support
│   ├── goose-cli/          # CLI entry point (crates/goose-cli/src/main.rs)
│   │                       # Commands: session, run, configure, recipes, etc.
│   ├── goose-server/       # HTTP/WebSocket server (goosed binary)
│   │   ├── src/routes/     # REST API endpoints
│   │   ├── src/commands/   # Agent subcommand logic
│   │   └── src/session_event_bus/ # Real-time session updates
│   ├── goose-mcp/          # MCP extension implementations
│   │   ├── src/mcp_server_runner.rs # MCP server bootstrap
│   │   └── [memory, computer_controller, autovisualiser, tutorial]
│   ├── goose-sdk/          # Rust SDK for ACP clients (Claude, Codex)
│   ├── goose-acp-macros/   # Procedural macros for ACP decorators
│   ├── goose-test/         # Test utilities
│   └── goose-test-support/ # Test fixture helpers
│
├── ui/
│   ├── desktop/            # Electron app (React, TypeScript)
│   │   ├── src/            # React components, UI logic
│   │   ├── src-tauri/      # Tauri plugin system (newer)
│   │   └── openapi.json    # Generated API schema (auto-generated)
│   ├── text/               # TUI (Ink/React terminal UI)
│   ├── goose2/             # Next-gen desktop variant
│   ├── sdk/                # JS/TS SDK for embedding goose
│   └── goose-binary/       # CLI binary wrapper
│
├── oidc-proxy/             # OAuth2 / OIDC proxy for auth flows
├── services/               # Ancillary services
├── recipe-scanner/         # Recipe discovery / validation
├── workflow_recipes/       # Community recipe repository
├── evals/                  # Benchmarking / open-model-gym
├── examples/               # Example agents, recipes
├── scripts/                # Build, release, distribution scripts
├── documentation/          # Docusaurus site (https://goose-docs.ai/)
│   ├── docs/
│   │   ├── getting-started/
│   │   ├── guides/        # How-to guides (recipes, sessions, MCP, etc.)
│   │   ├── goose-architecture/
│   │   ├── mcp/           # 70+ MCP server integrations
│   │   └── tutorials/
│   └── blog/              # 100+ blog posts
│
├── Cargo.toml             # Workspace manifest (Rust 1.91.1)
├── Cargo.lock             # Pinned dependencies
├── flake.nix              # Nix environment setup
├── Justfile               # Task automation (dev, build, test, release)
└── AGENTS.md              # Development guidelines (source of truth)
```

**Key Entry Points:**
- **CLI:** `crates/goose-cli/src/main.rs` — Terminal interface
- **Server:** `crates/goose-server/src/main.rs` — HTTP/WebSocket API (binary: `goosed`)
- **Agent:** `crates/goose/src/agents/agent.rs` — Core loop implementation
- **UI Desktop:** `ui/desktop/src/main.ts` — Electron entry point

---

## 4. Tech Stack

### Backend (Rust-only)

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Runtime** | Tokio 1.49+ (async) | Full-featured async runtime, `tokio-util` for compat |
| **HTTP** | Axum 0.8 | Zero-copy, minimal, WebSocket support via `tokio-tungstenite` |
| **Serialization** | serde + serde_json + serde_yaml | JSON/YAML config, ADF/markdown conversion |
| **Cryptography** | rustls 0.23 (aws-lc-rs) OR openssl (feature flag) | No OpenSSL by default (rustls preferred) |
| **Database** | SQLx 0.8 (SQLite) | Compile-time checked SQL, runtime migrations |
| **LLM Integration** | reqwest 0.13 (HTTP client) | Bearer auth, OAuth2, custom headers, streaming |
| **MCP Transport** | rmcp 1.7+ | Client, server, stdio, HTTP/Unix socket transports |
| **Tracing** | tracing 0.1 + OpenTelemetry 0.31 (optional) | Structured logging, OTEL export (OTLP/stdout) |
| **Task Scheduling** | tokio-cron-scheduler 0.15 | Cron expressions for scheduled tasks |
| **Syntax Highlighting** | Tree-sitter (10+ languages) | Go, Java, Python, JavaScript, TypeScript, Rust, Kotlin, Swift, Ruby + built-in |
| **Code Parsing** | Tree-sitter + regex | Symbol extraction, code structure analysis |
| **Process Management** | process-wrap 9.1 | Subprocess isolation, signal handling |

### Local Inference (Optional Feature: `local-inference`)

- **Whisper ASR:** candle (Hugging Face) + llama-cpp-2
- **LLM Inference:** llama-cpp-2 with GPU support (Metal on macOS, CUDA/Vulkan optional)
- **Audio:** symphonia (decoding) + rubato (resampling)

### Frontend (Electron + React + TypeScript)

- **Electron Forge:** Build system, code signing, auto-updates
- **Vite:** Module bundler (fast, ES modules)
- **React 18+** + TypeScript
- **Tauri (experimental):** Lighter alternative to Electron
- **Terminal UI:** Ink (React for terminal) in `ui/text/`

### Dependencies

**Core tooling:**
- `clap` 4.x — CLI argument parsing (derive macros)
- `anyhow` — Error handling
- `uuid` v4/v7 — ID generation
- `chrono` — Timestamps
- `minijinja` 2.x — Template engine (recipe variables)
- `regex` — Pattern matching
- `once_cell` — Lazy statics
- `tokio-stream` + `futures` — Async utilities

**External APIs:**
- `oauth2` 5.x — OAuth2 flows (Databricks, Tetrate, GitHub, ChatGPT)
- `keyring` 3.6 — Secure credential storage (OS keychains)
- `jsonwebtoken` — JWT signing for Vertex AI
- `webbrowser` — Open auth URLs

**Version:** goose v1.34.0, Rust 1.91.1 MSRV

---

## 5. Agent Execution Model

### 5.1 Interactive Loop

**Flow (crates/goose/src/agents/agent.rs):**

```
loop {
  1. format_prompt(user_msg, system_context, available_tools)
  
  2. provider.chat(prompt) -> ChatResponse {
       message: "...",
       tool_calls: [ { name: "...", args: {...} } ]
     }
  
  3. for each tool_call:
       - extension.call_tool(tool_name, params)
       - catch errors, return results as tool_result
  
  4. add assistant + tool results to conversation
  
  5. context_revision::prune_context() // token mgmt
  
  6. if user_wants_to_continue:
       loop back to step 1
     else:
       end session
}
```

**Context Management:**
- Token budgeting based on model context window
- Summarize old messages with faster LLM (e.g., Haiku)
- Semantic/algorithmic pruning (stale content removal)
- Preserve latest interaction, user instructions, tool results
- Cost optimization: grep instead of reread, find-and-replace for large files

### 5.2 Planning & Recipes

**Recipes (crates/goose/src/recipe/mod.rs):**
- YAML/JSON config files with instructions, prompts, parameters
- Parameterized activities (clickable buttons in UI)
- Subrecipes (sequential or parallel execution)
- Retry logic with success validation
- Response schema for structured output

**Example Recipe (goose-self-test.yaml):**
```yaml
version: "1.0.0"
title: "Code Review"
description: "Review code changes"
instructions: |
  You are a code reviewer. Focus on clarity, performance, and correctness.
extensions:
  - name: filesystem
parameters:
  - key: file_path
    input_type: string
    requirement: required
    description: "File to review"
activities:
  - "Review for bugs"
  - "Check performance"
  - "Suggest improvements"
```

### 5.3 Sessions

**Persistent State (crates/goose/src/session/):**
- SQLite database stores sessions, messages, tool calls
- Session ID (UUID v7), created/updated timestamps
- Conversation history, context snapshots
- Resume capability (load old session, continue interaction)
- Smart context management (rebuild context from DB)

---

## 6. LLM Integration

### 6.1 Supported Providers

**15+ Providers (crates/goose/src/providers/):**

| Provider | Auth | Models | Features |
|----------|------|--------|----------|
| **Anthropic** | API Key | Claude 3.x, 4 | Prompt caching, streaming |
| **OpenAI** | API Key | GPT-4o, GPT-5 | Function calling, streaming |
| **Google Gemini** | API Key | Gemini 3, 2 | Multimodal, thinking levels |
| **Anthropic (via Bedrock)** | AWS creds | Claude via Bedrock | Enterprise AWS integration |
| **Azure OpenAI** | API Key | GPT-4, GPT-3.5 | Enterprise Azure integration |
| **Ollama** | None (local) | Local models (Qwen, Llama) | Free, offline-first |
| **OpenRouter** | API Key | 100+ models | Unified gateway, rate limiting |
| **Databricks** | Token + Host | DBRX, etc. | Enterprise data platform |
| **Groq** | API Key | LLaMA, Mixtral | Fast inference |
| **Mistral** | API Key | Codestral, Pixtral | Specialized, multimodal |
| **LM Studio** | None (local) | Local via OpenAI-compat API | Desktop LLM runner |
| **Local Inference** | None | Llama-cpp-2, Whisper | Rust candle feature |
| **GitHub Copilot** | OAuth (device flow) | OpenAI, Anthropic, Google models | Via GitHub infrastructure |
| **ChatGPT Codex** | OAuth (browser) | GPT-5 Codex | ChatGPT Plus/Pro subscription |
| **Tetrate** | OAuth (PKCE) | Multi-vendor (Claude, GPT, etc.) | Agent router, $10 free credits |

**Provider Trait (crates/goose/src/providers/base.rs):**
```rust
#[async_trait]
pub trait Provider: Send + Sync {
    async fn chat(&self, request: ChatRequest) -> ProviderResult<ChatResponse>;
    async fn list_models(&self) -> ProviderResult<Vec<Model>>;
    // streaming support, OAuth, rate limiting
}
```

### 6.2 Tool Calling (Function Calling)

- **OpenAI format:** `tool_calls` in ChatCompletion response
- **Anthropic format:** Tool use blocks in message
- **goose layer:** Normalizes all providers to unified tool calling interface
- **Error handling:** Malformed calls → send error to LLM as new tool result
- **Token savings:** Prompt caching (Anthropic + OpenRouter + Bedrock + LiteLLM)

### 6.3 MCP Integration

**Model Context Protocol (rmcp 1.7+):**
- **Transport:** Stdio (child process), HTTP with streaming (WebSocket), Unix socket
- **Server Bootstrap (crates/goose-mcp/src/mcp_server_runner.rs):**
  ```rust
  pub enum McpCommand {
      AutoVisualiser,
      ComputerController,
      Memory,
      Tutorial,
  }
  
  // Usage: goosed mcp auto-visualiser
  // Exposes MCP tools via stdio
  ```
- **Built-in Servers:** 4 internal (filesystem, memory, computer control, visualization)
- **External Integration:** 70+ community servers (GitHub, Figma, Brave, Playwright, etc.)
- **ACP Providers:** goose can delegate to external ACP agents (Claude Code, Codex)
  - Passes goose extensions to the ACP agent as MCP servers

---

## 7. UI / UX Surfaces

### 7.1 Desktop App (ui/desktop/)

**Electron + React, Vite + TypeScript**
- Native macOS, Linux, Windows apps
- Spawns goosed server in subprocess
- Multi-tab architecture (one server per tab/window)
- Features:
  - Session browser, recipe library
  - Model/provider selection UI
  - Activity bubbles (parameterized quick-start buttons)
  - Settings panel (extensions, permissions, logs)
  - Real-time streaming responses
- **Signing/Notarization:** macOS app signing, Windows SmartScreen
- **Auto-updates:** Electron auto-updater

### 7.2 CLI (crates/goose-cli/src/main.rs)

**Rustyline + cliclack interactive prompts**

**Commands:**
- `goose session` — Start interactive session
- `goose run -t "<prompt>"` — One-shot task
- `goose run --recipe <recipe.yaml>` — Run recipe (automation)
- `goose configure` — Setup LLM provider, extensions
- `goose list-recipes` — Discover recipes
- `goose logs` — Tail logs
- `goose version` — Print version

**UX:**
- Streaming responses (real-time output)
- Colored code blocks (bat syntax highlighting)
- Tab completion for commands
- Rich error messages with diagnostics

### 7.3 Server API (crates/goose-server/)

**HTTP + WebSocket via Axum**

**REST Endpoints (goosed):**
- `GET /api/sessions` — List sessions
- `POST /api/sessions` — Create session
- `GET /api/sessions/{id}/messages` — Chat history
- `POST /api/sessions/{id}/messages` — Send message
- `GET /api/models` — List available models
- `POST /api/providers/configure` — Setup LLM provider
- `GET /api/extensions` — List installed extensions
- WebSocket: `/ws/sessions/{id}` — Real-time streaming

**OpenAPI Documentation:**
- Generated schema: `ui/desktop/openapi.json` (auto-generated post-build)
- Utoipa integration for auto-documentation
- Used by UI to validate API contracts

### 7.4 Text UI (ui/text/)

**Ink (React in terminal)**
- Component-based TUI rendering to fixed-width terminal
- Alternative interface for headless servers
- [See AGENTS.md](crates/goose/AGENTS.md) for Ink constraints (no overflow, fixed dimensions)

---

## 8. Integrations

### 8.1 MCP Extensions (70+)

**Categories:**
- **Code Tools:** GitHub, GitMCP, VS Code, JetBrains, Playwright, Selenium
- **Web/Scraping:** Brave, Fetch, Puppeteer, Firecrawl, Exa (search)
- **Productivity:** Asana, Slack, Figma, Excalidraw, Google Drive, Notion
- **Data:** MongoDB, PostgreSQL, Neon, Supabase, OpenMetadata
- **LLM Observability:** Langfuse, MLflow, Cognee
- **Specialized:** Blender (3D), Elevenlabs (TTS), Jetpack, Ollama (local), Apify (web automation)
- **Utilities:** Memory, Skills, Computer Controller, Tutorial, Extension Manager

**Discovery:** Community registry (goose-docs.ai/mcp), npm-based, GitHub repos

### 8.2 Skill System

**Skills (instructions + prompts):**
- Pre-defined task templates (code review, testing, documentation)
- Loaded from `.goosehints` file (project root)
- Custom, project-scoped instructions
- Example: `skill "test-python-file" "Run pytest on {{file_path}}"`

### 8.3 Authentication Patterns

**OAuth2 Flows:**
- **Device Flow:** GitHub Copilot, ChatGPT (browser-based)
- **PKCE:** Tetrate, some custom providers
- **Databricks:** OAuth + Bearer tokens
- **Keyring Integration:** Secure credential storage (macOS Keychain, Linux Secret Service, Windows Credential Manager)

**Environment Variables:**
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, etc.
- `GOOSE_PROVIDER`, `GOOSE_MODEL`
- Config files: `~/.config/goose/config.json` (macOS/Linux), AppData on Windows

---

## 9. Notable Features

### 9.1 Context Management & Token Optimization

**Problem:** LLM context windows are expensive/limited.

**Solutions:**
1. **Summarization:** Older messages summarized by faster model (Haiku summarizes for Opus)
2. **Pruning:** Algorithmic removal of irrelevant context
3. **Efficient Patterns:**
   - Grep instead of reading full files
   - Find-and-replace vs. rewriting entire files
   - Ripgrep to skip binary/ignored files
   - Verbose command output truncated/summarized
4. **Token Budgeting:** Context revision module ensures messages stay within window

### 9.2 MCP-First Design

- All extensions via MCP standard (no custom plugin system)
- Built-in extensions are MCP servers (can be run standalone)
- ACP provider delegation (goose → Claude Code / Codex with extensions passed through)
- Composable: recipes can orchestrate multiple agents

### 9.3 Recipes & Automation

- **YAML/JSON-driven:** Parameterized tasks for non-developers
- **Retry Logic:** Built-in success validation
- **Subrecipes:** Compose tasks (sequential `sub_recipes` array)
- **Persistent Execution:** Sessions survive restarts
- **Headless Mode:** `--recipe` flag for CI/CD, webhooks

### 9.4 Session Management

- **Resume:** Load old session, continue conversation
- **Context Snapshots:** DB stores full history for context rebuilding
- **Smart Recall:** Preserve important context across pruning
- **Activity Bubbles:** Desktop UI shows parameterized quick-start buttons

### 9.5 Security & Safety

- **Prompt Injection Detection:** (crates/goose/src/security/)
- **Adversary Mode:** Test agent robustness to adversarial inputs
- **Allowlist:** Fine-grained tool permissions
- **Code Mode:** Controlled code execution with sandboxing (pctx_code_mode feature)

### 9.6 Local Inference (Feature: `local-inference`)

- Run Whisper (speech-to-text) locally without cloud APIs
- Llama-cpp-2 for offline LLM inference
- Metal/CUDA/Vulkan GPU acceleration (macOS/Linux/Windows)
- Reduces cost and privacy risk for audio/text tasks

---

## 10. Deployment Story

### 10.1 Distribution Channels

**Desktop:**
- macOS: `.app` (signed/notarized), `.dmg`
- Linux: `.deb` (Debian/Ubuntu), `.flatpak`, ZIP
- Windows: `.msi`, `.exe`
- Download: https://goose-docs.ai/docs/getting-started/installation

**CLI:**
- Homebrew: `brew install goose` (coming soon)
- Curl: `curl https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash`
- GitHub Releases: Pre-built binaries (macOS/Linux/Windows)
- Build from source: `cargo build --release -p goose-cli`

**Server:**
- Docker: `ghcr.io/aaif-goose/goose:latest` (multi-stage build, ~340MB)
- Binary: `goosed` (HTTP server)
- Docker Compose for orchestration

### 10.2 Docker Deployment

**Multi-stage build (Dockerfile):**
```dockerfile
# Stage 1: Rust build with optimizations
FROM rust:latest as builder
WORKDIR /build
COPY . .
RUN cargo build --release -p goose-cli \
    && strip target/release/goose

# Stage 2: Minimal runtime
FROM debian:bookworm-slim
COPY --from=builder /build/target/release/goose /usr/local/bin/
ENTRYPOINT ["goose"]
```

**Running in Docker:**
```bash
docker run --rm \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e GOOSE_PROVIDER=openai \
  -e GOOSE_MODEL=gpt-4o \
  ghcr.io/aaif-goose/goose run -t "Analyze this code"
```

**With Volumes (file access):**
```bash
docker run --rm -v $(pwd):/workspace -w /workspace \
  ghcr.io/aaif-goose/goose:latest session
```

### 10.3 Headless / CI-CD

**Use Cases:**
- Automated code review in GitHub Actions
- Recipe-driven data processing in cron jobs
- Webhook-triggered tasks (via server API)

**Example (GitHub Actions):**
```yaml
- name: Code review with goose
  run: |
    docker run --rm \
      -e ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }} \
      ghcr.io/aaif-goose/goose run --recipe review-recipe.yaml
```

### 10.4 Server (goosed)

**Persistent HTTP/WebSocket API:**

```bash
# Start server
goosed agent

# HTTP API available at http://localhost:8000/api/
# OpenAPI docs: http://localhost:8000/api/docs
```

**Multi-window/tab:** Each Electron window spawns its own goosed subprocess (similar to Chrome's model).

**Remote Access (Experimental):**
- Telegram gateway for mobile access
- Daytona sandbox integration (OpenCode runner)

---

## 11. Code Organization & Key Files

### Core Agent Loop
- `crates/goose/src/agents/agent.rs` — Main interactive loop (100+ lines)
- `crates/goose/src/conversation/` — Message formatting, chat history
- `crates/goose/src/execution/` — Tool calling and result handling

### Context & Pruning
- `crates/goose/src/context_mgmt/` — Token budgeting, pruning algorithm
- Context revision: summarize old messages, remove irrelevant content

### Providers (LLM Integration)
- `crates/goose/src/providers/base.rs` — Provider trait
- `crates/goose/src/providers/anthropic.rs` — Anthropic (Claude)
- `crates/goose/src/providers/openai.rs` — OpenAI (GPT)
- `crates/goose/src/providers/gemini.rs` — Google Gemini
- `crates/goose/src/providers/*/` — 12 more providers

### Sessions & Data
- `crates/goose/src/session/` — SQLite persistence, session lifecycle
- `crates/goose/src/recipe/` — Recipe parsing (YAML/JSON)

### Security
- `crates/goose/src/security/` — Prompt injection detection, adversary mode
- `crates/goose/src/permission/` — Tool allowlist, sandboxing

### Server API
- `crates/goose-server/src/routes/` — REST endpoints (Axum)
- `crates/goose-server/src/session_event_bus.rs` — Real-time updates

### Extensions
- `crates/goose-mcp/src/` — MCP server implementations
  - Auto-visualiser, computer controller, memory, tutorial
- `crates/goose/src/extensions/` — Built-in extension registry

### Tests
- `crates/goose/tests/` — Integration tests (MCP, providers, recipes)
- `cargo test` — Run all tests
- `just record-mcp-tests` — Record MCP responses for replay

---

## 12. Development & Testing

### Build & Run

```bash
# Setup (activate Hermit)
source bin/activate-hermit

# Build
cargo build                    # Debug
cargo build --release          # Optimized
just release-binary            # Release + OpenAPI schema

# Test
cargo test                     # All tests
cargo test -p goose           # Specific crate
just record-mcp-tests         # Record MCP fixtures

# Format & Lint
cargo fmt
cargo clippy --all-targets -- -D warnings

# Desktop UI
just generate-openapi         # After server changes
just run-ui                   # Start Electron dev server
```

### Code Quality Standards

- **Self-documenting:** Prefer clear names over comments
- **Errors:** Use `anyhow::Result<T>` consistently
- **Logging:** Clean up logs, only add for errors/security events
- **Comments:** Only for complex algorithms or non-obvious "why"
- **Testing:** Add to `crates/goose/tests/` or `goose-self-test.yaml`

### Development Guidelines (from AGENTS.md)

- Test new features by updating `goose-self-test.yaml` and running `goose run --recipe goose-self-test.yaml`
- Provider implementation: Extend `Provider` trait (see `crates/goose/src/providers/base.rs`)
- MCP extension: Add to `crates/goose-mcp/`
- Server changes: Run `just generate-openapi` to sync schema with UI
- Always sign commits: `git commit -s` (DCO requirement)

---

## 13. Licensing & Governance

- **License:** Apache 2.0
- **Governance:** Agentic AI Foundation (AAIF) at Linux Foundation
- **Maintainers:** Block (original), now AAIF community
- **Funding:** Linux Foundation sponsors
- **Community:** Discord (~10k members), GitHub Discussions, Issues

---

## 14. Integration Points for Thor

Goose as a **Thor component** or **parallel system**:

### 14.1 Similarities to Thor
- **Multi-agent orchestration:** goose can run subrecipes (parallel/sequential)
- **Tool composition:** 70+ MCP extensions (vs. Thor's internal tools)
- **Sandbox execution:** Optional code-mode with llama-cpp-2, local inference
- **Session persistence:** SQLite-backed conversation history
- **Recipe-driven:** YAML/JSON automation (like Thor's workflows)
- **Webhook/API:** goosed HTTP server supports remote invocation

### 14.2 Potential Integration Paths

1. **Goose as MCP Server:** Thor invokes goose via MCP (goose as tool provider)
2. **Thor → Goose Delegation:** Thor routes tasks to goose for specialized LLM handling
3. **Shared Extensions:** Both consume same MCP servers (GitHub, Figma, etc.)
4. **Recipe Interop:** Convert Thor workflows to goose recipes for reuse
5. **Session Bridge:** Store goose sessions in Thor's context for continuity

### 14.3 Key Architectural Differences

| Aspect | Goose | Thor (Expected) |
|--------|-------|---|
| **Core Language** | Rust | Likely TypeScript/Go or multi-lang |
| **UI** | Electron Desktop + CLI + Server | Slack/web gateways |
| **Extension Model** | MCP (standard) | Custom tool interface? |
| **Context Management** | Token budgeting, pruning | Session-scoped memory? |
| **Authorization** | OAuth2, keyring | Slack OAuth, webhook tokens |
| **Persistence** | SQLite (local) | Distributed DB (Redis/Postgres?) |

---

## 15. Summary

**Goose at a Glance:**

- **Positioning:** Rust-native, MCP-first, general-purpose AI agent
- **Architecture:** Interactive loop (LLM → tools → results → repeat) with context optimization
- **Runtime:** Tokio async, Axum HTTP, rmcp for extensions
- **UI:** Electron desktop, terminal CLI, HTTP/WebSocket server API
- **Integration:** 15+ LLM providers, 70+ MCP extensions, recipe automation
- **Deployment:** Binary (macOS/Linux/Windows), Docker, CI/CD headless, server mode
- **Notable:** Session persistence, token budget optimization, prompt injection detection, local inference, ACP provider delegation
- **Governance:** AAIF/Linux Foundation, Apache 2.0, active community
- **For Thor:** Natural sibling for agentic orchestration, shared MCP ecosystem, composable via recipes/APIs

**Recommended Reading:**
- [goose-architecture.md](documentation/docs/goose-architecture/goose-architecture.md) — Detailed component breakdown
- [AGENTS.md](AGENTS.md) — Development handbook
- [CONTRIBUTING.md](CONTRIBUTING.md) — PR expectations, code quality
- [Providers guide](documentation/docs/getting-started/providers.md) — LLM integration patterns
- [Recipes reference](documentation/docs/guides/recipes/recipe-reference.md) — Automation DSL

---

**Document Version:** goose v1.34.0 (May 2026)
**Audience:** Thor engineering team
**Scope:** 900 lines, architecture + integration points
**Reference Density:** File:line refs throughout

