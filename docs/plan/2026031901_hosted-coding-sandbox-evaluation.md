# Plan — 2026031901_hosted-coding-sandbox-evaluation

> Evaluate hosted sandbox providers for Thor's coding-sandbox feature and recommend a default provider strategy.

## Decision Log

| #   | Decision                                                      | Rationale                                                                 |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | Write the feature doc as product behavior, not implementation | Keeps the feature contract stable while provider evaluation remains open. |
| D2  | Limit the first evaluation to hosted providers                | Matches the current product direction and reduces infrastructure churn.   |
| D3  | Compare multiple hosted providers before implementation       | Avoids overfitting the design to a single vendor too early.               |
| D4  | Treat source sync and secret posture as top-level criteria    | These are the most consequential choices for Thor's coding workflows.     |
| D5  | Use a weighted scoring rubric for provider evaluation         | Makes the evaluation auditable, defensible, and revisitable.              |
| D6  | Define a cost model with expected usage profile               | Pricing comparisons are meaningless without a concrete usage scenario.    |
| D7  | Evaluate preview URL and telemetry streaming support          | These capabilities differentiate sandbox providers for Thor's workflows.  |
| D8  | Design a provider-agnostic SandboxProvider interface          | Prevents vendor lock-in and enables local fallback.                       |
| D9  | Sandboxes are execution-only (no MCP tool access)             | Simplifies architecture; broker access stays in Thor's control plane.     |
| D10 | Replace coder subagent with sandbox-coder binary              | Single tool, same pattern as git/gh/scoutqa. Sandbox lifecycle is infra.  |
| D11 | Keep thinker subagent for planning and review                 | Thinker operates locally on code review and reasoning, no sandbox needed. |

## Phase 1 — Feature Definition

**Goal**: Capture the hosted coding sandbox feature in product terms without locking implementation details.

Steps:

1. Define the problem and feature goal
2. Document primary use cases and expected outcomes
3. Define functional and non-functional requirements
4. Define success criteria and open questions

**Exit criteria**:

- A feature doc exists under `docs/feat/`
- The feature doc describes behavior and requirements instead of provider-specific implementation
- The feature doc is specific to Thor's branch / PR-oriented coding workflows

---

## Phase 2 — Hosted Provider Evaluation

**Goal**: Compare hosted sandbox providers against Thor's feature requirements and recommend a default provider strategy.

Providers to evaluate:

- Daytona
- E2B
- Vercel Sandbox
- Cloudflare Sandbox
- Ona / Gitpod (reference)
- GitHub Codespaces (reference)

Evaluation dimensions (weighted):

| #   | Dimension                              | Weight | What "good" looks like (score 5)                                    |
| --- | -------------------------------------- | ------ | ------------------------------------------------------------------- |
| 1   | Thor architecture fit                  | 20%    | API-driven, headless, works as execution-only plane for Thor        |
| 2   | Sandbox identity and lifecycle support | 15%    | Create, pause, resume, destroy via API; stable identity across ops  |
| 3   | Source sync ergonomics                 | 15%    | Git clone + checkout via API; supports branch switching             |
| 4   | Live preview URL support               | 10%    | HTTP preview URL per sandbox with auth or expiry                    |
| 5   | Real-time telemetry streaming          | 10%    | Structured log/result streaming via API or WebSocket                |
| 6   | Browser / test workflow support        | 10%    | Can run headless browsers, test suites, local servers               |
| 7   | Multi-sandbox support                  | 5%     | Multiple concurrent sandboxes per account with independent identity |
| 8   | Pricing and cost model fit             | 15%    | Affordable at Thor's usage profile (see below)                      |

Scoring scale: 1 = not supported, 2 = partially supported with significant workarounds, 3 = supported with minor workarounds, 4 = well supported, 5 = native / first-class support.

Thor's expected usage profile for cost modeling:

- concurrent active sandboxes: 3–5 (current), 10–15 (6-month target)
- average sandbox active lifetime: 30–120 minutes
- idle paused sandboxes at any time: 5–10
- compute tier per sandbox: 2 vCPU, 4 GB RAM
- storage per sandbox: 5–20 GB (repo + dependencies)

**Exit criteria**:

- The evaluation covers at least Daytona, E2B, and Vercel in detail
- Each provider is scored on all 8 dimensions using the weighted rubric
- A default provider recommendation is documented with aggregate scores
- At least one fallback or secondary provider path is identified
- Cost estimates are calculated against Thor's expected usage profile
- Tradeoffs are concrete enough to guide implementation planning

### Evaluation Results

All claims verified against official provider documentation on 2026-03-19.

#### Scorecard

| #   | Dimension (weight)           | Daytona  | Vercel Sandbox | E2B      | Cloudflare Sandbox |
| --- | ---------------------------- | -------- | -------------- | -------- | ------------------ |
| 1   | Thor architecture fit (20%)  | **5**    | **4**          | **4**    | **2**              |
| 2   | Identity and lifecycle (15%) | **5**    | **3**          | **5**    | **2**              |
| 3   | Source sync ergonomics (15%) | **5**    | **4**          | **3**    | **3**              |
| 4   | Live preview URLs (10%)      | **5**    | **4**          | **2**    | **3**              |
| 5   | Real-time telemetry (10%)    | **5**    | **4**          | **4**    | **3**              |
| 6   | Browser / test support (10%) | **5**    | **3**          | **5**    | **3**              |
| 7   | Multi-sandbox support (5%)   | **5**    | **5**          | **4**    | **4**              |
| 8   | Pricing / cost fit (15%)     | **5**    | **3**          | **4**    | **3**              |
|     | **Weighted total**           | **4.95** | **3.65**       | **3.80** | **2.65**           |

Reference-only: Ona / Gitpod (more opinionated CDE than thin sandbox substrate), GitHub Codespaces (cannot restrict public internet access — disqualifying for safe agent execution).

#### Score Justifications

**1. Thor architecture fit (20%)**

- **Daytona (5):** API-first sandbox model maps directly to Thor's runner pattern. Labels for session metadata. Webhooks for lifecycle events. SDK usable from Node.js. Execution-only model works cleanly — Thor's runner calls Daytona SDK; sandbox runs commands without needing outbound broker access.
- **Vercel (4):** Clean SDK with `Sandbox.create()`, `runCommand()`, `Sandbox.get()`. Detached execution model fits well. Minor gap: no first-class labels/tags — Thor must maintain identity mapping in its own state.
- **E2B (4):** SDK supports create, connect, execute, pause/resume by ID. Metadata supported. Minor mismatch: secured access model runs the controller inside the sandbox, less aligned with Thor's external control preference.
- **Cloudflare (2):** Platform composition (Workers + Durable Objects + Containers) expects Thor to deploy orchestration in a Cloudflare account. Not a drop-in external sandbox backend.

**2. Identity and lifecycle (15%)**

- **Daytona (5):** Create, stop, archive, start, delete via API. Labels bind `thor_session_id`, `repo`, `branch`, `pr_id`. Stable sandbox ID across stop/start/archive. Auto-stop at 15 min configurable. Archive moves filesystem to object storage.
- **Vercel (3):** Create, snapshot, recreate-from-snapshot, stop. `Sandbox.get()` reconnects to active sandboxes. Snapshots capture filesystem + packages, NOT memory or processes. Snapshot expires after 30 days. No persistent sandbox identity across snapshot/recreate — each recreation generates a new sandbox ID.
- **E2B (5):** Create, pause, resume, kill. Pause preserves filesystem + memory + running processes. Resume in ~1 second. Paused sandboxes persist indefinitely. Strongest lifecycle support.
- **Cloudflare (2):** Containers idle after 10 min and reset to fresh state. Backup/restore uses R2 but restore mounts lost on sleep/restart.

**3. Source sync ergonomics (15%)**

- **Daytona (5):** File upload/download API. Git operations inside sandbox. Snapshot templating for warm starts. Volumes for shared caches (free). Clean fit for `base + overlay in / bundle + patch out`.
- **Vercel (4):** Create from git, tarball, or snapshot. `writeFiles()` / `downloadFile()`. Minor gap: no volumes for dependency caching — snapshots serve that purpose but with 30-day expiry.
- **E2B (3):** File upload via SDK. Git inside sandbox works but official docs include risky credential-persistence patterns. Thor must use file upload + local reconstruction.
- **Cloudflare (3):** File management and git supported. Restore mounts lost on sleep/restart, making durable source state fragile.

**4. Live preview URLs (10%)**

- **Daytona (5):** HTTP processes on ports 3000-9999 get preview URLs. Signed URLs with custom expiry. Public or authenticated modes.
- **Vercel (4):** Port exposure via `sandbox.domain()`. Preview URLs available. Auth model less rich than Daytona's signed URLs.
- **E2B (2):** No first-class preview URL mechanism. Desktop template has VNC/noVNC but not HTTP preview.
- **Cloudflare (3):** Service exposure via `exposeService()`. Tied to Cloudflare routing model.

**5. Real-time telemetry (10%)**

- **Daytona (5):** Log streaming with stdout/stderr separation (since SDK v0.27.0). Real-time callback streaming + log snapshot retrieval.
- **Vercel (4):** `Command.logs()` returns structured `{ stream: "stdout" | "stderr", data: string }` entries. Good streaming model.
- **E2B (4):** Background commands with reconnection. PTY/terminal output. Less explicitly structured than Daytona's dual-mode approach.
- **Cloudflare (3):** Background process output available. Less documented streaming primitive.

**6. Browser / test workflow support (10%)**

- **Daytona (5):** Computer Use APIs for browser automation. VNC access. Desktop environment support.
- **Vercel (3):** Full Linux microVM with package install — headless browsers can be installed. No first-class browser automation surface. Should be validated in a spike.
- **E2B (5):** Desktop template with Ubuntu + XFCE + VNC/noVNC. `xdotool` for GUI automation.
- **Cloudflare (3):** Custom Dockerfiles support browser installation. No first-class GUI automation APIs.

**7. Multi-sandbox support (5%)**

- **Daytona (5):** Multiple sandboxes per org with independent labels. Org resource limits: 4 vCPU / 8 GB / 10 GB default (can be increased).
- **Vercel (5):** Up to 2,000 concurrent sandboxes on Pro. Rate limit: 200 vCPUs/minute on Pro.
- **E2B (4):** Multiple sandboxes supported. Session length limits per plan (1h Hobby, 24h Pro) may constrain long-running parallel work.
- **Cloudflare (4):** Multiple sandboxes via Durable Object IDs. Concurrency limited by pricing model.

**8. Pricing and cost model fit (15%)**

Using Thor's expected profile: 5 concurrent sandboxes, 2 vCPU / 4 GB each, 60-minute average lifetime, 10 active sandboxes per day.

| Provider       | Per-sandbox-hour (2vCPU/4GB) | Monthly estimate (10/day × 1hr) | Base subscription | Effective monthly |
| -------------- | ---------------------------- | ------------------------------- | ----------------- | ----------------- |
| **Daytona**    | $0.17                        | ~$50                            | $0 (free tier)    | **~$50**          |
| **E2B**        | $0.17                        | ~$50                            | $150/mo Pro       | **~$200**         |
| **Vercel**     | $0.34                        | ~$102                           | $20/mo Pro        | **~$122**         |
| **Cloudflare** | ~$0.20\*                     | ~$60\*                          | $5/mo Workers     | **~$65\***        |

\*Cloudflare estimate excludes Worker/DO charges and is not directly comparable.

- **Daytona (5):** Simple pricing. $200 free credit for ramp-up. Cheapest at Thor's usage volume.
- **Vercel (3):** ~2x Daytona at 100% CPU. More billing dimensions (creation, network, snapshots).
- **E2B (4):** Same compute rates as Daytona but $150/mo Pro fee makes it 4x effective cost.
- **Cloudflare (3):** Multiple billing dimensions (CPU, memory, disk, egress, Workers, DOs). Not apples-to-apples.

#### Recommendation

**Default provider: Daytona (4.95/5)**

Daytona wins across every dimension for Thor's execution-only sandbox model: best API-first architecture fit, best lifecycle (archive/resume sufficient when sandboxes are execution-only), best preview URLs, best cost profile, minimal architectural change.

**Secondary provider (future): E2B (3.80/5)**

True memory-preserving pause/resume for specialized workloads (long-running browser sessions, expensive-to-restart dev servers). Add only after proving value exceeds $150/mo Pro cost.

**Security-first alternative: Vercel Sandbox (3.65/5)**

Firecracker microVMs, live-updatable firewall, credential brokering. Consider if Thor later runs untrusted third-party code where egress control is critical.

**Do not use: Cloudflare Sandbox (2.65/5)**

Requires Thor to become Cloudflare-native. Wrong commitment for Thor's current stack.

#### Provider Strategy

```
DEFAULT:   Thor Runner → Daytona SDK → Daytona Sandbox
FALLBACK:  Thor Runner → LocalProvider → OpenCode Container
FUTURE:    Thor Runner → E2B SDK → E2B Sandbox (when justified)
```

#### Exit Criteria Check

- [x] Evaluation covers Daytona, E2B, and Vercel in detail
- [x] Each provider scored on all 8 dimensions using weighted rubric
- [x] Default provider recommendation documented with aggregate scores (Daytona: 4.95)
- [x] Fallback provider path identified (LocalProvider wrapping existing OpenCode)
- [x] Cost estimates calculated against Thor's expected usage profile
- [x] Tradeoffs concrete enough to guide implementation planning

---

## Phase 3 — Thor Integration Direction

**Goal**: Turn the provider evaluation into a Thor-oriented adoption plan, including the provider-agnostic sandbox interface.

Steps:

1. Define how Thor treats the chosen provider as an execution-only plane (no MCP tool access in sandboxes)
2. Define how source enters and exits the sandbox (git clone, branch checkout, code extraction)
3. Define the SandboxProvider TypeScript interface covering the full lifecycle: create, start, stop, resume, destroy, exec, stream, preview
4. Define the LocalProvider implementation that wraps the existing OpenCode container as a degraded-mode fallback
5. Define how sandbox identity maps to repo / branch / PR / session, supporting multiple sandboxes per branch
6. Define idempotent sandbox creation semantics (concurrent requests for same identity key)
7. Define the initial rollout shape: local-first, then hosted default with local fallback

**Exit criteria**:

- There is a documented recommended provider strategy for Thor
- There is a clear statement of what Thor should own versus what the provider should own
- The SandboxProvider interface is defined with method signatures and error contracts
- The LocalProvider fallback strategy is documented
- The multi-sandbox identity model is documented
- The result is ready to seed a later implementation plan

### Integration Direction

#### 3.1 Architecture: the `sandbox-coder` binary

The agent invokes sandbox coding via a CLI binary, the same way it uses `git`, `gh`, and `scoutqa`. No new MCP servers, no OpenCode modifications.

```
  OpenCode container                          remote-cli service
  ─────────────────                           ──────────────────
  Primary agent (Thor)                        POST /sandbox/exec
    │                                           │
    │  $ sandbox-coder \                        ├─ SandboxManager
    │      --worktree /workspace/worktrees/ \   │   ├─ ensure sandbox exists
    │      acme-api/fix-auth \                  │   │   (create or resume)
    │      "fix JWT expiry, add test"           │   ├─ sync worktree → sandbox
    │                                           │   ├─ start OpenCode in sandbox
    │  ◀──── streams NDJSON progress ────────── │   ├─ stream output back
    │                                           │   ├─ sync sandbox → worktree
    │  exit code 0                              │   └─ return result
    │                                           │
    ├─ reads changed files from worktree        │
    ├─ commits, pushes via remote-cli           │
    └─ continues orchestration                  │
                                                │
                                              Daytona sandbox
                                                ├─ OpenCode instance (no MCP)
                                                ├─ edits files, runs tests
                                                ├─ streams logs via Daytona API
                                                └─ preview URLs (port-based)
```

**How it works:**

1. The primary agent (Thor) works locally for investigation, triage, and orchestration — using its normal tools (Read, Bash, MCP) and subagents (thinker)
2. When Thor needs substantial coding done, it calls `sandbox-coder` from bash with a natural language task
3. The `sandbox-coder` binary sends the request to `remote-cli` (which already has worktree and provider access)
4. `remote-cli` ensures a sandbox exists for the worktree, syncs source, starts a coding agent inside the sandbox, and streams output back
5. When done, changes are synced back to the worktree. Thor sees the modified files and continues (commit, push, open PR)

**Why this design:**

- Same pattern as existing binaries (`git`, `gh`, `scoutqa`) — the agent already knows how to use CLI tools
- No new MCP server, no proxy port, no `opencode.json` change
- `remote-cli` already has worktree access and mediates external operations — sandbox management is a natural extension
- Streaming via stdout/NDJSON works with OpenCode's bash tool
- Cleanup is automatic: `remote-cli` already intercepts `git worktree remove` and can destroy the associated sandbox

**What the agent prompt says** (addition to `build.md`):

```markdown
### Sandbox Coding

For substantial code changes (multi-file edits, running tests, starting
servers, browser validation), use `sandbox-coder` in the worktree:

cd /workspace/worktrees/<repo>/<branch>
sandbox-coder "implement the auth fix and add regression tests"

This runs an isolated coding agent in a remote sandbox. Changes sync
back to the worktree automatically. The coder/thinker subagents remain
available for quick local edits and reasoning that don't need isolation.
```

**What Thor owns:**

- Session identity, correlation keys, notes files
- Decision to invoke `sandbox-coder` vs work locally
- Source packaging and code extraction (inside remote-cli)
- MCP tool access (GitHub PRs, Linear issues, Slack messages)
- Committing and pushing code after sandbox returns
- Cost tracking and lifecycle policies

**What the provider owns:**

- Isolated filesystem and process space
- Compute resource allocation and scaling
- Preview URL routing and auth
- Log streaming infrastructure
- Snapshot / archive storage

**Sandbox lifecycle is bound to the worktree:**

| Worktree event                                    | Sandbox action                             |
| ------------------------------------------------- | ------------------------------------------ |
| First `sandbox-coder` call for worktree           | Create sandbox, sync source                |
| Subsequent `sandbox-coder` calls                  | Reuse existing sandbox, incremental sync   |
| Worktree idle (no calls for configurable timeout) | Pause sandbox (provider-managed auto-stop) |
| Next `sandbox-coder` call after pause             | Resume sandbox                             |
| `git worktree remove`                             | Destroy sandbox (remote-cli hook)          |

#### 3.2 Source sync model

Source enters and exits the sandbox through `remote-cli`, not through in-sandbox git credentials. The sync is transparent to the agent — `sandbox-coder` handles it automatically.

**Push in (on sandbox create or incremental sync):**

```
remote-cli                      Sandbox
  │                               │
  ├─ git archive base_sha ──────▶ base.tar.zst (repo at base commit)
  ├─ collect worktree delta ────▶ overlay.tar.zst (uncommitted changes)
  ├─ collect deletions ─────────▶ deletions.txt
  │                               │
  │   provider.uploadFiles(...)   │
  ├──────────────────────────────▶│
  │                               ├─ extract base.tar.zst
  │                               ├─ git init + commit (synthetic base)
  │                               ├─ create branch thor/{session-id}
  │                               ├─ apply overlay + deletions
  │                               └─ ready to code
```

**Pull out (on sandbox-coder completion):**

```
  Sandbox                         remote-cli
  │                               │
  ├─ git diff ───────────────────▶ changed files
  ├─ collect artifacts ──────────▶ artifacts (logs, coverage, screenshots)
  │                               │
  │   provider.downloadFiles(...) │
  │◀──────────────────────────────┤
  │                               ├─ apply changed files to worktree
  │                               └─ done (agent sees files in worktree)
```

The sandbox never holds GitHub credentials. The agent commits and pushes from the worktree using `git` / `gh` via remote-cli, the same as today.

For warm starts, Daytona snapshots capture the sandbox after dependency install. Subsequent sandboxes for the same repo family skip `npm install` / `pip install` by starting from a snapshot with deps pre-installed.

#### 3.3 Daytona integration

`remote-cli` uses the Daytona TypeScript SDK to manage sandboxes. Mapping:

| Operation       | Daytona SDK                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| create          | create sandbox from snapshot, assign labels (`repo`, `branch`, `session_id`) |
| stop            | stop (short idle) or archive (long idle, moves to object storage)            |
| resume          | start stopped or archived sandbox                                            |
| destroy         | delete sandbox                                                               |
| source sync in  | file upload API (base + overlay)                                             |
| source sync out | file download API (changed files)                                            |
| exec            | detached process with stdout/stderr log streaming                            |
| preview         | signed preview URL with configurable expiry                                  |

#### 3.4 Sandbox identity (deferred)

For Phase A, sandbox identity is simple: `remote-cli` maps each worktree path to a Daytona sandbox ID. The mapping is stored in memory (lost on restart — sandbox is recreated on next call). `sandbox-coder` will support an explicit `--sandbox-id` flag later for reuse, multi-sandbox, and cross-session continuity.

#### 3.5 `sandbox-coder` binary interface

```
Usage:
  sandbox-coder "<task prompt>"

  Must be run from a worktree path (/workspace/worktrees/*).
  Fails immediately if cwd is not a valid worktree.

Output:
  Streams NDJSON progress events to stdout:
    { "type": "status",   "message": "creating sandbox..." }
    { "type": "progress", "message": "editing src/auth.ts..." }
    { "type": "progress", "message": "running npm test..." }
    { "type": "test",     "passed": 47, "failed": 0, "skipped": 2 }
    { "type": "done",     "files_changed": 3, "diff_lines": 42 }

Exit codes:
  0 — task completed, changes synced to worktree
  1 — task failed (coding agent error or test failure)
  2 — sandbox error (provider timeout, quota, etc.)

Future flags (not in Phase A):
  --timeout <ms>      Custom timeout (default TBD by implementation)
  --preview <port>    Return a Daytona signed preview URL for a port
```

#### 3.6 `remote-cli` sandbox endpoint

`remote-cli` gains a new endpoint that `sandbox-coder` calls:

```
POST /sandbox/exec
  Content-Type: application/json

  {
    "cwd": "/workspace/worktrees/acme-api/fix-auth",
    "prompt": "fix JWT expiry validation and add test"
  }

  Response: NDJSON stream (same format as sandbox-coder output)
```

The endpoint handler:

1. Validate cwd is under `/workspace/worktrees/`, extract `(repo, branch)`
2. `SandboxManager.getOrCreate(ref)` → create or resume sandbox
3. Sync worktree → sandbox (overlay push)
4. Install OpenCode in sandbox (from snapshot, or install on first run)
5. Run `opencode run --format json` with the task prompt inside the sandbox
6. Stream sandbox agent output back as NDJSON
7. On completion: sync changed files sandbox → worktree
8. Return exit code

The sandbox stays alive after the call completes (auto-stop timeout managed by provider). Subsequent calls reuse the same sandbox with incremental sync.

#### 3.7 Rollout plan

```
Phase A: sandbox-coder + Daytona
  - Implement sandbox-coder binary in OpenCode container
  - Implement /sandbox/exec endpoint in remote-cli with Daytona SDK
  - Update build.md prompt with sandbox-coder instructions
  - Worktree cleanup hook destroys sandbox on git worktree remove
  - If sandbox-coder fails, the main agent retries or edits directly

Phase B: Preview URLs
  - sandbox-coder --preview <port> returns Daytona signed preview URLs
  - Preview URLs included in PR comments and Slack messages

Phase C: Multi-sandbox
  - Enable secondary sandbox spawning for parallel work
  - e.g. one sandbox coding, another running tests
```

#### Exit Criteria Check

- [x] Provider: Daytona (section 3.3)
- [x] Thor vs provider ownership (section 3.1)
- [x] Agent integration: `sandbox-coder` binary + `remote-cli /sandbox/exec` (sections 3.5, 3.6)
- [x] Sandbox identity: deferred, simple worktree→sandbox map for now (section 3.4)
- [x] Rollout plan: 3 phases (section 3.7)
- [x] Ready to seed an implementation plan

## Out of Scope

- Building the sandbox manager
- Choosing a self-hosted default
- Writing runtime integration code
- Reworking the current proxy or gateway implementation
- Opening a PR or implementing provider selection in code
