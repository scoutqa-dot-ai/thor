import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendAlias,
  appendSessionEvent,
  findActiveTrigger,
  listAnchorSessionStates,
  listSessionAliases,
  mintAnchor,
  mintTriggerId,
  readTriggerSlice,
  resolveAlias,
  reverseLookupAnchor,
  sessionLogPath,
  SessionEventLogRecordSchema,
} from "./event-log.js";

const triggerA = "00000000-0000-7000-8000-000000000001";
const triggerB = "00000000-0000-7000-8000-000000000002";
const triggerC = "00000000-0000-7000-8000-000000000003";
const triggerD = "00000000-0000-7000-8000-000000000004";
const triggerE = "00000000-0000-7000-8000-000000000005";
const triggerErr = "00000000-0000-7000-8000-000000000009";
const triggerInFlight = "00000000-0000-7000-8000-000000000011";
const triggerParent = "00000000-0000-7000-8000-000000000021";
const triggerSupersededA = "00000000-0000-7000-8000-000000000022";
const triggerSupersededB = "00000000-0000-7000-8000-000000000023";
const triggerOversized = "00000000-0000-7000-8000-000000000031";
const anchorA = "00000000-0000-7000-8000-0000000000a1";
const anchorB = "00000000-0000-7000-8000-0000000000a2";
const anchorParent = "00000000-0000-7000-8000-0000000000a3";
const anchorSuperseded = "00000000-0000-7000-8000-0000000000a4";
const anchorDashA = "00000000-0000-7000-8000-0000000000b1";
const anchorDashB = "00000000-0000-7000-8000-0000000000b2";
const anchorDashC = "00000000-0000-7000-8000-0000000000b3";
const anchorDashD = "00000000-0000-7000-8000-0000000000b4";
const anchorDashE = "00000000-0000-7000-8000-0000000000b5";
const anchorDashF = "00000000-0000-7000-8000-0000000000b6";

describe("session event log", () => {
  const originalWorklogDir = process.env.WORKLOG_DIR;
  const originalMax = process.env.SESSION_LOG_MAX_BYTES;
  let testDir = "";

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "thor-event-log-"));
    process.env.WORKLOG_DIR = testDir;
    delete process.env.SESSION_LOG_MAX_BYTES;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (originalWorklogDir === undefined) delete process.env.WORKLOG_DIR;
    else process.env.WORKLOG_DIR = originalWorklogDir;
    if (originalMax === undefined) delete process.env.SESSION_LOG_MAX_BYTES;
    else process.env.SESSION_LOG_MAX_BYTES = originalMax;
  });

  it("appends capped records with visible success", () => {
    const result = appendSessionEvent("s1", {
      type: "opencode_event",
      event: { huge: "x".repeat(8000) },
    });
    expect(result.ok).toBe(true);
    expect(statSync(sessionLogPath("s1")).size).toBeLessThan(4096);
  });

  it("preserves required trigger_end fields when truncating oversized errors", () => {
    expect(
      appendSessionEvent("truncated-end", {
        type: "trigger_start",
        triggerId: triggerErr,
      }),
    ).toEqual({ ok: true });
    expect(
      appendSessionEvent("truncated-end", {
        type: "trigger_end",
        triggerId: triggerErr,
        status: "error",
        error: "x".repeat(20_000),
      }),
    ).toEqual({ ok: true });

    expect(readTriggerSlice("truncated-end", triggerErr)).toMatchObject({
      status: "error",
    });
  });

  it("extracts completed, error, aborted, crashed, and in-flight slices", () => {
    appendSessionEvent("s1", { type: "trigger_start", triggerId: triggerA });
    appendSessionEvent("s1", { type: "trigger_end", triggerId: triggerA, status: "completed" });
    appendSessionEvent("s1", { type: "trigger_start", triggerId: triggerB });
    appendSessionEvent("s1", {
      type: "trigger_end",
      triggerId: triggerB,
      status: "error",
      error: "boom",
    });
    appendSessionEvent("s1", { type: "trigger_start", triggerId: triggerC });
    appendSessionEvent("s1", {
      type: "trigger_end",
      triggerId: triggerC,
      status: "aborted",
      reason: "user",
    });
    appendSessionEvent("s1", { type: "trigger_start", triggerId: triggerD });
    appendSessionEvent("s1", { type: "trigger_start", triggerId: triggerE });

    expect(readTriggerSlice("s1", triggerA)).toMatchObject({ status: "completed" });
    expect(readTriggerSlice("s1", triggerB)).toMatchObject({ status: "error" });
    expect(readTriggerSlice("s1", triggerC)).toMatchObject({ status: "aborted" });
    expect(readTriggerSlice("s1", triggerD)).toMatchObject({ status: "crashed" });
    expect(readTriggerSlice("s1", triggerE)).toMatchObject({ status: "in_flight" });
  });

  it("tolerates malformed and partial trailing lines", () => {
    appendSessionEvent("s2", { type: "trigger_start", triggerId: triggerInFlight });
    appendFileSync(sessionLogPath("s2"), "not-json\n{partial");
    expect(readTriggerSlice("s2", triggerInFlight)).toMatchObject({
      status: "in_flight",
      skippedMalformed: 1,
    });
  });

  it("resolves aliases newest-wins and lists session aliases", () => {
    expect(
      appendAlias({ aliasType: "opencode.session", aliasValue: "s1", anchorId: anchorA }).ok,
    ).toBe(true);
    expect(
      appendAlias({ aliasType: "slack.thread_id", aliasValue: "1.2", anchorId: anchorA }).ok,
    ).toBe(true);
    expect(
      appendAlias({ aliasType: "slack.thread_id", aliasValue: "1.2", anchorId: anchorB }).ok,
    ).toBe(true);
    expect(resolveAlias({ aliasType: "slack.thread_id", aliasValue: "1.2" })).toBe(anchorB);

    // Session-scoped alias audit only fires when callers explicitly write the
    // alias record into the session log; the global alias is the routing source
    // of truth. listSessionAliases reflects whatever the session itself recorded.
    expect(
      appendSessionEvent("s1", {
        type: "alias",
        aliasType: "slack.thread_id",
        aliasValue: "1.2",
        anchorId: anchorA,
      }),
    ).toEqual({ ok: true });
    expect(listSessionAliases("s1")).toMatchObject([
      { aliasType: "slack.thread_id", aliasValue: "1.2", anchorId: anchorA },
    ]);
  });

  it("finds active triggers via anchor reverse-lookup", () => {
    appendAlias({ aliasType: "opencode.session", aliasValue: "parent", anchorId: anchorParent });
    appendSessionEvent("parent", { type: "trigger_start", triggerId: triggerParent });

    // Child has no binding yet — falls through to "none".
    expect(findActiveTrigger("child")).toEqual({ ok: false, reason: "none" });

    // Recording opencode.subsession lets the child resolve to the same anchor
    // as the parent, and findActiveTrigger walks the anchor's bound sessions
    // to locate the open trigger.
    appendAlias({
      aliasType: "opencode.subsession",
      aliasValue: "child",
      anchorId: anchorParent,
    });
    expect(findActiveTrigger("child")).toEqual({
      ok: true,
      anchorId: anchorParent,
      sessionId: "parent",
      triggerId: triggerParent,
    });
  });

  it("treats superseded orphan trigger_start as crashed and surfaces the latest open trigger", () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "superseded",
      anchorId: anchorSuperseded,
    });
    appendSessionEvent("superseded", { type: "trigger_start", triggerId: triggerSupersededA });
    appendSessionEvent("superseded", { type: "trigger_start", triggerId: triggerSupersededB });

    expect(readTriggerSlice("superseded", triggerSupersededA)).toMatchObject({ status: "crashed" });
    expect(findActiveTrigger("superseded")).toEqual({
      ok: true,
      anchorId: anchorSuperseded,
      sessionId: "superseded",
      triggerId: triggerSupersededB,
    });

    appendSessionEvent("superseded", {
      type: "trigger_end",
      triggerId: triggerSupersededB,
      status: "completed",
    });
    expect(findActiveTrigger("superseded")).toEqual({ ok: false, reason: "none" });
  });

  it("supersedes orphan opens across sessions on the same anchor by newest trigger_start.ts", async () => {
    // Old session crashes mid-trigger (trigger_start written, no trigger_end).
    appendAlias({ aliasType: "opencode.session", aliasValue: "head1", anchorId: anchorA });
    appendSessionEvent("head1", { type: "trigger_start", triggerId: triggerA });

    // Brief delay so the new trigger_start.ts is strictly greater than the orphan's.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // session_stale recreate: new session on same anchor opens its own trigger.
    appendAlias({ aliasType: "opencode.session", aliasValue: "head2", anchorId: anchorA });
    appendSessionEvent("head2", { type: "trigger_start", triggerId: triggerB });

    // Disclaimer creation on either bound session should resolve to the newer
    // trigger; the orphan in head1 is treated as crashed and ignored.
    const expected = {
      ok: true,
      anchorId: anchorA,
      sessionId: "head2",
      triggerId: triggerB,
    };
    expect(findActiveTrigger("head1")).toEqual(expected);
    expect(findActiveTrigger("head2")).toEqual(expected);
  });

  it("preserves the anchor across session_stale recreate", () => {
    // First session on the anchor.
    appendAlias({ aliasType: "opencode.session", aliasValue: "head-old", anchorId: anchorA });
    appendAlias({ aliasType: "slack.thread_id", aliasValue: "1.5", anchorId: anchorA });

    // session_stale recreate: new session bound to the same anchor.
    appendAlias({ aliasType: "opencode.session", aliasValue: "head-new", anchorId: anchorA });
    appendSessionEvent("head-new", { type: "trigger_start", triggerId: triggerA });

    // Slack alias still resolves to the same anchor.
    expect(resolveAlias({ aliasType: "slack.thread_id", aliasValue: "1.5" })).toBe(anchorA);
    // The reverse map carries both bound sessions; the most recent is the head.
    const reverse = reverseLookupAnchor(anchorA);
    expect(reverse.sessionIds).toContain("head-old");
    expect(reverse.sessionIds).toContain("head-new");
    expect(reverse.currentSessionId).toBe("head-new");
    // findActiveTrigger picks up the open trigger on the new head.
    expect(findActiveTrigger("head-old")).toEqual({
      ok: true,
      anchorId: anchorA,
      sessionId: "head-new",
      triggerId: triggerA,
    });
  });

  it("fails active-trigger lookup closed on oversized files", () => {
    appendAlias({ aliasType: "opencode.session", aliasValue: "big", anchorId: anchorA });
    mkdirSync(join(testDir, "sessions"), { recursive: true });
    writeFileSync(sessionLogPath("big"), "x".repeat(53 * 1024 * 1024));
    expect(findActiveTrigger("big")).toEqual({ ok: false, reason: "oversized" });
  });

  it("fails active-trigger lookup closed when no anchor binding exists", () => {
    // Session log has an open trigger but no opencode.session binding → none.
    appendSessionEvent("orphan", { type: "trigger_start", triggerId: triggerOversized });
    expect(findActiveTrigger("orphan")).toEqual({ ok: false, reason: "none" });
  });

  it("lists anchor session states for idle, in-progress, stuck, and superseded sessions", () => {
    const now = new Date("2026-05-14T12:10:00.000Z");
    appendAlias({ aliasType: "opencode.session", aliasValue: "idle", anchorId: anchorDashA });
    appendAlias({ aliasType: "slack.thread_id", aliasValue: "111.222", anchorId: anchorDashA });
    appendAlias({ aliasType: "opencode.session", aliasValue: "live", anchorId: anchorDashB });
    appendAlias({ aliasType: "opencode.session", aliasValue: "stale", anchorId: anchorDashC });
    appendAlias({ aliasType: "opencode.session", aliasValue: "sup-old", anchorId: anchorDashD, ts: "2026-05-14T12:00:00.000Z" });
    appendAlias({ aliasType: "opencode.session", aliasValue: "sup-new", anchorId: anchorDashD, ts: "2026-05-14T12:00:01.000Z" });

    writeSession("idle", [
      { ts: "2026-05-14T12:00:00.000Z", type: "trigger_start", triggerId: triggerA },
      { ts: "2026-05-14T12:01:00.000Z", type: "trigger_end", triggerId: triggerA, status: "completed" },
    ]);
    writeSession("live", [
      { ts: "2026-05-14T12:08:00.000Z", type: "trigger_start", triggerId: triggerB },
      { ts: "2026-05-14T12:09:30.000Z", type: "opencode_event", event: { ok: true } },
    ]);
    writeSession("stale", [
      { ts: "2026-05-14T12:00:00.000Z", type: "trigger_start", triggerId: triggerC },
    ]);
    writeSession("sup-old", [
      { ts: "2026-05-14T12:02:00.000Z", type: "trigger_start", triggerId: triggerD },
    ]);
    writeSession("sup-new", [
      { ts: "2026-05-14T12:03:00.000Z", type: "trigger_start", triggerId: triggerE },
      { ts: "2026-05-14T12:03:10.000Z", type: "trigger_end", triggerId: triggerE, status: "aborted" },
    ]);

    const rows = listAnchorSessionStates({ now, stuckAfterMs: 5 * 60 * 1000, limit: 10 });
    expect(rows.map((r) => [r.anchorId, r.status])).toEqual([
      [anchorDashD, "stuck"],
      [anchorDashC, "stuck"],
      [anchorDashB, "in_progress"],
      [anchorDashA, "idle"],
    ]);
    expect(rows.find((r) => r.anchorId === anchorDashA)).toMatchObject({
      latestTerminalStatus: "completed",
      externalKeys: [{ aliasType: "slack.thread_id", aliasValue: "111.222" }],
    });
    expect(rows.find((r) => r.anchorId === anchorDashD)).toMatchObject({
      ownerSessionId: "sup-old",
      triggerId: triggerD,
      currentSessionId: "sup-new",
    });
  });

  it("surfaces malformed and oversized session diagnostics in anchor session states", () => {
    appendAlias({ aliasType: "opencode.session", aliasValue: "bad-lines", anchorId: anchorDashE });
    writeSession("bad-lines", [
      { ts: "2026-05-14T12:00:00.000Z", type: "trigger_start", triggerId: triggerA },
    ], "not-json\n");
    let row = listAnchorSessionStates({ now: new Date("2026-05-14T12:01:00.000Z") })[0];
    expect(row).toMatchObject({ anchorId: anchorDashE, status: "in_progress", skippedMalformed: 1 });

    writeFileSync(sessionLogPath("bad-lines"), "x".repeat(53 * 1024 * 1024));
    row = listAnchorSessionStates({ now: new Date("2026-05-14T12:01:00.000Z") })[0];
    expect(row).toMatchObject({ anchorId: anchorDashE, status: "unknown", oversized: true });
  });

  it("marks only anchors with unsafe session aliases unknown and preserves other rows", () => {
    appendAlias({ aliasType: "opencode.session", aliasValue: "good-session", anchorId: anchorDashE });
    appendAlias({ aliasType: "opencode.session", aliasValue: "unsafe/session", anchorId: anchorDashF });
    writeSession("good-session", [
      { ts: "2026-05-14T12:00:00.000Z", type: "trigger_start", triggerId: triggerA },
      { ts: "2026-05-14T12:00:10.000Z", type: "opencode_event", event: { ok: true } },
    ]);

    const rows = listAnchorSessionStates({ now: new Date("2026-05-14T12:01:00.000Z") });
    expect(rows.find((r) => r.anchorId === anchorDashE)).toMatchObject({
      status: "in_progress",
      triggerId: triggerA,
    });
    expect(rows.find((r) => r.anchorId === anchorDashF)).toMatchObject({
      status: "unknown",
      oversized: false,
    });
    expect(rows.find((r) => r.anchorId === anchorDashF)?.reason).toContain("Invalid session id");
  });

  it("mints UUIDv7 anchors and trigger ids that sort lexicographically by mint time", async () => {
    const a = mintAnchor();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = mintTriggerId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it("rejects writes with a non-UUIDv7 trigger id", () => {
    const result = appendSessionEvent("bad", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000001", // v4 — should fail
    });
    expect(result.ok).toBe(false);
  });

  it("multi-process appends produce zero corrupt JSONL lines", async () => {
    const PROCS = 4;
    const RECORDS_PER_PROC = 50;
    const harnessPath = fileURLToPath(new URL("./event-log-fuzz-harness.mjs", import.meta.url));
    const tasks = Array.from(
      { length: PROCS },
      (_, idx) =>
        new Promise<void>((resolveTask, rejectTask) => {
          const child = fork(harnessPath, [String(idx), String(RECORDS_PER_PROC), testDir], {
            stdio: "inherit",
          });
          child.on("error", rejectTask);
          child.on("exit", (code) => {
            if (code === 0) resolveTask();
            else rejectTask(new Error(`fuzz worker ${idx} exited ${code}`));
          });
        }),
    );
    await Promise.all(tasks);

    const path = sessionLogPath("fuzz");
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBe(PROCS * RECORDS_PER_PROC);
    for (const line of lines) {
      const parsed = SessionEventLogRecordSchema.safeParse(JSON.parse(line));
      expect(parsed.success, `corrupt line: ${line.slice(0, 80)}`).toBe(true);
    }
  });
});

function writeSession(
  sessionId: string,
  records: Array<Record<string, unknown>>,
  extra = "",
): void {
  mkdirSync(join(process.env.WORKLOG_DIR ?? "", "sessions"), { recursive: true });
  writeFileSync(
    sessionLogPath(sessionId),
    records.map((record) => JSON.stringify({ schemaVersion: 1, ...record })).join("\n") + "\n" + extra,
  );
}
