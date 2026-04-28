# Wake Thor on green CI — design plan

**Date**: 2026-04-27
**Status**: Design decided — ready to plan implementation
**Updated**: 2026-04-28 (decisions recorded; Q2/Q3 land at the gateway via the `/internal/exec` endpoint)
**Depends on**: https://github.com/scoutqa-dot-ai/thor/pull/47 — adds `THOR_INTERNAL_SECRET` + `POST /internal/exec` + gateway `internalExec()` client

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
- ⏸ Hard dependency: https://github.com/scoutqa-dot-ai/thor/pull/47 must land first
- ✅ Failure-forwarding: forward with distinct prompt shape (Q5)
- ⏭ Operator runbook update (`docs/github-app-webhooks.md`) — implementation phase
- ⏭ Rollout: per-repo opt-in via Slack-style `getConfig` allowlist, off by default — implementation phase

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

## Out of scope (this design plan)

- Implementation. This plan ends at "decisions recorded, ready to plan
  implementation." A separate implementation plan should sequence:
  (0) **prereq**: https://github.com/scoutqa-dot-ai/thor/pull/47 lands,
  (1) gateway `check_suite` allowlist + zod variant,
  (2) gateway git-gate helper consuming `internalExec()`
  (sha-exists + author-email match) + `THOR_GIT_AUTHOR_EMAIL` env,
  (3) failure prompt shape,
  (4) per-repo config gate,
  (5) runbook update.
- `workflow_run` / `workflow_job` / `deployment_status` /
  `repository_dispatch` — not selected.
