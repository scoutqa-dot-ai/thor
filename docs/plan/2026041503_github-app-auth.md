# GitHub App Auth via Thor `git` / `gh` Wrappers

**Date**: 2026-04-15
**Status**: Draft

## Goal

Replace the current static `GITHUB_PAT` auth model for `git` / `gh` in `remote-cli` with Thor-owned wrapper binaries that:

- support multiple GitHub org installations from one `remote-cli` instance
- read installation definitions from `/workspace/config.json` under `github_app.installations`
- cache installation tokens by org login for simplicity
- let an admin `docker exec` into the `remote-cli` container and use `git` / `gh` as usual
- keep policy enforcement in place for all OpenCode-triggered `git` / `gh` commands
- store GitHub App auth material in a dedicated mounted path inside `remote-cli`

## Why

- GitHub App installation tokens are short-lived and installation-scoped; a container-global `GH_TOKEN` set once at startup is the wrong lifecycle model.
- Thor may need to act across more than one org installation with the same app.
- The repo already standardizes on workspace-wide dynamic config via `/workspace/config.json`; GitHub App installation mapping should follow the same pattern.
- A wrapper-first design gives one auth path for both admin shell usage and the policy-gated server path.
- The agent path still needs cwd validation and command allowlists in the `remote-cli` HTTP layer.

## Architecture

### Runtime flow

```text
OpenCode gh/git wrapper
  -> POST /exec/gh or /exec/git
    -> policy validation
    -> exec Thor gh/git wrapper
      -> resolve target org
      -> read github_app.installations from config.json
      -> read/update org token cache
      -> mint/refresh installation token if needed
      -> exec real gh/git binary with auth env
```

### Admin flow

```text
human operator
  -> docker exec remote-cli sh
    -> run git / gh as usual
      -> Thor gh/git wrapper
      -> resolve target org
      -> read github_app.installations from config.json
      -> read/update org token cache
      -> exec real gh/git binary with auth env
```

The policy boundary stays in the `remote-cli` HTTP server. Direct shell usage inside the trusted `remote-cli` container bypasses that policy by design.

## Key Design Constraint

Because the Thor `git` / `gh` wrappers run as separate processes, token caching cannot live only in memory. To share cached tokens across:

- repeated admin shell commands
- repeated `/exec/git` and `/exec/gh` requests
- concurrent wrapper invocations

the cache needs to be disk-backed inside the `remote-cli` container.

Use a dedicated mount path for GitHub App auth state:

- container path: `/var/lib/remote-cli/github-app`
- private key file: `/var/lib/remote-cli/github-app/private-key.pem`
- token cache directory: `/var/lib/remote-cli/github-app/cache/`

This keeps the auth material separate from `/workspace` and `/home/thor`, and gives one obvious place for operators to inspect during `docker exec` troubleshooting.

### Config shape

Store GitHub App installation config in `/workspace/config.json` under a root key `github_app`:

```json
{
  "github_app": {
    "installations": [
      {
        "org": "acme",
        "installation_id": 12345678,
        "app_id": "",
        "private_key_path": "",
        "api_url": ""
      }
    ]
  }
}
```

Field behavior:

- `org` — required; used as the cache key and target resolution key
- `installation_id` — required; explicit install mapping for the org
- `app_id` — optional; if empty, fall back to `GITHUB_APP_ID`
- `private_key_path` — optional; if empty, fall back to `GITHUB_APP_PRIVATE_KEY_FILE`, then to `/var/lib/remote-cli/github-app/private-key.pem`
- `api_url` — optional; if empty, fall back to `GITHUB_API_URL`, then to `https://api.github.com`

## Phases

### Phase 1 — Thor wrapper binaries + GitHub App auth cache

Implement Thor-owned `git` / `gh` wrapper binaries as the primary auth surface inside the `remote-cli` image.

1. Add GitHub App config for `remote-cli`
   - extend workspace config schema with `github_app.installations`
   - read config from the existing `/workspace/config.json`
   - support env/default fallback only when `app_id` or `private_key_path` in an installation entry are empty
   - `GITHUB_APP_PRIVATE_KEY_FILE` still defaults to `/var/lib/remote-cli/github-app/private-key.pem`
   - optional `GITHUB_API_URL` still defaults to `https://api.github.com`
   - fixed cache root under `/var/lib/remote-cli/github-app/cache`
2. Add shared auth code in `packages/remote-cli/src/`
   - load `github_app.installations` via the workspace config loader
   - resolve installation config by org from `config.json`
   - generate app JWT from the resolved private key path
   - mint installation token via `POST /app/installations/{installation_id}/access_tokens`
3. Add Thor wrapper binaries under `packages/remote-cli/bin/`
   - `git`
   - `gh`
4. Wrapper behavior
   - resolve target org from command args or repository remote
   - look up the matching installation entry in `config.json`
   - read/update a disk-backed cache keyed by org login
   - refresh early before expiry
   - deduplicate concurrent refreshes with a simple lock strategy
   - exec the real `git` / `gh` binary with the correct auth env
5. Update the `remote-cli` image so admin shells use the Thor wrappers by default
   - prepend wrapper location to `PATH`
   - keep real binaries reachable by absolute path to avoid recursion
   - ensure `/var/lib/remote-cli/github-app` exists with appropriate permissions
6. Add tests
   - workspace config schema validation for `github_app.installations`
   - empty `app_id` / `private_key_path` fallback behavior
   - org resolution from `-R owner/repo`
   - org resolution from Git remotes in HTTPS and SSH form
   - cache hit vs miss
   - early refresh behavior
   - concurrent refresh coordination
   - clear failures for ambiguous or unsupported targets

**Exit criteria:**

- [ ] An admin can `docker exec -it ... sh` into `remote-cli` and run `gh` successfully against an installed org
- [ ] An admin can `docker exec -it ... sh` into `remote-cli` and run `git` successfully in a mounted GitHub repo checkout
- [ ] Installation tokens are cached by org login on disk with restricted file permissions
- [ ] Private key and cache files live under the dedicated `/var/lib/remote-cli/github-app` mount path
- [ ] Installation lookup comes from `config.json` under `github_app.installations`
- [ ] Empty `app_id` / `private_key_path` fields correctly fall back to env/default values
- [ ] Missing or invalid app config fails with explicit error messages
- [ ] Wrapper recursion is avoided and the real `git` / `gh` binaries are still callable directly

### Phase 2 — Make the `remote-cli` server execute Thor wrappers under existing policy

Reuse the wrapper binaries for OpenCode-triggered commands while preserving the current HTTP policy layer.

1. Keep policy ordering unchanged in `remote-cli`
   - validate `cwd`
   - validate command args
   - only then execute the Thor wrapper binary
2. Update command execution paths
   - make `/exec/git` and `/exec/gh` execute the Thor wrappers instead of relying on container-global `GH_TOKEN`
   - use explicit wrapper paths if needed to avoid PATH ambiguity
3. Remove static PAT assumptions from startup/auth wiring
   - no requirement for container-global `GH_TOKEN` when GitHub App auth is enabled
   - keep temporary PAT fallback only if needed for rollout
4. Add tests
   - policy-rejected commands never reach the wrapper
   - two orgs from `config.json` can be served by one `remote-cli` instance
   - retry once on auth failure consistent with token expiry by invalidating cache and re-running
5. Update compose/config/docs
   - update `docker-compose.yml`
   - mount a dedicated host path into `/var/lib/remote-cli/github-app`
   - update `.env.example`
   - document `github_app.installations` in `config.json`
   - update `README.md`
   - document admin `docker exec` workflow and GitHub App config

**Exit criteria:**

- [ ] OpenCode-triggered `gh` commands still go through existing policy checks before execution
- [ ] OpenCode-triggered `git` commands still go through existing policy checks before execution
- [ ] `remote-cli` can serve commands for at least two installed orgs in one process/container
- [ ] `remote-cli` installation routing is driven by `config.json`, not hardcoded env maps
- [ ] No doc claims that `remote-cli` relies solely on a static PAT if GitHub App auth is enabled
- [ ] The same Thor wrappers are used by both admin shells and the server execution path
- [ ] Compose/docs clearly define the dedicated GitHub App auth mount path for `remote-cli`

## Decision Log

| #   | Decision                                                                      | Reason                                                                                                                                       |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Make Thor-owned `git` / `gh` wrappers the primary auth surface                | One implementation path for admin shell usage and server execution is simpler than separate auth layers.                                     |
| 2   | Cache installation tokens by org login                                        | Simpler than per-repo or per-installation token fanout while still matching the multi-org requirement.                                       |
| 3   | Use a disk-backed token cache inside `remote-cli`                             | Wrapper binaries run per invocation, so in-memory cache alone would not be shared across commands.                                           |
| 4   | Keep policy enforcement only in the `remote-cli` HTTP path                    | The risky path is OpenCode-triggered execution; direct shell usage in the trusted container is an operator path.                             |
| 5   | Read installation mapping from `config.json` under `github_app.installations` | Aligns with the repo's dynamic workspace config pattern and makes multi-org routing explicit.                                                |
| 6   | Read the GitHub App private key from a file path                              | Better fit for Docker secrets / mounted files and avoids multiline env handling issues.                                                      |
| 7   | Mint full installation tokens per org, not narrowed per repo                  | Preserves a simple cache key and avoids token churn; GitHub still enforces the installation's repo access.                                   |
| 8   | Keep real `git` / `gh` binaries reachable by absolute path                    | Thor wrappers named `git` / `gh` must avoid recursive self-exec.                                                                             |
| 9   | Reject ambiguous or unsupported target resolution                             | Silent fallback to the wrong org would be a high-risk auth bug.                                                                              |
| 10  | Use a dedicated mounted path for the GitHub App private key and token cache   | Keeps auth material out of `/workspace` and `/home/thor`, simplifies operator troubleshooting, and makes permissions easier to reason about. |
| 11  | Only `app_id` and `private_key_path` fall back when empty                     | Keeps `org` and `installation_id` explicit in config while still allowing convenient shared defaults.                                        |

## Out of Scope

- User-account installations (`/users/{username}/installation`) in the first pass
- Cross-installation commands executed as a single `gh` or `git` process
- Per-repo narrowed installation tokens
- Persistent cache sharing across different containers
- A separate admin-only helper CLI beyond normal `git` / `gh` usage
- Relaxing the existing `gh` / `git` policy allowlists
- Dynamic installation-ID discovery via the GitHub API in the first pass

## Review Notes

Key trade-offs for review:

- This plan optimizes for one shared wrapper path instead of separate server-side and admin-side auth implementations.
- The main cost of that simplification is a disk-backed token cache in the trusted `remote-cli` container, because wrapper processes do not share memory.
- Multi-org installation routing is explicit in `config.json`, with env/default fallback only for shared app metadata.

<!-- AUTONOMOUS DECISION LOG -->

## Decision Audit Trail

| #   | Phase | Decision                                              | Classification | Principle | Rationale                                                                     | Rejected                                                         |
| --- | ----- | ----------------------------------------------------- | -------------- | --------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | CEO   | Mode: SELECTIVE EXPANSION                             | Mechanical     | P6        | Feature enhancement on existing system                                        | EXPANSION (overkill), REDUCTION (too little)                     |
| 2   | CEO   | Approach A (wrapper binaries)                         | Mechanical     | P5        | Explicit single auth path, avoids DRY violation of separate admin/server auth | Approach B (two auth paths), Approach C (overengineered sidecar) |
| 3   | CEO   | Defer all expansion candidates to TODOS.md            | Mechanical     | P3        | None in blast radius of Phase 1                                               | Build now                                                        |
| 4   | CEO   | Add auth_mode config switch for PAT fallback          | Taste          | P1        | Both voices flagged no rollback. Safe rollout requires fallback.              | Ship without rollback                                            |
| 5   | CEO   | Wrappers use absolute path for real binaries          | Mechanical     | P5        | Explicit path avoids PATH recursion, e.g., /usr/bin/git                       | Symlink tricks                                                   |
| 6   | CEO   | Per-org lock files, not global lock                   | Mechanical     | P5        | Concurrent ops to different orgs should not block each other                  | Global lock                                                      |
| 7   | CEO   | Wrappers should be TypeScript (shared auth module)    | Taste          | P5        | Enables vitest coverage of auth logic, DRY with server path                   | Shell scripts with curl/jq                                       |
| 8   | CEO   | Add graceful degradation for cache write failures     | Mechanical     | P1        | Disk full/permission denied should not block operations                       | Fail on cache error                                              |
| 9   | CEO   | Add [thor-github-app] stderr logging in wrappers      | Mechanical     | P1        | Debuggability for admin shell usage                                           | Silent auth                                                      |
| 10  | CEO   | Stale lock detection with mtime timeout (30s)         | Mechanical     | P5        | Prevents DoS from hung processes                                              | No stale detection                                               |
| 11  | CEO   | Add 5 additional test cases (forks, expiry, rotation) | Mechanical     | P1        | Completeness of test coverage                                                 | Skip edge cases                                                  |
| 12  | CEO   | File permissions: 0600 for private key and cache      | Mechanical     | P5        | Principle of least privilege for secrets at rest                              | Default permissions                                              |

## Follow-up Updates

Tracked here so this doc remains an honest record of what shipped vs. what was later reversed. Trace details live on the `gh-cli-append-only-policy` branch.

- **GitHub Enterprise support removed.** The `api_url` installation field, the `GITHUB_API_URL` env var, and the `deriveAllowedGitHosts` / `addGitHostsFromApiUrl` machinery have been dropped. Thor only targets `github.com` cloud. The token-mint URL is now hardcoded to `https://api.github.com`. ~50 lines and one config field gone.
- **Arg-based org resolution removed.** `resolveOrgFromArgs` (the `-R` / `--repo` parser referenced in this doc's Phase 1 tests) was unreachable because `validateGhArgs.hasRepoOverride` denies all four shapes (`-R`, `-Rfoo`, `--repo`, `--repo=foo`) before the auth helper ever runs. `resolveOrg` now defers entirely to the cwd's git remote.
- **Host check on `parseOrgFromRemoteUrl` dropped.** Defends only against admin compromise of the clone path, which already implies broader compromise. Trusted admin workflow makes the check noise.
