# grafana MCP per-profile via sandboxed stdio subprocesses

Re-architect the Grafana MCP integration so each profile gets a fully isolated Grafana
instance. Replace the single shared `grafana-mcp` streamable-HTTP sidecar — into which
per-profile credentials are smuggled as `X-Grafana-*` headers — with per-profile
`mcp-grafana` child processes spawned on demand by `remote-cli`, each configured by that
profile's own credentials in a scrubbed environment and confined with `bwrap`
(bubblewrap). This keeps profile credential routing fully dynamic: an operator enables a
new profile's Grafana by setting `GRAFANA_*_<PROFILE>` env vars only — never by editing
`docker-compose.yml`.

## Goal

Let a Thor operator point each profile at a different Grafana instance with no static
topology. A session bound to profile `QA` queries the `QA` Grafana; a session bound to
`LABS` queries the `LABS` Grafana; an unprofiled session uses the global Grafana. Adding
or removing a profile's Grafana target requires only env var changes plus the existing
`thor.json` profile membership — no new container, no compose edit, no restart of a
per-profile service. Every tool category, including the `proxied` (Tempo) tools, must
route to the profile's own instance, not silently to a boot-time global.

## Scope

**In scope**

- Drop the `grafana-mcp` service from `docker-compose.yml` and its `depends_on` /
  `no_proxy` references.
- Bundle the pinned `mcp-grafana` binary and `bubblewrap` into the `remote-cli` image.
- Extend the upstream transport abstraction so a resolved proxy config can describe a
  `stdio`-spawned upstream (command + args + scrubbed env), in addition to the existing
  `http` upstreams (Atlassian, PostHog, Langfuse stay HTTP).
- Change Grafana resolution in `proxies.ts` to return a sandboxed stdio spec keyed by the
  existing profile-scoped `target.key`, so connection pooling, reconnect, and
  approval re-resolution work per profile with no handler rewrite.
- Confine each `mcp-grafana` child with `bwrap`: cleared env (only the resolved profile's
  `GRAFANA_*`), no view of `/var/lib/remote-cli/github-app`, `/workspace`, or
  `remote-cli`'s other secrets; private `/tmp`, pid/ipc/uts namespaces; network shared
  (needs egress to the Grafana instance).
- Update `.env.example`, `README.md`, the E2E workflow env blocks, and tests/fixtures
  that reference the sidecar (AGENTS.md §6).

**Out of scope**

- Changing the profile resolution model itself (channel/repo → profile). This plan
  consumes the resolver from `2026052701_profile-based-integration-routing.md` unchanged.
- Per-profile tool allow/approve policy. Grafana policy stays global per integration
  (`GRAFANA_ALLOW`), matching that plan's Decision 6.
- Migrating the other MCP integrations off HTTP. Only Grafana needs a local process; the
  rest stay remote HTTP upstreams.
- Routing the `mcp-grafana` → Grafana egress through mitmproxy. MCP-path egress is not
  proxied today (only OpenCode's clients are); this plan preserves that posture and does
  not add profile-aware egress. See the security model and Open questions.
- Idle teardown of spawned children beyond what the existing reconnect/eviction path
  already does (noted as an optional follow-up).

## Architecture

Before (shared sidecar, header multi-tenancy):

```text
remote-cli ──HTTP /mcp + X-Grafana-* headers──▶ grafana-mcp:8000 (one shared process)
                                                      └─▶ Grafana API (per-request URL/token)
```

After (per-profile sandboxed child of remote-cli):

```text
remote-cli
  ├─ spawn bwrap mcp-grafana (env: GRAFANA_*_QA)   ── stdio ─▶ child ─▶ QA Grafana
  ├─ spawn bwrap mcp-grafana (env: GRAFANA_*_LABS) ── stdio ─▶ child ─▶ LABS Grafana
  └─ spawn bwrap mcp-grafana (env: GRAFANA_* global)── stdio ─▶ child ─▶ global Grafana
```

One child per distinct resolved `target.key`. Because each child is configured by its own
environment, it is single-tenant by construction: the `proxied` Tempo tools read the same
per-process `GRAFANA_URL`/token as the native datasource tools, eliminating the
header-vs-boot-config ambiguity that made the shared sidecar unfit for profiles.

## Environment & config contract (unchanged)

The env contract from the profile-routing plan is preserved verbatim — only the transport
behind it changes:

- `GRAFANA_URL_<P>` + `GRAFANA_SERVICE_ACCOUNT_TOKEN_<P>` (+ optional `GRAFANA_ORG_ID_<P>`)
  → that profile's instance; else global `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN`
  (+ optional `GRAFANA_ORG_ID`); else disabled.
- Multi-var bundle still fails hard on a partial profile suffix (Decision 12 of the
  profile-routing plan).
- `GRAFANA_ALLOW` and the empty `GRAFANA_APPROVE` are unchanged; enabled tool categories
  stay `datasource,prometheus,loki,proxied`.

No new env vars are introduced. The operator-facing change is purely the removal of the
need for a global `GRAFANA_URL`/token just to boot a sidecar: with only `_<P>` vars set,
Grafana is available for those profiles and absent globally.

## Current-state constraints to replace

- `docker-compose.yml` defines a `grafana-mcp` service, lists it in `remote-cli`'s
  `depends_on`, and includes it in both `no_proxy`/`NO_PROXY` lists.
- `packages/common/src/proxies.ts` returns `upstream.url = http://grafana-mcp:8000/mcp`
  plus `X-Grafana-*` headers for Grafana; `ResolvedProxyConfig.upstream` only models an
  HTTP url + headers.
- `packages/remote-cli/src/upstream.ts` always builds a `StreamableHTTPClientTransport`.
- `.github/workflows/core-e2e.yml` and `sandbox-e2e.yml` set
  `GRAFANA_URL: http://grafana-mcp:8000` + `GRAFANA_SERVICE_ACCOUNT_TOKEN: ci-fake`,
  values that only make sense with the sidecar present.
- `Dockerfile` `remote-cli` target has neither the `mcp-grafana` binary nor `bubblewrap`.

## Decision log

| #   | Decision                                                                                                                                                                                                                      | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rejected                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Spawn one `mcp-grafana` process per resolved `target.key`, configured by env, instead of one shared sidecar with per-request headers                                                                                          | Makes each instance single-tenant by construction; the `proxied`/Tempo tools route to the profile's own instance without depending on third-party per-session-header support. Removes the silent-wrong-instance failure mode for proxied tools.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Keep the shared HTTP sidecar and trust header multi-tenancy across all tool categories                                                                                         |
| 2   | Supersede Decision 8 of `2026052701_profile-based-integration-routing.md` (per-request `X-Grafana-*` headers)                                                                                                                 | That decision relied on the sidecar honoring per-request URL/token for every tool. The proxied-tool path is ambiguous in Grafana's docs and would leak the global instance per profile. This plan replaces the mechanism, not the env contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Leave Decision 8 in force                                                                                                                                                      |
| 3   | Run `mcp-grafana` as a child of `remote-cli` over stdio, not as a per-profile container                                                                                                                                       | The operator must not edit `docker-compose.yml` to add a profile. A static per-profile container topology contradicts the dynamic, hot-reloaded `thor.json` profile model. stdio children are created on demand from env, matching that model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | One `grafana-mcp-<profile>` compose service per profile (static topology, requires compose edits + restart per profile)                                                        |
| 4   | Confine each child with `bwrap` (cleared env + no secret mounts + private namespaces)                                                                                                                                         | The foreign Go binary now runs inside `remote-cli`, which holds `THOR_INTERNAL_SECRET` (policy-bypass) and the GitHub App private key. The security model leans on per-component isolation even inside the trusted network; `bwrap` restores a process/filesystem boundary around the third-party code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Spawn the binary directly with only an env scrub (no filesystem/PID isolation from remote-cli)                                                                                 |
| 5   | Scrub via `bwrap --clearenv` **and** pass an explicit `env` to the stdio transport                                                                                                                                            | Defense in depth: the SDK's stdio transport already replaces the parent env when `env` is supplied, and `--clearenv` guarantees the child starts from nothing even if the spawn path changes. The child sees only `GRAFANA_*` + minimal `PATH`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rely on a single env-scrub layer                                                                                                                                               |
| 6   | Model the upstream transport as a discriminated union (`http` \| `stdio`) on `ResolvedProxyConfig.upstream`; only Grafana uses `stdio`                                                                                        | Keeps the change localized; Atlassian/PostHog/Langfuse stay HTTP with zero behavioral change. `connectUpstream` branches once on `kind`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Add a second resolver/codepath parallel to `resolveProxyConfig`; make every integration stdio-capable                                                                          |
| 7   | Pin the `mcp-grafana` binary by copying it from `grafana/mcp-grafana:<pinned>` in a Dockerfile build stage                                                                                                                    | Same version pin as today, just relocated into the `remote-cli` image. The binary's blast radius is larger (adjacent to secrets), so version discipline matters — treat a bump like the OpenCode SDK alignment rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `go install`/download at build time (unpinned); fetch at runtime                                                                                                               |
| 8   | Gate the whole change behind a `bwrap`-in-container feasibility spike (Phase 1) with a documented fallback                                                                                                                    | Unprivileged `bwrap` needs user-namespace support that some Docker hosts/seccomp profiles restrict. If it cannot run rootless in our image, we must know before wiring the transport.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Assume `bwrap` works everywhere; ship without a fallback                                                                                                                       |
| 10  | Run `remote-cli` with a **custom additive seccomp profile** (Docker default + `unshare`/`clone`/`clone3`/`setns`/`mount`/`umount2`/`pivot_root`/`keyctl`), and bind host `/proc` into the sandbox instead of a fresh `--proc` | Spike finding: under Docker's default seccomp, rootless `bwrap` fails at `unshare(CLONE_NEWUSER)` even though the kernel allows userns (`max_user_namespaces` ≠ 0). `seccomp=unconfined` makes all checks pass, but disabling seccomp for all of remote-cli is too broad — an additive profile scoped to the one service restores the userns syscalls while keeping the rest of the default filter. A fresh `--proc` mount is rejected on the container kernel; bind-mounting host `/proc` works. See `.context/grafana-bwrap-spike/`.                                                                                                                                                                                                                                                                           | Ship `seccomp=unconfined` on remote-cli; rely on setuid `bwrap` (fails under default caps) or `cap-add SYS_ADMIN` (pivot_root still fails)                                     |
| 11  | Pass the per-profile credentials via the **child's env** (the stdio transport `env`), not `bwrap --setenv`, and therefore run **without `--clearenv`**. Supersedes Decision 5.                                                | `--clearenv` forces every var (including the service-account token) to be re-injected via `--setenv`, which puts the token in the child's argv — readable via `/proc/<pid>/cmdline` by any co-resident process. Avoiding argv exposure matters more than the `--clearenv` backstop, because the SDK already forwards only a fixed safe allowlist (`HOME/LOGNAME/PATH/SHELL/TERM/USER`) plus our `env` — no remote-cli secret is on that list. The existing `upstream.test.ts` "does not leak parent secret" test is the durability tripwire: it fails if an SDK bump ever widened that allowlist. Non-secret vars (`PATH`, `HOME`) are still pinned via `--setenv` for determinism.                                                                                                                              | Keep `--clearenv` + `--setenv` for every var (token lands in `/proc/<pid>/cmdline`)                                                                                            |
| 13  | CI runs mcp-grafana **without** bwrap via a `THOR_MCP_DISABLE_SANDBOX` flag set only in the e2e `.env`; production keeps the sandbox (flag unset, default).                                                                   | The GitHub Actions runner is a container-in-container that cannot host rootless bwrap at all: AppArmor `docker-default` denies the mount step (`Failed to make / slave`), and even with `CAP_SYS_ADMIN` the nested userns cannot map uids (`setting up uid map: Permission denied`) — verified empirically; relaxing both LSMs did not work and the only rung left was `--privileged`. Rather than escalate CI privileges, the flag drops the sandbox in CI so the real `mcp-grafana` binary still spawns and lists tools (better coverage than skipping). Safe **only** because CI credentials are fakes — no real secrets for the unsandboxed binary to reach; remote-cli logs `mcp_sandbox_disabled` whenever it is active. Production never sets it and is validated by the Phase 1 `run.sh` sandbox checks. | `apparmor=unconfined` + `CAP_SYS_ADMIN` CI override (tried — `uid_map` still denied); `--privileged` in CI (large hole, uncertain); probe-and-skip (loses real-spawn coverage) |
| 12  | Bind host `/proc` is safe **because** `--unshare-pid` puts the child in a fresh PID namespace                                                                                                                                 | An adversarial review flagged that a bind-mounted host `/proc` could expose remote-cli's `/proc/<pid>/environ` (→ `THOR_INTERNAL_SECRET`) and `/proc/<pid>/root` (→ GitHub App key). Verified empirically it does not: procfs renders only PIDs that exist in the **reader's** namespace, so a process in the child PID namespace sees only the sandbox's own processes; host PIDs are unresolvable and `/proc/1` is the sandbox init, not remote-cli's. `--unshare-user` additionally remaps the uid. The spike's confinement checks were extended to assert the `/proc/<host-pid>/environ` and `/proc/1/root` bypass paths are blocked.                                                                                                                                                                        | Assume the bind is unsafe and block on a fresh `--proc` that Docker rejects (would force the Option B fallback unnecessarily)                                                  |
| 9   | Keep Grafana → Grafana egress direct (not through mitmproxy), unchanged from the sidecar                                                                                                                                      | MCP-path egress is not proxied today; the security model only routes OpenCode's own clients through mitmproxy, and already accepts MCP-path profile creds bypassing it. No regression.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Route child egress through mitmproxy in this plan (out of scope; would need profile-aware addon)                                                                               |

## Phases

### Phase 1 — `bwrap`-in-container feasibility spike

- Add `bubblewrap` to the `remote-cli-tools` Dockerfile stage and the pinned
  `mcp-grafana` binary via `COPY --from=grafana/mcp-grafana:<pinned> /app/mcp-grafana`.
- As the non-root `thor` user, run `mcp-grafana -transport stdio` under a candidate
  `bwrap` argument set and confirm: (a) the process starts and completes an MCP
  `initialize` + `tools/list` over stdio against a real Grafana; (b) it cannot read
  `/var/lib/remote-cli/github-app` or `/workspace`; (c) it can resolve DNS and reach the
  Grafana instance.
- If rootless `bwrap` cannot start in our container, decide the fallback in the Decision
  log before proceeding (options: setuid `bwrap`, a narrowly scoped seccomp/cap profile
  on the `remote-cli` service, or env-scrub-only with the residual risk documented).

Validated confinement (spike, see `.context/grafana-bwrap-spike/`). Note: bind host
`/proc` (a fresh `--proc` is rejected on the container kernel), and the service needs the
additive seccomp profile from Decision 10:

```text
bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts --new-session --die-with-parent \
  --clearenv --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /tmp \
  --setenv GRAFANA_URL <url> --setenv GRAFANA_SERVICE_ACCOUNT_TOKEN <token> [--setenv GRAFANA_ORG_ID <org>] \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib [--ro-bind /lib64 /lib64] \
  --ro-bind /etc/ssl /etc/ssl \
  --ro-bind-try /etc/resolv.conf /etc/resolv.conf --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf --ro-bind-try /etc/hosts /etc/hosts \
  --bind /proc /proc --dev /dev --tmpfs /tmp \
  /usr/local/bin/mcp-grafana -transport stdio -enabled-tools datasource,prometheus,loki,proxied
```

**Exit criteria:** ✅ met. A reproducible `bwrap` invocation runs `mcp-grafana` rootless in
a remote-cli-like image, blocks `/var/lib/remote-cli/github-app` and `/workspace`, scrubs
the parent env, completes the MCP stdio handshake, and resolves DNS for egress. Confirmed
on **both** the dev kernel and the **production server** (default seccomp blocks it;
`max_user_namespaces` ≠ 0 on both, so the kernel allows userns). The additive seccomp
profile from Decision 10 is built and validated — all 7 checks pass under it with no added
capability and without `seccomp=unconfined` (`.context/grafana-bwrap-spike/`,
`seccomp-bwrap.json`). **Implementation carry-over into later phases:** vendor
`seccomp-bwrap.json` under the repo (e.g. `docker/remote-cli/`) and wire it via
`security_opt` on the `remote-cli` service in Phase 4.

### Phase 2 — stdio transport in the upstream layer

- Extend `ResolvedProxyConfig.upstream` to a discriminated union:
  `{ kind: "http"; url; headers? } | { kind: "stdio"; command; args; env }`.
- In `upstream.ts`, branch `connectUpstream` on `kind`: HTTP keeps
  `StreamableHTTPClientTransport`; stdio uses `StdioClientTransport` with the resolved
  `command`/`args`/`env`. Keep the existing `onclose`/`listTools` flow so the handler's
  reconnect and policy validation are unchanged.
- `connectInstance`/`getInstance` in `mcp-handler.ts` pass the upstream spec through
  untouched; pooling and `scheduleReconnect` (respawn on child exit) work as-is because
  they key on `target.key`.

**Exit criteria:** `remote-cli` unit tests cover an HTTP upstream (unchanged) and a stdio
upstream (spawn → list tools → policy validate → reconnect-on-exit), using an injected
`connectUpstreamFn`/fake command so no real binary is required in unit tests.

### Phase 3 — Grafana resolves to a sandboxed stdio spec

- In `proxies.ts`, change the Grafana branch of `resolveProxyConfig` to return
  `upstream: { kind: "stdio", command: "bwrap", args: [...confinement..., mcp-grafana,
-transport, stdio, -enabled-tools, ...], env: { GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN,
GRAFANA_ORG_ID?, PATH } }`. The profile-suffix resolution, bundle-partial fail-hard, and
  `target.key` are unchanged; only the `upstream` shape changes.
- The other three integrations keep returning `kind: "http"`.
- Centralize the `bwrap` arg construction (single helper) so the confinement set has one
  source of truth.

**Exit criteria:** `proxies.test.ts` proves Grafana resolves to distinct stdio specs per
profile (different `env`, same `target.key` scheme), partial-bundle still throws, and the
global fallback resolves when no `_<P>` vars are set; HTTP integrations are unaffected.

### Phase 4 — Remove the sidecar and align surfaces

- Delete the `grafana-mcp` service, the `remote-cli` `depends_on: grafana-mcp`, and the
  `grafana-mcp` entries in both `no_proxy`/`NO_PROXY` lists in `docker-compose.yml`.
- Update `.github/workflows/core-e2e.yml` and `sandbox-e2e.yml`: remove the
  `GRAFANA_URL: http://grafana-mcp:8000` sidecar value; set CI Grafana env so the E2E
  upstream-listing check still exercises the stdio spawn path (or document why it is
  skipped in CI when no reachable Grafana exists).
- Update `.env.example` (note the sidecar removal; global vars now optional when only
  profile bundles are used), `README.md` integration/architecture sections, and
  `docs/plan/2026031602_grafana-mcp.md` status to point here.
- Add a convention note (AGENTS.md / README) that bumping the bundled `mcp-grafana`
  version is a deliberate, pinned change — analogous to the OpenCode SDK alignment rule.

**Exit criteria:** `docker compose config` is valid with no `grafana-mcp` service; a fresh
`docker compose up --build` starts `remote-cli` without the removed dependency; no
remaining repo reference to `grafana-mcp:8000`; env var surfaces updated per AGENTS.md §6.

### Phase 5 — Integration verification

- Push the branch to trigger the relevant E2E workflow (`core-e2e` and/or `sandbox-e2e`).
- Verify the `mcp` upstream listing shows Grafana tools resolved through a spawned child,
  and that a profile-scoped session and the global session resolve to different instances
  (using two distinct `GRAFANA_*` bundles in the test environment where available).
- Use the green push checks as the final gate, then open the PR against `main`.

**Exit criteria:** required push checks green; PR opened against `main`.

## Open questions

- **Idle child reaping.** Each distinct profile that uses Grafana holds a live child for
  the process lifetime of `remote-cli` (bounded by the number of profiles). Is an idle
  timeout worth adding, or is per-profile process count low enough to ignore? Default:
  ignore for now; revisit if profile count grows.
- **CI without a real Grafana.** The sidecar let CI list tools against a fake URL. With a
  real binary spawned, the upstream-listing E2E needs either a reachable test Grafana or
  an explicit skip. Decide in Phase 4 whether to stand up a minimal Grafana in CI or gate
  the Grafana E2E assertion on a env-provided real instance.
- **`bwrap` fallback shape.** If Phase 1 finds rootless `bwrap` infeasible on the target
  host, which fallback (setuid `bwrap`, scoped seccomp/caps on `remote-cli`, or
  env-scrub-only) is acceptable to the security model? Resolve before Phase 2.
- **Egress visibility.** Child → Grafana egress stays direct (Decision 9). If a future
  requirement needs per-profile egress audit, it would follow the same
  runner→env→mitmproxy-addon path noted for Atlassian in the profile-routing plan.

## Test plan

- `pnpm --filter @thor/common test` — Grafana stdio-spec resolution, partial-bundle
  fail-hard, global fallback, HTTP integrations unaffected.
- `pnpm --filter @thor/remote-cli test` — stdio vs HTTP transport branch, spawn/list/
  policy/reconnect with an injected fake command.
- Manual / E2E:
  - profile `QA` session lists and queries Grafana tools against the `QA` instance;
  - global (unprofiled) session resolves to the global instance;
  - a Tempo (`proxied`) query routes to the session's own instance, not the global;
  - the spawned child cannot read `/var/lib/remote-cli/github-app` or `/workspace`
    (Phase 1 confinement check).

## Migration notes

- No env var renames; existing `GRAFANA_*` and `GRAFANA_*_<P>` values keep working.
- Operators running only profile-scoped Grafana may now drop the global `GRAFANA_URL`/
  token entirely (previously needed to boot the sidecar); Grafana becomes available only
  for profiles with a complete bundle.
- The `grafana-mcp` container is removed on the next `docker compose up --build`; no data
  volume is associated with it, so removal is clean.
- No flag day: the change is internal to `remote-cli`; profile membership and credentials
  are unchanged.

## Review fixes

- 2026-06-03: `THOR_MCP_DISABLE_SANDBOX` must be exactly `1`; values like `false` or `0`
  keep the bwrap sandbox enabled.
- 2026-06-03: stdio upstream setup now closes the just-spawned child if `tools/list` or
  pre-registration policy validation fails, so failed setup attempts do not leave
  untracked `mcp-grafana` processes behind.
