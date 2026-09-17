import { describe, expect, it } from "vitest";
import { sanitizeCredentialBrokerToolCallLog } from "./credential-broker-audit.js";

const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const BROWSER_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";

describe("credential browser worklog sanitization", () => {
  it("retains only validated safe IDs, exact origin, session, action, and outcome", () => {
    const secret = "must-not-enter-credential-worklog";
    const entry = sanitizeCredentialBrokerToolCallLog({
      tool: "browser_open_authenticated",
      decision: "approved",
      args: {
        item_id: ITEM_ID,
        item_title: "Private account title",
        automate_totp: true,
        url: `https://accounts.example.com/dashboard?token=${secret}`,
        browser_session_id: BROWSER_SESSION_ID,
        snapshot_id: SNAPSHOT_ID,
        _thor_session_id: "parent-session",
        text: secret,
        password: secret,
      },
      result: JSON.stringify({
        title: "Sensitive page title",
        accessibility: [{ text: secret }],
      }),
      durationMs: 12,
    });

    expect(entry).toEqual({
      tool: "browser_open_authenticated",
      decision: "approved",
      args: {
        item_id: ITEM_ID,
        browser_session_id: BROWSER_SESSION_ID,
        snapshot_id: SNAPSHOT_ID,
        _thor_session_id: "parent-session",
        origin: "https://accounts.example.com",
      },
      result: { outcome: "succeeded" },
      durationMs: 12,
    });
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(entry)).not.toContain("Private account title");
    expect(JSON.stringify(entry)).not.toContain("Sensitive page title");
  });

  it.each([
    "find_login_items",
    "browser_open_authenticated",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_navigate",
    "browser_close",
  ])("replaces %s errors and outputs with a classified outcome", (tool) => {
    const entry = sanitizeCredentialBrokerToolCallLog({
      tool,
      decision: "allowed",
      args: { text: "private typed text" },
      error: "upstream accidentally included a credential",
    });

    expect(entry.error).toBeUndefined();
    expect(entry.args).toEqual({});
    expect(entry.result).toEqual({ outcome: "failed" });
    expect(JSON.stringify(entry)).not.toContain("private typed text");
    expect(JSON.stringify(entry)).not.toContain("credential");
  });

  it("drops malformed identifier strings rather than treating them as safe IDs", () => {
    const secret = "secret-shaped-invalid-identifier";
    const entry = sanitizeCredentialBrokerToolCallLog({
      tool: "browser_snapshot",
      decision: "allowed",
      args: {
        item_id: secret,
        browser_session_id: secret,
        snapshot_id: secret,
      },
      result: {},
    });

    expect(entry.args).toEqual({});
    expect(JSON.stringify(entry)).not.toContain(secret);
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
