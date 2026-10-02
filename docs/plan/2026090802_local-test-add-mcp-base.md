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

## Follow-up phase — Delegate GWS and Drata authorization to upstream APIs

User request: remove Thor's GWS and Drata operation restrictions; operators will
configure permissions on the API identities instead. This extends the earlier
phase's scope to Drata without changing the add-mcp base or source worktrees.

### Implementation and exit criteria

- GWS forwards argv unchanged, including services/mutations, auth/file commands,
  output flags, and pagination options. No JSON forcing or page cap. Retain only
  argv-shape validation, private working directory, and replacement environment;
  let upstream gws determine authentication requirements and return its errors.
- Drata supports `drata api METHOD /path [--json JSON]` for API reads and writes,
  without a method or `/public/v2/` allowlist. Keep OAuth token minting/caching and
  require requests to stay on the operator-configured API origin; do not forward
  tokens to caller-selected hosts or follow redirects automatically.
- Tests prove writes and formerly denied GWS arguments reach inert subprocesses
  and local HTTP fixtures; upstream permission denials are propagated. No live
  write, credential-export, or upload commands are executed against real systems.
- Update agent skills, deployment docs, env comments, ADR, and prior active plans
  so they no longer promise a read-only boundary.
- Local tests/typecheck/build and isolated container checks pass. Leave changes
  uncommitted per the user's follow-up; no remote Git operations, CI dispatch,
  PR operations, or deployment.

### Decisions

| Decision                  | Choice                                                                                 | Reason                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authorization             | Upstream Google/Drata identity permissions                                             | Explicit user request; no Thor action allowlists or approvals for these integrations.                                                                                                                  |
| GWS local commands        | Forward them too, with an explicit operator warning                                    | An unrestricted CLI includes auth/export/file operations; API permissions alone cannot govern local credential/filesystem access. This supersedes the earlier read-only credential-boundary guarantee. |
| Drata origin              | Fixed configured API host, relative request paths, no automatic redirects              | Credential destination validation is separate from API operation authorization.                                                                                                                        |
| Drata bodies              | Optional inline JSON                                                                   | Provides the payload needed for write APIs without inventing a second file/stdin transport.                                                                                                            |
| Observability             | Counts/methods/status only, not raw argv, bodies, or OAuth errors                      | Unrestricted flags and request payloads may carry secrets or personal data.                                                                                                                            |
| Drata ownership           | Per-instance `IDrataService` instead of module-global token state and test reset hooks | Keeps OAuth/cache/HTTP errors together and verifies the real client against local HTTP servers without module mocks.                                                                                   |
| Redaction                 | Private `Redacted<T>` wrapper for OAuth secrets/tokens                                 | No existing wrapper in this base; removing it would leave credential strings exposed to accidental object serialization. No new dependency or public generic API.                                      |
| Generic response contract | Preserve arbitrary JSON/text API bodies and status                                     | The requested generic API wrapper cannot impose endpoint-specific schemas; the OAuth token envelope is parsed before it enters cache state.                                                            |

### Verification

- Complete, left **uncommitted and unstaged** on `local-test` at `5e4876b`.
- Full suite: **716 tests in 46 files pass**. Obsolete allowlist-denial tests
  were replaced by passthrough and upstream-error coverage.
- Workspace typecheck/build pass with pnpm 10.33.4 (invoked via offline npx
  because the machine's pnpm mise shim has no selected version).
- Both Docker targets build. Isolated container E2E passes with
  `thor-local-test-open-api-remote-cli:test` and
  `thor-local-test-open-api-opencode:test`: real pinned gws and both wrappers,
  Google/Drata fixture writes, upstream denials, YAML output, 12-page pagination,
  and private mounts. Test network is internal-only; no live vendor calls.
- Real local HTTP tests also cover OAuth caching/refresh, API and OAuth redirect
  isolation, malformed token envelopes, safe OAuth errors, non-JSON/empty API
  responses, and transport failures. No module mocks or new dependencies.
- Property-test assessment: fixed former-denial argv vectors, custom methods,
  and host/URL escape variants cover this small transport boundary; no new
  property-testing dependency or endpoint-specific API schema was introduced.
- Changed-file formatting and `git diff --check` pass. Full formatting still
  reports **18 pre-existing warnings**, each verified unchanged from HEAD.
- Source worktrees and local main remain untouched; HEAD and the Git index are
  unchanged. No commit, remote Git operation, workflow dispatch, PR change, or
  deployment was performed for this follow-up.

## Follow-up phase — Upgrade OpenCode and MCP runtimes

User request: upgrade OpenCode, Falcon MCP, Grafana MCP, and Aikido to the latest
stable releases. Preserve the existing uncommitted GWS/Drata work and add-mcp
history. No commits, PR changes, remote Git operations, or deployment.

### Selected releases (checked 2026-09-08)

| Component            | Before  | Target  | Source                                                                         |
| -------------------- | ------- | ------- | ------------------------------------------------------------------------------ |
| OpenCode CLI and SDK | 1.15.10 | 1.18.29 | npm `latest` for `opencode-ai` and `@opencode-ai/sdk`; GitHub release v1.18.29 |
| Falcon MCP           | 0.10.0  | 0.19.0  | CrowdStrike/falcon-mcp latest stable GitHub release                            |
| Grafana MCP          | 0.14.0  | 1.3.0   | grafana/mcp-grafana latest stable GitHub release                               |
| Aikido MCP           | 1.0.7   | 1.0.22  | npm `latest` for `@aikidosec/mcp`                                              |

### Implementation and exit criteria

- Pin releases explicitly; align OpenCode server and SDK, changing only the
  requested dependencies and required compatibility wiring.
- Check image entrypoints/flags, MCP initialization/discovery, and existing
  Falcon/Grafana policy tool names. Do not broaden these integrations' permissions.
- Run unit tests, typecheck/build, image builds, and isolated smoke tests with
  disposable storage/fake credentials. Do not touch a live OpenCode database.
- Exercise OpenCode session creation and agent switching without a live LLM
  where possible; distinguish verified behavior from the reported EC2 failure.
- Document upgrade/rebuild steps and require an OpenCode storage backup before
  allowing the new runtime to migrate a deployed database.

### Decision log

| Decision                       | Choice                                                                            | Reason                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest selection               | Stable release versions, not floating `latest` image/package specs                | Reproducible builds while meeting the requested upgrade as of today.                                                                                                                                                                                                                                                 |
| Verification                   | Disposable local instances, no live vendor operations                             | Existing integration scripts can clone repos/call vendors and are not suitable under the user's local-only constraints.                                                                                                                                                                                              |
| Reported SQLite error          | Verify separately, without claiming a version bump repairs existing data          | The trace is inside OpenCode's `appendMessage` / `session.next.agent.switched`; a deployment's persisted state has not been inspected.                                                                                                                                                                               |
| Grafana Host compatibility     | Explicit `--allowed-hosts` for the Docker service and loopback health checks      | v1.3.0 rejects Docker DNS names by default. An additional SDK guard affects loopback connections only, so validate real cross-container traffic rather than a loopback request with a synthetic Host. No header rewrite, wildcard, or transport shim is needed; preserve existing policy and internal-only topology. |
| Aikido native dependency       | Install `libsecret-1-0` in OpenCode image                                         | Loading the new keytar addon failed; `ldd` confirmed missing libsecret/glib shared libraries. No desktop keychain or browser login is required for existing API-key auth.                                                                                                                                            |
| Falcon inventory compatibility | Replace obsolete `falcon_list_modules` with read-only `falcon_list_enabled_tools` | The real 0.19.0 server does not register the former name. All existing investigation tools remain present; no dynamic execution or write tools are added.                                                                                                                                                            |

### Verification

Pending upgrade and local checks.

## Authorized integration snapshot — 2026-10-02

The user requested committing the complete current local-test code and importing it into the Pi worktree. The final working-tree versions supersede older staged versions, including per-user GWS OAuth, codex-lb multi-subscription upgrades, Drata command changes, updated MCP/runtime pins, and intentional agent-file deletions. Deployment data, ignored files, secrets, and node_modules remain outside the snapshot.

Index/working patches, untracked code, and a tracked Git recovery snapshot were preserved privately before changes. An offline, non-verifying secret scan of the 58 candidate files reported no findings. A test-only TypeScript compatibility fix replaces unavailable `RequestRedirect` with `RequestInit["redirect"]`; no OAuth behavior changes. Validate the combined source before committing, then merge into Pi without rewriting its published history. Pi integration must preserve actor-authenticated admission, separate credential storage/executor networking, OAuth ingress routing and consumed-before-dispatch approvals.

Snapshot validation: frozen installation, recursive workspace typechecks/builds, and 60 test files / 831 tests passed under Node 24.21.0 and pnpm 10.33.4. Host AppArmor provisioning and account-backed model/Falcon readiness remain deployment prerequisites to resolve/document during Pi integration; no live service or secret was used for this validation.
