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
