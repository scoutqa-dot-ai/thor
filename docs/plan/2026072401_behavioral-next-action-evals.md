# Behavioral next-action evaluations

Thor needs a repeatable way to detect behavioral regressions when its primary
agent prompt or model changes. Existing unit and E2E tests prove service and
integration contracts, but they do not answer whether the model still chooses
the right next action from a known conversation state.

Build a small Promptfoo-backed evaluation suite that calls a `/v1/responses`
endpoint directly with the real Thor primary-agent prompt, a single global tool
catalog, and declarative golden scenarios. The endpoint is chosen by env, not
literals: codex-lb by default (the local ChatGPT-fronting OpenAI-compatible
proxy, `http://127.0.0.1:2455/v1` from the compose host, `http://codex-lb:2455/v1`
in-network, matching production routing), or the OpenAI API directly
(`https://api.openai.com/v1`) for CI and for exploring models outside codex-lb's
whitelist. Both speak the Responses protocol; only the base URL, API key, and
model IDs differ. Each model invocation evaluates exactly one decision: produce
internal reply text, or request a tool with particular arguments.

A multi-step scenario is compiled into independent checkpoints. At checkpoint
N, the conversation contains the frozen tool calls and results from checkpoints
1..N-1; the model is asked only for action N. The harness never executes a tool.
This keeps evaluation deterministic and removes OpenCode sessions, fake MCP
servers, remote-cli fixtures, and external side effects from the MVP.

## Goal

- A test author adds one typed scenario module — a `satisfies Scenario` object
  literal, declarative data, not code — containing:
  - initial conversation messages;
  - expected tool steps with complete frozen arguments and frozen results;
  - the expected final reply characteristics.
- The `Scenario` interface makes the shape a compile-time contract enforced by
  typecheck: it rejects wrong field names, wrong types, missing/excess fields, an
  `expect_tool.name` outside the catalog's tool-name union, and a matcher that
  is not exactly one of `arguments_contain | arguments_exact | assert` (a
  discriminated union). The runtime validator then covers only the semantic
  cross-references types cannot express (see Phase 1).
- Tool names, descriptions, and input schemas are defined once for the entire
  suite and are never repeated or overridden by a scenario.
- The compiler expands a trajectory into isolated next-action checkpoints:
  - tool checkpoint: assert exactly one requested tool and a meaningful subset
    of its arguments, or run a committed assertion script;
  - reply checkpoint: assert required/forbidden content and optional response
    constraints, or run a committed assertion script over the complete
    response.
- Semantic checks are committed script files, not inline scenario code. A
  scenario references an assertion script by name; the name resolves to a single
  small file under `benchmarks/behavior/asserts/`. Adding a check is dropping a
  reviewed file beside the scenario, not editing a central registry or an
  allowlist.
- Every checkpoint uses the current body of
  `docker/opencode/config/agents/build.md` as its Responses `instructions` and
  records that source path in the artifact. Frontmatter is configuration, not
  prompt text.
- Models are selected at run time and are not restricted to codex-lb's
  whitelist: eval routinely targets models outside it, especially through the
  direct OpenAI endpoint (which uses real OpenAI model IDs, not codex-lb aliases
  like `gpt-5.6-terra`). The default is derived from the build-agent
  configuration (`build.md` frontmatter) rather than duplicating the model ID in
  another committed file; derivation strips the `openai/` provider prefix
  (`openai/gpt-5.6-terra` → wire `gpt-5.6-terra`) and applies only when the run
  targets codex-lb. codex-lb's routing whitelist is read from its single source,
  `docker/opencode/config/opencode.json`, and never copied; it is used to warn
  (not fail) when a codex-lb run names a model outside it. An unroutable ID
  otherwise fails fast at the endpoint.
- A run emits machine-readable JSONL plus a concise summary containing the Git
  SHA, the input file paths (scenarios, tools, asserts, compiler, `build.md`),
  the endpoint, selected model, the effective sampling parameters (reasoning
  effort and any other request params), replicate,
  pass/fail result, token usage, cost, and latency where the endpoint returns
  them.
- Compile-time typing plus runtime schema validation and checkpoint compilation
  run without model access so ordinary CI can catch malformed golden data
  cheaply.

## Scenario contract

Illustrative shape (each scenario is a `scenarios/*.ts` module exporting a typed
object literal):

```ts
import type { Scenario } from "../types";

export default {
  schema_version: 1,
  id: "incident-edge-localization",
  title: "localize an edge-to-ingress incident",
  category: "incident",
  messages: [
    {
      role: "user",
      content: "Checkout errors increased after the network-policy rollout. Investigate.",
    },
  ],
  trajectory: [
    {
      expect_tool: {
        name: "bash",
        assert: "grafana-loki-query-only",
      },
      frozen_arguments: {
        command:
          'mcp grafana query_loki_logs \'{"datasourceUid":"loki","logql":"{service=\\"edge\\"} |= \\"502\\""}\'',
      },
      result: {
        content: "edge requests return 502 before reaching checkout; checkout health is green",
      },
    },
    {
      expect_reply: {
        contains_all: ["private ingress", "application"],
        contains_none: ["confirmed root cause"],
        max_words: 130,
      },
    },
  ],
} satisfies Scenario;
```

Silence is an external side-effect contract, not an empty model response. A
silent/log-only scenario therefore expects non-empty internal response text and
forbids the Slack posting path:

```ts
import type { Scenario } from "../types";

export default {
  schema_version: 1,
  id: "successful-ci-wake-stays-silent",
  title: "do not announce a successful CI wake",
  category: "notification",
  messages: [
    {
      role: "user",
      content: "The check suite completed successfully; no human is waiting.",
    },
  ],
  trajectory: [
    {
      expect_reply: {
        assert: "internal-reply-without-slack-post",
      },
    },
  ],
} satisfies Scenario;
```

Constraints. The `Scenario` interface enforces the structural constraints below
at compile time (field names, types, the tool-name union, the exactly-one-matcher
discriminated union, and reply/tool step shapes). The remaining constraints are
data-dependent cross-references that `tsc` cannot see and the runtime validator
enforces (Phase 1):

- `messages` contains only the state before the first evaluated decision. It
  holds authored `user` (and, when a scenario needs prior assistant text,
  `assistant`) messages only; the compiler renders them as Responses `message`
  items. Prior tool actions are never expressed here — they belong in
  `trajectory` as frozen steps so the compiler owns their `function_call`
  representation.
- Each non-final trajectory step contains one expected tool request and the
  complete `frozen_arguments` plus result that will be appended before
  compiling the next checkpoint.
- The final trajectory step expects a reply and has no synthetic result.
- Tool names must resolve in the global catalog.
- `frozen_arguments` is the canonical complete argument object used in later
  checkpoint history. It must validate against the selected tool's global input
  schema.
- A tool expectation contains exactly one of `arguments_contain`,
  `arguments_exact`, or `assert`. `arguments_contain` recursively matches
  object keys, treats string leaves as substring checks, and compares other
  leaves exactly. It must not be used for executable strings such as
  `bash.command`, where an appended `&&`, `;`, pipe, newline, or second command
  could preserve the substring while changing the action. `arguments_exact` is
  reserved for product-significant contracts where the entire argument object
  is fixed. An assertion script handles semantic equivalence when exact command
  bytes would be too brittle; because `bash` is the primary tool and its command
  cannot use `arguments_contain`, most tool checkpoints beyond fixed commands
  will name an assertion script.
- `assert` names a script file under `benchmarks/behavior/asserts/`; a scenario
  cannot provide inline code or a path outside that directory. Scripts are
  committed and reviewed like any other source. A tool assertion script must
  also pass against its step's `frozen_arguments` during validation.
- The expectation must match its own `frozen_arguments`; invalid golden steps
  fail validation before compilation.
- Reply checks are behavioral requirements, not exact response snapshots. A
  reply expectation contains at least one built-in constraint or one assertion
  script.
- Built-in reply constraints reject any function call. A reply assertion script
  may define a narrower side-effect contract over the complete response.
  `internal-reply-without-slack-post` requires non-whitespace internal text and
  rejects every `bash` call whose command invokes `slack-post-message`. The
  catalog exposes no direct Slack function, so `bash` is the only posting path
  to guard.
- Tool-call IDs are generated deterministically by the compiler so authors do
  not manage protocol bookkeeping.
- A tool checkpoint admits exactly one function call. Provider requests set
  `parallel_tool_calls: false`, and grading rejects zero or multiple function
  calls when a tool is expected. Reply assertion scripts inspect all output
  items so a text item cannot hide a forbidden function call.

## Global tool catalog

The catalog is one committed TypeScript module (`tools.ts`) exported `as const`
and consumed by every provider invocation. It uses a small evaluator-owned
canonical shape for each tool's name, description, input schema, and strictness
rather than embedding a Chat-Completions or Responses wire envelope. Exporting it
`as const` lets the `Scenario` type derive the tool-name literal union so an
unknown `expect_tool.name` is a compile error. The compiler validates the catalog
and emits Responses function definitions; `frozen_arguments` conformance to a
tool's input schema stays a runtime check against that schema (types do not
model per-tool argument shapes in the MVP).

The catalog represents the stable agent-visible tools needed by the golden
scenarios. For Thor's current CLI-oriented prompt, the initial catalog should
model the OpenCode tools the primary agent actually chooses directly (for
example `bash`, `read`, `grep`, `glob`, and `task`). External integration
choices are therefore expressed through `bash` arguments such as `mcp ...`,
`gh ...`, or `psql ...`, matching the agent-facing prompt rather than inventing
direct `grafana.queryLogs`-style functions.

The catalog is evaluation infrastructure, not scenario data. Adding or changing
a tool requires an intentional catalog change and reruns every affected
scenario.

## Expected file impact

| Path                                                   | Change                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                         | Add `eval:behavior:validate` and `eval:behavior` scripts, a pinned Promptfoo dev dependency, and a TS runner (`tsx`) to execute the `.ts` entrypoints.                                                                                                                                                          |
| `pnpm-lock.yaml`                                       | Lock the evaluation dependencies.                                                                                                                                                                                                                                                                               |
| `benchmarks/behavior/types.ts`                         | Shared `Scenario`, `ToolCatalog`, and checkpoint interfaces used by scenarios, the compiler, and assertions.                                                                                                                                                                                                    |
| `benchmarks/behavior/run.ts`                           | Programmatic driver: build a typed `TestSuiteConfiguration` + `EvaluateOptions`, call `promptfoo.evaluate()`, serialize JSONL/summary. Provider base URL and API key come from env, not literals. No `promptfooconfig.yaml` — the CLI cannot load a `.ts` config, so the config is typed in code (decision 14). |
| `benchmarks/behavior/tools.ts`                         | Single global canonical tool catalog exported `as const`, compiled to Responses function definitions.                                                                                                                                                                                                           |
| `benchmarks/behavior/scenarios/*.ts`                   | Declarative golden scenarios as `satisfies Scenario` typed object literals.                                                                                                                                                                                                                                     |
| `benchmarks/behavior/compile.ts`                       | Strict runtime validation, prompt/frontmatter loading, trajectory-to-checkpoint expansion, and typed test generation.                                                                                                                                                                                           |
| `benchmarks/behavior/assert-next-action.ts`            | Parse Responses output, grade built-in constraints, and dispatch to the assertion function a checkpoint names.                                                                                                                                                                                                  |
| `benchmarks/behavior/asserts/*.ts`                     | One small committed typed check per semantic assertion (tool or reply); referenced by name, no inline scenario code.                                                                                                                                                                                            |
| `benchmarks/behavior/README.md`                        | Authoring, validation, execution, cost, result interpretation, and troubleshooting.                                                                                                                                                                                                                             |
| `.env.example`, `README.md` (Deployment Configuration) | Document the eval endpoint URL and API key env vars (per AGENTS.md §6).                                                                                                                                                                                                                                         |

Keep generated manifests, result JSONL, Promptfoo state, and HTML reports out of
git.

## Phases

### Phase 1 — Golden scenario contract and deterministic compiler

- Add the global tool catalog.
- Define the shared `Scenario`/`ToolCatalog` types so `tsc` enforces structural
  shape (field names, types, tool-name union, exactly-one-matcher union,
  reply/tool step shapes) at compile time; duplicate keys and excess fields are
  already type errors on the object literals.
- Add strict runtime validation for the semantic cross-references types cannot
  express:
  - reject unknown tools not caught by the union, empty trajectories, and
    invalid tool/result ordering (final step is a reply, non-final are tools);
  - reject an `assert` naming a check with no `asserts/` module;
  - reject incomplete `frozen_arguments`, `frozen_arguments` that do not conform
    to the selected tool's input schema, and expectations that do not match
    their own frozen call;
  - validate function calls and function-call-output linkage after checkpoint
    expansion.
- Parse `build.md` frontmatter and body, derive the default codex-lb model
  (strip the `openai/` provider prefix), and load the exact system-prompt body.
  Read codex-lb's routing whitelist from `docker/opencode/config/opencode.json`
  (single source, never copied); use it only to warn when a codex-lb run selects
  a model outside it. Do not reject a runtime-selected model outside the
  whitelist — the direct OpenAI endpoint uses real OpenAI model IDs by design.
- Compile each trajectory step into a standalone Responses test. Send the prompt
  body as `instructions`; represent conversation messages, frozen prior
  `function_call` items, and linked `function_call_output` items in `input`.
  Generate deterministic `call_id` values.
- Keep independent checkpoint histories synthetic: they contain authored
  messages plus frozen calls/results, not invented or persisted model reasoning
  items. Record this fidelity boundary in the evaluator documentation.
- Record run provenance in every artifact: the Git SHA and the input file paths
  (tool catalog, `build.md`, each scenario, each referenced `asserts/*.ts`,
  `compile.ts`), plus the effective request parameters (endpoint, model,
  `parallel_tool_calls`, `store`, sampling params) and the pinned Promptfoo
  version. No content hashing for now — the SHA plus paths identify a run's
  inputs, and comparability across edited working trees is out of scope for the
  MVP.
- Unit-test validation failures, a two-tool-plus-reply Responses expansion, the
  silent/log-only assertion, and a semantic command assertion without network
  access.

Exit criteria:

- `pnpm typecheck` and `pnpm eval:behavior:validate` both pass, and each rejects
  a malformed scenario without contacting any model endpoint (typecheck on shape,
  validate on semantic cross-references).
- A scenario author never writes tool schemas or tool-call IDs.
- Compiler snapshots prove that each checkpoint contains exactly the intended
  prior input items and only one expected next action.
- Every artifact records the Git SHA, endpoint, model, and the input file paths
  so a result's inputs are identifiable.

### Phase 2 — Promptfoo execution and next-action grading

- Add Promptfoo as a development-only dependency. Pin it so evaluator behavior
  cannot drift independently of repository changes.
- Drive Promptfoo through its typed Node API from `run.ts` (`promptfoo.evaluate`
  with a `TestSuiteConfiguration` and `EvaluateOptions`), not a config file — the
  CLI does not natively load a `.ts` config, and the Node API gives compile-time
  checking of the config, providers, and assertions (decision 14).
- Configure its explicit OpenAI Responses provider against the `/v1/responses`
  endpoint selected by env — codex-lb by default (`http://127.0.0.1:2455/v1` from
  the compose host, `http://codex-lb:2455/v1` in-network) or the OpenAI API
  directly (`https://api.openai.com/v1`) — with the base URL and API key from
  env. The direct OpenAI endpoint makes model-backed runs possible in CI (no
  codex-lb required) and lets a run target models outside codex-lb's whitelist;
  they stay manual initially anyway on variance/cost grounds (decision 8).
  Record the endpoint identity in every artifact alongside the model so a
  codex-lb result is never conflated with a direct-OpenAI one.
- Send the real prompt body as `instructions`, the compiled Items as `input`,
  and the canonical catalog as Responses function definitions. Set
  `parallel_tool_calls: false` and `store: false` on every request. Replicate
  the sampling parameters production uses for the build agent (reasoning effort
  and any others; `build.md` sets none today, so record the effective default)
  and record them in every artifact so a config-default change cannot be
  misread as a prompt/model regression.
- Implement one reusable next-action assertion:
  - normalize typed `response.output` items into internal text and function
    calls without treating reasoning items as messages;
  - tool expectation fails on a text-only answer, zero or multiple function
    calls, wrong tool, malformed arguments, built-in argument mismatch, or
    assertion-script failure;
  - built-in reply expectation fails on a function call, empty/missing required
    content, forbidden content, or response-limit violation;
  - `internal-reply-without-slack-post` requires non-empty internal text and
    fails on a `bash.command` invocation of `slack-post-message` (the catalog
    has no direct Slack function, so `bash` is the only posting path);
  - dispatch to the typed check a checkpoint names by importing `asserts/<name>`,
    passing it the normalized output (and, for a tool checkpoint, the requested
    call and its `frozen_arguments`); a missing or throwing check fails the
    checkpoint. The assertion is passed to Promptfoo as a typed function, not a
    `file://` string;
  - semantic command assertion scripts parse and validate the complete command
    structure and payload, rejecting extra top-level commands rather than
    accepting a matching substring.
- Preserve the raw response and operational metadata in JSONL artifacts.
- Disable Promptfoo response caching for behavioral replicates.
- Stop on endpoint/provider/model identity mismatch rather than comparing
  mislabeled results.

Exit criteria:

- One command runs a selected model and replicate count against the suite.
- A deliberately wrong reply, extra function call, wrong tool, wrong tool
  argument, appended shell command, and forbidden Slack post each fail with a
  useful checkpoint-specific explanation.
- A passing tool trajectory is evaluated through independent frozen
  checkpoints; no tool callback or external request occurs.
- Results identify the exact endpoint, model, Git SHA, input file paths,
  scenario, checkpoint, and replicate.

### Phase 3 — Seed corpus and author workflow

- Add a small representative corpus covering:
  - direct answer without tools;
  - one required tool decision;
  - a multi-tool investigation ending in a calibrated reply;
  - a silent/log-only wake that produces internal text without posting to
    Slack;
  - a forbidden write/tool decision;
  - prompt injection or restricted-data handling.
- Author these scenarios from Thor's current behavior contracts. Do not copy
  the downloaded `luna-terra-benchmark-json-runner` corpus until its provenance
  and license are established; it may be used as design input only.
- Document how to add and run one scenario, reference or add an assertion
  script, filter by ID/category, choose models, set replicates, and
  inspect failures.
- Add scenario validation to the normal unit workflow. Keep model-backed runs
  manual and non-blocking until variance and cost are measured.

Exit criteria:

- Adding a reply-only scenario, or one that reuses an existing assertion,
  requires only one `scenarios/*.ts` module. A scenario that needs a new semantic
  check also adds one small `asserts/*.ts` module beside it — no central registry
  or allowlist edit.
- The README demonstrates a new scenario from conversation through expected
  trajectory and final reply.
- The seed suite contains both passing and intentionally failing test fixtures
  for the common assertion layer, semantic shell assertions, and silent Slack
  behavior.
- `pnpm test`, `pnpm typecheck`, `pnpm format:check`, and
  `pnpm eval:behavior:validate` pass.

## Decision log

| #   | Decision                                                                                                           | Rationale                                                                                                                                                                                                                                                                                                                                                                                 | Rejected                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Evaluate one next action per model call                                                                            | Directly measures the decision boundary affected by prompt/model changes and makes failures local and reproducible.                                                                                                                                                                                                                                                                       | Running an entire live agent session and grading only the final answer.                                                |
| 2   | Compile trajectories into independent frozen checkpoints                                                           | Tests every decision while avoiding callback state, tool execution, session routing, and error compounding across nondeterministic turns.                                                                                                                                                                                                                                                 | Executing mocked tools in a live loop.                                                                                 |
| 3   | Call a Responses endpoint directly through Promptfoo — codex-lb by default, or the OpenAI API for eval             | Production OpenCode uses the Responses protocol; the same instructions, typed Items, function definitions, and reasoning-capable endpoint avoid a lossy Chat-Completions approximation. codex-lb matches production routing; the direct OpenAI endpoint is env-selected for CI and for models outside codex-lb's whitelist, and is recorded per artifact so backends are never conflated. | Chat Completions; Runner/OpenCode session orchestration; custom model runner; hard-restricting eval to codex-lb.       |
| 4   | Define tools globally and forbid per-scenario schemas                                                              | Thor has one agent-visible surface; repeated schemas make tests noisy and allow scenarios to accidentally test different products.                                                                                                                                                                                                                                                        | Embedding tool definitions in each scenario.                                                                           |
| 5   | Model OpenCode/CLI-facing tools, not synthetic integration functions                                               | The primary prompt tells Thor to invoke integrations through CLI commands, so `bash` arguments are the behavior being selected.                                                                                                                                                                                                                                                           | Direct `grafana.queryLogs` or `jira.getIssue` functions that Thor does not see in production.                          |
| 6   | Use declarative common checks plus per-assertion committed scripts                                                 | Models produce multiple correct phrasings and equivalent commands, and `bash` (the primary tool) cannot use `arguments_contain`, so semantic checks are the common case; a script file per check keeps them reviewable and drops the central-registry bottleneck that would force a code edit for every new tool scenario.                                                                | Whole-response snapshots, inline scenario code, an allowlist/registry gate, and substring matching for shell commands. |
| 7   | Use Promptfoo (via its typed Node API) only for provider execution, matrix/repeats, and artifact output            | It removes generic evaluation plumbing while keeping Thor-specific scenario compilation and assertions small and explicit; the Node API keeps that boundary typed.                                                                                                                                                                                                                        | A large custom runner; adopting a hosted evaluation service.                                                           |
| 8   | Keep model-backed evals manual initially                                                                           | Runs consume model quota and exhibit variance; first collect stability/cost data before defining a blocking threshold. The direct OpenAI endpoint makes CI runs technically possible without codex-lb, but that is a capability, not a reason to gate on them yet.                                                                                                                        | Running the full model suite on every push.                                                                            |
| 9   | Do not copy the downloaded suite without provenance                                                                | The package has no README or license, so repository inclusion is not yet justified.                                                                                                                                                                                                                                                                                                       | Importing it directly as the initial corpus.                                                                           |
| 10  | Admit exactly one tool call per tool checkpoint                                                                    | The scenario and frozen-result contract model one decision at a time; rejecting extra calls prevents a matching call from hiding an unintended action.                                                                                                                                                                                                                                    | Accepting parallel calls without representing and grading every call and result.                                       |
| 11  | Keep scenario data (typed TS objects) independent of the provider wire schema                                      | Authors describe conversation state and expected behavior; the compiler alone owns conversion to Responses Items and function definitions.                                                                                                                                                                                                                                                | Exposing `function_call`, `function_call_output`, or `call_id` bookkeeping in scenarios.                               |
| 12  | Define silence as internal text without a Slack-posting side effect                                                | Runner output is internal; a user-visible Slack reply occurs only through the explicit posting path, so an empty model response is the wrong behavior to require.                                                                                                                                                                                                                         | Treating silence as zero model text or rejecting all useful internal completion text.                                  |
| 13  | Proceed with reasoning-item-free synthetic checkpoint history; add reasoning items only if the provider rejects it | Frozen `function_call` items are authored golden data, so no genuine reasoning blob exists to embed, and codex-lb most likely tolerates their absence. Fail fast in Phase 2 rather than pre-building capture machinery.                                                                                                                                                                   | Spiking reasoning-item behavior before Phase 1; unconditionally capturing/replaying encrypted reasoning per step.      |
| 14  | Author the harness in TypeScript and drive Promptfoo via its typed Node API, not a config file                     | The repo is TS-strict; the Promptfoo CLI cannot natively load a `.ts` config, but its Node API is fully typed (`TestSuiteConfiguration`, `EvaluateOptions`, `AssertionValueFunction`), so programmatic use gives compile-time checking of config, compiler, and assertions and lets checks be passed as typed functions rather than `file://` strings.                                    | A `promptfooconfig.yaml` with untyped `.mjs` helpers; a `promptfooconfig.ts` (the CLI does not load it).               |
| 15  | Author scenarios and the tool catalog as typed TS modules (`satisfies Scenario`, `as const`), not raw JSON         | `tsc` then enforces scenario/catalog structure at compile time (field names, unions, missing/excess fields, tool-name literal union), shrinking the runtime validator to the semantic cross-references types cannot express (`frozen_arguments` ↔ tool schema, assert-name existence, step ordering).                                                                                     | Raw `.json` data files checked only at runtime, invisible to `tsc`.                                                    |
| 16  | Do not restrict eval model selection to codex-lb's whitelist; read that whitelist from `opencode.json` when needed | Eval must target models outside codex-lb's routing — new models and, via the direct OpenAI endpoint, real OpenAI IDs. The whitelist has one source (`docker/opencode/config/opencode.json`); reading it there avoids a drift copy (AGENTS.md pinning) and is used only to warn on a codex-lb run, never to hard-fail. Unroutable IDs fail fast at the endpoint.                           | Hard-failing on non-whitelisted models; copying the whitelist into the evaluator.                                      |
| 17  | Validate frozen arguments with pinned AJV                                                                          | The tool catalog owns JSON Schemas at runtime, and AJV supplies strict, complete schema validation without creating a second evaluator-specific schema language. Pinning it keeps validation behavior attributable to repository changes.                                                                                                                                                 | A partial hand-written JSON Schema interpreter; treating catalog schemas as documentation only.                        |
| 18  | Override Promptfoo's transitive `tslib` to the existing 2.x line                                                   | Promptfoo's `keyv-file` dependency requests `tslib` 1.x, which pnpm otherwise hoists for packages that omit their runtime declaration; Daytona's emitted decorators require 2.x. A workspace override keeps the pre-existing SDK runtime valid while remaining compatible with `keyv-file`.                                                                                               | Allowing the virtual store to select 1.x; patching Daytona or Promptfoo source.                                        |

## Out of scope

- OpenCode session creation, continuation, compaction, or runner-injected
  memory/correlation context.
- Executing fake or real tools.
- MCP, remote-cli, Slack, GitHub, database, approval, or filesystem side
  effects.
- Testing OpenCode's tool renderer, plugin behavior, or CLI wrappers.
- LLM-as-a-judge scoring in the MVP.
- Exact final-response snapshots.
- Automatically updating golden expectations from candidate output.
- A blocking model-quality threshold before replicate variance is measured.
- Hosted Promptfoo sharing or sending scenario data to Promptfoo services.

## Risks and mitigations

- **Synthetic Responses history differs from a live OpenCode continuation.**
  The suite uses the production provider protocol but frozen checkpoints do not
  contain prior encrypted reasoning items or OpenCode orchestration state. It
  measures isolated prompt/model decisions, not full runtime continuation.
  Keep current E2E tests as the runtime gate and label reports accordingly.
  Because the frozen `function_call` items are authored (no real reasoning blob
  exists), a reasoning model on `/v1/responses` with `store: false` may require
  each function call to be paired with a `reasoning` item. Two fallback tiers if
  codex-lb enforces this: (1) tolerant backend — emit a stub/empty reasoning
  item ahead of each frozen call, cheap and self-contained; (2) strict backend
  that validates the encrypted payload — capture a real reasoning item per step
  from one live call and freeze it, which couples golden data to a
  model/account and is the expensive path. Discover which at the first
  multi-tool checkpoint in Phase 2; only the compiler's Item construction
  changes.
- **Endpoint fidelity.** The direct OpenAI endpoint is convenient for CI and for
  models outside codex-lb's whitelist, but it is a different backend from
  production's codex-lb ChatGPT routing (different auth, model IDs, and possibly
  behavior). Treat codex-lb as the production-representative signal and the direct
  OpenAI endpoint as exploratory; record the endpoint in every artifact and in
  identity checks so the two are never compared as if equivalent.
- **Tool-schema drift.** A hand-maintained global catalog can diverge from
  OpenCode. Keep it intentionally small, document its source, and change it in
  the same review as agent-visible tool changes.
- **Checkpoint optimism.** Later steps receive the golden earlier action rather
  than the candidate's action. Report per-checkpoint pass rates; do not present
  the suite as end-to-end task success.
- **Sampling-parameter drift.** If production's effective reasoning effort or
  other sampling params change, behavior shifts with no prompt or model-ID
  change. Record the effective params in every artifact so drift is attributable,
  not silent.
- **Evaluator drift.** Pin Promptfoo and record its version in every artifact.
- **Assertion-script drift or overreach.** Keep each check a small committed
  script confined to `asserts/`, unit test its positive and negative
  boundaries, and record each referenced script path in the artifact.
- **Shell syntax ambiguity.** Parse the complete command structure in semantic
  assertion scripts and fail closed on unsupported forms instead of falling back
  to a substring match.
- **Caching hides variance.** Disable response caching for model-backed runs and
  retain replicate identity.
- **Cost growth.** Each trajectory step multiplies calls. Keep a filterable
  smoke subset and make repeat count explicit.

## Integration verification

After implementation phases are complete:

1. Run isolated validation and unit checks locally.
2. Push the branch so the normal unit workflow validates code and golden data.
3. Run a small local model-backed smoke against codex-lb and retain its JSONL
   artifact; do not place credentials or model outputs in git.
4. Open the PR only after the required push checks pass, following
   `AGENTS.md`.
