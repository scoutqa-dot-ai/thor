# Plan — 2026032001_rsync-sandbox-sync

> Replace tar-based sandbox file sync with rsync over Daytona SSH access.

## Problem

The original sync design used a multi-step tar dance:

- **syncIn full**: spawn local `tar -czf` → upload blob → shell `tar -xzf` + `rm` + `git init` + `git commit`
- **syncIn partial**: git-diff locally → spawn `tar` for changed files → upload → shell extract + rm + git commit
- **syncOut**: 3 remote git commands to detect changes → N serial `downloadFile()` calls → manual `rm` for deletes

This was fragile (binary buffer encoding, 256MB maxBuffer, multi-step shell pipelines) and complex (git-diff state tracking, 6 helper functions).

## Solution (Implemented)

Uses `rsync` over Daytona's SSH access. The SDK provides `sandbox.createSshAccess(minutes)` which returns `{ token, sshCommand, expiresAt }`. rsync natively handles incremental diffs, deletions, and .gitignore filtering.

The sync is implemented as two `DaytonaSandboxProvider` methods:

```bash
# syncIn: worktree → sandbox
rsync -azq --delete --filter=':- .gitignore' --exclude .git \
  -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
  <worktree>/ <token>@<host>:/home/daytona/src/

# syncOut: sandbox → worktree
rsync -azq --delete --exclude .git \
  -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
  <token>@<host>:/home/daytona/src/ <worktree>/
```

SSH host is parsed from `sshCommand` field (D33), not hardcoded. Timeout: 300 seconds per rsync. Tokens redacted in logs.

## Decision Log

| #   | Decision                                               | Rationale                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D27 | Replace tar sync with rsync over Daytona SSH           | Eliminates tar child process, binary buffer hacks, 256MB maxBuffer, remote shell extraction, git-diff state tracking. rsync handles incremental diffs, deletions, and permissions natively. ✅ Implemented.                                                                                             |
| D28 | Use `--filter=':- .gitignore'` on syncIn only          | Respects .gitignore when pushing to sandbox. On syncOut, we want everything the agent created (even if it would be gitignored locally — e.g. build artifacts the agent references). ✅ Implemented.                                                                                                     |
| D29 | Use `--delete` flag both directions                    | rsync natively handles file deletions. Removes need for manual `rm` commands and `parseDeletedFiles` helper. ✅ Implemented.                                                                                                                                                                            |
| D30 | SSH token managed per-sandbox, refreshed on expiry     | `createSshAccess(60)` gives a 60-min token. Cached in `sshCache` Map. Refreshed if expiring within 5 minutes. ✅ Implemented.                                                                                                                                                                           |
| D31 | Keep `git init + commit` in sandbox after first syncIn | The sandbox still needs a git repo for the agent (opencode) to work with. Run via `executeCommand` after the first rsync. Tracked in `syncedSandboxes` Set. ✅ Implemented.                                                                                                                             |
| D32 | Sync logic is Daytona-specific, on SandboxProvider     | rsync + SSH is an implementation detail of the Daytona provider. `syncIn`/`syncOut` are methods on `DaytonaSandboxProvider`. The `SandboxProvider` interface has `syncIn`/`syncOut` as abstract methods — each provider implements sync however it wants. No standalone `sync.ts` file. ✅ Implemented. |
| D33 | Parse SSH host from `sshCommand` field, don't hardcode | Regex `/@(.+)$/` extracts host from `sshCommand`. Throws if parsing fails. ✅ Implemented.                                                                                                                                                                                                              |
| D34 | `downloadFile` removed from provider interface         | No longer needed — sync uses rsync, not individual file downloads. `uploadFile` kept for auth/config upload in setup.ts. ✅ Implemented.                                                                                                                                                                |

## Out of Scope

- Changing the agent execution flow (PTY streaming stays as-is)
- Removing `executeCommand` from provider (still used for setup, git init, etc.)
- Changing the sandbox lifecycle (create, destroy, labels)

## Phases (All Complete)

### Phase 1 — Add `syncIn`/`syncOut` to provider interface, implement rsync in Daytona provider ✅

**Implemented:**

- `syncIn(sandboxId, worktreePath)` and `syncOut(sandboxId, worktreePath)` on `SandboxProvider` interface
- `DaytonaSandboxProvider` implementation:
  - `syncIn`: `rsync -azq --delete --filter=':- .gitignore' --exclude .git` via SSH
  - `syncOut`: `rsync -azq --delete --exclude .git` via SSH, plus git diff/status for file counting
  - SSH credentials cached in `sshCache` Map, refreshed if expiring within 5 minutes
  - First syncIn: `mkdir -p` + rsync + `git init && git add -A && git commit -m sync --allow-empty`
  - SSH host parsed from `sshCommand` via regex `/@(.+)$/`
  - rsync timeout: 300 seconds, SSH flags: `StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`, `LogLevel=ERROR`
- No standalone `sync.ts` — sync logic lives in `provider.ts`

### Phase 2 — Update callers and tests ✅

**Implemented:**

- `index.ts` calls `sandboxProvider.syncIn()` / `sandboxProvider.syncOut()` directly
- `provider.test.ts` tests rsync behavior:
  - Mocks `execFile` to verify rsync args (filter, exclude, delete, SSH flags)
  - Tests: first syncIn runs git init, repeat skips, mkdir creation, gitignore filter
  - Tests: syncOut rsync args, file counting via git diff + git status parsing
  - Tests: SSH credential caching, refresh on expiration, host parsing, parse failures
- No old `sync.ts` or `sync.test.ts` — all replaced

### Phase 3 — Clean up provider interface ✅

**Implemented:**

- `downloadFile` removed from `SandboxProvider` interface (not needed — sync uses rsync)
- `uploadFile` kept — used by `setup.ts` for uploading auth.json and opencode.json config
- No dead code from old tar sync remains
