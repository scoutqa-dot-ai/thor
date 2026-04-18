# Plan: 2026041601_daytona-integration.md

Provide cloud sandboxes to Thor's AI agent (OpenCode) for running Python/Java/etc. in isolated environments. Sandboxes run on Daytona's infrastructure, keeping the local server free for parallel agent sessions.

## Alternatives Analysis

> Added by /autoplan CEO review.

### The Actual Problem

Thor's AI agent runs in a Node.js container. Most managed repos are Java — the agent can't compile, test, or lint them locally. Server resources are limited, so sandboxes must run in the cloud. Sandbox is the agent's primary execution path for project commands.

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
sandbox mvn test -pl module-auth       # Java (most common case)
sandbox ./gradlew build
sandbox pytest -v --tb=short
sandbox make build                     # shell metacharacters work (sh -c)
```

No quoting, no subcommands, no IDs. The wrapper joins all args into a single command string and sends it to remote-cli. This is the agent's primary execution path — most repos are Java. Local Node is still available for lightweight tasks (formatting, linting, scripts) but the skill doc doesn't carve out exceptions.

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
│          b. SDK: daytona.create({ ephemeral, autoStop: 15 })   │
│             └─ labels: thor-managed, thor-cwd, thor-branch     │
│          c. git bundle create (full) on host                   │
│          d. SDK: sandbox.fs.uploadFile(bundle)                 │
│          e. sandbox: git init + bundle unbundle + reset SHA    │
│    2. Preflight: verify clean worktree, resolve HEAD SHA       │
│    3. Sync via bundle upload (skip if SHA unchanged):          │
│       a. Try delta: git bundle create (last-sha..HEAD)        │
│       b. On failure: fallback to full bundle (HEAD)           │
│       c. SDK: sandbox.fs.uploadFile(bundle)                   │
│       d. sandbox: git bundle unbundle + reset --hard SHA      │
│    4. SDK: sandbox.commands.run(command)                        │
│    5. Stream stdout/stderr via NDJSON                          │
│                                                                │
│  --stop: daytona.list → sandbox.delete() (no-op if none)       │
│  --list: daytona.list({thor-managed}) for this session         │
│  --create: same as auto-create above, without running command  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              Daytona Cloud (isolated, no git credentials, no origin access)
```

**Key security properties:**

1. **Sandbox has zero git credentials.** Code arrives via git bundle uploaded through the Daytona SDK — the sandbox never contacts origin, never has tokens, never has remote URLs. Running `env`, `cat .git/config`, or inspecting the filesystem reveals nothing.
2. **No writes to origin for sync.** Previous design pushed scratch refs (`refs/heads/thor-sandbox/*`) on every sync. Bundle upload eliminates all writes to the remote repo. No stale refs, no cleanup job.
3. **Sandbox sync needs no credentials at all.** Host creates bundle from the local worktree → SDK uploads → sandbox unbundles. No git remotes, no tokens, no origin access at any point. (GitHub App auth is still used by the host for the agent's own `git push` via the worktree workflow, but that's independent of sandbox.)
4. Private source code IS uploaded to Daytona Cloud via the SDK. This is an explicit trust boundary change. Acceptable because: Daytona sandboxes are ephemeral, auto-deleted, and the same code is already on GitHub. For self-hosted Daytona, code stays on your infra.

**Key DX properties:**

- **Zero cognitive load for agent**: one command (`sandbox <cmd>`), no lifecycle to manage, no IDs to track.
- **Sandbox is the primary path**: most repos are Java. The agent uses `sandbox` for builds, tests, lints — the majority of its work. Local Node still available for lightweight tasks but not called out as an exception.
- **No quoting**: `sandbox mvn test` — wrapper joins args into a single string, sandbox runs via `sh -c`. Shell metacharacters (`&&`, `|`, `;`) work naturally.
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
       c. SDK: `daytona.create({ ephemeral: true, autoStopInterval: 15, name, labels: {thor-managed, thor-cwd, thor-branch, thor-sha: <HEAD>} })`
       d. `git bundle create /tmp/<id>.bundle HEAD` on host (full bundle — no credentials needed)
       e. SDK: `sandbox.fs.uploadFile('/tmp/<id>.bundle', '/tmp/sync.bundle')`
       f. SDK: `sandbox.commands.exec('git init /workspace/repo && cd /workspace/repo && git bundle unbundle /tmp/sync.bundle && git reset --hard <sha> && rm /tmp/sync.bundle')`
       g. On any failure: delete the sandbox, surface generic error (admin-only rich context in logs)
    2. Preflight: verify clean worktree (`git status --porcelain`), resolve HEAD SHA
    3. Sync via bundle upload (skip if SHA unchanged from `thor-sha` label):
       a. Try delta: `git bundle create /tmp/<id>.bundle <last-sha>..HEAD` on host
       b. On failure (backward reset, unrelated branch): fallback to full `HEAD` bundle
       c. SDK: `sandbox.fs.uploadFile('/tmp/<id>.bundle', '/tmp/sync.bundle')`
       d. SDK: `sandbox.commands.exec('cd /workspace/repo && git bundle unbundle /tmp/sync.bundle && git reset --hard <sha> && rm /tmp/sync.bundle')`
       e. Update `thor-sha` label to current HEAD
    4. Join args into command string, run via `sh -c` in sandbox
    5. Stream stdout/stderr via NDJSON
  - `create` (operator): same as auto-create above, without running a command. Returns sandbox ID.
  - `stop` (operator): `daytona.list({thor-managed, thor-cwd})` → `sandbox.delete()`. No-op if none.
  - `list` (operator): `daytona.list({thor-managed})` for this session.
  - NDJSON streaming for exec. Buffered JSON for operator modes.
- [ ] Implement `packages/remote-cli/src/sandbox.ts` module:
  - All operations use `@daytona/sdk`. No CLI binary needed.
  - **Stateless**: no in-memory maps. Sandbox lookup via Daytona labels (`thor-managed`, `thor-cwd`, `thor-branch`, `thor-sha`). Only `cwdLocks` (ephemeral mutex) kept in memory. Survives remote-cli restart.
  - **No git credentials in sandbox.** Code sync uses git bundle upload via `sandbox.fs.uploadFile()`. Sandbox never contacts origin.
  - `createSandbox(name, cwd, sha, labels): Promise<string>` — create sandbox, bundle full repo, upload, unbundle+reset
  - `syncSandbox(id, cwd, lastSha, sha): Promise<void>` — try delta bundle (`lastSha..HEAD`), fall back to full bundle on failure (handles backward reset, unrelated branch). Skip if SHA unchanged.
  - `bundleAndUpload(sandbox, cwd, range, sha): Promise<void>` — shared helper:
    1. `git bundle create /tmp/<id>.bundle <range>` on host
    2. `sandbox.fs.uploadFile('/tmp/<id>.bundle', '/tmp/sync.bundle')` — streaming, supports large repos
    3. `sandbox.commands.exec('cd /workspace/repo && git bundle unbundle /tmp/sync.bundle && git reset --hard <sha> && rm /tmp/sync.bundle')`
    4. Clean up local temp file
  - `execInSandbox(id, command, callbacks): Promise<number>` — `sandbox.commands.exec(command)` + log streaming for real-time output. Command is passed to `sh -c`.
  - `deleteSandbox(id): Promise<void>` — `sandbox.delete()`
  - `findSandboxForCwd(cwd): Promise<string | null>` — `daytona.list({thor-managed, thor-cwd=cwd})`
  - `listSandboxes(): Promise<SandboxInfo[]>` — `daytona.list({thor-managed})`
  - `getLastSyncedSha(sandbox): string | null` — read `thor-sha` label from sandbox metadata
  - Snapshot: launch from `daytona-medium` by default; admin-overridable via `sandbox.snapshot` workspace config key.

### Phase 3: Agent Skill + Documentation

- [ ] Create `docker/opencode/config/skills/sandbox/SKILL.md`:
  - One rule: "Use `sandbox` to run project commands (build, test, lint)."
  - No language exceptions — skill doc doesn't mention Node/local.
  - Workflow example:
    ```
    cd /workspace/worktrees/myrepo/feat/auth
    sandbox mvn test -pl module-auth       # auto-creates, syncs, runs
    # fix test, commit...
    sandbox mvn test -pl module-auth       # auto-syncs code, reuses sandbox
    sandbox ./gradlew spotlessCheck        # lint
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
  - `create`: happy path (create + bundle upload + unbundle), API unreachable, auth failure, bundle create fails, upload fails, unbundle fails
  - `exec`: happy path (delta bundle + upload + unbundle + exec + stream), worktree dirty, command fails (nonzero), auto-create on missing sandbox, SHA unchanged (skip sync)
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
  - No tokens visible via `sandbox env | grep -i token`
  - No remote URLs in sandbox `.git/config` (bundle-based init, no origin configured)
  - `sandbox git remote -v` returns empty (no remotes)

### Phase 5: Validation

- [ ] End-to-end: `sandbox pytest -v` → results streamed (auto-creates on first call)
- [ ] Verify no credentials or remotes inside sandbox (`sandbox env | grep -i token`, `sandbox git remote -v`)
- [ ] Verify `sandbox --create` fails fast with a clear error when `DAYTONA_API_KEY` is not configured
- [ ] Verify auto-sync: edit in worktree, commit, `sandbox pytest -v` picks up changes
- [ ] Verify auto-stop: idle sandbox is cleaned up by Daytona after 15 min

### Follow-ups (post-launch)

- [x] **P1 — Shell-quote args before joining.** `args.join(" ")` was lossy: `["mvn", "test", "hello world"]` became `mvn test hello world` (2 files, not 1). Fix: `args.map(a => shellQuote(a)).join(" ")` so it becomes `'mvn' 'test' 'hello world'`. Preserves arg boundaries while keeping `sh -lc` wrapper for login-shell environment (PATH, JAVA_HOME). Daytona's `executeCommand` runs a non-login shell (`GetShell()` returns bash/zsh without `-l`), so `sh -lc` is required to source profiles.
- [ ] **P2 — Token cache invalidation on 401/403.** Currently tokens are cached for ~1hr with 5-min early refresh. A revoked token would fail until cache expires. (Host-side only — sandbox has no tokens.)
- [ ] **P3 — Client disconnect → sandbox command cancellation.** If OpenCode kills the wrapper (SIGTERM), the HTTP request aborts but the sandbox command keeps running until Daytona auto-stop. Future: listen for `req.on("close")` and call SDK command cancel.
- [ ] **P3 — Bundle size limits.** Git bundles for very large repos could be slow to create/upload. Monitor bundle sizes in production. If needed, implement shallow bundles (`--depth`) or file-level sync via `sandbox.fs.uploadFile()` for individual changed files.

## Decision Log

> Historical record of all architectural decisions. Kept for context even when superseded.

| Date       | Choice                                                                          | Rationale                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-16 | Daytona over alternatives                                                       | Cloud needed for parallel sessions. Full CLI + SDK. Self-hostable.                                                                                                                                                                                                                                                                     |
| 2026-04-16 | High-level `sandbox` command                                                    | Agent shouldn't orchestrate create/clone/exec/delete. One command.                                                                                                                                                                                                                                                                     |
| 2026-04-16 | SDK for everything, no CLI                                                      | SDK covers create/clone/pull/exec/delete. No binary to install, no version to pin.                                                                                                                                                                                                                                                     |
| 2026-04-16 | No raw daytona CLI exposure                                                     | Prevents PAT leaks via `--env`, reduces attack surface, no policy allowlist needed.                                                                                                                                                                                                                                                    |
| 2026-04-16 | Skill named "sandbox" not "daytona"                                             | Daytona is implementation detail. Skill teaches the concept.                                                                                                                                                                                                                                                                           |
| 2026-04-16 | No cleanup hook needed                                                          | Rely on agent calling `sandbox stop` + Daytona auto-stop as safety net.                                                                                                                                                                                                                                                                |
| 2026-04-16 | Kill worktree streamer                                                          | Agent commits before pushing. Git clone works. No need for HMAC/tar/ingress bypass.                                                                                                                                                                                                                                                    |
| 2026-04-16 | NDJSON streaming for exec                                                       | Test runs exceed 60s. Use execCommandStream pattern like scoutqa.                                                                                                                                                                                                                                                                      |
| 2026-04-16 | Worktree path as map key                                                        | Natural 1:1 with the code. Daytona auto-stop as cleanup safety net.                                                                                                                                                                                                                                                                    |
| 2026-04-17 | Repo remote from `/workspace/repos/<repo>` not config.json                      | `/workspace/repos` is read-only to OpenCode, so `.git/config` there is effectively admin-owned. HTTPS enforced at resolution time. Used for host-side git push (not sandbox sync).                                                                                                                                                     |
| 2026-04-17 | Sandbox session scoping uses Daytona labels                                     | `sandbox list` filters by session without overloading the human-readable sandbox name.                                                                                                                                                                                                                                                 |
| 2026-04-17 | Drop in-memory map; Daytona labels are the source of truth                      | `thor-cwd` + `thor-branch` labels stored on create; `daytona.list({thor-managed, thor-cwd})` finds sandboxes. Remote-cli is stateless (only `cwdLocks` as ephemeral mutex). Survives restart. One extra `daytona.list` per request is the cost. Supersedes earlier in-memory `Map<sandboxId, ...>` + `Map<cwdPath, sandboxId>` design. |
| 2026-04-17 | Base sandbox contract stays minimal until a pinned image exists                 | Current code only guarantees shell + git + network; runtime availability must be checked per task.                                                                                                                                                                                                                                     |
| 2026-04-17 | Drop sandbox `<id>` arg from exec/stop; key by cwd                              | "CLI does as much as possible, opencode as little as possible." The agent no longer captures/echoes ids, never sees stale-id fallback. Label-based lookup is the single source of truth; auto-create, stop no-op, and list work without ids. Tradeoff: one sandbox per worktree at a time (fine).                                      |
| 2026-04-17 | Launch from `daytona-medium` snapshot; admin-overridable via `sandbox.snapshot` | Daytona requires a snapshot to start a sandbox. `daytona-medium` is the sane default for most tasks. Admins can point to a custom snapshot via the workspace config key.                                                                                                                                                               |
| 2026-04-17 | Auth delivery via GIT_ASKPASS callback (host-side git ops)                      | Host-side git commands (agent's `git push`) use `GIT_ASKPASS` → `bin/git-askpass` → `auth-helper.ts` to mint tokens on demand. Independent of sandbox sync.                                                                                                                                                                            |
| 2026-04-17 | Block `git config` entirely in policy                                           | Earlier plan had a config-key allowlist. Now fully blocked — agent cannot rewrite remotes or credential helpers. Simpler, more secure.                                                                                                                                                                                                 |
| 2026-04-17 | Generic errors to agent, detailed logs for admins                               | Sandbox errors from Daytona SDK can leak internal details. Agent sees generic "Sandbox service error"; admins see full context in logs. No redactor needed.                                                                                                                                                                            |
| 2026-04-18 | Flatten CLI: `sandbox <cmd> [args...]`, no subcommands for agent                | Minimize agent cognitive load. No quoting (`sandbox pytest -v` not `sandbox exec "pytest -v"`). Wrapper joins args, sandbox runs via `sh -c`. One command to learn, zero lifecycle management.                                                                                                                                         |
| 2026-04-18 | Operator flags (`--create`, `--stop`, `--list`) instead of subcommands          | Agent never sees lifecycle commands. Operators can troubleshoot without teaching the agent. Flags detected by wrapper before arg joining.                                                                                                                                                                                              |
| 2026-04-18 | Sandbox is primary execution path; local Node for lightweight tasks             | Most repos are Java — sandbox is the 80% case. Local Node still available for lightweight tasks (formatting, scripts) but skill doc teaches only `sandbox`. No language exceptions to learn.                                                                                                                                           |
| 2026-04-18 | No session-end cleanup; rely on Daytona auto-stop                               | Agent may run long-running sandbox processes. Killing on session end would cut off streaming output. Daytona auto-stop (15 min idle) is sufficient. Cost of leaked sandbox: ~$0.01. Avoids complexity of session lifecycle hooks.                                                                                                      |
| 2026-04-18 | Git bundle upload for sync, not scratch-push to origin                          | Daytona SDK has `sandbox.fs.uploadFile()` with streaming support. Bundle created on host, uploaded via SDK, unbundled in sandbox. Zero writes to origin, zero credentials in sandbox, no stale ref cleanup needed. Supersedes scratch-push + embedded-token-in-URL approach.                                                           |
| 2026-04-18 | Delta bundles with full-bundle fallback for subsequent syncs                    | Try delta bundle (`last-sha..HEAD`) first; on failure (backward reset, unrelated branch, empty bundle) fall back to full bundle (`HEAD`). `thor-sha` label on sandbox tracks last-synced SHA. Skip sync entirely if SHA unchanged. Supersedes pure-delta approach which broke on backward resets (git refuses empty bundles).          |
| 2026-04-18 | Sandbox has no git remotes                                                      | Bundle unbundle + reset creates a local repo with no origin configured. Sandbox cannot fetch/push anywhere. Eliminates credential stripping follow-up (P2) and the entire token-in-URL pattern. Strongest possible isolation.                                                                                                          |

## Exit Criteria

- `sandbox <cmd> [args...]` runs project commands in a cloud sandbox from any worktree.
- Agent only needs one command — no lifecycle management, no IDs, no quoting.
- Operator flags (`--create`, `--stop`, `--list`) available for troubleshooting.
- Sandbox auto-creates on first run, auto-syncs committed code, auto-stops after 15 min idle.
- Code synced to sandbox via git bundle upload — no credentials in sandbox, no writes to origin.
- Test output streamed back to agent via NDJSON.
- Sandbox has no git remotes, no tokens, no credentials of any kind.
- Sandbox is the primary execution path. Local Node available for lightweight tasks but not called out in skill doc.

## Out of Scope

- Custom Daytona targets or profile management.
- Cost monitoring / usage tracking (deferred to TODOS.md).
- Sandbox result artifact management (files back from sandbox to agent).
- Raw `daytona` CLI access for agent (security risk, not needed).

## Error & Rescue Registry

| Codepath          | What Can Go Wrong                 | Rescued? | Rescue Action                                  | User Sees                                                                            |
| ----------------- | --------------------------------- | -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| auto-create       | Not in a worktree                 | Y        | 400                                            | "Must run from /workspace/worktrees/"                                                |
| auto-create       | Daytona API unreachable           | Y        | 500                                            | "Sandbox service unavailable"                                                        |
| auto-create       | Daytona auth failure              | Y        | 500                                            | "Sandbox auth failed, check DAYTONA_API_KEY"                                         |
| auto-create       | Bundle create fails               | Y        | Delete sandbox, 500                            | "Failed to prepare code for sandbox"                                                 |
| auto-create       | Bundle upload fails               | Y        | Delete sandbox, 500                            | "Failed to upload code to sandbox"                                                   |
| auto-create       | Unbundle+reset fails              | Y        | Delete sandbox, 500                            | "Failed to initialize code in sandbox"                                               |
| auto-create       | Create timeout                    | Y        | 500                                            | "Sandbox creation timed out"                                                         |
| `sandbox <cmd>`   | No sandbox yet / gone on Daytona  | Y        | Auto-create from cwd (silent)                  | Stream command output normally                                                       |
| `sandbox <cmd>`   | Worktree dirty (host preflight)   | Y        | 400                                            | "Worktree not clean. Commit your changes first (add generated files to .gitignore)." |
| `sandbox <cmd>`   | Bundle create fails (delta)       | Y        | Fallback to full bundle; 500 only if both fail | "Failed to prepare code sync"                                                        |
| `sandbox <cmd>`   | Bundle upload fails               | Y        | 500                                            | "Failed to upload code to sandbox"                                                   |
| `sandbox <cmd>`   | Unbundle+reset fails (sandbox)    | Y        | 500                                            | "Failed to sync code to sandbox"                                                     |
| `sandbox <cmd>`   | Command fails (nonzero)           | Y        | Stream stderr                                  | Test failure output (normal)                                                         |
| `sandbox <cmd>`   | Long-running command              | N/A      | No timeout imposed — OpenCode manages its own  | Stream until done                                                                    |
| `sandbox --stop`  | No sandbox tracked for cwd        | Y        | Silent no-op (idempotent)                      | Exit 0                                                                               |
| `sandbox --stop`  | Delete fails                      | Y        | Log + ignore                                   | Exit 0                                                                               |
| Daytona auto-stop | Sandbox leaked (no explicit stop) | Y        | Auto-delete after 15 min idle                  | Silent                                                                               |

## Decision Audit Trail

> Historical record from /autoplan reviews. Kept for traceability.

| #   | Phase  | Decision                                                 | Classification | Principle | Rationale                                                    | Rejected                            |
| --- | ------ | -------------------------------------------------------- | -------------- | --------- | ------------------------------------------------------------ | ----------------------------------- |
| 1   | CEO    | Daytona over alternatives                                | User Decision  | —         | Cloud needed, CLI+SDK fits                                   | E2B, DinD, Sidecar, Direct          |
| 2   | CEO    | Skill named "sandbox"                                    | User Feedback  | P5        | Daytona is implementation detail                             | "daytona" skill                     |
| 3   | Eng    | High-level sandbox command only                          | User Decision  | P5        | One command, no orchestration by agent                       | Raw daytona CLI                     |
| 5   | Eng    | Kill worktree streamer (Phase 3/4)                       | User Decision  | P3        | Git clone works, code is committed                           | HMAC/tar/ingress                    |
| 6   | Eng    | NDJSON streaming for exec                                | Mechanical     | P1        | Runs exceed 60s buffered timeout                             | Buffered exec                       |
| 7   | Eng    | Session cleanup via onSessionEnd()                       | Mechanical     | P1        | Existing hook, reliable cleanup point                        | Manual cleanup                      |
| 8   | DX     | Sandbox skill with examples                              | Mechanical     | P2        | Agent needs to know when/how to use                          | No skill file                       |
| 9   | DX     | Pin @daytona/sdk version                                 | Mechanical     | P5        | Reproducible builds                                          | Latest                              |
| 10  | DX     | Define base snapshot contract                            | Taste          | P1        | Agent needs runtimes pre-installed                           | Defer                               |
| 13  | Eng-v2 | Explicit trust boundary: code goes to Daytona Cloud      | Mechanical     | P5        | Codex: current model keeps code local                        | Implicit                            |
| 17  | Eng-v2 | Add tests for unconfigured API key, special branch chars | Mechanical     | P2        | Claude: missing test cases                                   | Skip                                |
| 18  | CEO-v2 | SDK spike before full implementation                     | Taste          | P6        | Claude: SDK behavior is biggest risk                         | Skip spike                          |
| 19  | CEO-v2 | Exec timeout: 5 min may be too short                     | Taste          | P3        | Claude flagged, but configurable later                       | Longer default                      |
| 20  | DX-v3  | Flatten CLI to `sandbox <cmd> [args...]`                 | User Decision  | P5        | Zero cognitive load; no quoting needed                       | Subcommand-based CLI                |
| 21  | DX-v3  | Operator flags (`--create/--stop/--list`)                | User Decision  | P5        | Keep lifecycle out of agent's view                           | Teach all commands to agent         |
| 22  | Eng-v3 | Sandbox primary; local Node for lightweight only         | User Decision  | P1        | Most repos Java; no language exceptions taught               | Everything through sandbox          |
| 23  | Eng-v3 | No session-end cleanup; Daytona auto-stop only           | User Decision  | P3        | Long-running processes; ~$0.01 leak cost                     | Session-end hook                    |
| 24  | Eng-v3 | Git bundle upload via SDK, not scratch-push to origin    | User Decision  | P1        | Zero origin writes; zero sandbox credentials                 | Scratch-push + token-in-URL         |
| 25  | Eng-v3 | Delta bundles + thor-sha label for incremental sync      | Mechanical     | P1        | Small uploads for edit-test cycles                           | Full bundle every time              |
| 26  | Eng-v3 | Sandbox has no git remotes (bundle-only init)            | Mechanical     | P1        | Strongest isolation; no credential surface                   | Clone from origin                   |
| 27  | Eng-v4 | `sudo mkdir` for /workspace in Daytona sandbox           | Bug fix        | P1        | Default sandbox user cannot create dirs at /                 | Use home dir (breaks path symmetry) |
| 28  | Eng-v4 | Sandbox wrapper reads THOR_REMOTE_CLI_URL env var        | Bug fix        | P1        | Hardcoded localhost:3004 fails in container                  | —                                   |
| 29  | Eng-v4 | Sandbox wrapper COPY'd into Dockerfile                   | Bug fix        | P1        | Missing from image, agent got "command not found"            | —                                   |
| 30  | Eng-v4 | Delta bundle uses `OLD..HEAD` not `OLD..SHA`             | Bug fix        | P1        | Bare SHAs produce empty bundles in git                       | —                                   |
| 31  | Eng-v4 | Delta-with-fallback replaces three sync strategies       | Simplification | P3        | One try/catch vs merge-base + reset + delta                  | Three separate code paths           |
| 32  | Eng-v4 | Route sandbox output to stdout regardless of exit code   | Bug fix        | P1        | Daytona merges streams; exit-based routing loses test output | —                                   |
| 33  | Eng-v4 | git-askpass clears TOKEN on node crash                   | Bug fix        | P5        | Partial stdout from crashed node becomes garbage password    | —                                   |

## GSTACK REVIEW REPORT

| Review     | Trigger              | Why                  | Runs | Status                | Findings                                                         |
| ---------- | -------------------- | -------------------- | ---- | --------------------- | ---------------------------------------------------------------- |
| CEO Review | `/plan-ceo-review`   | Scope & strategy     | 2    | CLEAR (via /autoplan) | No demand data (accepted risk), git sync latency noted           |
| Eng Review | `/plan-eng-review`   | Architecture & tests | 2    | CLEAR (via /autoplan) | Fixed: identity model, trust boundary, dirty sandbox, first push |
| DX Review  | `/plan-devex-review` | Developer experience | 2    | CLEAR (via /autoplan) | 4-command API, zero-arg create, auto-sync                        |

**VERDICT:** CLEARED. 2 taste decisions surfaced (SDK spike, exec timeout). All critical/high findings addressed.
