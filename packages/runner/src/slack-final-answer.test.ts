import { describe, expect, it } from "vitest";
import { prepareSlackFinalAnswer } from "./slack-final-answer.js";

describe("final Slack answer size and markup contract", () => {
  it.each(["🙂", "x", "🙂text ", "<https://example.test/report|report> "])(
    "keeps %s chunks within Block Kit UTF-16 limits without broken Unicode or duplicated metadata",
    (piece) => {
      const prepared = prepareSlackFinalAnswer(piece.repeat(4000), {
        type: "model",
        modelId: "model",
        thinkingLevel: "high",
      });
      expect(prepared.state).toBe("ready");
      if (prepared.state !== "ready") return;
      expect(
        prepared.chunks.every(
          (chunk) =>
            chunk.text.length < 3000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text),
        ),
      ).toBe(true);
      expect(prepared.chunks.map((chunk) => chunk.text).join("")).toBe(piece.repeat(4000));
      expect(prepared.chunks.filter((chunk) => chunk.blocks.length > 1)).toHaveLength(1);
      expect(prepared.chunks.at(-1)?.blocks).toHaveLength(2);
    },
  );

  it("escapes ordinary angles but preserves intentional Slack references and comparison code at entity boundaries", () => {
    const entities = "<@U123> <#C123|channel> <!here> <https://example.test/a|link>";
    for (let padding = 2760; padding < 2810; padding++) {
      const text =
        "x".repeat(padding) +
        " < 1 > 0 & ready " +
        entities +
        " `count < limit` " +
        "tail ".repeat(700);
      const prepared = prepareSlackFinalAnswer(text);
      expect(prepared.state).toBe("ready");
      if (prepared.state !== "ready") continue;
      expect(prepared.chunks.map((chunk) => chunk.text).join("")).toBe(
        text.replace("< 1 > 0 & ready", "&lt; 1 &gt; 0 &amp; ready"),
      );
      expect(prepared.chunks.every((chunk) => !/&(?:a|am|amp|l|lt|g|gt)?$/.test(chunk.text))).toBe(
        true,
      );
      for (const entity of entities.split(" "))
        expect(prepared.chunks.filter((chunk) => chunk.text.includes(entity))).toHaveLength(1);
      expect(
        prepared.chunks.filter((chunk) => chunk.text.includes("`count < limit`")),
      ).toHaveLength(1);
    }
  });

  it("rejects over-budget answers or unbreakable entities rather than clipping or sending malformed partial content", () => {
    expect(prepareSlackFinalAnswer("x".repeat(2800 * 65))).toEqual({ state: "rejected" });
    expect(
      prepareSlackFinalAnswer("```" + "long-language".repeat(100) + "\n" + "code".repeat(3000)),
    ).toEqual({ state: "rejected" });
    expect(prepareSlackFinalAnswer(`<https://example.test/${"x".repeat(4000)}|report>`)).toEqual({
      state: "rejected",
    });
  });
});
