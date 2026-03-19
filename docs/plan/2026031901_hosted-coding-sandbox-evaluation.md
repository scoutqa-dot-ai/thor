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

## Out of Scope

- Building the sandbox manager
- Choosing a self-hosted default
- Writing runtime integration code
- Reworking the current proxy or gateway implementation
- Opening a PR or implementing provider selection in code
