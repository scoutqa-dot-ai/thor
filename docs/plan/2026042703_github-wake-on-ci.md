# Wake Thor on green CI

**Date**: 2026-04-27
**Status**: Ready to implement (Phase 1)
**Updated**: 2026-04-28 (PR #47 merged into branch; phases expanded)
**Depends on**: ~~https://github.com/scoutqa-dot-ai/thor/pull/47~~ ✅ landed — provides `THOR_INTERNAL_SECRET` + `POST /internal/exec` + gateway `internalExec()` client

## Problem

Today the gateway drops `workflow_run` / `workflow_job` / `check_run` /
`check_suite` as `event_unsupported`. Operationally we want: when CI passes
on a Thor-authored PR, Thor wakes up to take the next step (open the PR,
continue the task, react to results).

A naive implementation (allowlist `workflow_run`, gate on
`triggering_actor.id` + `pull_requests[]`) was drafted and reviewed by
/autoplan; both CEO voices flagged fundamental issues. This plan parked the
implementation pending a design decision; decisions are now recorded below.

## Decisions

| #       | Question                | Decision                                                                                                                                                 |
| ------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1      | Event primitive         | **`check_suite.completed`** — single rollup per commit, native PR association, eliminates Q4 fan-out                                                     |
| Q2      | Self-loop guard         | **Gateway-side `git cat-file -e <head_sha>`** via `internalExec()` against the workspace directory before enqueue. No notes schema change, no woken-flag |
| Q3      | Bot authorship          | **Gateway-side `git log -1 --format=%ae <head_sha>`** via `internalExec()`, matched against `THOR_GIT_AUTHOR_EMAIL`. Both Q2 and Q3 must pass to enqueue |
| Q4      | Multi-workflow debounce | **Not applicable** — eliminated by Q1 choice                                                                                                             |
| Q5      | Failure handling        | **Forward terminal non-success** with a distinct prompt shape ("CI failed on sha X, branch Y") so Thor reacts instead of hangs. Same Q2+Q3 gate applies  |
| Rollout | Gating                  | Mirror the Slack `getConfig` channel-allowlist pattern (`packages/gateway/src/app.ts:197-205`); per-repo opt-in for `check_suite`, off by default        |

### Wake-time gate (no schema change)

When `check_suite.completed` arrives at the gateway for `correlationKey=K`,
`head_sha=X`, the gateway resolves the workspace `directory` from K (same
path as for any other GitHub event) and runs two git checks via the
`internalExec()` client (`POST /internal/exec` on `remote-cli`):

1. `git cat-file -e X` — does this sha exist in the workspace's git?
2. `git log -1 --format=%ae X` — is the author email Thor's bot identity?

Both pass → enqueue as success or failure prompt depending on
`conclusion`. Either fails (incl. exec timeout / non-zero exit) → drop
with a structured log line. The runner is not involved in gating.

Why this beats the earlier notes-file design:

- Provenance lives in git, where it actually is. No sidecar drift, no
  extra write paths on every push.
- No "mark sha as woken" flag needed. `check_suite.completed` fires once
  per (commit, app); reruns _should_ re-wake (CI re-passing after a fix
  is exactly when Thor should react). The feared self-loop — "wake →
  push same sha → wake" — isn't a real path: Thor doesn't push identical
  shas, and `check_suite` doesn't fire on comments or pushes alone.
- Sender-based gating on `check_suite` doesn't work anyway: `sender` is
  the CI app (e.g., `github-actions[bot]`), not the pusher.

## Original design questions (for context)

### 1. Which event primitive?

Options to evaluate:

- **`workflow_run.completed`** — fires per workflow. Multi-workflow repos
  fan out. `pull_requests[]` is eventually consistent and empty for forks.
  `head_branch` can be null for tag-triggered or detached-ref runs.
- **`check_suite.completed`** — rolls up _all_ checks for a commit into
  one verdict. Closer to "is this PR green." Fires once per commit per
  app. Native PR association via `pull_requests[]`.
- **`check_run.completed`** — per-individual-check. Wrong granularity.
- **`status`** — legacy commit-status API. Some CI systems still use it.
- **`repository_dispatch`** — explicit "Thor may continue" signal from the
  CI workflow itself. Clean control plane but requires modifying every
  target repo's workflow YAML.
- **`deployment_status`** — useful if the gate is post-deploy, not CI.
- **Runner-side polling/subscription** — agent that pushed registers a
  one-shot listener keyed by `head_sha`; gateway not involved.

Recommendation lean: `check_suite.completed` for general "PR green" or
runner-side subscription for "Thor mid-task awaiting CI."

**Decision: `check_suite.completed`.** Rationale: collapses Q4 entirely,
provides native `pull_requests[]` association, fires once per commit per
app. Runner-side subscription rejected as premature complexity — gateway
pass-through is the established pattern.

### 2. Self-loop guard

Thor pushes → CI green → Thor wakes → Thor pushes → loop. The current
gateway delivers GitHub events with `interrupt: true`, which means a wake
_aborts_ the in-flight session. There's no `head_sha` dedupe today.

Options:

- Dedupe at runner: per `(correlationKey, head_sha)` — first wake for a
  given sha proceeds; subsequent ones drop.
- Rate-limit at gateway: per `head_sha` per minute.
- Session-state correlation: the runner tracks "I am awaiting CI on sha X";
  only that wake matches.

Recommendation lean: runner-side `(correlationKey, head_sha)` dedupe via
notes file; cheapest, observable.

**Decision: gateway-side `git cat-file -e <head_sha>` via
`internalExec()`.** No notes-file schema change, no woken-flag. The
feared loop ("wake → push same sha → wake") isn't a real path: Thor
doesn't push identical shas, and `check_suite` doesn't fire on comments
or non-CI pushes. See "Wake-time gate" above.

### 3. Bot authorship proxy

`workflow_run.actor.id` and `triggering_actor.id` are not equivalent and
neither perfectly answers "did Thor author this commit." On reruns, actor
= original pusher, triggering_actor = rerunner.

Options:

- `triggering_actor.id === botId` — drops legitimate rerun-by-human cases.
- `actor.id === botId` — drops Thor-authored work re-triggered by humans.
- Commit signature on `head_sha` — provenance-based, no actor reliance.
- Persisted Thor session metadata keyed by `head_sha` — runner-side.

Recommendation lean: drop actor-based gating entirely; use session-state
correlation (option 4) to answer "is this a sha I pushed."

**Decision: gateway-side git-author check via `internalExec()`.**
`git log -1 --format=%ae <head_sha>` against `THOR_GIT_AUTHOR_EMAIL`.
Webhook actor fields can't help here: `check_suite.sender` is the CI
app (e.g., `github-actions[bot]`), not the pusher, and there is no
clean `pusher`/`actor` field on `check_suite`. `GITHUB_APP_BOT_ID`
stays gateway-only.

### 4. Multi-workflow granularity

If `workflow_run` is chosen, three workflows = three wakes. `check_suite`
collapses this naturally. If `workflow_run` wins anyway, debounce per
`head_sha` at the gateway (with a flush trigger when the _last_ expected
workflow completes — but knowing "last" requires knowing the workflow
list, which the gateway doesn't have).

**Decision: N/A.** Eliminated by Q1 (`check_suite.completed`).

### 5. Failure handling

If CI fails, does Thor stay asleep forever waiting on a green that never
comes? Or do we forward terminal non-success as a "stop waiting" signal?

Recommendation lean: forward conclusion=failure with a distinct prompt
shape ("CI failed on sha X, branch Y") so Thor can react instead of hang.

**Decision: forward terminal non-success.** New prompt shape in the
GitHub prompt renderer. Same Q2+Q3 git gate applies. No "woken" flag
needed — reruns naturally re-wake.

## Implementation prerequisites (resolved)

- ✅ Primitive: `check_suite.completed` (Q1)
- ✅ Self-loop guard: gateway `internalExec()` → `git cat-file -e` (Q2)
- ✅ Authorship proxy: gateway `internalExec()` → `git log -1 --format=%ae` (Q3)
- ✅ Hard dependency: PR #47 landed (`/internal/exec` + `internalExec()` client)
- ✅ Failure-forwarding: forward with distinct prompt shape (Q5)
- ⏭ Operator runbook update (`docs/github-app-webhooks.md`) — Phase 5
- ⏭ Rollout: per-repo opt-in via Slack-style `getConfig` allowlist, off by default — Phase 4

## Feasibility notes (from 2026-04-28 review)

- Gateway extension is mechanical: extend `GITHUB_SUPPORTED_EVENTS`
  allowlist (`packages/gateway/src/github.ts:105-109`) and add a
  `check_suite` variant to the zod-discriminated `GitHubQueuedPayload`
  (`v: 2` envelope).
- Runner is **not modified**. Gate lives entirely in the gateway,
  alongside the existing supported-events check and correlationKey
  resolution in `packages/gateway/src/{app,service}.ts`.
- Git is sandboxed inside OpenCode and accessed via `remote-cli`. The
  gateway already calls `remote-cli` for MCP approvals; the sibling
  `internal-exec-endpoint` plan adds `internalExec()` to
  `packages/gateway/src/service.ts`. The CI gate is a second consumer
  of that client.
- `THOR_GIT_AUTHOR_EMAIL` becomes a new gateway env var (the gateway
  doesn't set git config today; it only reads commits authored by
  Thor in OpenCode workspaces).
- Test the gate as a pure-ish helper that takes an `internalExec`
  function + sha + expected email; stub `internalExec` for unit
  coverage. No new E2E scaffolding needed.
- No architectural blockers identified.

## References

- /autoplan review of the original combined plan (commit 3457b3b0):
  CEO consensus 5/6 confirmed plan needs replan; Eng review surfaced 3
  HIGH and 4 MEDIUM implementation concerns.
- Sibling plan `docs/plan/2026042702_github-event-passthrough.md` — the
  pass-through refactor that ships first, independently.

## Phases

Each phase = one commit. Phases land in order; later phases assume earlier phases are merged. Per AGENTS.md, run unit tests against the phase exit criteria before moving on; push at the end for E2E verification.

### Phase 1 — Accept `check_suite.completed` at the gateway

**Goal:** the gateway parses, schema-validates, and forwards `check_suite.completed` events end-to-end without a gate. Wake fires on every CI completion for repos in the existing GitHub install. Safe to merge because Phase 4 will gate it per-repo before any production rollout.

Files:

- `packages/gateway/src/github.ts`
  - Add `check_suite` to `GITHUB_SUPPORTED_EVENTS`.
  - Define `CheckSuiteCompletedEventSchema` (zod) and `CheckSuiteCompletedEvent` type. Discriminator: top-level `check_suite` object with `head_sha`, `head_branch`, `conclusion`, `pull_requests[]`. Also `action: "completed"`, `repository`, `installation`, `sender`.
  - Extend `GitHubWebhookEnvelopeSchema` discriminated union to include the new variant.
  - `isCheckSuiteCompletedEvent` type guard.
  - `getGitHubEventType` returns `"check_suite"` for the new variant.
  - `getGitHubEventBranch` returns `event.check_suite.head_branch` (may be null — fall through to pending-branch resolve key).
  - `getGitHubEventNumber` returns `event.check_suite.pull_requests[0]?.number ?? 0` (used only for pending-branch resolve fallback; `head_branch` should be present for normal cases).
  - `getGitHubEventSourceTs` returns `Date.parse(event.check_suite.updated_at)`.
  - `shouldIgnoreGitHubEvent` returns `null` for `check_suite` (filtering happens in Phase 2 git gate).
- `packages/gateway/src/service.ts`
  - `renderGitHubPromptLine` adds a branch for `check_suite`: `[CI] ${conclusion} on ${repoFullName}@${head_sha.slice(0,7)} (branch ${head_branch ?? "?"})`. Failure variant deferred to Phase 3.

Tests:

- `packages/gateway/src/github.test.ts`
  - `CheckSuiteCompletedEventSchema` parses a real GitHub fixture (success and failure conclusions).
  - `getGitHubEventType` / `getGitHubEventBranch` / `getGitHubEventSourceTs` for the new variant.
- `packages/gateway/src/app.test.ts`
  - End-to-end: POST `check_suite` payload → `writeGitHubWebhookHistory("ingested", …)` and `queue.enqueue` called with `payload.event.check_suite.head_sha` reachable.

Exit criteria:

- Unit tests green.
- `check_suite.completed` no longer hits `event_unsupported`; queued payload carries the raw event.

### Phase 2 — Git gate via `internalExec()`

**Goal:** before enqueuing a `check_suite.completed` event, verify the `head_sha` exists in the workspace AND was authored by Thor's bot. Drop with a structured ignored-history entry otherwise.

Files:

- Env wiring: `THOR_GIT_AUTHOR_EMAIL` (no default).
  - `packages/gateway/src/index.ts` — add to env loader; fail-fast if absent (consistent with `THOR_INTERNAL_SECRET` / `GITHUB_APP_BOT_ID` patterns).
  - `.env.example`, `docker-compose.yml` (gateway service env), e2e workflows (mint a test value).
- New helper `verifyThorAuthoredSha` in `packages/gateway/src/github-gate.ts` (new file):
  ```
  type GateResult =
    | { ok: true }
    | { ok: false; reason: "sha_missing" | "author_mismatch" | "exec_failed" };
  async function verifyThorAuthoredSha(input: {
    internalExec: InternalExecClient;
    directory: string;
    sha: string;
    expectedEmail: string;
  }): Promise<GateResult>;
  ```

  - Calls `internalExec({ bin: "git", args: ["cat-file", "-e", sha], cwd: directory, timeoutMs: 5000 })` — non-zero exit → `sha_missing`.
  - Calls `internalExec({ bin: "git", args: ["log", "-1", "--format=%ae", sha], cwd: directory, timeoutMs: 5000 })` — compares stdout (trimmed) to `expectedEmail` case-insensitively → `author_mismatch` on miss.
  - Network/timeout/exec failure → `exec_failed`.
- `packages/gateway/src/app.ts`
  - After the existing `shouldIgnoreGitHubEvent` block, when `eventType === "check_suite"`: resolve `directory = resolveRepoDirectory(localRepo)` (already trusted at this point), call `verifyThorAuthoredSha`. On failure, `writeGitHubWebhookHistory("ignored", { reason: "check_suite_gate_failed", metadata: { ..., gateReason } })` and `logGitHubIgnored`.
  - Plumb the `internalExec` client (already on `service.ts`) through `GatewayAppConfig` if not already exposed; fall back to a no-op stub in tests that always returns `{ ok: false, reason: "exec_failed" }` unless overridden.
- New `IgnoreReason` value: `"check_suite_gate_failed"` in `packages/gateway/src/github.ts`.

Tests:

- `packages/gateway/src/github-gate.test.ts` — stub `internalExec`, cover all four `GateResult` branches.
- `packages/gateway/src/app.test.ts` — `check_suite` event, gate succeeds → enqueued; gate fails (each reason) → ignored history entry + 200 response.

Exit criteria:

- Unit tests green.
- A `check_suite` event whose `head_sha` is unknown to the workspace OR not authored by `THOR_GIT_AUTHOR_EMAIL` is dropped before enqueue.

### Phase 3 — Failure-conclusion prompt

**Goal:** Thor reacts to CI failure instead of hanging. Same Q2+Q3 gate applies; only the prompt rendering changes.

Files:

- `packages/gateway/src/service.ts`
  - `renderGitHubPromptLine` for `check_suite`: branch on `conclusion`. Success: existing line from Phase 1. Failure (anything other than `success` once `status === "completed"`): `"[CI] FAILED on ${repoFullName}@${head_sha.slice(0,7)} (branch ${head_branch}, conclusion ${conclusion}). Investigate and fix."`. Include `pull_requests[0]?.html_url` if present.

Tests:

- `packages/gateway/src/service.test.ts` — `renderGitHubPromptLine` for `success`, `failure`, `cancelled`, `timed_out`, `action_required`.

Exit criteria:

- Both prompt shapes render correctly. No new gate logic — failure events flow the same gate as success events.

### Phase 4 — Per-repo opt-in

**Goal:** `check_suite` ingestion is off by default. Only repos explicitly listed in workspace config receive the wake.

Files:

- `packages/common/src/workspace-config.ts`
  - Add `githubCheckSuiteRepos?: string[]` (or `Set<string>`) to the workspace config schema. Empty/missing = disabled for all repos.
  - Helper `isCheckSuiteEnabled(config, localRepo): boolean`.
- `packages/gateway/src/app.ts`
  - In the `check_suite` path, before the git gate, call `isCheckSuiteEnabled(config.getConfig?.() ?? {}, localRepo)`. If false, log and write `writeGitHubWebhookHistory("ignored", { reason: "check_suite_repo_not_enabled" })`.
- New `IgnoreReason` value: `"check_suite_repo_not_enabled"`.

Tests:

- `packages/common/src/workspace-config.test.ts` — `isCheckSuiteEnabled` with missing config, empty list, matching repo, non-matching repo.
- `packages/gateway/src/app.test.ts` — opt-in test: same `check_suite` event ignored when repo not in list, accepted when it is.

Exit criteria:

- Default config = no repos receive `check_suite`. Explicit allowlist required.
- Unit tests green.

### Phase 5 — Runbook + integration verification

**Goal:** documented and verified end-to-end.

Files:

- `docs/github-app-webhooks.md`
  - Document the new `check_suite` subscription requirement on the GitHub App.
  - `THOR_GIT_AUTHOR_EMAIL` env var.
  - Per-repo opt-in via `githubCheckSuiteRepos` in workspace config.
  - Troubleshooting: how to read `writeGitHubWebhookHistory` worklogs for `check_suite_gate_failed` / `check_suite_repo_not_enabled`.
- `README.md` — add the env var to the gateway section.

Verification:

- Push the branch; ensure unit-tests + core-e2e + sandbox-e2e workflows pass.
- Manual: in a sandbox repo, opt in via config, push a Thor-authored commit, wait for CI, observe a wake. Push a non-Thor commit, wait for CI, observe an ignored history entry with `check_suite_gate_failed` (author_mismatch).

Exit criteria:

- All required CI green on the branch.
- One manual end-to-end verification recorded in this plan's Decision Log below.

## Decision Log

| #   | Decision                                                                             | Rationale                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Gate at the gateway, not the runner                                                  | Gateway already has `directory`, `internalExec()`, and the supported-events check. Runner stays unchanged. Rejected events never enqueue. |
| D-2 | `check_suite.completed` only; not `workflow_run` or `check_run`                      | Single rollup per commit eliminates multi-workflow fan-out. Native `pull_requests[]` association.                                         |
| D-3 | No notes-file `head_sha` schema; no woken-flag                                       | Provenance lives in git. `check_suite` fires once per (commit, app); reruns _should_ re-wake.                                             |
| D-4 | Author check via `git log -1 --format=%ae` against `THOR_GIT_AUTHOR_EMAIL`           | Webhook actor fields don't help on `check_suite` (`sender` is the CI app). Git is the source of truth for authorship.                     |
| D-5 | Per-repo opt-in, off by default                                                      | Mirrors Slack channel allowlist pattern. Limits blast radius of a misconfiguration; explicit consent per repo before wakes start.         |
| D-6 | Phase 1 ships unguarded but acceptable because Phase 4 gates per-repo before rollout | Keeps each phase small and reviewable. No production traffic flows until Phase 4 lands. Branch is feature-flag-equivalent until then.     |

## Out of scope

- `workflow_run` / `workflow_job` / `deployment_status` / `repository_dispatch` — not selected.
- Retries on transient `internalExec` failures. Phase 2 treats any non-success as drop. If false-negative rate becomes a problem, add bounded retry in a follow-up.
- Coalescing repeated `check_suite` events for the same `head_sha`. Not observed as a problem; revisit if rerun storms become noisy.
- Surfacing CI logs to Thor in the failure prompt. Phase 3 forwards the `conclusion` and PR URL only; Thor can fetch logs via `gh` if needed.
