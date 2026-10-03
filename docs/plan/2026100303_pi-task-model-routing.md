# Neo — per-task Pi model and thinking routing

## Goal

Implement the user's requested task-dependent model/thinking selection instead of one registered model and fixed medium reasoning. Provide configurable fast/balanced/strong profiles, automatic initial selection, explicit overrides, bounded escalation, durable selection across retry/OAuth/restart, and truthful viewer attribution. Preserve existing deployment, credential isolation, Google continuation and other integration policies.

## Phases and exit criteria

1. **Profile configuration, policy and trusted transport.** Add optional `pi.modelRouting` to the existing workspace config, typed profile/override/selection contracts, a cohesive pure routing policy, and fresh-request Slack directive extraction/HTTP transport/frozen queue payloads. Profiles fast/balanced/strong default to the existing `PI_MODEL_ID` with low/medium/high thinking; distinct models are chosen only from the operator's configured pool, never invented/discovered blindly. Support explicit `[profile:strong thinking:high]`, `[model:configured-id thinking:low]` and `[thinking:high]` at the start of the current Slack request (after bot mention). Preserve exact task text, use only latest requesting event for directive/routing evidence, reject ambiguous/conflicting/unknown overrides. API fields `modelProfile`, `modelId`, `thinkingLevel`, `routingTask` carry the same contract. Automatic routing is conservative and transparent: strong investigation/security/architecture cues win, coding work balanced, routine integration/lookup/summarization fast, unknown balanced. No classifier dependency, extra LLM call or unbounded task-controlled model name. Test routing invariants, config validation, current-user versus history directives and frozen transport compatibility. Commit after isolated validation.
2. **Embedded lifecycle, escalation and actual attribution.** Resolve the workspace pool once at runner startup; register all distinct configured models with the existing provider/transport and capabilities. Persist selection with admission and configure model/thinking atomically before submit. Retries/OAuth use saved choices rather than reclassifying continuation text. Add sequential `escalate_model(profile, reason)` for automatic tasks only: upward profile movement, bounded to at most two steps, no provider/model/cwd/tool/permission mutation outside the pool. Commit metadata and native Pi agent choices together, applying from the next prepared request. Respect explicit locks, replay idempotence, new-human boundaries and restart. Show actual saved selection/escalation/history in the viewer rather than global startup model. Add real Responses-HTTP tests proving model and reasoning effort changes, overrides, escalation, retry/OAuth/restart fidelity, unsupported pool/profile failures without tool execution and unchanged credential/storage/tool boundaries. Update docs/config examples and container model fixtures. Full tests/types/builds and isolated Pi/GWS/browser regression before phase commit.

## Configuration and compatibility

- Operator configuration lives in `/workspace/config/thor.json`, under `pi.modelRouting`, preserving established paths. Example model IDs are examples only; no private deployment file will be edited.
- Optional profiles each specify `modelId` and `thinkingLevel`; omitted values inherit existing model settings / profile thinking defaults. No new environment variables or dependencies. All profiles use the existing provider/base URL/key and shared model capability/context settings; models in this pool must satisfy those declared settings.
- Missing config or absent routing section retains a single-model-compatible pool, while varying reasoning by task. Invalid declared routing configuration fails safely instead of silently guessing another pool. Pool edits take effect after runner restart; task selections already persisted remain authoritative. Unavailable saved pool choices fail closed rather than silently switching/replaying work.
- Legacy receipts remain readable; compatibility chooses their persisted native agent choices where available, not the task router applied to old text. External requests cannot inject persisted selection/escalation/history fields.
- Routing and escalation are performance policy, never a credential/approval authority. Google consent and unrelated tool boundaries do not change.

## Decision log

| Decision                                                                                                               | Reason                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing workspace JSON, no new env settings                                                                           | Operator-owned allowlisted pool without multiplying secrets/env surfaces; admin validation preserves it.                                                                                                                                                                         |
| Conservative deterministic initial routing plus bounded model escalation                                               | Avoids paying a classifier call for every simple task, is auditable/testable, and lets the agent promote unexpectedly hard tasks. Overrides handle ambiguity.                                                                                                                    |
| Only latest requester event supplies Slack directives                                                                  | Old thread context, quoted code/tool output and bystanders cannot accidentally pick current task routing.                                                                                                                                                                        |
| Existing model ID fallback for all profiles                                                                            | Never assume codex-lb exposes an invented fast/strong model. Reasoning adapts immediately; operators configure distinct served IDs for model switching.                                                                                                                          |
| Shared existing transport/context/image declarations                                                                   | Preserve the existing Pi capability contract and avoid silently mislabeling heterogeneous backends.                                                                                                                                                                              |
| One durable model selection per admitted task with recorded escalation                                                 | A retry/OAuth wake must not route the generic continuation prompt or silently undo a prior escalation.                                                                                                                                                                           |
| Native transactional `configure()`                                                                                     | Pi supports model/thinking changes; persist agent and receipt choices in the same commit and leave prepared requests/tools untouched.                                                                                                                                            |
| Current request selection governs viewer/progress identity                                                             | Global startup `PI_MODEL_ID` is no longer truthful after routing/escalation. Historical native message metadata remains the exact per-response record.                                                                                                                           |
| Explicit thinking-only requests also lock escalation                                                                   | Changing model/profile later could silently undo the caller's requested effort; all per-request overrides are explicit locks.                                                                                                                                                    |
| Escalation promotes exactly one adjacent profile per decision                                                          | Finite fast → balanced → strong progression permits at most two promotions, with no skips, self loops or downgrades; native transactions remain phase 2.                                                                                                                         |
| An explicit model ID shared by profiles uses the configured default if matching, otherwise the lowest matching profile | Same-model/different-thinking profiles are intentional; deterministic tie-breaking avoids duplicate-model rejection and still honors explicit effort.                                                                                                                            |
| Freeze absent fields, not only present values                                                                          | Old payloads lacking routing/actor/interrupt fields must not acquire fresh values on retry; reattach only request ID, dependencies and callbacks.                                                                                                                                |
| Pure routing owner plus shared serialized contracts                                                                    | Putting decisions in `pi-runner.ts` would mix native lifecycle/effects with classification and escalation invariants; workspace config owns validation, common owns cross-process evidence, the pure policy owns decisions.                                                      |
| Preserve directive-free Slack body whitespace                                                                          | Only the mention/directive delimiters and one separating ASCII space are removed; newlines/indentation and the original rendered event text remain intact.                                                                                                                       |
| Local commits only                                                                                                     | Commit skill prohibits push; report local fixture versus live provider/CI acceptance separately.                                                                                                                                                                                 |
| Cohesive `PiModelRoutingRuntime` owns frozen support checks, native transaction policy, escalation and its prompt      | Removing this module would scatter the same invariants across admission, recovery, OAuth and tools; coordinators only wire/call it.                                                                                                                                              |
| Preserve mutable JSON persistence representation, restore readonly branded selection at policy reads                   | Native Durable documents require mutable JSON arrays and declaration output cannot name propagated Zod brands; the receipt parser first validates the common schema, then explicitly encodes its known fields. No unchecked cast is needed.                                      |
| Replay records native task IDs in the same commit as selection/native agent, then saves a tool memo                    | A process can die after model promotion but before memo/result settlement. The committed task ID closes that gap; tool-call strings may repeat across model rounds, so native task identity is the durable key.                                                                  |
| Validate every retained frozen pool before enabling any scheduler                                                      | A removed model or changed context/image contract must not start tools before another receipt is found incompatible. Reordering supported profile IDs/defaults is safe because saved task pools remain authoritative. This deliberately rejects obsolete completed receipts too. |
| Configured-default tasks lock promotion, like explicit tasks                                                           | The requested escalation boundary is automatic tasks only; saved lock state, pure policy, native tool and prompt now agree for `autoSelect=false`.                                                                                                                               |
| Legacy viewer uses native agent as-of the task's final entry                                                           | A subsequent human request can change the conversation agent; legacy history must not be mislabeled using the new task or startup model. Native response headers remain exact per-response identity.                                                                             |
| No phase-2 commit/push or private deployment edits                                                                     | Delegated task explicitly forbids commit/push; deterministic fixtures and sanitized operator examples are not live provider/CI acceptance.                                                                                                                                       |

## Out of scope

New providers/credentials, automatic probing of live model catalogs, cost accounting/budget enforcement, a separate routing LLM/dependency, subagents, mid-tool model replacement, private deployment edits, changes to auth/approval policy, technical namespace migrations, push/PR without authorization.

## Phase 1 implementation and isolated evidence

**Implemented; committed as `df17b12`.** Phase 1 made no edits to `pi-runner.ts`,
native tools/state, OAuth, continuation/poller behavior, deployments,
dependencies or environment variables. Phase 2 integration/evidence follows below.

- `packages/common/src/pi-model-routing.ts` owns strict operator config,
  shared override fields and mutually exclusive selectors, branded/read-only
  parsed pool/selection evidence. `WorkspaceConfigSchema` includes optional
  `pi.modelRouting`; the existing admin validator retains it and all existing
  common fields. Unknown routing/profile/property names and invalid IDs/effort
  are rejected, not silently stripped into a guessed configuration.
- `packages/runner/src/pi-model-routing-policy.ts` resolves only existing model
  and capability defaults, chooses strong before balanced before fast cues,
  returns balanced for unknown tasks, and returns typed success/error values.
  Pure escalation checks explicit/config locks, adjacent upward movement,
  nonempty bounded reason, and at most two recorded promotions. Durable parsing
  validates pool membership, matching reasoning for automatic selections,
  locks, promotion count, contiguous history and final profile. Same model IDs
  across profiles are valid. Finite profile transitions and all explicit
  thinking levels are enumerated without adding a property-test dependency.
- `packages/gateway/src/slack-model-routing.ts` consumes only the newest queued
  event for the trusted actor (queue chronological order). Prefix parsing never
  reads thread/history fields or bystander text. Malformed, duplicate,
  conflicting and unknown directive forms produce a terminal diagnostic; the
  gateway attempts an in-thread notice using its existing Slack client before
  dropping. A failed notice remains logged and cannot turn rejection into
  dispatch. Unknown model _membership_ is resolved by the policy against the
  operator's pool, not by guessing in the gateway.
- `RunnerTriggerOptions`, real HTTP JSON and the frozen batch schema carry
  `modelProfile`, `modelId`, `thinkingLevel`, `routingTask`. Original prompts,
  request identity/correlation, requester attribution and legacy protocol
  names remain unchanged. No legacy runner selection behavior was altered.
- Real local HTTP tests cover the three supported Slack prefix forms through
  parsing → dispatch plan → queue persistence → delivery → changed-context
  retry, requester/history precedence and original event preservation. Real
  Slack SDK/local HTTP tests prove visible invalid-directive notices and no
  runner delivery. Pre-routing-shaped records with no selectors are retried
  against fresh profile and fresh model selectors independently: selectors,
  effort, task evidence, actors and interrupt remain absent, while live ACK
  callbacks still execute. Existing accepted-but-lost/restart transport tests
  remain green.

### Phase 2 contracts

Common package exports:

- Schemas/constants: `PiModelProfileSchema`, `PiThinkingLevelSchema`,
  `PiModelRoutingConfigSchema`, `PiTaskRoutingFields`,
  `PiTaskRoutingOverridesSchema`, `PiModelRoutingPoolSchema`,
  `PiModelSelectionSchema`.
- Types: `PiModelProfile`, `PiThinkingLevel`, `PiModelRoutingConfig`,
  `PiTaskRoutingOverrides`, `PiModelRoutingPool`, `PiModelSelection`.
- Pool fields: `provider: "codex-lb"`, three resolved `profiles` entries
  `{modelId, thinkingLevel}`, `modelContextWindow`, `modelSupportsImages`,
  `autoSelect`, `defaultProfile`, `allowEscalation`. No key/base URL/secret.
- Selection fields: `version: 1`, `pool`, `profile`, `modelId`, `thinkingLevel`,
  `source` (`automatic|default|explicit_profile|explicit_model|explicit_thinking`),
  `reason`, `escalationLocked`, `promotions`, `history: {from,to,reason}[]`.
  These are runner-owned metadata, never external request fields.

Pure runner exports:

- `resolvePiModelRoutingPool(config: Pick<PiRunnerConfig, "modelId" | "modelContextWindow" | "modelSupportsImages">, routingConfig?: unknown)`.
- `parsePiTaskRoutingOverrides(input: unknown)`.
- `selectPiTaskModel({pool, routingTask, overrides?})`.
- `parsePiModelSelection(input: unknown)`.
- `decidePiModelEscalation(selection, {profile: unknown, reason: string})`.
- `PiModelRoutingResult<T>` is `{ok:true,value:T}|{ok:false,error:PiModelRoutingError}`;
  `PiModelRoutingError` has `_tag: "PiModelRoutingError"` and codes
  `configuration_invalid|overrides_invalid|model_not_in_pool|selection_invalid|escalation_locked|escalation_limit|escalation_not_upward|escalation_reason_invalid`.

Resolve the pool once at startup from `workspaceConfig.pi?.modelRouting`, parse
the incoming API fields with the shared contract, and save the returned
selection at admission. Native registration/configuration, saved-choice versus
current-pool compatibility checks, transaction/replay identity, and retry/OAuth
metadata adoption are intentionally phase 2 work. Do not reclassify saved
continuations. No native model-switch tests were run for phase 1.

### Verification

Toolchain used explicitly:

```sh
export PATH=/home/s4ukk/.local/share/mise/installs/node/24.21.0/bin:/tmp/thor-pi-tools:$PATH
# node v24.21.0; pnpm 10.33.4
pnpm exec vitest run packages/common packages/gateway packages/runner/src/pi-model-routing-policy.test.ts
# 27 files passed; 426 tests passed; exit 0
pnpm -r typecheck
# all eight workspace typecheck scripts passed; exit 0
git diff --check
# exit 0
```

Host logs: `/tmp/pi-routing-phase1-tests.log`,
`/tmp/pi-routing-phase1-typecheck.log`, `/tmp/pi-routing-phase1-format.log`.
An initial focused run caught three test assertions comparing raw newlines to
JSON-escaped rendered event text; assertions were corrected to verify the
original JSON-serialized text, with all subsequent runs green.

Sandbox preflight observed SBX v0.46.0 and approved `node:24-bookworm`, but no
prepared repository image/dependencies; no sandbox preparation/download was
attempted. The reported evidence is the explicitly requested Node toolchain's
local test/typecheck execution, not sandbox, live-provider, CI or deployment
acceptance. There were no phase-2 compiler blockers in recursive typecheck.

## Phase 2 implementation and isolated evidence

**Implemented and locally verified.** The delegated phase made no commits;
parent verification and phase commit follow below. No dependency/environment
variable changes, credential-authority changes, private JSON edits or push.
Live provider availability, real-account acceptance and GitHub integration gates
remain unverified; the evidence below is local and deterministic.

### Runtime ownership and lifecycle

- `packages/runner/src/pi-model-routing-runtime.ts` reads optional workspace
  routing once at startup, with an injectable production `ConfigLoader` interface.
  Default reads distinguish only a real `ENOENT` as absent; invalid JSON/schema,
  declared routing and other read failures return safe configuration failure.
  No loader/provider/file diagnostic payload is exposed.
- Runner registers unique configured IDs plus the existing legacy `config.modelId`
  with the same provider/key/base URL, context, reasoning and image capabilities.
  There is no live catalog probe or separate credential source. Current resources
  validate all saved frozen pool IDs/capabilities before any scheduler starts.
- Shared routing fields and mutually exclusive selectors extend the external
  trigger parser. Unknown caller selection/pool/source/history authority is
  stripped. All routing evidence participates in the existing request fingerprint;
  old absent-field fingerprints remain compatible.
- Fresh serial admission selects only `routingTask ?? prompt`. Receipt/frozen
  pool/selection and native model/thinking are saved with `activeRequestId` in one
  transaction before submit. A new human task reroutes. Existing request IDs,
  recovery and prepared native requests never reclassify or guess new choices.
- The replay-safe, explicitly sequential `escalate_model` validates the automatic
  source, locks, adjacent progression and two-promotion bound through the pure
  policy. Selection/history/call evidence/native agent commit together. A native
  tool task ID and memo preserve the original result after a crash; cwd,
  extensions, tools, executor namespace and credential authority never change.
  The agent prompt exposes current profile/model/effort and next allowed promotion,
  not workspace keys or server internals.
- Google continuation copies the **original final** selection and escalation
  evidence, configures it transactionally with continuation admission, and retains
  existing requester/workspace/ack/expiry/supersession gates. Generic continuation
  text does not acquire routing authority.
- The viewer now renders the task's saved choice/source/lock/history and native
  per-response models. Legacy receipts retain native choices and the viewer reads
  native agent state as-of their final entry, not the latest conversation setting.
- Routine Google document/Docs URL/link/file cues now select fast; stronger
  investigation/security/architecture and coding cues retain precedence. Defaults
  with disabled automatic routing lock escalation in the common schema and policy.

### Behavioral verification

- Real Responses HTTP tests cover distinct model+reasoning changes, three explicit
  override forms/locks, invalid selectors before execution, injected authority
  stripping, routing-fingerprint mismatches, fresh-human rerouting, unchanged
  saved retries and supported pool reorder/default changes on restart.
- Actual gateway planning/frozen queue/delivery reaches the real Pi HTTP app;
  latest trusted Slack directives override history/bystanders and retry payloads
  remain frozen. The container test covers signed HTTP intake and privacy reroute.
- Native escalation tests prove two adjacent promotions, denied skip/self-loop/
  downgrade/third promotion, actual next-request model/effort, truthful viewer
  history and per-response models. A native child Harness intentionally suspends
  its real memo interface after the promotion commit; **SIGKILL in that exact
  window** followed by the production runner recovery proves one recorded promotion,
  one tool result and balanced model/effort, not a second promotion or fast reset.
- Legacy admitted work recovers its native high effort/model despite routine old
  text, while a later human selects a fresh fast profile. Invalid durable selection
  and native/receipt drift fail before scheduling and remain unchanged; restoring
  valid evidence permits recovery. Removed model resources and changed context or
  image declarations fail startup without another model/tool invocation.
- All three profiles transport the same real inline executor image contract,
  with model keys/internal secrets excluded from model input and executor calls.
- Existing Pi→executor→real wrapper→remote-cli→dummy OAuth integration now makes
  two real native promotions before GWS onboarding. Confirmed private OAuth
  continues on the original strong/high choice; unconfirmed DM still never executes
  Google work. Compound side effects remain once-only, browser binding/owner checks
  hold, and the short-lived token never enters model input. Broker-failed-ack/restart
  tests separately prove copying the saved final selection and one continuation.

### Documentation and fixtures

`README.md`, `docs/pi-runtime.md` and `docs/examples/thor.json` document the optional
workspace pool, sample IDs, shared capability requirement, supported overrides,
heuristic limitations, automatic-only bounded escalation, frozen recovery and
runner-restart requirement. The sanitized example inherits the existing model
with differing effort; the distinct-model example requires operator substitution
with IDs actually served by that deployment.

`docker/pi-test/compose.yml` uses three distinct fixture-only models. The Responses
fixture accepts all supported reasoning variations, requires the offered escalation
tool and reports actual model/effort choices. `scripts/test-pi-e2e.sh` checks an
explicit signed Slack strong/low override, subsequent human rerouting, native
fast→balanced→strong progression and viewer history without relaxing credential,
mount, signature, SSO or tool boundaries.

### Commands and results

Host commands use:

```sh
export PATH=/home/s4ukk/.local/share/mise/installs/node/24.21.0/bin:/tmp/thor-pi-tools:$PATH
# node v24.21.0; pnpm 10.33.4
pnpm test
pnpm -r typecheck
pnpm build
./scripts/test-pi-e2e.sh
./scripts/test-gws-e2e.sh
node --import ./packages/runner/node_modules/tsx/dist/loader.mjs scripts/test-gws-browser-cookie.mjs "$(command -v chromium)"
node --import ./packages/runner/node_modules/tsx/dist/loader.mjs scripts/test-gws-ingress-browser.mjs "$(command -v chromium)"
git diff --check
```

- Final full Vitest: **73 files / 1,066 tests passed**, exit 0 (28.37s), including
  an asserted native child-process `SIGKILL` in the post-promotion/pre-memo window.
- Final recursive typechecks: **all eight packages passed**, exit 0; final recursive
  builds passed, exit 0.
- Changed-file Prettier check, `git diff --check` and Pi E2E shell syntax check:
  passed, exit 0; `/tmp/pi-routing-phase2-format-check.log` contains format evidence.
- Pi deterministic Docker E2E: passed signed Slack→queue→Pi, actual routed model/
  effort, two promotions, image transport, executor credential/storage/mount
  isolation, viewers/SSO, SIGKILL admission recovery and no repeated completed tool.
- GWS/Drata internal-network Docker E2E: passed per-user OAuth/direct reads/writes,
  formatting/pagination, upstream denials and private mount isolation.
- Chromium cookie test: passed scoped Secure/HttpOnly/Lax handoff, cross-site POST
  withholding and safe same-site confirmation. Chromium/shipped Nginx test: passed
  cold SSO, cookie/identity forwarding, Google chooser/consent, verified callback
  grant and branding compatibility. No live profiles/accounts were used.
- Container images retain the repository's existing `node:24-slim` tag (the local
  cached runtime reported v24.15.0); host compiler/test toolchain was explicitly
  v24.21.0. No runtime/dependency pins were changed.
- Sandbox preflight: SBX v0.46.0 and approved Node base image available, but no
  prepared repository/dependency image. These are explicitly requested local test
  and isolated fixture executions, not sandbox-audit or live acceptance claims.

Final logs: `/tmp/pi-routing-phase2-tests-final.log`,
`/tmp/pi-routing-phase2-typecheck-final.log`, `/tmp/pi-routing-phase2-build-final.log`,
`/tmp/pi-routing-phase2-container-final.log`,
`/tmp/pi-routing-phase2-gws-container.log`,
`/tmp/pi-routing-phase2-browser-cookie.log`,
`/tmp/pi-routing-phase2-browser-ingress.log`,
`/tmp/pi-routing-phase2-replay.log`, `/tmp/pi-routing-phase2-capabilities.log`.

Initial focused checks caught the native JSON readonly-array/declaration boundary
and numeric native task IDs; storage encoding/string task keys were corrected
without casts. Viewer tests were corrected to distinguish per-task headers from
conversation-wide usage. The first Pi container run failed its new Slack override
assertion because the historical fixture bot mention `U_BOT` is not valid Slack
mention syntax; the fixture now uses `UBOT`, with production parsing unchanged.
Its retained failure log is `/tmp/pi-routing-phase2-container.log`; the complete
rerun and final post-refinement run both passed. **No remaining local check
failures.** Live provider/account acceptance and CI/push/PR remain unrun; no
commit/push was made. Deterministic Docker scripts and browser fixtures confirmed
cleanup of their temporary containers/volumes/profiles.

Existing shared TypeScript configuration remains unchanged (`strict=true`, other
recommended stricter flags not enabled globally); no unrelated workspace flag
migration is attempted in this phase. New routing code uses refined domain types,
native owner-provided types, explicit known-field serialization and no unchecked
casts/non-null assertions.

### Parent compatibility review

Restricted current-resource validation to executable (`accepted`) admissions, while still parsing every stored selection strictly. Retired model resources in completed history are not a reason to prevent startup or replay of a completed response. Pending/admitted work and OAuth dispatch still validate their saved pool/native choice before model/tool execution. Added a real restart test that rotates the complete pool, retrieves old duplicate results/history unchanged, and then sends a fresh task through the replacement fast model. Unsupported-resource tests now hold an actual pending native request, preserving the original fail-closed contract instead of requiring retired resources forever.

The shared workspace example omits model IDs, so copying it retains the operator's existing `PI_MODEL_ID` rather than silently selecting the example default model. Distinct served model IDs are shown explicitly in the routing documentation, not injected into private deployment configuration.

### Parent final gate

**73 files / 1,067 tests**, all workspace typechecks/builds, frozen offline install, formatting/diff/shell checks pass. Rebuilt Pi E2E verifies actual routed models/efforts, explicit signed Slack override, new-human rerouting, bounded escalation/history and existing image/credential/mount/SSO/recovery boundaries. Rebuilt GWS/Drata E2E and both serial Chromium regressions also pass. Temporary fixture runtimes were cleaned up. Parent logs are `/tmp/neo-model-final-{tests,types,build,install,pi-container,gws-container,ingress-browser,cookie-browser}.log`.

Both local phases are complete and committed separately. Operator configuration of distinct actually served model IDs is still required for distinct-model routing; without it, the existing model ID is retained and reasoning adapts by task. Live model availability/deployment acceptance and GitHub gates/PR remain unperformed. No private deployment configuration/data or secrets were committed, and nothing was pushed.
