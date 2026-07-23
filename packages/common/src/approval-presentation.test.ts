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

  it("surfaces milestone and parent so the approver sees the created issue's placement", () => {
    const presentation = buildApprovalPresentation("ghIssueCreate", {
      cwd: "/workspace/repos/thor",
      args: ["issue", "create", "--title", "foo", "--body-file", "-", "-m", "v1", "--parent", "12"],
      title: "foo",
      milestone: "v1",
      parent: "12",
    });

    expect(presentation).toBeDefined();
    expect(presentation!.markdown).toContain("*Milestone:* v1");
    expect(presentation!.markdown).toContain("*Parent:* 12");
  });
});

describe("buildApprovalPresentation — confluence page create", () => {
  it("summarizes the page target and content without raw JSON noise", () => {
    const presentation = buildApprovalPresentation("createConfluencePage", {
      spaceId: "CST",
      title: "Maybank monitoring update",
      parentId: "123456",
      content: "Monitoring summary\n\nAll checks passed.",
      representation: "markdown",
    });

    expect(presentation).toBeDefined();
    expect(presentation!.title).toBe("Create Confluence page: Maybank monitoring update");
    expect(presentation!.markdown).toContain("*Space:* CST");
    expect(presentation!.markdown).toContain("*Title:* Maybank monitoring update");
    expect(presentation!.markdown).toContain("*Parent:* 123456");
    expect(presentation!.markdown).toContain("*Content preview:*\nMonitoring summary");
    expect(presentation!.markdown).not.toContain("representation");
    expect(presentation!.markdown).not.toContain('"spaceId"');
  });
});

describe("buildApprovalPresentation — aws write command", () => {
  it("renders the reviewed aws command argv in a JSON code block with the working directory", () => {
    const presentation = buildApprovalPresentation("awsExec", {
      cwd: "/workspace/repos/thor",
      args: ["s3", "cp", "./build.zip", "s3://my-bucket/build.zip"],
    });

    expect(presentation).toBeDefined();
    expect(presentation!.title).toBe("Run aws command");
    expect(presentation!.markdown).toContain("*Directory:* /workspace/repos/thor");
    expect(presentation!.markdown).toContain(
      [
        "*Command argv:*",
        "```json",
        "[",
        '  "aws",',
        '  "s3",',
        '  "cp",',
        '  "./build.zip",',
        '  "s3://my-bucket/build.zip"',
        "]",
        "```",
      ].join("\n"),
    );
  });

  it("preserves spaces and escapes backticks inside the JSON argv fence", () => {
    const presentation = buildApprovalPresentation("awsExec", {
      cwd: "/workspace/repos/thor",
      args: [
        "ec2",
        "run-instances",
        "--tag-specifications",
        "ResourceType=instance,Tags=[{Key=Name,Value=build worker}]",
        "--user-data",
        "line one\nline two with `ticks` and ``` fence",
      ],
    });

    expect(presentation).toBeDefined();
    expect(presentation!.markdown).toContain(
      '"ResourceType=instance,Tags=[{Key=Name,Value=build worker}]"',
    );
    expect(presentation!.markdown).toContain(
      '"line one\\nline two with \\u0060ticks\\u0060 and \\u0060\\u0060\\u0060 fence"',
    );
  });
});
