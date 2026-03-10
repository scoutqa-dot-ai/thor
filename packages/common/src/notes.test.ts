import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Set WORKLOG_DIR before importing the module
const testDir = mkdtempSync(join(tmpdir(), "thor-notes-"));
process.env.WORKLOG_DIR = testDir;

const { readNotes, createNotes, appendTrigger, appendSummary, findNotesFile } =
  await import("./notes.js");

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
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});
