# Docker Remote-CLI Access

Expose Docker troubleshooting to agents through Thor's existing `remote-cli` policy gateway while keeping the Docker socket out of OpenCode.

## Goal

Allow agents to use normal Docker CLI spelling for the three troubleshooting commands operators need:

- `docker ps ...`
- `docker logs ...`
- `docker stats ...`

Every other Docker subcommand or global Docker daemon/config selector is denied by `remote-cli` server-side policy. The OpenCode container gets only a `docker` shim that forwards to `remote-cli`; the Docker CLI binary and `/var/run/docker.sock` mount exist only in the `remote-cli` container.

## Scope

**In scope:**

- Add a `remote-cli` `/exec/docker` endpoint and policy validator.
- Add an OpenCode-side `docker` shim so agents type `docker ps`, `docker logs`, and `docker stats` directly.
- Install the real Docker CLI only in the `remote-cli` image.
- Mount `/var/run/docker.sock` only into the `remote-cli` service, with compose wiring for non-root socket access.
- Cover allow/deny behavior, forwarding, streaming behavior, docs, and local verification.

**Out of scope:**

- A new agent-facing wrapper command such as `thor-docker`.
- Mounting the Docker socket or Docker CLI into OpenCode.
- Docker write/debug subcommands (`exec`, `run`, `compose`, `restart`, `inspect`, `cp`, `container ...`, etc.).
- Container name allowlists, per-service ACLs, or daemon-level isolation beyond the three-command policy.

## Current Surfaces Inspected

- `packages/opencode-cli/src/remote-cli.ts` — generic HTTP shim used by OpenCode command wrappers; already supports JSON and NDJSON streaming responses.
- `docker/opencode/bin/git`, `docker/opencode/bin/gh`, and similar shims — precedent for preserving normal CLI command names while enforcing policy remotely.
- `packages/remote-cli/src/index.ts` — existing `/exec/*` route registration, policy checks, logging, buffered and NDJSON execution patterns.
- `packages/remote-cli/src/policy.ts` and `policy.test.ts` — inline validators for smaller CLI surfaces.
- `packages/remote-cli/src/exec.ts` — buffered `execCommand` and streaming `execCommandStream` helpers.
- `Dockerfile` — OpenCode receives only shims; `remote-cli-tools` is the right layer for real host-side CLIs.
- `docker-compose.yml` — `remote-cli` already owns CLI integration mounts; `opencode` mounts stay limited to workspace/config/tmp data.
- `README.md` and `docs/feat/security-model.md` — top-level integration and policy docs to update.

## Proposed Design

### Agent-facing command path

1. Agent runs `docker ps`, `docker logs`, or `docker stats` in OpenCode.
2. `/usr/local/bin/docker` in the OpenCode image is a tiny shim: `exec node /usr/local/bin/remote-cli.mjs docker "$@"`.
3. The shim posts `{ args, cwd }` to `remote-cli` `POST /exec/docker`, carrying the existing Thor session/call headers.
4. `remote-cli` validates `args`, then runs the real Docker CLI from its own image against its own `/var/run/docker.sock` mount.

This keeps normal Docker CLI syntax at the shell while making OpenCode's binary untrusted convenience plumbing, not an enforcement point.

### Server-side policy

Add `validateDockerArgs(args: string[]): string | null` in `packages/remote-cli/src/policy.ts` and export it.

Rules:

- `args` must be a non-empty string array.
- `args[0]` must be exactly one of `ps`, `logs`, or `stats`.
- Deny all other first tokens, including `compose`, `container`, `inspect`, `exec`, `run`, `restart`, `cp`, `system`, and global flag forms like `--host`, `-H`, `--context`, or `--config` before the subcommand.
- Deny Docker daemon/config selection flags anywhere they appear (`--host`, `-H`, `--context`, `--config`, `--tls`, `--tlscacert`, `--tlscert`, `--tlskey`, `--tlsverify`) so allowed commands cannot target another daemon or config directory.
- Otherwise pass through the subcommand's normal flags and positionals. The subcommand allowlist is the safety boundary; `ps`, `logs`, and `stats` are read-only Docker troubleshooting surfaces.

Policy denial text should be direct and command-specific, for example: `"docker exec" is not allowed — only docker ps, docker logs, and docker stats are permitted`.

### Execution behavior

Add `app.post("/exec/docker", ...)` in `packages/remote-cli/src/index.ts` near the other CLI routes.

- Validate with `validateDockerArgs` before spawning anything.
- Log `exec_docker` with subcommand, argument count, and Thor ids; avoid logging full `docker logs` filters only if they may include sensitive values. Container names are acceptable operational metadata.
- Run with cwd `/workspace` and the real binary name `docker`.
- Prefer an NDJSON streaming response, using the same response format already consumed by `remote-cli.mjs`, because `docker logs -f` and plain `docker stats` are streaming CLI shapes. Extend `execCommandStream` or add a sibling helper so the child process is killed when the HTTP client disconnects.
- Keep policy errors as non-streaming JSON `ExecResult` responses, matching the existing wrapper behavior for denied calls.

### Compose and image wiring

- `Dockerfile`:
  - Add the real Docker CLI to the `remote-cli-tools` stage only. Prefer a CLI-only install path if available (`docker-ce-cli` from Docker's apt repository or an official static CLI tarball); do not install or start a Docker daemon in the container.
  - Copy a new `docker/opencode/bin/docker` shim only into the `opencode` target. Do not install the real Docker CLI in the OpenCode target.
- `docker-compose.yml`:
  - Add `/var/run/docker.sock:/var/run/docker.sock` only under `services.remote-cli.volumes`.
  - Add `group_add: ["${DOCKER_SOCKET_GID:-0}"]` to `remote-cli` so the non-root `thor` user can read the host socket when operators set the socket group id.
  - Do not add the socket mount or group to `opencode`, `runner`, `gateway`, or any other service.
- `.env.example` and README deployment docs:
  - Document optional `DOCKER_SOCKET_GID` and the setup command: `DOCKER_SOCKET_GID=$(stat -c %g /var/run/docker.sock)`.
  - Explain that the default `0` only works on hosts whose socket is root-group accessible.

## Phases

### Phase 1 — Policy and route

**Changes:**

- Add `validateDockerArgs` and policy unit cases to `packages/remote-cli/src/policy.ts` / `policy.test.ts`.
- Add `/exec/docker` route in `packages/remote-cli/src/index.ts`.
- Add route tests that mock the exec layer and prove:
  - `ps`, `logs`, and `stats` reach `docker` with the original args.
  - denied subcommands do not call the exec layer.
  - global daemon/config flags are denied.
  - streaming calls emit stdout/stderr/exit NDJSON.

**Exit criteria:**

- `pnpm test packages/remote-cli/src/policy.test.ts`
- Targeted route test command for the new Docker route.

### Phase 2 — Wrapper and container wiring

**Changes:**

- Add `docker/opencode/bin/docker` shim forwarding to `remote-cli.mjs docker`.
- Update `Dockerfile` so only OpenCode gets the shim and only `remote-cli` gets the real Docker CLI.
- Update `docker-compose.yml` remote-cli socket mount and `group_add`.
- Update `.env.example` for `DOCKER_SOCKET_GID`.

**Exit criteria:**

- `pnpm build`
- `docker compose build opencode remote-cli`
- `docker compose config` shows the Docker socket mount only under `remote-cli`.

### Phase 3 — Docs and agent guidance

**Changes:**

- Update `README.md` integration table, deployment configuration, and operations notes.
- Update `docs/feat/security-model.md` command-policy and blast-radius sections to call out Docker's special socket risk and the three-command allowlist.
- Add a small `docker/opencode/config/skills/docker/SKILL.md` if useful for discoverability, written positively and without restating internal env var details: supported forms are `docker ps`, `docker logs`, and `docker stats`; use denial responses as the authority for unsupported flags/subcommands.

**Exit criteria:**

- Docs explain that the Docker socket is mounted only in `remote-cli`, not OpenCode.
- No docs introduce a new command name.

### Phase 4 — Integration verification

**Changes:**

- Bring up the stack and exercise the real path from OpenCode shim to `remote-cli` to host Docker.
- Confirm forbidden subcommands fail before the Docker CLI runs.

**Verification commands:**

```bash
pnpm test
pnpm typecheck
docker compose up --build -d remote-cli opencode
docker compose exec opencode docker ps
docker compose exec opencode docker logs --tail 20 remote-cli
docker compose exec opencode docker stats --no-stream remote-cli
docker compose exec opencode docker inspect remote-cli # expected denial
docker compose exec opencode test ! -S /var/run/docker.sock
docker compose exec remote-cli test -S /var/run/docker.sock
```

**Exit criteria:**

- Allowed commands return real Docker output through the OpenCode shim.
- Denied commands return policy errors and do not execute Docker.
- The Docker socket is absent from OpenCode and present in remote-cli.

## Decision Log

| Date       | Decision                                                                 | Rationale                                                                                                              | Alternatives considered                                  |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 2026-05-31 | Preserve normal `docker ...` spelling by adding an OpenCode `docker` shim | The approved product shape says no new wrapper command; existing Thor CLI integrations already use command-name shims. | A `thor-docker` command, rejected by product direction.  |
| 2026-05-31 | Mount `/var/run/docker.sock` only into `remote-cli`                       | Policy enforcement and real credentials/resources belong in `remote-cli`; OpenCode wrappers are untrusted convenience. | Mounting the socket in OpenCode and relying on wrappers. |
| 2026-05-31 | Stream Docker execution responses                                         | `docker logs -f` and default `docker stats` are legitimate Docker CLI forms that can run until interrupted.             | Buffered `execFile`, which would hang on streaming forms. |
| 2026-05-31 | Deny Docker daemon/config selector flags                                  | Even allowed read-only subcommands should not be able to choose another daemon or client config.                        | Allow all global Docker CLI syntax.                      |

## Open Questions / Risks

- Docker socket access is powerful if `remote-cli` itself is compromised; this feature relies on the existing `remote-cli` trust boundary and a narrow HTTP policy, not daemon-level authorization.
- Socket permissions vary by host. Operators may need to set `DOCKER_SOCKET_GID` from `stat -c %g /var/run/docker.sock` before compose starts.
- `docker logs` can expose service secrets if applications print them. The command is intentionally allowed for troubleshooting, but docs should remind operators to avoid logging secrets.
