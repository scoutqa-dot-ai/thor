# AGENTS.md — Way of Work

Instructions for AI agents working on this repository.

## Project Stage — read this first

This repo is **greenfield, pre-v1, MVP state**. There are **no production users, no deployment, and no backward-compatibility commitments**. Nothing here is load-bearing for anyone yet. The goal of every change is to lay a **solid foundation for after v1**, not to protect an installed base that does not exist.

Default posture for any feature or fix:

- **Clean over compatible.** Prefer the correct end-state design over an incremental migration that preserves current internals. There is no old behavior to keep working — if a refactor is right, do it in one move and delete the old path. No deprecation shims, no dual code paths, no feature flags "for safety".
- **Correctness and simplicity first.** Choose the simplest design that is actually correct. Remove special cases instead of accumulating them. Fewer moving parts, fewer producers/owners of a concern, single source of truth.
- **Practical, not speculative.** Build what the current problem needs. Do not add extensibility, config surface, or abstraction layers for hypothetical future requirements ("YAGNI"). Generalize only when a second concrete case exists.
- **No migration-safety scaffolding.** Because nothing is deployed, skip work whose only purpose is staying green across a rollout: before/after parity tests, phased "keep it running between steps" sequencing, compatibility adapters. Phases are still useful as review/checkpoint boundaries; the integration/E2E workflow is the gate (see Workflow §3), not equivalence-to-today.
- **Don't over-engineer.** When a design starts adding layers to hedge risk that only exists for live systems, stop and pick the clean single-path version instead. If you find yourself preserving an awkward boundary "to be safe", that is the signal to simplify.

This posture holds **until this section is explicitly changed**. When v1 ships and real users/deployments exist, revisit these defaults — but do not assume that has happened.

## Workflow

1. **Plan before code when warranted** — New features or PoCs should start with a plan document in `docs/plan/`. Format: `YYYYMMDDNN_<slug>.md`. The plan contains phases, decision log, exit criteria, and out-of-scope items.
   - Bug fixes or isolated changes on top of an existing plan should append to that existing plan instead of creating a new one.
   - Small, focused feature adjustments can skip a new plan file when the scope is obvious and contained.

2. **Phase-based implementation** — Work proceeds one phase at a time:
   - Implement the phase
   - Run self-tests against the phase exit criteria using unit tests or other isolated local verification
   - Proceed to the next phase once the phase passes isolated validation locally

3. **Integration verification** — After all phases are complete:
   - Push the branch to GitHub to trigger the relevant E2E or integration workflow
   - If the required workflow does not trigger automatically, dispatch it manually
   - Choose the workflow to run based on the scope of the change
   - Use the GitHub workflow result as the final verification gate
   - Once the required push checks are green, open a PR against the appropriate base branch

4. **Commit discipline**:
   - One commit per phase (not per file, not per feature)
   - Commit message format: `<type>: <short description>` (e.g. `feat: add mcp approval flow`, `chore: project init`)
   - Never commit secrets, `.env` files, or `node_modules`
   - Push after all phases are complete so GitHub workflows can verify the full change
   - Create the PR only after the required push checks pass

5. **Document decisions** — When making a non-obvious choice (library, pattern, architecture), add it to the active plan's Decision Log table. Future sessions can read this to understand why things are the way they are.

6. **Environment variable discipline** — When adding, renaming, or removing an environment variable, update every required surface in the same change: `docker-compose.yml`, `.env.example`, `README.md` Deployment Configuration, relevant GitHub workflow env blocks, tests/fixtures, and any active plan docs. Do not leave required env vars documented only in code or compose.

7. **Behavior-focused tests** — Prefer tests that prove user-visible behavior, safety boundaries, integration contracts, and non-obvious fail-fast paths. Avoid tests that only lock obvious string construction, env-var trimming/default wrappers, one-line pass-through helpers, or other implementation details unless that exact output is a meaningful product/API contract. If the code is straightforward and already covered through a higher-level behavior test, prefer no direct unit test over low-value coverage.

8. **Rate limiting** — App-level rate limiters / DDoS protection are deferred to infrastructure (ingress, proxy, WAF, or platform controls). CodeQL missing-rate-limit alerts are acknowledged, but do not add Express middleware limiters unless a future plan explicitly changes this policy.

9. **OpenCode harness boundaries** — Thor-side wrappers and tools should not re-enforce timeouts, output caps/truncation, or output transformations already handled by the OpenCode harness. Add Thor-side enforcement only when Thor has its own explicit product/API contract or safety boundary (for example, endpoint-specific JSON formatting or a documented internal output limit).

10. **Agent-facing prompts and skills** — Write in terms of what the agent can do, and describe only state the agent can actually observe or act on. Concretely:
    - Describe supported command/argument shapes positively, listing the forms that work.
    - Keep server-side env vars, config keys, internal service or component names, and other implementation details the agent cannot reach from inside its container out of agent-facing docs. When a policy is enforced elsewhere, let the denial response from that boundary be the signal, and refer to it generically (e.g. "server-side policy").
    - Document project-specific constraints, redirects, and surprises; leave standard tool/library behavior to the tool's own help.
    - Frame the listed surface as "constraints documented here" and leave unlisted shapes to be confirmed by the denial response, so policy can tighten without a skill rewrite. Reserve absolute claims like "any arguments accepted" for surfaces guaranteed to stay that way.
    - State each rule in one place — keep overview bullets and per-section detail from restating the same constraint.

## Repository Structure

```
thor/
├── AGENTS.md                  # This file
├── CLAUDE.md                  # Claude Code guidance
├── docker/                    # Container definitions and service configs
├── docker-volumes/            # Local mounted data for dockerized services
├── docs/
│   ├── feat/                  # Feature specs and architecture
│   └── plan/                  # Implementation plans
├── packages/
│   ├── admin/                 # Admin web UI
│   ├── common/                # Shared config, logging, notes, schemas
│   ├── gateway/               # Inbound webhook gateway (Slack, etc.)
│   ├── opencode-cli/          # OpenCode helper wrappers for remote-cli
│   ├── remote-cli/            # CLI + MCP policy gateway
│   └── runner/                # Agent runner + trigger endpoint
├── scripts/                   # Test and utility scripts
├── docker-compose.yml
├── package.json               # pnpm workspace root
├── pnpm-workspace.yaml
└── tsconfig.base.json         # Shared TypeScript config
```

## Conventions

- **Language**: TypeScript (strict mode)
- **Package manager**: pnpm with workspaces
- **Runtime**: Node.js 22+
- **Formatting**: Default TypeScript/ESLint conventions. No custom config until needed.
- **OpenCode version alignment**: When bumping `@opencode-ai/sdk`, also bump the OpenCode server/package version in the Dockerfile in the same change so the client and server stay aligned.
- **External schema drift**: any upstream whose shape evolves under us — e.g. OpenCode events and MCP tool schemas/policy, and almost certainly other boundaries in this repo (treat these two as examples, not the full list) — should be consumed through **strongly-typed, strict schemas**, not loose or defensive parsing. When a shape drifts, **fail fast and loudly wherever that helps us catch and fix it** — strict parsing that surfaces the unknown/changed shape so we update our schema — rather than investing in tolerant fallback rendering or graceful degradation that hides the drift. While MVP there is no persisted history or deployed state to preserve, so prefer letting drift break visibly and fixing the schema. The one exception is keeping a *live* run alive: where failing would take down a running agent, downgrade to log-and-tolerate **in production only** (e.g. `PolicyDriftError` tolerated when `isProduction`) and keep the dev path strict. When you hit another such boundary, apply this same posture. Known instances to read first: `docs/plan/2026051601_opencode-event-view-schema.md` (OpenCode events) and `packages/remote-cli/src/mcp-handler.ts` (MCP policy).
- **No frameworks unless justified** — Express for HTTP, raw TypeScript for everything else. Every added dependency should have a reason in the plan.

## Context for New Sessions

When starting a new session on this repo:

1. Read `AGENTS.md` (this file) for workflow rules
2. Read the latest plan in `docs/plan/` for current work context
3. Read `README.md` for the overall architecture
4. Check `git log --oneline -10` for recent progress
5. Check for `TODO` / `FIXME` comments in `packages/` and `scripts/` for incomplete work
