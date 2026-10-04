# Neo — Pi Durable-native Slack simplification

**Status:** Core Phases 1–3 and Phase 4's feasible **local acceptance** are verified after `dfaa3ad`; MCP companion core Phases 1–4 are implemented. Phase 4 is **not fully accepted**: CI, live workspace/provider/OAuth and Ubuntu deployment acceptance remain unrun. Deployment, default cutover and rollback retirement require separate approval.
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

### Junior-inspired working effect with Neo's AI animation (user requested)

Adopt Junior's **acknowledge → native loading/status → paced progress → completed reply → cleanup** experience inside the single Neo presentation owner. This is part of Phase 3, not a separate UI runtime or import of Junior's Chat SDK/Redis worker stack. Preserve Neo's current source reactions, animation artwork and task-model evidence.

**Reference behavior, checked at Junior `dae707a84520a541c08d81a5e8047b22a6f819c0`:** ingress adds a processing reaction before publishing accepted work, best effort and deduplicated; a per-turn status scheduler serializes writes, coalesces rapid updates (1s debounce / 1.2s readability window), and refreshes legacy loading state every 30s. Its sender keeps the raw status generic (`is working on your request...`) and uses `loading_messages` for readable progress. It clears pending timers/loading on exit. Current `slack/adapter.ts` explicitly uses completed assistant-message posts plus status updates, not bespoke token-streaming edits. Junior also accepts model-reported progress/plan text; Neo must not copy those strings blindly into shared Slack.

#### Visible journey

| Observable state                     | Slack presentation                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted / queued                    | Best-effort Neo-owned 👀 on the exact human request. Queued arrival cannot replace the current task's footer/native status or claim execution has started.                                                                                                                                     |
| Active model work                    | Native working/loading effect where available; compact **official thinking GIF** with `Neo thinking` and saved Model / Thinking metadata after the existing footer grace.                                                                                                                      |
| Tool work                            | **Official working GIF**, `Neo working`; a safe public operation category such as searching/reading may be shown only when established by observable work, not invented progress.                                                                                                              |
| Output / response publication        | **Still AI mark**, `Neo responding`; motion stops when output begins. Publish only the permitted final answer under the host-owned contract above.                                                                                                                                             |
| Confirmed Google/approval hold       | **Still AI mark**, explicit waiting label; native suspension where supported. Keep eyes and do not claim completed work. Approval display depends on authenticated broker outcomes, not model prose or a new waiter.                                                                           |
| Unconfirmed authorization / delivery | Static, accurately degraded label; no fabricated sign-in requirement, ongoing tool work or confirmed publication. Preserve the companion completion/uncertainty rules.                                                                                                                         |
| Normal completion                    | Clear native loading, remove/settle activity footer, retain task Model / Thinking on the final reply's compact context footer where that reply exists; remove only Neo's eyes and add ✅ to the frozen source. This remains turn completion, not proof of Google/resource success or delivery. |
| Error / interruption / supersession  | Stop motion and clear owned native loading; static error/stopped state or cleanup as appropriate. No success reaction, result replay or late update on the replacement request.                                                                                                                |

The existing `/neo-thinking-v1.gif`, `/neo-working-v1.gif` and `/neo-ai-still-v1.png` remain authoritative. One moving AI mark per active thread surface, no restored hourglass, generic spinner/dots/pulse substitution or new artwork. Keep readable labels and a text-only fallback. The compact footer is the reliable custom-animation surface; native status is a platform loading effect, not a guarantee Slack renders an arbitrary GIF there. Do not set a second animated native/avatar icon, change the installed app icon or add `chat:write.customize` just to duplicate the footer. Katalon rights and live client playback/reduced-motion acceptance remain existing external gates.

#### Slack API compatibility gate

Slack documentation checked 2026-10-04 recommends **`agents.sessions.setStatus`** over Junior's current `assistant.threads.setStatus`:

- Use the existing admitted `channel_id` + `thread_ts` for a thread-based session; never infer a new reply destination or requester from Slack's session initiator/title. Set `processing` only for actual active work, `suspended` for confirmed user-action holds, and `active` when this task is finished/stopped but the conversation remains reusable. `closed` is conversation retirement, not every task completion.
- Inspect the calling Neo agent's `agent_status`, not another agent's aggregate session status. Explicitly leave `processing` on completion/wait/error/stop: **the current sessions API does not automatically clear loading when a reply is posted**, unlike the legacy API. Reconcile best-effort UI state on restart from validated native/domain facts; status writes do not authorize execution.
- Ordinary status calls use `chat:write`. Custom identity overrides need `chat:write.customize`; this plan does not request them. Workspace/surface support must be verified; `feature_disabled`, missing permission or unsupported methods degrade to existing AI footer/text instead of blocking the task or changing privacy/channel policy.
- Use the legacy assistant status method only as an explicitly verified compatibility path. Keep its raw status generic, validated factual `loading_messages` (at most ten), and a low-frequency keepalive while actual work continues because its loading state expires after two minutes. Do not rotate fictional task steps, untrusted plan/tool arguments, private reasoning, filenames, resource titles, queries or OAuth details. The sessions API is lifecycle-based; do not transplant legacy loading-message/refresh arguments onto it.
- No automatic manifest migration. Switching `assistant_view` to `agent_view` can be irreversible; workspace feature activation or app reinstallation requires operator approval. Existing admitted surfaces remain unchanged. Do not subscribe to/show a native stop button until a signed, requester-policy-checked, request-scoped stop path is implemented and validated; a late stop must not abort a newer request. It is not necessary to add stop-button scope for the loading effect itself.

#### One owner and pacing

Project native activity/model plus authenticated wait outcomes once, then send native status and the compact footer through the same request-scoped serialized/coalescing owner. No second timer registry, observer, progress LLM or `reportProgress` tool is needed just for this effect. Retain the existing 1.5s / completed-call footer threshold; a fast task may finish without a footer but still gets source acknowledgement/completion.

Adopt Junior's readable debounce/minimum-visible principle for **nonterminal phase changes**, not exact constants as an API contract. Never delay terminal cleanup or keep an animation running to satisfy a minimum duration. Cancel/drain pending status/footer sends before replacement ownership; late clear/status/model callbacks cannot clear a newer task's native loading or overwrite its footer. SDK rate-limit responses and endpoint-specific keepalive needs govern refresh; no per-token API calls, artificial percentage, vendor-private error body or new app-level rate limiter.

**Phase 3 gates:** extend existing real Slack SDK/local HTTP + native SQLite fixtures for native lifecycle transitions/explicit clear, supported versus unavailable status methods, legacy expiry/keepalive, acknowledgement-before-fast-completion, queued-versus-active ownership, readable coalescing, pending write versus clear/supersession, factual labels, single animated mark, still output/wait/error, final model metadata and source-specific eyes/check. Reconnect/snapshot overflow cannot invent tool progress; Google/MCP holds and unconfirmed authorization cannot claim success. Test transport failure without task replay. Live Slack workspace surfaces, playback/accessibility and lifecycle cleanup are a separate acceptance gate; mocks do not prove visual rendering.

**Sources:** [Junior Slack adapter contract](https://github.com/getsentry/junior/blob/dae707a84520a541c08d81a5e8047b22a6f819c0/packages/junior/src/chat/slack/README.md), `assistant-thread/{status-scheduler,status-send,status-render}.ts`, `providers/slack/processing-reaction.ts`, `runtime/report-progress.ts`, `slack/adapter.ts`; [Slack session status](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/), [legacy assistant status](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/) and [migration/lifecycle cleanup](https://docs.slack.dev/ai/migrating-to-agent-messaging). Review only; no live Slack calls, scope/manifest changes or animation re-export.

Focused independent plan verification passed the source/lifecycle/animation/ownership boundaries. This does not validate live rendering or authorize implementation/deployment; the Phase 3 isolated and workspace acceptance gates remain future work.

**Prototype review:** throwaway branch `prototype/neo-slack-working`, snapshot `bb74e7c`, captures three Slack-style layouts at `packages/runner/src/slack-working.prototype.html`: A quiet footer, B activity card and C step trail, using unchanged AI assets and synthetic task states. The user marked **A — Quiet footer** preferred in the local review window (completed state, dark theme). Record this as the initial visual direction: native loading plus one compact AI mark/model line, with task metadata on the final reply. It does not approve implementation/deployment, verify native Slack playback or accept every lifecycle state; further feedback and Phase 3 acceptance gates remain. The prototype/server/switcher stay on the throwaway branch, not in production code. Run there with `pnpm prototype:slack` for further review.

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

### Phase 3 — Host-owned replies and Junior-style working presentation

Implement the approved final-reply/decoration contract and the user-requested Junior-inspired loading/pacing/cleanup with Neo's existing AI mark, using the single presentation owner above. Gate native Slack lifecycle support and preserve footer/text fallback. Switch ordinary posting instructions in the same change; keep explicit outbound/rich actions and NDJSON/legacy compatibility at their edges. Remove now-unused ordinary reply prompt/tool glue and Pi-only shadow presentation registries, not the UX itself.

**Exit:** new-admission-only host policy versus historical/pending tool policy, final-answer-only/empty selection, frozen private destination, all three prompt/skill instruction surfaces, explicit artifacts plus final summary, Slack formatting, short/long requests, native snapshot overflow, model/escalation metadata, static OAuth wait, source eyes/check, delayed sends/supersession, send-before-receipt and partial/uncertain delivery pass through real interfaces. No double ordinary model+host reply, historical answer publication, automatic uncertain repost, new delivery workflow engine, raw reasoning or replay of completed tools. Keep the existing completion-decoration contract unless separately approved.

The Junior-inspired working-effect gates above also pass: no stuck native processing, duplicate moving mark, delayed terminal cleanup or unsupported API assumption. Keep scope/app-feature activation separate from code deployment approval; confirm the actual Slack rendering before claiming the effect accepted.

### Phase 4 — Acceptance and legacy execution retirement (separate approval)

Run relevant Unit/Pi Runtime/Core/GWS/sandbox/browser gates according to changed scope; push/dispatch only with authorization and open a PR after required checks pass. Accept on the existing Ubuntu deployment using unchanged project/keys/volumes, then explicitly decide whether to retire the legacy execution entrypoint/services. Preserve the read-only historical viewer permanently for existing records.

**Exit:** CI gates plus separately reported live Slack/model/OAuth and Ubuntu isolation acceptance; no second Slack consumer. Runtime-default/ingress/Compose cutover and rollback retirement each need explicit approval, not incidental inclusion in viewer extraction or acceptance. If retirement is approved, remove now-unused legacy trigger/SSE/tool-projection code and their execution-only dependencies/tests. Update every affected Compose/env/README/workflow surface together. No `down -v`, data-directory rename or unverified downgrade against migrated SQLite.

### Optional independent phase — Released package alignment

If approved, coordinate exact 1.0.2 Pi Durable/Pi AI/Chord pins in runner and executor together; review exports, sampling/provider behavior and lockfile impact. Keep retries disabled. Verify existing-store reopen, lazily created provider identity, stable identity across restart/model changes and distinct new/forked conversations. Do not claim backend account/cache affinity without actual codex-lb evidence. This is release maintenance, not a prerequisite for phases 1–3.

**Exit:** existing full native/integration behavior, request payloads, types/builds and provider identity recovery pass on the release; executable saved model policy fails closed, completed retired-model history stays readable; backup/rollback compatibility is documented before upgrade. No state reset, automatic update or unsupported database downgrade.

**Optional later phase:** typed Google child Task only after its separate gates. Native heterogeneous queueing and gateway merger remain deferred; neither blocks the core simplification.

## Implementation record

### Phase 1 — 2026-10-04

Implementation begins with the handoff's next phase, starting with composition separation. `index.ts` now owns runtime selection and startup/shutdown only. It dynamically imports `legacy-runner.ts` only for default/explicit OpenCode execution. Pi constructs `createLegacyRunnerViewer()` instead of `createRunnerApp()`; the historical owner installs only the two existing GET viewer routes, with no JSON parser, trigger/helper/health route, live SDK, event bus, config loader or execution progress transport.

Historical rendering moved unchanged, including aliases, owner/current-session distinction, escaped content, omitted markers, unknown events and recursive subagent logs. Shared raw-field/token parsing lives in `opencode-event-fields.ts`, so legacy context progress does not import the historical renderer for token accounting. No new service/adapter, native state migration, reply-policy change, dependency, environment variable, mount or ingress change was introduced. Default `THOR_RUNTIME=opencode` and explicit rollback execution remain intact.

Validation on Node 24:

- All eight workspace typechecks passed; runner split build passed.
- Full unit suite: **68 files / 1,021 tests passed**. New entrypoint checks exercise unset/explicit OpenCode, Pi with execution-module import rejection, historical/native viewer URLs, trigger authentication, absence of legacy helper routes and graceful storage-owner release.
- Historical viewer is exercised directly without execution-resource construction; POST/health routes return 404 and reads leave session records unchanged. Existing viewer cases retain unknown-event, omitted-marker, patch, UTF-8 and recursive-subagent coverage.
- Existing SQLite recovery fixture now deletes shared worklog/aliases before reopening and observes the correct original Slack actor at the first recovered model dispatch. Admission, interrupt/drain, continuation and resume ordering remain unchanged in this phase; strengthening request-scoped ownership is Phase 2 work.
- Three additional isolated checks reran the production-entrypoint fixtures against compiled `dist/index.js` rather than tsx source, including the SDK import rejection guard. Temporary validation copies were removed afterward.
- `scripts/test-pi-e2e.sh` passed with real isolated containers: native tool execution, wrapper identity, Slack SDK presentation, signed gateway intake, SSO viewer/admin routes, model routing, storage/credential isolation and SIGKILL recovery. Its test containers/volumes were cleaned up.

Independent source verification found no extraction regressions. Its bundled-entrypoint gap was closed by the compiled checks. Proposed extra per-call restoration edits were not retained: this phase preserves the existing admission ordering instead of introducing unverified recovery-policy changes. No live provider/Slack/OAuth/Ubuntu acceptance, Core E2E against real integrations, push, GitHub workflow or PR was performed. These results validate Phase 1 only, not the quiet-footer implementation or MCP catalog.

**Phase 1 handoff:** Phase 2 owns native execution truth, watch/terminal-presentation lifetime and unconfirmed authorization. Its implementation evidence follows; Phase 1 did not activate host replies or native Slack status.

## Phase 2 implementation and isolated verification

Implemented on the existing Durable/Pi AI/Chord **1.0.0** pins, using supported
`defineDoc.migrate`, submission status/wait and inclusive native entry-query
bounds. No internal admission API, package upgrade, runtime-default change,
credential mount, live account call or ordinary-reply/native-status change.

`thor.pi.conversation` now has an explicit version-2 representation. Version-1
identity, fingerprints, requester/source/workspace, policy, escalation task-ID
evidence and Google continuation bindings migrate without changing public IDs.
Current/legacy/hybrid evidence selects one parser; malformed authority fails
startup intact, without a weaker fallback. All bindings validate before native
recovery starts or migration/input-retirement commits. Runner-wide request and
public-session collisions fail closed. The remaining admission union describes
only pre-submit input intent, native admission/input retirement or pre-submit
withdrawal; it is not a second execution lifecycle.

Removed receipt terminal `status` and `googleAuthWaiting` from the current
representation. Native submission records decide completion/error/abort. Exact
native input→answer bounds drive successful history, without searching later
receipts; unanswered inputs keep a fixed observation fence and explicit next
native-input fallback. Prompt and routing-text copies disappear once native
admission exists. Completion duration is fixed at the first settlement
observation, before terminal presentation drains, not at history retrieval. The
released native record has no completion clock; migration uses existing shared
trigger-end time where available, otherwise fixes the first recovery observation
instead of inventing historical timing.

Reader migration was traced through HTTP duplicate/stream/history responses,
shared log reconciliation, Google coordinator admission/recovery, model-routing
configuration/escalation and all actor/correlation/reply/Google prompt sections.
The model/tool readers still use `activeRequestId` as serialized requester
authority, not terminal status. Shared alias/current-trigger facts remain for
gateway/admin/approval/disclaimer/broker readers. Every submit/wait/abort and
startup resume path restores that projection first, including pre-submit,
native-submit→Neo-retirement and native-settlement→projection gaps. Frozen native
cwd joins the existing model/thinking recovery checks.

One request-owned monitor covers setup, callbacks, settlement and terminal
presentation. Ownership registers before awaited presentation; native watch
stop detaches and the owned callback promise drains **before** terminal presentation, and active requester
authority clears only after those writes drain. Released 1.0.0 watch stop can
resolve while an asynchronous listener still runs; awaiting the owned callback
is required, not a second observer or execution lifecycle. Replacements cannot install a
new actor/model/footer while the old owner is delayed. A failed observer is
disposed without withdrawing live execution; interruption of unobserved native
work aborts/joins and projects its settlement before replacement. Graceful close
also drains only this runner's scoped progress owners. Native attach/overflow
rebuilds factual tool accounting from bounded immutable request history via
`tools_snapshot`, rather than announcing old completions as fresh progress.

Broker observation now parses **confirmed waiting / confirmed no matching wait /
unavailable** outcomes. Timeout, disconnect, non-OK, malformed responses and a
missing frozen team are not no-wait evidence. A prior confirmed hold retains
`waiting_unconfirmed` provenance if it disappears or becomes unverifiable;
repeated reads cannot erase it into success. Holds keep the original request
latest until a newer admitted request or authenticated continuation supersedes
it. NDJSON uses non-success status plus `authWait: google` or `unconfirmed`;
Slack keeps eyes, skips checks and uses static wait/degraded presentation. Pure
observation recovery does not replay model/tool/Slack completion effects or
create OAuth invitations. Existing grant-bound continuation and escalation
commit→memo recovery are preserved. A native continuation submission proves the
preceding bound ACK already succeeded; lease checks still gate new outbox
admission and broker grant/expiry/tombstone checks still gate actual dispatch.

Validation on Node 24.21.0 with installed dependencies:

- Full unit suite: **68 files / 1,037 tests passed**. Includes real HTTP/SQLite,
  Responses/executor, Slack SDK and Pi→wrapper→Google OAuth continuation fixtures.
- All eight workspace typechecks and all workspace builds passed.
- New behavioral cases cover version-1 migration versus corrupt hybrid
  preservation, native status precedence, native admission/settlement gaps,
  pre-submit actor restoration, success/error/abort history bounds, stable
  duration/restart, delayed terminal ownership, failed-observer abort, competing
  actors/cwd/cross-conversation IDs, each unavailable/missing-team outcome,
  disappearing holds and snapshot accounting without fresh-completion pulses.
  Existing SIGKILL/escalation commit→memo, unsafe-tool, supersession and
  grant/continuation cases remain green. Finite real-boundary/interleaving cases
  were chosen over a new property-test dependency or schema echo tests.
- Rebuilt `scripts/test-pi-e2e.sh` passed: signed intake, actor/model routing,
  actual remote tools/wrappers, exact source eyes/check, Slack SDK activity,
  image/isolation, admin/SSO viewers and SIGKILL recovery. Its dummy broker now
  answers authenticated no-wait queries and the test runner freezes its existing
  team setting; the fixture no longer relies on an unavailable broker looking
  like success. Temporary containers/volumes were removed.
- A full run concurrent with Docker builds/typechecks hit the existing 5-second
  callback-before-turn-finish test timeout. The isolated serial full rerun passed
  unchanged; no assertion or timeout was relaxed. Logs are in
  `/tmp/phase2-final-tests-serial.log`, `/tmp/phase2-final-types.log`,
  `/tmp/phase2-final-build.log` and `/tmp/phase2-final-e2e.log`.

These are Phase 2 isolated gates, not live Slack/model/OAuth/Ubuntu acceptance.
No push, CI workflow, PR, deployment/cutover, database downgrade or legacy
retirement was performed. Existing browser/account proofs and broker credential
ownership were not changed; live/Core/Google/browser acceptance remains Phase 4
work. Back up before migrating deployed SQLite; do not run an older Pi runner
against the version-2 metadata.

### Phase 2 verification correction — 2026-10-04

Independent verification reproduced a version-1 SQLite recovery defect: an
expired Google continuation could leave a legacy `aborted` mirror and no
`activeRequestId` while its native input remained `placed`. Migration translated
that mirror to pre-submit `withdrawn`; status derivation incorrectly let it hide
live native execution from requester validation. Startup then committed input
retirement and resumed without the original requester in actor/model context.
The initial Phase 2 validation above did not cover this interleaving.

Native `placed`/`queued` input now takes precedence over withdrawal just as native
settlement already takes precedence over terminal mirrors. Startup therefore
requires the persisted active/latest requester and frozen native configuration
before committing migration or enabling scheduling. Missing requester authority
fails closed; it is not reconstructed by guessing from the continuation or
thread. The version-1 aborted translation remains provisional until this
native-aware validation passes; pre-submit withdrawal without native admission
retains its existing behavior.

Expanded the real SQLite/Responses/executor fixture to seven recovery cases:
settled legacy history with an incorrect error mirror, corrupt hybrid metadata,
live version-1 aborted/error/completed mirrors, and live version-2 withdrawn
placed/queued inputs. The aborted case includes expired Google continuation
evidence and absent active requester. Every rejection preserves the exact
metadata (including version-1 prompt/status), native submission and agent
configuration, creates no shared trigger projection, and issues **zero model or
executor requests**. Valid settled history still migrates without replay.
These finite native/status/version cases extend the existing boundary test;
no new schema echo test, property-test dependency or abstraction was added.

Correction validation on Node 24.21.0:

- Relevant runner, Pi Google integration and progress behavior: **3 files / 144
  tests passed**, including the seven recovery cases.
- Full serial unit suite: **68 files / 1,042 tests passed**.
- All eight workspace typechecks and all workspace builds passed.
- Deliberately removing native-live precedence reproduced unsafe successful
  startup in both the version-1 aborted and version-2 withdrawn placed cases;
  both regression tests failed. The fix was restored before final verification.
- Logs: `/tmp/phase2-correction-behavior.log`,
  `/tmp/phase2-correction-full-tests.log`, `/tmp/phase2-correction-types.log`,
  `/tmp/phase2-correction-build.log` and
  `/tmp/phase2-correction-deliberate-regression.log`.

This correction amends the Phase 2 commit, rather than adding a downstream
phase commit. No push, CI, container E2E rerun, live acceptance, deployment or
Phase 3 implementation was performed for the correction.

**Historical Phase 2 handoff (completed below):** Phase 3 host-owned replies and the approved quiet-footer/native working
effect, with its privacy/publication/pacing/lifecycle gates unchanged. Keep
legacy execution/default OpenCode and the tool-owned reply instructions until
that phase's new-admission-only policy is implemented.

## Phase 3 implementation and isolated verification

Implemented on the unchanged Durable/Pi AI/Chord **1.0.0** pins. Version 3 of
`thor.pi.conversation` freezes host versus tool reply ownership and bounded
publication/footer evidence on each existing request binding. Versions 1/2,
including pre-submit intents and completed history, migrate as **tool-owned**;
malformed current/hybrid data remains intact and fails startup. No answer is
auto-published merely because an old receipt becomes readable.

Gateway preserves signed team equality through the existing disk privacy reroute
and freezes the permitted target only after privacy and repository admission.
Old queued/frozen payloads have no such proof and cannot acquire it on retry.
Runner rejects inconsistent workspace/requester/canonical-thread authority before
interruption. Host targets remain independent of correlation aliases: a Slack
request associated with a git anchor still uses its admitted private Slack
surface; GitHub/cron do not inherit that publication policy. Existing aliases and
serialized requester/model/cwd authority remain the source of conversation scope.
OAuth continuation copies the original ownership and target, never the paused
answer. All three reply instruction surfaces distinguish automatic final text
from tool-owned ordinary replies and explicit outbound/rich artifacts.

The sink reads only the successful native input's exact answer entry and its
assistant text blocks. Empty/reasoning-only answers issue no publication. Native
history keeps content; the binding stores answer/destination plus pending,
confirmed timestamp, uncertain or rejected disposition, with at most 64 chunk
receipts. Intent commits before I/O; SDK retries are disabled. Pending recovery,
lost/malformed receipts, send-before-receipt SIGKILL and partial delivery do not
authorize another send or model/tool replay. Formatting preserves code, converts
common headings/bold/links to Slack mrkdwn, escapes ordinary text markup and
chunks within Block Kit's UTF-16 budget without splitting Unicode. Unbreakable/
over-budget content is rejected rather than clipped. Final Model / Thinking is
on the last answer chunk. Rich tool output is not retransmitted; the final text
is a summary. The authenticated viewer reports publication separately from model
completion; ✅ remains normal turn completion, not delivery/business success.

`PiSlackPresentation` is the request-owned Slack projection under the existing
conversation/monitor owner. Pi no longer uses common `ProgressSession`'s global
session/message/replay registries; those remain for OpenCode/NDJSON compatibility.
One timer and serialized line coordinate the native lifecycle, quiet footer and
source reactions. The 1.5-second/three-completed-call grace is preserved. Rapid
nonterminal phases/model changes coalesce; output becomes still immediately and
terminal cleanup cancels pacing, drains issued writes and clears loading before
broker observation/final publication. Snapshot replacement restores counts
without new-completion pulses. A fresh native status read after acknowledgement
prevents processing for a turn that already finished. Startup repairs owned
native/known-footer state without replaying replies or checks. Shutdown drains
completed publication and persists cleanup before closing SQLite.

Slack's current public docs were fetched during implementation: thread sessions
use only `channel_id`, `thread_ts`, lifecycle `status`; **calling** `agent_status`
confirms the write even when aggregate status differs. The installed SDK's
generic `apiCall` handles `agents.sessions.setStatus` with parsed response evidence,
without a package upgrade. Actual work uses processing, confirmed Google holds
use suspended, and settled/stopped reusable conversations use active, never
closed. Unsupported feature/method/permission outcomes keep the footer/text and
never activate scopes/manifest features or try legacy blindly. Explicitly
verified embedded compatibility configuration alone selects the legacy method,
generic factual loading and a 30-second active keepalive; holds/end clear it.
No avatar/custom identity, stop subscription, extra observer/timer registry,
progress LLM, publication task, delivery scheduler or outbox was added.

Isolated evidence on Node 24.21.0:

- Real Responses/executor HTTP, native SQLite and Slack WebClient fixtures cover
  new-only policy, old pending migration, malformed-state preservation, private
  targets/aliases, final-only/empty/reasoning selection, artifact plus summary,
  formatting/Unicode/chunks, confirmed/rejected/lost/partial sends, duplicate/
  restart/SIGKILL no-repost, no completed-tool replay, late receipt ownership,
  queued versus active work, pending native write versus interrupt/clear,
  unavailable methods/permissions, own versus aggregate agent status, explicitly
  verified legacy arguments, restart still/clear and exact human eyes/check.
- Single-owner timing fixtures cover readable coalescing, instant still output/
  terminal drain, three-call grace, snapshot accounting without invented pulses,
  and verified legacy keepalive/hold stop. Existing authenticated Google hold,
  unavailable/timeout/missing-team, continuation/escalation and requester-isolation
  suites remain required. Generic native MCP tools/approval outcomes are not yet
  supplied by this phase; their authenticated hold gates belong to the companion,
  not model prose or a placeholder waiter in the Slack owner.
- Final serial full suite: **70 files / 1,074 tests passed**. All eight workspace
  typechecks and all workspace builds passed. Rebuilt isolated Pi container E2E
  passed on the final sources, including native loading/explicit clear and two
  host replies without the ordinary posting wrapper; the separate direct
  tool-owned wrapper path still passes. Logs: `/tmp/phase3-tests-verified.log`,
  `/tmp/phase3-types-verified.log`, `/tmp/phase3-build-verified.log`,
  `/tmp/phase3-e2e-verified.log`. Earlier targeted real-boundary/timing checks and
  full reruns also passed; no timeout was relaxed. The obsolete instant
  post-tool-phase assertion now checks native phase evidence plus the separate
  paced-owner tests, rather than requiring a short phase to bypass coalescing.
- `scripts/test-pi-e2e.sh` exercises signed new host-owned intake/follow-up with
  final metadata and explicit native clear, alongside unchanged direct legacy/
  tool-owned wrapper posting, native execution/model routing, shared aliases,
  source reactions, viewer/SSO and credential/mount/SIGKILL recovery isolation.
  Its uniquely named dummy containers/volumes are removed afterward.

No live Slack feature activation/rendering/playback/accessibility, real provider/
OAuth/Ubuntu deployment acceptance, MCP implementation, optional upgrade,
runtime-default change, push, workflow dispatch or PR is implied. An activity
post lost before its local timestamp may still need manual UI cleanup; answer
uncertainty never becomes automatic repost permission. Back up deployed SQLite
before migration and do not run an older Pi runner against version-3 metadata.

### Phase 3 verification correction — 2026-10-04

Independent verification of `bca36c5` reproduced three missing gates. Earlier
Phase 3 results did not establish these interleavings:

1. A native successful host-owned answer settled during a broker 503, with no
   publication intent. A later authoritative `waits: []` changed NDJSON to normal
   completion but only deleted the degraded footer: no first answer, eyes removal
   or completion check. Duplicate refresh and startup now share latest-idle
   request reconciliation. Only a new host-owned binding with clear authorization,
   the exact successful answer and **no existing publication record** retains its
   first-send opportunity. Pending/uncertain/rejected/confirmed records never
   authorize another send. Confirmed holds remain unconfirmed when disappearing;
   tool-owned/historical and superseded requests cannot acquire publication.
   Empty answers still get the normal source decoration when unavailable
   authorization becomes clear, without inventing a delivered reply or repeating
   checks on subsequent reads/restarts. An old refresh cannot clear a newer
   active footer/status or install its actor/model. Terminal monitors drain before
   reconciliation, and replacements reload footer evidence after cleanup.
2. Chunking mistook comparison `<` characters for unclosed Slack entities. The
   formatter now escapes ordinary standalone angles and protects only actual
   Slack references/escapes, inline code and fenced-code delimiters/headers at
   chunk boundaries. Fenced code retains comparisons verbatim and reopens/closes
   across chunks. The 3,000 UTF-16-unit block and 64-chunk budgets, whole-answer
   rejection, Unicode handling and last-chunk-only model metadata remain intact.
3. Accepted engaged follow-ups lacked ingress eyes while busy work correctly
   stayed queued. They now acknowledge only the human channel/message source;
   no footer/status/model/actor ownership is acquired. Known permitted private
   follow-ups acknowledge on intake; deferred privacy follows the admitted
   dispatch plan. Disallowed, self and mention-duplicate follow-ups get no eyes.
   A bounded ingress-owner source set deduplicates retries/concurrent redelivery;
   Slack's own reaction identity also deduplicates restart attempts while eyes
   remain. This is best-effort presentation, not a new durable delivery ledger or
   a universal exactly-once guarantee after source eyes have been removed.

Correction evidence on Node 24.21.0, using real HTTP/SQLite/Responses/executor and
Slack SDK fixtures (no live accounts or dependency installation):

- The exact new reproductions against an archived `bca36c5` fail **7 cases**:
  duplicate/restart recovery with nonempty/empty final answers, the valid
  **5,632-character fenced TypeScript comparison**, ordinary `0 < 1. ` plus
  300 repeated answer phrases, and signed allowlisted private runner-busy intake.
  The temporary archived checkout was removed. Log:
  `/tmp/phase3-correction-exact-original-repro.log`.
- The corrected fixtures additionally cover superseded/new-active ownership,
  confirmed disappearing holds under host and tool policy, existing uncertain
  publication, exact private/source timestamps, no model/tool replay, and 50
  boundary placements of intentional Slack links/mentions, angle escapes and
  inline comparisons. Finite boundary/interleaving fixtures were chosen over a
  new property-test dependency or general mock framework.
- `node_modules/.bin/vitest run --no-file-parallelism`: **70 files / 1,084 tests
  passed**, including existing Google continuation, unsafe-effect, source/status,
  migration, partial/lost/SIGKILL and legacy behavior. No timeout was relaxed.
- `pnpm typecheck`: all eight workspace typechecks passed. `pnpm build`: all
  workspace builds passed.
- `./scripts/test-pi-e2e.sh`: rebuilt isolated container E2E passed, including
  signed mention/follow-up, native loading/clear, host replies and final metadata,
  tool-owned wrapper, requester/model routing, source reactions, remote image and
  credential/storage isolation, SSO/viewers and SIGKILL recovery. The fixture
  containers and volumes were confirmed removed.
- Final logs: `/tmp/phase3-correction-full-tests.log`,
  `/tmp/phase3-correction-types.log`, `/tmp/phase3-correction-build.log` and
  `/tmp/phase3-correction-e2e.log`.

This correction amends the Phase 3 commit. No MCP implementation, optional package
upgrade, deployment, live Slack/model/OAuth acceptance, push, workflow dispatch,
PR or `.pi` files are included. The companion MCP plan remains unimplemented and
the separate live/cutover/retirement acceptance gates remain unchanged.

## Phase 4 — local acceptance only — 2026-10-05

Verified the core on `dfaa3ad` without retirement, default cutover, deployment,
upgrade, push or PR. The earlier Phase 2/3 handoffs and statements that MCP was
unimplemented describe those commits, not current status. **Next:** MCP Phase 5
local integration acceptance, then separately authorized external gates below.

One acceptance-fixture repair: explicit cached-image GWS validation now mounts
the current host-built broker `dist` read-only and fails if it is missing. Cached
images supply dependencies, not validation of old compiled source. No production
environment/mount, credential, catalog or application behavior changed.

### Actual isolated evidence

Node **24.21.0**, pnpm **10.33.4**, installed dependencies and cached images only.
No downloads/install, live Slack/Google/provider/API/repository calls or private
deployment data. Sandbox preflight confirms `sbx v0.46.0` and approved
`node:24-bookworm`, but no prepared repository/dependency image; the expressly
authorized host/dummy Docker mechanisms were available and used instead.

- `pnpm exec vitest run --no-file-parallelism`: **76 files / 1,321 tests passed**,
  zero skipped. Includes real SQLite/Responses/executor/Slack SDK, Google automatic
  continuation/current actor, browser Chromium, Jira/built-in approval, sandbox
  policy/file boundaries and generic MCP crash/uncertainty regressions.
- `pnpm typecheck`, `pnpm build`, `pnpm build:mcp-fixture`: all pass (eight
  workspace typechecks/builds, separately compiled integration fixture).
- Cached `./scripts/test-pi-e2e.sh`: pass, actual Pi SQLite → production broker →
  SDK HTTP, signed Slack gateway/queue, host final text/model/source reactions,
  private approval continuation, structured/image/error, credential/storage
  isolation, viewer/SSO and SIGKILL recovery. No model/provider/Slack live claim.
- Cached `./scripts/test-mcp-catalog-compose.sh`: pass, actual private review/
  effect/result, owner refusal, complete authority evidence and production
  browser/command kernel child file/proc/mount isolation. This supplies local
  sandbox fail-closed evidence, not a Daytona cloud lifecycle.
- `./scripts/test-gws-e2e.sh thor-gws-remote-cli:e2e thor-gws-opencode:e2e`:
  pass with **current broker artifacts**, dummy per-user OAuth/direct reads/writes,
  Drata, caller formatting/pagination, upstream denial and private mount checks.
- `node --import ./packages/runner/node_modules/tsx/dist/loader.mjs
scripts/test-gws-browser-cookie.mjs /usr/bin/chromium` and the same command for
  `scripts/test-gws-ingress-browser.mjs`: both pass. Fresh headless Chromium,
  local fake SSO/Google, shipped Nginx, scoped cookie recovery/verified owner,
  exact public GIF/PNG bytes/MIME and decoding in both themes; no copied profile.
- Base/Pi/CI/no-AppArmor graphs rendered in an empty inherited environment with
  explicit dummy values, `--env-file /dev/null --no-env-resolution --format json`:
  pass. Assertions confirm broker-only private approval volume and both broker-only
  read-only catalog/token mounts. Shell syntax and `git diff --check` pass.

Pi selectors: `PI_TEST_USE_CACHED_IMAGES=1`,
`MCP_TEST_BROKER_IMAGE=thor-gws-remote-cli:e2e`,
`PI_TEST_{RUNNER,EXECUTOR,GATEWAY,ADMIN,INGRESS}_IMAGE` select the corresponding
`thor-pi-e2e-1000-3364098-{runner,pi-executor,gateway,admin,ingress}:latest` images.
Catalog uses the same images under `MCP_TEST_{BROKER,RUNNER,EXECUTOR,GATEWAY,ADMIN}_IMAGE`.
Current compiled artifacts are mounted by the existing cached overlay.
Logs: `/tmp/slack4-{tests,types,build,fixture-build,pi,catalog,gws,cookie,browser}.log`;
graphs: `/tmp/slack4-compose-{base,pi,ci,no-apparmor}.json`.
Post-script Docker container/volume/network queries show no resources for
`thor-pi-e2e-1000-150847` or `neo-mcp-catalog-test-1000-163277`, nor GWS/browser
fixture containers/networks. Each browser fixture removes its temporary private
state and closes its fresh context. Initial graph setup lacked required dummy
values; supplying them (without private env resolution) produced all four graphs.

### Exact remaining gates (not local fixture acceptance)

- Authorized push/CI Unit, Pi Runtime, MCP Catalog and relevant Core/Sandbox
  workflow results; no push/dispatch/PR requested or performed here.
- Real Slack workspace feature/permission/surface lifecycle, GIF playback,
  reduced motion/accessibility and Katalon artwork rights. Local decoding/SDK
  response fixtures cannot prove client rendering or permit app activation.
- Genuine served-provider execution/model behavior and real requester Google
  OAuth/account consent/automatic continuation, plus live Slack/Jira/Core paths.
  `test-e2e.sh`, `test-create-jira-approval-e2e.sh` and `test-opencode-e2e.sh`
  require real integrations and were deliberately not launched.
- `test-sandbox-e2e.sh` requires Daytona credentials/snapshot and clones an
  external repository; its cloud lifecycle was deliberately not launched. Unit,
  pinned-file and kernel child denial gates above are its feasible local subset.
- Existing Ubuntu Compose/keys/volumes, loaded production `thor-remote-cli`
  AppArmor and storage/power-loss/backup support. This host reports AppArmor kernel
  `N`; test-only unconfined-AppArmor fixtures do not validate the Ubuntu profile.
  SIGKILL/WAL process-crash evidence is not power-loss acceptance.

No second Slack consumer, actual private mount changes, `.pi` files, database
downgrade, optional Pi 1.0.2/typed Google redesign or legacy retirement included.

## Decision log

| Decision                                                                       | Reason / approval boundary                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep runner-owned embedded Harness; no adapter/conversation server             | Native Durable should own execution, not sit beneath another runtime abstraction.                                                                                                          |
| Keep gateway, executor and broker initially                                    | They own external custody/security, not alternate LLM lifecycles. Fewer containers alone would not delete those responsibilities.                                                          |
| Prefer native settlement/history over mirrored receipt status                  | Removes disagreement/recovery machinery while keeping domain admission/authorization evidence.                                                                                             |
| Native live input also outranks pre-submit withdrawal                          | Legacy aborted/expired continuations can retain placed input; validate persisted active requester before migration/scheduling, never guess missing authority.                              |
| Retain two-commit admission recovery and fingerprints                          | Released public API cannot supply combined admission or changed-payload/global dedup guarantees.                                                                                           |
| Version Neo metadata, retire input only after native admission                 | Preserves the public submit crash gap while removing prompt/status mirrors; malformed version/hybrid authority is not silently reinterpreted.                                              |
| Keep fixed observation time and unanswered-history fence                       | Durable 1.0.0 has exact successful answer IDs but no settlement clock or failed-input answer boundary; retain only evidence it cannot supply.                                              |
| Stop native watch before terminal sends; clear active requester after drain    | A settled submission does not mean the old footer callback has finished; new actor/model ownership must not race those callbacks.                                                          |
| Preserve confirmed-hold provenance through unavailable observations            | A vanished wait or second no-wait read cannot prove the blocked Google operation completed; continuation and supersession remain separate authority.                                       |
| Keep serialized active requester/model boundary                                | Native queued input does not freeze actor/model/cwd authority.                                                                                                                             |
| Make ordinary final reply host-owned                                           | Removes a basic chat dependency on model tool compliance; delivery/decoration contract needs approval.                                                                                     |
| Version-3 new-only reply policy; preserve v1/v2 and old queue ownership        | Prompts/private commentary already promised to historical or pending work cannot be retroactively published.                                                                               |
| Frozen target is separate from correlation aliases                             | A git-linked Slack request retains the admitted private surface; an anchor alone never gives GitHub/cron automatic Slack publication.                                                      |
| Publication intent/disposition on the existing binding, no retry               | Slack SDK retry/memo/client_msg_id cannot prove universal exactly-once effects; pending/lost/partial calls need explicit reconciliation.                                                   |
| Latest idle host binding without publication retains first-send opportunity    | Clear broker observation can release a never-issued exact answer, not authorize repost or a superseded/paused/historical reply; normal source decoration is independent of empty delivery. |
| Protect code-aware Slack tokens, escape ordinary angles                        | Comparison operators are not unclosed links; preserve code and intentional references while respecting UTF-16/chunk budgets.                                                               |
| Source-only accepted follow-up eyes, no queued presentation owner              | Queued users get acknowledgement without changing the executing requester/model/footer/status; bounded best-effort dedup is not an effect-retry ledger.                                    |
| One Pi request presentation, keep common registries only at legacy edges       | The common ProgressSession also serves OpenCode/NDJSON; reusing its global Pi lifecycle would retain two owners.                                                                           |
| Generic SDK apiCall plus parsed own agent_status                               | Existing SDK/ordinary chat:write suffice; no version/scope/irreversible manifest activation is required by implementation.                                                                 |
| Bounded section chunks with final model metadata; rich tools remain explicit   | Slack has a 3,000-character block budget; unsupported output rejects instead of silent clipping or artifact replacement.                                                                   |
| Native settlement stops loading before broker observation                      | A timeout is not active model/tool work or success; the static authenticated/unconfirmed outcome follows without motion or replay.                                                         |
| Adopt Junior's paced native working effect with Neo's AI mark (user requested) | Native loading + one compact animated footer, not token edits or a second progress runtime; current Slack lifecycle and fallback gates apply.                                              |
| Retain current Google coordinator in core cut                                  | It implements external grant-bound automatic continuation already verified by existing fixtures. Native Task redesign is optional, not magic deletion.                                     |
| Routing stays optional operator policy, not a second provider                  | Preserve shipped overrides/escalation and saved choices; existing `autoSelect`/`allowEscalation` controls suffice. No speculative capability/plugin framework.                             |
| Separate historical OpenCode viewing from execution retirement                 | Old links/data must survive even after live legacy runtime is removed; retirement is not assumed authorized.                                                                               |
| Phase 1 loads legacy execution only at the runtime selector                    | A historical GET cannot construct the live SDK/event bus; preserve rollback explicitly without a runtime abstraction.                                                                      |
| Share only raw OpenCode field/token interpretation across legacy owners        | Existing execution context progress and historical cost rendering use the same counts; neither owner depends on the other for parsing.                                                     |
| No LOC/test-count target                                                       | Demonstrate deleted responsibilities, fewer authorities and stable recovery/permission contracts, not cosmetic shrinking.                                                                  |

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

The original proposal was **source-backed planning only**: no runtime/dependency/config changes, target execution, installs, live account calls or new tests at that point. The prior 1,018-case results belong to earlier commits; they are not validation of this architecture or 1.0.2. Subsequent Phase 1 implementation evidence is recorded above.

Four independent source reviews covered native capabilities, runner ownership, admission/broker boundaries and the chat reference. A subsequent critique prompted explicit release-optional sequencing, minimal publication state, old/new reply policy/privacy, unconfirmed OAuth holds, startup authentication/order and runtime-default gates. Follow-up plan verification passed those amendments. This is planning verification only; implementation exit criteria remain future work.

- [Released Durable README](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md) and [normative specification](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/docs/spec.md): submissions, per-conversation agent, tasks/replay and observation guarantees.
- Release source: `harness/submissions.ts::admitSubmission`, `harness/harness.ts::ConversationImpl`, `harness/agent.ts::AgentDoc/configure`, `harness/generation.ts::GenerationTask`, `harness/tool.ts::ToolTask`, `harness/provider.ts::ensureProviderSessionId`, `session/observation.ts`, `types.ts::EntryQuery/TaskRuntime`, `tools/read.ts`, `storage/sqlite/node.ts`, under the same pinned Durable tree. `test/harness-submissions.test.ts` explicitly covers changed-content same-ID replay; `test/examples/14-chat.ts` demonstrates exact answer selection.
- Neo: `packages/runner/src/pi-runner.ts::{fingerprintPiRequest,reconcileLogs,submissionFor,entriesFor,doneFrame,monitor,startAccepted}`, `pi-runner-state.ts`, `pi-model-routing-runtime.ts`, `pi-runner-tools.ts`, `pi-storage-owner.ts`, `pi-execution-env.ts`, `pi-read-image.ts`, `index.ts`; `packages/common/src/{event-log,progress-manager,progress-events}.ts`.
- Admission/security: `packages/gateway/src/{app,service,queue,batch-request,slack,slack-channel-gate}.ts`; `packages/runner/src/google-auth-continuation-poller.ts`; `packages/remote-cli/src/{gws-oauth,gws-slack-identity,gws,index,slack-post-message}.ts`; `packages/common/src/google-auth-continuation.ts`.
- [Official chat reference](https://github.com/earendil-works/pi-chat/tree/9adbd29b40ee27ff1decf0fc87cbe180b40924f5): actual README/source/package contracts, not the broad Slack/chat label in Pi's root README.
- Before touching historical event/viewer code, follow [the OpenCode schema/viewer drift plan](2026051601_opencode-event-view-schema.md).
