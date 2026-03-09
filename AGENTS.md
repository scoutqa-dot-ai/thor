# AGENTS.md — Way of Work

Instructions for AI agents working on this repository.

## Workflow

1. **Plan before code** — Every feature or PoC starts with a plan document in `docs/plan/`. Format: `YYYYMMDDNN_<slug>.md`. The plan contains phases, decision log, exit criteria, and out-of-scope items.

2. **Phase-based implementation** — Work proceeds one phase at a time:
   - Implement the phase
   - Self-test against the exit criteria defined in the plan
   - Stop and wait for human review
   - Human approves -> create a focused git commit for that phase
   - Proceed to next phase

3. **Commit discipline**:
   - One commit per phase (not per file, not per feature)
   - Commit message format: `<type>: <short description>` (e.g. `feat: add mcp policy proxy`, `chore: project init`)
   - Never commit secrets, `.env` files, or `node_modules`
   - Never push unless explicitly asked

4. **Document decisions** — When making a non-obvious choice (library, pattern, architecture), add it to the plan's Decision Log table. Future sessions can read this to understand why things are the way they are.

## Repository Structure

```
thor/
├── AGENTS.md                  # This file
├── docs/
│   ├── feat/                  # Feature specs and architecture
│   └── plan/                  # Implementation plans
├── packages/
│   ├── proxy/                 # MCP policy proxy
│   └── runner/                # Agent runner + trigger endpoint
├── scripts/                   # Test and utility scripts
├── docker-compose.yml
├── package.json               # pnpm workspace root
└── tsconfig.base.json         # Shared TypeScript config
```

## Conventions

- **Language**: TypeScript (strict mode)
- **Package manager**: pnpm with workspaces
- **Runtime**: Node.js 22+
- **Formatting**: Default TypeScript/ESLint conventions. No custom config until needed.
- **No frameworks unless justified** — Express for HTTP, raw TypeScript for everything else. Every added dependency should have a reason in the plan.

## Context for New Sessions

When starting a new session on this repo:

1. Read `AGENTS.md` (this file) for workflow rules
2. Read the latest plan in `docs/plan/` for current work context
3. Read `docs/feat/mvp.md` for the overall architecture
4. Check `git log --oneline -10` for recent progress
5. Check for any TODO comments in code for incomplete work
