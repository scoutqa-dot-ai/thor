import { describe, expect, it } from "vitest";
import { formatAuthHelperError } from "./auth-helper-format.js";

describe("formatAuthHelperError", () => {
  it("adds the Thor tag to untagged errors", () => {
    expect(formatAuthHelperError(new Error("boom"))).toBe("[thor-github-app] boom");
  });

  it("does not duplicate the Thor tag when already present", () => {
    expect(formatAuthHelperError(new Error('[thor-github-app] missing org "acme"'))).toBe(
      '[thor-github-app] missing org "acme"',
    );
  });

  it("formats non-Error values", () => {
    expect(formatAuthHelperError("plain failure")).toBe("[thor-github-app] plain failure");
  });
});
