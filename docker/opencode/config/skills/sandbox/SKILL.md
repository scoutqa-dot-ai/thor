---
name: sandbox
description: Run project commands (build, test, lint) in a cloud sandbox with full language runtimes.
---

## When to use

Use `sandbox` to run project commands: builds, tests, lints, and anything that needs runtimes not available locally (Java, Python, Go, etc.). The sandbox auto-creates on first use, syncs your committed code, and stops automatically when idle.

---

## Usage

```
sandbox <command> [args...]
```

Examples:

```bash
sandbox mvn test -pl module-auth
sandbox ./gradlew build
sandbox pytest -v --tb=short
sandbox make build && make test
sandbox npm test
```

No quoting needed. Shell metacharacters (`&&`, `|`, `;`) work naturally.

---

## How it works

1. On first run, a cloud sandbox is created and your committed code is synced
2. On subsequent runs, only new commits are synced (delta sync)
3. The command runs inside the sandbox and output streams back in real time
4. Sandbox auto-stops after 15 minutes idle

**Uncommitted changes are synced automatically.** The sandbox creates a temporary commit, syncs it, then undoes the commit locally. Your working tree is unchanged. No need to commit before running.

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

## Notes

- Sandbox has internet access (`pip install`, `npm install`, `apt-get` all work)
- First run is slower (sandbox creation + full code sync)
- Subsequent runs reuse the sandbox and sync only new commits
- Sandbox stops automatically after 15 minutes of inactivity
