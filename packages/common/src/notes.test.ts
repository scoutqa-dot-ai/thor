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
  resolveCorrelationKey,
  isAliasableTool,
  extractAliases,
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

    it("resolveCorrelationKey returns canonical key for an aliased key", () => {
      const canonical = "cron:daily-check:2026-03-13T06";
      createNotes({ correlationKey: canonical, prompt: "test", sessionId: "session-resolve-1" });
      registerAlias({ correlationKey: canonical, alias: "slack:thread:222.000" });

      expect(resolveCorrelationKey("slack:thread:222.000")).toBe(canonical);
    });

    it("resolveCorrelationKey returns canonical key when queried with canonical key", () => {
      const canonical = uniqueKey();
      createNotes({ correlationKey: canonical, prompt: "test", sessionId: "session-resolve-2" });

      expect(resolveCorrelationKey(canonical)).toBe(canonical);
    });

    it("resolveCorrelationKey returns raw key unchanged when no match found", () => {
      expect(resolveCorrelationKey("unknown:key:xyz")).toBe("unknown:key:xyz");
    });

    it("resolveCorrelationKey returns canonical key for continued files", () => {
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
      expect(resolveCorrelationKey("slack:thread:333.000")).toBe(canonical);
    });

    it("resolveCorrelationKey finds alias even when canonical file also exists for the raw key", () => {
      // Scenario: git push → session A, then Slack review → session B aliases the branch key
      const oldCanonical = "git:branch:org/repo:feat-y";
      const newCanonical = "slack:thread:444.000";

      createNotes({ correlationKey: oldCanonical, prompt: "old", sessionId: "session-old" });
      createNotes({ correlationKey: newCanonical, prompt: "new", sessionId: "session-new" });
      registerAlias({ correlationKey: newCanonical, alias: oldCanonical });

      // Should resolve to the NEWER session that claimed this key via alias
      const resolved = resolveCorrelationKey(oldCanonical);
      expect(resolved).toBe(newCanonical);
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
      expect(resolveCorrelationKey(aliasKey)).toBe(canonical);

      // Old file should be untouched
      expect(readFileSync(oldPath, "utf-8")).toContain(`### Session: ${aliasKey}`);
    });
  });
});

describe("alias extraction", () => {
  describe("isAliasableTool", () => {
    it("returns true for aliasable tools", () => {
      expect(isAliasableTool("post_message")).toBe(true);
      expect(isAliasableTool("git")).toBe(true);
    });

    it("returns false for non-aliasable tools", () => {
      expect(isAliasableTool("create_pull_request")).toBe(false);
      expect(isAliasableTool("read_channel")).toBe(false);
      expect(isAliasableTool("list_issues")).toBe(false);
    });
  });

  describe("extractAliases", () => {
    it("extracts slack thread alias from post_message (new thread)", () => {
      const aliases = extractAliases([
        {
          tool: "post_message",
          input: { channel: "C123ABC", text: "Hello" },
          output: JSON.stringify({ ok: true, ts: "1710000000.123", channel: "C123ABC" }),
        },
      ]);

      expect(aliases).toEqual([
        { alias: "slack:thread:1710000000.123", context: "New thread posted to C123ABC" },
      ]);
    });

    it("aliases thread_ts for post_message replies", () => {
      const aliases = extractAliases([
        {
          tool: "post_message",
          input: { channel: "C123ABC", text: "Reply", thread_ts: "1710000000.100" },
          output: JSON.stringify({ ok: true, ts: "1710000000.200", channel: "C123ABC" }),
        },
      ]);

      expect(aliases).toEqual([
        { alias: "slack:thread:1710000000.100", context: "Replied in thread in C123ABC" },
      ]);
    });

    it("extracts git branch alias from git push", () => {
      const aliases = extractAliases([
        {
          tool: "git",
          input: {
            args: ["push", "origin", "feat/login-fix"],
            cwd: "/workspace/repos/acme-project",
          },
          output: "(no output)",
        },
      ]);

      expect(aliases).toEqual([
        {
          alias: "git:branch:acme/project:feat/login-fix",
          context: "git push in /workspace/repos/acme-project",
        },
      ]);
    });

    it("extracts git branch alias from checkout", () => {
      const aliases = extractAliases([
        {
          tool: "git",
          input: {
            args: ["checkout", "feat/review"],
            cwd: "/workspace/repos/acme-project",
          },
          output: "Switched to branch 'feat/review'",
        },
      ]);

      expect(aliases).toEqual([
        {
          alias: "git:branch:acme/project:feat/review",
          context: "git checkout in /workspace/repos/acme-project",
        },
      ]);
    });

    it("extracts git branch alias from checkout -b", () => {
      const aliases = extractAliases([
        {
          tool: "git",
          input: { args: ["checkout", "-b", "feat/new"], cwd: "/workspace/repos/org-repo" },
          output: "Switched to new branch 'feat/new'",
        },
      ]);

      expect(aliases).toEqual([
        {
          alias: "git:branch:org/repo:feat/new",
          context: "git checkout in /workspace/repos/org-repo",
        },
      ]);
    });

    it("extracts git branch alias from switch", () => {
      const aliases = extractAliases([
        {
          tool: "git",
          input: { args: ["switch", "feat/login"], cwd: "/workspace/repos/acme-project" },
          output: "Switched to branch 'feat/login'",
        },
      ]);

      expect(aliases).toEqual([
        {
          alias: "git:branch:acme/project:feat/login",
          context: "git switch in /workspace/repos/acme-project",
        },
      ]);
    });

    it("strips origin/ prefix from checkout of remote branch", () => {
      const aliases = extractAliases([
        {
          tool: "git",
          input: { args: ["checkout", "origin/feat/review"], cwd: "/workspace/repos/org-repo" },
          output: "HEAD is now at abc123",
        },
      ]);

      expect(aliases).toEqual([
        {
          alias: "git:branch:org/repo:feat/review",
          context: "git checkout in /workspace/repos/org-repo",
        },
      ]);
    });

    it("skips git commands that don't involve branches", () => {
      const aliases = extractAliases([
        {
          tool: "git",
          input: { args: ["log", "--oneline", "-5"], cwd: "/workspace/repos/org-repo" },
          output: "abc123 some commit",
        },
      ]);

      expect(aliases).toEqual([]);
    });

    it("handles multiple artifacts in a single call", () => {
      const aliases = extractAliases([
        {
          tool: "post_message",
          input: { channel: "C001", text: "Starting" },
          output: JSON.stringify({ ok: true, ts: "111.000", channel: "C001" }),
        },
        {
          tool: "git",
          input: { args: ["push", "origin", "fix/bug"], cwd: "/workspace/repos/org-repo" },
          output: "(no output)",
        },
      ]);

      expect(aliases).toHaveLength(2);
      expect(aliases[0].alias).toBe("slack:thread:111.000");
      expect(aliases[1].alias).toBe("git:branch:org/repo:fix/bug");
    });

    it("skips malformed output gracefully", () => {
      const aliases = extractAliases([
        {
          tool: "post_message",
          input: { channel: "C001", text: "Hello" },
          output: "not json at all",
        },
        {
          tool: "git",
          input: { args: ["push", "origin", "main"] },
          output: "error: something went wrong",
        },
      ]);

      // post_message: JSON.parse fails → skipped
      // git: no cwd → no repo → skipped
      expect(aliases).toEqual([]);
    });

    it("handles git push with HEAD:branch syntax", () => {
      const aliases = extractAliases([
        {
          tool: "git",
          input: {
            args: ["push", "origin", "HEAD:refs/heads/feat/new"],
            cwd: "/workspace/repos/acme-app",
          },
          output: "(no output)",
        },
      ]);

      expect(aliases).toEqual([
        {
          alias: "git:branch:acme/app:feat/new",
          context: "git push in /workspace/repos/acme-app",
        },
      ]);
    });
  });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});
