import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAge, formatBytes, formatCostUsd, formatDuration, formatTokens } from "./format.ts";

describe("formatTokens", () => {
  it.each([
    // raw integer below 1k
    [0, "0"],
    [999, "999"],
    // truncates (not rounds) to 0.1K between 1k and 1M
    [1000, "1.0K"],
    [5_983, "5.9K"],
    [583_930, "583.9K"],
    // truncates to 0.1M at or above 1M
    [1_000_000, "1.0M"],
    [4_962_304, "4.9M"],
  ])("formats %i as %s", (input, expected) => {
    expect(formatTokens(input)).toBe(expected);
  });
});

describe("formatDuration", () => {
  it.each([
    // integer s / m+s / h+m / d+h ranges
    [0, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [2 * 60_000 + 30_000, "2m 30s"],
    [60 * 60_000, "1h 0m"],
    [60 * 60_000 + 5 * 60_000, "1h 5m"],
    [24 * 60 * 60_000, "1d 0h"],
    [25 * 60 * 60_000, "1d 1h"],
    // non-finite or non-numeric input via the unknown overload
    [undefined, undefined],
    ["100", undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
  ])("formats %p as %p", (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});

describe("formatAge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for empty / unparseable / future timestamps", () => {
    expect(formatAge(undefined)).toBeUndefined();
    expect(formatAge("")).toBeUndefined();
    expect(formatAge("not-a-date")).toBeUndefined();
    expect(formatAge("2026-01-01T00:00:01.000Z")).toBeUndefined();
  });

  it("formats age as a duration relative to now", () => {
    expect(formatAge("2025-12-31T23:59:55.000Z")).toBe("5s");
    expect(formatAge("2025-12-31T23:00:00.000Z")).toBe("1h 0m");
  });
});

describe("formatBytes", () => {
  it.each([
    // B / KB / MB ranges
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1024 * 1024, "1.0 MB"],
    [5 * 1024 * 1024, "5.0 MB"],
    // "?" for invalid input
    [-1, "?"],
    [Number.NaN, "?"],
    [Number.POSITIVE_INFINITY, "?"],
  ])("formats %p as %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe("formatCostUsd", () => {
  it("uses tighter precision for smaller amounts", () => {
    expect(formatCostUsd(0)).toBe("$0.0000");
    expect(formatCostUsd(0.001234)).toBe("$0.0012");
    expect(formatCostUsd(0.0125)).toBe("$0.013");
    expect(formatCostUsd(0.999)).toBe("$0.999");
    expect(formatCostUsd(1)).toBe("$1.00");
    expect(formatCostUsd(12.345)).toBe("$12.35");
  });
});
