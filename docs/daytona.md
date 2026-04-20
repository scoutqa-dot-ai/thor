# Daytona

Thor runs project commands (builds, tests, lints) in [Daytona](https://daytona.io) cloud sandboxes via the `sandbox` command. Sandboxes are created on demand, keep your committed and uncommitted code in sync, and stop automatically when idle.

This doc covers how the integration works, how to configure it, and how admins publish and register a custom sandbox image.

## How it works

Each worktree gets its own isolated sandbox. The first `sandbox` call in a worktree creates it; subsequent calls reuse it.

1. **Create.** `sandbox <cmd>` in a worktree with no existing sandbox provisions one from a Daytona snapshot, uploads the repo as a git bundle, and checks out `HEAD` at `/workspace/sandbox`.
2. **Sync (before exec).** Uncommitted changes in the worktree are uploaded as an overlay. If > 100 files are dirty the sync is refused — commit, stash, or `.gitignore`.
3. **Exec.** The command runs via a Daytona session. Stdout/stderr stream back in real time.
4. **Sync (after exec).** On exit code 0, any files the command created or modified inside the sandbox are pulled back to the worktree. Non-zero exits skip the pull — nothing is partially synced.
5. **Auto-stop.** Sandboxes stop after 15 minutes idle. Re-running `sandbox <cmd>` wakes them up; delta-only sync means wake-up is fast.

`git` is blocked inside the sandbox — git state lives on the host. Everything else (internet, `apt-get`, `npm install`, `pip install`, Docker-in-Docker) works.

See `docker/opencode/config/skills/sandbox/SKILL.md` for the agent-facing reference.

## Configuration

Environment variables (set in `.env`; passed through by `docker-compose.yml`):

| Variable           | Required | Default                      | Purpose                                                                |
| ------------------ | -------- | ---------------------------- | ---------------------------------------------------------------------- |
| `DAYTONA_API_KEY`  | yes      | —                            | API key from the Daytona dashboard. Needs sandbox create/delete scope. |
| `DAYTONA_API_URL`  | no       | `https://app.daytona.io/api` | Override for self-hosted Daytona.                                      |
| `DAYTONA_SNAPSHOT` | no       | `daytona-medium`             | Snapshot name sandboxes launch from. Set this to use a custom image.   |

The default snapshot `daytona-medium` is a generic Daytona image. It's sufficient for Node projects but lacks Java, Python, Maven, Gradle, and Docker. For polyglot projects, see **Custom snapshot** below.

## Developer setup

1. Get an API key from https://app.daytona.io.
2. Add it to your `.env`:
   ```
   DAYTONA_API_KEY=daytona_...
   ```
3. `docker compose up` (or restart `remote-cli` if already running) so the env var reaches the service.

That's it — the first `sandbox <cmd>` in any worktree will provision a sandbox.

## Custom snapshot (admin)

For full polyglot runtime support (Node, Java, Python, Docker, `uv`), use the custom image defined in `docker/sandbox/Dockerfile`. It preinstalls nvm, SDKMAN, pyenv, Docker CE, and common runtime versions.

### Build + publish the image

CI does this automatically:

- **Workflow:** `.github/workflows/sandbox-image.yml`
- **Trigger:** push to `docker/sandbox/**` or the workflow file itself, or manual `workflow_dispatch`.
- **Output:** image pushed to `ghcr.io/scoutqa-dot-ai/thor-sandbox`, tagged with the long commit SHA and `latest` (on the default branch).

The workflow uses the built-in `GITHUB_TOKEN` to push; no secrets are required.

**First-time only:** the package is private on first push. Toggle it to public once in the [package settings](https://github.com/orgs/scoutqa-dot-ai/packages/container/thor-sandbox/settings), or register a pull credential with Daytona if you prefer to keep it private. After that, subsequent pushes keep the visibility.

### Register the snapshot with Daytona

Once the image is published, create a snapshot in Daytona that points to it:

1. Open the Daytona dashboard → **Snapshots** → **Create snapshot**.
2. Source: **Container registry**.
3. Image: `ghcr.io/scoutqa-dot-ai/thor-sandbox:latest` (or pin to a specific `:<sha>`).
4. Name: `thor-sandbox` (or whatever you'll set `DAYTONA_SNAPSHOT` to).
5. Resources: 4 CPU / 8 GiB RAM / 10 GiB disk is a good starting point.
6. Save and wait for the snapshot to reach `Ready`.

### Point sandboxes at the custom snapshot

Set the env var in `.env`:

```
DAYTONA_SNAPSHOT=thor-sandbox
```

Restart the `remote-cli` service. New sandboxes will launch from the custom snapshot; existing sandboxes keep whichever snapshot they were created from — delete them (`sandbox --list`, then delete in the Daytona UI) if you want them to be recreated from the new snapshot.

### Updating the image

1. Edit `docker/sandbox/Dockerfile`, commit, push.
2. The workflow publishes a new `:latest` and `:<sha>` tag to GHCR.
3. In Daytona, update the snapshot to the new tag (or create a new snapshot and switch `DAYTONA_SNAPSHOT`).

Pinning `DAYTONA_SNAPSHOT` to a snapshot built from a specific `:<sha>` tag gives you reproducible sandbox environments across teams.

## Troubleshooting

| Symptom                                      | Likely cause                            | Fix                                                                         |
| -------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `Sandbox auth failed, check DAYTONA_API_KEY` | Env var not set or empty                | Set `DAYTONA_API_KEY` in `.env`, restart `remote-cli`.                      |
| `Sandbox service unavailable`                | Daytona API transient failure           | Retry in a few minutes.                                                     |
| `Sandbox creation timed out`                 | Daytona provisioning slow               | Retry. Next call creates a fresh sandbox.                                   |
| `java: command not found` (or similar)       | Using `daytona-medium`, missing runtime | Publish the custom image (above) and set `DAYTONA_SNAPSHOT`.                |
| `File "…" is NNN MB, exceeding 100 MB`       | Large artifact in dirty worktree        | Commit, `.gitignore`, or remove the file before running `sandbox`.          |
| `… exceeds the 100-file sync limit`          | Too many dirty files                    | Commit or clean up the worktree; the sync refuses to guess what to include. |

To inspect or clean up sandboxes directly, use the Daytona dashboard or the `@daytonaio/sdk` (e.g. via `scripts/test-dind-compose.ts`).
