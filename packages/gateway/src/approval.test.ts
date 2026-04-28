import { describe, expect, it } from "vitest";
import {
  buildApprovalButtonValue,
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
