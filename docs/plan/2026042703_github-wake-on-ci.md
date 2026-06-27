# Wake Thor on terminal CI

**Date**: 2026-04-27
**Status**: Ready to implement (Phase 0)
**Depends on**: `THOR_INTERNAL_SECRET` + `POST /internal/exec` endpoint on `remote-cli` (landed).

## Problem

Today the gateway drops `workflow_run` / `workflow_job` / `check_run` /
`check_suite` as `event_unsupported`. Operationally we want: when CI reaches
any terminal outcome on a Thor-authored PR, Thor wakes up to take the next step
(open the PR, continue the task, react to results, or simply record success).

## Wake-time gate (no schema change)

The gate lives entirely in the gateway; the runner is not modified.

When `check_suite.completed` arrives for `git:branch:<repo>:<head_branch>`,
`head_sha=X`, the webhook route does cheap signature/schema/repo/session
routing and enqueues the event under an isolated pending key
(`pending:check-suite:<repo>:<prNumber>:<branch>`) so GitHub is not kept
waiting. During pending-key queue processing, the gateway resolves the
workspace `directory` and runs the gate via the `internalExec()` client
(`POST /internal/exec` on `remote-cli`):

1. Correlation key match — does `git:branch:<repo>:<head_branch>` resolve to
   an existing notes-backed session/correlation key?
2. `git cat-file -e X` — does this sha exist in the workspace's git?
3. `git log -1 --format=%ae X` — is the author email Thor's bot identity?
4. PR-wide `gh pr checks <pr>` — are all PR checks terminal?

The session match admits the pending queue item. The git checks plus the
PR-wide checks gate must pass before the event is rerouted to the real branch
key with the terminal outcome payload (`interrupt: false`), augmented with a
namespaced `thor.pr_checks` / `thor.pr_checks_summary` block so OpenCode sees
final PR-wide status. Any failure (incl. exec timeout / non-zero exit)
dead-letters the pending check-suite batch with a structured log line; PR
checks still non-terminal cause a drop (see below).

Design rationale:

- **`check_suite.completed`, not `workflow_run`/`check_run`** — single rollup
  per commit, native `pull_requests[]` association, fires once per (commit,
  app), eliminating multi-workflow fan-out.
- **Provenance lives in git** — no notes-file `head_sha` schema, no
  "mark sha as woken" flag, no sidecar drift. The feared self-loop
  ("wake → push same sha → wake") isn't a real path: Thor doesn't push
  identical shas, and `check_suite` doesn't fire on comments or non-CI pushes.
  Reruns _should_ re-wake (CI re-passing after a fix is exactly when Thor
  should react).
- **Git-author check, not webhook actor fields** — sender-based gating on
  `check_suite` doesn't work: `sender` is the CI app (e.g.,
  `github-actions[bot]`), not the pusher, and there is no clean `pusher`/`actor`
  field. The bot email is derived once in `@thor/common` from
  `GITHUB_APP_BOT_ID` + `GITHUB_APP_SLUG` so gateway and remote-cli cannot drift.
- **Forward every terminal outcome** — success, neutral, skipped, cancelled,
  and stale all end the waiting state. The JSON-passthrough renderer forwards
  the raw event including `conclusion`; the agent decides actionability
  (success-like → silence/log-only, failure-like → investigate/fix). The
  gateway does not encode "actionable" as "failed only".
- **Pending key isolates CI wakes from branch batches** — batch-level
  `ack`/`reject` is coarse, so running the PR-check gate inside a normal
  `git:branch:<repo>:<branch>` batch could delay or dead-letter unrelated user
  comments/reviews sharing the branch lock. The pending-key dispatcher owns the
  SHA gate and `gh pr checks` polling; only it reroutes terminal events onto the
  branch key. Normal branch batches never run PR-wide check polling.
- **Drop, don't defer, when PR checks are still pending** — multi-suite PRs
  keep firing `check_suite.completed` until the last suite finishes, and that
  final event already sees terminal `gh pr checks` and dispatches on its own.
  Dropping the still-pending events (with a structured log line) avoids the
  defer-and-poll machinery (`readyAt` reschedule, `deferFiles`,
  `BatchDispatchPlan.defer`, retry-delay config). Lookup failures also drop.

### Rejected alternatives

- **Runner-side polling/subscription** keyed by `head_sha` — premature
  complexity; gateway pass-through is the established pattern.
- **Notes-file `(correlationKey, head_sha)` dedupe / woken-flag** — extra
  write paths on every push; git already holds provenance.
- **`triggering_actor.id` / `actor.id` gating** — neither answers "did Thor
  author this commit"; both drop legitimate rerun cases, and neither field
  exists usefully on `check_suite`.
- **Per-event queue settlement** (replacing batch-level ack/defer/reject) — the
  more general long-term model, but it changes the core `EventQueue` handler
  contract, partial-settlement logging, busy-retry semantics, and flush
  behavior. Defer to a future queue refactor.
- **Defer-and-poll escape hatch** — if GitHub fails to deliver the _last_
  `check_suite.completed` for a PR, no dispatch happens. Accepted as safe given
  GitHub retries and multi-suite PRs giving multiple chances. If missed
  dispatches become observable, subscribe to additional events
  (`check_run.completed`, `workflow_run.completed`, `status`) and treat each as
  a "re-query `gh pr checks`" ping deduped by the PR-branch pending key —
  webhook carries no state, `gh pr checks` is the single source of truth. This
  is the planned escape hatch, not a near-term change.

## Feasibility notes

- Gateway extension is mechanical: extend the `GITHUB_SUPPORTED_EVENTS`
  allowlist in `packages/gateway/src/app.ts` and add a `check_suite` variant to
  the zod-discriminated parsed GitHub webhook event. Runner is **not modified**.
- `check_suite` must resolve to an existing notes-backed branch correlation key
  before pending enqueue. Existing `resolveCorrelationKeys()` returns the raw
  key when nothing matches, so the implementation needs either a strict resolver
  (`resolveCorrelationKeyMatch`) or an explicit `findNotesFile(resolvedKey)`
  check to distinguish "matched" from "fallback". This stricter gate is specific
  to `check_suite`: CI completion should resume Thor's own in-progress branch
  work, not create a brand-new branch session from an ambient GitHub event.
  Existing mention/review events intentionally can start new sessions.
- Git is sandboxed inside OpenCode and accessed via `remote-cli`. The gateway
  already calls `remote-cli` for MCP approvals; the `/internal/exec` endpoint
  exists, but the gateway `internalExec()` client helper does not yet (Phase 2).
- Test the gate as a pure-ish helper that takes an `internalExec` function +
  sha + expected email; stub `internalExec` for unit coverage. No new E2E
  scaffolding needed. No architectural blockers identified.

## References

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
  - For `check_suite`, build `rawKey = buildCorrelationKey(localRepo, head_branch)`, resolve it, and require a positive existing-session match before enqueueing under the pending check-suite key. Do not rely on `resolveCorrelationKeys([rawKey])` alone, because that function intentionally falls back to `rawKey` when nothing resolves.
  - Use either a strict resolver (`resolveCorrelationKeyMatch`) or `findNotesFile(resolvedKey)` after resolution. If no existing notes-backed session is found, write ignored history with `reason: "correlation_key_unresolved"` and do not enqueue.
  - Enqueue accepted `check_suite.completed` events under the pending check-suite key with `interrupt: false`. CI completion should resume/coalesce with the existing branch session only after pending-key gates reroute it. Keep existing GitHub mention/review events on their current `interrupt: true` behavior.
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
  - Existing-session path: POST `check_suite` payload with a notes-backed branch key → `writeGitHubWebhookHistory("ingested", …)` and `queue.enqueue` called with the pending check-suite key and `payload.check_suite.head_sha` reachable.
  - Unknown-session path: same payload without a matching notes file → ignored with `correlation_key_unresolved`, no enqueue.

Exit criteria:

- Unit tests green.
- `check_suite.completed` no longer hits `event_unsupported`.
- A branchless event or an event whose branch has no existing notes-backed session is ignored before enqueue.
- A queued payload carries the raw event, uses the pending check-suite key, records the resolved branch correlation key, and has `interrupt: false`.

### Phase 2 — Git gate via `internalExec()`

**Goal:** before branch dispatching a queued `check_suite.completed` event that
already passed Phase 1's existing-session gate, verify that the `head_sha`
exists in the workspace and the commit was authored by Thor's bot. Dead-letter
the pending check-suite batch otherwise.

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

- `packages/gateway/src/service.ts`
  - During pending-key queue processing for `check_suite`: resolve `directory = resolveRepoDirectory(localRepo)` (already trusted at this point), then call `verifyThorAuthoredSha`. On failure, dead-letter with `reason: "check_suite_gate_failed"`.
  - Plumb the new `internalExec` client through `GatewayAppConfig` if needed for tests; fall back to the real HTTP client in production.
- New `IgnoreReason` value: `"check_suite_gate_failed"` in `packages/gateway/src/github.ts`.

Tests:

- `packages/gateway/src/github-gate.test.ts` — stub `internalExec`, cover all four `GateResult` branches.
- `packages/gateway/src/app.test.ts` — `check_suite` event, pending enqueue succeeds; queued gate succeeds → branch reroute; queued gate fails (each reason) → dead-letter entry.

Exit criteria:

- Unit tests green.
- A `check_suite` event whose `head_sha` is unknown to the workspace OR whose commit is not authored by the derived GitHub App bot email is dead-lettered before branch dispatch.

### Phase 3 — Agent-side handling of CI outcomes

**Goal:** Thor reacts to CI failure instead of hanging, while treating success-like outcomes as silent/log-only by default. With the JSON-passthrough renderer (Phase 0), the gateway forwards the full `check_suite` event including `conclusion`; the agent reads it and decides. No gateway-side prompt-shape work needed.

Files:

- `docker/opencode/config/agents/build.md` — document how to interpret a `check_suite` event in the inbound payload, including the `conclusion` field, and what action to take per outcome (success/neutral/skipped → prefer silence/log-only unless a human is waiting; failure/timed_out/action_required → investigate and fix; cancelled/stale → normally log/reorient unless evidence points to an actionable failure).

Tests:

- No new unit tests at the gateway. Coverage of the `check_suite` JSON envelope already exists from Phase 1.

Exit criteria:

- Agent docs updated. Manual smoke (in Phase 4 verification) confirms Thor reacts sensibly to both success/log-only and failure/action events.

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

The core gate decisions and their rationale are captured in "Wake-time gate"
above. The rows below record the non-obvious safety/scope tradeoffs and a slot
for the manual end-to-end verification.

| #   | Decision                                                                      | Rationale                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | No per-repo opt-in; rollout to all repos on the install                       | Existing-session + git-author gating is the safety filter. Git author email is spoofable, but a wake also requires an existing Thor notes-backed branch session, which is acceptable for this wake path. Add per-repo gating later only if a real misfire pattern emerges.                                                                   |
| D-2 | Phase 1 is deployable on its own                                              | Phase 1 ships the existing-session gate but not the sha/author checks. It still cannot create a new session from an ambient CI event; Phase 2 tightens the gate before broader rollout validation.                                                                                                                                           |
| D-3 | GitHub prompt is `JSON.stringify(rawEvent)`; drop `GITHUB_PROMPT_LIMIT_BYTES` | Slack already passes raw events; per-field rendering was pre-passthrough cruft, and the agent decides. Zod strips unknown keys so parsed events are tiny; only `comment.body`/`review.body` are unbounded, and dropping whole events to fit a batch limit is worse than passing one large body. Cap fields at parse time if it ever matters. |
| D-4 | Manual end-to-end verification                                                | _To be recorded here after Phase 4: push a Thor-authored commit and observe a wake; push a non-Thor commit and observe an ignored history entry with `check_suite_gate_failed` (author_mismatch)._                                                                                                                                           |

## Out of scope

- `workflow_run` / `workflow_job` / `deployment_status` / `repository_dispatch` — not selected.
- Retries on transient `internalExec` failures. Phase 2 treats any non-success as drop. If false-negative rate becomes a problem, add bounded retry in a follow-up.
- Coalescing across different PR branches. Pending check-suite coalescing is PR-branch scoped.
- Surfacing CI logs to Thor in the prompt. The forwarded JSON includes `conclusion` and `pull_requests[]` URLs; Thor can fetch logs via `gh` if needed.
