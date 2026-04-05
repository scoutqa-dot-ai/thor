import { describe, it, expect } from "vitest";
import { validatePolicy, PolicyDriftError, PolicyOverlapError } from "./policy.js";

const allow = ["read_issue", "list_issues", "search_code"];
const approve = ["create_pr", "merge_pr"];

describe("validatePolicy", () => {
  const upstream = [
    "read_issue",
    "list_issues",
    "search_code",
    "create_pr",
    "merge_pr",
    "delete_repo",
  ];

  it("passes with valid allow and approve lists", () => {
    expect(() => validatePolicy(allow, approve, upstream)).not.toThrow();
  });

  it("throws PolicyDriftError for orphaned allow entries", () => {
    const badAllow = [...allow, "nonexistent_tool"];
    expect(() => validatePolicy(badAllow, approve, upstream)).toThrow(PolicyDriftError);
    try {
      validatePolicy(badAllow, approve, upstream);
    } catch (err) {
      expect((err as PolicyDriftError).orphans).toEqual(["nonexistent_tool"]);
    }
  });

  it("throws PolicyDriftError for orphaned approve entries", () => {
    const badApprove = [...approve, "missing_tool"];
    expect(() => validatePolicy(allow, badApprove, upstream)).toThrow(PolicyDriftError);
    try {
      validatePolicy(allow, badApprove, upstream);
    } catch (err) {
      expect((err as PolicyDriftError).orphans).toEqual(["missing_tool"]);
    }
  });

  it("throws PolicyOverlapError when a tool is in both allow and approve", () => {
    const overlappingApprove = [...approve, "read_issue"];
    expect(() => validatePolicy(allow, overlappingApprove, upstream)).toThrow(PolicyOverlapError);
    try {
      validatePolicy(allow, overlappingApprove, upstream);
    } catch (err) {
      expect((err as PolicyOverlapError).overlap).toEqual(["read_issue"]);
    }
  });
});
