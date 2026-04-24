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
  extractAliases,
  hasSlackReply,
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

  it("appendTrigger is a no-op when notes file does not exist", () => {
    // Should not throw
    appendTrigger({
      correlationKey: "ghost-key",
      prompt: "nobody home",
    });
    expect(readNotes("ghost-key")).toBeUndefined();
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
    it("registerAlias is a no-op when notes file does not exist", () => {
      registerAlias({
        correlationKey: "ghost-alias-key",
        alias: "slack:thread:000.000",
      });
      expect(readNotes("ghost-alias-key")).toBeUndefined();
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
          input: {
            command:
              "curl -sS -X POST https://slack.com/api/chat.postMessage --data-urlencode channel=C123 --data-urlencode text=hello",
          },
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

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});
