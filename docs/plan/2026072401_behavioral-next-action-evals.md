# Behavioral next-action evaluations

Thor needs a repeatable way to detect behavioral regressions when its primary
agent prompt or model changes. Existing unit and E2E tests prove service and
integration contracts, but they do not answer whether the model still chooses
the right next action from a known conversation state.

Build a small Promptfoo-backed evaluation suite that calls codex-lb directly
with the real Thor primary-agent prompt, a single global tool catalog, and
declarative golden scenarios. Each model invocation evaluates exactly one
decision: reply now, or request a tool with particular arguments.

A multi-step scenario is compiled into independent checkpoints. At checkpoint
N, the conversation contains the frozen tool calls and results from checkpoints
1..N-1; the model is asked only for action N. The harness never executes a tool.
This keeps evaluation deterministic and removes OpenCode sessions, fake MCP
servers, remote-cli fixtures, and external side effects from the MVP.

## Goal

- A test author adds one JSON scenario containing:
  - initial conversation messages;
  - expected tool steps with frozen results;
  - the expected final reply characteristics.
- Tool names, descriptions, and input schemas are defined once for the entire
  suite and are never repeated or overridden by a scenario.
- The compiler expands a trajectory into isolated next-action checkpoints:
  - tool checkpoint: assert the requested tool and a meaningful subset of its
    arguments;
  - reply checkpoint: assert required/forbidden content and optional response
    constraints.
- Every checkpoint uses the current body of
  `docker/opencode/config/agents/build.md` as its system prompt and records its
  hash. Frontmatter is configuration, not prompt text.
- Models are selected at run time. The default is derived from the build-agent
  configuration rather than duplicating the model ID in another committed
  file.
- A run emits machine-readable JSONL plus a concise summary containing the Git
  SHA, suite digest, prompt hash, selected model, replicate, pass/fail result,
  token usage, cost, and latency where codex-lb returns them.
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
        "arguments_contain": {
          "command": "mcp grafana"
        }
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

Constraints:

- `messages` contains only the state before the first evaluated decision.
- Each non-final trajectory step contains one expected tool request and the
  frozen result that will be appended before compiling the next checkpoint.
- The final trajectory step expects a reply and has no synthetic result.
- Tool names must resolve in the global catalog.
- `arguments_contain` is recursive subset matching. Exact argument matching is
  available only for product-significant contracts where alternatives are not
  valid.
- Reply checks are behavioral requirements, not exact response snapshots.
- Tool-call IDs are generated deterministically by the compiler so authors do
  not manage protocol bookkeeping.

## Global tool catalog

The catalog is one committed JSON file consumed by every provider invocation.
It represents the stable agent-visible tools needed by the golden scenarios.
For Thor's current CLI-oriented prompt, the initial catalog should model the
OpenCode tools the primary agent actually chooses directly (for example
`bash`, `read`, `grep`, `glob`, and `task`). External integration choices are
therefore expressed through `bash` arguments such as `mcp ...`, `gh ...`, or
`psql ...`, matching the agent-facing prompt rather than inventing direct
`grafana.queryLogs`-style functions.

The catalog is evaluation infrastructure, not scenario data. Adding or changing
a tool requires an intentional catalog change and reruns every affected
scenario.

## Expected file impact

| Path                                         | Change                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                               | Add `eval:behavior:validate`, `eval:behavior`, and a pinned Promptfoo dev dependency.                                            |
| `pnpm-lock.yaml`                             | Lock the evaluation dependency.                                                                                                  |
| `benchmarks/behavior/promptfooconfig.yaml`   | Provider, prompt, assertion, repeat, concurrency, and artifact configuration.                                                    |
| `benchmarks/behavior/tools.json`             | Single global OpenAI-format tool catalog.                                                                                        |
| `benchmarks/behavior/scenarios/*.json`       | Declarative golden scenarios only.                                                                                               |
| `benchmarks/behavior/compile.mjs`            | Strict validation, prompt/frontmatter loading, trajectory-to-checkpoint expansion, suite hashing, and Promptfoo test generation. |
| `benchmarks/behavior/assert-next-action.mjs` | Parse raw completion output and grade tool name/arguments or reply constraints.                                                  |
| `benchmarks/behavior/README.md`              | Authoring, validation, execution, cost, result interpretation, and troubleshooting.                                              |

Keep generated manifests, result JSONL, Promptfoo state, and HTML reports out of
git.

## Phases

### Phase 1 — Golden scenario contract and deterministic compiler

- Add the global tool catalog.
- Add strict scenario validation:
  - reject duplicate JSON keys, unknown fields, unknown tools, malformed
    messages, empty trajectories, invalid tool/result ordering, and invalid
    reply constraints;
  - validate assistant tool calls and tool-result linkage after checkpoint
    expansion.
- Parse `build.md` frontmatter and body, derive the default model, and hash the
  exact system-prompt body.
- Compile each trajectory step into a standalone chat-completions test with the
  frozen prior steps represented as assistant tool-call and tool-result
  messages.
- Produce a stable suite digest from the tool catalog, prompt body, scenario
  inputs, and expectations.
- Unit-test validation failures and a two-tool-plus-reply expansion without
  network access.

Exit criteria:

- `pnpm eval:behavior:validate` validates the suite without contacting
  codex-lb.
- A scenario author never writes tool schemas or tool-call IDs.
- Compiler snapshots prove that each checkpoint contains exactly the intended
  prior conversation and only one expected next action.
- Changing the primary prompt, global tools, scenario evidence, or expectations
  changes the suite digest.

### Phase 2 — Promptfoo execution and next-action grading

- Add Promptfoo as a development-only dependency. Pin it so evaluator behavior
  cannot drift independently of repository changes.
- Configure its OpenAI Chat Completions provider for codex-lb's existing
  `/v1/chat/completions` endpoint.
- Send the real prompt body as the system message, followed by the compiled
  conversation, with the global tool catalog on every request.
- Implement one reusable next-action assertion:
  - tool expectation fails on a text-only answer, wrong tool, malformed
    arguments, or argument-subset mismatch;
  - reply expectation fails on a tool request, missing required content,
    forbidden content, or response-limit violation.
- Preserve the raw response and operational metadata in JSONL artifacts.
- Disable Promptfoo response caching for behavioral replicates.
- Stop on provider/model identity mismatch rather than comparing mislabeled
  results.

Exit criteria:

- One command runs a selected model and replicate count against the suite.
- A deliberately wrong reply, wrong tool, and wrong tool argument each fail
  with a useful checkpoint-specific explanation.
- A passing tool trajectory is evaluated through independent frozen
  checkpoints; no tool callback or external request occurs.
- Results identify the exact model, prompt hash, suite digest, scenario,
  checkpoint, and replicate.

### Phase 3 — Seed corpus and author workflow

- Add a small representative corpus covering:
  - direct answer without tools;
  - one required tool decision;
  - a multi-tool investigation ending in a calibrated reply;
  - a forbidden write/tool decision;
  - prompt injection or restricted-data handling.
- Author these scenarios from Thor's current behavior contracts. Do not copy
  the downloaded `luna-terra-benchmark-json-runner` corpus until its provenance
  and license are established; it may be used as design input only.
- Document how to add and run one scenario, filter by ID/category, choose
  models, set replicates, and inspect failures.
- Add scenario validation to the normal unit workflow. Keep model-backed runs
  manual and non-blocking until variance and cost are measured.

Exit criteria:

- Adding a normal test requires only one scenario JSON file.
- The README demonstrates a new scenario from conversation through expected
  trajectory and final reply.
- The seed suite contains both passing and intentionally failing test fixtures
  for the assertion layer.
- `pnpm test`, `pnpm typecheck`, `pnpm format:check`, and
  `pnpm eval:behavior:validate` pass.

## Decision log

| #   | Decision                                                                       | Rationale                                                                                                                                                | Rejected                                                                                      |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Evaluate one next action per model call                                        | Directly measures the decision boundary affected by prompt/model changes and makes failures local and reproducible.                                      | Running an entire live agent session and grading only the final answer.                       |
| 2   | Compile trajectories into independent frozen checkpoints                       | Tests every decision while avoiding callback state, tool execution, session routing, and error compounding across nondeterministic turns.                | Executing mocked tools in a live loop.                                                        |
| 3   | Call codex-lb Chat Completions directly through Promptfoo                      | This is the smallest path that preserves the real prompt, selected model, chat roles, and tool-call protocol while allowing inspection before execution. | Runner/OpenCode session orchestration; custom model runner.                                   |
| 4   | Define tools globally and forbid per-scenario schemas                          | Thor has one agent-visible surface; repeated schemas make tests noisy and allow scenarios to accidentally test different products.                       | Embedding tool definitions in each scenario.                                                  |
| 5   | Model OpenCode/CLI-facing tools, not synthetic integration functions           | The primary prompt tells Thor to invoke integrations through CLI commands, so `bash` arguments are the behavior being selected.                          | Direct `grafana.queryLogs` or `jira.getIssue` functions that Thor does not see in production. |
| 6   | Prefer semantic content and argument-subset checks over exact snapshots        | Models can produce multiple correct phrasings and equivalent commands. Goldens should encode product requirements, not incidental bytes.                 | Whole-response snapshots and exact argument matching by default.                              |
| 7   | Use Promptfoo only for provider execution, matrix/repeats, and artifact output | It removes generic evaluation plumbing while keeping Thor-specific scenario compilation and assertions small and explicit.                               | A large custom runner; adopting a hosted evaluation service.                                  |
| 8   | Keep model-backed evals manual initially                                       | Runs consume model quota and exhibit variance; first collect stability/cost data before defining a blocking threshold.                                   | Running the full model suite on every push.                                                   |
| 9   | Do not copy the downloaded suite without provenance                            | The package has no README or license, so repository inclusion is not yet justified.                                                                      | Importing it directly as the initial corpus.                                                  |

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

- **Direct Chat Completions differs from OpenCode.** The suite measures
  prompt/model decisions, not the runtime. Keep current E2E tests as the runtime
  gate and label reports accordingly.
- **Tool-schema drift.** A hand-maintained global catalog can diverge from
  OpenCode. Keep it intentionally small, document its source, and change it in
  the same review as agent-visible tool changes.
- **Equivalent command shapes.** CLI commands may differ while remaining
  correct. Use subset, pattern, or alternative-path expectations where the
  product contract permits them.
- **Checkpoint optimism.** Later steps receive the golden earlier action rather
  than the candidate's action. Report per-checkpoint pass rates; do not present
  the suite as end-to-end task success.
- **Evaluator drift.** Pin Promptfoo and record its version in every artifact.
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
