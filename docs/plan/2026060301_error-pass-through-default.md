# error pass-through by default

Make LLM-facing Thor command failures return the caught error message by default, while preserving a narrow profile/access-control/routing-denial exception and avoiding broad policy/taxonomy/redaction frameworks.

## Why

The prior sandbox incident exposed an actionable provider failure (`no space left on device`) as a generic `Sandbox service error`, preventing the agent from diagnosing or reporting the real blocker. The agreed MVP direction from the Slack thread is intentionally simpler than the earlier audit proposal: pass caught errors through by default, keep paths visible, do not add a generic secret-redaction layer, and only retain an explicit safe wrapper for profile/access-control/routing denials.

## Scope

**In scope**

- Add one shared `errorMessage(err: unknown): string` helper in `@thor/common` and export it.
- Replace LLM-facing `Internal server error` catch responses in `packages/remote-cli/src/index.ts` with `errorMessage(err)`.
- Make `/exec/sandbox` default to returning the underlying caught error message, including paths, for both JSON and NDJSON failure paths.
- Keep existing explicit validation/policy/usage messages as-is.
- Keep profile/access-control/routing denial messages safe in `packages/remote-cli/src/mcp-handler.ts` with a tiny file-local wrapper only where strict profile resolution can expose routing topology.
- Update targeted tests that currently assert generic masking.

**Out of scope**

- Generic error policy engines, category taxonomies, stable error-code frameworks, or rule registries.
- Generic `redactSecrets()` or any broad redaction/filter layer.
- Hiding filesystem paths in sandbox or command errors.
- Reworking gateway/admin/runner non-LLM-facing behavior unless a touched remote-cli integration test requires a tiny fixture adjustment.
- Changing command validation, allow lists, approval semantics, or profile-routing rules.

## Decision log

| #   | Decision                                                                                      | Rationale                                                                                                 | Rejected                                                                                                 |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Default caught errors on LLM-facing remote-cli endpoints pass through via `errorMessage(err)` | Matches the agreed MVP and maximizes agent diagnosability with minimal code                               | Keeping broad `Internal server error` masks; building a safe/admin error framework                       |
| 2   | No generic redaction helper for this MVP                                                      | Slack direction explicitly removed `redactSecrets`; adding it would create a policy layer by another name | Shared `redactSecrets(text)` from the earlier helper proposal                                            |
| 3   | Sandbox also passes through raw caught messages by default                                    | The concrete failure class needs the Daytona/provider detail and path to be visible to the agent          | Curated sandbox categories like `Sandbox storage full`; current generic `Sandbox service error` fallback |
| 4   | Profile/access-control/routing denials stay explicitly wrapped                                | These can reveal profile topology or credential routing boundaries and are the only agreed exception      | A repo-wide denial taxonomy; raw pass-through of strict profile-resolution details                       |
| 5   | Keep helper set to `errorMessage()` plus an optional local MCP denial wrapper                 | Removes repeated extraction without introducing new architecture                                          | Multiple shared helpers or new error classes                                                             |

## Phases

### Phase 1 — Shared raw-message helper

Add `errorMessage(err: unknown): string` to `packages/common/src/errors.ts`, export it from `packages/common/src/index.ts`, and replace only nearby/touched repeated `err instanceof Error ? err.message : String(err)` expressions where the feature needs them.

**Exit:** `@thor/common` builds/types cleanly; no behavior changes beyond equivalent message extraction.

### Phase 2 — Remote-cli catch-boundary pass-through

In `packages/remote-cli/src/index.ts`, change LLM-facing catch responses that currently return `stderr: "Internal server error"` to return `stderr: errorMessage(err)` while continuing to log the same raw message and `thorIds(req)`. Cover `/exec/git`, `/exec/gh`, `/exec/scoutqa` pre-header failure, `/exec/slack-post-message`, `/exec/ldcli`, `/exec/mcp`, `/internal/exec`, and `/exec/approval`. Preserve existing 400/401 behavior and endpoints already passing useful messages through.

For streaming endpoints with headers already sent, write an NDJSON `stderr` event containing `errorMessage(err)` before the failing `exit` event rather than only emitting an exit code.

**Exit:** targeted remote-cli tests prove at least one JSON endpoint and one streaming endpoint expose the thrown message instead of the generic mask.

### Phase 3 — Sandbox pass-through

Simplify sandbox failure handling so non-`SandboxError` failures use the raw `errorMessage(err)` as the outward `userMessage` instead of `Sandbox service error`. Update `toSandboxError()` fallback behavior similarly: keep auth/timeout special messages only if they are still intentional and already more specific, but remove the generic fallback mask. Keep `adminDetail` equal to the raw message and leave paths visible.

Also update the pull-back failure path so wrapped `SandboxError` messages do not hide the underlying pull error more than needed; if a custom prefix is retained (`Failed to pull sandbox changes back to the worktree`), include the raw cause in the agent-visible stderr.

**Exit:** sandbox tests include a provider-style error containing a path (for example `no space left on device` under `/home/thor/.daytona/...`) and assert the path/detail reaches JSON or NDJSON stderr.

### Phase 4 — Profile/access-control/routing denial exception

In `packages/remote-cli/src/mcp-handler.ts`, add a tiny file-local helper only if needed, e.g. `profileDenialMessage(err)`, for failures from `resolveProfileForContext()` / `resolveProfileForAction()` / `resolveStrictProfileForSession()` that can expose profile topology. Use it in the help/list and upstream execution paths that currently return raw strict-resolution errors. Continue logging raw details where logging already exists, and do not wrap normal usage/tool/upstream failures.

Candidate outward message: `Integration not available in this thread context`.

**Exit:** tests that currently assert raw profile conflict/mixed-profile details are updated to assert the safe denial message, while MCP tool-call/upstream failures still pass through their raw messages.

### Phase 5 — Verification and PR readiness

Run targeted tests first, then workspace-level checks appropriate for a remote-cli/common-only change.

**Exit:**

- `pnpm --filter @thor/common test` (or typecheck if no common tests are defined)
- `pnpm --filter @thor/remote-cli test`
- `pnpm typecheck`
- Push after phase commits and use the required GitHub workflow result as the final gate before opening a PR.

## Test plan

- Add/update common helper coverage only if existing common tests make it natural; otherwise rely on typecheck because `errorMessage()` is a one-line helper.
- Update remote-cli endpoint tests to assert thrown messages are returned in `stderr` instead of `Internal server error`.
- Update sandbox tests to assert raw provider details and paths pass through by default.
- Update MCP/profile-routing tests so profile/access denial details are safe, but normal MCP upstream/tool failures remain raw pass-through.

## Exit criteria

- No LLM-facing remote-cli catch boundary newly returns a generic mask except the explicit profile/access-control/routing denial exception.
- Sandbox raw failures, including paths, are visible to the agent by default.
- No generic redaction, policy engine, taxonomy, or new shared error class is introduced.
- Existing validation/policy/usage errors continue to return their current explicit messages.
