import { describe, expect, it } from "vitest";
import { formatThorDisclaimerFooter } from "./disclaimer.js";

describe("formatThorDisclaimerFooter", () => {
  it("formats the shared Thor AI disclaimer with trigger viewer link", () => {
    expect(formatThorDisclaimerFooter("https://thor.example.com/runner/v/session/trigger")).toBe(
      "\n---\nCreated by Thor, an AI assistant. This content may be wrong; review carefully and do not trust it blindly. [View Thor trigger](https://thor.example.com/runner/v/session/trigger)",
    );
  });
});
