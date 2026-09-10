import { describe, expect, it } from "vitest";
import { sanitizeCredentialBrokerToolCallLog } from "./credential-broker-audit.ts";

describe("credential broker worklog sanitization", () => {
  it("retains only approved identifiers, origin, session, action, and outcome", () => {
    const secret = "must-not-enter-credential-worklog";
    const entry = sanitizeCredentialBrokerToolCallLog({
      tool: "get_login_metadata",
      decision: "allowed",
      targetKey: "onepassword-browser:GLOBAL",
      args: {
        item_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
        expected_origin: "https://accounts.lambdatest.com",
        _thor_session_id: "parent-session",
        password: secret,
      },
      result: JSON.stringify({
        vault_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        title: "Sensitive item title",
        fields: [{ name: "private field", value: secret }],
      }),
      durationMs: 12,
    });

    expect(entry).toEqual({
      tool: "get_login_metadata",
      decision: "allowed",
      targetKey: "onepassword-browser:GLOBAL",
      profile: undefined,
      args: {
        item_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
        expected_origin: "https://accounts.lambdatest.com",
        _thor_session_id: "parent-session",
      },
      result: { outcome: "succeeded" },
      durationMs: 12,
    });
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(entry)).not.toContain("Sensitive item title");
    expect(JSON.stringify(entry)).not.toContain("private field");
  });

  it("replaces credential-boundary errors with a failed outcome", () => {
    const entry = sanitizeCredentialBrokerToolCallLog({
      tool: "browser_login",
      decision: "approved",
      args: { item_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb" },
      error: "upstream accidentally included a secret",
    });

    expect(entry.error).toBeUndefined();
    expect(entry.result).toEqual({ outcome: "failed" });
  });

  it("does not change unrelated integration logs", () => {
    const entry = {
      tool: "getJiraIssue",
      decision: "allowed" as const,
      args: { issueKey: "THOR-1" },
      result: "issue body",
    };

    expect(sanitizeCredentialBrokerToolCallLog(entry)).toBe(entry);
  });
});
