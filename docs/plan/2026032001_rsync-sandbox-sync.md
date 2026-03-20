# Plan — 2026032001_rsync-sandbox-sync

> Replace tar-based sandbox file sync with rsync over Daytona SSH access.

## Problem

The current sync implementation (`packages/remote-cli/src/sandbox/sync.ts`) uses a multi-step tar dance:
- **syncIn full**: spawn local `tar -czf` → upload blob → shell `tar -xzf` + `rm` + `git init` + `git commit`
- **syncIn partial**: git-diff locally → spawn `tar` for changed files → upload → shell extract + rm + git commit
- **syncOut**: 3 remote git commands to detect changes → N serial `downloadFile()` calls → manual `rm` for deletes

This is fragile (binary buffer encoding, 256MB maxBuffer, multi-step shell pipelines) and complex (git-diff state tracking, `syncedSandboxes` Set, 6 helper functions).

## Solution

Use `rsync` over Daytona's SSH access. The SDK provides `sandbox.createSshAccess(minutes)` which returns `{ token, sshCommand }`. rsync natively handles incremental diffs, deletions, and .gitignore filtering.

The entire sync becomes two commands:
```bash
# syncIn: worktree → sandbox
rsync -azq --delete --filter=':- .gitignore' --exclude .git \
  -e "ssh -o StrictHostKeyChecking=no" \
  <worktree>/ <token>@ssh.app.daytona.io:/home/daytona/src/

# syncOut: sandbox → worktree
rsync -azq --delete --exclude .git \
  -e "ssh -o StrictHostKeyChecking=no" \
  <token>@ssh.app.daytona.io:/home/daytona/src/ <worktree>/
```

## Decision Log

| #   | Decision | Rationale |
| --- | -------- | --------- |
| D27 | Replace tar sync with rsync over Daytona SSH | Eliminates tar child process, binary buffer hacks, 256MB maxBuffer, remote shell extraction, git-diff state tracking. rsync handles incremental diffs, deletions, and permissions natively. |
| D28 | Use `--filter=':- .gitignore'` on syncIn only | Respects .gitignore when pushing to sandbox. On syncOut, we want everything the agent created (even if it would be gitignored locally — e.g. build artifacts the agent references). |
| D29 | Use `--delete` flag both directions | rsync natively handles file deletions. Removes need for manual `rm` commands and `parseDeletedFiles` helper. |
| D30 | SSH token managed per-sandbox, refreshed on expiry | `createSshAccess(60)` gives a 60-min token. Store alongside sandbox ID. Refresh if expired before sync. |
| D31 | Keep `git init + commit` in sandbox after first syncIn | The sandbox still needs a git repo for the agent (opencode) to work with. Run via `executeCommand` after the first rsync. |
| D32 | Sync logic is Daytona-specific, not on SandboxProvider | rsync + SSH is an implementation detail of the Daytona provider, not a generic sync abstraction. `syncIn`/`syncOut` move from standalone functions into `DaytonaSandboxProvider` methods. The `SandboxProvider` interface gains `syncIn`/`syncOut` as abstract methods — each provider implements sync however it wants. |
| D33 | Parse SSH host from `sshCommand` field, don't hardcode | `SshAccessDto.sshCommand` contains the full `ssh <token>@<host>` string. Parse host from it to avoid hardcoding `ssh.app.daytona.io`. |
| D34 | Remove `downloadFile` from provider interface if unused | No longer needed for sync. `uploadFile` kept if still used for auth upload in setup.ts. |

## Out of Scope

- Changing the agent execution flow (PTY streaming stays as-is)
- Removing `executeCommand` from provider (still used for setup, git init, etc.)
- Changing the sandbox lifecycle (create, destroy, labels)

## Phases

### Phase 1 — Add `syncIn`/`syncOut` to provider interface, implement rsync in Daytona provider

**Changes:**
- Add `syncIn(sandboxId, worktreePath)` and `syncOut(sandboxId, worktreePath)` to `SandboxProvider` interface
- In `DaytonaSandboxProvider`:
  - Implement `syncIn` using rsync over SSH: `rsync -azq --delete --filter=':- .gitignore' --exclude .git`
  - Implement `syncOut` using rsync over SSH: `rsync -azq --delete --exclude .git`
  - Manage SSH token internally (create on first use, cache, refresh if close to expiry)
  - On first syncIn, run `git init && git add -A && git commit -m sync` after rsync (agent needs a git repo)
  - Parse SSH host from `SshAccessDto.sshCommand`, don't hardcode
- Delete `sync.ts` — all sync logic now lives inside the provider

**Exit criteria:**
- `syncIn`/`syncOut` work as `DaytonaSandboxProvider` methods using rsync
- No tar, no git-diff state tracking, no standalone sync module
- TypeScript compiles cleanly

### Phase 2 — Update callers and tests

**Changes:**
- Update `index.ts` to call `provider.syncIn()` / `provider.syncOut()` instead of importing from sync.ts
- Rewrite `sync.test.ts` → test rsync behavior via the provider
  - Mock `execFile` to verify rsync args (filter, exclude, delete, SSH flags)
  - Test: first syncIn also runs git init in sandbox
  - Test: syncOut calls rsync with correct args
  - Test: SSH token caching and refresh
- Delete old `sync.ts` and `sync.test.ts` if replaced

**Exit criteria:**
- All tests pass (`pnpm test` in `packages/remote-cli`)
- No imports from old sync module

### Phase 3 — Clean up provider interface

**Changes:**
- Audit whether `downloadFile` is still needed anywhere outside sync (check setup.ts, index.ts)
- Remove `downloadFile` from interface if unused
- Remove any dead code from the refactor

**Exit criteria:**
- No dead code related to old tar sync
- TypeScript compiles, tests pass
