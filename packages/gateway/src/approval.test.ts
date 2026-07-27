import { describe, expect, it } from "vitest";
import {
  approvalPresentationIsOversize,
  buildApprovalActionIdTag,
  buildApprovalButtonValue,
  buildApprovalNotificationText,
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
      "act-1",
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

  it("truncates an overlong title", () => {
    const longValue = "x".repeat(4000);
    const blocks = buildApprovalPresentationBlocks(
      {
        title: `Create feature flag: ${longValue}`,
        markdown: "short body",
      },
      "v3:act-1:posthog:1710000000.001",
      "act-1",
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
  });

  it("replaces an oversize body with a pointer to the uploaded file carrying the same action ID, instead of a truncated preview", () => {
    const longValue = "x".repeat(4000);
    const blocks = buildApprovalPresentationBlocks(
      { title: "Create feature flag: beta", markdown: longValue },
      "v3:act-1:posthog:1710000000.001",
      "act-1",
    );

    expect(blocks[1]).toMatchObject({
      type: "section",
      expand: true,
      text: {
        type: "mrkdwn",
        text: "Full content shared as a file in this thread (approval `act-1`).",
      },
    });
  });

  it("pairs each of two same-title oversize approvals with its own action ID, not the other's", () => {
    const longValue = "x".repeat(4000);
    const presentation = { title: "Create feature flag: beta", markdown: longValue };

    const blocksA = buildApprovalPresentationBlocks(
      presentation,
      "v3:act-a:posthog:1710000000.001",
      "act-a",
    );
    const blocksB = buildApprovalPresentationBlocks(
      presentation,
      "v3:act-b:posthog:1710000000.002",
      "act-b",
    );

    const textA = (blocksA[1] as { text: { text: string } }).text.text;
    const textB = (blocksB[1] as { text: { text: string } }).text.text;

    expect(textA).toContain("approval `act-a`");
    expect(textA).not.toContain("act-b");
    expect(textB).toContain("approval `act-b`");
    expect(textB).not.toContain("act-a");
  });
});

describe("approval notification text", () => {
  it("keeps the plain title for a normal-size presentation", () => {
    const text = buildApprovalNotificationText(
      { title: "Create feature flag: beta", markdown: "*Key:* beta" },
      "act-1",
    );
    expect(text).toBe("Create feature flag: beta");
  });

  it("appends the action ID for an oversize presentation", () => {
    const text = buildApprovalNotificationText(
      { title: "Create feature flag: beta", markdown: "x".repeat(4000) },
      "act-1",
    );
    expect(text).toBe("Create feature flag: beta (approval `act-1`)");
  });

  it("distinguishes two same-title oversize approvals by action ID", () => {
    const presentation = { title: "Create feature flag: beta", markdown: "x".repeat(4000) };
    const textA = buildApprovalNotificationText(presentation, "act-a");
    const textB = buildApprovalNotificationText(presentation, "act-b");

    expect(textA).not.toBe(textB);
    expect(textA).toContain("act-a");
    expect(textB).toContain("act-b");
  });
});

describe("approval action ID tag", () => {
  it("formats the shared action ID tag", () => {
    expect(buildApprovalActionIdTag("act-1")).toBe("(approval `act-1`)");
  });

  it("is embedded verbatim in both the oversize card pointer and the notification text, so they cannot drift apart", () => {
    const presentation = { title: "Create feature flag: beta", markdown: "x".repeat(4000) };
    const tag = buildApprovalActionIdTag("act-1");

    const blocks = buildApprovalPresentationBlocks(
      presentation,
      "v3:act-1:posthog:1710000000.001",
      "act-1",
    );
    const pointerText = (blocks[1] as { text: { text: string } }).text.text;
    const notificationText = buildApprovalNotificationText(presentation, "act-1");

    expect(pointerText).toContain(tag);
    expect(notificationText).toContain(tag);
  });
});

describe("approval oversize detection", () => {
  it("flags a presentation as oversize only when its body exceeds the section limit", () => {
    expect(approvalPresentationIsOversize({ title: "t", markdown: "short" })).toBe(false);
    expect(approvalPresentationIsOversize({ title: "t", markdown: "x".repeat(3001) })).toBe(true);
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
