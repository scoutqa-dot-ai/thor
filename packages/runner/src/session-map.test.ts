import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Set WORKLOG_DIR before importing the module so it uses our temp dir
const testDir = mkdtempSync(join(tmpdir(), "thor-session-map-"));
process.env.WORKLOG_DIR = testDir;

// Dynamic import after env is set
const { getSession, setSession, touchSession, removeSession, listSessions, clearSessions } =
  await import("./session-map.js");

describe("session-map", () => {
  beforeEach(() => {
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it("returns undefined for unknown key", () => {
    expect(getSession("nonexistent")).toBeUndefined();
  });

  it("stores and retrieves a session mapping", () => {
    setSession("slack:thread:123", "session-abc");

    const entry = getSession("slack:thread:123");
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBe("session-abc");
    expect(entry!.createdAt).toBeTruthy();
    expect(entry!.lastUsedAt).toBeTruthy();
  });

  it("updates sessionId for existing key", () => {
    setSession("key-1", "session-old");
    setSession("key-1", "session-new");

    const entry = getSession("key-1");
    expect(entry!.sessionId).toBe("session-new");
  });

  it("touchSession updates lastUsedAt without changing sessionId", async () => {
    setSession("key-1", "session-abc");
    const before = getSession("key-1")!.lastUsedAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));
    touchSession("key-1");

    const after = getSession("key-1")!;
    expect(after.sessionId).toBe("session-abc");
    expect(after.lastUsedAt >= before).toBe(true);
  });

  it("touchSession is a no-op for unknown key", () => {
    // Should not throw
    touchSession("nonexistent");
    expect(getSession("nonexistent")).toBeUndefined();
  });

  it("removes a session mapping", () => {
    setSession("key-1", "session-abc");
    expect(getSession("key-1")).toBeDefined();

    removeSession("key-1");
    expect(getSession("key-1")).toBeUndefined();
  });

  it("removeSession is a no-op for unknown key", () => {
    // Should not throw
    removeSession("nonexistent");
  });

  it("lists all session mappings", () => {
    setSession("key-1", "session-a");
    setSession("key-2", "session-b");
    setSession("key-3", "session-c");

    const all = listSessions();
    expect(Object.keys(all)).toHaveLength(3);
    expect(all["key-1"].sessionId).toBe("session-a");
    expect(all["key-2"].sessionId).toBe("session-b");
    expect(all["key-3"].sessionId).toBe("session-c");
  });

  it("listSessions returns a copy (not a reference)", () => {
    setSession("key-1", "session-a");
    const copy = listSessions();
    copy["key-1"].sessionId = "mutated";

    // Original should be unchanged
    expect(getSession("key-1")!.sessionId).toBe("session-a");
  });

  it("clearSessions removes all mappings", () => {
    setSession("key-1", "session-a");
    setSession("key-2", "session-b");

    clearSessions();

    expect(listSessions()).toEqual({});
    expect(getSession("key-1")).toBeUndefined();
  });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});
