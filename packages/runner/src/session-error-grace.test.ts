import { describe, expect, it } from "vitest";
import { SessionErrorGrace } from "./session-error-grace.ts";

// Deterministic unit coverage for the state-machine contract, using the
// injectable clock the class was built with. The wall-clock window is
// exercised end-to-end in trigger.test.ts; these pin the invariants that the
// integration path can't assert without flake.
describe("SessionErrorGrace", () => {
  it("reports full window and no pending error before any record", () => {
    const g = new SessionErrorGrace(100, () => 0);
    expect(g.pending).toBe(false);
    expect(g.error).toBeUndefined();
    expect(g.remainingMs()).toBe(100);
  });

  it("counts down remainingMs from the recorded time using the injected clock", () => {
    let now = 1000;
    const g = new SessionErrorGrace(100, () => now);
    g.record("boom", 5);
    expect(g.pending).toBe(true);
    expect(g.error).toBe("boom");
    now = 1040;
    expect(g.remainingMs()).toBe(60);
    now = 1200;
    expect(g.remainingMs()).toBeLessThanOrEqual(0);
  });

  it("clears only on a seq strictly greater than the error seq", () => {
    const g = new SessionErrorGrace(100, () => 0);
    g.record("boom", 5);
    g.clearIfRecovered(5);
    expect(g.pending).toBe(true);
    g.clearIfRecovered(4);
    expect(g.pending).toBe(true);
    g.clearIfRecovered(6);
    expect(g.pending).toBe(false);
  });

  it("clearIfRecovered is a no-op when no error is held", () => {
    const g = new SessionErrorGrace(100, () => 0);
    g.clearIfRecovered(99);
    expect(g.pending).toBe(false);
  });

  it("a second record replaces the held error and resets the window", () => {
    let now = 0;
    const g = new SessionErrorGrace(100, () => now);
    g.record("first", 5);
    now = 50;
    g.record("second", 9);
    expect(g.error).toBe("second");
    expect(g.remainingMs()).toBe(100);
    // The clear must key off the second seq, not the first.
    g.clearIfRecovered(7);
    expect(g.pending).toBe(true);
    g.clearIfRecovered(10);
    expect(g.pending).toBe(false);
  });

  it("clear() drops the held error unconditionally and restores the full window", () => {
    let now = 1000;
    const g = new SessionErrorGrace(100, () => now);
    g.record("boom", 5);
    now = 1080;
    g.clear();
    expect(g.pending).toBe(false);
    expect(g.error).toBeUndefined();
    // remainingMs falls back to the full window once #errorAt is cleared, so a
    // continued response after auto-resume isn't bounded by the old timestamp.
    expect(g.remainingMs()).toBe(100);
  });
});
