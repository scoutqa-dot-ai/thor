# Internal Exec Endpoint + Internal-Secret Consolidation

**Date**: 2026-04-27
**Status**: Implemented in PR #47

## Goal

Add a single internal credential (`THOR_INTERNAL_SECRET`) and a single policy-bypass endpoint (`POST /internal/exec` on `remote-cli`) so trusted gateway-side and admin-side callers can run service-to-service maintenance commands (`git pull`, `gh`, future admin tooling) without each new caller adding a per-feature policy allowlist entry.

This is shared infrastructure used by `2026042701_github-webhook-event-expansion.md` (for `git pull` on push events) and by future admin tooling.

## Current State

- Today `RESOLVE_SECRET` + `x-thor-resolve-secret` gates `/exec/mcp` approval resolution only:
  - `packages/gateway/src/index.ts:27,40` (env read)
  - `packages/gateway/src/service.ts:797` (header sender)
  - `packages/remote-cli/src/index.ts:270,776` (env read + header read)
  - `packages/remote-cli/src/mcp-handler.ts:590-593` (`timingSafeEqual` site)
  - `docker-compose.yml:45,211` (env passthrough on gateway and remote-cli)
  - `.github/workflows/{core,sandbox}-e2e.yml` mints the value at run time
  - Documented in `README.md:140,222,231`, `docs/feat/mvp.md:53,71`, `docs/github-app-webhooks.md:140`
- Policy-checked exec paths (`/exec/git`, `/exec/gh`, etc.) on `remote-cli` enforce per-binary allowlists via `policy.ts` and `policy-git.ts`. There is no bypass path for trusted internal callers today.
- `packages/remote-cli/src/exec.ts` exposes `execCommand({ bin, args, cwd, options })` which `child_process.execFile`s the binary (with an unconditional 60s safety SIGKILL) and returns `{ exitCode, stdout, stderr }`.

## Architecture

**Single internal credential**. `RESOLVE_SECRET` and `x-thor-resolve-secret` become `THOR_INTERNAL_SECRET` and `x-thor-internal-secret`. One env var, one header, gating every gateway↔remote-cli internal endpoint (currently `/exec/mcp`, after this plan also `/internal/exec`, and any future internal route).

**Trade-off accepted (Decision D-1)**: a leak of `THOR_INTERNAL_SECRET` now compromises both MCP approval resolution AND policy-bypass exec. Mitigated by: (a) the secret never leaves the internal Docker network (no public-ingress exposure), (b) least-privilege at the network boundary instead of per-feature secrets that drift over time, (c) operators rotate one secret on schedule, not many.

**`POST /internal/exec` shape**:

- Auth: `x-thor-internal-secret` header, `crypto.timingSafeEqual` against `THOR_INTERNAL_SECRET`. Missing/wrong → 401 before any work.
- Body: `{ bin: string, args: string[], cwd: string }`.
- Response: `{ exitCode, stdout, stderr }` from `execCommand()`.
- No bin allowlist — caller is trusted by virtue of holding the secret. This is the bypass path; `/exec/git` etc. remain the default for agent-driven calls.
- Bound on the internal Docker network only. Documented in the runbook; never exposed via public ingress.
- Every invocation logged with `bin`, `argc`, `cwd`, `exitCode`, `durationMs`. Args themselves are not logged; the endpoint is internal-only and the caller is trusted, so a hardcoded redaction list (which would inevitably miss flags from `psql`/`ssh`/`aws`/custom tools) buys false confidence.

**Migration**: hard rename in one commit. No backwards-compat env fallback. Justified: internal infra, no external consumers, e2e workflows mint the secret at run time, production deploys are coordinated. (See Decision D-2 for the rolling-deploy mitigation.)

## Phases

### Phase 1 — Rename `RESOLVE_SECRET` → `THOR_INTERNAL_SECRET`

Single commit, hard rename:

- `packages/gateway/src/index.ts:27,40` — env read; rename internal field `resolveSecret` → `internalSecret` for clarity.
- `packages/gateway/src/service.ts:797` — header name `x-thor-resolve-secret` → `x-thor-internal-secret`.
- `packages/remote-cli/src/index.ts:270,776` — env read + header read.
- `packages/remote-cli/src/mcp-handler.ts:590-593` — `timingSafeEqual` site (no logic change, just the env source).
- Tests: `packages/gateway/src/{app,service}.test.ts`, `packages/remote-cli/src/mcp-handler.test.ts` — string fixtures and header names.
- `docker-compose.yml:45,211`, `.env.example`, `.github/workflows/{core,sandbox}-e2e.yml:184-187,96-99`.
- `README.md:140,222,231`, `docs/feat/mvp.md:53,71`, `docs/github-app-webhooks.md:140`.
- Boot fail-fast in both gateway and remote-cli when `THOR_INTERNAL_SECRET` is unset.

### Phase 2 — Add `POST /internal/exec`

In `packages/remote-cli/src/index.ts`:

- Reuse the same `THOR_INTERNAL_SECRET` env + `x-thor-internal-secret` header check from Phase 1.
- 401 on missing/wrong secret before invoking `execCommand()`.
- Body validation: `bin` must be non-empty string, `args` must be string array, `cwd` must be non-empty string. No bin allowlist.
- Pass through to `execCommand()` from `packages/remote-cli/src/exec.ts`.

In `packages/gateway/src/service.ts`:

- Thread `internalSecret` through `BatchDispatchInput` → `triggerRunnerGitHub` → `resolveGitHubPrHead` so the existing `/github/pr-head` fetch can include `x-thor-internal-secret`. Same for `resolveApproval` against `/exec/mcp`.
- Split the upstream-status handling: 401 from remote-cli now means "rejected our internal credential" (terminal `branch_lookup_failed`); 403 still means "installation gone".
- A typed `internalExec()` client for `/internal/exec` is **deferred** (see Deferred section): it would land as dead code on this branch, so it ships with its first real caller (the push-event `git pull` handler in `2026042701_github-webhook-event-expansion.md`).

### Phase 3 — Tests + grep audit

- 401 on missing/wrong secret for `/exec/mcp` resolve, `/internal/exec`, and `/github/pr-head`; `execCommand`/approval handler never invoked.
- Existing MCP approval test suite passes against the renamed env/header. The previous "Unknown subcommand: resolve" denial path is replaced by an HTTP 401 at the route layer.
- `/internal/exec` happy-path: runs `echo`, returns `{ exitCode: 0, stdout: "hello\n", stderr: "" }`.
- `grep -r "RESOLVE_SECRET\|x-thor-resolve-secret"` returns zero hits outside historical plan docs (`docs/plan/2026041602_drop-proxy.md` and similar — leave as historical record).

## Exit Criteria

- [ ] `THOR_INTERNAL_SECRET` is the only internal-auth env var; `RESOLVE_SECRET` is gone from source, compose, e2e workflows, README, and live docs.
- [ ] `x-thor-internal-secret` is the only internal-auth header; `x-thor-resolve-secret` is gone.
- [ ] `/exec/mcp` approval resolution still works under the renamed env+header; existing approval tests pass unchanged in behavior.
- [ ] `/internal/exec` runs arbitrary `{bin, args, cwd}` under the same auth, bypasses policy, returns `{exitCode, stdout, stderr}`.
- [ ] 401 on missing/wrong secret for `/exec/mcp` resolve, `/internal/exec`, and `/github/pr-head`; never invokes `execCommand` or approval logic in that case.
- [ ] Boot fails fast on missing `THOR_INTERNAL_SECRET` in either service.
- [ ] e2e workflows mint and pass `THOR_INTERNAL_SECRET` to both services.

## Decision Log

| #   | Decision                                                                                         | Rationale                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | One credential gates all gateway↔remote-cli internal endpoints                                   | Per-feature secrets drift apart, multiply ops burden, and create rotation gaps. One credential on the internal network boundary is least-privilege at the right layer. Acknowledged trade-off: leak compromises both approvals and exec, mitigated by network isolation.                                                                                                                    |
| D-2 | Hard rename (no dual-read env fallback) deployed via coordinated restart                         | Backwards-compat fallback is operational tax for internal infra with no external consumers. Reviewed alternative: dual-read for one release. Accepted in favor of single-step rename + explicit deploy procedure (gateway and remote-cli restart together; e2e workflows already mint at run time). If a rolling deploy is required in the future, add a one-release dual-read window then. |
| D-3 | `POST /internal/exec` has no bin allowlist                                                       | The endpoint exists _because_ the policy allowlist is too narrow for legitimate service-to-service maintenance. An allowlist on the bypass path defeats the point. The credential + network boundary is the security control.                                                                                                                                                               |
| D-4 | Endpoint is internal-only by design — never expose via public ingress                            | This is authenticated remote shell. The only safe deployment is on the internal Docker network with the credential never leaving that boundary. Documented in the runbook; verified by docker-compose port bindings.                                                                                                                                                                        |
| D-5 | Reuse `execCommand()` from `packages/remote-cli/src/exec.ts` rather than introduce a new spawner | Existing utility handles stdout/stderr capture, exit codes, and an unconditional 60s safety SIGKILL. No reason to fork.                                                                                                                                                                                                                                                                     |

## Out of Scope

- Generalizing `/internal/exec` into an agent-callable surface. Stays internal-only by design (D-4). Admin tooling that uses the same credential is fine.
- Per-call audit log persistence beyond the existing structured logger. If audit retention becomes a requirement, add a separate logging sink.
- mTLS on the internal network. The shared-secret model is sufficient for the internal Docker bridge today; revisit if multiple operator orgs share infrastructure.
- A bin allowlist on `/internal/exec`. Discarded under D-3.
- Replacing `/exec/mcp`'s purpose-specific shape with a generic exec call. The MCP handler does more than spawn a process (approval state machine, MCP protocol bridge); leave it alone.

## Deferred

- **Caller-driven timeouts.** Callers that need a deadline should pass an `AbortSignal` through `ExecCommandOptions` and forward it to `child_process.execFile` (and as `signal` on the gateway-side `fetch`). Until there's a real caller, `execCommand` only enforces the existing 60s safety SIGKILL.
- **Gateway-side `internalExec()` client.** Lands with its first real caller (e.g. the push-event `git pull` handler in `2026042701_github-webhook-event-expansion.md`) so it doesn't ship as dead code.
