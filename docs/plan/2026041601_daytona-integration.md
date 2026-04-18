# Plan: 2026041601_daytona-integration.md

Provide cloud sandboxes to Thor's AI agent (OpenCode) for running Python/Java/etc. in isolated environments. Sandboxes run on Daytona's infrastructure, keeping the local server free for parallel agent sessions.

## Alternatives Analysis

> Added by /autoplan CEO review.

### The Actual Problem

Thor's AI agent runs in a Node.js container. It can't run Python tests, compile Java, or execute non-Node code. Server resources are limited, so sandboxes must run in the cloud.

### Options Evaluated

| Option                  | Verdict  | Why                                                                 |
| ----------------------- | -------- | ------------------------------------------------------------------- |
| **Daytona**             | SELECTED | Full CLI + SDK, self-hostable, built-in lifecycle, ~$0.05/hr        |
| E2B                     | Rejected | SDK-first (no CLI), self-hosting requires enterprise plan           |
| DinD / Sidecar / Direct | Rejected | Requires local server resources, can't scale with parallel sessions |

## Architecture

One agent-facing command: `sandbox <cmd> [args...]`. Run from a worktree. Remote-cli handles sandbox lifecycle (create, sync, cleanup) transparently. Operator flags (`--create`, `--stop`, `--list`) exist for troubleshooting but are not taught to the agent.

**Agent interface:**

```
sandbox pytest -v --tb=short           # auto-creates, syncs, runs, streams
sandbox pip install -r requirements.txt && pytest
sandbox make build                     # shell metacharacters work (sh -c)
```

No quoting, no subcommands, no IDs. The wrapper joins all args into a single command string and sends it to remote-cli. Node/TypeScript runs locally (the container already isolates it); sandbox is for non-Node languages.

**Operator interface (not in skill doc):**

```
sandbox --create                       # pre-warm a sandbox for this worktree
sandbox --stop                         # tear down sandbox for this worktree
sandbox --list                         # list session's sandboxes
```

**Lifecycle**: sandbox auto-creates on first run, auto-syncs on every run, auto-stops via Daytona idle timeout (15 min). No explicit cleanup by agent or operator required.

```
┌─ Agent (in /workspace/worktrees/myrepo/feat/auth) ───────────┐
│                                                               │
│  sandbox pytest -v --tb=short        → streamed test output   │
│  sandbox flake8 .                    → reuses same sandbox    │
│                                                               │
│  (all commands keyed by cwd; no id, no lifecycle to manage)   │
└───────────────────────────┬───────────────────────────────────┘
                            │ POST /exec/sandbox { args, cwd }
                            ▼
┌─ remote-cli (server-side, stateless) ─────────────────────────┐
│                                                                │
│  All operations via @daytona/sdk. No CLI binary.               │
│  Sandbox lookup via Daytona labels (no in-memory map).         │
│                                                                │
│  On every request:                                             │
│    1. daytona.list({thor-managed, thor-cwd}) → find sandbox    │
│       └─ auto-create if missing/gone:                          │
│          a. Parse cwd → repo name, branch, worktree path       │
│          b. Resolve remote URL from /workspace/repos/<repo>    │
│          c. SDK: daytona.create({ ephemeral, autoStop: 15 })   │
│             └─ labels: thor-managed, thor-cwd, thor-branch     │
│          d. Clone default branch, fetch+reset to SHA           │
│    2. Preflight: verify clean worktree, resolve HEAD SHA       │
│    3. ensureShaOnOrigin: scratch-push to thor-sandbox/<id>     │
│    4. Mint GitHub App token (REQUIRED, no PAT fallback)        │
│    5. Fetch ref + reset to SHA in sandbox (token in URL)       │
│    6. SDK: sandbox.commands.run(command)                        │
│    7. Stream stdout/stderr via NDJSON                          │
│                                                                │
│  --stop: daytona.list → sandbox.delete() (no-op if none)       │
│  --list: daytona.list({thor-managed}) for this session         │
│  --create: same as auto-create above, without running command  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              Daytona Cloud (isolated, no stored credentials)
```

**Key security properties:**

1. The sandbox never has persistent git credentials. Token is embedded in the fetch URL transiently (~1hr TTL GitHub App token). Running `env` inside the sandbox won't reveal them.
2. **Sandbox requires GitHub App auth. PAT is never used.** The blast radius of a leaked PAT (long-lived, broadly scoped) is unacceptable for a third-party cloud sandbox. Remote-cli calls `parseOrgFromRemoteUrl(remoteUrl)` → `getInstallationToken(org)` from `github-app-auth.ts`. If no installation is configured for the org, `sandbox create` fails fast with a clear error. GitHub App tokens are ~1 hr TTL, scoped to one installation, and show up in GitHub's audit log with the app identity.
3. Remote URL is resolved from `/workspace/repos/<repo>/.git/config` — this path is read-only to the agent, so it's effectively admin-owned. HTTPS is enforced at resolution time. Agent cannot redirect clones via `git config` in its worktree.
4. Private source code IS cloned to Daytona Cloud. This is an explicit trust boundary change. Acceptable because: Daytona sandboxes are ephemeral, auto-deleted, and the same code is already on GitHub. For self-hosted Daytona, code stays on your infra.

**Key DX properties:**

- **Zero cognitive load for agent**: one command (`sandbox <cmd>`), no lifecycle to manage, no IDs to track.
- **Node stays local**: the container already isolates Node. `npm test`, `vitest`, `tsc` run directly against the worktree with zero latency. Sandbox is only for non-Node languages where the container lacks runtimes.
- **No quoting**: `sandbox pytest -v --tb=short` — wrapper joins args into a single string, sandbox runs via `sh -c`. Shell metacharacters (`&&`, `|`, `;`) work naturally.
- **Auto-everything**: auto-create on first run, auto-sync committed code before each run, auto-stop after 15 min idle.

## Phases

### Phase 1: Environment Setup

- [ ] Add `@daytona/sdk` to `packages/remote-cli/package.json`. No CLI needed.
- [ ] Add env vars to `docker-compose.yml` (`remote-cli` service):
  - `DAYTONA_API_KEY=${DAYTONA_API_KEY:-}`
  - `DAYTONA_API_URL=${DAYTONA_API_URL:-https://app.daytona.io/api}`
- [ ] Add to `.env.example`:
  ```
  # -- DAYTONA -- cloud sandboxes for Python/Java/etc.
  # DAYTONA_API_KEY=daytona_XXXXXXXXXXXX
  # DAYTONA_API_URL=https://app.daytona.io/api
  ```

### Phase 2: Sandbox Module + Endpoint

- [ ] Create `docker/opencode/bin/sandbox` wrapper script.
  - Must be run from a worktree (`cwd` sent to remote-cli, like git/gh).
  - Default mode (no flags): join all args into a command string, send to remote-cli for exec.
    - `sandbox pytest -v --tb=short` → sends `{ "args": ["pytest", "-v", "--tb=short"], "cwd": "..." }`
    - Remote-cli joins args with spaces, runs via `sh -c` in the sandbox.
  - Operator flags (not taught to agent):
    - `sandbox --create` → pre-warm sandbox for this worktree
    - `sandbox --stop` → tear down sandbox for this worktree
    - `sandbox --list` → list session's sandboxes
  - Flags are detected by the wrapper before arg joining. If first arg starts with `--`, route to operator mode.
- [ ] Implement `POST /exec/sandbox` endpoint in `packages/remote-cli/src/index.ts`.
  - Body: `{ "args": [...], "cwd": "/workspace/worktrees/...", "mode": "exec"|"create"|"stop"|"list" }`
  - `sandbox` is repo-scoped (`cwd` is validated + required, like git/gh).
  - `exec` (default mode — the only mode the agent uses):
    1. `daytona.list({thor-managed, thor-cwd})` to find sandbox; auto-create from cwd if missing/gone:
       a. Parse `cwd` → repo name, worktree path
       b. `git rev-parse --abbrev-ref HEAD` in cwd → branch (for sandbox naming only)
       c. Resolve remote URL from `/workspace/repos/<repo>` (NOT from agent's `.git/config`)
       d. Resolve git credentials: GitHub App token via `github-app-auth.getInstallationToken(org)`. No PAT fallback.
       e. SDK: `daytona.create({ ephemeral: true, autoStopInterval: 15, name, labels: {thor-managed, thor-cwd, thor-branch} })`
       f. Clone default branch, fetch+reset to SHA
       g. On any failure: delete the sandbox, surface generic error (admin-only rich context in logs)
    2. Preflight: verify clean worktree (`git status --porcelain`), resolve HEAD SHA
    3. ensureShaOnOrigin: always push HEAD to `refs/heads/thor-sandbox/<sandboxId>`
    4. Mint token, embed in fetch URL, `git fetch <authed-url> refs/heads/thor-sandbox/<id> && git reset --hard <sha>` in sandbox
    5. Join args into command string, run via `sh -c` in sandbox
    6. Stream stdout/stderr via NDJSON
  - `create` (operator): same as auto-create above, without running a command. Returns sandbox ID.
  - `stop` (operator): `daytona.list({thor-managed, thor-cwd})` → `sandbox.delete()`. No-op if none.
  - `list` (operator): `daytona.list({thor-managed})` for this session.
  - NDJSON streaming for exec. Buffered JSON for operator modes.
- [ ] Implement `packages/remote-cli/src/sandbox.ts` module:
  - All operations use `@daytona/sdk`. No CLI binary needed.
  - **Stateless**: no in-memory maps. Sandbox lookup via Daytona labels (`thor-managed`, `thor-cwd`, `thor-branch`). Only `cwdLocks` (ephemeral mutex) kept in memory. Survives remote-cli restart.
  - Git credentials resolved via `resolveGitCredentials(remoteUrl)`:
    1. `parseOrgFromRemoteUrl(remoteUrl)` → org (from `github-app-auth.ts`)
    2. `getInstallationToken(org)` → short-lived GitHub App token
    3. Return `["x-access-token", token]`
    4. **No PAT fallback.** If org cannot be resolved, no installation is configured, or token minting fails, throw `SandboxUserError("Sandbox requires GitHub App auth for <org>. Configure github_app.installations in workspace config.")`
  - Remote URL resolution: `resolveRemoteUrl(repoName)` → `git remote get-url origin` in `/workspace/repos/<repo>`. Enforce HTTPS; reject non-HTTPS URLs.
  - `createSandbox(name, remoteUrl, sha, labels): Promise<string>` — create, scratch-push, clone default branch, fetch+reset SHA
  - `syncSandbox(id, remoteUrl, sha): Promise<void>` — scratch-push, fetch ref+reset SHA in sandbox
  - `execInSandbox(id, command, callbacks): Promise<number>` — `sandbox.commands.exec(command)` + log streaming for real-time output. Command is passed to `sh -c`.
  - `deleteSandbox(id): Promise<void>` — `sandbox.delete()`
  - `findSandboxForCwd(cwd): Promise<string | null>` — `daytona.list({thor-managed, thor-cwd=cwd})`
  - `listSandboxes(): Promise<SandboxInfo[]>` — `daytona.list({thor-managed})`
  - Snapshot: launch from `daytona-medium` by default; admin-overridable via `sandbox.snapshot` workspace config key.

### Phase 3: Agent Skill + Documentation

- [ ] Create `docker/opencode/config/skills/sandbox/SKILL.md`:
  - One rule: "Use `sandbox` to run non-Node code (Python, Java, Go, etc.) in a cloud sandbox. For Node/TypeScript, run commands directly."
  - Workflow example:
    ```
    cd /workspace/worktrees/myrepo/feat/auth
    sandbox pip install -r requirements.txt && pytest -v   # auto-creates, syncs, runs
    # fix test, commit...
    sandbox pytest -v              # auto-syncs code, reuses sandbox
    ```
  - Note: sandbox auto-creates on first run, auto-syncs committed code, auto-stops when idle
  - Note: sandbox has internet access for `pip install`, `npm install`, etc.
  - Note: worktree must be clean (committed) before running
  - Note: no quoting needed — just write the command naturally
  - Common errors and fixes
- [ ] Update README.md to list `sandbox` in available agent tools.
- [ ] Define base snapshot/image contract (which runtimes pre-installed).

### Phase 4: Tests

- [ ] Unit tests for sandbox orchestration in `packages/remote-cli/src/sandbox.test.ts`:
  - `create`: happy path (create + clone), repo not found, API unreachable, auth failure, GitHub App installation missing, token mint fails
  - `exec`: happy path (scratch-push + fetch+reset + exec + stream), worktree dirty, command fails (nonzero), auto-create on missing sandbox
  - `stop`: happy path, sandbox not found (no-op)
  - `list`: happy path, empty list
  - Unconfigured: `DAYTONA_API_KEY` empty → clear error on `create`
  - Branch names with special chars (slashes, dots) → sanitized sandbox name
  - Label-based lookup: finds sandbox by `thor-cwd` label, returns null when none match
- [ ] Integration test for `/exec/sandbox` endpoint:
  - Default mode (exec) returns NDJSON stream
  - `--create` returns sandbox ID
  - `--stop` returns success
  - `--list` returns filtered sandboxes
  - No args (empty command) returns 400
- [ ] Security test:
  - Token NOT visible via `sandbox env | grep -i token`

### Phase 5: Validation

- [ ] End-to-end: `sandbox pytest -v` → results streamed (auto-creates on first call)
- [ ] Verify credentials are NOT visible inside sandbox (`sandbox env | grep -i token`)
- [ ] Verify `sandbox --create` fails fast with a clear error when GitHub App installation is not configured for the org
- [ ] Verify auto-sync: edit in worktree, commit, `sandbox pytest -v` picks up changes
- [ ] Verify auto-stop: idle sandbox is cleaned up by Daytona after 15 min

### Follow-ups (post-launch)

- [ ] **P1 — Daily cleanup of `refs/heads/thor-sandbox/*`** on origin whose sandbox no longer exists in Daytona. Every live sandbox owns one scratch ref (overwritten in place), but deleted sandboxes leave stale refs. A scheduled job should: list live Daytona sandboxes with `thor-managed` label, list refs under `thor-sandbox/` on each repo's origin, and delete refs for non-live sandboxes. Belt-and-suspenders: also delete refs older than 7 days.
- [ ] **P2 — Strip credentials from sandbox `.git/config` after clone/pull.** Token is embedded in the fetch URL; if Daytona persists it in `.git/config`, a subsequent `cat .git/config` would reveal it. Post-clone cleanup step.
- [ ] **P2 — Token cache invalidation on 401/403.** Currently tokens are cached for ~1hr with 5-min early refresh. A revoked token would fail until cache expires.
- [ ] **P3 — Client disconnect → sandbox command cancellation.** If OpenCode kills the wrapper (SIGTERM), the HTTP request aborts but the sandbox command keeps running until Daytona auto-stop. Future: listen for `req.on("close")` and call SDK command cancel.

## Decision Log

> Historical record of all architectural decisions. Kept for context even when superseded.

| Date       | Choice                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-16 | Daytona over alternatives                                                       | Cloud needed for parallel sessions. Full CLI + SDK. Self-hostable.                                                                                                                                                                                                                                                                                                         |
| 2026-04-16 | High-level `sandbox` command                                                    | Agent shouldn't orchestrate create/clone/exec/delete. One command.                                                                                                                                                                                                                                                                                                         |
| 2026-04-16 | SDK for everything, no CLI                                                      | SDK covers create/clone/pull/exec/delete. No binary to install, no version to pin.                                                                                                                                                                                                                                                                                         |
| 2026-04-16 | No raw daytona CLI exposure                                                     | Prevents PAT leaks via `--env`, reduces attack surface, no policy allowlist needed.                                                                                                                                                                                                                                                                                        |
| 2026-04-16 | Skill named "sandbox" not "daytona"                                             | Daytona is implementation detail. Skill teaches the concept.                                                                                                                                                                                                                                                                                                               |
| 2026-04-16 | No cleanup hook needed                                                          | Rely on agent calling `sandbox stop` + Daytona auto-stop as safety net.                                                                                                                                                                                                                                                                                                    |
| 2026-04-16 | Kill worktree streamer                                                          | Agent commits before pushing. Git clone works. No need for HMAC/tar/ingress bypass.                                                                                                                                                                                                                                                                                        |
| 2026-04-16 | NDJSON streaming for exec                                                       | Test runs exceed 60s. Use execCommandStream pattern like scoutqa.                                                                                                                                                                                                                                                                                                          |
| 2026-04-16 | Worktree path as map key                                                        | Natural 1:1 with the code. Daytona auto-stop as cleanup safety net.                                                                                                                                                                                                                                                                                                        |
| 2026-04-17 | Sandbox REQUIRES GitHub App auth, no PAT fallback                               | PAT in a third-party cloud sandbox is too much blast radius (long-lived, broadly scoped). Fail fast when App installation is missing for the org. Uses `github-app-auth.getInstallationToken()`.                                                                                                                                                                           |
| 2026-04-17 | Repo remote from `/workspace/repos/<repo>` not config.json                      | `/workspace/repos` is read-only to OpenCode, so `.git/config` there is effectively admin-owned. Drops a redundant config field. HTTPS enforced at resolution time. Supersedes earlier plan to use `getRepoRemoteUrl()` from workspace config.                                                                                                                              |
| 2026-04-17 | Sandbox session scoping uses Daytona labels                                     | `sandbox list` filters by session without overloading the human-readable sandbox name.                                                                                                                                                                                                                                                                                     |
| 2026-04-17 | Drop in-memory map; Daytona labels are the source of truth                      | `thor-cwd` + `thor-branch` labels stored on create; `daytona.list({thor-managed, thor-cwd})` finds sandboxes. Remote-cli is stateless (only `cwdLocks` as ephemeral mutex). Survives restart. One extra `daytona.list` per request is the cost. Supersedes earlier in-memory `Map<sandboxId, ...>` + `Map<cwdPath, sandboxId>` design.                                     |
| 2026-04-17 | Base sandbox contract stays minimal until a pinned image exists                 | Current code only guarantees shell + git + network; runtime availability must be checked per task.                                                                                                                                                                                                                                                                         |
| 2026-04-17 | SHA-based identity for clone + sync; strict host preflight                      | Branch-name-based clone hides errors (PR-head fetches like `pr-2984` aren't on origin under that name) and is fragile to remote tip drift. Push by SHA, verify SHA on origin via single-SHA fetch, reset sandbox to exact host SHA. Worktree must be clean. Opencode owns push/fetch decisions.                                                                            |
| 2026-04-17 | Drop sandbox `<id>` arg from exec/stop; key by cwd                              | "CLI does as much as possible, opencode as little as possible." The agent no longer captures/echoes ids, never sees stale-id fallback. Label-based lookup is the single source of truth; auto-create, stop no-op, and list work without ids. Tradeoff: one sandbox per worktree at a time (fine).                                                                          |
| 2026-04-17 | Launch from `daytona-medium` snapshot; admin-overridable via `sandbox.snapshot` | Daytona requires a snapshot to start a sandbox. `daytona-medium` is the sane default for most tasks. Admins can point to a custom snapshot via the workspace config key.                                                                                                                                                                                                   |
| 2026-04-17 | Clone default branch then fetch+reset SHA, not clone-by-commitId                | `sandbox.git.clone(..., commitId=sha)` 400s when the SHA isn't reachable from the default branch (e.g. PR head refs at `refs/pull/N/head` or our `thor-sandbox/*` scratch refs). Clone the default branch to establish the remote, then run `git fetch origin <sha> && git reset --hard <sha>` via executeCommand.                                                         |
| 2026-04-17 | Always scratch-push; fetch by ref, not by SHA                                   | Sandbox-side `git fetch origin <sha>` returned exit 128 in practice (allowReachableSHA1InWant wire behavior is unreliable). Always push HEAD to `refs/heads/thor-sandbox/<id>`, always fetch that specific ref. One deterministic path, no SHA-fetch magic.                                                                                                                |
| 2026-04-17 | Embed GitHub App token in the sandbox fetch URL                                 | Daytona's `sandbox.git.pull`/`clone` pass creds transiently for that one call only — nothing persists into `.git/config`, so a plain `git fetch origin <ref>` via `executeCommand` prompts for credentials and fails. Put the short-lived GitHub App token into the fetch URL instead. Acceptable given ~1hr TTL. Also lets us drop the `sandbox.git.pull` call — simpler. |
| 2026-04-17 | Auth delivery via GIT_ASKPASS callback (host-side git ops)                      | Host-side git commands (scratch-push) use `GIT_ASKPASS` → `bin/git-askpass` → `auth-helper.ts` to mint tokens on demand. Token never lives in an env var. Sandbox-side uses embedded URL token instead (different trust boundary).                                                                                                                                         |
| 2026-04-17 | Block `git config` entirely in policy                                           | Earlier plan had a config-key allowlist. Now fully blocked — agent cannot rewrite remotes or credential helpers. Simpler, more secure.                                                                                                                                                                                                                                     |
| 2026-04-17 | Generic errors to agent, detailed logs for admins                               | Sandbox errors from Daytona SDK can leak internal details. Agent sees generic "Sandbox service error"; admins see full context in logs. No redactor needed.                                                                                                                                                                                                                |
| 2026-04-18 | Flatten CLI: `sandbox <cmd> [args...]`, no subcommands for agent                | Minimize agent cognitive load. No quoting (`sandbox pytest -v` not `sandbox exec "pytest -v"`). Wrapper joins args, sandbox runs via `sh -c`. One command to learn, zero lifecycle management.                                                                                                                                                                             |
| 2026-04-18 | Operator flags (`--create`, `--stop`, `--list`) instead of subcommands          | Agent never sees lifecycle commands. Operators can troubleshoot without teaching the agent. Flags detected by wrapper before arg joining.                                                                                                                                                                                                                                  |
| 2026-04-18 | Node/TypeScript stays local, sandbox for non-Node only                          | Container already isolates Node. Local execution gives zero-latency edit→test loop (no commit→push→sync cycle). Sandbox adds 5-10s per iteration — unacceptable for the 80% case. One simple rule: "use `sandbox` for non-Node code."                                                                                                                                      |
| 2026-04-18 | No session-end cleanup; rely on Daytona auto-stop                               | Agent may run long-running sandbox processes. Killing on session end would cut off streaming output. Daytona auto-stop (15 min idle) is sufficient. Cost of leaked sandbox: ~$0.01. Avoids complexity of session lifecycle hooks.                                                                                                                                          |

## Exit Criteria

- `sandbox <cmd> [args...]` runs non-Node commands in a cloud sandbox from any worktree.
- Agent only needs one command — no lifecycle management, no IDs, no quoting.
- Operator flags (`--create`, `--stop`, `--list`) available for troubleshooting.
- Sandbox auto-creates on first run, auto-syncs committed code, auto-stops after 15 min idle.
- Code cloned into sandbox without credentials being stored in sandbox env.
- Require GitHub App installation for the org; fail fast with clear error if missing. PAT is never used.
- Test output streamed back to agent via NDJSON.
- Git credentials NOT visible via `env` inside sandbox.
- Node/TypeScript continues to run locally (no sandbox needed).

## Out of Scope

- Custom Daytona targets or profile management.
- Cost monitoring / usage tracking (deferred to TODOS.md).
- Sandbox result artifact management (files back from sandbox to agent).
- Raw `daytona` CLI access for agent (security risk, not needed).

## Error & Rescue Registry

| Codepath          | What Can Go Wrong                 | Rescued? | Rescue Action                                 | User Sees                                                                                             |
| ----------------- | --------------------------------- | -------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| auto-create       | Not in a worktree                 | Y        | 400                                           | "Must run from /workspace/worktrees/"                                                                 |
| auto-create       | Daytona API unreachable           | Y        | 500                                           | "Sandbox service unavailable"                                                                         |
| auto-create       | Daytona auth failure              | Y        | 500                                           | "Sandbox auth failed, check DAYTONA_API_KEY"                                                          |
| auto-create       | GitHub App installation missing   | Y        | 400                                           | "Sandbox requires GitHub App auth for <org>. Configure github_app.installations in workspace config." |
| auto-create       | GitHub App token mint fails       | Y        | 500                                           | "Failed to mint GitHub App token for <org>"                                                           |
| auto-create       | Clone fails (bad repo/branch)     | Y        | Delete sandbox, 400                           | "Failed to clone <repo>@<branch>"                                                                     |
| auto-create       | Create timeout                    | Y        | 500                                           | "Sandbox creation timed out"                                                                          |
| `sandbox <cmd>`   | No sandbox yet / gone on Daytona  | Y        | Auto-create from cwd (silent)                 | Stream command output normally                                                                        |
| `sandbox <cmd>`   | Worktree dirty (host preflight)   | Y        | 400                                           | "Worktree not clean. Commit your changes first (add generated files to .gitignore)."                  |
| `sandbox <cmd>`   | Scratch-push fails                | Y        | 500                                           | "Failed to sync code to origin"                                                                       |
| `sandbox <cmd>`   | GitHub App token mint fails       | Y        | 500                                           | "Failed to mint GitHub App token for <org>"                                                           |
| `sandbox <cmd>`   | Fetch+reset fails (sandbox)       | Y        | 500                                           | "Failed to sync code to sandbox"                                                                      |
| `sandbox <cmd>`   | Command fails (nonzero)           | Y        | Stream stderr                                 | Test failure output (normal)                                                                          |
| `sandbox <cmd>`   | Long-running command              | N/A      | No timeout imposed — OpenCode manages its own | Stream until done                                                                                     |
| `sandbox --stop`  | No sandbox tracked for cwd        | Y        | Silent no-op (idempotent)                     | Exit 0                                                                                                |
| `sandbox --stop`  | Delete fails                      | Y        | Log + ignore                                  | Exit 0                                                                                                |
| Daytona auto-stop | Sandbox leaked (no explicit stop) | Y        | Auto-delete after 15 min idle                 | Silent                                                                                                |

## Decision Audit Trail

> Historical record from /autoplan reviews. Kept for traceability.

| #   | Phase  | Decision                                                 | Classification | Principle | Rationale                                      | Rejected                        |
| --- | ------ | -------------------------------------------------------- | -------------- | --------- | ---------------------------------------------- | ------------------------------- |
| 1   | CEO    | Daytona over alternatives                                | User Decision  | —         | Cloud needed, CLI+SDK fits                     | E2B, DinD, Sidecar, Direct      |
| 2   | CEO    | Skill named "sandbox"                                    | User Feedback  | P5        | Daytona is implementation detail               | "daytona" skill                 |
| 3   | Eng    | High-level sandbox command only                          | User Decision  | P5        | One command, no orchestration by agent         | Raw daytona CLI                 |
| 4   | Eng    | SDK for git clone (PAT transient)                        | User Decision  | P1        | PAT never stored in sandbox env                | PAT as --env, worktree streamer |
| 5   | Eng    | Kill worktree streamer (Phase 3/4)                       | User Decision  | P3        | Git clone works, code is committed             | HMAC/tar/ingress                |
| 6   | Eng    | NDJSON streaming for exec                                | Mechanical     | P1        | Runs exceed 60s buffered timeout               | Buffered exec                   |
| 7   | Eng    | Session cleanup via onSessionEnd()                       | Mechanical     | P1        | Existing hook, reliable cleanup point          | Manual cleanup                  |
| 8   | DX     | Sandbox skill with examples                              | Mechanical     | P2        | Agent needs to know when/how to use            | No skill file                   |
| 9   | DX     | Pin @daytona/sdk version                                 | Mechanical     | P5        | Reproducible builds                            | Latest                          |
| 10  | DX     | Define base snapshot contract                            | Taste          | P1        | Agent needs runtimes pre-installed             | Defer                           |
| 11  | Eng-v2 | ID-based lookup, not cwd-based for exec                  | Mechanical     | P5        | Both: exec takes ID but plan looked up by cwd  | cwd lookup                      |
| 12  | Eng-v2 | Remote URL from admin config, not .git/config            | Mechanical     | P1        | Codex: agent can rewrite remote via git config | Trust .git/config               |
| 13  | Eng-v2 | Explicit trust boundary: code goes to Daytona Cloud      | Mechanical     | P5        | Codex: current model keeps code local          | Implicit                        |
| 14  | Eng-v2 | git reset --hard on dirty sandbox pull                   | Mechanical     | P1        | Codex: reused sandbox has untracked files      | Fail on dirty                   |
| 15  | Eng-v2 | git push -u origin HEAD for first push                   | Mechanical     | P1        | Codex: no upstream on new branches             | Assume upstream                 |
| 16  | Eng-v2 | Recovery path on map miss (daytona.get)                  | Mechanical     | P1        | Both: restart loses map                        | No recovery                     |
| 17  | Eng-v2 | Add tests for unconfigured API key, special branch chars | Mechanical     | P2        | Claude: missing test cases                     | Skip                            |
| 18  | CEO-v2 | SDK spike before full implementation                     | Taste          | P6        | Claude: SDK behavior is biggest risk           | Skip spike                      |
| 19  | CEO-v2 | Exec timeout: 5 min may be too short                     | Taste          | P3        | Claude flagged, but configurable later         | Longer default                  |
| 20  | DX-v3  | Flatten CLI to `sandbox <cmd> [args...]`                 | User Decision  | P5        | Zero cognitive load; no quoting needed         | Subcommand-based CLI            |
| 21  | DX-v3  | Operator flags (`--create/--stop/--list`)                | User Decision  | P5        | Keep lifecycle out of agent's view             | Teach all commands to agent     |
| 22  | Eng-v3 | Node stays local, sandbox for non-Node only              | User Decision  | P1        | Container isolates Node; 5-10s sync tax bad    | Everything through sandbox      |
| 23  | Eng-v3 | No session-end cleanup; Daytona auto-stop only           | User Decision  | P3        | Long-running processes; ~$0.01 leak cost       | Session-end hook                |

## GSTACK REVIEW REPORT

| Review     | Trigger              | Why                  | Runs | Status                | Findings                                                         |
| ---------- | -------------------- | -------------------- | ---- | --------------------- | ---------------------------------------------------------------- |
| CEO Review | `/plan-ceo-review`   | Scope & strategy     | 2    | CLEAR (via /autoplan) | No demand data (accepted risk), git sync latency noted           |
| Eng Review | `/plan-eng-review`   | Architecture & tests | 2    | CLEAR (via /autoplan) | Fixed: identity model, trust boundary, dirty sandbox, first push |
| DX Review  | `/plan-devex-review` | Developer experience | 2    | CLEAR (via /autoplan) | 4-command API, zero-arg create, auto-sync                        |

**VERDICT:** CLEARED. 2 taste decisions surfaced (SDK spike, exec timeout). All critical/high findings addressed.
