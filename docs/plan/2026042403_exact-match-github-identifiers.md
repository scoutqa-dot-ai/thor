# Exact-Match GitHub Identifiers

**Date**: 2026-04-24
**Status**: Completed

## Goal

Reduce the GitHub webhook / GitHub App auth PR by removing branch-added case-insensitive identifier handling and returning to exact string matching for org and repo comparisons.

## Phases

### Phase 1 — Remove case-insensitive org matching

- delete the case-insensitive org lookup helper behavior
- delete the duplicate-org-by-case validation guard
- trim tests back to exact-match org expectations

**Exit criteria:**

- [x] `getInstallationIdForOrg()` only matches exact org keys
- [x] workspace-config validation no longer rejects org keys that differ only by case
- [x] focused tests cover exact-match org lookup only

### Phase 2 — Remove case-folded repo matching in GitHub dispatch

- stop lowercasing repo full names and local repo basenames during webhook intake
- stop lowercasing PR-head repo names returned from remote-cli
- trim tests back to exact-case repo expectations

**Exit criteria:**

- [x] webhook routing uses the payload repo basename as-is
- [x] branch-resolution compares repo full names exactly
- [x] focused tests cover exact-case repo matching only

## Decision Log

| Date       | Decision                                                                                    | Reason                                                                       |
| ---------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 2026-04-24 | Remove branch-added case-insensitive org/repo handling instead of adding more normalization | Keeps the implementation closer to `origin/main` and reduces PR surface area |

## Out of scope

- changing mention detection behavior
- changing GitHub delivery dedupe behavior
- changing wrapper gating for migrated `orgs` config
