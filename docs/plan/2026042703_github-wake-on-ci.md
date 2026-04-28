# Wake Thor on green CI

**Date**: 2026-04-27
**Status**: Ready to implement (Phase 0)
**Updated**: 2026-04-28 (PR #47 merged into branch; phases expanded)
**Depends on**: ~~https://github.com/scoutqa-dot-ai/thor/pull/47~~ ✅ landed — provides `THOR_INTERNAL_SECRET` + `POST /internal/exec` endpoint

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

| #       | Question                | Decision                                                                                                                                                                                                       |
| ------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1      | Event primitive         | **`check_suite.completed`** — single rollup per commit, native PR association, eliminates Q4 fan-out                                                                                                           |
| Q2      | Self-loop guard         | **Gateway-side `git cat-file -e <head_sha>`** via `internalExec()` against the workspace directory before enqueue. No notes schema change, no woken-flag                                                       |
| Q3      | Bot authorship          | **Gateway-side `git log -1 --format=%ae <head_sha>`** via `internalExec()`, matched against the GitHub App bot email derived from `GITHUB_APP_BOT_ID` + `GITHUB_APP_SLUG`. Both Q2 and Q3 must pass to enqueue |
| Q4      | Multi-workflow debounce | **Not applicable** — eliminated by Q1 choice                                                                                                                                                                   |
| Q5      | Failure handling        | **Forward terminal non-success** in the JSON event payload so Thor reacts instead of hangs. Same Q2+Q3 gate applies                                                                                            |
| Rollout | Gating                  | **All repos on the GitHub App install.** No per-repo opt-in for now; existing-session + git-author gates are the rollout safety filter                                                                         |

### Wake-time gate (no schema change)

When `check_suite.completed` arrives at the gateway for `correlationKey=K`,
`head_sha=X`, the gateway resolves the workspace `directory` from K (same
path as for any other GitHub event) and runs two git checks via the
`internalExec()` client (`POST /internal/exec` on `remote-cli`):

1. Correlation key match — does `git:branch:<repo>:<head_branch>` resolve to
   an existing notes-backed session/correlation key?
2. `git cat-file -e X` — does this sha exist in the workspace's git?
3. `git log -1 --format=%ae X` — is the author email Thor's bot identity?

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
`git log -1 --format=%ae <head_sha>` against the GitHub App bot
email derived from `GITHUB_APP_BOT_ID` + `GITHUB_APP_SLUG`.
Webhook actor fields can't help here: `check_suite.sender` is the CI
app (e.g., `github-actions[bot]`), not the pusher, and there is no
clean `pusher`/`actor` field on `check_suite`.

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

Recommendation lean: forward conclusion=failure so Thor can react
instead of hang.

**Decision: forward terminal non-success.** With the JSON-passthrough
renderer, no gateway-specific failure prompt shape is needed; the agent
reads `check_suite.conclusion` from the raw event. Same Q2+Q3 git gate
applies. No "woken" flag needed — reruns naturally re-wake.

## Implementation prerequisites (resolved)

- ✅ Primitive: `check_suite.completed` (Q1)
- ✅ Self-loop guard: existing correlation key + gateway `internalExec()` → `git cat-file -e` (Q2)
- ✅ Authorship proxy: gateway `internalExec()` → `git log -1 --format=%ae` (Q3)
- ✅ Hard dependency: PR #47 landed (`/internal/exec` endpoint)
- ✅ Failure-forwarding: forward the raw JSON event including `conclusion` (Q5)
- ⏭ Operator runbook update (`docs/github-app-webhooks.md`) — Phase 4
- ✅ Rollout: all repos on the install. Existing-session + git-author gates are the safety filter (D-5); per-repo gating not introduced.

## Feasibility notes (from 2026-04-28 review)

- Gateway extension is mechanical: extend `GITHUB_SUPPORTED_EVENTS`
  allowlist (`packages/gateway/src/app.ts:137-141`) and add a
  `check_suite` variant to the zod-discriminated parsed GitHub webhook event.
- Runner is **not modified**. Gate lives entirely in the gateway,
  alongside the existing supported-events check and correlationKey
  resolution in `packages/gateway/src/{app,service}.ts`.
- `check_suite` must resolve to an existing notes-backed correlation key
  before enqueue. Existing `resolveCorrelationKeys()` returns the raw key
  when nothing matches, so the implementation needs either a strict resolver
  (`resolveCorrelationKeyMatch`) or an explicit `findNotesFile(resolvedKey)`
  check to distinguish "matched" from "fallback".
- This stricter existing-notes gate is specific to `check_suite`. Existing
  GitHub mention/review events intentionally can start new sessions when a
  user mentions the app or when Thor-authored PR review activity arrives.
  CI completion is different: it should resume Thor's own in-progress branch
  work, not create a brand-new branch session from an ambient GitHub event.
- Git is sandboxed inside OpenCode and accessed via `remote-cli`. The
  gateway already calls `remote-cli` for MCP approvals, and PR #47 added
  `POST /internal/exec` on `remote-cli`. This plan must add the gateway
  `internalExec()` client as part of Phase 2; the endpoint exists, but the
  client helper does not yet.
- Gateway and remote-cli must derive the GitHub App bot git email through
  one shared helper in `@thor/common`, using `GITHUB_APP_BOT_ID` +
  `GITHUB_APP_SLUG`. Do not add a separate `THOR_GIT_AUTHOR_EMAIL`
  env var; it would drift from the identity remote-cli already uses when
  configuring git.
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

### Phase 0 — Align GitHub prompt rendering with Slack (`JSON.stringify`)

**Goal:** drop the bespoke `renderGitHubPromptLine` field-extraction. Slack already passes raw events to the agent via `JSON.stringify` (`service.ts:147-153`); GitHub had its own per-field renderer left over from when `NormalizedGitHubEvent` carried pre-extracted fields. With raw passthrough in place (commits `869861bf`, `6fb218a0`), per-field rendering is pointless work that the agent can do better itself.

This is independent of `check_suite` and worth landing on its own merits — it shrinks Phase 1 (the `check_suite` variant works for free) and eliminates Phase 3 entirely (no failure-prompt shape to differentiate; the agent reads `conclusion` from the JSON).

Files:

- `packages/gateway/src/service.ts`
  - Replace `renderGitHubPromptLine` + `renderGitHubPrompt` with a single function that mirrors `renderSlackPrompt`:
    ```ts
    function renderGitHubPrompt(events: GitHubWebhookEvent[]): string {
      return JSON.stringify(events.length === 1 ? events[0] : events);
    }
    ```
  - Drop the byte-limit truncation entirely. Remove `GITHUB_PROMPT_LIMIT_BYTES`, the `while`-loop, and the `github_prompt_truncated` log call. Zod schemas (`github.ts:32-79`) strip unknown keys at parse time, so each event is already a tiny declared subset; the only unbounded field is free-text `comment.body` / `review.body`, and dropping whole events is a worse failure mode than letting one large body through. If field-level bounds become necessary later, cap `body` at parse time rather than reintroducing batch truncation.
  - Remove now-unused imports (`getGitHubEventNumber`, `isIssueCommentEvent`, `isPullRequestReviewCommentEvent`, `truncate`, `GITHUB_PROMPT_EVENT_BODY_MAX`).
- `packages/gateway/src/service.test.ts`
  - Replace per-field assertions on `renderGitHubPromptLine` output with JSON-shape assertions (parse the rendered prompt, check it equals the input event/array).
  - Delete the truncation test.

Tests:

- All existing GitHub-prompt tests rewritten to JSON shape.
- Single-event vs multi-event rendering (single event = object, multiple = array).

Exit criteria:

- `pnpm test` green.
- No `renderGitHubPromptLine` / `GITHUB_PROMPT_LIMIT_BYTES` / `github_prompt_truncated` references in source.
- Rendered prompt for any GitHub event is `JSON.stringify(rawEvent)` (or array thereof).

### Phase 1 — Accept `check_suite.completed` at the gateway

**Goal:** the gateway parses and schema-validates `check_suite.completed`
events, then forwards only events whose `head_branch` resolves to an
existing notes-backed Thor session. Phase 1 does **not** do the git sha
or git-author checks yet, but it must already include the strict
existing-session gate so an ambient CI event cannot create a brand-new
branch session.

Files:

- `packages/gateway/src/app.ts`
  - Add `check_suite` to `GITHUB_SUPPORTED_EVENTS`.
  - Add `check_suite_branch_missing` and `correlation_key_unresolved` to the local GitHub ignored-reason union and write ignored history for both cases.
  - For `check_suite`, build `rawKey = buildCorrelationKey(localRepo, head_branch)`, resolve it, and require a positive existing-session match before enqueueing. Do not rely on `resolveCorrelationKeys([rawKey])` alone, because that function intentionally falls back to `rawKey` when nothing resolves.
  - Use either a strict resolver (`resolveCorrelationKeyMatch`) or `findNotesFile(resolvedKey)` after resolution. If no existing notes-backed session is found, write ignored history with `reason: "correlation_key_unresolved"` and do not enqueue.
  - Enqueue accepted `check_suite.completed` events with `interrupt: false`. CI completion should resume/coalesce with the existing branch session without aborting in-flight work. Keep existing GitHub mention/review events on their current `interrupt: true` behavior.
- `packages/gateway/src/github.ts`
  - Define `CheckSuiteCompletedEventSchema` (zod) and `CheckSuiteCompletedEvent` type. Discriminator: top-level `check_suite` object with `head_sha`, `head_branch`, `conclusion`, `pull_requests[]`. Also `action: "completed"`, `repository`, `installation`, `sender`.
  - Make `GitHubWebhookEnvelopeSchema` a true `z.discriminatedUnion("event_type", ...)` instead of the current plain `z.union(...)`: preprocess the parsed webhook body by adding an internal `event_type` field derived from shape (`issue`, `pull_request` + `comment`, `pull_request` + `review`, or `check_suite`), then discriminate on that field. Keep the queued `event` payload as the parsed schema output, including `event_type`, so downstream type guards can use the same discriminator.
  - Extend the discriminated union to include the new `check_suite` variant.
  - `isCheckSuiteCompletedEvent` type guard.
  - `getGitHubEventType` returns `"check_suite"` for the new variant.
  - `getGitHubEventBranch` returns `event.check_suite.head_branch`.
  - If `head_branch` is null/empty, drop the event explicitly with a structured ignore reason such as `check_suite_branch_missing`. Do **not** fall through to the existing pending-branch resolve path: that path is issue-comment-specific and resolves an issue/PR number through `gh pr view` via `/internal/exec`. A `check_suite` event may contain `pull_requests[]`, but the current reroute code only accepts `IssueCommentEvent` and would drop non-issue-comment payloads as `branch_lookup_failed`.
  - `getGitHubEventNumber` should not be used for `check_suite` routing. If future support for branchless `check_suite` events is needed, add a dedicated branch resolver based on `check_suite.pull_requests[]` instead of reusing the issue-comment pending key.
  - `getGitHubEventSourceTs` returns `Date.parse(event.check_suite.updated_at)`.
  - `shouldIgnoreGitHubEvent` returns `null` for `check_suite` (branch/session filtering happens in Phase 1; git sha/authorship filtering happens in Phase 2).

No `service.ts` changes — Phase 0's `JSON.stringify` renderer handles `check_suite` automatically.

Tests:

- `packages/gateway/src/github.test.ts`
  - `CheckSuiteCompletedEventSchema` parses a real GitHub fixture (success and failure conclusions).
  - `getGitHubEventType` / `getGitHubEventBranch` / `getGitHubEventSourceTs` for the new variant.
- `packages/gateway/src/app.test.ts`
  - Existing-session path: POST `check_suite` payload with a notes-backed branch key → `writeGitHubWebhookHistory("ingested", …)` and `queue.enqueue` called with `payload.check_suite.head_sha` reachable.
  - Unknown-session path: same payload without a matching notes file → ignored with `correlation_key_unresolved`, no enqueue.

Exit criteria:

- Unit tests green.
- `check_suite.completed` no longer hits `event_unsupported`.
- A branchless event or an event whose branch has no existing notes-backed session is ignored before enqueue.
- A queued payload carries the raw event, uses the resolved existing correlation key, and has `interrupt: false`.

### Phase 2 — Git gate via `internalExec()`

**Goal:** before enqueuing a `check_suite.completed` event that already
passed Phase 1's existing-session gate, verify that the `head_sha` exists
in the workspace and the commit was authored by Thor's bot. Drop with a
structured ignored-history entry otherwise.

Files:

- Shared bot identity helper:
  - `packages/common/src/github-identity.ts` (new) — export a helper such as `deriveGitHubAppBotIdentity({ slug, botId })` returning `{ name, email }`, where email is `${botId}+${slug}[bot]@users.noreply.github.com`.
  - `packages/common/src/index.ts` — export the helper.
  - `packages/remote-cli/src/index.ts` — replace the local `deriveBotGitIdentity()` implementation with the shared helper.
  - `packages/gateway/src/index.ts` — derive the expected author email from already-required `GITHUB_APP_SLUG` + `GITHUB_APP_BOT_ID`; do not introduce `THOR_GIT_AUTHOR_EMAIL`.
- Add gateway `internalExec()` client in `packages/gateway/src/service.ts` or a small sibling module:
  - POSTs to `${remoteCliUrl}/internal/exec` with `{ bin, args, cwd }`.
  - Sends `x-thor-internal-secret` when configured.
  - Parses `ExecResultSchema`.
  - Uses gateway-side client timeouts via Node's `AbortSignal.timeout(5000)` on the `fetch()` call. This is enforced by the gateway process, not by remote-cli; remote-cli may continue the underlying command briefly after the HTTP client aborts, but the webhook decision treats the abort as `exec_failed`.
  - Treats non-2xx responses, schema failures, and thrown fetch/timeout errors as client failures.
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

  - Calls `internalExec({ bin: "git", args: ["cat-file", "-e", sha], cwd: directory })` — non-zero exit → `sha_missing`.
  - Calls `internalExec({ bin: "git", args: ["log", "-1", "--format=%ae", sha], cwd: directory })` — compares stdout (trimmed) to `expectedEmail` case-insensitively → `author_mismatch` on miss.
  - Network/timeout/exec failure → `exec_failed`.

- `packages/gateway/src/app.ts`
  - After the Phase 1 existing-session gate, when `eventType === "check_suite"`: resolve `directory = resolveRepoDirectory(localRepo)` (already trusted at this point), then call `verifyThorAuthoredSha`. On failure, `writeGitHubWebhookHistory("ignored", { reason: "check_suite_gate_failed", metadata: { ..., gateReason } })` and `logGitHubIgnored`.
  - Plumb the new `internalExec` client through `GatewayAppConfig` if needed for tests; fall back to the real HTTP client in production.
- New `IgnoreReason` value: `"check_suite_gate_failed"` in `packages/gateway/src/github.ts`.

Tests:

- `packages/gateway/src/github-gate.test.ts` — stub `internalExec`, cover all four `GateResult` branches.
- `packages/gateway/src/app.test.ts` — `check_suite` event, gate succeeds → enqueued; gate fails (each reason) → ignored history entry + 200 response.

Exit criteria:

- Unit tests green.
- A `check_suite` event whose `head_sha` is unknown to the workspace OR whose commit is not authored by the derived GitHub App bot email is dropped before enqueue.

### Phase 3 — Agent-side handling of CI failure

**Goal:** Thor reacts to CI failure instead of hanging. With the JSON-passthrough renderer (Phase 0), the gateway forwards the full `check_suite` event including `conclusion`; the agent reads it and decides. No gateway-side prompt-shape work needed.

Files:

- `docker/opencode/config/agents/build.md` — document how to interpret a `check_suite` event in the inbound payload, including the `conclusion` field, and what action to take per outcome (success → continue; failure/cancelled/timed_out → investigate and fix).

Tests:

- No new unit tests at the gateway. Coverage of the `check_suite` JSON envelope already exists from Phase 1.

Exit criteria:

- Agent docs updated. Manual smoke (in Phase 4 verification) confirms Thor reacts sensibly to both success and failure events.

### Phase 4 — Runbook + integration verification

**Goal:** documented and verified end-to-end.

Files:

- `docs/github-app-webhooks.md`
  - Document the new `check_suite` subscription requirement on the GitHub App.
  - The derived GitHub App bot email used for git-author gating (`GITHUB_APP_BOT_ID` + `GITHUB_APP_SLUG`), and why there is no separate author-email env var.
  - Troubleshooting: how to read `writeGitHubWebhookHistory` worklogs for `check_suite_gate_failed`.
- `README.md` — document that the gateway uses existing `GITHUB_APP_SLUG` + `GITHUB_APP_BOT_ID` to derive the bot author email; no new env var is required.

Verification:

- Push the branch; ensure unit-tests + core-e2e + sandbox-e2e workflows pass.
- Manual: in a real repo on the GitHub App install, push a Thor-authored commit, wait for CI, observe a wake. Push a non-Thor commit, wait for CI, observe an ignored history entry with `check_suite_gate_failed` (author_mismatch).

Exit criteria:

- All required CI green on the branch.
- One manual end-to-end verification recorded in this plan's Decision Log below.

## Decision Log

| #    | Decision                                                                            | Rationale                                                                                                                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Gate at the gateway, not the runner                                                 | Gateway already has `directory`, correlation-key resolution, `internalExec()`, and the supported-events check. Runner stays unchanged. Rejected events never enqueue.                                                                                                                                          |
| D-2  | `check_suite.completed` only; not `workflow_run` or `check_run`                     | Single rollup per commit eliminates multi-workflow fan-out. Native `pull_requests[]` association.                                                                                                                                                                                                              |
| D-3  | No notes-file `head_sha` schema; no woken-flag                                      | Provenance lives in git. `check_suite` fires once per (commit, app); reruns _should_ re-wake.                                                                                                                                                                                                                  |
| D-4  | Author check via `git log -1 --format=%ae` against the derived GitHub App bot email | Webhook actor fields don't help on `check_suite` (`sender` is the CI app). Git is the source of truth for the operational authorship heuristic. The email is derived once in `@thor/common` from `GITHUB_APP_BOT_ID` + `GITHUB_APP_SLUG` so gateway and remote-cli cannot drift.                               |
| D-5  | No per-repo opt-in for now; rollout to all repos on the install                     | Existing-session gating plus git-author gating is the rollout safety filter. Git author email is spoofable, and that is acceptable for this operational wake path because a wake also requires an existing Thor notes-backed branch session. Add per-repo gating later only if a real misfire pattern emerges. |
| D-6  | Phase 1 is deployable because it includes the existing-session gate                 | Phase 1 does not yet verify sha existence or bot authorship, but it cannot create a new session from an ambient CI event. Phase 2 tightens the gate before broader rollout validation.                                                                                                                         |
| D-7  | GitHub prompt is `JSON.stringify(rawEvent)`, mirroring Slack                        | Per-field rendering was cruft from the pre-passthrough era. Slack already passes raw events. Lets the agent decide; eliminates Phase 3 gateway work; new event types like `check_suite` cost zero rendering code.                                                                                              |
| D-8  | Drop `GITHUB_PROMPT_LIMIT_BYTES` batch truncation                                   | Zod strips unknown keys, so parsed events are already tiny. Only `comment.body`/`review.body` are unbounded; dropping whole events to fit a batch limit is a worse failure mode than passing one large body through. Cap fields at parse time if it ever matters.                                              |
| D-9  | Require existing correlation key for `check_suite` wakes                            | Dropping repo opt-in is acceptable only if `check_suite` cannot create a brand-new branch session by itself. Existing notes are the signal that Thor was already working that branch and is waiting for CI.                                                                                                    |
| D-10 | Keep existing GitHub mention/review behavior unchanged                              | Issue comments and review events are user-initiated or PR-author gated and may legitimately start work. The existing-notes requirement is only for CI completion events, which are ambient system signals.                                                                                                     |
| D-11 | `check_suite.completed` enqueues with `interrupt: false`                            | CI completion is a continuation signal for an existing branch session, not a direct user instruction. It should wake or coalesce without aborting in-flight work; user-initiated GitHub mentions/reviews keep `interrupt: true`.                                                                               |

## Out of scope

- `workflow_run` / `workflow_job` / `deployment_status` / `repository_dispatch` — not selected.
- Retries on transient `internalExec` failures. Phase 2 treats any non-success as drop. If false-negative rate becomes a problem, add bounded retry in a follow-up.
- Coalescing repeated `check_suite` events for the same `head_sha`. Not observed as a problem; revisit if rerun storms become noisy.
- Surfacing CI logs to Thor in the prompt. The forwarded JSON includes `conclusion` and `pull_requests[]` URLs; Thor can fetch logs via `gh` if needed.
