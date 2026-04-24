# GitHub Webhook Review Fixes

**Date**: 2026-04-24
**Status**: In progress

## Goal

Address three post-review correctness issues in the GitHub webhook implementation:

1. release the branch queue key immediately after accepted GitHub triggers so later interrupting events can reach the runner
2. dead-letter exhausted PR-head resolution failures instead of retrying forever
3. make GitHub App installation lookup case-insensitive for operator-provided org keys

## Phases

### Phase 1 — Case-insensitive installation lookup

- make `getInstallationIdForOrg()` robust to mixed-case `orgs` keys in workspace config
- add focused common + remote-cli tests

**Exit criteria:**

- [ ] mixed-case org keys resolve correctly
- [ ] targeted tests pass

### Phase 2 — Terminal PR-head resolution exhaustion

- convert exhausted timeout/5xx/network PR-head lookup failures into terminal branch-resolution failures
- add focused gateway tests for dead-letter behavior after retry budget exhaustion

**Exit criteria:**

- [ ] exhausted PR-head failures dead-letter once
- [ ] no infinite retry expectation remains in tests

### Phase 3 — Immediate GitHub trigger acceptance

- stop awaiting the runner response body inline after GitHub trigger acceptance
- consume/cancel the body asynchronously so the queue key is released immediately
- add focused tests proving later interrupting events can proceed

**Exit criteria:**

- [ ] accepted GitHub trigger returns before body completion
- [ ] interrupting same-branch GitHub event can reach runner while prior stream is still open
- [ ] targeted tests pass

## Out of scope

- changes to Slack or cron trigger semantics
- broader queue architecture refactors
- new GitHub webhook event types
