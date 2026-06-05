import type { ToolPart } from "@opencode-ai/sdk";
import { describe, expect, it } from "vitest";
import { toolDisplayName } from "./prompt-stream.ts";

function bashTool(command?: string): ToolPart {
  return {
    type: "tool",
    tool: "bash",
    state: { input: command === undefined ? {} : { command } },
  } as unknown as ToolPart;
}

describe("toolDisplayName", () => {
  it("renders MCP server calls without extra arguments", () => {
    expect(toolDisplayName(bashTool("mcp posthog query --limit 1"))).toBe("mcp posthog");
  });

  it("renders MCP profile calls with bracketed profile", () => {
    expect(toolDisplayName(bashTool("mcp --profile QA posthog query"))).toBe("mcp[QA] posthog");
    expect(toolDisplayName(bashTool("mcp --profile=QA posthog query"))).toBe("mcp[QA] posthog");
  });

  it("falls back to plain mcp when MCP parsing fails", () => {
    expect(toolDisplayName(bashTool("mcp --profile"))).toBe("mcp");
    expect(toolDisplayName(bashTool("mcp --profile= posthog"))).toBe("mcp");
    expect(toolDisplayName(bashTool("mcp --help"))).toBe("mcp");
  });
});
