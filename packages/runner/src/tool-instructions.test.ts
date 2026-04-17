import { describe, expect, it } from "vitest";
import { buildToolInstructions } from "./tool-instructions.js";
import type { WorkspaceConfig } from "@thor/common";

describe("buildToolInstructions", () => {
  it("renders registry-backed instructions for configured repo upstreams", () => {
    const config: WorkspaceConfig = {
      repos: {
        acme: {
          proxies: ["slack", "atlassian"],
        },
      },
    };

    const instructions = buildToolInstructions(config, "/workspace/repos/acme");

    expect(instructions).toContain("## slack (allow)");
    expect(instructions).toContain("- post_message");
    expect(instructions).toContain("## atlassian (approve — requires human approval)");
    expect(instructions).toContain("- createJiraIssue");
    expect(instructions).not.toContain("## unknown");
  });

  it("returns undefined when the repo has no configured upstreams", () => {
    const config: WorkspaceConfig = {
      repos: {
        acme: {},
      },
    };

    expect(buildToolInstructions(config, "/workspace/repos/acme")).toBeUndefined();
  });
});
