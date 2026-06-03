import { describe, expect, it } from "vitest";
import { isOmittedMarker, parseOpencodeEvent, projectOpencodeEvent } from "./opencode-event.ts";

describe("parseOpencodeEvent", () => {
  it("parses a message.part.updated event with a tool part", () => {
    const result = parseOpencodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_1",
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "a\nb",
            time: { start: 1, end: 2 },
          },
        },
      },
    });
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.event.type).toBe("message.part.updated");
    const part = result.event.properties.part;
    if (part.type !== "tool") throw new Error("expected tool part");
    expect(part.tool).toBe("bash");
    expect(part.state.status).toBe("completed");
  });

  it("accepts OmittedMarker in payload leaves without losing type narrowing", () => {
    const result = parseOpencodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_1",
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: {
            status: "completed",
            input: { _omitted: true, bytes: 4096 },
            output: "small",
          },
        },
      },
    });
    if (result.kind !== "ok") throw new Error("expected ok");
    const part = result.event.properties.part;
    if (part.type !== "tool") throw new Error("expected tool part");
    const input = part.state.input;
    if (!input || typeof input !== "object" || !("_omitted" in input))
      throw new Error("expected omitted marker");
    expect(input.bytes).toBe(4096);
  });

  it("parses text, reasoning, step-finish, retry, subtask part shapes", () => {
    for (const part of [
      { id: "p", type: "text", text: "hello" },
      { id: "p", type: "reasoning", text: "thinking" },
      { id: "p", type: "step-finish", cost: 0.001, tokens: { input: 10, output: 5 } },
      { id: "p", type: "retry", reason: "rate limit" },
      { id: "p", type: "subtask" },
    ]) {
      const result = parseOpencodeEvent({
        type: "message.part.updated",
        properties: { part },
      });
      expect(result.kind).toBe("ok");
    }
  });

  it("parses session.idle, session.status, session.error events", () => {
    expect(parseOpencodeEvent({ type: "session.idle", properties: { sessionID: "s1" } }).kind).toBe(
      "ok",
    );
    expect(
      parseOpencodeEvent({
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      }).kind,
    ).toBe("ok");
    expect(
      parseOpencodeEvent({
        type: "session.error",
        properties: { error: "boom" },
      }).kind,
    ).toBe("ok");
  });

  it("recognizes telemetry-only lifecycle events with loose property shapes", () => {
    for (const type of [
      "message.updated",
      "message.removed",
      "message.part.removed",
      "session.created",
      "session.updated",
      "session.deleted",
      "session.compacted",
      "permission.updated",
      "permission.replied",
    ]) {
      const result = parseOpencodeEvent({ type, properties: { whatever: true } });
      expect(result.kind, `${type} should parse`).toBe("ok");
    }
  });

  it("recognizes silent SDK part shapes (step-start, snapshot, patch, agent, file, compaction)", () => {
    for (const part of [
      { id: "p", type: "step-start" },
      { id: "p", type: "snapshot" },
      { id: "p", type: "patch" },
      { id: "p", type: "agent" },
      { id: "p", type: "file" },
      { id: "p", type: "compaction", auto: true },
    ]) {
      const result = parseOpencodeEvent({
        type: "message.part.updated",
        properties: { part },
      });
      expect(result.kind, `${part.type} should parse`).toBe("ok");
    }
  });

  it("drift key for malformed parts is <event-type>:<part-type>, not the event type alone", () => {
    const result = parseOpencodeEvent({
      type: "message.part.updated",
      properties: { part: { id: "p", type: "future-part" } },
    });
    expect(result.kind).toBe("unrecognized");
    if (result.kind === "unrecognized") {
      expect(result.rawType).toBe("message.part.updated:future-part");
    }
  });

  it("falls back to unrecognized for event types that aren't in the schema", () => {
    const result = parseOpencodeEvent({
      type: "file.edited",
      properties: { whatever: true },
    });
    expect(result.kind).toBe("unrecognized");
    if (result.kind === "unrecognized") expect(result.rawType).toBe("file.edited");
  });

  it("falls back to unrecognized for malformed part shapes", () => {
    const result = parseOpencodeEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "p", type: "tool" }, // missing required fields
      },
    });
    expect(result.kind).toBe("unrecognized");
    if (result.kind === "unrecognized") expect(result.rawType).toBe("message.part.updated:tool");
  });

  it("recognizes the {_truncated: true} cap sentinel", () => {
    expect(parseOpencodeEvent({ _truncated: true }).kind).toBe("truncated");
  });

  it("falls back when raw is not an object", () => {
    expect(parseOpencodeEvent(null).kind).toBe("unrecognized");
    expect(parseOpencodeEvent("hello").kind).toBe("unrecognized");
    const result = parseOpencodeEvent(null);
    if (result.kind === "unrecognized") expect(result.rawType).toBeUndefined();
  });
});

describe("projectOpencodeEvent", () => {
  it("projects a tool event to the fixed viewer skeleton", () => {
    const out = projectOpencodeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_a",
        time: 1,
        part: {
          id: "prt_a",
          messageID: "msg_a",
          sessionID: "ses_a",
          type: "tool",
          tool: "read",
          callID: "call_a",
          state: {
            status: "completed",
            title: "Read a file",
            time: { start: 10, end: 20 },
            input: { path: "/tmp/x" },
            output: "result",
          },
          vendorPayload: "dropped",
        },
        vendorPayload: "dropped",
      },
    });

    expect(out).toMatchObject({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_a",
        time: 1,
        part: {
          id: "prt_a",
          messageID: "msg_a",
          sessionID: "ses_a",
          type: "tool",
          tool: "read",
          callID: "call_a",
          state: {
            status: "completed",
            title: "Read a file",
            time: { start: 10, end: 20 },
          },
        },
      },
    });
    const part = out?.properties?.part as { state?: { input?: unknown; output?: unknown } };
    expect(isOmittedMarker(part.state?.input)).toBe(true);
    expect(isOmittedMarker(part.state?.output)).toBe(true);
    expect((out?.properties as Record<string, unknown>).vendorPayload).toBeUndefined();
    expect((out?.properties?.part as Record<string, unknown>).vendorPayload).toBeUndefined();
  });

  it("preserves unknown event and part type skeletons", () => {
    const out = projectOpencodeEvent({
      id: "evt_future",
      type: "message.future.delta",
      properties: {
        sessionID: "ses_future",
        time: 123,
        metadata: { trace: "m".repeat(5000) },
        part: {
          id: "prt_future",
          type: "future-part",
          tool: "future-tool",
          callID: "call_future",
          state: {
            status: "cancelled",
            raw: { body: "z".repeat(5000) },
          },
        },
      },
    });

    expect(out).toMatchObject({
      id: "evt_future",
      type: "message.future.delta",
      properties: {
        sessionID: "ses_future",
        time: 123,
        part: {
          id: "prt_future",
          type: "future-part",
          tool: "future-tool",
          callID: "call_future",
          state: { status: "cancelled" },
        },
      },
    });
    const props = out?.properties as Record<string, unknown>;
    const part = props.part as { state?: { raw?: unknown } };
    expect(isOmittedMarker(props.metadata)).toBe(true);
    expect(isOmittedMarker(part.state?.raw)).toBe(true);
  });

  it("preserves step-finish cost and token accounting in projections", () => {
    expect(
      projectOpencodeEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_step_finish",
            type: "step-finish",
            cost: 0.0123,
            tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
            vendorPayload: "dropped",
          },
        },
      }),
    ).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_step_finish",
          type: "step-finish",
          cost: 0.0123,
          tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        },
      },
    });
  });

  it("preserves compact session status and error fields", () => {
    expect(
      projectOpencodeEvent({
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy", ignored: true } },
      }),
    ).toEqual({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    });

    expect(
      projectOpencodeEvent({
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "ProviderError", data: { message: "unavailable", extra: true } },
        },
      }),
    ).toEqual({
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "ProviderError", data: { message: "unavailable" } },
      },
    });
  });

  it("returns null when there is no event type", () => {
    expect(projectOpencodeEvent({ foo: "bar" })).toBeNull();
  });
});
