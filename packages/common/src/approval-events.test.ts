import { describe, expect, it } from "vitest";
import { injectApprovalDisclaimer } from "./approval-events.ts";

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
