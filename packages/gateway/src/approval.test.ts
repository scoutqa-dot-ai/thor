import { describe, expect, it } from "vitest";
import {
  approvalPresentationIsOversize,
  buildApprovalButtonValue,
  buildApprovalPresentation,
  buildApprovalPresentationBlocks,
  parseApprovalButtonValue,
} from "@thor/common";

describe("approval presentation", () => {
  it("returns only title and markdown for configured approval tools", () => {
    const presentation = buildApprovalPresentation("createJiraIssue", {
      cloudId: "cloud-1",
      projectKey: "ENG",
      issueTypeName: "Task",
      summary: "Ship approval cards",
      description: "Use a concise markdown preview.",
    });

    expect(presentation).toEqual({
      title: "Create Jira issue: Ship approval cards",
      markdown:
        "*Project:* ENG\n\n*Issue type:* Task\n\n*Summary:* Ship approval cards\n\n*Description:*\nUse a concise markdown preview.",
    });
    expect(Object.keys(presentation ?? {})).toEqual(["title", "markdown"]);
  });

  it("escapes mrkdwn-special user input in titles and markdown", () => {
    const presentation = buildApprovalPresentation("createJiraIssue", {
      cloudId: "cloud-1",
      projectKey: "ENG",
      issueTypeName: "Task",
      summary: "<!here> & <@U123>",
      description: "See <#C123> & <!channel>",
    });

    expect(presentation).toEqual({
      title: "Create Jira issue: &lt;!here&gt; &amp; &lt;@U123&gt;",
      markdown:
        "*Project:* ENG\n\n*Issue type:* Task\n\n*Summary:* &lt;!here&gt; &amp; &lt;@U123&gt;\n\n*Description:*\nSee &lt;#C123&gt; &amp; &lt;!channel&gt;",
    });
  });

  it("renders strict approval presentations for known tool schemas", () => {
    expect(
      buildApprovalPresentation("addCommentToJiraIssue", {
        cloudId: "cloud-1",
        issueIdOrKey: "ENG-42",
        commentBody: "Looks good to me.",
      }),
    ).toEqual({
      title: "Comment on Jira issue: ENG-42",
      markdown: "Looks good to me.",
    });
    expect(
      buildApprovalPresentation("addCommentToJiraIssue", {
        cloudId: "cloud-1",
        issueIdOrKey: "KSR-11011",
        commentBody: "Approved.",
      }),
    ).toEqual({
      title: "Comment on Jira issue: KSR-11011",
      markdown: "Approved.",
    });
    expect(
      buildApprovalPresentation("create-feature-flag", { key: "beta", active: false }),
    ).toEqual({ title: "Create feature flag: beta", markdown: "*Key:* beta\n\n*Active:* false" });
  });

  it("throws on invalid args for a known tool (the gate rejects these upstream)", () => {
    expect(() =>
      buildApprovalPresentation("createJiraIssue", {
        projectKey: "ENG",
        summary: "Missing required fields",
      }),
    ).toThrow();
    expect(() =>
      buildApprovalPresentation("addCommentToJiraIssue", {
        issueKey: "ENG-42",
        commentBody: "Legacy alias",
      }),
    ).toThrow();
    expect(() => buildApprovalPresentation("create-feature-flag", { flagKey: "beta" })).toThrow();
  });

  it("renders presentations for known tool schemas with extra unknown fields", () => {
    expect(
      buildApprovalPresentation("create-feature-flag", { key: "beta", "<!here>": true }),
    ).toEqual({
      title: "Create feature flag: beta",
      markdown: "*Key:* beta",
    });
  });

  it("falls back to non-empty markdown when rendered fields trim to empty", () => {
    expect(
      buildApprovalPresentation("addCommentToJiraIssue", {
        cloudId: "cloud-1",
        issueIdOrKey: "ENG-42",
        commentBody: "   ",
      }),
    ).toEqual({
      title: "Comment on Jira issue: ENG-42",
      markdown: "No arguments provided.",
    });
  });

  it("renders presentation markdown blocks with the shared approval actions", () => {
    const blocks = buildApprovalPresentationBlocks(
      { title: "Create feature flag: beta", markdown: "*Key:* beta" },
      "v3:act-1:posthog:1710000000.001",
    );

    expect(blocks[0]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: ":lock: *Create feature flag: beta*" },
    });
    expect(blocks[1]).toMatchObject({
      type: "section",
      expand: true,
      text: { type: "mrkdwn", text: "*Key:* beta" },
    });
    expect(blocks[3]).toMatchObject({
      type: "actions",
      elements: expect.arrayContaining([
        expect.objectContaining({
          action_id: "approval_approve",
          value: "v3:act-1:posthog:1710000000.001",
        }),
      ]),
    });
  });

  it("keeps presentation block text within Slack limits when truncating", () => {
    const longValue = "x".repeat(4000);
    const blocks = buildApprovalPresentationBlocks(
      {
        title: `Create feature flag: ${longValue}`,
        markdown: longValue,
      },
      "v3:act-1:posthog:1710000000.001",
    );

    expect(blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: expect.stringContaining("…[+"),
      },
    });
    expect((blocks[0] as { text: { text: string } }).text.text.length).toBeLessThanOrEqual(
      280 + 11,
    );
    expect((blocks[1] as { text: { text: string } }).text.text.length).toBeLessThanOrEqual(3000);
  });
});

describe("approval oversize detection and file link", () => {
  it("flags a presentation as oversize only when its body exceeds the section limit", () => {
    expect(approvalPresentationIsOversize({ title: "t", markdown: "short" })).toBe(false);
    expect(approvalPresentationIsOversize({ title: "t", markdown: "x".repeat(3001) })).toBe(true);
  });

  it("appends a file link block below the truncated body when a fileUrl is given", () => {
    const blocks = buildApprovalPresentationBlocks(
      { title: "Create feature flag: beta", markdown: "x".repeat(4000) },
      "v3:act-1:posthog:1710000000.001",
      "https://slack.example/files/F1",
    );

    const linkBlock = blocks.find(
      (b): b is { type: "section"; text: { type: "mrkdwn"; text: string } } =>
        b.type === "section" && b.text.text.includes("View the full content"),
    );
    expect(linkBlock?.text.text).toBe(
      ":paperclip: <https://slack.example/files/F1|View the full content>",
    );
  });

  it("omits the file link block when no fileUrl is given", () => {
    const blocks = buildApprovalPresentationBlocks(
      { title: "Create feature flag: beta", markdown: "*Key:* beta" },
      "v3:act-1:posthog:1710000000.001",
    );
    expect(
      blocks.some((b) => b.type === "section" && b.text.text.includes("View the full content")),
    ).toBe(false);
  });
});

describe("approval button routing", () => {
  it("encodes v3 payloads with thread routing data", () => {
    const value = buildApprovalButtonValue({
      actionId: "act-1",
      upstreamName: "github",
      threadTs: "1710000000.001",
    });

    expect(value).toBe("v3:act-1:github:1710000000.001");
    expect(parseApprovalButtonValue(value)).toEqual({
      actionId: "act-1",
      upstreamName: "github",
      threadTs: "1710000000.001",
    });
  });

  it("returns undefined for malformed v3 upstream encoding", () => {
    expect(parseApprovalButtonValue("v3:act-1:%ZZ:1710000000.001")).toBeUndefined();
  });
});
