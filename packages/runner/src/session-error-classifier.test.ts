import { describe, expect, it } from "vitest";
import { isExpectedAbortSessionError } from "./prompt-stream.ts";

describe("isExpectedAbortSessionError", () => {
  it("matches expected abort, cancel, and interrupt messages", () => {
    expect(isExpectedAbortSessionError("AbortError: This operation was aborted")).toBe(true);
    expect(isExpectedAbortSessionError("request cancelled by user")).toBe(true);
    expect(isExpectedAbortSessionError("stream interrupted")).toBe(true);
  });

  it("keeps generic runtime failures at error severity", () => {
    expect(isExpectedAbortSessionError("provider unavailable")).toBe(false);
    expect(isExpectedAbortSessionError("context length exceeded")).toBe(false);
  });
});
