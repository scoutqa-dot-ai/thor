# Wake Thor on green CI — design plan

**Date**: 2026-04-27
**Status**: Design — not ready to implement

## Problem

Today the gateway drops `workflow_run` / `workflow_job` / `check_run` /
`check_suite` as `event_unsupported`. Operationally we want: when CI passes
on a Thor-authored PR, Thor wakes up to take the next step (open the PR,
continue the task, react to results).

A naive implementation (allowlist `workflow_run`, gate on
`triggering_actor.id` + `pull_requests[]`) was drafted and reviewed by
/autoplan; both CEO voices flagged fundamental issues. This plan parks the
implementation pending a design decision.

## Open design questions

### 1. Which event primitive?

Options to evaluate:

- **`workflow_run.completed`** — fires per workflow. Multi-workflow repos
  fan out. `pull_requests[]` is eventually consistent and empty for forks.
  `head_branch` can be null for tag-triggered or detached-ref runs.
- **`check_suite.completed`** — rolls up *all* checks for a commit into
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

### 2. Self-loop guard

Thor pushes → CI green → Thor wakes → Thor pushes → loop. The current
gateway delivers GitHub events with `interrupt: true`, which means a wake
*aborts* the in-flight session. There's no `head_sha` dedupe today.

Options:

- Dedupe at runner: per `(correlationKey, head_sha)` — first wake for a
  given sha proceeds; subsequent ones drop.
- Rate-limit at gateway: per `head_sha` per minute.
- Session-state correlation: the runner tracks "I am awaiting CI on sha X";
  only that wake matches.

Recommendation lean: runner-side `(correlationKey, head_sha)` dedupe via
notes file; cheapest, observable.

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

### 4. Multi-workflow granularity

If `workflow_run` is chosen, three workflows = three wakes. `check_suite`
collapses this naturally. If `workflow_run` wins anyway, debounce per
`head_sha` at the gateway (with a flush trigger when the *last* expected
workflow completes — but knowing "last" requires knowing the workflow
list, which the gateway doesn't have).

### 5. Failure handling

If CI fails, does Thor stay asleep forever waiting on a green that never
comes? Or do we forward terminal non-success as a "stop waiting" signal?

Recommendation lean: forward conclusion=failure with a distinct prompt
shape ("CI failed on sha X, branch Y") so Thor can react instead of hang.

## Required before implementation

- Pick the primitive (Q1) with explicit comparison.
- Specify the self-loop guard (Q2) with placement (gateway vs runner).
- Specify the authorship proxy (Q3).
- Decide failure-forwarding policy (Q5).
- Update operator runbook (`docs/github-app-webhooks.md`) accordingly.
- Plan the rollout — feature flag? Allowlist by repo? Off by default?

## References

- /autoplan review of the original combined plan (commit 3457b3b0):
  CEO consensus 5/6 confirmed plan needs replan; Eng review surfaced 3
  HIGH and 4 MEDIUM implementation concerns.
- Sibling plan `docs/plan/2026042702_github-event-passthrough.md` — the
  pass-through refactor that ships first, independently.

## Out of scope (this design plan)

- Implementation. This plan ends at "decision recorded, ready to plan
  implementation."
- `workflow_job` / `deployment_status` / `repository_dispatch` if they're
  not selected as the primitive.
