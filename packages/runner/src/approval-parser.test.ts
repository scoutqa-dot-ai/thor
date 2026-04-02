import { describe, it, expect } from "vitest";

// JSON extraction pattern — matches the one in index.ts parseApprovalResult
const JSON_PATTERN = /\{[^{}]*"type"\s*:\s*"approval_required"[^{}]*\}/;

// Legacy regex patterns — fallback for older proxy versions
const ACTION_ID_PATTERN = /Action ID:\s*([0-9a-f-]{36})/;
const PROXY_NAME_PATTERN = /Proxy-Name:\s*([a-z0-9][a-z0-9-]*)/;

describe("approval parser — structured JSON format", () => {
  const jsonPayload = JSON.stringify({
    type: "approval_required",
    actionId: "550e8400-e29b-41d4-a716-446655440000",
    proxyName: "atlassian",
    tool: "createJiraIssue",
  });

  it("extracts JSON from concatenated output", () => {
    const output = `⏳ Approval required for \`createJiraIssue\`. Use \`check_approval_status\` with action ID to check the outcome.\n${jsonPayload}`;
    const match = output.match(JSON_PATTERN);
    expect(match).toBeTruthy();
    const parsed = JSON.parse(match![0]);
    expect(parsed.type).toBe("approval_required");
    expect(parsed.actionId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(parsed.proxyName).toBe("atlassian");
  });

  it("extracts JSON when it is the entire output", () => {
    const match = jsonPayload.match(JSON_PATTERN);
    expect(match).toBeTruthy();
    expect(JSON.parse(match![0]).actionId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("does not match non-approval JSON", () => {
    const output = '{"type":"tool_result","status":"ok"}';
    expect(output.match(JSON_PATTERN)).toBeNull();
  });
});

describe("approval parser — legacy regex format", () => {
  const sampleMessage =
    "⏳ Approval required for `createJiraIssue`. Action ID: 550e8400-e29b-41d4-a716-446655440000. Proxy-Name: atlassian. Use `check_approval_status` with this ID to check the outcome.";

  it("extracts action ID", () => {
    const match = sampleMessage.match(ACTION_ID_PATTERN);
    expect(match?.[1]).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("extracts proxy name without trailing period", () => {
    const match = sampleMessage.match(PROXY_NAME_PATTERN);
    expect(match?.[1]).toBe("atlassian");
  });

  it("extracts hyphenated proxy name", () => {
    const msg = "Proxy-Name: my-proxy-1. Done.";
    const match = msg.match(PROXY_NAME_PATTERN);
    expect(match?.[1]).toBe("my-proxy-1");
  });

  it("returns null for missing proxy name", () => {
    const msg = "Approval required. Action ID: 550e8400-e29b-41d4-a716-446655440000.";
    expect(msg.match(PROXY_NAME_PATTERN)).toBeNull();
  });
});
