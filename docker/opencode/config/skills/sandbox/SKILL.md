---
name: sandbox
description: Run project commands (build, test, lint) in a cloud sandbox with common runtimes and on-demand toolchains.
---

## When to use

Use `sandbox` to run project commands: builds, tests, lints, and anything that needs runtimes not available locally (Java, Python, etc.). The sandbox auto-creates on first use, syncs your committed code, and stops automatically when idle.

For technical browser orchestration guidance — choosing between `agent-browser`, headed browser capture, verification, and artifact patterns — use the dedicated `browser` skill. Keep app-specific browser flows in repo runbooks or task prompts.

---

## Usage

```
sandbox <command> [args...]
```

Examples:

```bash
sandbox mvn test -pl module-auth
sandbox ./gradlew build
sandbox bash -c 'make build && make test'
sandbox npm test
```

For a single command, write it naturally: `sandbox mvn test -pl module-auth`.
For shell chaining, pipelines, or redirects, wrap the command explicitly:

```bash
sandbox bash -c 'make build && make test'
sandbox bash -c 'npm run build && npm test'
```

---

## How it works

1. On first run, a cloud sandbox is created and your committed code is synced
2. On subsequent runs, only new commits are synced (delta sync)
3. The command runs inside the sandbox and output streams back in real time
4. Sandbox auto-stops after 15 minutes idle

**Sync is bidirectional.** Before exec, uncommitted local changes are uploaded to the sandbox. After exec, any files the command created or modified are pulled back to your worktree. No need to commit before running. Sync is skipped if more than 100 files are dirty.

---

## Workflow

```bash
cd /workspace/worktrees/myrepo/feat/auth
sandbox mvn test -pl module-auth       # auto-creates sandbox, syncs, runs
# edit code (no need to commit)...
sandbox mvn test -pl module-auth       # syncs uncommitted changes, reuses sandbox
sandbox ./gradlew spotlessCheck        # same sandbox, different command
```

---

## Errors

| Error                         | Cause             | Fix                                        |
| ----------------------------- | ----------------- | ------------------------------------------ |
| "Sandbox service unavailable" | Daytona API down  | Retry in a few minutes                     |
| "Sandbox auth failed"         | Missing API key   | Check DAYTONA_API_KEY configuration        |
| "Sandbox creation timed out"  | Slow provisioning | Retry; sandbox will be created fresh       |
| Nonzero exit code             | Command failed    | Normal test/build failure; read the output |

---

## Pre-installed runtimes

The sandbox image is intentionally slim. Preinstalled by default:

- **Node**: 22 (default), 20 via nvm. pnpm available via corepack.
- **Java**: 21 (default), 17 (Temurin) via SDKMAN. Maven and Gradle included.
- **Python**: 3.12 (default) via pyenv. `uv` available for fast installs.
- **Docker**: Docker CE with docker compose. Start the daemon with `sudo dockerd &` before use.
- **Browser automation/recording**: `agent-browser` with Chrome for Testing preinstalled, plus `ffmpeg`, `xvfb`, `xdotool`, `tree`, and ImageMagick (`identify`, `convert`, `compare`).

Browser examples:

```bash
sandbox agent-browser --session qa open https://example.com
sandbox agent-browser --session qa screenshot /tmp/example.png
sandbox identify /tmp/example.png
sandbox xvfb-run -a agent-browser --session qa open https://example.com --headed
```

Install less-common toolchains on demand per task by running the appropriate
installer inside the sandbox (for example via `nvm`, `pyenv`, `rustup`, or by
downloading a release tarball into `$HOME/.local`). Use `sandbox bash -lc '...'`
to run install commands, then invoke the toolchain the same way.

To use a non-default version, either set it permanently or inline it with your command:

```bash
# Permanent (persists across sandbox calls, only need to set once)
sandbox sdk default java 17.0.18-tem
sandbox mvn test

# Inline (one-off version switch + command)
sandbox bash -c 'sdk use java 17.0.18-tem && mvn test'
sandbox bash -c 'nvm use 20 && npm test'
```

---

## Notes

- Each worktree gets its own isolated sandbox — switching worktrees creates a separate sandbox
- Code is synced to `/workspace/sandbox` inside the sandbox — paths in error output will show this prefix
- First run is slower (sandbox creation + full code sync)
- Subsequent runs reuse the sandbox and sync only new commits
- Sandbox stops automatically after 15 minutes of inactivity
- Multiple `sandbox` commands on the same worktree can run in parallel
- `npm`, `npx`, `pnpm`, `pnpx`, and `corepack` are automatically redirected to the sandbox — no need to prefix with `sandbox`
- `git` is blocked inside the sandbox — git state is not synced back, so use `git` directly instead
- Pull only happens on successful exec (exit code 0) — failed commands do not sync partial artifacts back
