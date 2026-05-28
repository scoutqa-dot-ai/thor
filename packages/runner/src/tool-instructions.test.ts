import { describe, expect, it } from "vitest";
import { buildToolInstructions } from "./tool-instructions.js";

describe("buildToolInstructions", () => {
  it("uses absolute HTTPS Jira attachment upload URLs", () => {
    const instructions = buildToolInstructions("/workspace/repos/my-repo");

    expect(instructions).toContain(
      "https://<site>.atlassian.net/rest/api/3/issue/<KEY>/attachments",
    );
    expect(instructions).toContain(
      "https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/<KEY>/attachments",
    );
  });

  it("returns undefined when not under /workspace/repos", () => {
    expect(buildToolInstructions("/tmp")).toBeUndefined();
  });
});
