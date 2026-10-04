import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAlias,
  appendSessionEvent,
  findLatestMcpApprovalProjection,
  findNativeMcpProjection,
  findTriggerActor,
  hasNativeMcpCallProjection,
  readTriggerSlice,
  resolveAlias,
  sessionLogPath,
} from "./event-log.js";
import { McpNativeAuthoritySchema } from "./mcp-broker.js";

const anchorId = "00000000-0000-7000-8000-000000000201";
const context = McpNativeAuthoritySchema.parse({
  anchorId,
  sessionId: `pi-${anchorId}`,
  triggerId: "00000000-0000-7000-8000-000000000202",
  requestId: "dummy-request",
  directory: "/workspace/repos/fixture",
  repositoryDirectory: "/workspace/repos/fixture",
  requester: { source: "slack", id: "U123" },
  teamId: "T123",
  sourceKey: "slack:thread:C123/1710000000.001",
  taskId: "dummy-task",
  callId: "dummy-call",
});
const searchContext = McpNativeAuthoritySchema.parse({
  ...context,
  taskId: "dummy-search-task",
  callId: "dummy-search-call",
});
const sessionRecord = JSON.stringify({
  schemaVersion: 1,
  ts: "2026-10-05T00:00:00.000Z",
  type: "tool_call",
  tool: "unrelated",
  payload: "é",
});
const aliasRecord = JSON.stringify({
  ts: "2026-10-05T00:00:00.000Z",
  aliasType: "git.branch",
  aliasValue: "é",
  anchorId,
});

// These are independent corrupt bytes, not invalid values built by the owning schemas.
const tails = [
  { name: "partial supersession", tail: Buffer.from('{"type":"trigger_start","triggerId":"') },
  { name: "malformed complete record", tail: Buffer.from('{"type":"trigger_start"\n') },
  { name: "schema-invalid complete record", tail: Buffer.from('{"type":"trigger_start"}\n') },
  { name: "nonempty whitespace tail", tail: Buffer.from(" ") },
  { name: "split UTF-8 tail", tail: Buffer.from([0xc3]) },
];

describe("MCP worklog authority requires complete append evidence", () => {
  let root: string;
  const originalWorklogDir = process.env.WORKLOG_DIR;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "neo-event-authority-"));
    process.env.WORKLOG_DIR = root;
    for (const aliasType of ["pi.conversation", "opencode.session"] as const)
      appendAlias({ aliasType, aliasValue: context.sessionId, anchorId });
    const {
      sessionId,
      anchorId: _anchor,
      triggerId,
      taskId: _task,
      callId: _call,
      ...nativeMcp
    } = context;
    appendSessionEvent(sessionId, {
      type: "trigger_start",
      triggerId,
      correlationKey: context.sourceKey,
      triggerSlackId: "U123",
      nativeMcp,
    });
    appendSessionEvent(sessionId, {
      type: "tool_call",
      tool: "mcp_call",
      callId: context.callId,
      payload: { nativeMcp: context, state: "started" },
    });
    appendSessionEvent(sessionId, {
      type: "tool_call",
      tool: "mcp_search",
      callId: searchContext.callId,
      payload: { nativeMcp: searchContext, state: "started" },
    });
  });
  afterEach(() => {
    if (originalWorklogDir === undefined) delete process.env.WORKLOG_DIR;
    else process.env.WORKLOG_DIR = originalWorklogDir;
    rmSync(root, { recursive: true, force: true });
  });

  function expectDenied() {
    expect(findNativeMcpProjection(context.sessionId)).toBeUndefined();
    expect(findLatestMcpApprovalProjection(context.sessionId)).toBeUndefined();
    expect(hasNativeMcpCallProjection(context, "mcp_call")).toBe(false);
    expect(hasNativeMcpCallProjection(searchContext, "mcp_search")).toBe(false);
  }
  function expectAdmitted() {
    expect(findNativeMcpProjection(context.sessionId)?.triggerId).toBe(context.triggerId);
    expect(findLatestMcpApprovalProjection(context.sessionId)?.triggerId).toBe(context.triggerId);
    expect(hasNativeMcpCallProjection(context, "mcp_call")).toBe(true);
    expect(hasNativeMcpCallProjection(context, "mcp_search")).toBe(false);
    expect(hasNativeMcpCallProjection(searchContext, "mcp_search")).toBe(true);
    expect(hasNativeMcpCallProjection(searchContext, "mcp_call")).toBe(false);
  }

  describe.each(["session", "aliases"] as const)("%s log", (source) => {
    function path() {
      return source === "session" ? sessionLogPath(context.sessionId) : join(root, "aliases.jsonl");
    }
    const validRecord = source === "session" ? sessionRecord : aliasRecord;
    const invalidUtf8 = Buffer.concat([
      Buffer.from(validRecord.slice(0, validRecord.indexOf("é"))),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(validRecord.slice(validRecord.indexOf("é") + 1) + "\n"),
    ]);
    it.each([
      ...tails,
      { name: "valid final JSON without newline", tail: Buffer.from(validRecord) },
      { name: "invalid UTF-8 inside complete JSON", tail: invalidUtf8 },
    ])("denies $name without hiding admitted history or rewriting evidence", ({ tail }) => {
      expectAdmitted(); // Warm both caches before the incomplete append.
      appendFileSync(path(), tail);
      const bytes = readFileSync(path());
      expectDenied();
      expect(readTriggerSlice(context.sessionId, context.triggerId)).toMatchObject({
        status: "in_flight",
      });
      expect(findTriggerActor(context.sessionId)).toEqual({ slack: "U123" });
      expect(resolveAlias({ aliasType: "pi.conversation", aliasValue: context.sessionId })).toBe(
        anchorId,
      );
      expect(readFileSync(path())).toEqual(bytes);
    });

    it("restores authority only after a valid append is newline committed", () => {
      expectAdmitted();
      appendFileSync(path(), validRecord);
      expectDenied();
      appendFileSync(path(), "\n");
      expectAdmitted();
    });
  });

  it("never falls back to an older trigger across any incomplete supersession prefix", () => {
    const path = sessionLogPath(context.sessionId);
    const original = readFileSync(path);
    const supersession = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        ts: "2026-10-05T00:00:00.000Z",
        type: "trigger_start",
        triggerId: "00000000-0000-7000-8000-000000000203",
      }),
    );
    for (let length = 1; length <= supersession.length; length++) {
      writeFileSync(path, Buffer.concat([original, supersession.subarray(0, length)]));
      expectDenied();
    }
    appendFileSync(path, "\n");
    expectDenied(); // The new legacy turn cannot resurrect the old native proof.
  });

  it("accepts complete Unicode records across a 64 KiB boundary and ended original approval turns", () => {
    const path = sessionLogPath(context.sessionId);
    const recordPrefix =
      '{"schemaVersion":1,"ts":"2026-10-05T00:00:00.000Z","type":"tool_call","tool":"other","payload":"';
    const padding = 64 * 1024 - readFileSync(path).length - Buffer.byteLength(recordPrefix) - 1;
    appendFileSync(path, recordPrefix + "x".repeat(padding) + 'é🙂"}\n');
    expectAdmitted();
    expect(findTriggerActor(context.sessionId)).toEqual({ slack: "U123" });
    appendSessionEvent(context.sessionId, {
      type: "trigger_end",
      triggerId: context.triggerId,
      status: "completed",
    });
    expect(findNativeMcpProjection(context.sessionId)).toBeUndefined();
    expect(hasNativeMcpCallProjection(context, "mcp_call")).toBe(false);
    expect(findLatestMcpApprovalProjection(context.sessionId)?.triggerId).toBe(context.triggerId);
  });
});
