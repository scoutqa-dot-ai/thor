# Plan — 2026031902_sandbox-coder-phase-a

> Implement `sandbox-coder` binary and Daytona sandbox integration in `remote-cli`.

## Decision Log

| #   | Decision                                                               | Rationale                                                                                |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| D1  | sandbox-coder is a shell wrapper calling remote-cli.mjs                | Same pattern as git, gh, scoutqa — proven, zero new infrastructure.                      |
| D2  | Daytona SDK lives in remote-cli, not a new package                     | remote-cli already manages worktrees and external tool execution.                        |
| D3  | Source sync uses tar + file upload, not in-sandbox git credentials     | Sandbox never holds GitHub credentials. Agent pushes from worktree.                      |
| D4  | OpenCode runs inside the sandbox via Daytona session                   | Sandbox is a full coding environment. opencode-ai installed from npm.                    |
| D5  | Sandbox identity is worktree path → sandbox ID in memory               | Labels + reconcile on startup prevent orphans. See D8.                                   |
| D6  | SandboxProvider interface from day 1                                   | Prevents vendor lock-in, enables mocking in tests. DaytonaSandboxProvider implements it. |
| D7  | Use Daytona sessions, not simple exec                                  | Sessions survive HTTP disconnects. Session ID emitted early for reconnect.               |
| D8  | Label sandboxes + reconcile on startup                                 | On restart, list sandboxes by label, destroy orphans, re-populate Map.                   |
| D9  | Per-worktree lock in getOrCreate                                       | Prevents race condition where concurrent calls create duplicate sandboxes.               |
| D10 | Route: POST /exec/sandbox-coder, args carry prompt                     | Same URL pattern as git/gh/scoutqa. Zero changes to remote-cli.mjs client.               |
| D11 | NDJSON uses existing { stream, data } format with [sandbox:*] prefixes | Reuses scoutqa protocol. No client changes. Metadata on stderr.                          |
| D12 | Subcommands via args: --reconnect, --pull                              | Same endpoint handles new task, reconnect to session, and pull files.                    |
| D13 | No artificial timeout; 1h Daytona session limit if API supports        | Coding tasks vary in duration. Let the caller decide when to abort.                      |
| D14 | Fail loud on syncOut failure, no retry                                 | Agent can use --pull to recover. Keep error handling simple.                             |
| D15 | Git-diff partial sync + Daytona snapshots for warm starts              | Full tar on first sync, git-diff on repeat. Snapshots for base image.                    |
| D16 | No in-memory sandbox cache — always query Daytona API                  | Survives restarts, no stale cache. One extra list call is negligible vs 3-5 per invoke.  |
| D17 | Use `daytona-medium` snapshot, not custom Docker image                 | Pre-built Daytona snapshot has node/git/daytona user. Configurable via SANDBOX_SNAPSHOT. |
| D18 | Install opencode at setup time (pinned version), not baked into image  | No custom image to maintain. Pin version in code for reproducibility.                    |
| D19 | Split setup into one-time install + per-prompt auth upload             | Auth tokens expire. Refresh fields stripped to prevent sandbox invalidating main creds.  |
| D20 | PTY streaming instead of Daytona sessions for agent execution          | Sessions hang with opencode (no output). PTY via createPty streams JSON in real-time.    |
| D21 | `--session <id>` flag for opencode session continuity                  | Main agent decides which session to continue. Supports multiple concurrent sessions.     |
| D22 | Drop `--reconnect`, keep `--pull` and `--session`                      | PTY doesn't support reconnect like sessions did. --pull still useful for file recovery.  |
| D23 | Exclude .git from tar, init standalone repo in sandbox                 | Worktree .git is a pointer file to host git dir which doesn't exist in sandbox.          |
| D24 | Sync deleted files both directions (syncIn partial + syncOut)          | Detect via git diff --diff-filter=D locally, git status --porcelain in sandbox.          |
| D25 | Re-commit in sandbox after partial syncIn                              | Keeps sandbox HEAD current so next syncOut diff is accurate.                             |
| D26 | Require DAYTONA_API_KEY, drop apiUrl/target config                     | Only API key needed. Simplifies provider constructor. Fail fast if missing.              |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  OpenCode Container (agent runtime)                                     │
│                                                                         │
│  Agent calls:  sandbox-coder "implement auth fix"                       │
│       │                                                                 │
│       ▼                                                                 │
│  bin/sandbox-coder  ──exec──▶  remote-cli.mjs sandbox-coder "..."      │
│                                     │                                   │
│                                     │ POST /exec/sandbox-coder          │
│                                     │ { args: [...], cwd: "/wt/..." }   │
│                                     ▼                                   │
└─────────────────────────────────────┼───────────────────────────────────┘
                                      │ HTTP (NDJSON streaming response)
┌─────────────────────────────────────┼───────────────────────────────────┐
│  remote-cli service (port 3004)     │                                   │
│                                     ▼                                   │
│  POST /exec/sandbox-coder handler:                                      │
│    1. validateCwd(cwd) — must be /workspace/worktrees/...               │
│    2. Parse args: prompt vs --pull vs --session <id>                     │
│    3. sandboxManager.getOrCreate(cwd) → sandbox ID (remote query + lock)│
│    4. setupSandboxOpenCode (one-time) + uploadSandboxAuth (every call)  │
│    5. syncIn(sandboxId, cwd) — tar worktree → upload to Daytona         │
│    6. createPty → stream opencode JSON output in real-time (D20)        │
│    7. syncOut(sandboxId, cwd) — download changed files → write worktree │
│    8. Write { stream: "stderr", data: "[sandbox:done] ..." } → end      │
│                                                                         │
│  ┌──────────────────────┐    ┌──────────────────────────────────┐       │
│  │  SandboxManager      │    │  SandboxProvider interface        │       │
│  │  (manager.ts)        │───▶│  DaytonaSandboxProvider           │       │
│  │  remote query + lock      │  (provider.ts)                    │       │
│  └──────────────────────┘    └──────────────────────────────────┘       │
│                                        │                                │
│                                        │ @daytonaio/sdk                  │
│                                        ▼                                │
│            ┌──────────────────────────────────────────┐                  │
│            │  Daytona API (external)                  │                  │
│            │  - createSandbox (with labels)           │                  │
│            │  - file upload/download                  │                  │
│            │  - createPty (real-time streaming)       │                  │
│            │  - executeCommand (sync operations)      │                  │
│            │  - destroySandbox                        │                  │
│            └──────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### File structure

```
packages/remote-cli/src/
├── index.ts              (routes — add /exec/sandbox-coder)
├── exec.ts               (existing command execution)
├── policy.ts             (existing validation)
└── sandbox/
    ├── provider.ts       (SandboxProvider interface + DaytonaSandboxProvider)
    ├── manager.ts        (SandboxManager: Map, getOrCreate with lock, reconcile)
    └── sync.ts           (syncIn/syncOut: tar, upload, download, write)
```

### NDJSON protocol

Sandbox-coder reuses the existing `{ stream, data }` / `{ exitCode }` format. Structured metadata uses `[sandbox:*]` prefixes on stderr (same pattern as `[thor:meta]`):

```jsonl
{ "stream": "stderr", "data": "[sandbox:session] sess-abc-123\n" }
{ "stream": "stderr", "data": "[sandbox:phase] sync_in\n" }
{ "stream": "stdout", "data": "Editing src/index.ts...\n" }
{ "stream": "stderr", "data": "[sandbox:phase] agent_running\n" }
{ "stream": "stdout", "data": "All tests passing.\n" }
{ "stream": "stderr", "data": "[sandbox:phase] sync_out\n" }
{ "stream": "stderr", "data": "[sandbox:done] files_changed=3\n" }
{ "exitCode": 0 }
```

### Subcommands

All handled via the same `/exec/sandbox-coder` endpoint, differentiated by args:

- `sandbox-coder "implement auth fix"` → new task (create session, sync, run agent)
- `sandbox-coder --reconnect <session-id>` → resume streaming from existing session
- `sandbox-coder --pull <sandbox-id>` → syncOut only (pull files from sandbox to worktree)

---

## Phase 1 — sandbox-coder binary + shell wrapper

**Goal**: Agent can call `sandbox-coder "task"` from a worktree and get NDJSON output.

Steps:

1. Create `docker/opencode/bin/sandbox-coder` shell wrapper:

   ```sh
   #!/bin/sh
   exec node /usr/local/bin/remote-cli.mjs sandbox-coder "$@"
   ```

2. No changes needed to `remote-cli.mjs` — the existing client:
   - Constructs URL as `${baseUrl}/exec/sandbox-coder` automatically
   - Sends `{ args, cwd }` body (prompt is in args, joined server-side)
   - Detects `application/x-ndjson` content-type and streams (same as scoutqa)

3. Add `COPY bin/sandbox-coder /usr/local/bin/sandbox-coder` to `docker/opencode/Dockerfile`

4. Add stub `POST /exec/sandbox-coder` route to `index.ts` that returns a placeholder NDJSON stream

**Tests** (Phase 1):

- Shell wrapper sends correct endpoint and args
- Stub route returns NDJSON with correct content-type
- Non-worktree cwd → 400 error

**Exit criteria**:

- `sandbox-coder "hello"` from a worktree path POSTs to remote-cli and streams output
- `sandbox-coder "hello"` from a non-worktree path fails with exit code 2
- NDJSON events stream to stdout in real time

---

## Phase 2 — SandboxProvider + SandboxManager

**Goal**: remote-cli can create, reuse, and destroy Daytona sandboxes with proper lifecycle management.

Steps:

1. Add `@daytonaio/sdk` dependency to `packages/remote-cli/package.json`

2. Create `packages/remote-cli/src/sandbox/provider.ts`:
   - `SandboxProvider` interface:
     - `create(opts: { repo, branch, labels })` → sandbox ID
     - `destroy(sandboxId: string)` → void
     - `createSession(sandboxId: string)` → session ID
     - `execSessionCommand(sessionId: string, command: string)` → command ID
     - `getSessionCommandLogs(sessionId: string, commandId: string, onData: callback)` → stream
     - `uploadFile(sandboxId: string, remotePath: string, data: Buffer)` → void
     - `downloadFile(sandboxId: string, remotePath: string)` → Buffer
     - `listSandboxes(labels: Record<string, string>)` → sandbox list
   - `DaytonaSandboxProvider` class implementing the interface via `@daytonaio/sdk`

3. Create `packages/remote-cli/src/sandbox/manager.ts`:
   - `SandboxManager` class:
     - `sandboxes: Map<string, string>` — worktree path → Daytona sandbox ID
     - `creating: Map<string, Promise<string>>` — per-worktree lock for in-flight creations
     - `getOrCreate(cwd: string)` — lookup Map, or await existing creation, or create new
     - `destroy(cwd: string)` — remove from Map, call provider.destroy
     - `reconcile()` — on startup: list sandboxes by label `{ thor: true }`, destroy any whose worktree path no longer exists under `/workspace/worktrees/`, re-populate Map for live ones
   - Labels on creation: `{ "thor": "true", "worktree": cwd }`

4. Wire `sandboxManager.reconcile()` into the remote-cli startup (before `app.listen`)

5. Add sandbox destroy hook to existing `POST /exec/git` route:
   - After `git worktree remove` succeeds, call `sandboxManager.destroy(cwd)` for the removed path

**Tests** (Phase 2):

- getOrCreate: returns cached sandbox on second call
- getOrCreate: concurrent calls for same worktree → only one provider.create call (lock test)
- destroy: removes from Map, calls provider.destroy
- reconcile: destroys orphaned sandboxes, re-populates Map for existing worktrees
- All tests use a mock SandboxProvider (no Daytona calls)

**Exit criteria**:

- SandboxManager creates, caches, and destroys sandboxes via provider interface
- Concurrent getOrCreate calls don't create duplicates
- Startup reconcile cleans up orphaned sandboxes
- `git worktree remove` destroys the associated sandbox

---

## Phase 3 — Source sync

**Goal**: Worktree state is faithfully transferred to and from the sandbox.

Steps:

1. Create `packages/remote-cli/src/sandbox/sync.ts`

2. Implement `syncIn(provider, sandboxId, worktreePath)`:
   - First call (cold start): `tar -czf - -C <worktree> .` to create tarball, upload via `provider.uploadFile`, extract in sandbox
   - Repeat calls (warm): use `git diff --name-only` + `git ls-files --others --exclude-standard` to find changed/new files, tar only those
   - Verify: file count matches

3. Implement `syncOut(provider, sandboxId, worktreePath)`:
   - In sandbox: `git diff --name-only` to find changed files
   - Download changed files via `provider.downloadFile`
   - Write to worktree path
   - Detect deleted files via `git status --porcelain` in sandbox, delete from worktree
   - On failure: emit error with sandbox ID and session ID for recovery via `--pull`

4. Implement Daytona snapshots for warm starts:
   - After first syncIn + successful agent run, create a snapshot of the sandbox
   - On subsequent calls, create sandbox from snapshot instead of cold start + full tar
   - Fall back to cold start if snapshot creation fails

5. Handle edge cases:
   - Empty worktree (fresh branch, no files yet) → sync in the repo base from `/workspace/repos`
   - Binary files → included in tar, not in diff output
   - Deleted files → detect via `git status` in sandbox, delete from worktree

**Tests** (Phase 3):

- syncIn: creates tar from worktree, calls provider.uploadFile
- syncIn: repeat call uses git-diff partial sync (only changed files)
- syncOut: calls provider.downloadFile, writes files to worktree
- syncOut: handles deleted files
- syncOut: failure emits error with sandbox/session IDs

**Exit criteria**:

- Modified, added, and deleted files round-trip correctly
- Binary files survive the sync
- Empty worktree works (fresh branch)
- Repeat calls use git-diff partial sync
- Snapshots used for warm starts when available

---

## Phase 4 — Sandbox agent execution via Daytona sessions

**Goal**: OpenCode runs inside the Daytona sandbox via sessions, with reconnect support.

Steps:

1. Create a Daytona sandbox image or snapshot that includes:
   - Node.js 22
   - `opencode-ai@1.2.27` (or current version) installed globally
   - git
   - Common build tools (for the target repos)

2. Configure OpenCode inside the sandbox:
   - No MCP servers (execution-only, no external tools)
   - `"permission": "allow"` for file and bash tools
   - Agent prompt focused on coding: "You are a coding agent. Edit files, run tests, fix bugs. Do not attempt external API calls."
   - Working directory set to the synced source path

3. Implement agent execution via Daytona sessions:
   - `provider.createSession(sandboxId)` → session ID
   - Emit `[sandbox:session] <session-id>` immediately (for reconnect)
   - `provider.execSessionCommand(sessionId, 'opencode run --format json "<prompt>"')` → command ID
   - Stream output via `provider.getSessionCommandLogs(sessionId, commandId, onData)`
   - Parse OpenCode JSON output into `{ stream, data }` NDJSON events
   - If Daytona supports session timeout, set to 1h at creation

4. Implement `--reconnect <session-id>` subcommand:
   - Skip sandbox creation and syncIn
   - Call `provider.getSessionCommandLogs` to resume streaming
   - When agent completes, run syncOut as normal

5. Implement `--pull <sandbox-id>` subcommand:
   - Skip everything, just run syncOut for the given sandbox

6. Handle completion:
   - OpenCode exits 0 → task succeeded, emit `[sandbox:done]`
   - OpenCode exits non-zero → task failed, emit `[sandbox:error]` with last output
   - Session timeout → emit `[sandbox:timeout]`

**Tests** (Phase 4):

- Agent execution streams NDJSON with session ID and phase events
- --reconnect resumes streaming from existing session
- --pull triggers syncOut only
- Agent exit 0 → done event
- Agent exit non-zero → error event with output

**Exit criteria**:

- OpenCode runs inside a Daytona sandbox and can edit files
- OpenCode can run `npm test` (or equivalent) inside the sandbox
- Agent output streams back to the caller as NDJSON with `[sandbox:*]` events
- Session ID emitted early, enabling reconnect via `--reconnect`
- `--pull` recovers files from a sandbox after connection failure
- Sandbox survives across multiple `sandbox-coder` calls (not destroyed between calls)

---

## Phase 5 — End-to-end integration test

**Goal**: Full flow works: Slack message → Thor → sandbox-coder → Daytona → code changes → PR.

Steps:

1. Manual test script:
   - Create a worktree for a test branch
   - Run `sandbox-coder "add a hello-world endpoint to src/index.ts and a test for it"`
   - Verify files changed in worktree
   - Commit and push from worktree
   - Verify PR created

2. Verify sandbox reuse:
   - Run `sandbox-coder` again in the same worktree
   - Confirm sandbox is reused (not recreated)
   - Confirm incremental sync (only changed files transferred)

3. Verify reconnect:
   - Start `sandbox-coder` task, kill the connection mid-execution
   - Run `sandbox-coder --reconnect <session-id>` to resume
   - Verify output continues from where it left off
   - Run `sandbox-coder --pull <sandbox-id>` to recover files

4. Verify cleanup:
   - Run `git worktree remove`
   - Confirm Daytona sandbox is destroyed

5. Verify startup reconcile:
   - Restart remote-cli service
   - Confirm orphaned sandboxes are destroyed
   - Confirm live sandboxes are re-populated in Map

6. Verify failure:
   - Run `sandbox-coder` from `/workspace/repos` (not a worktree) → exit 2
   - Kill the Daytona sandbox mid-execution → agent sees error, exits 2
   - Give an impossible task → agent exits 1

**Exit criteria**:

- End-to-end flow produces a working PR from a Slack-triggered coding task
- Sandbox reuse works
- Reconnect and --pull recovery work
- Cleanup works (worktree remove + startup reconcile)
- Failure modes produce clear errors with session/sandbox IDs

## Out of Scope

- Preview URLs (Phase B in evaluation plan)
- Multi-sandbox per worktree (Phase C in evaluation plan)
- Sandbox cost tracking (see TODOS)
- Sandbox telemetry/observability beyond NDJSON output
