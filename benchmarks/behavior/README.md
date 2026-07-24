# Thor behavioral next-action evaluations

This suite asks one narrow question per model call: from a frozen conversation
state, does the build agent reply or request the expected tool with safe
arguments? It uses the current body of
`docker/opencode/config/agents/build.md`, the single catalog in `tools.ts`, and
the OpenAI Responses protocol through Promptfoo.

Model-backed runs are manual. They consume quota and can vary between
replicates. Ordinary tests run scenario validation, checkpoint compilation, and
assertion tests without contacting a model.

## Validate

```bash
pnpm eval:behavior:validate
pnpm typecheck
pnpm vitest run benchmarks/behavior
```

Validation checks trajectory ordering, tool names, argument schemas, assertion
module references, golden expectation matches, and Responses call/output
linkage. Scenario structure is also checked by TypeScript: use
`satisfies Scenario` so misspelled, missing, or excess fields fail typecheck.

## Run

The default endpoint is the compose-host codex-lb URL,
`http://127.0.0.1:2455/v1`. Its default model is derived from `build.md`
frontmatter. The API key must always come from the environment.

```bash
THOR_BEHAVIOR_EVAL_API_KEY=codex-lb-local \
  pnpm eval:behavior -- --replicates 3
```

Use the in-network URL from a container:

```bash
THOR_BEHAVIOR_EVAL_BASE_URL=http://codex-lb:2455/v1 \
THOR_BEHAVIOR_EVAL_API_KEY=codex-lb-local \
  pnpm eval:behavior
```

Use real OpenAI model IDs for the direct API. A model is required for any
non-codex-lb endpoint:

```bash
THOR_BEHAVIOR_EVAL_BASE_URL=https://api.openai.com/v1 \
THOR_BEHAVIOR_EVAL_API_KEY="$OPENAI_API_KEY" \
  pnpm eval:behavior -- --model gpt-5.4 --replicates 3
```

Available filters and controls:

- `--scenario <id>` selects one scenario.
- `--category <category>` selects a category.
- `--model <id>` selects the endpoint's wire model ID and overrides
  `THOR_BEHAVIOR_EVAL_MODEL`.
- `--replicates <n>` repeats every selected checkpoint; the default is
  `THOR_BEHAVIOR_EVAL_REPLICATES` or `1`.
- `--endpoint <url>` overrides `THOR_BEHAVIOR_EVAL_BASE_URL`.
- `--output <directory>` changes the default gitignored
  `.context/behavior-evals/<timestamp>` output.
- `THOR_BEHAVIOR_EVAL_REASONING_EFFORT` sends an explicit reasoning effort.
- `THOR_BEHAVIOR_EVAL_REQUEST_PARAMS` supplies other provider parameters as a
  JSON object. It cannot override the model, input, instructions, tools,
  endpoint, credentials, `parallel_tool_calls`, or `store`.

The driver disables Promptfoo caching, sets `parallel_tool_calls: false` and
`store: false`, and omits Promptfoo sampling defaults. If `build.md` does not
configure sampling, the artifact records a null reasoning effort and an empty
additional-parameter object. A codex-lb model outside the whitelist in
`docker/opencode/config/opencode.json` produces a warning; the endpoint remains
the authority and may reject it.

Each run writes:

- `results.jsonl`: one record per checkpoint replicate, including source paths,
  Git SHA, endpoint/model identity, request parameters, grade, raw response,
  usage, cost, and latency where returned;
- `summary.json`: run-level provenance and aggregate counts.

A provider error is a failed row. A returned model that differs from the
requested model aborts the run so mislabeled results are not compared.

## Author a scenario

Add one module under `scenarios/`. Tool schemas and call IDs never belong in
scenario data:

```ts
import type { Scenario } from "../types.js";

export default {
  schema_version: 1,
  id: "find-runner-timeout",
  title: "inspect runner timeout handling",
  category: "engineering",
  messages: [{ role: "user", content: "How is the runner timeout handled?" }],
  trajectory: [
    {
      expect_tool: {
        name: "grep",
        arguments_contain: { pattern: "timeout", path: "packages/runner" },
      },
      frozen_arguments: {
        pattern: "timeout",
        path: "packages/runner",
        include: "*.ts",
      },
      result: "packages/runner/src/example.ts:10",
    },
    {
      expect_reply: {
        contains_all: ["timeout"],
        contains_none: ["confirmed root cause"],
        max_words: 100,
      },
    },
  ],
} satisfies Scenario;
```

Every non-final step is a tool request with complete frozen arguments and a
frozen result. The final step is a reply. `arguments_contain` recursively checks
object keys, treats string leaves as substrings, and compares other leaves
exactly. It cannot check `bash.command`: use `arguments_exact` for a
byte-significant fixed command or a semantic assertion script.

For a semantic check, add one small default-exported `BehaviorAssertion` in
`asserts/<name>.ts`, then reference it as `assert: "<name>"`. There is no
registry. Tool assertions are validated against their own frozen call before a
run. Assertions for complete shell commands must reject trailing commands,
pipelines, redirects, or unsupported syntax rather than fall back to substring
matching.

Built-in reply checks reject every function call. A reply assertion can define a
narrower side-effect contract; `internal-reply-without-slack-post` requires
internal text and specifically forbids a `bash` command that invokes
`slack-post-message`.

## Interpretation and fidelity boundary

Later checkpoints receive the authored golden earlier action, not the
candidate's earlier output. History contains authored messages plus frozen
`function_call` and `function_call_output` items. It deliberately contains no
invented model reasoning items, persisted Responses state, OpenCode session
state, or executed tools. Report checkpoint pass rates as isolated decision
quality, not end-to-end task success. Runtime E2E tests remain the integration
gate.

If a backend rejects a multi-step checkpoint because prior reasoning items are
absent, treat that as a protocol-fidelity failure and update the compiler
deliberately; do not silently execute tools or reuse candidate outputs.

Promptfoo state lives under `.context/promptfoo`. Keep artifacts, HTML reports,
credentials, and model outputs out of git.
