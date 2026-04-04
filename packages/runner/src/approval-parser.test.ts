import { describe, it, expect } from "vitest";
import { extractThorMeta, formatThorMeta } from "@thor/common";
import type { ThorMetaApproval } from "@thor/common";

describe("approval via [thor:meta]", () => {
  const approval: ThorMetaApproval = {
    type: "approval",
    actionId: "550e8400-e29b-41d4-a716-446655440000",
    proxyName: "atlassian",
    tool: "createJiraIssue",
  };

  it("extracts approval from [thor:meta] line in combined output", () => {
    const output = `Approval required for \`createJiraIssue\`. Run: approval status ${approval.actionId}${formatThorMeta(approval)}`;
    const metas = extractThorMeta(output);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toEqual(approval);
  });

  it("extracts approval when meta is the only content", () => {
    const output = formatThorMeta(approval);
    const metas = extractThorMeta(output);
    expect(metas).toHaveLength(1);
    expect(metas[0].type).toBe("approval");
    if (metas[0].type === "approval") {
      expect(metas[0].actionId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(metas[0].proxyName).toBe("atlassian");
      expect(metas[0].tool).toBe("createJiraIssue");
    }
  });

  it("does not match non-meta output", () => {
    const output = '{"type":"tool_result","status":"ok"}';
    expect(extractThorMeta(output)).toEqual([]);
  });

  it("skips malformed [thor:meta] lines", () => {
    const output = "[thor:meta] not-json\n[thor:meta] {invalid";
    expect(extractThorMeta(output)).toEqual([]);
  });

  it("extracts both alias and approval from same output", () => {
    const alias = formatThorMeta({
      type: "alias",
      alias: "git:branch:repo:main",
      context: "git push in /workspace/repos/repo",
    });
    const approvalMeta = formatThorMeta(approval);
    const output = `some output${alias}more output${approvalMeta}`;
    const metas = extractThorMeta(output);
    expect(metas).toHaveLength(2);
    expect(metas[0].type).toBe("alias");
    expect(metas[1].type).toBe("approval");
  });
});
