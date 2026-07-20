import { describe, expect, it } from "vitest";
import { injectApprovalDisclaimer } from "./approval-events.ts";

const FOOTER = "[View Thor context](https://thor.example.com/runner/v/anchor)";

describe("injectApprovalDisclaimer", () => {
  it("appends the footer to Confluence content when args are valid", () => {
    const result = injectApprovalDisclaimer(
      "createConfluencePage",
      { spaceKey: "ENG", title: "Design notes", content: "Body" },
      FOOTER,
    );

    expect(result.content).toBe(`Body\n${FOOTER}`);
  });

  it("fails closed instead of executing without the disclaimer when args no longer parse", () => {
    // Missing required `title`: passes a partial format check but not the full schema.
    expect(() =>
      injectApprovalDisclaimer(
        "createConfluencePage",
        { spaceKey: "ENG", content: "Body" },
        FOOTER,
      ),
    ).toThrowError(/Cannot inject approval disclaimer for "createConfluencePage"/);
  });
});
