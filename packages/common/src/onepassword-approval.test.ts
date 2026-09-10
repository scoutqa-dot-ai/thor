import { describe, expect, it } from "vitest";
import {
  ApprovalRequiredEventPayloadSchema,
  BrowserLoginApprovalArgsSchema,
  GetLoginMetadataArgsSchema,
} from "./approval-events.js";
import { buildApprovalPresentation } from "./approval-presentation.js";

const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORIGIN = "https://accounts.lambdatest.com";

describe("1Password browser approval boundary", () => {
  it("accepts only the narrow metadata argument shape", () => {
    expect(GetLoginMetadataArgsSchema.safeParse({ item_id: ITEM_ID }).success).toBe(true);
    expect(
      GetLoginMetadataArgsSchema.safeParse({ item_id: ITEM_ID, unexpected: "secret" }).success,
    ).toBe(false);
    expect(GetLoginMetadataArgsSchema.safeParse({ item_id: "not-an-id" }).success).toBe(false);
  });

  it("accepts only an exact canonical HTTPS origin for login", () => {
    expect(
      BrowserLoginApprovalArgsSchema.safeParse({
        item_id: ITEM_ID,
        expected_origin: ORIGIN,
      }).success,
    ).toBe(true);

    for (const expected_origin of [
      "http://accounts.lambdatest.com",
      `${ORIGIN}/login`,
      `${ORIGIN}/`,
      `${ORIGIN}?next=/dashboard`,
      "https://user:pass@accounts.lambdatest.com",
    ]) {
      expect(
        BrowserLoginApprovalArgsSchema.safeParse({ item_id: ITEM_ID, expected_origin }).success,
      ).toBe(false);
    }
  });

  it("parses and presents browser login without credential values", () => {
    const parsed = ApprovalRequiredEventPayloadSchema.parse({
      type: "approval_required",
      actionId: "action-1",
      proxyName: "onepassword-browser",
      tool: "browser_login",
      args: { item_id: ITEM_ID, expected_origin: ORIGIN },
    });
    expect(parsed.tool).toBe("browser_login");

    const presentation = buildApprovalPresentation("browser_login", parsed.args);
    expect(presentation).toEqual({
      title: "Log in with approved 1Password item",
      markdown: [
        `*1Password item:* ${ITEM_ID}`,
        `*Exact destination origin:* ${ORIGIN}`,
        "The credential values, cookies, and browser storage are never shown to Neo or Slack.",
      ].join("\n\n"),
    });
  });
});
