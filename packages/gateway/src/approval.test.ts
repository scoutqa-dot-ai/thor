import { describe, expect, it } from "vitest";
import {
  buildApprovalButtonValue,
  buildApprovalPresentation,
  buildApprovalPresentationBlocks,
  buildInlineApprovalBlocks,
  formatApprovalArgs,
  parseApprovalButtonValue,
} from "./approval.js";

describe("approval formatting", () => {
  it("keeps full pretty JSON inline when within the Slack block limit", () => {
    const args = { repo: "acme/api", branch: "feature/full-json", dryRun: false };
    const argsJson = formatApprovalArgs(args);

    const blocks = buildInlineApprovalBlocks("create_pr", argsJson, "v2:abc:github");
    expect(blocks[1]).toMatchObject({
      type: "section",
      expand: true,
      text: {
        type: "mrkdwn",
        text: `\`\`\`json\n${argsJson}\n\`\`\``,
      },
    });
  });

  it("recursively trims oversized JSON instead of slicing the rendered output", () => {
    const args = {
      repo: "acme/api",
      body: {
        description: "x".repeat(5000),
        reviewers: Array.from({ length: 20 }, (_, index) => ({
          login: `reviewer-${index}`,
          notes: "y".repeat(400),
        })),
        metadata: Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [`key-${index}`, "z".repeat(300)]),
        ),
      },
    };

    const argsJson = formatApprovalArgs(args);

    expect(argsJson.length).toBeLessThanOrEqual(2990);
    expect(argsJson).toContain("_trimmed");
    expect(argsJson).toContain("[+");
    expect(argsJson).not.toContain("...[+0 chars]");
  });

  it("guarantees the final rendered JSON fits Slack's section limit", () => {
    const args = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `key-${index}-${"x".repeat(80)}`,
        {
          nested: Object.fromEntries(
            Array.from({ length: 50 }, (_, nestedIndex) => [
              `nested-${nestedIndex}-${"y".repeat(80)}`,
              "z".repeat(500),
            ]),
          ),
        },
      ]),
    );

    const argsJson = formatApprovalArgs(args);

    expect(argsJson.length).toBeLessThanOrEqual(2990);
    expect(
      argsJson.includes('"approval args too large for Slack"') ||
        argsJson.includes('"[+194 more keys]"'),
    ).toBe(true);
  });
});

describe("approval presentation", () => {
  it("returns only title and markdown for configured approval tools", () => {
    const presentation = buildApprovalPresentation("createJiraIssue", {
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
      projectKey: "ENG",
      summary: "<!here> & <@U123>",
      description: "See <#C123> & <!channel>",
    });

    expect(presentation).toEqual({
      title: "Create Jira issue: &lt;!here&gt; &amp; &lt;@U123&gt;",
      markdown:
        "*Project:* ENG\n\n*Summary:* &lt;!here&gt; &amp; &lt;@U123&gt;\n\n*Description:*\nSee &lt;#C123&gt; &amp; &lt;!channel&gt;",
    });
  });

  it("builds sparse presentations without throwing", () => {
    expect(buildApprovalPresentation("addCommentToJiraIssue", {})).toEqual({
      title: "Comment on Jira issue: unknown issue",
      markdown: "*Issue:* unknown issue",
    });
    expect(
      buildApprovalPresentation("addCommentToJiraIssue", {
        issueKey: "ENG-42",
        commentBody: "Looks good to me.",
      }),
    ).toEqual({
      title: "Comment on Jira issue: ENG-42",
      markdown: "*Issue:* ENG-42\n\n*Comment:*\nLooks good to me.",
    });
    expect(buildApprovalPresentation("create-feature-flag", { key: "beta", active: false })).toEqual({
      title: "Create feature flag: beta",
      markdown: "*Key:* beta\n\n*Active:* false",
    });
    expect(buildApprovalPresentation("update-feature-flag", { key: "beta", filters: { groups: [] } }))
      .toEqual({
        title: "Update feature flag: beta",
        markdown: '*Flag:* beta\n\n*filters:* {"groups":[]}',
      });
  });

  it("returns undefined for unconfigured tools", () => {
    expect(buildApprovalPresentation("merge_pull_request", { pr: 42 })).toBeUndefined();
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
        expect.objectContaining({ action_id: "approval_approve", value: "v3:act-1:posthog:1710000000.001" }),
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
    expect((blocks[0] as { text: { text: string } }).text.text.length).toBeLessThanOrEqual(280 + 11);
    expect((blocks[1] as { text: { text: string } }).text.text.length).toBeLessThanOrEqual(3000);
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

  it("parses legacy v2 payloads for compatibility", () => {
    expect(parseApprovalButtonValue("v2:act-1:atlassian")).toEqual({
      actionId: "act-1",
      upstreamName: "atlassian",
    });
  });

  it("returns undefined for malformed v3 upstream encoding", () => {
    expect(parseApprovalButtonValue("v3:act-1:%ZZ:1710000000.001")).toBeUndefined();
  });
});
