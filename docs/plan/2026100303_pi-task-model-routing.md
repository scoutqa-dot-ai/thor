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

| Decision                                                                                                               | Reason                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing workspace JSON, no new env settings                                                                           | Operator-owned allowlisted pool without multiplying secrets/env surfaces; admin validation preserves it.                                                                                                                    |
| Conservative deterministic initial routing plus bounded model escalation                                               | Avoids paying a classifier call for every simple task, is auditable/testable, and lets the agent promote unexpectedly hard tasks. Overrides handle ambiguity.                                                               |
| Only latest requester event supplies Slack directives                                                                  | Old thread context, quoted code/tool output and bystanders cannot accidentally pick current task routing.                                                                                                                   |
| Existing model ID fallback for all profiles                                                                            | Never assume codex-lb exposes an invented fast/strong model. Reasoning adapts immediately; operators configure distinct served IDs for model switching.                                                                     |
| Shared existing transport/context/image declarations                                                                   | Preserve the existing Pi capability contract and avoid silently mislabeling heterogeneous backends.                                                                                                                         |
| One durable model selection per admitted task with recorded escalation                                                 | A retry/OAuth wake must not route the generic continuation prompt or silently undo a prior escalation.                                                                                                                      |
| Native transactional `configure()`                                                                                     | Pi supports model/thinking changes; persist agent and receipt choices in the same commit and leave prepared requests/tools untouched.                                                                                       |
| Current request selection governs viewer/progress identity                                                             | Global startup `PI_MODEL_ID` is no longer truthful after routing/escalation. Historical native message metadata remains the exact per-response record.                                                                      |
| Explicit thinking-only requests also lock escalation                                                                   | Changing model/profile later could silently undo the caller's requested effort; all per-request overrides are explicit locks.                                                                                               |
| Escalation promotes exactly one adjacent profile per decision                                                          | Finite fast → balanced → strong progression permits at most two promotions, with no skips, self loops or downgrades; native transactions remain phase 2.                                                                    |
| An explicit model ID shared by profiles uses the configured default if matching, otherwise the lowest matching profile | Same-model/different-thinking profiles are intentional; deterministic tie-breaking avoids duplicate-model rejection and still honors explicit effort.                                                                       |
| Freeze absent fields, not only present values                                                                          | Old payloads lacking routing/actor/interrupt fields must not acquire fresh values on retry; reattach only request ID, dependencies and callbacks.                                                                           |
| Pure routing owner plus shared serialized contracts                                                                    | Putting decisions in `pi-runner.ts` would mix native lifecycle/effects with classification and escalation invariants; workspace config owns validation, common owns cross-process evidence, the pure policy owns decisions. |
| Preserve directive-free Slack body whitespace                                                                          | Only the mention/directive delimiters and one separating ASCII space are removed; newlines/indentation and the original rendered event text remain intact.                                                                  |
| Local commits only                                                                                                     | Commit skill prohibits push; report local fixture versus live provider/CI acceptance separately.                                                                                                                            |

## Out of scope

New providers/credentials, automatic probing of live model catalogs, cost accounting/budget enforcement, a separate routing LLM/dependency, subagents, mid-tool model replacement, private deployment edits, changes to auth/approval policy, technical namespace migrations, push/PR without authorization.

## Phase 1 implementation and isolated evidence

**Implemented; uncommitted.** No edits to `pi-runner.ts`, native tools/state,
OAuth, continuation/poller behavior, deployments, dependencies or environment
variables. Phase 2 has not been implemented or claimed verified.

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
