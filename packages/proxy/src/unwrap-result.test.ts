import { describe, it, expect } from "vitest";
import { unwrapResult } from "./unwrap-result.js";

describe("unwrapResult", () => {
  it("unwraps a single text block to plain text", () => {
    const result = {
      content: [{ type: "text", text: '{"ok":true,"ts":"1234","channel":"C123"}' }],
    };
    expect(unwrapResult(result)).toBe('{"ok":true,"ts":"1234","channel":"C123"}');
  });

  it("joins multiple text blocks with newline", () => {
    const result = {
      content: [
        { type: "text", text: '{"file":"metadata"}' },
        { type: "text", text: "file contents here" },
      ],
    };
    expect(unwrapResult(result)).toBe('{"file":"metadata"}\nfile contents here');
  });

  it("returns JSON envelope when content has non-text blocks", () => {
    const result = {
      content: [
        { type: "text", text: "metadata" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    };
    expect(unwrapResult(result)).toBe(JSON.stringify(result));
  });

  it("returns JSON envelope when content is empty", () => {
    const result = { content: [] };
    expect(unwrapResult(result)).toBe(JSON.stringify(result));
  });

  it("returns JSON envelope when shape is unexpected", () => {
    const result = { error: "something" };
    expect(unwrapResult(result)).toBe(JSON.stringify(result));
  });
});
