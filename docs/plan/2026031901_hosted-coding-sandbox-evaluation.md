# Plan — 2026031901_hosted-coding-sandbox-evaluation

> Evaluate hosted sandbox providers for Thor's coding-sandbox feature and recommend a default provider strategy.

## Decision Log

| #   | Decision                                                      | Rationale                                                                 |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | Write the feature doc as product behavior, not implementation | Keeps the feature contract stable while provider evaluation remains open. |
| D2  | Limit the first evaluation to hosted providers                | Matches the current product direction and reduces infrastructure churn.   |
| D3  | Compare multiple hosted providers before implementation       | Avoids overfitting the design to a single vendor too early.               |
| D4  | Treat source sync and secret posture as top-level criteria    | These are the most consequential choices for Thor's coding workflows.     |

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

Evaluation dimensions:

1. Thor architecture fit
2. Sandbox identity and lifecycle support
3. Source sync ergonomics
4. Secure access to Thor-managed broker services
5. Detached execution, logs, and previews
6. Browser / test workflow support
7. Pricing and operational tradeoffs

**Exit criteria**:

- The evaluation covers at least Daytona, E2B, and Vercel in detail
- A default provider recommendation is documented
- At least one fallback or secondary provider path is identified
- Tradeoffs are concrete enough to guide implementation planning

---

## Phase 3 — Thor Integration Direction

**Goal**: Turn the provider evaluation into a Thor-oriented adoption plan.

Steps:

1. Define how Thor should treat the chosen provider as the execution plane
2. Define how source enters and exits the sandbox at a high level
3. Define how the sandbox reaches Thor-managed brokers without becoming a secret store
4. Define how sandbox identity maps to repo / branch / PR / session
5. Define the initial rollout shape and follow-up validation work

**Exit criteria**:

- There is a documented recommended provider strategy for Thor
- There is a clear statement of what Thor should own versus what the provider should own
- The result is ready to seed a later implementation plan

## Out of Scope

- Building the sandbox manager
- Choosing a self-hosted default
- Writing runtime integration code
- Reworking the current proxy or gateway implementation
- Opening a PR or implementing provider selection in code
