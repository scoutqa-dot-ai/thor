# Behavioral next-action evaluations

Thor needs a repeatable way to detect behavioral regressions when its primary
agent prompt or model changes. Existing unit and E2E tests prove service and
integration contracts, but they do not answer whether the model still chooses
the right next action from a known conversation state.

Build a small Promptfoo-backed evaluation suite that calls codex-lb's
`/v1/responses` endpoint directly with the real Thor primary-agent prompt, a
single global tool catalog, and declarative golden scenarios. codex-lb is the
local ChatGPT-fronting OpenAI-compatible proxy; its base URL and API key come
from env config, not literals (`http://127.0.0.1:2455/v1` from the compose
host, `http://codex-lb:2455/v1` in-network). Each
model invocation evaluates exactly one decision: produce internal reply text,
or request a tool with particular arguments.

A multi-step scenario is compiled into independent checkpoints. At checkpoint
N, the conversation contains the frozen tool calls and results from checkpoints
1..N-1; the model is asked only for action N. The harness never executes a tool.
This keeps evaluation deterministic and removes OpenCode sessions, fake MCP
servers, remote-cli fixtures, and external side effects from the MVP.

## Goal

- A test author adds one JSON scenario containing:
  - initial conversation messages;
  - expected tool steps with complete frozen arguments and frozen results;
  - the expected final reply characteristics.
- Tool names, descriptions, and input schemas are defined once for the entire
  suite and are never repeated or overridden by a scenario.
- The compiler expands a trajectory into isolated next-action checkpoints:
  - tool checkpoint: assert exactly one requested tool and a meaningful subset
    of its arguments, or run an allowlisted semantic predicate;
  - reply checkpoint: assert required/forbidden content and optional response
    constraints, or run an allowlisted semantic predicate over the complete
    response.
- Every checkpoint uses the current body of
  `docker/opencode/config/agents/build.md` as its Responses `instructions` and records its
  hash. Frontmatter is configuration, not prompt text.
- Models are selected at run time. The default is derived from the build-agent
  configuration rather than duplicating the model ID in another committed
  file. Derivation strips the `openai/` provider prefix (`openai/gpt-5.6-terra`
  → wire `gpt-5.6-terra`) and validates the result against the provider
  whitelist so an unroutable ID fails fast.
- A run emits machine-readable JSONL plus a concise summary containing the Git
  SHA, suite digest, prompt hash, selected model, the effective sampling
  parameters (reasoning effort and any other request params), replicate,
  pass/fail result, token usage, cost, and latency where codex-lb returns them.
- Scenario/schema validation and checkpoint compilation run without model
  access so ordinary CI can catch malformed golden data cheaply.

## Scenario contract

Illustrative shape:

```json
{
  "schema_version": 1,
  "id": "incident-edge-localization",
  "title": "localize an edge-to-ingress incident",
  "category": "incident",
  "messages": [
    {
      "role": "user",
      "content": "Checkout errors increased after the network-policy rollout. Investigate."
    }
  ],
  "trajectory": [
    {
      "expect_tool": {
        "name": "bash",
        "predicate": "grafana-loki-query-only"
      },
      "frozen_arguments": {
        "command": "mcp grafana query_loki_logs '{\"datasourceUid\":\"loki\",\"logql\":\"{service=\\\"edge\\\"} |= \\\"502\\\"\"}'"
      },
      "result": {
        "content": "edge requests return 502 before reaching checkout; checkout health is green"
      }
    },
    {
      "expect_reply": {
        "contains_all": ["private ingress", "application"],
        "contains_none": ["confirmed root cause"],
        "max_words": 130
      }
    }
  ]
}
```

Silence is an external side-effect contract, not an empty model response. A
silent/log-only scenario therefore expects non-empty internal response text and
forbids the Slack posting path:

```json
{
  "schema_version": 1,
  "id": "successful-ci-wake-stays-silent",
  "title": "do not announce a successful CI wake",
  "category": "notification",
  "messages": [
    {
      "role": "user",
      "content": "The check suite completed successfully; no human is waiting."
    }
  ],
  "trajectory": [
    {
      "expect_reply": {
        "predicate": "internal-reply-without-slack-post"
      }
    }
  ]
}
```

Constraints:

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
  `arguments_exact`, or `predicate`. `arguments_contain` recursively matches
  object keys, treats string leaves as substring checks, and compares other
  leaves exactly. It must not be used for executable strings such as
  `bash.command`, where an appended `&&`, `;`, pipe, newline, or second command
  could preserve the substring while changing the action. `arguments_exact` is
  reserved for product-significant contracts where the entire argument object
  is fixed. A named predicate handles semantic equivalence when exact command
  bytes would be too brittle.
- Predicates are fixed exports registered in `assert-next-action.mjs`.
  Scenarios reference an allowlisted predicate name; they cannot provide inline
  code or arbitrary file paths. A tool predicate must also pass against its
  step's `frozen_arguments` during validation.
- The expectation must match its own `frozen_arguments`; invalid golden steps
  fail validation before compilation.
- Reply checks are behavioral requirements, not exact response snapshots. A
  reply expectation contains at least one built-in constraint or one named
  predicate.
- Built-in reply constraints reject any function call. A named reply predicate
  may define a narrower side-effect contract over the complete response.
  `internal-reply-without-slack-post` requires non-whitespace internal text and
  rejects every direct Slack-posting function call and every `bash` call whose
  command invokes `slack-post-message`.
- Tool-call IDs are generated deterministically by the compiler so authors do
  not manage protocol bookkeeping.
- A tool checkpoint admits exactly one function call. Provider requests set
  `parallel_tool_calls: false`, and grading rejects zero or multiple function
  calls when a tool is expected. Reply predicates inspect all output items so a
  text item cannot hide a forbidden function call.

## Global tool catalog

The catalog is one committed JSON file consumed by every provider invocation.
It uses a small evaluator-owned canonical shape for each tool's name,
description, input schema, and strictness rather than embedding a
Chat-Completions or Responses wire envelope. The compiler validates the
catalog and emits Responses function definitions.

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

| Path                                                   | Change                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                         | Add `eval:behavior:validate`, `eval:behavior`, and a pinned Promptfoo dev dependency.                                               |
| `pnpm-lock.yaml`                                       | Lock the evaluation dependency.                                                                                                     |
| `benchmarks/behavior/promptfooconfig.yaml`             | Provider, prompt, assertion, repeat, concurrency, and artifact configuration. Endpoint URL and API key come from env, not literals. |
| `benchmarks/behavior/tools.json`                       | Single global canonical tool catalog, compiled to Responses function definitions.                                                   |
| `benchmarks/behavior/scenarios/*.json`                 | Declarative golden scenarios only.                                                                                                  |
| `benchmarks/behavior/compile.mjs`                      | Strict validation, prompt/frontmatter loading, trajectory-to-checkpoint expansion, suite hashing, and Promptfoo test generation.    |
| `benchmarks/behavior/assert-next-action.mjs`           | Parse Responses output, grade common constraints, and register named semantic predicates.                                           |
| `benchmarks/behavior/README.md`                        | Authoring, validation, execution, cost, result interpretation, and troubleshooting.                                                 |
| `.env.example`, `README.md` (Deployment Configuration) | Document the eval endpoint URL and API key env vars (per AGENTS.md §6).                                                             |

Keep generated manifests, result JSONL, Promptfoo state, and HTML reports out of
git.

## Phases

### Phase 1 — Golden scenario contract and deterministic compiler

- Add the global tool catalog.
- Add strict scenario validation:
  - reject duplicate JSON keys, unknown fields, unknown tools, malformed
    messages, empty trajectories, invalid tool/result ordering, and invalid
    reply constraints;
  - reject unknown predicates, inline code/file references, and invalid
    matcher/predicate combinations;
  - reject incomplete `frozen_arguments` and expectations that do not match
    their own frozen call;
  - validate function calls and function-call-output linkage after checkpoint
    expansion.
- Parse `build.md` frontmatter and body, derive the default model (strip the
  `openai/` provider prefix and validate against the provider whitelist), and
  hash the exact system-prompt body.
- Compile each trajectory step into a standalone Responses test. Send the prompt
  body as `instructions`; represent conversation messages, frozen prior
  `function_call` items, and linked `function_call_output` items in `input`.
  Generate deterministic `call_id` values.
- Keep independent checkpoint histories synthetic: they contain authored
  messages plus frozen calls/results, not invented or persisted model reasoning
  items. Record this fidelity boundary in the evaluator documentation.
- Produce a stable suite digest from the tool catalog, prompt body, scenario
  inputs, expectations, assertion-module source, `compile.mjs` source, the
  effective request parameters (model, `parallel_tool_calls`, `store`, sampling
  params), and the pinned Promptfoo version, so a change to any input the model
  actually sees — or to how Items are compiled — invalidates prior results.
- Unit-test validation failures, a two-tool-plus-reply Responses expansion, the
  silent/log-only predicate, and a semantic command predicate without network
  access.

Exit criteria:

- `pnpm eval:behavior:validate` validates the suite without contacting
  codex-lb.
- A scenario author never writes tool schemas or tool-call IDs.
- Compiler snapshots prove that each checkpoint contains exactly the intended
  prior input items and only one expected next action.
- Changing the primary prompt, global tools, scenario evidence, expectations,
  or assertion implementation changes the suite digest.

### Phase 2 — Promptfoo execution and next-action grading

- Add Promptfoo as a development-only dependency. Pin it so evaluator behavior
  cannot drift independently of repository changes.
- Configure its explicit OpenAI Responses provider for codex-lb's
  `/v1/responses` endpoint, taking the base URL and API key from env
  (`http://127.0.0.1:2455/v1` from the compose host, `http://codex-lb:2455/v1`
  in-network). Ordinary CI has no codex-lb, which is why model-backed runs stay
  manual (decision 8).
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
    named-predicate failure;
  - built-in reply expectation fails on a function call, empty/missing required
    content, forbidden content, or response-limit violation;
  - `internal-reply-without-slack-post` requires non-empty internal text and
    fails on either the direct Slack-posting tool or a `bash.command` invocation
    of `slack-post-message`;
  - semantic command predicates parse and validate the complete command
    structure and payload, rejecting extra top-level commands rather than
    accepting a matching substring.
- Preserve the raw response and operational metadata in JSONL artifacts.
- Disable Promptfoo response caching for behavioral replicates.
- Stop on provider/model identity mismatch rather than comparing mislabeled
  results.

Exit criteria:

- One command runs a selected model and replicate count against the suite.
- A deliberately wrong reply, extra function call, wrong tool, wrong tool
  argument, appended shell command, and forbidden Slack post each fail with a
  useful checkpoint-specific explanation.
- A passing tool trajectory is evaluated through independent frozen
  checkpoints; no tool callback or external request occurs.
- Results identify the exact model, prompt hash, suite digest, scenario,
  checkpoint, and replicate.

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
- Document how to add and run one scenario, reference or add an allowlisted
  semantic predicate, filter by ID/category, choose models, set replicates, and
  inspect failures.
- Add scenario validation to the normal unit workflow. Keep model-backed runs
  manual and non-blocking until variance and cost are measured.

Exit criteria:

- Adding a normal test requires only one scenario JSON file.
- The README demonstrates a new scenario from conversation through expected
  trajectory and final reply.
- The seed suite contains both passing and intentionally failing test fixtures
  for the common assertion layer, semantic shell predicates, and silent Slack
  behavior.
- `pnpm test`, `pnpm typecheck`, `pnpm format:check`, and
  `pnpm eval:behavior:validate` pass.

## Decision log

| #   | Decision                                                                                                           | Rationale                                                                                                                                                                                                               | Rejected                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Evaluate one next action per model call                                                                            | Directly measures the decision boundary affected by prompt/model changes and makes failures local and reproducible.                                                                                                     | Running an entire live agent session and grading only the final answer.                                           |
| 2   | Compile trajectories into independent frozen checkpoints                                                           | Tests every decision while avoiding callback state, tool execution, session routing, and error compounding across nondeterministic turns.                                                                               | Executing mocked tools in a live loop.                                                                            |
| 3   | Call codex-lb Responses directly through Promptfoo                                                                 | Production OpenCode uses the Responses protocol; using the same instructions, typed Items, function definitions, and reasoning-capable endpoint avoids measuring a lossy Chat-Completions approximation.                | Chat Completions; Runner/OpenCode session orchestration; custom model runner.                                     |
| 4   | Define tools globally and forbid per-scenario schemas                                                              | Thor has one agent-visible surface; repeated schemas make tests noisy and allow scenarios to accidentally test different products.                                                                                      | Embedding tool definitions in each scenario.                                                                      |
| 5   | Model OpenCode/CLI-facing tools, not synthetic integration functions                                               | The primary prompt tells Thor to invoke integrations through CLI commands, so `bash` arguments are the behavior being selected.                                                                                         | Direct `grafana.queryLogs` or `jira.getIssue` functions that Thor does not see in production.                     |
| 6   | Use declarative common checks plus allowlisted code predicates                                                     | Models can produce multiple correct phrasings and equivalent commands, while executable strings need complete semantic validation that JSON substring checks cannot safely express.                                     | Whole-response snapshots, arbitrary scenario code, and substring matching for shell commands.                     |
| 7   | Use Promptfoo only for provider execution, matrix/repeats, and artifact output                                     | It removes generic evaluation plumbing while keeping Thor-specific scenario compilation and assertions small and explicit.                                                                                              | A large custom runner; adopting a hosted evaluation service.                                                      |
| 8   | Keep model-backed evals manual initially                                                                           | Runs consume model quota and exhibit variance; first collect stability/cost data before defining a blocking threshold.                                                                                                  | Running the full model suite on every push.                                                                       |
| 9   | Do not copy the downloaded suite without provenance                                                                | The package has no README or license, so repository inclusion is not yet justified.                                                                                                                                     | Importing it directly as the initial corpus.                                                                      |
| 10  | Admit exactly one tool call per tool checkpoint                                                                    | The scenario and frozen-result contract model one decision at a time; rejecting extra calls prevents a matching call from hiding an unintended action.                                                                  | Accepting parallel calls without representing and grading every call and result.                                  |
| 11  | Keep scenario JSON independent of the provider wire schema                                                         | Authors describe conversation state and expected behavior; the compiler alone owns conversion to Responses Items and function definitions.                                                                              | Exposing `function_call`, `function_call_output`, or `call_id` bookkeeping in scenarios.                          |
| 12  | Define silence as internal text without a Slack-posting side effect                                                | Runner output is internal; a user-visible Slack reply occurs only through the explicit posting path, so an empty model response is the wrong behavior to require.                                                       | Treating silence as zero model text or rejecting all useful internal completion text.                             |
| 13  | Proceed with reasoning-item-free synthetic checkpoint history; add reasoning items only if the provider rejects it | Frozen `function_call` items are authored golden data, so no genuine reasoning blob exists to embed, and codex-lb most likely tolerates their absence. Fail fast in Phase 2 rather than pre-building capture machinery. | Spiking reasoning-item behavior before Phase 1; unconditionally capturing/replaying encrypted reasoning per step. |

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
- **Tool-schema drift.** A hand-maintained global catalog can diverge from
  OpenCode. Keep it intentionally small, document its source, and change it in
  the same review as agent-visible tool changes.
- **Checkpoint optimism.** Later steps receive the golden earlier action rather
  than the candidate's action. Report per-checkpoint pass rates; do not present
  the suite as end-to-end task success.
- **Sampling-parameter drift.** If production's effective reasoning effort or
  other sampling params change, behavior shifts with no prompt or model-ID
  change. Record the effective params in every artifact and include them in the
  suite digest so drift is attributable, not silent.
- **Evaluator drift.** Pin Promptfoo and record its version in every artifact.
- **Predicate drift or overreach.** Keep predicates named and allowlisted, unit
  test their positive and negative boundaries, and include their source in the
  suite digest.
- **Shell syntax ambiguity.** Parse the complete command structure in semantic
  predicates and fail closed on unsupported forms instead of falling back to a
  substring match.
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
