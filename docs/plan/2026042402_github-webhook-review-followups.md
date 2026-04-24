# GitHub Webhook Review Follow-ups

**Date**: 2026-04-24
**Status**: In progress

## Goal

Address two review findings in the GitHub webhook / GitHub App auth rollout:

1. re-enable GitHub App auth in the `git` / `gh` wrappers after the workspace config migration from `github_app` to `orgs`
2. preserve delivery-level dedupe for accepted GitHub webhook retries when the payload omits source timestamps

## Phases

### Phase 1 — Wrapper gating follows the new config shape

- update the `git` and `gh` wrappers to detect the migrated `orgs`-based workspace config instead of the removed `github_app` block
- add focused tests that prove wrapper auth is still activated for migrated configs

**Exit criteria:**

- [ ] `git` wrapper enables `GIT_ASKPASS` when `/workspace/config.json` contains `orgs`
- [ ] `gh` wrapper invokes the auth helper when `/workspace/config.json` contains `orgs`
- [ ] targeted tests or equivalent verification cover the migrated config path

### Phase 2 — Stable fallback timestamp for GitHub delivery dedupe

- stop using request-time `Date.now()` as the filename-affecting fallback when an accepted GitHub payload omits `created_at` / `submitted_at`
- use a stable per-delivery fallback so repeated deliveries with the same `X-GitHub-Delivery` still overwrite the queue file
- add focused tests for retry coalescing without source timestamps

**Exit criteria:**

- [ ] accepted GitHub events without payload timestamps still enqueue successfully
- [ ] repeated deliveries with the same delivery ID and no payload timestamp collapse to one queue file
- [ ] targeted tests or equivalent verification cover the missing-timestamp path

## Decision Log

| Date       | Decision | Reason |
| ---------- | -------- | ------ |
| 2026-04-24 | Treat each review finding as a separate phase and commit | Keeps rollback and audit surface aligned with the review comments |
| 2026-04-24 | Detect migrated GitHub App config from the `orgs` key in wrappers | `github_app` is removed from schema, so wrapper gating must follow the supported config shape |
| 2026-04-24 | Derive the missing-timestamp fallback deterministically from the delivery ID | Queue dedupe keys include `sourceTs`, so fallback must be stable across retries to preserve overwrite semantics |

## Out of scope

- broader GitHub webhook event-type expansion
- queue storage redesign beyond restoring current delivery dedupe guarantees
- changes to Slack or cron trigger behavior
