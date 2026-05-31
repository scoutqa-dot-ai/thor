import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAge, formatBytes, formatCostUsd, formatDuration, formatTokens } from "./format.ts";

describe("formatTokens", () => {
  it("returns the raw integer below 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("truncates (not rounds) to 0.1K between 1k and 1M", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(5_983)).toBe("5.9K");
    expect(formatTokens(583_930)).toBe("583.9K");
  });

  it("truncates to 0.1M at or above 1M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(4_962_304)).toBe("4.9M");
  });
});

describe("formatDuration", () => {
  it("renders integer s / m+s / h+m / d+h ranges", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(59_999)).toBe("59s");
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(2 * 60_000 + 30_000)).toBe("2m 30s");
    expect(formatDuration(60 * 60_000)).toBe("1h 0m");
    expect(formatDuration(60 * 60_000 + 5 * 60_000)).toBe("1h 5m");
    expect(formatDuration(24 * 60 * 60_000)).toBe("1d 0h");
    expect(formatDuration(25 * 60 * 60_000)).toBe("1d 1h");
  });

  it("returns undefined for non-finite or non-numeric input via the unknown overload", () => {
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration("100")).toBeUndefined();
    expect(formatDuration(Number.NaN)).toBeUndefined();
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeUndefined();
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
  it("renders B / KB / MB ranges", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it('returns "?" for invalid input', () => {
    expect(formatBytes(-1)).toBe("?");
    expect(formatBytes(Number.NaN)).toBe("?");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("?");
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
