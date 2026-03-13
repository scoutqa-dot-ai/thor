import { describe, it, expect } from "vitest";
import {
  classifyTool,
  isAllowed,
  isApprovalRequired,
  validatePolicy,
  PolicyDriftError,
  PolicyOverlapError,
} from "./policy.js";

const allow = ["read_issue", "list_issues", "search_code"];
const approve = ["create_pr", "merge_pr"];

describe("classifyTool", () => {
  it("returns 'allow' for tools in allow list", () => {
    expect(classifyTool(allow, approve, "read_issue")).toBe("allow");
    expect(classifyTool(allow, approve, "list_issues")).toBe("allow");
  });

  it("returns 'approve' for tools in approve list", () => {
    expect(classifyTool(allow, approve, "create_pr")).toBe("approve");
    expect(classifyTool(allow, approve, "merge_pr")).toBe("approve");
  });

  it("returns 'hidden' for tools in neither list", () => {
    expect(classifyTool(allow, approve, "delete_repo")).toBe("hidden");
    expect(classifyTool(allow, approve, "fork_repo")).toBe("hidden");
  });

  it("works with empty approve list", () => {
    expect(classifyTool(allow, [], "read_issue")).toBe("allow");
    expect(classifyTool(allow, [], "create_pr")).toBe("hidden");
  });

  it("works with empty allow list", () => {
    expect(classifyTool([], approve, "create_pr")).toBe("approve");
    expect(classifyTool([], approve, "read_issue")).toBe("hidden");
  });
});

describe("isAllowed", () => {
  it("returns true for allowed tools", () => {
    expect(isAllowed(allow, "read_issue")).toBe(true);
  });

  it("returns false for non-allowed tools", () => {
    expect(isAllowed(allow, "create_pr")).toBe(false);
  });
});

describe("isApprovalRequired", () => {
  it("returns true for approval-required tools", () => {
    expect(isApprovalRequired(approve, "create_pr")).toBe(true);
  });

  it("returns false for non-approval tools", () => {
    expect(isApprovalRequired(approve, "read_issue")).toBe(false);
  });
});

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

  it("passes with empty approve list", () => {
    expect(() => validatePolicy(allow, [], upstream)).not.toThrow();
  });

  it("passes with empty allow and approve lists", () => {
    expect(() => validatePolicy([], [], upstream)).not.toThrow();
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
