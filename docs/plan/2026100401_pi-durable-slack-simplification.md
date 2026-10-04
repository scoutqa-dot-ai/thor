# Neo — Pi Durable-native Slack simplification

**Status:** Proposed; implementation has not started. Approval of this architecture is not approval to deploy or retire rollback support.
**Reviewed:** 2026-10-04, Neo `f8ce4b6`, released Pi `v1.0.2` (`cd32f7725fdbddbaecdff5b1e68491563394e0ca`).

## Goal and recommendation

Make Neo a small application **on Pi Durable**, rather than maintaining a parallel representation of Pi's lifecycle. Keep the security and integration boundaries that Pi deliberately does not provide.

The target is **one embedded runtime, one native source of execution truth, one Slack presentation owner, and the existing credential-free execution / credential-policy separation**. No generic runtime adapter, replacement scheduler, universal event framework, or new conversation server.

The biggest cuts are separating OpenCode execution from historical viewing, deriving submitted work's status/history directly from Durable, and making ordinary Slack replies host-owned rather than requiring the model to call a posting tool. A package upgrade alone does not achieve these cuts.

This is a substantial follow-on to [the embedded migration](2026100201_pi-durable-runtime-migration.md), not a replacement for its security decisions. Preserve [Google automatic continuation](2026100302_google-auth-pause-resume.md), [task routing](2026100303_pi-task-model-routing.md), and [the activity/footer contract](2026100304_neo-slack-progress-design.md).

The user's additional MCP flow request is covered by [Configurable MCP catalog and native Durable tools](2026100402_mcp-catalog-and-native-tools.md): operator-owned HTTP server additions, broker-only credential references, two native discovery/call tools and versioned generic approvals. It shares this plan's single-owner and credential boundaries; it does not require a new runtime, Pi upgrade or arbitrary plugin loading.

## What the release actually supplies

Neo currently pins Pi Durable, Pi AI and Chord **1.0.0**. npm's latest published Durable version at review time is **1.0.2**. Capability authority is the released tag, not unreleased main or the interactive CLI's extension API.

| Capability                                                                             | Released reality                                                                             | Architectural consequence                                                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Persisted conversations, submissions, task graphs, recovery, abort/join                | Already available in 1.0.0                                                                   | Use native state instead of mirroring a second execution lifecycle.                                       |
| `submit({requestId})`, `Submission.status/wait`, successful `answer` entry             | Already available; Neo already passes `receipt.requestId`                                    | Retain the existing native idempotency bridge; use exact settlement/answer identity.                      |
| Same-ID changed-payload rejection                                                      | Not provided: same conversation + same ID/type returns the original, even if content differs | Keep Neo's fingerprint and runner-wide request binding.                                                   |
| Atomic configuration + Neo document updates                                            | Public `configure(tx, ...)` supports this                                                    | Keep frozen policy and native configuration in one commit.                                                |
| Atomic Neo intent + public `Conversation.submit`                                       | Not provided; these are separate commits                                                     | Preserve intent-before-submit recovery. Internal `admitSubmission` is not a supported package export.     |
| Busy follow-up / steering                                                              | Native inbox exists, but actor/model/cwd are not submission-local                            | Do not replace current busy deferral with an unsafe one-line `followUp` change.                           |
| Committed views and event watches                                                      | Snapshot-first; overflow/reconnect rebuild state, without a durable event-replay cursor      | One presentation observer; no second transcript/event journal.                                            |
| Native task waiting and sleep                                                          | Task joins; checkpointed deadline + sleep can compose polling                                | Not a built-in OAuth callback/signal bus. Broker readiness/ACK remains application policy.                |
| Stable provider-session identity                                                       | The principal Durable runtime addition in 1.0.2                                              | Useful provider affinity evidence, not a new Slack/OAuth architecture or proven codex-lb cache guarantee. |
| Remote execution, credential permissions, single-process ownership fencing, image read | Not shipped as Neo-ready replacements                                                        | Keep the remote environment/executor, policy broker, storage-owner lock and image bridge.                 |

The Durable source delta from 1.0.0 to 1.0.2 is six files, mainly provider identity creation/forwarding/viewing; Chord runtime source is unchanged. Pi AI has separate provider/sampling fixes. Durable is explicitly **experimental**; verify an eventual coordinated upgrade rather than assume stable APIs or backward database rollback.

## Current complexity: distinguish overlap from necessary policy

Source review covered gateway intake/delivery, runner lifecycle/state/model/tools/viewers, Slack presentation, executor and Google/integration broker, plus the upstream normative Durable specification and official chat reference.

- `packages/runner/src/index.ts` combines legacy execution, historical rendering and startup. Pi startup still constructs `createRunnerApp()` for its legacy viewer. This is coupling, **not evidence that Pi currently runs OpenCode**.
- `packages/runner/src/pi-runner.ts` owns admission, recovery, receipt status, history slicing, NDJSON, Slack observation and viewing. Its `monitor` already waits on native settlement, then mirrors terminal status into `PiAdmissionReceipt`.
- `entriesFor` scans history and infers the task boundary from the next receipt; native input/answer IDs and bounded entry queries can remove much of this work. Error/abort/unsettled ranges still need explicit boundaries.
- `monitor/project` translates native events into the common progress lifecycle. `ProgressSession` then separately tracks activity, timers and session registries. Keep the UX, but make the Pi Slack path one request-scoped projection instead of multiple lifecycle owners.
- Ordinary final assistant text is **not automatically posted to Slack**. `pi-runner-tools.ts` instructs the model to use the Slack skill/posting workflow. This makes a simple reply depend on prompt compliance and an extra tool effect.
- `reconcileLogs` publishes **aliases and trigger start/end facts**, not a second full Pi transcript. Those shared facts currently authorize broker calls and serve gateway/admin/approval/disclaimer readers. They cannot simply be deleted as logging noise.
- Gateway's disk queue freezes uncertain deliveries, performs debounce/privacy/repository admission and survives runner downtime. It is not currently double-enqueuing work in the native inbox: Pi uses `whenBusy: "reject"`.
- Google encrypted grants, confirmed private DMs, grant-bound continuation ACKs and dispatch tombstones are external authorization state, not duplicated Pi task status.

Static follow-ups to verify during implementation: an old native watch can remain live during awaited terminal presentation after `activeRequestId` clears; duplicate/history duration currently uses retrieval-time `Date.now()`. Scope watches by their actual run/submission and preserve fixed completion evidence instead of adding more monitor flags. These are source-level observations, not executed reproductions.

## Target architecture

```text
Slack / GitHub / cron
        |
        v
Gateway: authenticate, gate, debounce, freeze, durable handoff
        |
        v
Runner: small trusted admission boundary
        |
        +-- Pi Durable Harness + private SQLite
        |      native conversations / submissions / tasks / history
        |      small Neo request binding and policy documents
        |
        +-- one Slack owner: activity + final reply + source reactions
        +-- native viewer + read-only historical OpenCode viewer
        |
        +-- ExecutionEnv --> credential-free pi-executor
        |                       shell / files / image bytes / wrappers
        |
        +-- existing broker coordination --> remote-cli
                                credentials / integration policy / Google OAuth
```

These are responsibility boundaries, not a proposal for new layers or containers. Keep the existing Compose project and services initially. Phases 1–3 do not flip the repository's `THOR_RUNTIME` default (`opencode`) or replace the explicit `docker-compose.pi.yml` overlay. Runtime-default/cutover changes require separate approval. A gateway/runner merger saves a process only by relocating all admission responsibilities and coupling public ingress availability to runtime startup; it is not the recommended first cut.

### Ownership and deletion map

| Owner                                                                            | Keep                                                                                                                                           | Simplify / remove after its gate                                                                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native Harness                                                                   | Generation, tools, tasks, joins/abort, submissions, entries, usage, recovery                                                                   | Neo mirrors of submitted execution status and inferred native transcript boundaries.                                                                                  |
| Neo admission (`pi-runner-state.ts` and admission portion of `pi-runner.ts`)     | Parsed requester/source/workspace, fingerprint, external aliases, pre-submit intent/withdrawal, frozen routing and broker continuation binding | Full prompt copies after native admission/recovery no longer needs them; duplicate terminal lifecycle fields. Keep a durable or reconstructable runner-wide index.    |
| Runner composition (`index.ts`)                                                  | Resource startup/shutdown and explicit ownership                                                                                               | Legacy execution imports/app construction on the Pi path; move historical viewing to a read-only owner.                                                               |
| Slack presentation (`slack-progress.ts` and relevant `ProgressSession` behavior) | Serialized/coalesced updates, grace threshold, actual activity/model, wait/static states, original-source eyes/check behavior                  | A second Pi session lifecycle and redundant registries/translations where no compatibility consumer needs them. Keep common NDJSON/legacy translation at their edges. |
| Native/history viewer                                                            | Exact native entry/task evidence; historical aliases, escaping and unknown-event fallbacks                                                     | Whole-history scans for successful inputs; legacy live SDK/SSE dependencies in read-only viewing.                                                                     |
| Model routing                                                                    | Operator pool, pure selection, trusted overrides, locks, bounded escalation, frozen OAuth/restart choice                                       | No provider execution wrapper. Do not remove task-ID escalation evidence: configuration can commit before native memo.                                                |
| Google broker/coordinator                                                        | Encrypted credentials, private delivery proof, readiness/ACK/lease/grant checks, cancellation/supersession                                     | No deletion based only on native task waiting. Optional typed Google redesign below has its own gates.                                                                |
| Executor/remote environment/image bridge                                         | Credential-free boundary, session/cancellation semantics, bounded raster read, no local runner fallback                                        | Only genuinely duplicated harness behavior, never security isolation to save a wrapper.                                                                               |
| Gateway/shared context                                                           | Signature/privacy/repository/current-actor policy, frozen uncertain handoff, aliases/current-trigger authority                                 | Narrow contracts and repeated rendering/projection work; queue deletion or authority-store migration is not an automatic native replacement.                          |
| OpenCode execution                                                               | Explicit temporary rollback path during acceptance                                                                                             | After separate retirement approval: legacy trigger route, SSE event bus and recursive tool projection. Historical viewing remains.                                    |

Use flat, discoverable modules: `pi-runner.ts` for HTTP, one cohesive admission/recovery owner if extraction is justified, `pi-runner-state.ts`, `pi-runner-viewer.ts`, `legacy-runner-viewer.ts`, and the existing concrete execution/model/Google/Slack owners. Do not create a file or class per forwarding function. A file move alone is not a simplification.

### Small Neo state, not another task engine

Evolve `thor.pi.conversation` deliberately, with a versioned migration; retain technical names and public IDs. Native state owns actual execution. Neo retains facts that native state cannot establish:

- Request identity/fingerprint and conversation/submission mapping; trusted requester, original human `messageTs`, channel/thread, workspace/repository and public anchor/trigger aliases.
- A discriminated admission intent/withdrawal boundary covering the real gap before public native submit. Original input is retained until native admission can reconstruct it.
- Frozen routing policy, explicit locks/promotion history and replay-safe promotion evidence. The selected native generation/configuration remains actual execution evidence.
- Broker continuation identity and original request binding; confirmed or unconfirmed authorization hold is **not** redundant native lifecycle state. Minimal Slack publication/reconstruction evidence where required. No Google tokens, OAuth/browser capabilities or provider keys.

Derive settled execution from native submission/task records. Distinguish model completion from authorization wait, external publication and business-operation success. Do not substitute conversation idle or a transient `run_end` event for the completed submission's answer.

Keep alias/current-trigger projection for its existing consumers. Before reducing its receipt rescans or deriving trigger-end facts from native state, prove broker current-actor restoration **before any scheduling-enabling call**. `submit`, waits and abort can enable scheduling, not just `resume`. A future authenticated context API is a separate consumer migration, not a prerequisite added merely to delete JSONL.

### Admission: retain the safe serialized boundary

The initial target remains one conversation per existing correlation/thread/repository binding and **one active trusted request at a time**:

1. Gateway verifies/gates source and freezes delivery identity/payload before uncertain handoff.
2. Runner validates/fingerprints; rejects same-ID changed authority/payload; checks existing native submission or persisted admission intent.
3. Busy work defers; an authorized interruption aborts and drains the old execution/presentation before selecting a new actor/model.
4. Commit native configuration plus Neo binding/intent, then submit using the same stable native `requestId`; recover the two-commit gap by reacquiring/repeating that idempotent submit.
5. Observe exact native settlement and answer. Serialize/stop the old presentation owner before it can affect a newer request.

**Do not queue requester B and immediately install B's actor/model while A runs.** Native `AgentDoc` and cwd are conversation-level; later tool phases can read current configuration. Steers can join multiple inputs into one run. Native ownership alone does not decide whose Google account a call may use. Broader native follow-up queueing is deferred until request-context activation before model/tool dispatch is proven, including mixed inputs, failed runs, restart and supersession.

The signed Slack envelope currently is not forwarded wholesale: runner `slackTeamId` comes from configured `SLACK_TEAM_ID`, not preserved signed-team proof. Any new admitted envelope must explicitly establish configured-workspace equality at ingress; do not retrofit a claim that existing receipts contain that proof.

### Ordinary replies: let Pi answer, let the host deliver

Recommend replacing the ordinary “call Slack before ending” instruction with a host-owned final sink. This is a product-contract change, not existing behavior:

- Freeze delivery policy on admission. Historical and already-admitted tasks retain **tool-owned** replies; only new trusted Slack admissions with an established permitted reply target become **host-owned**. GitHub/cron do not acquire automatic Slack publication merely by sharing an anchor; keep their existing explicit publication rules. Never auto-publish an old completed answer or switch an in-flight task whose prompt promised private final text. A versioned migration distinguishes old bindings from malformed new data.
- For host-owned work, the prompt explicitly says final assistant text will be published to the admitted reply destination. That destination is frozen **after** privacy/repository admission, not taken from a raw signed event or model arguments. Private result destinations remain private; inability to establish the permitted destination fails closed, with no fallback to a public channel/thread root.
- OAuth continuations inherit the original delivery policy and target, including pre-cutover tool ownership. An outstanding/unconfirmed auth hold is not a final-answer publication opportunity; after authorized resume, select the resumed submission's final answer for the original permitted destination. Do not publish a paused step as the task's completed answer.
- Select **only text blocks from the successful input's `settled.answer`**, not `textFromEntries` over intermediate turns, reasoning blocks or raw snapshots. Empty/reasoning-only answers post nothing and are not recorded as delivered replies. Tool-derived final text is public to that permitted audience; it is no longer described as private internal commentary.
- Remove the ordinary same-thread posting obligation together from `pi-runner-tools.ts::slack-reply`, `tool-instructions.ts`, and `docker/opencode/config/skills/slack/SKILL.md`, while preserving the legacy/tool-owned contract. `slack-post-message` is for explicitly requested outbound actions/rich artifacts, not ordinary final text. Block Kit/canvases/uploads remain explicit tool outputs; the host does not retransmit those payloads. If a task emits an artifact, its final text is a concise result/summary rather than a second copy. The host publishes nonempty final text by policy, not a heuristic that inspects whether a posting tool ran.
- Reuse existing Slack formatting/transport where appropriate; deliberately handle markup, size/chunking and artifacts. A text-only sink must not silently replace rich workflows. A send issued before supersession can remain remotely uncertain; late receipts belong to the old binding and cannot decorate the newer request.
- Persist **one publication disposition on the existing request binding**, keyed by answer entry and frozen destination: pending, confirmed (Slack timestamp), uncertain, or definite rejection. Native entries retain the content; no new delivery Task, second outbox, delivery scheduler or ordinary-run wrapper. Chunk dispositions, if needed, are bounded children of this same publication record, not another workflow engine.
- An accepted Slack receipt confirms that call only. Send-before-local-receipt crash, timeout and partial chunks are **uncertain**, not automatic-repost permission. Recovery must not treat an unresolved pending record as proof no send occurred. Reconcile/dispose explicitly; do not rerun the model/tools. Native memo or `client_msg_id` is not a verified universal exactly-once guarantee.

Keep ✅ on normal turn completion under the current contract, **not Google/resource success or proof of delivery**. Do not relabel uncertain answer publication as confirmed. Delaying the decoration until confirmed publication requires separate approval. OAuth wait/unconfirmed auth status/error/abort/supersession never get success. Only normal completion removes Neo's own eyes from the frozen human source; auth wait keeps eyes.

One request-scoped observer supplies factual activity/model/thinking and one serialized footer. Rebuild from native snapshots after attach/overflow; snapshot replacement is not a stream of new tool completions. Dispose/drain old callbacks on supersession. Keep the existing GIF/still/labels and text-only fallback; no per-token Slack API calls or private reasoning exposure.

### Google: preserve the working flow; optional second cut

Core refactor keeps the broker outbox and `google-auth-continuation-poller.ts`. Current `/exec/gws` produces typed 428 `authWait`, but the shell wrapper renders `ExecResult` text and does not make bash a native signal waiter. Broker-ready continuation authorizes the existing automatic **agent task** continuation under the original requester/final model; never replay a compound shell command or uncertain earlier effect.

**Fix, rather than preserve, the completion-observation ambiguity:** the current `waiting()` helper returns false on HTTP failure/timeout/throw, and the monitor skips its check without `slackTeamId`. That is not authoritative evidence of no wait. Use a parsed broker outcome distinguishing confirmed wait, confirmed no matching wait, and unavailable/unconfirmed status; document treatment of missing workspace configuration. Native `done` plus an outstanding or unconfirmed auth hold cannot become successful NDJSON/Slack completion or ✅. Show a safe static/degraded status until authoritative resolution; do not initiate a new OAuth invitation or replay effects merely because observation failed.

An auth hold can coexist with a settled native input and no open trigger. The coordinator's original binding/latest-request/grant checks, not native idle or the thread starter, establish continuation authority. Retain the original request as latest until a newer **admitted** request supersedes it or its authenticated continuation is admitted. Do not require an old open-trigger projection that the existing wait flow intentionally closes; do not install a queued actor during the hold. Keep `googleAuthWaiting`/equivalent typed hold evidence separate from native status and preserve eyes/no-check through the wait.

A later, separately approved simplification can make an exact-argv Google tool own a native child Task: typed broker call → confirmed private auth wait → checkpointed sleep/poll or document observation → grant/lease/current-request revalidation → exact blocked operation → tool result → original generation continues. Released tasks support this composition, not an invented `awaitSignal` API.

Before replacing the current coordinator, prove task-key-idempotent wait/DM registration, callback-before-DM handling, readiness/ACK recovery, cancellation/expiry/supersession/grant replacement and uncertain dispatch. Native memo does not close the provider effect/result crash window. An unsafe dispatch recovery must reconcile or report uncertainty, not execute again. Keep encrypted broker records/tombstones until their negative-authority purpose is replaced. Moving polling into a Task alone does not remove polling or OAuth policy; do not build this merely to replace a filename.

## Phased implementation and exit criteria

Each approved implementation phase has isolated behavioral verification and one commit. Reuse/extend the meaningful HTTP/native SQLite/SDK/browser/container tests; no helper/schema echoes, artificial test/LOC target or mechanical test deletion. **The core phases below can land on the existing pinned 1.0.0.** Release alignment is independent and optional; experimental upgrade risk must not block cuts already supported by the installed API.

### Phase 1 — Separate Pi composition from legacy execution/viewing

Make the Pi startup path construct only its runtime plus read-only legacy viewing. Extract legacy execution as an explicit compatibility entrypoint while rollback is retained; keep old URLs, aliases, unknown-event/omitted-marker rendering and admin access.

**Exit:** Pi runs/views without constructing live OpenCode resources; historical and Pi viewers preserve behavior; explicit legacy execution and default `THOR_RUNTIME=opencode` remain unchanged. Restore actor/alias/trigger context before submit/wait/abort/resume; preserve the `x-thor-internal-secret` trigger boundary and viewer routes under existing SSO-protected `/runner/` ingress. No SQLite mount into broker/executor, deleted history, default/ingress cutover or weakened authentication. This phase reduces coupling, not merely file sizes.

### Phase 2 — Native execution truth and one request owner

Evolve Neo metadata; derive submitted terminal state/bounded successful history from native records; retain intent/fingerprint/policy/authorization evidence. Consolidate recovery/presentation ownership; restore shared actor projection before progress-enabling calls. Keep serialized busy/interrupt semantics. Remove redundant lifecycle fields only after all readers migrate.

**Exit:** exact duplicate/mismatch and cross-conversation identity, intent→submit and settlement→projection crash windows, scope-safe delayed callbacks, success/error/abort history bounds, fixed duration, two-requester model/cwd/grant isolation, escalation commit→memo and OAuth restart/supersession behavior remain correct. Native done plus outstanding/unconfirmed authorization is not successful NDJSON/Slack completion; broker timeout/non-OK and missing-team configuration cannot invent no-wait evidence. Original requester hold and later supersession are explicit. Existing `findActiveSlackTriggerActor`, alias/admin/approval/disclaimer readers work under restore-before-scheduling ordering. No silent malformed-state fallback or migration erasure.

### Phase 3 — Host-owned ordinary answer delivery and lean Slack projection

Implement the approved final-reply/decoration contract and single presentation path; switch ordinary posting instructions in the same change. Keep explicit outbound/rich actions and NDJSON/legacy compatibility at their edges. Remove now-unused ordinary reply prompt/tool glue and Pi-only shadow presentation registries.

**Exit:** new-admission-only host policy versus historical/pending tool policy, final-answer-only/empty selection, frozen private destination, all three prompt/skill instruction surfaces, explicit artifacts plus final summary, Slack formatting, short/long requests, native snapshot overflow, model/escalation metadata, static OAuth wait, source eyes/check, delayed sends/supersession, send-before-receipt and partial/uncertain delivery pass through real interfaces. No double ordinary model+host reply, historical answer publication, automatic uncertain repost, new delivery workflow engine, raw reasoning or replay of completed tools. Keep the existing completion-decoration contract unless separately approved.

### Phase 4 — Acceptance and legacy execution retirement (separate approval)

Run relevant Unit/Pi Runtime/Core/GWS/sandbox/browser gates according to changed scope; push/dispatch only with authorization and open a PR after required checks pass. Accept on the existing Ubuntu deployment using unchanged project/keys/volumes, then explicitly decide whether to retire the legacy execution entrypoint/services. Preserve the read-only historical viewer permanently for existing records.

**Exit:** CI gates plus separately reported live Slack/model/OAuth and Ubuntu isolation acceptance; no second Slack consumer. Runtime-default/ingress/Compose cutover and rollback retirement each need explicit approval, not incidental inclusion in viewer extraction or acceptance. If retirement is approved, remove now-unused legacy trigger/SSE/tool-projection code and their execution-only dependencies/tests. Update every affected Compose/env/README/workflow surface together. No `down -v`, data-directory rename or unverified downgrade against migrated SQLite.

### Optional independent phase — Released package alignment

If approved, coordinate exact 1.0.2 Pi Durable/Pi AI/Chord pins in runner and executor together; review exports, sampling/provider behavior and lockfile impact. Keep retries disabled. Verify existing-store reopen, lazily created provider identity, stable identity across restart/model changes and distinct new/forked conversations. Do not claim backend account/cache affinity without actual codex-lb evidence. This is release maintenance, not a prerequisite for phases 1–3.

**Exit:** existing full native/integration behavior, request payloads, types/builds and provider identity recovery pass on the release; executable saved model policy fails closed, completed retired-model history stays readable; backup/rollback compatibility is documented before upgrade. No state reset, automatic update or unsupported database downgrade.

**Optional later phase:** typed Google child Task only after its separate gates. Native heterogeneous queueing and gateway merger remain deferred; neither blocks the core simplification.

## Decision log (proposed)

| Decision                                                           | Reason / approval boundary                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep runner-owned embedded Harness; no adapter/conversation server | Native Durable should own execution, not sit beneath another runtime abstraction.                                                                              |
| Keep gateway, executor and broker initially                        | They own external custody/security, not alternate LLM lifecycles. Fewer containers alone would not delete those responsibilities.                              |
| Prefer native settlement/history over mirrored receipt status      | Removes disagreement/recovery machinery while keeping domain admission/authorization evidence.                                                                 |
| Retain two-commit admission recovery and fingerprints              | Released public API cannot supply combined admission or changed-payload/global dedup guarantees.                                                               |
| Keep serialized active requester/model boundary                    | Native queued input does not freeze actor/model/cwd authority.                                                                                                 |
| Make ordinary final reply host-owned                               | Removes a basic chat dependency on model tool compliance; delivery/decoration contract needs approval.                                                         |
| Retain current Google coordinator in core cut                      | It implements external grant-bound automatic continuation already verified by existing fixtures. Native Task redesign is optional, not magic deletion.         |
| Routing stays optional operator policy, not a second provider      | Preserve shipped overrides/escalation and saved choices; existing `autoSelect`/`allowEscalation` controls suffice. No speculative capability/plugin framework. |
| Separate historical OpenCode viewing from execution retirement     | Old links/data must survive even after live legacy runtime is removed; retirement is not assumed authorized.                                                   |
| No LOC/test-count target                                           | Demonstrate deleted responsibilities, fewer authorities and stable recovery/permission contracts, not cosmetic shrinking.                                      |

## Risks, non-goals and deployment boundaries

- No blanket deletion of receipts, disk queues, locks, Google outbox or shared JSONL. No already-available native feature is advertised as newly added in 1.0.2.
- No new permission policy, routine Google command approvals, credential mounts into runner tools, live catalog probes, guessed model IDs, provider retries or app-level rate limiter.
- Preserve current requester authority, private OAuth DM/account verification, unrelated integration approvals, Slack/GitHub/cron attribution, model selection through resume/restart and unsafe-effect boundaries.
- Preserve `THOR_*`, `@thor/*`, crypto/protocol namespaces, `thor.pi.conversation`, public IDs/aliases/paths, callback URLs, Compose project, existing `.env`, grants/encryption keys and volumes. No new env family is proposed. Any future env change updates all required surfaces in one phase.
- Keep single-owner fencing: Node SQLite transaction locks do not prevent two Harnesses executing the same work. WAL/NORMAL process-crash evidence is not a power-loss guarantee. Close/join before releasing the owner.
- Native snapshots contain private state. Presentation is an intentional projection, not raw state forwarding. Retain executor byte/pixel/raster bounds and no runner-local file fallback.
- The official `pi-chat` is a coding-agent CLI extension for Discord/Telegram with tmux/Gondolin, **not a Durable Slack bridge**. Borrow host-owned reply-to patterns; do not adopt its deployment stack or agent-readable runtime secret exchange.
- Local fixture evidence is not live provider/Slack/OAuth/Ubuntu acceptance. Katalon asset redistribution rights and Slack/client animation preferences remain existing unresolved external gates, not solved by this refactor.

## Review evidence and source references

This change is **a source-backed plan only**: no runtime/dependency/config changes, target execution, installs, live account calls or new tests. The prior 1,018-case results belong to earlier commits; they are not new validation of this architecture or 1.0.2.

Four independent source reviews covered native capabilities, runner ownership, admission/broker boundaries and the chat reference. A subsequent critique prompted explicit release-optional sequencing, minimal publication state, old/new reply policy/privacy, unconfirmed OAuth holds, startup authentication/order and runtime-default gates. Follow-up plan verification passed those amendments. This is planning verification only; implementation exit criteria remain future work.

- [Released Durable README](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md) and [normative specification](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/docs/spec.md): submissions, per-conversation agent, tasks/replay and observation guarantees.
- Release source: `harness/submissions.ts::admitSubmission`, `harness/harness.ts::ConversationImpl`, `harness/agent.ts::AgentDoc/configure`, `harness/generation.ts::GenerationTask`, `harness/tool.ts::ToolTask`, `harness/provider.ts::ensureProviderSessionId`, `session/observation.ts`, `types.ts::EntryQuery/TaskRuntime`, `tools/read.ts`, `storage/sqlite/node.ts`, under the same pinned Durable tree. `test/harness-submissions.test.ts` explicitly covers changed-content same-ID replay; `test/examples/14-chat.ts` demonstrates exact answer selection.
- Neo: `packages/runner/src/pi-runner.ts::{fingerprintPiRequest,reconcileLogs,submissionFor,entriesFor,doneFrame,monitor,startAccepted}`, `pi-runner-state.ts`, `pi-model-routing-runtime.ts`, `pi-runner-tools.ts`, `pi-storage-owner.ts`, `pi-execution-env.ts`, `pi-read-image.ts`, `index.ts`; `packages/common/src/{event-log,progress-manager,progress-events}.ts`.
- Admission/security: `packages/gateway/src/{app,service,queue,batch-request,slack,slack-channel-gate}.ts`; `packages/runner/src/google-auth-continuation-poller.ts`; `packages/remote-cli/src/{gws-oauth,gws-slack-identity,gws,index,slack-post-message}.ts`; `packages/common/src/google-auth-continuation.ts`.
- [Official chat reference](https://github.com/earendil-works/pi-chat/tree/9adbd29b40ee27ff1decf0fc87cbe180b40924f5): actual README/source/package contracts, not the broad Slack/chat label in Pi's root README.
- Before touching historical event/viewer code, follow [the OpenCode schema/viewer drift plan](2026051601_opencode-event-view-schema.md).
