import { describe, expect, it } from "vitest";
import { buildApprovalPresentation } from "./approval-presentation.ts";

describe("buildApprovalPresentation — gh issue create", () => {
  // The stored approval args are the raw, reviewed command. The disclaimer
  // footer + assignee are injected only at execution, so the card must not
  // render the footer (it used to appear twice — in the body preview and in a
  // raw command block) and must not echo the full command.
  it("shows the author's body preview without the disclaimer footer or a command block", () => {
    const presentation = buildApprovalPresentation("ghIssueCreate", {
      cwd: "/workspace/repos/thor",
      args: ["issue", "create", "--title", "foo", "--body", "bar"],
      title: "foo",
      bodyPreview: "bar",
    });

    expect(presentation).toBeDefined();
    expect(presentation!.title).toBe("Create GitHub issue: foo");
    expect(presentation!.markdown).toContain("*Body preview:*\nbar");
    expect(presentation!.markdown).not.toContain("verify before acting");
    expect(presentation!.markdown).not.toContain("*Command:*");
    expect(presentation!.markdown).not.toContain("gh issue create");
  });
});
