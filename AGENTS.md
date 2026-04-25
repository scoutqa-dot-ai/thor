# AGENTS.md — Way of Work

Instructions for AI agents working on this repository.

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

## Repository Structure

```
thor/
├── AGENTS.md                  # This file
├── docker/                    # Container definitions and service configs
├── docker-volumes/            # Local mounted data for dockerized services
├── docs/
│   ├── feat/                  # Feature specs and architecture
│   └── plan/                  # Implementation plans
├── packages/
│   ├── admin/                 # Admin web UI
│   ├── common/                # Shared config, logging, notes, schemas
│   ├── gateway/               # Inbound webhook gateway (Slack, etc.)
│   ├── opencode-cli/          # OpenCode CLI integration layer
│   ├── remote-cli/            # CLI + MCP policy gateway
│   ├── runner/                # Agent runner + trigger endpoint
│   └── slack-mcp/             # Slack MCP server + progress updates
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
- **No frameworks unless justified** — Express for HTTP, raw TypeScript for everything else. Every added dependency should have a reason in the plan.

## Context for New Sessions

When starting a new session on this repo:

1. Read `AGENTS.md` (this file) for workflow rules
2. Read the latest plan in `docs/plan/` for current work context
3. Read `docs/feat/mvp.md` for the overall architecture
4. Check `git log --oneline -10` for recent progress
5. Check for `TODO` / `FIXME` comments in `packages/` and `scripts/` for incomplete work
