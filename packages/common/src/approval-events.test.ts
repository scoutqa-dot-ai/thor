import { describe, expect, it } from "vitest";
import { ApprovalRequiredEventPayloadSchema, injectApprovalDisclaimer } from "./approval-events.ts";

const FOOTER = "[View Thor context](https://thor.example.com/runner/v/anchor)";

describe("injectApprovalDisclaimer", () => {
  it("appends the footer to the Confluence page body and pins markdown formatting", () => {
    const result = injectApprovalDisclaimer(
      "createConfluencePage",
      { spaceId: "ENG", title: "Design notes", body: "Page text" },
      FOOTER,
    );

    expect(result.body).toBe(`Page text\n${FOOTER}`);
    expect(result.contentFormat).toBe("markdown");
  });

  it("fails closed instead of executing without the disclaimer when args no longer parse", () => {
    // Missing required `body`: no field for the injector to append the footer to.
    expect(() =>
      injectApprovalDisclaimer("createConfluencePage", { spaceId: "ENG", title: "Notes" }, FOOTER),
    ).toThrowError(/Cannot inject approval disclaimer for "createConfluencePage"/);
  });
});

describe("browser_login approval payload", () => {
  const payload = {
    type: "approval_required",
    actionId: "action-1",
    proxyName: "onepassword-browser",
    tool: "browser_login",
    args: {
      item_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      expected_origin: "https://accounts.lambdatest.com",
    },
  } as const;

  it("accepts only the exact item/origin review surface", () => {
    expect(ApprovalRequiredEventPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      ApprovalRequiredEventPayloadSchema.safeParse({
        ...payload,
        args: { ...payload.args, password: "must-not-enter-approval-storage" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["malformed item", { ...payload.args, item_id: "bad" }],
    ["non-TLS origin", { ...payload.args, expected_origin: "http://accounts.lambdatest.com" }],
    ["origin path", { ...payload.args, expected_origin: "https://accounts.lambdatest.com/login" }],
  ])("rejects %s", (_label, args) => {
    expect(ApprovalRequiredEventPayloadSchema.safeParse({ ...payload, args }).success).toBe(false);
  });
});
