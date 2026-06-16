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

describe("buildApprovalPresentation — aws write command", () => {
  it("renders the reviewed aws command in a code block with the working directory", () => {
    const presentation = buildApprovalPresentation("awsExec", {
      cwd: "/workspace/repos/thor",
      args: ["s3", "cp", "./build.zip", "s3://my-bucket/build.zip"],
    });

    expect(presentation).toBeDefined();
    expect(presentation!.title).toBe("Run aws command");
    expect(presentation!.markdown).toContain("*Directory:* /workspace/repos/thor");
    expect(presentation!.markdown).toContain(
      "*Command:*\n```\naws s3 cp ./build.zip s3://my-bucket/build.zip\n```",
    );
  });

  it("preserves shell metacharacters literally instead of parsing them as mrkdwn", () => {
    const presentation = buildApprovalPresentation("awsExec", {
      cwd: "/workspace/repos/thor",
      args: ["s3", "rm", "s3://my-bucket/*.log", "--recursive"],
    });

    expect(presentation).toBeDefined();
    // The `*` must survive verbatim inside the fence, not toggle bold.
    expect(presentation!.markdown).toContain(
      "```\naws s3 rm s3://my-bucket/*.log --recursive\n```",
    );
  });
});
