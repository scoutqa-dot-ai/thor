import { describe, expect, it } from "vitest";
import { isOmittedMarker, projectOpencodeEvent } from "./opencode-event-view.js";

describe("opencode-event-view", () => {
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
