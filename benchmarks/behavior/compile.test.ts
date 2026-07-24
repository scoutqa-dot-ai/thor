import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertDirectory, compileSuite, repositoryRoot, type CompileOptions } from "./compile.js";
import { gradeNextAction } from "./assert-next-action.js";
import { buildPromptfooSuite, parseRunArguments } from "./run.js";
import type { Checkpoint, Scenario } from "./types.js";

function loaded(scenario: Scenario): NonNullable<CompileOptions["scenarios"]>[number] {
  return {
    scenario,
    path: resolve(repositoryRoot, `benchmarks/behavior/scenarios/${scenario.id}.ts`),
  };
}

const twoToolScenario = {
  schema_version: 1,
  id: "two-tools",
  title: "two tool checkpoint expansion",
  category: "test",
  messages: [{ role: "user", content: "Investigate the failure." }],
  trajectory: [
    {
      expect_tool: {
        name: "grep",
        arguments_contain: { pattern: "failure" },
      },
      frozen_arguments: { pattern: "failure", path: "packages" },
      result: "packages/runner/src/run.ts:42",
    },
    {
      expect_tool: {
        name: "read",
        arguments_exact: {
          filePath: "packages/runner/src/run.ts",
          offset: 35,
          limit: 20,
        },
      },
      frozen_arguments: {
        filePath: "packages/runner/src/run.ts",
        offset: 35,
        limit: 20,
      },
      result: "throw new Error('failure')",
    },
    {
      expect_reply: {
        contains_all: ["failure"],
        max_words: 80,
      },
    },
  ],
} as const satisfies Scenario;

describe("behavior scenario compiler", () => {
  it("expands two tools and a reply into independent frozen checkpoints", async () => {
    const suite = await compileSuite({ scenarios: [loaded(twoToolScenario)] });
    expect(suite.checkpoints).toHaveLength(3);
    expect(suite.checkpoints.map((checkpoint) => checkpoint.input.length)).toEqual([1, 3, 5]);
    expect(suite.checkpoints[1]?.input).toMatchInlineSnapshot(`
      [
        {
          "content": "Investigate the failure.",
          "role": "user",
          "type": "message",
        },
        {
          "arguments": "{"pattern":"failure","path":"packages"}",
          "call_id": "call_two_tools_1",
          "name": "grep",
          "type": "function_call",
        },
        {
          "call_id": "call_two_tools_1",
          "output": "packages/runner/src/run.ts:42",
          "type": "function_call_output",
        },
      ]
    `);
    expect(suite.checkpoints[2]?.input.at(-2)).toMatchObject({
      type: "function_call",
      call_id: "call_two_tools_2",
      name: "read",
    });
    expect(suite.provenance).toMatchObject({
      git_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      endpoint: "http://127.0.0.1:2455/v1",
      model: "gpt-5.6-terra",
      request: { parallel_tool_calls: false, store: false },
    });
    expect(suite.provenance.source_paths).toContain("docker/opencode/config/agents/build.md");
  });

  it("rejects semantic cross-reference failures without model access", async () => {
    const malformed = {
      ...twoToolScenario,
      id: "bad-schema",
      trajectory: [
        {
          expect_tool: {
            name: "read",
            arguments_exact: { filePath: "README.md" },
          },
          frozen_arguments: {},
          result: "text",
        },
        { expect_reply: { contains_all: ["done"] } },
      ],
    } as unknown as Scenario;
    await expect(compileSuite({ scenarios: [loaded(malformed)] })).rejects.toThrow(
      /frozen_arguments.*must have required property 'filePath'/u,
    );
  });

  it("rejects bash command substring matching", async () => {
    const malformed = {
      ...twoToolScenario,
      id: "unsafe-bash-substring",
      trajectory: [
        {
          expect_tool: {
            name: "bash",
            arguments_contain: { command: "mcp grafana" },
          },
          frozen_arguments: { command: "mcp grafana" },
          result: "text",
        },
        { expect_reply: { contains_all: ["done"] } },
      ],
    } as unknown as Scenario;
    await expect(compileSuite({ scenarios: [loaded(malformed)] })).rejects.toThrow(
      /bash\.command cannot use arguments_contain/u,
    );
  });
});

function checkpoint(
  expectation: Checkpoint["expectation"],
  expectationType: Checkpoint["expectation_type"],
): Checkpoint {
  return {
    id: "test#1",
    scenario_id: "test",
    scenario_title: "test",
    category: "test",
    step_index: 0,
    instructions: "test",
    input: [],
    tools: [],
    expectation,
    expectation_type: expectationType,
    source_paths: [],
  };
}

describe("behavior assertions", () => {
  it("defines silence as internal text without a Slack post", async () => {
    const target = checkpoint({ assert: "internal-reply-without-slack-post" }, "reply");
    await expect(
      gradeNextAction(
        target,
        {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "No follow-up is needed." }],
            },
          ],
        },
        assertDirectory,
      ),
    ).resolves.toMatchObject({ pass: true });
    await expect(
      gradeNextAction(
        target,
        {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Done." }],
            },
            {
              type: "function_call",
              name: "bash",
              arguments: JSON.stringify({
                command: "echo done | slack-post-message --channel C123",
              }),
            },
          ],
        },
        assertDirectory,
      ),
    ).resolves.toMatchObject({
      pass: false,
      reason: expect.stringContaining("slack-post-message"),
    });
  });

  it("rejects a second top-level command in a semantic Loki assertion", async () => {
    const target = {
      ...checkpoint({ name: "bash", assert: "grafana-loki-query-only" }, "tool"),
      frozen_arguments: {
        command:
          'mcp grafana query_loki_logs \'{"datasourceUid":"loki","logql":"{service=\\"edge\\"}"}\'',
      },
    } satisfies Checkpoint;
    const extraCommand = target.frozen_arguments.command + " && slack-post-message --channel C123";
    await expect(
      gradeNextAction(
        target,
        {
          output: [
            {
              type: "function_call",
              name: "bash",
              arguments: JSON.stringify({ command: extraCommand }),
            },
          ],
        },
        assertDirectory,
      ),
    ).resolves.toMatchObject({ pass: false });
  });

  it.each([
    [
      "text-only answer",
      { output: [{ type: "message", content: "I would search." }] },
      "exactly one",
    ],
    [
      "extra function call",
      {
        output: [
          { type: "function_call", name: "grep", arguments: '{"pattern":"x"}' },
          { type: "function_call", name: "grep", arguments: '{"pattern":"x"}' },
        ],
      },
      "received 2",
    ],
    [
      "wrong tool",
      {
        output: [{ type: "function_call", name: "read", arguments: '{"filePath":"x"}' }],
      },
      "expected tool grep",
    ],
    [
      "wrong arguments",
      {
        output: [{ type: "function_call", name: "grep", arguments: '{"pattern":"other"}' }],
      },
      "arguments mismatch",
    ],
    [
      "malformed arguments",
      {
        output: [{ type: "function_call", name: "grep", arguments: "{" }],
      },
      "malformed JSON",
    ],
  ])("rejects a %s", async (_name, response, reason) => {
    const target = checkpoint({ name: "grep", arguments_contain: { pattern: "failure" } }, "tool");
    await expect(gradeNextAction(target, response, assertDirectory)).resolves.toMatchObject({
      pass: false,
      reason: expect.stringContaining(reason),
    });
  });
});

describe("Promptfoo driver", () => {
  it("builds a typed Responses suite with immutable request boundaries", async () => {
    const compiled = await compileSuite({ scenarios: [loaded(twoToolScenario)] });
    const suite = buildPromptfooSuite(compiled, "test-key");
    expect(suite.providers).toMatchObject([
      {
        id: "openai:responses:gpt-5.6-terra",
        config: {
          apiBaseUrl: "http://127.0.0.1:2455/v1",
          apiKey: "test-key",
          parallel_tool_calls: false,
          store: false,
          omitDefaults: true,
        },
      },
    ]);
    expect(suite.tests).toHaveLength(3);
  });

  it("parses filters and rejects protected passthrough parameters", () => {
    expect(parseRunArguments(["--scenario", "two-tools", "--replicates", "3"], {})).toMatchObject({
      scenario: "two-tools",
      replicates: 3,
    });
    expect(() =>
      parseRunArguments([], {
        THOR_BEHAVIOR_EVAL_REQUEST_PARAMS: '{"store":true}',
      }),
    ).toThrow(/protected key store/u);
  });
});
