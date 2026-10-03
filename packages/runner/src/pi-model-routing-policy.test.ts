import { describe, expect, it } from "vitest";
import {
  decidePiModelEscalation,
  parsePiModelSelection,
  resolvePiModelRoutingPool,
  selectPiTaskModel,
  type PiModelRoutingResult,
} from "./pi-model-routing-policy.js";

function value<T>(result: PiModelRoutingResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
const config = { modelId: "existing-model", modelContextWindow: 272000, modelSupportsImages: true };
const pool = value(resolvePiModelRoutingPool(config));
const distinctPool = value(
  resolvePiModelRoutingPool(config, {
    profiles: { fast: { modelId: "quick" }, strong: { modelId: "deep", thinkingLevel: "minimal" } },
  }),
);

describe("Pi model routing policy", () => {
  it("inherits only existing model/capabilities and permits differing effort on the same model", () => {
    expect(pool).toEqual({
      provider: "codex-lb",
      profiles: {
        fast: { modelId: "existing-model", thinkingLevel: "low" },
        balanced: { modelId: "existing-model", thinkingLevel: "medium" },
        strong: { modelId: "existing-model", thinkingLevel: "high" },
      },
      modelContextWindow: 272000,
      modelSupportsImages: true,
      autoSelect: true,
      defaultProfile: "balanced",
      allowEscalation: true,
    });
    expect(JSON.stringify(pool)).not.toMatch(/apiKey|Secret|BaseUrl/);
    expect(
      value(
        resolvePiModelRoutingPool(config, {
          profiles: { strong: { modelId: "${NOT_READ_FROM_ENV}" } },
        }),
      ).profiles.strong.modelId,
    ).toBe("${NOT_READ_FROM_ENV}");
  });

  it.each([
    [{ profiles: { speedy: { modelId: "quick" } } }],
    [{ profiles: { fast: { modelID: "quick" } } }],
    [{ profiles: { fast: { modelId: "   " } } }],
    [{ profiles: { strong: { thinkingLevel: "max" } } }],
    [{ autoSelec: false }],
    [{ defaultProfile: "turbo" }],
    [null],
  ])("rejects invalid operator pool configuration %j", (routing) => {
    expect(resolvePiModelRoutingPool(config, routing)).toMatchObject({
      ok: false,
      error: { code: "configuration_invalid" },
    });
  });

  it.each([
    ["Summarize Slack status", "fast", "low"],
    ["Look up the Jira issue", "fast", "low"],
    ["Read Google Drive document and summarize it", "fast", "low"],
    ["Implement a feature and tests", "balanced", "medium"],
    ["Fix the parser bug", "balanced", "medium"],
    ["Summarize a security investigation", "strong", "high"],
    ["Design the architecture", "strong", "high"],
    ["Debug this intermittent deadlock and root cause", "strong", "high"],
    ["hello there", "balanced", "medium"],
    ["", "balanced", "medium"],
  ])("routes current task %j conservatively", (routingTask, profile, thinkingLevel) => {
    const selection = value(selectPiTaskModel({ pool, routingTask }));
    expect(selection).toMatchObject({
      profile,
      thinkingLevel,
      modelId: "existing-model",
      source: "automatic",
      escalationLocked: false,
    });
    expect(value(parsePiModelSelection(JSON.parse(JSON.stringify(selection))))).toEqual(selection);
  });

  it("uses only supplied raw current task evidence, not rendered thread/history", () => {
    const selection = value(
      selectPiTaskModel({
        pool,
        routingTask: "Historical architecture security review",
        overrides: { routingTask: "List Jira issues" },
      }),
    );
    expect(selection.profile).toBe("fast");
    expect(selection.source).toBe("automatic");
  });

  it("uses the declared default when automatic routing is disabled", () => {
    const configured = value(
      resolvePiModelRoutingPool(config, {
        autoSelect: false,
        defaultProfile: "fast",
        allowEscalation: false,
      }),
    );
    expect(
      value(
        selectPiTaskModel({ pool: configured, routingTask: "Security architecture investigation" }),
      ),
    ).toMatchObject({ profile: "fast", source: "default", escalationLocked: true });
  });

  it.each([
    [{ modelProfile: "strong", thinkingLevel: "low" }, "strong", "deep", "low"],
    [{ modelId: "quick", thinkingLevel: "high" }, "fast", "quick", "high"],
    [{ thinkingLevel: "minimal" }, "balanced", "existing-model", "minimal"],
  ])(
    "honors explicit overrides and locks escalation %j",
    (overrides, profile, modelId, thinkingLevel) => {
      const selection = value(
        selectPiTaskModel({ pool: distinctPool, routingTask: "hello", overrides }),
      );
      expect(selection).toMatchObject({ profile, modelId, thinkingLevel, escalationLocked: true });
      expect(
        decidePiModelEscalation(selection, { profile: "strong", reason: "more complex" }),
      ).toMatchObject({ ok: false, error: { code: "escalation_locked" } });
    },
  );

  it("chooses the configured default for an explicit ID shared by profiles", () => {
    expect(
      value(
        selectPiTaskModel({ pool, routingTask: "debug", overrides: { modelId: "existing-model" } }),
      ),
    ).toMatchObject({
      profile: "balanced",
      thinkingLevel: "medium",
      source: "explicit_model",
      escalationLocked: true,
    });
  });

  it.each([
    [{ modelProfile: "turbo" }, "overrides_invalid"],
    [{ modelId: "not-in-pool" }, "model_not_in_pool"],
    [{ modelProfile: "fast", modelId: "quick" }, "overrides_invalid"],
    [{ thinkingLevel: "max" }, "overrides_invalid"],
    [{ escalationLocked: false }, "overrides_invalid"],
    [{ modelSelection: {} }, "overrides_invalid"],
  ])("rejects unsupported overrides %j before any selection", (overrides, code) => {
    expect(
      selectPiTaskModel({ pool: distinctPool, routingTask: "hello", overrides }),
    ).toMatchObject({ ok: false, error: { code } });
  });

  it("allows exactly two sequential promotions within frozen pool with changing model/effort", () => {
    const initial = value(
      selectPiTaskModel({ pool: distinctPool, routingTask: "List Jira issues" }),
    );
    const balanced = value(
      decidePiModelEscalation(initial, { profile: "balanced", reason: "Implementation needed" }),
    );
    const strong = value(
      decidePiModelEscalation(balanced, {
        profile: "strong",
        reason: "Security boundary discovered",
      }),
    );
    expect(initial).toMatchObject({ profile: "fast", promotions: 0, history: [] });
    expect(balanced).toMatchObject({
      profile: "balanced",
      modelId: "existing-model",
      thinkingLevel: "medium",
      promotions: 1,
    });
    expect(strong).toMatchObject({
      profile: "strong",
      modelId: "deep",
      thinkingLevel: "minimal",
      promotions: 2,
      history: [
        { from: "fast", to: "balanced", reason: "Implementation needed" },
        { from: "balanced", to: "strong", reason: "Security boundary discovered" },
      ],
    });
    expect(value(parsePiModelSelection(JSON.parse(JSON.stringify(strong))))).toEqual(strong);
    expect(decidePiModelEscalation(strong, { profile: "strong", reason: "again" })).toMatchObject({
      ok: false,
      error: { code: "escalation_limit" },
    });
    for (const profile of ["fast", "strong", "unknown"]) {
      expect(decidePiModelEscalation(initial, { profile, reason: "try" })).toMatchObject({
        ok: false,
        error: { code: "escalation_not_upward" },
      });
    }
    expect(decidePiModelEscalation(balanced, { profile: "fast", reason: "cheaper" })).toMatchObject(
      { ok: false, error: { code: "escalation_not_upward" } },
    );
    expect(decidePiModelEscalation(initial, { profile: "balanced", reason: " " })).toMatchObject({
      ok: false,
      error: { code: "escalation_reason_invalid" },
    });
    expect(
      decidePiModelEscalation(initial, { profile: "balanced", reason: "x".repeat(1001) }),
    ).toMatchObject({ ok: false, error: { code: "escalation_reason_invalid" } });
  });

  it("exhausts all profile transitions and explicit reasoning levels through production constructors", () => {
    const profiles = ["fast", "balanced", "strong"] as const;
    const tasks = {
      fast: "List issues",
      balanced: "Implement tests",
      strong: "Investigate security",
    };
    for (const [rank, profile] of profiles.entries()) {
      const automatic = value(
        selectPiTaskModel({ pool: distinctPool, routingTask: tasks[profile] }),
      );
      for (const [targetRank, target] of profiles.entries()) {
        const result = decidePiModelEscalation(automatic, {
          profile: target,
          reason: "Unexpected complexity",
        });
        expect(result.ok).toBe(rank < 2 && targetRank === rank + 1);
      }
      for (const thinkingLevel of ["minimal", "low", "medium", "high"] as const) {
        const explicit = value(
          selectPiTaskModel({
            pool: distinctPool,
            routingTask: tasks[profile],
            overrides: { modelProfile: profile, thinkingLevel },
          }),
        );
        expect(explicit.thinkingLevel).toBe(thinkingLevel);
        expect(value(parsePiModelSelection(JSON.parse(JSON.stringify(explicit))))).toEqual(
          explicit,
        );
        expect(
          decidePiModelEscalation(explicit, { profile: "strong", reason: "Unexpected complexity" }),
        ).toMatchObject({ ok: false, error: { code: "escalation_locked" } });
      }
    }
  });

  it("rejects corrupt frozen selection invariants rather than treating them as retry authority", () => {
    const initial = value(selectPiTaskModel({ pool, routingTask: "list tasks" }));
    const explicit = value(
      selectPiTaskModel({ pool, routingTask: "list tasks", overrides: { modelProfile: "fast" } }),
    );
    const invalid = [
      { ...initial, modelId: "outside-pool" },
      { ...initial, promotions: 1 },
      { ...initial, thinkingLevel: "high" },
      { ...explicit, escalationLocked: false },
      { ...initial, pool: { ...pool, allowEscalation: false } },
      { ...initial, pool: { ...pool, autoSelect: false } },
      {
        ...initial,
        profile: "strong",
        thinkingLevel: "high",
        promotions: 2,
        history: [
          { from: "balanced", to: "strong", reason: "first" },
          { from: "balanced", to: "strong", reason: "discontinuous" },
        ],
      },
      { ...initial, promotions: 1, history: [{ from: "fast", to: "fast", reason: "loop" }] },
      { ...initial, promotions: 1, history: [{ from: "strong", to: "fast", reason: "down" }] },
      { ...initial, promotions: 1, history: [{ from: "fast", to: "strong", reason: "skip" }] },
      {
        ...initial,
        promotions: 1,
        history: [{ from: "fast", to: "balanced", reason: "wrong final" }],
      },
    ];
    for (const selection of invalid)
      expect(parsePiModelSelection(selection)).toMatchObject({
        ok: false,
        error: { code: "selection_invalid" },
      });
  });
});
