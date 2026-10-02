# OpenCode → Pi Durable runtime migration

## Implementation revision — embedded Harness (2026-10-02)

The user selected the simpler architecture and requested a local-test implementation. This revision supersedes the separate Pi service/runtime-adapter proposal below: runner directly embeds Pi Durable; a credential-free `pi-executor` container supplies its remote `ExecutionEnv`; remote-cli retains all external authorization and credentials. OpenCode remains an opt-in rollback path during testing, not a shared runtime abstraction.

Initial implementation uses the committed local-test baseline already rebased into this branch. Dirty local-test files will not be copied or committed without explicit selection. Per-user Google OAuth is therefore not included in this initial test delivery.

Implementation phases (one validated commit each):

1. **Executor boundary:** published exact package pins, remote filesystem/shell execution with cancellation and streaming, and real HTTP tests proving reduced shell environment, fail-closed parsing and filesystem behavior.
2. **Embedded runner:** direct Harness ownership, persistent conversations/admission metadata, stable gateway request IDs, busy/interrupt behavior, tools/skills/context, Slack progress and a Pi viewer alongside historical OpenCode viewer routes. Validate through a deterministic Responses server and persistent storage reopen.
3. **Test deployment:** opt-in Pi compose override, executor image/mounts/networking, all env/documentation/workflow surfaces, deterministic local E2E, full workspace verification, then scope-relevant GitHub checks before PR.

The first test delivery does not claim full OpenCode browser SPA parity, lossless old-session import, background subagents, or power-failure durability. No unsafe tool receives `replay: "safe"`. Runner secrets never enter executor requests or mounts; shell tools cannot run locally in runner. Published-package/source mismatch, security boundary regressions, or failed deterministic E2E block delivery.

| New decision                                                  | Rationale                                                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Embed Durable directly in runner                              | One conversation lifecycle owner and no OpenCode-compatible server emulation                               |
| Remote executor is an `ExecutionEnv`, not another agent       | Keep file/process work away from runner credentials while reusing Durable tools                            |
| Opt-in compose override during testing                        | Leave default OpenCode deployment recoverable; avoid silently switching production                         |
| Keep legacy OpenCode viewer and compatibility session aliases | Preserve existing attribution/approval readers and historical links while marking Pi provenance explicitly |

## Status and goal

Review and implementation proposal; no runtime migration implemented. Direction awaits confirmation because the request says “replace it with opencode,” while the release/context suggests replacing Thor's OpenCode harness with Pi Durable.

Assumed goal: run Thor on `@earendil-works/pi-durable` while continuing the local-test feature set, preserving Slack/GitHub/cron behavior, remote-cli policy, approvals, attribution, and historical viewer links.

Recommendation: proceed with a gated PoC, not an immediate replacement. Pi Durable is an experimental library, not an OpenCode-compatible server or browser UI. This is a harness, execution-context, observation, and deployment migration—not a Docker image substitution or a change to this workstation's Pi extensions.

## Baseline and completed preparation

- Original `pi`: `77b4971`; original merge-base with local-test: `987a953`.
- Committed `local-test`: `4922c203f7d90bb5e4b51836986f5fc14ba1def5`.
- Backup branch: `backup/pi-before-local-test-20261002`.
- Rebased `pi`: `a1bfb0e`, with all six newer main-line commits replayed onto committed local-test.
- Conflict resolution retained local Drata/Kali/1Password/GWS documentation, both browser and codex-lb security sections, integration environment entries, and Falcon in NO_PROXY. Daytona's newer OpenTelemetry dependency graph was retained.
- Frozen installation exposed a missing broker `@types/node` lock entry after replay. Regenerating the lock repaired it and applied local-test's existing patched protobufjs@8 override (resolved to 8.8.0); no manifest/override change was needed.
- Validated locally under Node 24.21.0 and Corepack-managed pnpm 10.33.4: frozen install with lifecycle scripts disabled, 57 test files / 858 tests, and recursive workspace typechecks.
- No push, GitHub integration run, deployment, or PR performed. Local unit verification is not the final integration gate.

**Important:** local-test has 63 staged/unstaged/untracked paths as inspected. A rebase brings committed history, not those files. That worktree was not stashed, committed, copied, or modified. Several files have different staged and working versions. The current pi checkout therefore does **not** yet contain the latest per-user GWS OAuth, revised codex-lb deployment, or agent deletions present in local-test's working tree.

Before implementation, obtain approval to snapshot/import the intended working-tree state. Preserve index and working layers separately in a private recovery location, review for secrets, and never commit `.env`, credentials, encrypted runtime stores, or mounted deployment data. Then establish an explicit feature baseline; do not import all paths blindly.

## Evidence and suitability review

Release: https://earendil.com/posts/pi-durable/

Upstream reviewed at `7fbbd5f4a1d982bb02d63472dde0774fa639f99b`, cached under `~/.cache/checkouts/github.com/earendil-works/pi`:

- `packages/durable/README.md`, `package.json`, `src/harness/{types,submissions,generation,tool}.ts`.
- `packages/durable/src/storage/{sqlite/node,jsonl/storage}.ts` and relevant normative specification/Chord guidance.
- `packages/durable/test/examples/{19-json,22-subagent-foreground,25-compaction,26-coding-agent,29-sandbox-per-conversation}.ts`.
- `packages/ai/src/models.ts`, `api/{openai-responses,openai-codex-responses}.ts`.
- Experimental coding-agent implementation is a reference, not Thor's proposed server.

Verified constraints:

1. Published Durable package inspected is 1.0.0, requires Node >=22.19.0, and explicitly permits API changes without notice. Pin exact compatible versions of Durable, pi-ai, and Chord after published-package PoC validation.
2. `Harness.open`, `resume`, `Conversation.submit`, stable `requestId`, and reacquirable `Submission` support persisted admission/recovery. Deduplication is per conversation; same-type request-ID reuse does not compare payloads. Thor must reject mismatched payload reuse.
3. Tool intent is durable, but external effects are not exactly-once. Interrupted tools rerun only when both their persisted and current definitions declare `replay: "safe"`. Built-in coding tools do not. Model requests can be resent after a crash and billed again.
4. `Conversation.abort()` cancels work; cancelling a Chord wait does not. Owned foreground children participate in parent cancellation/completion; background work has different semantics.
5. `watch`, `viewState`, and `watchEvents` are snapshot-first live projections. Slow consumers can receive replacement snapshots. They are not a replayable event journal; terminal audit events cannot depend solely on transient deltas.
6. One process must own a storage. SQLite WAL/NORMAL survives process crashes but may lose latest commits on host/power failure. JSONL's fsync option must not be assumed to guarantee commit-marker durability without validating the implementation. Select and test an explicit durability policy.
7. `CodingTools` provides read/write/edit/bash through an `ExecutionEnv`. `NodeExecutionEnv` is not a sandbox; cwd is not a filesystem boundary. Durable's built-in read currently does not support images.
8. No ready-made remote OpenCode-compatible server, equivalent browser SPA, or exported OpenCode session importer is supplied.

## Current coupling and preservation contracts

| Surface                                 | Current paths / behavior                                                                                                      | Migration requirement                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime lifecycle                       | `packages/runner/src/index.ts`: directory-scoped OpenCode clients; create/get/status/abort/promptAsync/children/provider.list | Explicit runtime adapter; preserve allowed directories, resolve/create semantics, settlement and model metadata                                    |
| Trigger and queue                       | `packages/gateway/src/{queue,service}.ts`; runner accepted/busy and optional NDJSON responses                                 | Non-interrupt busy requests remain gateway-queued; interrupts abort-and-resubmit initially; acknowledge only durable acceptance                    |
| Identity/history                        | `packages/common/src/{event-log,correlation}.ts`: UUIDv7 anchors/triggers and `opencode.session/subsession` aliases           | Keep anchors, external keys, attribution, old session references and viewer URLs; add explicit Pi provenance                                       |
| Live progress                           | `packages/runner/src/{event-bus,slack-progress,memory-progress}.ts`                                                           | Preserve parent/child progress, error handling, persisted Slack messages and terminal outcomes; recover from snapshots                             |
| Viewer/admin                            | Runner viewer; `packages/common/src/opencode-event.ts`; `packages/admin/src/{app,views}.ts`                                   | Retain legacy OpenCode readers; add Pi projections without rewriting old logs; keep unknown-event fallback                                         |
| Shell context                           | `docker/opencode/config/plugins/thor.js`, `packages/opencode-cli/src/remote-cli.ts`, `docker/opencode/bin/*`                  | Supply originating session/directory/call identity from runtime context, not mutable cwd; retain policy-gateway wrappers                           |
| Skills/instructions                     | `docker/opencode/config/skills/*`, runner bootstrap/memory/tool instructions                                                  | Explicit skill discovery/loading and prompt sections; do not assume Durable loads coding-agent config automatically                                |
| Local integrations                      | `packages/common/src/proxies.ts`, remote-cli handlers                                                                         | Preserve Jira edits/transitions, PostHog/Grafana, Falcon/Kali, Drata/GWS, Slack canvas/upload, observability, GitHub and Daytona                   |
| Browser credentials                     | `packages/onepassword-browser-mcp/*`, remote-cli secret stdio/broker audit                                                    | Broker remains remote-cli-owned; preserve origin/session binding, one-use approvals, TOTP, expiry and redaction                                    |
| Google authorization (dirty local-test) | common active-actor lookup, gateway approval events, `remote-cli/src/{gws-oauth,gws-args,gws,attribution,index}.ts`           | Keep active Slack actor, explicit Google email, private PKCE flow, encrypted grants, owner approval and consumed-before-dispatch execution         |
| Deployment/UI                           | Dockerfile, compose, ingress, CA setup and workflows                                                                          | Maintain credential separation, unprivileged execution, mounts, proxy/CA behavior, SSO and exact OAuth routes; explicitly replace OpenCode root UI |

Before any event/projection change, read `docs/plan/2026051601_opencode-event-view-schema.md`. Preserve the reader-not-write-gate contract and event-size exceptions. Read the runner-owned Slack progress and user-aware-attribution plans before touching those paths.

The dirty Google OAuth implementation currently resolves active users through OpenCode alias namespaces. A Pi alias rename without adapting all readers would break authorization. Runtime headers are correlation inputs, not authorization on their own.

## Proposed architecture

```text
gateway -> runner -> runtime adapter -> pi-runtime (Harness + restricted tools)
                    |                       |              |
                    |                       |              -> remote-cli -> policies/brokers/integrations
                    |                       -> codex-lb Responses API -> mitmproxy -> provider
                    -> Slack progress / trigger viewer / admin history
```

Keep Pi execution in a dedicated, unprivileged runtime container. Do not run agent shell tools inside runner, which holds Slack/internal credentials. Do not inject Thor's privileged internal secret, provider refresh tokens, GWS grants, broker token, or credential-store mounts into Pi.

Proposed implementation seams (names may be refined during Phase 2):

- `packages/runner/src/agent-runtime.ts`: lifecycle/submission/observation/model-context contract.
- `packages/runner/src/opencode-runtime.ts`: existing behavior extracted without product changes.
- `packages/runner/src/pi-runtime.ts`: typed internal client for Pi service.
- `packages/pi-runtime/`: Harness host, model registration, durable storage, Thor extension, internal transport, restricted execution environment.
- Runtime-neutral common identity/progress projections with explicit runtime discriminants; retain legacy OpenCode readers and aliases.

Use a small Thor-owned internal HTTP/stream contract rather than emulating the full OpenCode API. Match existing runner trigger responses. Keep this endpoint internal and define network access controls; avoid placing a privileged server-auth secret where agent shell tools can read it.

Storage state is canonical inside Pi. Thor's shared JSONL remains the historical/audit read model, not a second independent engine of conversation state. Persist an admission record and deterministic request ID before submission; reconcile uncertain responses by looking up/reusing that submission. Version projection state and derive current/terminal records from committed state, with stable entry/task/submission identities and idempotent writes. Do not append live deltas twice after reconnect.

Default cutover proposal: drain/explicitly cancel legacy work, keep old OpenCode sessions read-only, attach a new Pi conversation to the existing Thor anchor with an approved handoff and link to history. Full lossless transcript import is optional later, not a prerequisite to browsing old runs. Never import foreign in-flight tools or automatically repeat pending writes.

## Phases and exit criteria

### Phase 0 — Establish the intended local-test baseline

1. Confirm migration direction and which dirty local-test changes to include.
2. Snapshot reviewed staged/working/untracked layers without disturbing the source worktree; incorporate approved feature groups and review the resulting diff.
3. Reconcile older replayed codex-lb configuration with local-test's newer digest-pinned v1.24.0, named storage volume, readiness/live-model work and ingress changes. Preserve GWS OAuth over the older staged unrestricted GWS design.
4. Preserve intentional deletions of build/coder/thinker agents when that working-tree version is selected. Identify any required behaviors to port rather than restoring files accidentally.
5. Resolve or explicitly document the externally provisioned `apparmor=thor-remote-cli` profile requirement found in the dirty compose file.

**Exit:** reviewed baseline contains the selected features, source worktree remains intact, clean recovery references exist, frozen installation/typechecks/tests pass, and existing deterministic Google/broker fixtures verify the intended security contract. Completed rebase alone does not finish this phase.

### Phase 1 — Isolated Durable feasibility PoC (go/no-go)

1. Install pinned published packages in an isolated runtime fixture, with no live Google/browser credentials.
2. Register codex-lb with `createModels` / `createProvider` / `openAIResponsesApi`, explicit `api: "openai-responses"`, `baseUrl`, model capabilities/context limits/cost metadata and auth. Do not use the ChatGPT-specific `openai-codex-responses` adapter merely because the upstream models are Codex models.
3. Demonstrate reasoning, text, one tool round, errors, cancellation and compaction against a deterministic Responses fixture; separately validate the intended codex-lb deployment with an operator-approved real-model smoke.
4. Verify actual Node runtime networking respects proxy/NO_PROXY and public CA trust. Session affinity/cache identity is not supplied automatically by Durable generation; validate whether a provider wrapper is needed.
5. Choose SQLite/process-crash baseline provisionally, enforce one owner externally, and document host-failure/backup expectations before production admission.
6. SIGKILL/reopen during model streaming and tool execution. Test repeated request IDs, interrupted unsafe tools, slow consumers, child ownership and missing task definitions.

**Exit:** published package/container compatibility proven; exact provider protocol works; uncertain writes do not rerun; duplicates do not cause duplicate admission; snapshots converge; process-crash recovery works. Experimental API and durability policy explicitly accepted. Otherwise stop without cutting over.

### Phase 2 — Extract the runner contract and implement Pi service

1. Introduce the adapter, initially backed only by OpenCode, with behavior-focused regression tests.
2. Add Pi service/client, directory validation and stable mapping of Thor anchor + runtime session + submission + trigger + tool call.
3. Persist batch identity and payload fingerprint; repeated delivery uses the same request ID, while altered payload reuse fails closed.
4. Preserve non-interrupt reject/defer and interrupt abort/settle/resubmit. Guard terminal updates by trigger/submission identity so an old run cannot complete a replacement run.
5. Reconcile accepted unfinished runs on startup; explicitly prevent simultaneous storage owners and status-check/admission races.

**Exit:** both adapters satisfy the trigger contract; lost admission replies and restarts do not duplicate prompts; child completion never completes parent; gateway acknowledges durable acceptance only; concurrent requests serialize correctly.

### Phase 3 — Port tools, skills and execution identity

1. Port command wrappers and trusted execution-context propagation; retain compatibility for remote-cli header readers until migrated together.
2. Implement explicit skill/system-section loading, root/repo memory and user/tool-inventory injection. Preserve scoped-search and sandbox redirection behavior from the OpenCode plugin.
3. Validate built-in filesystem tools against read-only repositories/config and writable worktrees; handle bash cancellation and runtime output behavior in the harness layer, not duplicated CLI wrappers.
4. Keep all MCP policy and approved browser/GWS execution in remote-cli. Leave unsafe shell/writes without safe-replay declarations. Identify genuinely replay-safe operations individually, not by a blanket “read tool” label.
5. Add child-agent support only with required wrapper identity, remote-cli constraints and parent ownership inherited; define depth/cancellation behavior explicitly.

**Exit:** existing CLI/MCP policies, owner approval, active-actor lookup, broker origin/expiry, token-env isolation and secret-redaction tests pass through Pi-driven calls. No privileged credential or newly writable sensitive mount reaches the runtime. Broker capabilities expire across restart rather than silently restoring authentication.

### Phase 4 — Observation, history, Slack and UI

1. Add Pi snapshot/entry projections and stable persisted processing state; keep OpenCode parser/fallback for historical sessions.
2. Recover text/tool/child/terminal progress from snapshots; reconcile Slack message IDs after lost replies and avoid duplicate terminal/progress records where APIs permit. Do not promise exactly-once Slack posting across uncertain network outcomes.
3. Adapt usage/context calculations: cumulative spend, failed/aborted attempts and current-context occupancy are separate metrics. Verify cache/reasoning semantics and model limits.
4. Keep `/runner/v/:anchor/:trigger` links and admin session listing, including historical/current runtime IDs and attribution.
5. Recommended initial browser scope: Thor admin + trigger viewer, with an authenticated root landing page. If interactive browser prompting/steering/model selection is required, implement that as an explicit acceptance surface before removing the OpenCode SPA.
6. Make old-session handoff idempotent; do not rewrite legacy logs or resurrect in-flight legacy execution.

**Exit:** reconnect/slow-consumer/restart projections converge without duplicate usage or missing terminal records; old and new viewer fixtures render; superseded runs cannot finish current Slack progress; agreed browser UI behavior is available behind SSO.

### Phase 5 — Deployment, integration verification and cutover

1. Add Pi image/service, persistent storage, health/readiness, shutdown, permissions and isolated routing. Maintain public-only CA and secret separation.
2. Migrate shared skill/wrapper paths deliberately, then remove unused OpenCode SDK/server/plugin assets only after parity tests pass. Keep the old deployment recoverable during validation without running two owners of one trigger.
3. For each added/removed/renamed env var update compose, `.env.example`, README Deployment Configuration, relevant workflow env blocks, fixtures and this plan together.
4. Update core/sandbox/GWS E2E and ingress probes to test Pi rather than OpenCode API/auth/SPA assumptions. Retain Jira/browser/GWS approval tests and codex-lb dashboard/OAuth protection.
5. Run full isolated tests, recursive typechecks/builds and relevant local fixture E2E. Commit one completed phase at a time.
6. Push after implementation phases; inspect required GitHub checks, manually dispatch scope-relevant workflows if needed, and open PR only when required push checks pass.
7. Back up storage, drain legacy work, migrate selected anchors, verify real Slack/repo/approval flows with operator authorization. Rollback never copies Pi live state into OpenCode or replays uncertain approved writes.

**Exit:** relevant GitHub integration gates green; deployment smoke and backup/reopen demonstrated; agreed features/UI preserved; documented rollback works; OpenCode removal has no dangling references except intentional legacy readers/history.

## Decision log

| Decision                                                    | Status                                      | Rationale / alternative                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| OpenCode → Pi Durable, not the reverse                      | Pending user confirmation                   | Assumed from release/context; original phrasing is ambiguous                                                 |
| Include reviewed dirty local-test features before migration | Recommended; selection pending              | Branch-only rebase omits per-user OAuth and current deployment; do not silently commit somebody else's index |
| Dedicated Pi runtime container, runner stays separate       | Proposed                                    | Embedding tools in credential-bearing runner would expand blast radius                                       |
| Thor runtime adapter and small internal transport           | Proposed                                    | Preserve product contract without cloning the entire OpenCode server API                                     |
| Keep remote-cli as policy/credential boundary               | Required invariant                          | Durable hooks and runtime headers are not standalone authorization                                           |
| Exact package pins and gated published-package PoC          | Proposed                                    | Experimental APIs may change without notice                                                                  |
| SQLite with single-owner enforcement for PoC                | Provisional                                 | Simple process-crash recovery; production host-failure policy still pending                                  |
| Keep abort-and-resubmit interruption semantics initially    | Proposed                                    | In-place Durable steering changes trigger ownership/active-user authorization; reconsider separately         |
| Snapshot-based projections with persisted identities        | Proposed                                    | Watch streams can coalesce to snapshots; live deltas cannot be the audit journal                             |
| Legacy history read-only plus explicit handoff              | Recommended; continuity expectation pending | Safer than full transcript/tool-state conversion; lossless import can be separate                            |
| Thor admin/viewer rather than immediate OpenCode SPA parity | Recommended; browser requirements pending   | Durable supplies no replacement browser UI                                                                   |

## Risks and deferred decisions

- codex-lb's disabled dashboard auth on a shared Docker network is not isolated by Vouch or loopback host ports. The inherited security doc claim that an agent cannot reach dashboard routes is too strong. Evaluate internal API/dashboard isolation and correct documentation; do not present the existing topology as a proven credential boundary.
- Existing queue/runner memory state does not itself become durable by installing Pi. Admission, actor/trigger identity, terminal projection and Slack recovery require explicit reconciliation.
- Decide acceptable loss after power failure and how backups are consistent with WAL before production cutover; do not overstate “durable.”
- Decide whether read/image tool parity and browser interaction are required in the first cutover. Unsupported capabilities must be visible rather than silently omitted.
- Production proxy/provider compatibility, host-policy requirements, and live account behavior are unverified until the PoC/integration gates.

## Out of scope

- Updating this workstation's Pi extensions or approving glimpseui/node-pty install scripts.
- Replacing codex-lb with direct ChatGPT login, moving secrets into Pi, or bypassing remote-cli.
- Multi-owner/high-availability Harness operation, unrestricted background agents, new personal credentials for cron/GitHub, or automatic retry of uncertain provider mutations.
- Blanket safe-replay declarations, rewriting old OpenCode logs, full live-session import, or claiming exactly-once external effects.
- Redesigning integrations, adding app-level rate limiting, changing business approval policy, or deploying production during planning.

## Implementation validation log

- Phase 1 implemented: `@thor/pi-executor` private HTTP filesystem/shell service and runner-owned `PiExecutionEnv`. Exact Durable/pi-ai/Chord 1.0.0 pins. No local execution fallback or automatic mutation retry; shell environment explicitly reduced and cancellation propagated. Real HTTP suite: 27 tests passed; all workspace typechecks passed. Executor strict flags enabled. The existing runner tsconfig remains legacy strict to avoid unrelated migration diagnostics; the new client was additionally verified under strict flags by the executor implementation task.
