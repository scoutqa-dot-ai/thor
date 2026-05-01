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
  listSessionAliases,
  readTriggerSlice,
  resolveAlias,
  sessionLogPath,
  SessionEventLogRecordSchema,
} from "./event-log.js";

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

  it("extracts completed, error, aborted, crashed, and in-flight slices", () => {
    appendSessionEvent("s1", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000001",
    });
    appendSessionEvent("s1", {
      type: "trigger_end",
      triggerId: "00000000-0000-4000-8000-000000000001",
      status: "completed",
    });
    appendSessionEvent("s1", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000002",
    });
    appendSessionEvent("s1", {
      type: "trigger_end",
      triggerId: "00000000-0000-4000-8000-000000000002",
      status: "error",
      error: "boom",
    });
    appendSessionEvent("s1", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000003",
    });
    appendSessionEvent("s1", {
      type: "trigger_end",
      triggerId: "00000000-0000-4000-8000-000000000003",
      status: "aborted",
      reason: "user",
    });
    appendSessionEvent("s1", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000004",
    });
    appendSessionEvent("s1", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000005",
    });

    expect(readTriggerSlice("s1", "00000000-0000-4000-8000-000000000001")).toMatchObject({
      status: "completed",
    });
    expect(readTriggerSlice("s1", "00000000-0000-4000-8000-000000000002")).toMatchObject({
      status: "error",
    });
    expect(readTriggerSlice("s1", "00000000-0000-4000-8000-000000000003")).toMatchObject({
      status: "aborted",
    });
    expect(readTriggerSlice("s1", "00000000-0000-4000-8000-000000000004")).toMatchObject({
      status: "crashed",
    });
    expect(readTriggerSlice("s1", "00000000-0000-4000-8000-000000000005")).toMatchObject({
      status: "in_flight",
    });
  });

  it("tolerates malformed and partial trailing lines", () => {
    appendSessionEvent("s2", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000011",
    });
    appendFileSync(sessionLogPath("s2"), "not-json\n{partial");
    expect(readTriggerSlice("s2", "00000000-0000-4000-8000-000000000011")).toMatchObject({
      status: "in_flight",
      skippedMalformed: 1,
    });
  });

  it("resolves aliases newest-wins and lists session aliases", () => {
    expect(
      appendAlias({ aliasType: "slack.thread_id", aliasValue: "1.2", sessionId: "s1" }).ok,
    ).toBe(true);
    expect(
      appendAlias({ aliasType: "slack.thread_id", aliasValue: "1.2", sessionId: "s2" }).ok,
    ).toBe(true);
    expect(resolveAlias({ aliasType: "slack.thread_id", aliasValue: "1.2" })).toBe("s2");
    expect(listSessionAliases("s2")).toMatchObject([
      { aliasType: "slack.thread_id", aliasValue: "1.2" },
    ]);
  });

  it("finds active triggers with parent chains and failure reasons", () => {
    appendSessionEvent("parent", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000021",
    });
    expect(findActiveTrigger("child")).toEqual({ ok: false, reason: "none" });
    appendAlias({ aliasType: "session.parent", aliasValue: "child", sessionId: "parent" });
    expect(findActiveTrigger("child")).toEqual({
      ok: true,
      sessionId: "parent",
      triggerId: "00000000-0000-4000-8000-000000000021",
    });

    appendSessionEvent("superseded", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000022",
    });
    appendSessionEvent("superseded", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000023",
    });
    expect(readTriggerSlice("superseded", "00000000-0000-4000-8000-000000000022")).toMatchObject({
      status: "crashed",
    });
    expect(findActiveTrigger("superseded")).toEqual({
      ok: true,
      sessionId: "superseded",
      triggerId: "00000000-0000-4000-8000-000000000023",
    });
    appendSessionEvent("superseded", {
      type: "trigger_end",
      triggerId: "00000000-0000-4000-8000-000000000023",
      status: "completed",
    });
    expect(findActiveTrigger("superseded")).toEqual({ ok: false, reason: "none" });

    appendAlias({ aliasType: "session.parent", aliasValue: "a", sessionId: "b" });
    appendAlias({ aliasType: "session.parent", aliasValue: "b", sessionId: "a" });
    expect(findActiveTrigger("a")).toEqual({ ok: false, reason: "cycle" });
  });

  it("fails active-trigger lookup closed on oversized files", () => {
    mkdirSync(join(testDir, "sessions"), { recursive: true });
    writeFileSync(sessionLogPath("big"), "x".repeat(53 * 1024 * 1024));
    expect(findActiveTrigger("big")).toEqual({ ok: false, reason: "oversized" });
  });

  it("returns depth_exceeded when the parent chain is longer than the cap", () => {
    appendSessionEvent("top", {
      type: "trigger_start",
      triggerId: "00000000-0000-4000-8000-000000000031",
    });
    // Chain c0 -> c1 -> c2 -> c3 -> c4 -> c5 -> top (7 hops, > the cap of 5)
    const hops: Array<[string, string]> = [
      ["c0", "c1"],
      ["c1", "c2"],
      ["c2", "c3"],
      ["c3", "c4"],
      ["c4", "c5"],
      ["c5", "top"],
    ];
    for (const [child, parent] of hops) {
      appendAlias({ aliasType: "session.parent", aliasValue: child, sessionId: parent });
    }
    expect(findActiveTrigger("c0")).toEqual({ ok: false, reason: "depth_exceeded" });
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
