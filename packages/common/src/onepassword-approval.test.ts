import { describe, expect, it } from "vitest";
import {
  ApprovalRequiredEventPayloadSchema,
  BrowserOpenAuthenticatedApprovalArgsSchema,
  BrowserOpenAuthenticatedRequestArgsSchema,
  FindLoginItemsArgsSchema,
} from "./approval-events.js";
import { buildApprovalPresentation } from "./approval-presentation.js";

const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const URL = "https://accounts.example.com/dashboard";

describe("1Password authenticated browser approval boundary", () => {
  it("accepts only the narrow exact-origin discovery shape", () => {
    expect(FindLoginItemsArgsSchema.safeParse({ url: URL }).success).toBe(true);
    expect(FindLoginItemsArgsSchema.safeParse({ url: URL, unexpected: "secret" }).success).toBe(
      false,
    );
  });

  it("separates model-supplied open arguments from trusted title enrichment", () => {
    expect(
      BrowserOpenAuthenticatedRequestArgsSchema.safeParse({ item_id: ITEM_ID, url: URL }).success,
    ).toBe(true);
    expect(
      BrowserOpenAuthenticatedRequestArgsSchema.safeParse({
        item_id: ITEM_ID,
        url: URL,
        item_title: "Model-authored title",
      }).success,
    ).toBe(false);
    expect(
      BrowserOpenAuthenticatedRequestArgsSchema.safeParse({
        item_id: ITEM_ID,
        url: URL,
        automate_totp: true,
      }).success,
    ).toBe(true);
    expect(
      BrowserOpenAuthenticatedApprovalArgsSchema.safeParse({
        item_id: ITEM_ID,
        url: URL,
        item_title: "Example audit",
      }).success,
    ).toBe(true);
    expect(
      BrowserOpenAuthenticatedRequestArgsSchema.safeParse({
        item_id: ITEM_ID,
        url: URL,
        automate_totp: "true",
      }).success,
    ).toBe(false);
  });

  it.each([
    "http://accounts.example.com/dashboard",
    "https://user:pass@accounts.example.com/dashboard",
    `${URL}?token=secret`,
    `${URL}#secret`,
  ])("rejects unsafe approval destination %s", (url) => {
    expect(
      BrowserOpenAuthenticatedRequestArgsSchema.safeParse({ item_id: ITEM_ID, url }).success,
    ).toBe(false);
  });

  it("rejects invisible and bidirectional controls in a Login title", () => {
    expect(
      BrowserOpenAuthenticatedApprovalArgsSchema.safeParse({
        item_id: ITEM_ID,
        url: URL,
        item_title: "Audit\u202eLogin",
      }).success,
    ).toBe(false);
  });

  it("presents the trusted Login title and exact destination without credentials", () => {
    const parsed = ApprovalRequiredEventPayloadSchema.parse({
      type: "approval_required",
      actionId: "action-1",
      proxyName: "onepassword-browser",
      tool: "browser_open_authenticated",
      args: { item_id: ITEM_ID, url: URL, item_title: "Example audit" },
    });
    expect(parsed.tool).toBe("browser_open_authenticated");

    const presentation = buildApprovalPresentation("browser_open_authenticated", parsed.args);
    expect(presentation).toEqual({
      title: "Open authenticated browser: Example audit",
      markdown: [
        "*1Password Login:* Example audit",
        `*1Password item:* ${ITEM_ID}`,
        `*Exact destination:* ${URL}`,
        "*Automated TOTP:* Disabled",
        "Approval permits password autofill and a ten-minute broker-owned browser session on this exact HTTPS origin. Credential values, cookies, and browser storage are never shown to Neo or Slack.",
      ].join("\n\n"),
    });
    expect(JSON.stringify(presentation)).not.toContain("password-value");
  });

  it("explicitly discloses automated TOTP authorization", () => {
    const presentation = buildApprovalPresentation("browser_open_authenticated", {
      item_id: ITEM_ID,
      url: URL,
      item_title: "Example audit",
      automate_totp: true,
    });

    expect(presentation?.markdown).toContain("*Automated TOTP:* Enabled");
    expect(presentation?.markdown).toContain("one fresh TOTP code");
    expect(presentation?.markdown).toContain("never shown to Neo or Slack");
  });

  it("neutralizes Slack formatting characters in the exact destination", () => {
    const presentation = buildApprovalPresentation("browser_open_authenticated", {
      item_id: ITEM_ID,
      url: "https://accounts.example.com/*not-bold*",
      item_title: "Example audit",
    });

    expect(presentation?.markdown).toContain(
      "*Exact destination:* https://accounts.example.com/＊not-bold＊",
    );
  });

  it("neutralizes Slack formatting characters in a trusted Login title", () => {
    const presentation = buildApprovalPresentation("browser_open_authenticated", {
      item_id: ITEM_ID,
      url: URL,
      item_title: "*Admin* `override`_",
    });

    expect(presentation?.title).toBe("Open authenticated browser: ＊Admin＊ ｀override｀＿");
    expect(presentation?.markdown).toContain(
      "*Exact destination:* https://accounts.example.com/dashboard",
    );
  });
});
