# Plan — 2026031902_sandbox-coder-phase-a

> Implement `sandbox-coder` binary and Daytona sandbox integration in `remote-cli`.

## Decision Log

| #   | Decision                                                               | Rationale                                                                                |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| D1  | sandbox-coder is a shell wrapper calling remote-cli.mjs                | Same pattern as git, gh, scoutqa — proven, zero new infrastructure.                      |
| D2  | Daytona SDK lives in remote-cli, not a new package                     | remote-cli already manages worktrees and external tool execution.                        |
| D3  | Source sync uses rsync over SSH, not in-sandbox git credentials        | Sandbox never holds GitHub credentials. Agent pushes from worktree. rsync replaced tar.  |
| D4  | OpenCode runs inside the sandbox via Daytona session                   | Sandbox is a full coding environment. opencode-ai installed from npm.                    |
| D5  | Sandbox identity is worktree path → sandbox ID via remote API query    | Labels enable lookup. No in-memory cache — always queries Daytona API (D16).             |
| D6  | SandboxProvider interface from day 1                                   | Prevents vendor lock-in, enables mocking in tests. DaytonaSandboxProvider implements it. |
| D7  | Use Daytona sessions for agent execution, executeCommand for setup     | Sessions provide async execution + log streaming + exit codes. executeCommand for sync.  |
| D8  | Label sandboxes with `thor=true` + `worktree=<cwd>`                    | Enables lookup by worktree path via remote API. No startup reconcile implemented yet.    |
| D9  | Per-worktree lock in getOrCreate                                       | Prevents race condition where concurrent calls create duplicate sandboxes.               |
| D10 | Route: POST /exec/sandbox-coder, args carry prompt                     | Same URL pattern as git/gh/scoutqa. Zero changes to remote-cli.mjs client.               |
| D11 | NDJSON uses existing { stream, data } format with [sandbox:*] prefixes | Reuses scoutqa protocol. No client changes. Metadata on stderr.                          |
| D12 | Subcommands via args: --session, --pull                                | Same endpoint handles new task, session continuity, and pull files. --reconnect dropped. |
| D13 | No artificial timeout; 1h Daytona session limit if API supports        | Coding tasks vary in duration. Let the caller decide when to abort.                      |
| D14 | Fail loud on syncOut failure, no retry                                 | Agent can use --pull to recover. Keep error handling simple.                             |
| D15 | rsync handles incremental sync natively (replaces git-diff partial)    | rsync diffs files automatically. No need for git-diff state tracking or tar.             |
| D16 | No in-memory sandbox cache — always query Daytona API                  | Survives restarts, no stale cache. One extra list call is negligible vs 3-5 per invoke.  |
| D17 | Use `daytona-medium` snapshot, not custom Docker image                 | Pre-built Daytona snapshot has node/git/daytona user. Configurable via SANDBOX_SNAPSHOT. |
| D18 | Install opencode at setup time (pinned version), not baked into image  | No custom image to maintain. Pin version in code for reproducibility.                    |
| D19 | Split setup into one-time install + per-prompt auth upload             | Auth tokens expire. Refresh fields stripped to prevent sandbox invalidating main creds.  |
| D20 | Session API with async commands for agent execution                    | Async session commands give real exit codes, stdout/stderr separation, and auto-close.   |
| D21 | `--session <id>` flag for opencode session continuity                  | Main agent decides which session to continue. Supports multiple concurrent sessions.     |
| D22 | Close stdin for async session commands                                 | opencode hangs waiting for TTY input without `</dev/null`. Closing stdin prevents hang.  |
| D23 | Exclude .git from rsync, init standalone repo in sandbox               | Worktree .git is a pointer file to host git dir which doesn't exist in sandbox.          |
| D24 | rsync --delete handles file deletions both directions                  | No manual detection needed. rsync natively removes files not present in source.          |
| D25 | (Superseded by rsync) — no re-commit needed after sync                 | rsync replaces git-diff partial sync. syncOut counts changes via git for reporting only. |
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
│    5. provider.syncIn(sandboxId, cwd) — rsync worktree → sandbox via SSH│
│    6. provider.runAgentStreaming — session API + log streaming (D20)     │
│    7. provider.syncOut(sandboxId, cwd) — rsync sandbox → worktree       │
│    8. Write { stream: "stderr", data: "[sandbox:done] ..." } → end      │
│                                                                         │
│  ┌──────────────────────┐    ┌──────────────────────────────────┐       │
│  │  SandboxManager      │    │  SandboxProvider interface        │       │
│  │  (manager.ts)        │───▶│  DaytonaSandboxProvider           │       │
│  │  remote query + lock      │  (provider.ts)                    │       │
│  └──────────────────────┘    └──────────────────────────────────┘       │
│                                        │                                │
│                                        │ @daytonaio/sdk + rsync over SSH │
│                                        ▼                                │
│            ┌──────────────────────────────────────────┐                  │
│            │  Daytona API (external)                  │                  │
│            │  - createSandbox (with labels)           │                  │
│            │  - file upload (auth.json, config)       │                  │
│            │  - createSshAccess (for rsync)           │                  │
│            │  - session API (async cmd + log stream)  │                  │
│            │  - executeCommand (setup, git init)      │                  │
│            │  - destroySandbox                        │                  │
│            └──────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### File structure

```
packages/remote-cli/src/
├── index.ts              (routes — POST /exec/sandbox-coder handler)
├── exec.ts               (existing command execution)
├── policy.ts             (validation — validateSandboxCwd, validateSandboxCoderArgs)
└── sandbox/
    ├── provider.ts       (SandboxProvider interface + DaytonaSandboxProvider with rsync sync)
    ├── manager.ts        (SandboxManager: getOrCreate with per-worktree lock, destroy)
    └── setup.ts          (setupSandboxOpenCode one-time + uploadSandboxAuth per-prompt)
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

- `sandbox-coder "implement auth fix"` → new task (create sandbox, sync, run agent, sync back)
- `sandbox-coder --session <id> "implement auth fix"` → continue existing opencode session
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
     - `create(opts: { image?, snapshot?, labels, envVars?, autoStopInterval? })` → sandbox ID
     - `destroy(sandboxId: string)` → void
     - `list(labels: Record<string, string>)` → SandboxInfo[]
     - `uploadFile(sandboxId: string, remotePath: string, data: Buffer)` → void
     - `executeCommand(sandboxId: string, command: string, cwd?: string)` → { exitCode, result }
     - `syncIn(sandboxId: string, worktreePath: string)` → void (rsync over SSH)
     - `syncOut(sandboxId: string, worktreePath: string)` → SyncOutResult
     - `runAgentStreaming(sandboxId, command, cwd, onData)` → AgentStreamResult
   - `DaytonaSandboxProvider` class implementing the interface via `@daytonaio/sdk`
   - Internal caches: sandbox instances, SSH credentials (with 5-min refresh buffer), synced-sandbox set

3. Create `packages/remote-cli/src/sandbox/manager.ts`:
   - `SandboxManager` class:
     - `creating: Map<string, Promise<string>>` — per-worktree lock for in-flight creations (D9)
     - `getOrCreate(cwd: string)` — query remote API for existing sandbox, or await existing creation, or create new
     - `find(cwd: string)` — query provider.list by labels, return first match or undefined
     - `destroy(cwd: string)` — find sandbox by worktree, call provider.destroy (non-fatal errors)
   - No in-memory sandbox cache — always queries Daytona API (D16)
   - Labels on creation: `{ "thor": "true", "worktree": cwd }`
   - Snapshot: configurable via `SANDBOX_SNAPSHOT` env (default: `"daytona-medium"`)

4. Create `packages/remote-cli/src/sandbox/setup.ts`:
   - `setupSandboxOpenCode(provider, sandboxId)` — one-time per sandbox: fix stale binaries, install pinned opencode-ai@1.2.27, configure git identity, upload opencode.json config
   - `uploadSandboxAuth(provider, sandboxId)` — every prompt: read auth.json, strip refresh fields recursively, upload to sandbox

5. Add sandbox destroy hook to existing `POST /exec/git` route:
   - After `git worktree remove` succeeds, call `sandboxManager.destroy(cwd)` for the removed path

**Tests** (Phase 2):

- getOrCreate: creates when none exists, returns existing on second call
- getOrCreate: concurrent calls for same worktree → only one provider.create call (D9 lock test)
- getOrCreate: separate sandboxes per worktree
- find: returns ID when found, undefined when not, handles API errors gracefully
- destroy: finds and destroys sandbox, no-op if not found, handles destroy errors
- setupSandboxOpenCode: installs pinned version, creates dirs, uploads config, skips repeat
- uploadSandboxAuth: strips refresh fields recursively, doesn't throw if auth.json missing
- All tests use a mock SandboxProvider (no Daytona calls)

**Exit criteria**:

- SandboxManager creates and destroys sandboxes via provider interface
- Concurrent getOrCreate calls don't create duplicates
- `git worktree remove` destroys the associated sandbox

---

## Phase 3 — Source sync (rsync over SSH)

**Goal**: Worktree state is faithfully transferred to and from the sandbox via rsync.

Steps:

1. Sync is implemented as `DaytonaSandboxProvider` methods (D32 — sync is a provider concern):

2. `syncIn(sandboxId, worktreePath)`:
   - First call: create target directory (`mkdir -p /home/daytona/src`)
   - Run `rsync -azq --delete --filter=':- .gitignore' --exclude .git` over SSH (D27, D28)
   - First call: initialize standalone git repo: `git init && git add -A && git commit -m sync` (D31)
   - Subsequent calls: rsync handles incremental diffs natively (D15)
   - SSH credentials from `sandbox.createSshAccess(60)`, cached with 5-min refresh buffer (D30)

3. `syncOut(sandboxId, worktreePath)`:
   - Count changes via `git diff --name-only HEAD` + `git ls-files --others` in sandbox (for reporting)
   - Count deletions via `git status --porcelain` (lines matching `D ` prefix)
   - Run `rsync -azq --delete --exclude .git` from sandbox to worktree (D29)
   - Return `SyncOutResult { filesChanged, filesDeleted }` for NDJSON `[sandbox:done]` event
   - On failure: emit error with sandbox ID for recovery via `--pull`

4. SSH credential management:
   - Parse host from `sshCommand` field (e.g. `ssh <token>@<host>`) — don't hardcode (D33)
   - rsync SSH flags: `StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`, `LogLevel=ERROR`
   - Timeout: 300 seconds per rsync invocation
   - Token redaction in logs for security

**Tests** (Phase 3):

- syncIn: verifies rsync args (filter, exclude .git, delete, SSH flags)
- syncIn: first sync runs git init + commit in sandbox
- syncIn: repeat call skips git init (syncedSandboxes set)
- syncOut: verifies rsync args (exclude .git, no gitignore filter)
- syncOut: counts files via git diff + git status parsing
- SSH credentials: caching, refresh on expiry, host parsing from sshCommand

**Exit criteria**:

- Modified, added, and deleted files round-trip correctly via rsync
- .gitignore respected on syncIn, not on syncOut (D28)
- First syncIn initializes git repo in sandbox
- SSH credentials cached and refreshed automatically

---

## Phase 4 — Sandbox agent execution via Daytona sessions

**Goal**: OpenCode runs inside the Daytona sandbox via sessions, with session continuity support.

Steps:

1. Sandbox base: use `daytona-medium` snapshot (configurable via `SANDBOX_SNAPSHOT` env, D17):
   - Pre-built with Node.js, git, daytona user
   - OpenCode installed at setup time via `npm i -g opencode-ai@1.2.27` (D18)

2. Configure OpenCode inside the sandbox (via setup.ts):
   - No MCP servers (execution-only, no external tools)
   - `"permission": "allow"` for file and bash tools
   - Working directory: `/home/daytona/src`
   - Auth credentials uploaded fresh before every prompt (refresh fields stripped, D19)

3. Implement agent execution via `runAgentStreaming` in DaytonaSandboxProvider:
   - Create async session with ID format `agent-<timestamp>`
   - Wrap command: `cd /home/daytona/src && <command> </dev/null` (D22)
   - `sandbox.process.executeSessionCommand(sessionId, { command, runAsync: true })` → command ID
   - Stream via `sandbox.process.getSessionCommandLogs(sessionId, cmdId, onStdout, onStderr)`
   - Buffer stdout line-by-line, parse JSON events, extract `sessionID` field for continuity
   - Non-JSON output captured as stderr diagnostics
   - Get real exit code via `sandbox.process.getSessionCommand(sessionId, cmdId)`
   - Best-effort session cleanup via `sandbox.process.deleteSession(sessionId)`

4. Route handler builds command: `opencode run --format json --model <SANDBOX_MODEL> [--session <id>] '<prompt>'`
   - Model configurable via `SANDBOX_MODEL` env (default: `openai/gpt-5.3-codex-spark`)
   - `--session <id>` flag enables opencode session continuity (D21)

5. Implement `--pull <sandbox-id>` subcommand:
   - Skip everything, just run syncOut for the given sandbox

6. Handle completion:
   - Agent exits 0 → emit `[sandbox:done] files_changed=N files_deleted=N`
   - Agent exits non-zero → emit `[sandbox:error]` + `[sandbox:stderr]` with last 20 lines, still syncOut
   - OpenCode session ID emitted as `[sandbox:opencode_session] <id>` for follow-up `--session` calls

**Tests** (Phase 4):

- Agent execution streams NDJSON with phase events and opencode session ID
- --session continues existing opencode session
- --pull triggers syncOut only
- Agent exit 0 → done event with file counts
- Agent exit non-zero → error event with stderr tail, still syncs out

**Exit criteria**:

- OpenCode runs inside a Daytona sandbox and can edit files
- OpenCode can run `npm test` (or equivalent) inside the sandbox
- Agent output streams back to the caller as NDJSON with `[sandbox:*]` events
- OpenCode session ID emitted for `--session` continuity
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

3. Verify session continuity and file recovery:
   - Run `sandbox-coder` task, note the `[sandbox:opencode_session]` ID
   - Run `sandbox-coder --session <id> "continue work"` to resume in same opencode session
   - Run `sandbox-coder --pull <sandbox-id>` to recover files from sandbox

4. Verify cleanup:
   - Run `git worktree remove`
   - Confirm Daytona sandbox is destroyed

5. Verify failure:
   - Run `sandbox-coder` from `/workspace/repos` (not a worktree) → exit 2
   - Kill the Daytona sandbox mid-execution → agent sees error, exits 2
   - Give an impossible task → agent exits 1

**Exit criteria**:

- End-to-end flow produces a working PR from a Slack-triggered coding task
- Sandbox reuse works
- --session continuity and --pull recovery work
- Cleanup works (worktree remove destroys sandbox)
- Failure modes produce clear errors with sandbox IDs and stderr tail

## Out of Scope

- Preview URLs (Phase B in evaluation plan)
- Multi-sandbox per worktree (Phase C in evaluation plan)
- Sandbox cost tracking (see TODOS)
- Sandbox telemetry/observability beyond NDJSON output
