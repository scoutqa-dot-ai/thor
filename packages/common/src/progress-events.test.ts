import { describe, expect, it } from "vitest";
import { ProgressEventSchema } from "./progress-events.js";

describe("ProgressEventSchema", () => {
  it("accepts context-window progress events", () => {
    expect(
      ProgressEventSchema.parse({
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 126_000,
        limit: 200_000,
        usagePercent: 63,
      }),
    ).toEqual({
      type: "context",
      providerID: "openai",
      modelID: "gpt-5.5",
      tokens: 126_000,
      limit: 200_000,
      usagePercent: 63,
    });
  });
});
