import type { ToolCatalog } from "./types.js";

// Stable OpenCode tools that the build agent chooses directly. Integration
// choices remain bash commands (mcp, gh, psql, slack-post-message, and so on).
export const tools = [
  {
    name: "bash",
    description: "Execute a shell command in the current workspace and return its output.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The complete shell command to execute.",
        },
        timeout: {
          type: "number",
          description: "Optional command timeout in milliseconds.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "read",
    description: "Read a file or a bounded range of lines from a file.",
    input_schema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "grep",
    description: "Search file contents for a regular expression.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "glob",
    description: "Find files whose paths match a glob pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "task",
    description: "Delegate a bounded task to a specialized subagent.",
    input_schema: {
      type: "object",
      properties: {
        subagent_type: { type: "string", enum: ["coder", "thinker"] },
        description: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["subagent_type", "description", "prompt"],
      additionalProperties: false,
    },
    strict: true,
  },
] as const satisfies ToolCatalog;

export const responseTools = tools.map((tool) => ({
  type: "function" as const,
  name: tool.name,
  description: tool.description,
  parameters: tool.input_schema,
  strict: tool.strict,
}));
