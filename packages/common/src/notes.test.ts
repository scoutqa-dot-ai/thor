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
  registerAlias,
  resolveCorrelationKeys,
  isAliasableTool,
  isAliasableGitCommand,
  isAliasableMcpTool,
  extractAliases,
  getNotesLineCount,
  hasSlackReply,
  ThorMetaSchema,
  computeGitAlias,
  computeSlackAlias,
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
        { tool: "atlassian__list_issues", state: "completed" },
      ],
      responsePreview: "Found 3 critical errors in the auth module.",
    });

    const content = readNotes(key)!;
    expect(content).toContain("## Result");
    expect(content).toContain("**Status**: completed");
    expect(content).toContain("**Duration**: 5.4s");
    expect(content).toContain("**Tool calls**: 2");
    expect(content).toContain("posthog__list-errors");
    expect(content).toContain("atlassian__list_issues");
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
    expect(content).toContain("…");
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
      prompt: "Find related Atlassian issues",
    });

    appendSummary({
      correlationKey: key,
      status: "completed",
      durationMs: 2000,
      toolCalls: [{ tool: "atlassian__list_issues", state: "completed" }],
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
    expect(content).toContain("atlassian__list_issues");
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

  describe("correlation key aliasing", () => {
    it("registerAlias appends h3 alias block to notes file", () => {
      const key = uniqueKey();
      createNotes({ correlationKey: key, prompt: "test", sessionId: "session-alias-1" });

      registerAlias({
        correlationKey: key,
        alias: "slack:thread:999.000",
        context: "Bot posted to #general",
      });

      const content = readNotes(key)!;
      expect(content).toContain("### Session: slack:thread:999.000");
      expect(content).toContain("Bot posted to #general");
    });

    it("registerAlias uses default context when none provided", () => {
      const key = uniqueKey();
      createNotes({ correlationKey: key, prompt: "test", sessionId: "session-alias-2" });

      registerAlias({ correlationKey: key, alias: "git:branch:org/repo:feat-x" });

      const content = readNotes(key)!;
      expect(content).toContain("### Session: git:branch:org/repo:feat-x");
      expect(content).toContain(`Alias for ${key}`);
    });

    it("registerAlias skips self-alias (key === alias)", () => {
      const key = uniqueKey();
      createNotes({ correlationKey: key, prompt: "test", sessionId: "session-self" });

      registerAlias({ correlationKey: key, alias: key, context: "should not appear" });

      const content = readNotes(key)!;
      expect(content).not.toContain("### Session:");
    });

    it("registerAlias is a no-op when notes file does not exist", () => {
      registerAlias({
        correlationKey: "ghost-alias-key",
        alias: "slack:thread:000.000",
      });
      expect(readNotes("ghost-alias-key")).toBeUndefined();
    });

    it("multiple aliases can be registered on the same notes file", () => {
      const key = uniqueKey();
      createNotes({ correlationKey: key, prompt: "test", sessionId: "session-multi" });

      registerAlias({ correlationKey: key, alias: "slack:thread:111.000" });
      registerAlias({ correlationKey: key, alias: "git:branch:org/repo:fix-bug" });
      registerAlias({ correlationKey: key, alias: "github:pr:org/repo:42" });

      const content = readNotes(key)!;
      expect(content).toContain("### Session: slack:thread:111.000");
      expect(content).toContain("### Session: git:branch:org/repo:fix-bug");
      expect(content).toContain("### Session: github:pr:org/repo:42");
    });

    it("resolveCorrelationKeys returns canonical key for an aliased key", () => {
      const canonical = "cron:daily-check:2026-03-13T06";
      createNotes({ correlationKey: canonical, prompt: "test", sessionId: "session-resolve-1" });
      registerAlias({ correlationKey: canonical, alias: "slack:thread:222.000" });

      expect(resolveCorrelationKeys(["slack:thread:222.000"])).toBe(canonical);
    });

    it("resolveCorrelationKeys returns canonical key when queried with canonical key", () => {
      const canonical = uniqueKey();
      createNotes({ correlationKey: canonical, prompt: "test", sessionId: "session-resolve-2" });

      expect(resolveCorrelationKeys([canonical])).toBe(canonical);
    });

    it("resolveCorrelationKeys returns raw key unchanged when no match found", () => {
      expect(resolveCorrelationKeys(["unknown:key:xyz"])).toBe("unknown:key:xyz");
    });

    it("resolveCorrelationKeys returns canonical key for continued files", () => {
      const canonical = "resolve-continued";
      // Create old day file with alias
      const sanitized = canonical.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
      const dir = join(testDir, "2026-02-01", "notes");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${sanitized}.md`);
      writeFileSync(
        path,
        `# Session: ${canonical}\nSession ID: sess-old\n\n---\n### Session: slack:thread:333.000\nAliased from old day\n`,
      );

      // Alias from old day should still resolve
      expect(resolveCorrelationKeys(["slack:thread:333.000"])).toBe(canonical);
    });

    it("resolveCorrelationKeys finds alias even when canonical file also exists for the raw key", () => {
      // Scenario: git push → session A, then Slack review → session B aliases the branch key
      const oldCanonical = "git:branch:org/repo:feat-y";
      const newCanonical = "slack:thread:444.000";

      createNotes({ correlationKey: oldCanonical, prompt: "old", sessionId: "session-old" });
      createNotes({ correlationKey: newCanonical, prompt: "new", sessionId: "session-new" });
      registerAlias({ correlationKey: newCanonical, alias: oldCanonical });

      // Should resolve to the NEWER session that claimed this key via alias
      const resolved = resolveCorrelationKeys([oldCanonical]);
      expect(resolved).toBe(newCanonical);
    });

    it("resolveCorrelationKeys picks most recent file when alias exists across multiple days", () => {
      const oldCanonical = "resolve-multi-day-old";
      const newCanonical = "resolve-multi-day-new";
      const alias = "slack:thread:multi-day-555.000";

      // Day 1: old session registers alias
      const oldSanitized = oldCanonical.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
      const oldDir = join(testDir, "2026-01-20", "notes");
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(
        join(oldDir, `${oldSanitized}.md`),
        `# Session: ${oldCanonical}\nSession ID: sess-old\n\n---\n### Session: ${alias}\nOld alias\n`,
      );

      // Day 2: new session registers the same alias
      const newSanitized = newCanonical.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
      const newDir = join(testDir, "2026-01-21", "notes");
      mkdirSync(newDir, { recursive: true });
      writeFileSync(
        join(newDir, `${newSanitized}.md`),
        `# Session: ${newCanonical}\nSession ID: sess-new\n\n---\n### Session: ${alias}\nNew alias\n`,
      );

      // Should resolve to the NEWER session (day 2), not the older one
      expect(resolveCorrelationKeys([alias])).toBe(newCanonical);
    });

    it("resolveCorrelationKeys checks h1 canonical keys, not just h3 aliases", () => {
      const key = uniqueKey();
      createNotes({ correlationKey: key, prompt: "test", sessionId: "session-h1-check" });

      // Should resolve to itself via h1 match (not just return rawKey as fallback)
      expect(resolveCorrelationKeys([key])).toBe(key);
    });
  });

  describe("getNotesLineCount", () => {
    it("returns line count for existing notes file", () => {
      const key = uniqueKey();
      createNotes({
        correlationKey: key,
        prompt: "test",
        sessionId: "session-lines",
      });

      const path = findNotesFile(key)!;
      const count = getNotesLineCount(path);
      expect(count).toBeGreaterThan(0);

      // Verify it matches actual line count
      const content = readFileSync(path, "utf-8");
      expect(count).toBe(content.split("\n").length);
    });

    it("returns 0 for non-existent file", () => {
      expect(getNotesLineCount("/nonexistent/path.md")).toBe(0);
    });
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

    it("alias registered on previous day resolves after continueNotes", () => {
      const canonical = "cross-day-alias-resolve";
      const aliasKey = "slack:thread:cross-day-555.000";

      // Day N: create notes + register alias
      const sanitized = canonical.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
      const oldDir = join(testDir, "2026-01-10", "notes");
      mkdirSync(oldDir, { recursive: true });
      const oldPath = join(oldDir, `${sanitized}.md`);
      writeFileSync(
        oldPath,
        `# Session: ${canonical}\nSession ID: sess-cross\n\n---\n### Session: ${aliasKey}\nAliased on day N\n`,
      );

      // Day N+1 (today): continueNotes creates today's file
      continueNotes({
        correlationKey: canonical,
        sessionId: "sess-cross",
        prompt: "follow up next day",
        previousNotesPath: oldPath,
      });

      // Alias from old day should still resolve to canonical key
      expect(resolveCorrelationKeys([aliasKey])).toBe(canonical);

      // Old file should be untouched
      expect(readFileSync(oldPath, "utf-8")).toContain(`### Session: ${aliasKey}`);
    });
  });
});

describe("alias extraction", () => {
  describe("isAliasableTool", () => {
    it("returns true for aliasable tools", () => {
      expect(isAliasableTool("slack_post_message")).toBe(true);
      expect(isAliasableTool("bash")).toBe(true);
    });

    it("returns false for non-aliasable tools", () => {
      expect(isAliasableTool("post_message")).toBe(false);
      expect(isAliasableTool("git")).toBe(false);
      expect(isAliasableTool("create_pull_request")).toBe(false);
      expect(isAliasableTool("read_channel")).toBe(false);
      expect(isAliasableTool("list_issues")).toBe(false);
    });
  });

  describe("extractAliases", () => {
    it("extracts slack thread alias from slack_post_message (new thread)", () => {
      const aliases = extractAliases([
        {
          tool: "slack_post_message",
          input: { channel: "C999XYZ", text: "Health report" },
          output: JSON.stringify({ ok: true, ts: "1710099999.456", channel: "C999XYZ" }),
        },
      ]);

      expect(aliases).toEqual([
        { alias: "slack:thread:1710099999.456", context: "New thread posted to C999XYZ" },
      ]);
    });

    it("aliases thread_ts for slack_post_message replies", () => {
      const aliases = extractAliases([
        {
          tool: "slack_post_message",
          input: { channel: "C999XYZ", text: "Follow up", thread_ts: "1710099999.456" },
          output: JSON.stringify({ ok: true, ts: "1710099999.789", channel: "C999XYZ" }),
        },
      ]);

      expect(aliases).toEqual([
        { alias: "slack:thread:1710099999.456", context: "Replied in thread in C999XYZ" },
      ]);
    });

    it("handles multiple artifacts in a single call", () => {
      const pushMeta = JSON.stringify({
        type: "alias",
        alias: "git:branch:org-repo:fix/bug",
        context: "git push in /workspace/repos/org-repo",
      });
      const aliases = extractAliases([
        {
          tool: "slack_post_message",
          input: { channel: "C001", text: "Starting" },
          output: JSON.stringify({ ok: true, ts: "111.000", channel: "C001" }),
        },
        {
          tool: "bash",
          input: { command: "git push origin fix/bug" },
          output: `(no output)\n[thor:meta] ${pushMeta}\n`,
        },
      ]);

      expect(aliases).toHaveLength(2);
      expect(aliases[0].alias).toBe("slack:thread:111.000");
      expect(aliases[1].alias).toBe("git:branch:org-repo:fix/bug");
    });

    it("skips malformed output gracefully", () => {
      const aliases = extractAliases([
        {
          tool: "slack_post_message",
          input: { channel: "C001", text: "Hello" },
          output: "not json at all",
        },
        {
          tool: "bash",
          input: { command: "git push origin main" },
          output: "error: something went wrong",
        },
      ]);

      // slack_post_message: JSON.parse fails → skipped
      // bash: no [thor:meta] → skipped
      expect(aliases).toEqual([]);
    });

    it("extracts alias from bash tool with [thor:meta]", () => {
      const meta = JSON.stringify({
        type: "alias",
        alias: "git:branch:acme-project:feat/login-fix",
        context: "git push in /workspace/repos/acme-project",
      });
      const aliases = extractAliases([
        {
          tool: "bash",
          input: { command: "git push origin feat/login-fix" },
          output: `Everything up-to-date\n[thor:meta] ${meta}\n`,
        },
      ]);

      expect(aliases).toEqual([
        {
          alias: "git:branch:acme-project:feat/login-fix",
          context: "git push in /workspace/repos/acme-project",
        },
      ]);
    });

    it("extracts multiple [thor:meta] entries from single bash output", () => {
      const meta1 = JSON.stringify({
        type: "alias",
        alias: "git:branch:repo:feat/a",
        context: "git push in /workspace/repos/repo",
      });
      const meta2 = JSON.stringify({
        type: "alias",
        alias: "git:branch:repo:feat/b",
        context: "git checkout in /workspace/repos/repo",
      });
      const aliases = extractAliases([
        {
          tool: "bash",
          input: { command: "some compound command" },
          output: `output\n[thor:meta] ${meta1}\nmore\n[thor:meta] ${meta2}\n`,
        },
      ]);

      expect(aliases).toHaveLength(2);
      expect(aliases[0].alias).toBe("git:branch:repo:feat/a");
      expect(aliases[1].alias).toBe("git:branch:repo:feat/b");
    });

    it("extracts slack thread alias from bash tool with [thor:meta]", () => {
      const meta = JSON.stringify({
        type: "alias",
        alias: "slack:thread:1712345678.123",
        context: "New thread posted to C123",
      });
      const aliases = extractAliases([
        {
          tool: "bash",
          input: { command: "mcp slack post_message ..." },
          output: `posted\n[thor:meta] ${meta}\n`,
        },
      ]);

      expect(aliases).toEqual([
        {
          alias: "slack:thread:1712345678.123",
          context: "New thread posted to C123",
        },
      ]);
    });

    it("skips bash tool output without [thor:meta]", () => {
      const aliases = extractAliases([
        {
          tool: "bash",
          input: { command: "ls -la" },
          output: "total 42\ndrwxr-xr-x ...",
        },
      ]);

      expect(aliases).toEqual([]);
    });

    it("skips malformed [thor:meta] in bash output", () => {
      const aliases = extractAliases([
        {
          tool: "bash",
          input: { command: "git push origin main" },
          output: "Everything up-to-date\n[thor:meta] not-json\n",
        },
      ]);

      expect(aliases).toEqual([]);
    });

    it("skips [thor:meta] missing required fields", () => {
      // Missing "type" discriminant → rejected by schema
      const meta = JSON.stringify({ alias: "git:branch:repo:main", context: "git push" });
      const aliases = extractAliases([
        {
          tool: "bash",
          input: { command: "git push origin main" },
          output: `ok\n[thor:meta] ${meta}\n`,
        },
      ]);

      expect(aliases).toEqual([]);
    });

    it("skips approval meta (not an alias)", () => {
      const meta = JSON.stringify({
        type: "approval",
        actionId: "550e8400-e29b-41d4-a716-446655440000",
        proxyName: "atlassian",
        tool: "createJiraIssue",
      });
      const aliases = extractAliases([
        {
          tool: "bash",
          input: { command: "mcp atlassian createJiraIssue ..." },
          output: `Approval required\n[thor:meta] ${meta}\n`,
        },
      ]);

      // approval meta is not an alias → skipped by extractAliases
      expect(aliases).toEqual([]);
    });
  });
});

describe("hasSlackReply", () => {
  let keyCounter = 100;
  function uniqueKey(): string {
    return `slack-reply-key-${++keyCounter}`;
  }

  it("returns false when no notes exist", () => {
    expect(hasSlackReply("nonexistent-key")).toBe(false);
  });

  it("returns false when notes exist but no slack_post_message tool call", () => {
    const key = uniqueKey();
    createNotes({ correlationKey: key, prompt: "test", sessionId: "s1" });
    appendSummary({
      correlationKey: key,
      status: "completed",
      durationMs: 1000,
      toolCalls: [{ tool: "bash", state: "completed" }],
    });
    expect(hasSlackReply(key)).toBe(false);
  });

  it("returns true when a slack:thread alias is registered", () => {
    const key = uniqueKey();
    createNotes({ correlationKey: key, prompt: "test", sessionId: "s2" });
    registerAlias({
      correlationKey: key,
      alias: "slack:thread:1712345678.123",
      context: "New thread posted to C123",
    });
    expect(hasSlackReply(key)).toBe(true);
  });

  it("returns true when slack:thread alias is registered after multiple sessions", () => {
    const key = uniqueKey();
    createNotes({ correlationKey: key, prompt: "test", sessionId: "s3" });
    // First session: no slack reply
    appendSummary({
      correlationKey: key,
      status: "completed",
      durationMs: 1000,
      toolCalls: [{ tool: "bash", state: "completed" }],
    });
    // Follow-up: Thor replies in Slack
    appendTrigger({ correlationKey: key, prompt: "follow up" });
    registerAlias({
      correlationKey: key,
      alias: "slack:thread:1712345678.456",
      context: "Replied in thread in C456",
    });
    expect(hasSlackReply(key)).toBe(true);
  });
});

describe("ThorMetaSchema", () => {
  it("validates alias meta", () => {
    const meta = {
      type: "alias",
      alias: "git:branch:acme:main",
      context: "git push in /workspace/repos/acme",
    };
    const result = ThorMetaSchema.safeParse(meta);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(meta);
  });

  it("validates approval meta", () => {
    const meta = {
      type: "approval",
      actionId: "550e8400-e29b-41d4-a716-446655440000",
      proxyName: "atlassian",
      tool: "createJiraIssue",
    };
    const result = ThorMetaSchema.safeParse(meta);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(meta);
  });

  it("rejects unknown type", () => {
    expect(ThorMetaSchema.safeParse({ type: "unknown", foo: "bar" }).success).toBe(false);
  });

  it("rejects missing type discriminant", () => {
    expect(
      ThorMetaSchema.safeParse({ alias: "git:branch:repo:main", context: "test" }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(ThorMetaSchema.safeParse({}).success).toBe(false);
  });
});

describe("computeGitAlias", () => {
  it("computes alias for git push", () => {
    const result = computeGitAlias(
      "git",
      ["push", "origin", "feat/login"],
      "/workspace/repos/acme",
    );
    expect(result).toEqual({
      type: "alias",
      alias: "git:branch:acme:feat/login",
      context: "git push in /workspace/repos/acme",
    });
  });

  it("computes alias for git checkout -b", () => {
    const result = computeGitAlias(
      "git",
      ["checkout", "-b", "feat/new"],
      "/workspace/repos/org-repo",
    );
    expect(result).toEqual({
      type: "alias",
      alias: "git:branch:org-repo:feat/new",
      context: "git checkout in /workspace/repos/org-repo",
    });
  });

  it("computes alias for git push with HEAD:refs/heads/ syntax", () => {
    const result = computeGitAlias(
      "git",
      ["push", "origin", "HEAD:refs/heads/feat/new"],
      "/workspace/repos/acme",
    );
    expect(result).toEqual({
      type: "alias",
      alias: "git:branch:acme:feat/new",
      context: "git push in /workspace/repos/acme",
    });
  });

  it("computes alias for worktree cwd path", () => {
    const result = computeGitAlias(
      "git",
      ["push", "-u", "origin", "feat-admin"],
      "/workspace/worktrees/acme-app/feat-admin",
    );
    expect(result).toEqual({
      type: "alias",
      alias: "git:branch:acme-app:feat-admin",
      context: "git push in /workspace/worktrees/acme-app/feat-admin",
    });
  });

  it("computes alias for worktree add -b", () => {
    const result = computeGitAlias(
      "git",
      ["worktree", "add", "-b", "chore/remove", "../worktrees/repo/chore"],
      "/workspace/repos/katalon-scout",
    );
    expect(result).toEqual({
      type: "alias",
      alias: "git:branch:katalon-scout:chore/remove",
      context: "git worktree in /workspace/repos/katalon-scout",
    });
  });

  it("returns undefined for non-aliasable commands", () => {
    expect(computeGitAlias("git", ["status"], "/workspace/repos/acme")).toBeUndefined();
    expect(computeGitAlias("git", ["log"], "/workspace/repos/acme")).toBeUndefined();
    expect(computeGitAlias("git", ["diff"], "/workspace/repos/acme")).toBeUndefined();
  });

  it("returns undefined when branch cannot be extracted", () => {
    expect(
      computeGitAlias("gh", ["pr", "create", "--head", "feat/new"], "/workspace/repos/acme"),
    ).toBeUndefined();
  });

  it("returns undefined when cwd is not a workspace path", () => {
    expect(computeGitAlias("git", ["push", "origin", "main"], "/home/user/repo")).toBeUndefined();
  });
});

describe("computeSlackAlias", () => {
  it("computes alias for new thread", () => {
    const result = computeSlackAlias(
      { channel: "C123", text: "hi" },
      JSON.stringify({ ok: true, ts: "1712345678.123", channel: "C123" }),
    );
    expect(result).toEqual({
      type: "alias",
      alias: "slack:thread:1712345678.123",
      context: "New thread posted to C123",
    });
  });

  it("computes alias for reply (thread_ts present)", () => {
    const result = computeSlackAlias(
      { channel: "C123", text: "reply", thread_ts: "1712345678.000" },
      JSON.stringify({ ok: true, ts: "1712345678.999", channel: "C123" }),
    );
    expect(result).toEqual({
      type: "alias",
      alias: "slack:thread:1712345678.000",
      context: "Replied in thread in C123",
    });
  });

  it("returns undefined for malformed result", () => {
    expect(computeSlackAlias({ channel: "C123" }, "not json")).toBeUndefined();
  });

  it("returns undefined for missing ts in result", () => {
    expect(computeSlackAlias({ channel: "C123" }, JSON.stringify({ ok: true }))).toBeUndefined();
  });
});

describe("isAliasableGitCommand", () => {
  it("returns true for push", () =>
    expect(isAliasableGitCommand(["push", "origin", "main"])).toBe(true));
  it("returns true for checkout", () =>
    expect(isAliasableGitCommand(["checkout", "-b", "feat"])).toBe(true));
  it("returns true for switch", () => expect(isAliasableGitCommand(["switch", "main"])).toBe(true));
  it("returns true for worktree", () =>
    expect(isAliasableGitCommand(["worktree", "add", "..."])).toBe(true));
  it("returns false for status", () => expect(isAliasableGitCommand(["status"])).toBe(false));
  it("returns false for log", () => expect(isAliasableGitCommand(["log"])).toBe(false));
  it("returns false for diff", () => expect(isAliasableGitCommand(["diff"])).toBe(false));
  it("returns false for empty args", () => expect(isAliasableGitCommand([])).toBe(false));
});

describe("isAliasableMcpTool", () => {
  it("returns true for post_message", () => expect(isAliasableMcpTool("post_message")).toBe(true));
  it("returns false for read_channel", () =>
    expect(isAliasableMcpTool("read_channel")).toBe(false));
  it("returns false for list_tools", () => expect(isAliasableMcpTool("list_tools")).toBe(false));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});
