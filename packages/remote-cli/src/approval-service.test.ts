import { describe, expect, it } from "vitest";
import { createApprovalService } from "./approval-service.ts";

describe("createApprovalService — fail-hard gate", () => {
  // The approval-gated tool set is a closed discriminated union. An unknown
  // tool must be rejected at the gate before any pending action is persisted or
  // any Slack card is posted — no degraded fallback rendering.
  it("rejects an unknown tool before touching session state", async () => {
    const service = createApprovalService({ approvalsDir: "/tmp/approval-gate-test" });

    const result = await service.createPending({
      storeName: "github",
      tool: "totallyUnknownTool",
      displayName: "totally unknown tool",
      args: { anything: "goes" },
      sessionId: "session-without-anchor",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid approval payload for tool "totallyUnknownTool"');
  });

  it("rejects a known tool with invalid args", async () => {
    const service = createApprovalService({ approvalsDir: "/tmp/approval-gate-test" });

    const result = await service.createPending({
      storeName: "jira",
      tool: "createJiraIssue",
      displayName: "create Jira issue",
      // Missing required projectKey / issueTypeName / summary.
      args: { description: "only a description" },
      sessionId: "session-without-anchor",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid approval payload for tool "createJiraIssue"');
  });
});
