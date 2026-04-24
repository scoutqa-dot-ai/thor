import { describe, expect, it } from "vitest";
import { PolicyDriftError, PolicyOverlapError, validatePolicy } from "./policy-mcp.js";

describe("validatePolicy", () => {
  const allow = ["read_issue", "list_issues", "search_code"];
  const approve = ["create_pr", "merge_pr"];
  const upstream = [
    "read_issue",
    "list_issues",
    "search_code",
    "create_pr",
    "merge_pr",
    "delete_repo",
  ];

  it("accepts matching allow and approve lists", () => {
    expect(() => validatePolicy(allow, approve, upstream)).not.toThrow();
  });

  it("rejects policy drift", () => {
    expect(() => validatePolicy([...allow, "missing_tool"], approve, upstream)).toThrow(
      PolicyDriftError,
    );
  });

  it("rejects overlap between allow and approve", () => {
    expect(() => validatePolicy(allow, [...approve, "read_issue"], upstream)).toThrow(
      PolicyOverlapError,
    );
  });
});
