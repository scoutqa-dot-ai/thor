<!-- /autoplan restore point: /Users/son.dao/.gstack/projects/scoutqa-dot-ai-thor/feat-daytona-autoplan-restore-20260416-201749.md -->

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

Four commands. Must be run from a worktree (`cwd` provides repo, branch, path). Remote-cli orchestrates everything server-side. Git credentials never enter the sandbox environment.

```
┌─ Agent (in /workspace/worktrees/myrepo/feat/auth) ───────────┐
│                                                               │
│  sandbox exec "pytest -v"            → streamed test output   │
│  sandbox exec "flake8 ."             → reuses same sandbox    │
│  sandbox stop                        → cleanup                │
│                                                               │
│  (all commands keyed by cwd; no id to track)                  │
└───────────────────────────┬───────────────────────────────────┘
                            │ POST /exec/sandbox { args, cwd }
                            ▼
┌─ remote-cli (server-side) ────────────────────────────────────┐
│                                                                │
│  All operations via @daytona/sdk. No CLI binary.               │
│                                                                │
│  sandbox create (derives everything from cwd):                 │
│    1. Parse cwd → repo name, branch, worktree path             │
│    2. git remote get-url origin (in cwd) → remote URL          │
│    3. SDK: daytona.create({ ephemeral, autoStop: 15, name })   │
│       └─ name = sanitized worktree path (repo-branch)          │
│    4. Mint GitHub App token for org (REQUIRED, no PAT fallback)│
│    5. SDK: sandbox.git.clone(remoteUrl, branch, creds)         │
│       └─ creds transient, NOT stored in sandbox env            │
│    6. Store mapping: cwd → { sandboxId, remoteUrl, branch }    │
│    7. Return sandbox ID                                        │
│                                                                │
│  sandbox exec "<command>" (keyed by cwd):                      │
│    1. Look up sandbox for cwd; auto-create if missing/gone     │
│    2. Preflight worktree (clean tree, resolve HEAD SHA)        │
│    3. ensureShaOnOrigin: fetch SHA, or scratch-push to         │
│       refs/heads/thor-sandbox/<id> (real branch untouched)     │
│    4. SDK: sandbox.git.pull + executeCommand(fetch+reset <sha>)│
│    5. SDK: sandbox.commands.run(command)                        │
│    6. Stream stdout/stderr via NDJSON                          │
│                                                                │
│  sandbox stop (keyed by cwd):                                  │
│    1. Look up tracked sandbox for cwd; no-op if none           │
│    2. SDK: sandbox.delete() (idempotent)                       │
│    3. Drop local mapping                                       │
│                                                                │
│  sandbox list:                                                 │
│    1. SDK: daytona.list() filtered by session prefix           │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              Daytona Cloud (isolated, no credentials)
```

**Key security properties:**

1. The sandbox never has git credentials. `git.clone()` and `git.pull()` pass credentials transiently via the Daytona SDK API. Running `env` inside the sandbox won't reveal them.
2. **Sandbox requires GitHub App auth. PAT is never used.** The blast radius of a leaked PAT (long-lived, broadly scoped) is unacceptable for a third-party cloud sandbox. Remote-cli calls `parseOrgFromRemoteUrl(remoteUrl)` → `getInstallationToken(org)` from `github-app-auth.ts`. If no installation is configured for the org, `sandbox create` fails fast with a clear error. GitHub App tokens are ~1 hr TTL, scoped to one installation, and show up in GitHub's audit log with the app identity.
3. Remote URL is NOT read from `.git/config` (agent could rewrite it via `git config`). Instead, derive from admin-known repo metadata in `/workspace/config.json` via `getRepoRemoteUrl()`.
4. Private source code IS cloned to Daytona Cloud. This is an explicit trust boundary change. Acceptable because: Daytona sandboxes are ephemeral, auto-deleted, and the same code is already on GitHub. For self-hosted Daytona, code stays on your infra.

**Key DX property:** Zero-argument `create` — cwd tells remote-cli everything. `exec` auto-syncs code (push + pull) before running. Agent just edits, commits, runs.

## Phases

### Phase 1: Environment Setup

- [x] Add `@daytona/sdk` to `packages/remote-cli/package.json`. No CLI needed.
- [x] Add env vars to `docker-compose.yml` (`remote-cli` service):
  - `DAYTONA_API_KEY=${DAYTONA_API_KEY:-}`
  - `DAYTONA_API_URL=${DAYTONA_API_URL:-https://app.daytona.io/api}`
- [x] Add to `.env.example`:
  ```
  # -- DAYTONA -- cloud sandboxes for Python/Java/etc.
  # DAYTONA_API_KEY=daytona_XXXXXXXXXXXX
  # DAYTONA_API_URL=https://app.daytona.io/api
  ```

### Phase 2: Sandbox Endpoint

> **Note:** The step-by-step flow below describes the initial v1 design. Phase 7 supersedes it for the current behavior (SHA-based sync, scratch-ref push, no `<id>` arg for exec/stop, auto-create on missing). Keep this for historical context.

- [x] Create `docker/opencode/bin/sandbox` wrapper script.
  - Must be run from a worktree (`cwd` sent to remote-cli, like git/gh).
  - Usage (current, per Phase 7):
    - `sandbox create` → optional pre-warm; derives repo/branch/remote from cwd, prints sandbox ID
    - `sandbox exec "<command>"` → auto-creates sandbox if needed, syncs code by SHA, streams output
    - `sandbox stop` → stops the sandbox tracked for this cwd (silent no-op if none)
    - `sandbox list` → lists session's sandboxes (introspection)
- [x] Implement `POST /exec/sandbox` endpoint in `packages/remote-cli/src/index.ts`.
  - Body: `{ "args": ["create"|"exec"|"stop"|"list", ...], "cwd": "/workspace/worktrees/..." }`
  - `sandbox` is repo-scoped (NOT in `nonRepoScopedEndpoints`). `cwd` is validated + required.
  - `create` (no args, everything from cwd):
    1. Validate `cwd` is under `/workspace/worktrees/`
    2. Parse `cwd` → repo name, worktree path
    3. `git rev-parse --abbrev-ref HEAD` in cwd → branch
    4. Resolve remote URL from admin config (NOT from `.git/config`, see Security)
    5. Resolve git credentials: GitHub App token via `github-app-auth.getInstallationToken(org)`. No PAT fallback — fail fast if missing.
    6. SDK: `daytona.create({ ephemeral: true, autoStopInterval: 15, name })`
    7. SDK: `sandbox.git.clone(remoteUrl, branch, creds)` — creds transient, not stored
    8. Store mapping: sandboxId → { cwd, remoteUrl, branch }
    9. Return `{ sandboxId: "<id>" }`
  - `exec <id> "<command>"`:
    1. Lookup sandbox by ID from mapping (not by cwd)
    2. `git push` on host (in stored cwd). Host git already resolves creds via the auth-helper configured in `entrypoint.sh`.
       — First push: use `git push -u origin HEAD` to set upstream
       — If nothing to push (clean): skip push, still pull
    3. Resolve git credentials for pull (same path as create step 5)
    4. SDK: `sandbox.git.pull(username, password)` — creds transient
       — If pull fails (dirty tree): run `git reset --hard origin/<branch>` in sandbox first
    5. SDK: `sandbox.commands.run(command)` — streamed via NDJSON
  - `stop <id>`:
    1. SDK: `sandbox.delete()`
    2. Remove from mapping
  - `list`:
    1. SDK: `daytona.list()` filtered by name prefix
    2. Also check in-memory map for enriched info (cwd, branch)
  - Use NDJSON streaming for `exec` subcommand. Buffered JSON for others.
  - On map miss for `exec <id>`: try `daytona.get(id)` to recover after restart.
- [x] Implement `packages/remote-cli/src/sandbox.ts` module:
  - All operations use `@daytona/sdk`. No CLI binary needed.
  - Git credentials resolved via `resolveGitCredentials(remoteUrl)`:
    1. `parseOrgFromRemoteUrl(remoteUrl)` → org (from `github-app-auth.ts`)
    2. `getInstallationToken(org)` → short-lived GitHub App token
    3. Return `["x-access-token", token]`
    4. **No PAT fallback.** If org cannot be resolved, no installation is configured, or token minting fails, throw `SandboxUserError("Sandbox requires GitHub App auth for <org>. Configure github_app.installations in workspace config.")`
  - `createSandbox(name: string, remoteUrl: string, branch: string): Promise<string>`
    — `daytona.create({ name, ephemeral: true, autoStopInterval: 15 })` then `sandbox.git.clone()` with resolved creds
  - `pullInSandbox(id: string, remoteUrl: string): Promise<void>` — resolves creds, then `sandbox.git.pull()`
  - `pushFromWorktree(cwd: string): Promise<void>` — host-side `execCommand("git", ["push"], cwd)`
  - `execInSandbox(id: string, command: string, callbacks: StreamCallbacks): Promise<number>`
    — `sandbox.commands.exec(command)` to start, then `getSessionCommandLogs()` with
    stdout/stderr callbacks for real-time streaming. `commands.run()` is buffered (waits
    for completion), so we must use exec + log streaming instead.
    — On timeout: agent already has all output streamed so far. Nothing lost.
  - `deleteSandbox(id: string): Promise<void>` — `sandbox.delete()`
  - `listSandboxes(prefix: string): Promise<string[]>` — `daytona.list()` filtered by prefix
  - In-memory map: `Map<sandboxId, { cwd, remoteUrl, branch }>` keyed by sandbox ID
  - Secondary index: `Map<cwdPath, sandboxId>` for `create` dedup (same worktree replaces old)
  - Recovery on map miss: `daytona.get(id)` to re-hydrate after restart (cannot recover cwd)
- [x] `sandbox` is repo-scoped (sends `cwd`, like git/gh). Do NOT add to `nonRepoScopedEndpoints`.

### Phase 3: Sandbox Lifecycle

- [x] Name sandboxes by worktree path: `--name <repo>-<branch>` (sanitized).
- [x] Primary map: `Map<sandboxId, { cwd, remoteUrl, branch }>`.
- [x] Secondary index: `Map<cwdPath, sandboxId>` for dedup on `create`.
- [x] `sandbox create` from the same worktree stops the old sandbox, creates new.
- [x] Recovery on map miss: `daytona.get(id)` to check if sandbox still exists.
  - If found: exec works (no cwd for auto-sync, run command directly).
  - If not found: return 404.
- [x] No cleanup hook needed. Rely on:
  1. Agent calls `sandbox stop` (skill teaches this).
  2. `--ephemeral` + `--auto-stop 15` as safety net (Daytona auto-deletes idle sandboxes).
  3. In-memory map clears on remote-cli restart (Daytona handles orphans).

### Phase 4: Agent Skill + Documentation

- [x] Create `docker/opencode/config/skills/sandbox/SKILL.md`:
  - When to use: running Python/Java/etc. tests, compiling code, executing non-Node scripts
  - Commands: `sandbox create`, `sandbox exec`, `sandbox stop`, `sandbox list`
  - Workflow example:
    ```
    cd /workspace/worktrees/myrepo/feat/auth
    sandbox create                     # → "sandbox-abc123"
    # edit code, commit...
    sandbox exec abc123 "pip install -r requirements.txt && pytest -v"
    # fix test, commit...
    sandbox exec abc123 "pytest -v"    # auto-syncs code
    sandbox stop abc123
    ```
  - Note: `exec` auto-syncs (pushes local commits + pulls in sandbox)
  - Note: sandbox has internet access for `pip install`, `npm install`, etc.
  - Common errors and fixes
- [x] Update README.md to list `sandbox` in available agent tools.
- [x] Define base snapshot/image contract (which runtimes pre-installed).

### Phase 5: Tests

- [ ] Unit tests for sandbox orchestration in `packages/remote-cli/src/sandbox.test.ts`:
  - `create`: happy path (create + clone), repo not found, API unreachable, auth failure
  - `exec`: happy path (push + pull + exec + stream), push fails, pull fails (dirty tree recovery), command fails (nonzero), nothing to push (clean tree), first push (no upstream)
  - `exec` after restart: map miss → recovery via `daytona.get(id)`
  - `stop`: happy path, sandbox not found
  - `list`: happy path, empty list
  - In-memory mapping: exec with unknown sandbox ID attempts recovery
  - Unconfigured: `DAYTONA_API_KEY` empty → clear error on `create`
  - Branch names with special chars (slashes, dots) → sanitized sandbox name
- [ ] Integration test for `/exec/sandbox` endpoint:
  - `create` returns sandbox ID
  - `exec` returns NDJSON stream
  - `stop` returns success
  - `list` returns filtered sandboxes
  - Invalid args (missing repo/branch/command) returns 400
  - Invalid subcommand returns 400
- [ ] Lifecycle test:
  - Sandboxes tagged with correlation key
  - Cleanup deletes matching sandboxes
- [ ] Security test:
  - PAT NOT visible via `sandbox exec "env | grep -i token"`

### Phase 6: Validation

- [ ] End-to-end: `sandbox exec "pytest -v"` → results streamed (auto-creates on first call)
- [ ] Verify credentials are NOT visible inside sandbox (`sandbox exec "env | grep -i token"`)
- [ ] Verify `sandbox create` fails fast with a clear error when GitHub App installation is not configured for the org
- [ ] Verify auto-sync: edit in worktree, commit, `sandbox exec` picks up changes
- [ ] Verify auto-stop: idle sandbox is cleaned up by Daytona after 15 min

### Phase 7: SHA-based Sync + Strict Preflight

Triggered by `pr-2984` failure: local branch name created via `git fetch origin pull/N/head:pr-N` does not exist on origin, so Daytona's `git.clone(url, path, branch)` returns a generic 400. Branch-name-based sync is also fragile if the remote tip moves between host and sandbox operations. Switch to SHA-based identity, with strict preflight on the host so the user gets clear errors before any cloud call.

**Common preflight (both `create` and `exec`):**

1. Verify clean worktree via `git status --porcelain`. Fail if any output (uncommitted, unstaged, OR untracked).
   - Hint: `"Worktree not clean. Add untracked files to .gitignore, commit/stash changes, or use 'git worktree add <path> <ref>' to keep current state in a separate worktree."`
2. Resolve host HEAD SHA (`git rev-parse HEAD`).

**Ensure SHA on origin (post-sandbox-creation for `create`; after preflight for `exec`):**

1. Try single-SHA fetch: `git fetch --quiet origin <sha>`.
2. On success: proceed (SHA reachable, e.g. already pushed, or PR head ref).
3. On failure: push HEAD to a scratch ref: `git push --quiet origin HEAD:refs/heads/thor-sandbox/<sandboxId>`. This makes the SHA reachable without touching the real branch (no PR sync, no branch-protection trip).
4. If the scratch push itself fails, surface `"Commit <sha7> isn't on origin. Push your branch first."` — same shape as the no-reachability case, so the agent just pushes to its own branch and retries.

**`create` changes:**

- [x] Run preflight (clean tree only) before any Daytona call.
- [x] Drop `branch` from `daytona.git.clone` (`branch=undefined`); pass `commitId=<sha>`. Sandbox name still uses `${repoName}-${branch}` for human readability, but correctness rides on the SHA.
- [x] After Daytona sandbox create, run `ensureShaOnOrigin` (verify or scratch-push), then clone. On any failure, delete the sandbox and surface a generic error (admin-only rich context in logs).

**`exec` changes:**

- [x] Run preflight (clean tree) before syncing.
- [x] Replace `sandbox.git.pull` + `git reset --hard origin/<branch>` with: `ensureShaOnOrigin` on host, then `sandbox.git.pull(...)` (auth-enabled fetch via Daytona) followed by `executeCommand("git fetch origin <sha> && git reset --hard <sha>")`. Pull warms the credential helper inside the sandbox; the explicit fetch+reset pins to the exact host SHA regardless of branch-tip drift.
- [x] Auto-create a new sandbox from `cwd` if the sandbox ID is unknown or the sandbox has disappeared on the Daytona side. The fresh sandbox is already at the host SHA (clone pinned commitId), so no extra sync.

**Behavior changes worth documenting in the skill:**

- Real branch stays pristine. If the host SHA isn't on origin, a scratch push to `refs/heads/thor-sandbox/<sandboxId>` makes it reachable without touching the PR branch.
- Branch name is informational (sandbox name only). PR-head fetches like `pr-2984` work as long as the SHA is reachable on origin (which `pull/N/head` always is).
- Out-of-sync with `origin/<branch>` is intentionally allowed: opencode can run an older commit by checking it out and creating a sandbox at that SHA.
- `sandbox exec`, `sandbox stop`, and `sandbox list` take no sandbox id — everything is keyed by the request's `cwd`. Auto-create on missing sandbox is completely invisible to the agent. Agents wanting to see ids can use `sandbox list`.

**Follow-ups (not in this phase):**

- [ ] **P1 — Daily cleanup of `refs/heads/thor-sandbox/*` on origin whose sandbox no longer exists in Daytona.** Now that every `sandbox create`/`sandbox exec` pushes to its per-sandbox scratch ref, this is load-bearing: every live sandbox owns one ref (overwritten in place, so no growth while the sandbox lives), but every _deleted_ sandbox leaves its ref behind until cleanup runs. A scheduled job (daily cron, e.g. from `packages/runner/src/scheduler`) should: list live Daytona sandboxes with the `thor-managed` label, list refs under `thor-sandbox/` on each managed repo's origin, and `git push origin --delete refs/heads/thor-sandbox/<id>` for every id that isn't live. Belt-and-suspenders: also delete refs older than 7 days regardless.
  - Without this, origin accumulates one stale ref per stopped sandbox — cheap individually but unbounded over time. Kicks in when a team hits a few hundred stopped sandboxes, not immediately.
  - Admins can work around by running `git push origin --delete refs/heads/thor-sandbox/*` manually if the job is late.

**Tests:**

- [x] Preflight: dirty tree (uncommitted OR untracked) blocks with `.gitignore` + `git worktree add` hint.
- [x] `create`: SHA-based clone passes `commitId` to Daytona, no `branch` param.
- [x] `create`: pushes HEAD to `thor-sandbox/<id>` when SHA isn't reachable on origin; no push when SHA is already on origin.
- [x] `create`: scratch-push failure deletes the sandbox and surfaces a clear error.
- [x] `exec`: no auto-push to real branch; clean tree + on-origin SHA succeeds; sandbox ends at host SHA after sync.
- [x] `exec`: auto-creates a fresh sandbox when the id is unknown.
- [x] `exec`: SHA-based reset pins to host SHA even when sandbox pull fails.

## Decision Log

| Date       | Choice                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-16 | Daytona over alternatives                                                       | Cloud needed for parallel sessions. Full CLI + SDK. Self-hostable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-04-16 | High-level `sandbox` command                                                    | Agent shouldn't orchestrate create/clone/exec/delete. One command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-04-16 | SDK for everything, no CLI                                                      | SDK covers create/clone/pull/exec/delete. No binary to install, no version to pin.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-04-16 | No raw daytona CLI exposure                                                     | Prevents PAT leaks via `--env`, reduces attack surface, no policy allowlist needed.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-04-16 | Skill named "sandbox" not "daytona"                                             | Daytona is implementation detail. Skill teaches the concept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-04-16 | No cleanup hook needed                                                          | Rely on agent calling `sandbox stop` + Daytona auto-stop as safety net.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-04-16 | Kill worktree streamer                                                          | Agent commits before pushing. Git clone works. No need for HMAC/tar/ingress bypass.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-04-16 | SDK only, no CLI binary                                                         | SDK covers all operations. No binary to install in Dockerfile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-04-16 | Worktree path as map key                                                        | Natural 1:1 with the code. Daytona auto-stop as cleanup safety net.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-04-16 | NDJSON streaming for exec                                                       | Test runs exceed 60s. Use execCommandStream pattern like scoutqa.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-04-17 | Sandbox REQUIRES GitHub App auth, no PAT fallback                               | PAT in a third-party cloud sandbox is too much blast radius (long-lived, broadly scoped). Fail fast when App installation is missing for the org. Uses `github-app-auth.getInstallationToken()`.                                                                                                                                                                                                                                                                                                                                  |
| 2026-04-17 | Repo remote comes from `git remote get-url origin` in `/workspace/repos/<repo>` | `/workspace/repos` is read-only to OpenCode, so `.git/config` there is effectively admin-owned. Drops a redundant config field. HTTPS enforced at resolution time.                                                                                                                                                                                                                                                                                                                                                                |
| 2026-04-17 | Sandbox session scoping uses Daytona labels                                     | `sandbox list` filters by session without overloading the human-readable sandbox name.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-04-17 | Host push uses explicit `origin HEAD:refs/heads/<branch>` refspec               | Avoids relying on local upstream state while still syncing committed branch contents.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-04-17 | Base sandbox contract stays minimal until a pinned image exists                 | Current code only guarantees shell + git + network; runtime availability must be checked per task.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-04-17 | SHA-based identity for clone + sync; strict host preflight; no auto push/fetch  | Branch-name-based clone hides errors (PR-head fetches like `pr-2984` aren't on origin under that name) and is fragile to remote tip drift. Push by SHA, verify SHA on origin via single-SHA fetch, reset sandbox to exact host SHA. Worktree must be clean. Opencode owns push/fetch decisions.                                                                                                                                                                                                                                   |
| 2026-04-17 | Drop sandbox `<id>` arg from exec/stop; key by cwd                              | "CLI does as much as possible, opencode as little as possible." The agent no longer captures/echoes ids, never sees stale-id fallback. `cwdIndex` is the single source of truth; auto-create, stop no-op, and list work without ids. Tradeoff: one sandbox per worktree at a time (fine).                                                                                                                                                                                                                                         |
| 2026-04-17 | Drop in-memory map; Daytona labels are the source of truth                      | `thor-cwd` + `thor-branch` labels are stored as plain text on create; `daytona.list({thor-managed, thor-cwd})` finds sandboxes for a request. Remote-cli is now stateless (only `cwdLocks` remain as an ephemeral mutex). Survives restart. One extra `daytona.list` per request is the cost.                                                                                                                                                                                                                                     |
| 2026-04-17 | Launch from `daytona-medium` snapshot; admin-overridable via `sandbox.snapshot` | Daytona requires a snapshot to start a sandbox. `daytona-medium` is the sane default for most tasks. Admins can point to a custom snapshot (pre-baked language runtimes, cache, etc.) via the new `sandbox.snapshot` workspace config key, read lazily so changes take effect on next create.                                                                                                                                                                                                                                     |
| 2026-04-17 | Clone default branch then fetch+reset SHA, not clone-by-commitId                | `sandbox.git.clone(..., commitId=sha)` 400s when the SHA isn't reachable from the default branch (e.g. PR head refs at `refs/pull/N/head` or our `thor-sandbox/*` scratch refs). Clone the default branch to establish the remote, then run `git fetch origin <sha> && git reset --hard <sha>` via executeCommand — same pattern we already use in sync, now covers create too.                                                                                                                                                   |
| 2026-04-17 | Always scratch-push; fetch by ref, not by SHA                                   | Sandbox-side `git fetch origin <sha>` returned exit 128 in practice (allowReachableSHA1InWant wire behavior is unreliable). Drop the "only push when not reachable" shortcut: always push HEAD to `refs/heads/thor-sandbox/<id>`, always fetch that specific ref in the sandbox. One deterministic path, no SHA-fetch magic. `executeCommand.result` now surfaced in sync-failure logs so future breaks show the real error.                                                                                                      |
| 2026-04-17 | Embed GitHub App token in the sandbox fetch URL                                 | Daytona's `sandbox.git.pull`/`clone` pass creds transiently for that one call only — nothing persists into `.git/config`, so a plain `git fetch origin <ref>` via `executeCommand` prompts for credentials and fails (`fatal: could not read Username`). Put the short-lived GitHub App token into the fetch URL instead. Token is visible in the sandbox cmdline briefly, same exposure as the preceding clone; acceptable given ~1hr TTL. Also lets us drop the `sandbox.git.pull` call and the pull-side auth retry — simpler. |

## Exit Criteria

- `sandbox create/exec/stop/list` commands available in OpenCode environment.
- Code cloned into sandbox without credentials being stored in sandbox env.
- Require GitHub App installation for the org; fail fast with clear error if missing. PAT is never used for sandbox git ops.
- `sandbox exec` auto-syncs (push + pull) before running command.
- Test output streamed back to agent via NDJSON.
- Daytona auto-stop cleans up idle sandboxes (15 min).
- Git credentials NOT visible via `env` inside sandbox.

## Out of Scope

- Custom Daytona targets or profile management.
- Cost monitoring / usage tracking (deferred to TODOS.md).
- Sandbox result artifact management (files back from sandbox to agent).
- Raw `daytona` CLI access for agent (security risk, not needed).
- Client disconnect → sandbox command cancellation. If OpenCode kills the wrapper (SIGTERM), the HTTP request aborts but the sandbox command keeps running until Daytona auto-stop. Same gap exists for all current remote-cli endpoints. Future: listen for `req.on("close")` and call SDK command cancel.

## Error & Rescue Registry

| Method/Codepath   | What Can Go Wrong                    | Rescued? | Rescue Action                                 | User Sees                                                                                             |
| ----------------- | ------------------------------------ | -------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `sandbox create`  | Not in a worktree                    | Y        | 400                                           | "Must run from /workspace/worktrees/"                                                                 |
| `sandbox create`  | Daytona API unreachable              | Y        | 500                                           | "Sandbox service unavailable"                                                                         |
| `sandbox create`  | Daytona auth failure                 | Y        | 500                                           | "Sandbox auth failed, check DAYTONA_API_KEY"                                                          |
| `sandbox create`  | GitHub App installation missing      | Y        | 400                                           | "Sandbox requires GitHub App auth for <org>. Configure github_app.installations in workspace config." |
| `sandbox create`  | GitHub App token mint fails          | Y        | 500                                           | "Failed to mint GitHub App token for <org>"                                                           |
| `sandbox create`  | Clone fails (bad repo/branch)        | Y        | Delete sandbox, 400                           | "Failed to clone <repo>@<branch>"                                                                     |
| `sandbox create`  | Worktree dirty (host preflight)      | Y        | 400                                           | "Worktree not clean. Commit your changes first (add generated files to .gitignore)."                  |
| `sandbox create`  | HEAD SHA not on origin               | Y        | 400                                           | "Commit <sha7> isn't on origin. Push your branch first."                                              |
| `sandbox create`  | Create timeout                       | Y        | 500                                           | "Sandbox creation timed out"                                                                          |
| `sandbox exec`    | No sandbox for cwd / gone on Daytona | Y        | Auto-create from cwd (silent)                 | Stream command output normally                                                                        |
| `sandbox exec`    | Worktree dirty (host preflight)      | Y        | 400                                           | (same hint as create)                                                                                 |
| `sandbox exec`    | HEAD SHA not on origin               | Y        | 400                                           | "Commit <sha7> isn't on origin. Push your branch first."                                              |
| `sandbox exec`    | GitHub App token mint fails          | Y        | 500                                           | "Failed to mint GitHub App token for <org>"                                                           |
| `sandbox exec`    | Git pull fails (sandbox)             | Y        | 500                                           | "Failed to sync code to sandbox"                                                                      |
| `sandbox exec`    | Command fails (nonzero)              | Y        | Stream stderr                                 | Test failure output (normal)                                                                          |
| `sandbox exec`    | Long-running command                 | N/A      | No timeout imposed — OpenCode manages its own | Stream until done                                                                                     |
| `sandbox stop`    | No sandbox tracked for cwd           | Y        | Silent no-op (idempotent)                     | Exit 0                                                                                                |
| `sandbox stop`    | Delete fails                         | Y        | Log + ignore                                  | Exit 0                                                                                                |
| Daytona auto-stop | Sandbox leaked (no explicit stop)    | Y        | Auto-delete after 15 min idle                 | Silent                                                                                                |

## Failure Modes Registry

| Codepath       | Failure Mode     | Rescued? | Test?    | User Sees?        | Logged?     |
| -------------- | ---------------- | -------- | -------- | ----------------- | ----------- |
| sandbox create | Not in worktree  | Y        | Planned  | 400               | Y           |
| sandbox create | API unreachable  | Y        | Planned  | 500               | Y           |
| sandbox create | Auth failure     | Y        | Planned  | 500               | Y           |
| sandbox create | App inst missing | Y        | Planned  | 400               | Y           |
| sandbox create | Token mint fails | Y        | Planned  | 500               | Y           |
| sandbox create | Clone failure    | Y        | Planned  | 400               | Y           |
| sandbox create | Timeout          | Y        | Planned  | 500               | Y           |
| sandbox exec   | No sandbox yet   | Y        | Tested   | Auto-created      | Y           |
| sandbox exec   | Push fails       | Y        | Tested   | 400               | Y           |
| sandbox exec   | Pull fails       | Y        | Tested   | 500               | Y           |
| sandbox exec   | Nonzero exit     | Y        | Tested   | stderr            | Y           |
| sandbox exec   | Long-running     | N/A      | N/A      | Stream until done | N/A         |
| sandbox stop   | None tracked     | Y        | Tested   | Silent Exit 0     | N           |
| sandbox stop   | Delete fails     | Y        | Tested   | Silent Exit 0     | Y           |
| auto-stop      | Sandbox leaked   | Y        | Built-in | Silent            | Y (Daytona) |

No CRITICAL GAPS.

<!-- AUTONOMOUS DECISION LOG -->

## Decision Audit Trail

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

## GSTACK REVIEW REPORT

| Review     | Trigger              | Why                  | Runs | Status                | Findings                                                         |
| ---------- | -------------------- | -------------------- | ---- | --------------------- | ---------------------------------------------------------------- |
| CEO Review | `/plan-ceo-review`   | Scope & strategy     | 2    | CLEAR (via /autoplan) | No demand data (accepted risk), git sync latency noted           |
| Eng Review | `/plan-eng-review`   | Architecture & tests | 2    | CLEAR (via /autoplan) | Fixed: identity model, trust boundary, dirty sandbox, first push |
| DX Review  | `/plan-devex-review` | Developer experience | 2    | CLEAR (via /autoplan) | 4-command API, zero-arg create, auto-sync                        |

**VERDICT:** CLEARED. 2 taste decisions surfaced (SDK spike, exec timeout). All critical/high findings addressed.
