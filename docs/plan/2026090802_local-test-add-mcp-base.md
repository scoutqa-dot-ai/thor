# Local-test based on add-mcp, with GWS feature changes only

## Goal

Correct the integration direction at the user's request: local-test starts from add-mcp, including its existing uncommitted work, and receives only the Google Workspace feature changes. Do not fetch, pull, rebase, push, or merge newer remote-main history.

## Inputs and preservation

- Base: add-mcp `3511252` plus its unchanged working changes captured in snapshot `a60ce51` (parent `3511252`). Source status, dirty patch, and nine untracked file contents were checked against the capture before use.
- GWS feature source: the dedicated GWS files and feature-only changes from commits `809fcd6`, `7ca4560`, and `247926b`. Their newer remote-main parent is **not** part of this branch's ancestry.
- Previous local-test `fd74360` is preserved as local branch `local-test-with-remote-base` for recovery; it is not a parent of the rebuilt local-test.
- Both source worktrees and local main are left untouched.

## One integration phase

1. Start local-test at the add-mcp snapshot.
2. Replace the older GWS implementation with the feature worktree's private execution/configuration boundary, policy, skill, and tests.
3. Adapt only shared GWS wiring (HTTP route, subprocess env option, Docker, Compose, docs, and workflow definitions) to add-mcp's existing interfaces and imports.
4. Remove the superseded inline GWS policy/tests/helpers, leaving Drata, Kali, Falcon, Aikido, Jira, Slack, Neo branding/model settings, and other add-mcp changes intact.
5. Verify locally and record one local integration commit. Do not publish.

## Exit criteria

- add-mcp and its dirty snapshot are ancestors of local-test; neither `2d6a5c6` (newer remote main) nor `fd74360` (previous local-test) is an ancestor.
- Changes relative to the snapshot are confined to GWS and integration documentation.
- Local tests, typecheck, build, and isolated GWS container checks pass, or concrete inherited failures are reported without unrelated fixes.
- Source worktrees and main remain unchanged; no remote Git writes or reads are performed for this correction.

## Out of scope

Reconciliation with newer main, changing existing non-GWS integrations, live vendor authentication, deployments, scanning, CI dispatch, or PR operations.

## Decision log

| Decision                 | Choice                                                                 | Reason                                                                                               |
| ------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Base                     | add-mcp snapshot                                                       | Exact user-requested direction, including uncommitted Drata/Kali work.                               |
| Feature transfer         | Copy dedicated GWS files and port shared deltas; no branch merge       | A full merge would reintroduce unwanted newer remote-main ancestry.                                  |
| Imports and dependencies | Keep add-mcp's `.js` import convention, pnpm/SDK/server pins, and tsup | Bringing GWS does not require a main upgrade.                                                        |
| GWS overlap              | New policy/service/skill supersede the older copy                      | Retains private cwd/cache, credential checks, replacement environment, and tested read-only surface. |
| Previous work            | Preserve on a local backup branch                                      | No user work or earlier integration history is discarded.                                            |

### Porting notes

- Retained add-mcp's existing checksum-verified static musl GWS 0.22.5 download; no Docker base or dependency version changes are needed.
- GWS credential/config defaults now match the feature worktree and deployment instructions (`/etc/thor/google-workspace/credentials.json`, `/var/lib/remote-cli/gws`). The superseded GWS cache volume and old inline policy/tests/helpers are removed.
- All changes outside dedicated GWS files are limited to its wiring, documentation, and tests. No newer proxy/profile/approval/Slack/model changes from main are imported.

## Verification

- Full unit suite: 767 tests in 47 files pass.
- Workspace typecheck and build pass using add-mcp's pnpm 10.33.4 / tsup / existing SDK pins.
- Both container images build; isolated GWS E2E passes using the actual add-mcp-based OpenCode wrapper and real GWS binary, without external network access during the test.
- All changed files pass formatting. Full-repository formatting reports 20 pre-existing warnings; each warning was verified to concern a file unchanged from the add-mcp snapshot. They were not reformatted as part of this correction.
- Non-GWS source code, model config (GPT-5.5), package manifests/lockfile, proxy/approval architecture, and imported Drata/Kali/Falcon work remain unchanged from add-mcp's snapshot.
- Both source worktrees, add-mcp's dirty/untracked contents, and local main (`77b4971`) remain unchanged. No remote Git operations, pushes, PR operations, or deployments were performed.
