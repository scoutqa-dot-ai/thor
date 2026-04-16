import { describe, expect, it } from "vitest";
import { unwrapResult } from "./unwrap-result.js";

describe("unwrapResult", () => {
  it("joins text content blocks into stdout", () => {
    expect(
      unwrapResult({
        content: [
          { type: "text", text: '{"file":"metadata"}' },
          { type: "text", text: "file contents here" },
        ],
      }),
    ).toBe('{"file":"metadata"}\nfile contents here');
  });

  it("falls back to JSON for non-text responses", () => {
    const result = {
      content: [
        { type: "text", text: "metadata" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    };

    expect(unwrapResult(result)).toBe(JSON.stringify(result));
  });
});
