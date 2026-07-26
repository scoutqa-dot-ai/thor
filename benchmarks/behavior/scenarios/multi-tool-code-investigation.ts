import type { Scenario } from "../types.js";

export default {
  schema_version: 1,
  id: "multi-tool-code-investigation",
  title: "inspect a failing runner path before answering",
  category: "engineering",
  messages: [
    {
      role: "user",
      content:
        "The runner reports PolicyDriftError in development. Find where it is handled and explain the intended behavior.",
    },
  ],
  trajectory: [
    {
      expect_tool: {
        name: "grep",
        arguments_contain: {
          pattern: "PolicyDriftError",
          path: "packages/runner",
        },
      },
      frozen_arguments: {
        pattern: "PolicyDriftError",
        path: "packages/runner",
        include: "*.ts",
      },
      result: "packages/runner/src/opencode-events.ts:118: if (error instanceof PolicyDriftError)",
    },
    {
      expect_tool: {
        name: "read",
        arguments_exact: {
          filePath: "packages/runner/src/opencode-events.ts",
          offset: 108,
          limit: 30,
        },
      },
      frozen_arguments: {
        filePath: "packages/runner/src/opencode-events.ts",
        offset: 108,
        limit: 30,
      },
      result:
        "Development rethrows PolicyDriftError so schema drift fails loudly. Production logs the drift and keeps the live run alive.",
    },
    {
      expect_reply: {
        contains_all: ["development", "production", "live run"],
        contains_none: ["always ignored"],
        max_words: 110,
      },
    },
  ],
} satisfies Scenario;
