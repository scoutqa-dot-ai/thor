import { describe, expect, it } from "vitest";
import {
  ApprovalRequiredEventPayloadSchema,
  BrowserOpenAuthenticatedApprovalArgsSchema,
  BrowserOpenAuthenticatedRequestArgsSchema,
  FindLoginItemsArgsSchema,
} from "./approval-events.js";
import { buildApprovalPresentation } from "./approval-presentation.js";

const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const LOGIN_PLAN_ID = "00000000-0000-4000-8000-000000000003";
const URL = "https://app.example.com/dashboard";
const APPLICATION_ORIGIN = "https://app.example.com";
const CREDENTIAL_ORIGIN = "https://identity.example.net";

function approvalArgs(overrides: Record<string, unknown> = {}) {
  return {
    login_plan_id: LOGIN_PLAN_ID,
    item_id: ITEM_ID,
    item_title: "Example audit",
    application_origin: APPLICATION_ORIGIN,
    credential_origin: CREDENTIAL_ORIGIN,
    callback_origin: APPLICATION_ORIGIN,
    ...overrides,
  };
}

describe("1Password authenticated browser approval boundary", () => {
  it("accepts only the narrow credential-free discovery shape", () => {
    expect(FindLoginItemsArgsSchema.safeParse({ url: URL }).success).toBe(true);
    expect(FindLoginItemsArgsSchema.safeParse({ url: URL, unexpected: "secret" }).success).toBe(
      false,
    );
  });

  it("separates model-supplied plan selection from trusted origin and title enrichment", () => {
    expect(
      BrowserOpenAuthenticatedRequestArgsSchema.safeParse({
        login_plan_id: LOGIN_PLAN_ID,
        item_id: ITEM_ID,
      }).success,
    ).toBe(true);
    expect(
      BrowserOpenAuthenticatedRequestArgsSchema.safeParse({
        login_plan_id: LOGIN_PLAN_ID,
        item_id: ITEM_ID,
        item_title: "Model-authored title",
      }).success,
    ).toBe(false);
    expect(
      BrowserOpenAuthenticatedRequestArgsSchema.safeParse({
        login_plan_id: LOGIN_PLAN_ID,
        item_id: ITEM_ID,
        application_origin: APPLICATION_ORIGIN,
      }).success,
    ).toBe(false);
    expect(
      BrowserOpenAuthenticatedRequestArgsSchema.safeParse({
        login_plan_id: LOGIN_PLAN_ID,
        item_id: ITEM_ID,
        automate_totp: true,
      }).success,
    ).toBe(true);
    expect(BrowserOpenAuthenticatedApprovalArgsSchema.safeParse(approvalArgs()).success).toBe(true);
  });

  it.each([
    "http://app.example.com",
    "https://user:pass@app.example.com",
    "https://app.example.com/path",
    "https://app.example.com?token=secret",
    "https://app.example.com#secret",
  ])("rejects unsafe approval origin %s", (origin) => {
    expect(
      BrowserOpenAuthenticatedApprovalArgsSchema.safeParse(
        approvalArgs({ application_origin: origin }),
      ).success,
    ).toBe(false);
  });

  it("rejects invisible and bidirectional controls in a Login title", () => {
    expect(
      BrowserOpenAuthenticatedApprovalArgsSchema.safeParse(
        approvalArgs({ item_title: "Audit\u202eLogin" }),
      ).success,
    ).toBe(false);
  });

  it("presents the trusted Login title and complete origin chain without credentials", () => {
    const parsed = ApprovalRequiredEventPayloadSchema.parse({
      type: "approval_required",
      actionId: "action-1",
      proxyName: "onepassword-browser",
      tool: "browser_open_authenticated",
      args: approvalArgs(),
    });
    expect(parsed.tool).toBe("browser_open_authenticated");

    const presentation = buildApprovalPresentation("browser_open_authenticated", parsed.args);
    expect(presentation?.title).toBe("Open authenticated browser: Example audit");
    expect(presentation?.markdown).toContain(`*1Password item:* ${ITEM_ID}`);
    expect(presentation?.markdown).toContain(`*Application origin:* ${APPLICATION_ORIGIN}`);
    expect(presentation?.markdown).toContain(`*Credential origin:* ${CREDENTIAL_ORIGIN}`);
    expect(presentation?.markdown).toContain(`*Callback origin:* ${APPLICATION_ORIGIN}`);
    expect(presentation?.markdown).toContain("*Automated TOTP:* Disabled");
    expect(presentation?.markdown).toContain("only at the credential origin");
    expect(JSON.stringify(presentation)).not.toContain("password-value");
  });

  it("explicitly discloses automated TOTP authorization", () => {
    const presentation = buildApprovalPresentation(
      "browser_open_authenticated",
      approvalArgs({ automate_totp: true }),
    );

    expect(presentation?.markdown).toContain("*Automated TOTP:* Enabled");
    expect(presentation?.markdown).toContain("one fresh TOTP code");
    expect(presentation?.markdown).toContain("never shown to Neo or Slack");
  });

  it("neutralizes Slack formatting characters in a trusted Login title", () => {
    const presentation = buildApprovalPresentation(
      "browser_open_authenticated",
      approvalArgs({ item_title: "*Admin* `override`_" }),
    );

    expect(presentation?.title).toBe("Open authenticated browser: ＊Admin＊ ｀override｀＿");
    expect(presentation?.markdown).toContain(`*Application origin:* ${APPLICATION_ORIGIN}`);
  });
});
