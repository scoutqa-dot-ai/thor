import { describe, expect, it } from "vitest";
import { buildToolInstructions } from "./tool-instructions.js";
import type { WorkspaceConfig } from "@thor/common";

describe("buildToolInstructions", () => {
  it("renders MCP instructions and a Slack capability hint for channel-mapped repos", () => {
    const config: WorkspaceConfig = {
      repos: {
        acme: {
          channels: ["C123"],
          proxies: ["atlassian"],
        },
      },
    };

    const instructions = buildToolInstructions(config, "/workspace/repos/acme");

    expect(instructions).toContain("[Available MCP tools");
    expect(instructions).toContain("## atlassian (approve — requires human approval)");
    expect(instructions).toContain("- createJiraIssue");
    expect(instructions).toContain("[Slack capability]");
    expect(instructions).toContain("real Slack Web API URLs over mitmproxy");
    expect(instructions).toContain("do not use `mcp slack`");
    expect(instructions).toContain("chat.postMessage");
    expect(instructions).toContain("reactions.add");
    expect(instructions).toContain("reaction remove");
    expect(instructions).toContain("preserve raw JSON stdout");
    expect(instructions).not.toContain("## slack (allow)");
    expect(instructions).not.toContain("## unknown");
  });

  it("returns Slack-only guidance when repo has channels but no proxies", () => {
    const config: WorkspaceConfig = {
      repos: {
        acme: {
          channels: ["C123"],
        },
      },
    };

    const instructions = buildToolInstructions(config, "/workspace/repos/acme");

    expect(instructions).toContain("[Slack capability]");
    expect(instructions).toContain("chat.postMessage");
    expect(instructions).toContain("reactions.add");
    expect(instructions).not.toContain("[Available MCP tools");
  });

  it("returns undefined when the repo has no configured proxies or channels", () => {
    const config: WorkspaceConfig = {
      repos: {
        acme: {},
      },
    };

    expect(buildToolInstructions(config, "/workspace/repos/acme")).toBeUndefined();
  });
});
