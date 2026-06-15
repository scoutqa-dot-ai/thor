import { describe, expect, it } from "vitest";
import { buildApprovalPresentation } from "./approval-presentation.ts";

describe("buildApprovalPresentation — gh issue create", () => {
  // Footer + assignee are injected only at execution, so the card must not
  // render the footer or echo the raw command.
  it("shows the author's body preview without the disclaimer footer or a command block", () => {
    const presentation = buildApprovalPresentation("ghIssueCreate", {
      cwd: "/workspace/repos/thor",
      args: ["issue", "create", "--title", "foo", "--body", "bar"],
      title: "foo",
      bodyPreview: "bar",
    });

    expect(presentation).toBeDefined();
    expect(presentation!.markdown).toContain("*Body preview:*\nbar");
    expect(presentation!.markdown).not.toContain("verify before acting");
    expect(presentation!.markdown).not.toContain("*Command:*");
    expect(presentation!.markdown).not.toContain("gh issue create");
  });
});
