import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Set WORKLOG_DIR before importing the module
const testDir = mkdtempSync(join(tmpdir(), "thor-notes-"));
process.env.WORKLOG_DIR = testDir;

const {
  readNotes,
  createNotes,
  continueNotes,
  appendTrigger,
  appendSummary,
  findNotesFile,
  getSessionIdFromNotes,
} = await import("./notes.js");

describe("notes", () => {
  // Use a unique key per test to avoid collisions
  let keyCounter = 0;
  function uniqueKey(): string {
    return `test-key-${++keyCounter}`;
  }

  it("readNotes returns undefined when no notes exist", () => {
    expect(readNotes("nonexistent-key")).toBeUndefined();
  });

  it("findNotesFile returns undefined when no notes exist", () => {
    expect(findNotesFile("nonexistent-key")).toBeUndefined();
  });

  it("createNotes creates a markdown file with header", () => {
    const key = uniqueKey();
    createNotes({
      correlationKey: key,
      prompt: "List recent errors",
      model: "opencode/big-pickle",
      sessionId: "session-123",
    });

    const content = readNotes(key);
    expect(content).toBeDefined();
    expect(content).toContain(`# Session: ${key}`);
    expect(content).toContain("Session ID: session-123");
    expect(content).toContain("**Prompt**: List recent errors");
    expect(content).toContain("**Model**: opencode/big-pickle");
  });

  it("createNotes uses (default) when no model specified", () => {
    const key = uniqueKey();
    createNotes({
      correlationKey: key,
      prompt: "test",
      sessionId: "session-456",
    });

    const content = readNotes(key);
    expect(content).toContain("**Model**: (default)");
  });

  it("findNotesFile locates the created file", () => {
    const key = uniqueKey();
    createNotes({
      correlationKey: key,
      prompt: "test",
      sessionId: "session-789",
    });

    const path = findNotesFile(key);
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
  });

  it("appendTrigger adds a follow-up entry", () => {
    const key = uniqueKey();
    createNotes({
      correlationKey: key,
      prompt: "First prompt",
      sessionId: "session-aaa",
    });

    appendTrigger({
      correlationKey: key,
      prompt: "Follow-up prompt",
      model: "opencode/big-pickle",
    });

    const content = readNotes(key)!;
    expect(content).toContain("## Follow-up");
    expect(content).toContain("**Prompt**: Follow-up prompt");
    // Original content should still be there
    expect(content).toContain("**Prompt**: First prompt");
  });

  it("appendTrigger is a no-op when notes file does not exist", () => {
    // Should not throw
    appendTrigger({
      correlationKey: "ghost-key",
      prompt: "nobody home",
    });
    expect(readNotes("ghost-key")).toBeUndefined();
  });

  it("appendSummary adds a result block", () => {
    const key = uniqueKey();
    createNotes({
      correlationKey: key,
      prompt: "Check errors",
      sessionId: "session-bbb",
    });

    appendSummary({
      correlationKey: key,
      status: "completed",
      durationMs: 5432,
      toolCalls: [
        { tool: "posthog__list-errors", state: "completed" },
        { tool: "linear__list_issues", state: "completed" },
      ],
      responsePreview: "Found 3 critical errors in the auth module.",
    });

    const content = readNotes(key)!;
    expect(content).toContain("## Result");
    expect(content).toContain("**Status**: completed");
    expect(content).toContain("**Duration**: 5.4s");
    expect(content).toContain("**Tool calls**: 2");
    expect(content).toContain("posthog__list-errors");
    expect(content).toContain("linear__list_issues");
    expect(content).toContain("**Key findings**: Found 3 critical errors");
  });

  it("appendSummary includes error when present", () => {
    const key = uniqueKey();
    createNotes({
      correlationKey: key,
      prompt: "test",
      sessionId: "session-ccc",
    });

    appendSummary({
      correlationKey: key,
      status: "error",
      durationMs: 1000,
      toolCalls: [],
      error: "Connection refused",
    });

    const content = readNotes(key)!;
    expect(content).toContain("**Status**: error");
    expect(content).toContain("**Error**: Connection refused");
  });

  it("appendSummary truncates long response previews", () => {
    const key = uniqueKey();
    createNotes({
      correlationKey: key,
      prompt: "test",
      sessionId: "session-ddd",
    });

    const longResponse = "A".repeat(500);
    appendSummary({
      correlationKey: key,
      status: "completed",
      durationMs: 1000,
      toolCalls: [],
      responsePreview: longResponse,
    });

    const content = readNotes(key)!;
    expect(content).toContain("...");
    // Should not contain the full 500-char string
    expect(content).not.toContain("A".repeat(500));
  });

  it("full lifecycle: create → trigger → summary → read", () => {
    const key = uniqueKey();

    createNotes({
      correlationKey: key,
      prompt: "Check PostHog errors",
      model: "opencode/big-pickle",
      sessionId: "session-lifecycle",
    });

    appendSummary({
      correlationKey: key,
      status: "completed",
      durationMs: 3000,
      toolCalls: [{ tool: "posthog__list-errors", state: "completed" }],
      responsePreview: "Found spike in auth errors.",
    });

    appendTrigger({
      correlationKey: key,
      prompt: "Find related Linear issues",
    });

    appendSummary({
      correlationKey: key,
      status: "completed",
      durationMs: 2000,
      toolCalls: [{ tool: "linear__list_issues", state: "completed" }],
      responsePreview: "Found ACME-123 related to auth.",
    });

    const content = readNotes(key)!;

    // Verify ordering: header → first summary → follow-up → second summary
    const headerIdx = content.indexOf("# Session:");
    const firstResult = content.indexOf("## Result");
    const followUp = content.indexOf("## Follow-up");
    const secondResult = content.indexOf("## Result", firstResult + 1);

    expect(headerIdx).toBeLessThan(firstResult);
    expect(firstResult).toBeLessThan(followUp);
    expect(followUp).toBeLessThan(secondResult);

    // Both tool names present
    expect(content).toContain("posthog__list-errors");
    expect(content).toContain("linear__list_issues");
  });

  it("getSessionIdFromNotes returns session ID from notes file", () => {
    const key = uniqueKey();
    createNotes({
      correlationKey: key,
      prompt: "test",
      sessionId: "session-lookup-123",
    });

    expect(getSessionIdFromNotes(key)).toBe("session-lookup-123");
  });

  it("getSessionIdFromNotes returns undefined for unknown key", () => {
    expect(getSessionIdFromNotes("nonexistent-key-xyz")).toBeUndefined();
  });

  it("getSessionIdFromNotes returns undefined when notes file has no Session ID line", () => {
    const key = uniqueKey();
    // Create notes file, then overwrite it with content missing the Session ID header
    createNotes({ correlationKey: key, prompt: "test", sessionId: "will-be-removed" });
    const path = findNotesFile(key)!;
    writeFileSync(path, "# Session: test\nNo session ID here\n");

    expect(getSessionIdFromNotes(key)).toBeUndefined();
  });

  it("getSessionIdFromNotes returns latest session ID after overwrite", () => {
    const key = uniqueKey();
    createNotes({
      correlationKey: key,
      prompt: "first",
      sessionId: "session-old",
    });

    // Overwrite with new notes (same day, same key → overwrites)
    createNotes({
      correlationKey: key,
      prompt: "second",
      sessionId: "session-new",
    });

    expect(getSessionIdFromNotes(key)).toBe("session-new");
  });

  it("sanitizes correlation keys with special characters", () => {
    const key = "slack:thread:123.456";
    createNotes({
      correlationKey: key,
      prompt: "test",
      sessionId: "session-sanitize",
    });

    const path = findNotesFile(key);
    expect(path).toBeDefined();
    // Filename should not contain colons or dots
    expect(path!).not.toMatch(/:[^/\\]/);
    expect(readNotes(key)).toContain("# Session: slack:thread:123.456");
  });

  describe("cross-day continuation", () => {
    // Helper to create a notes file in a specific date directory (simulating a previous day)
    function createNotesOnDay(day: string, key: string, sessionId: string): string {
      const sanitized = key.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
      const dir = join(testDir, day, "notes");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${sanitized}.md`);
      writeFileSync(
        path,
        `# Session: ${key}\nCreated: ${day}T00:00:00Z\nSession ID: ${sessionId}\n\n## Trigger\n**Prompt**: original\n`,
      );
      return path;
    }

    it("continueNotes creates today's file with back-reference", () => {
      const key = "cross-day-continue-1";
      const prevPath = createNotesOnDay("2026-01-01", key, "session-old");

      continueNotes({
        correlationKey: key,
        sessionId: "session-old",
        prompt: "Follow up next day",
        previousNotesPath: prevPath,
      });

      // findNotesFile should return today's file (most recent)
      const todayPath = findNotesFile(key)!;
      expect(todayPath).toBeDefined();
      expect(todayPath).not.toBe(prevPath);

      const content = readFileSync(todayPath, "utf-8");
      expect(content).toContain("(continued)");
      expect(content).toContain("Session ID: session-old");
      expect(content).toContain("Previous:");
      expect(content).toContain("Follow up next day");
    });

    it("continueNotes is a no-op if today's file already exists", () => {
      const key = "cross-day-noop";
      const prevPath = createNotesOnDay("2026-01-02", key, "session-first");

      continueNotes({
        correlationKey: key,
        sessionId: "session-first",
        prompt: "first continue",
        previousNotesPath: prevPath,
      });

      const todayPath = findNotesFile(key)!;
      const contentBefore = readFileSync(todayPath, "utf-8");

      // Second call should be a no-op
      continueNotes({
        correlationKey: key,
        sessionId: "session-first",
        prompt: "duplicate continue",
        previousNotesPath: prevPath,
      });

      const contentAfter = readFileSync(todayPath, "utf-8");
      expect(contentAfter).toBe(contentBefore);
    });

    it("old notes file is not modified after continueNotes", () => {
      const key = "cross-day-frozen";
      const prevPath = createNotesOnDay("2026-01-03", key, "session-frozen");
      const originalContent = readFileSync(prevPath, "utf-8");

      continueNotes({
        correlationKey: key,
        sessionId: "session-frozen",
        prompt: "continue next day",
        previousNotesPath: prevPath,
      });

      // Old file should be unchanged
      expect(readFileSync(prevPath, "utf-8")).toBe(originalContent);
    });

    it("appendTrigger writes to today's file, not previous day's", () => {
      const key = "cross-day-append";
      const prevPath = createNotesOnDay("2026-01-04", key, "session-append");
      const originalContent = readFileSync(prevPath, "utf-8");

      continueNotes({
        correlationKey: key,
        sessionId: "session-append",
        prompt: "continued",
        previousNotesPath: prevPath,
      });

      appendTrigger({ correlationKey: key, prompt: "another follow-up" });

      // Old file untouched
      expect(readFileSync(prevPath, "utf-8")).toBe(originalContent);

      // Today's file has the follow-up
      const todayContent = readFileSync(findNotesFile(key)!, "utf-8");
      expect(todayContent).toContain("another follow-up");
    });

    it("appendSummary writes to today's file, not previous day's", () => {
      const key = "cross-day-summary";
      const prevPath = createNotesOnDay("2026-01-05", key, "session-summary");
      const originalContent = readFileSync(prevPath, "utf-8");

      continueNotes({
        correlationKey: key,
        sessionId: "session-summary",
        prompt: "continued",
        previousNotesPath: prevPath,
      });

      appendSummary({
        correlationKey: key,
        status: "completed",
        durationMs: 1234,
        toolCalls: [{ tool: "test-tool", state: "completed" }],
      });

      // Old file untouched
      expect(readFileSync(prevPath, "utf-8")).toBe(originalContent);

      // Today's file has the summary
      const todayContent = readFileSync(findNotesFile(key)!, "utf-8");
      expect(todayContent).toContain("## Result");
      expect(todayContent).toContain("test-tool");
    });

    it("getSessionIdFromNotes finds session from continued file", () => {
      const key = "cross-day-lookup";
      const prevPath = createNotesOnDay("2026-01-06", key, "session-original");

      continueNotes({
        correlationKey: key,
        sessionId: "session-original",
        prompt: "continued",
        previousNotesPath: prevPath,
      });

      // Should find today's (most recent) session ID
      expect(getSessionIdFromNotes(key)).toBe("session-original");
    });
  });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});
