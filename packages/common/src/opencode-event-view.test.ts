import { describe, expect, it } from "vitest";
import {
  OpencodeEventViewSchema,
  isOmittedMarker,
  projectOpencodeEvent,
} from "./opencode-event-view.js";

describe("opencode-event-view", () => {
  it("projects a small tool event through the schema unchanged in shape", () => {
    const event = {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_a",
        time: 1,
        part: {
          id: "prt_a",
          type: "tool",
          tool: "read",
          callID: "call_a",
          state: {
            status: "running",
            input: { path: "/tmp/x" },
          },
        },
      },
    };
    const out = projectOpencodeEvent(event);
    expect(out).not.toBeNull();
    expect(OpencodeEventViewSchema.safeParse(out).success).toBe(true);
    if (out?.type === "message.part.updated" && out.properties.part.type === "tool") {
      expect(out.properties.part.state.input).toEqual({ path: "/tmp/x" });
    }
  });

  it("replaces large state.output with an omitted marker carrying byte count", () => {
    const big = "y".repeat(5000);
    const out = projectOpencodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          type: "tool",
          tool: "bash",
          state: { status: "completed", output: big },
        },
      },
    });
    expect(out).not.toBeNull();
    if (out?.type === "message.part.updated" && out.properties.part.type === "tool") {
      const marker = out.properties.part.state.output;
      expect(isOmittedMarker(marker)).toBe(true);
      if (isOmittedMarker(marker)) {
        expect(marker.bytes).toBeGreaterThanOrEqual(5000);
      }
    }
  });

  it("returns null for unrecognized top-level event.type", () => {
    expect(projectOpencodeEvent({ type: "unknown.kind", properties: {} })).toBeNull();
    expect(projectOpencodeEvent({ foo: "bar" })).toBeNull();
  });

  it("accepts unknown part.type via passthrough escape hatch", () => {
    const out = projectOpencodeEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "p1", type: "future-part-kind", extra: "value" },
      },
    });
    expect(out).not.toBeNull();
    if (out?.type === "message.part.updated") {
      expect(out.properties.part.type).toBe("future-part-kind");
    }
  });

  it("preserves status.type enum forward-compat (session.status with new status)", () => {
    const out = projectOpencodeEvent({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "cancelled" } },
    });
    expect(out).not.toBeNull();
    if (out?.type === "session.status") {
      expect(out.properties.status.type).toBe("cancelled");
    }
  });

  it("threshold:0 forces all omittable leaves to markers", () => {
    const out = projectOpencodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p1",
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { path: "/x" }, output: "ok" },
          },
        },
      },
      { threshold: 0 },
    );
    if (out?.type === "message.part.updated" && out.properties.part.type === "tool") {
      expect(isOmittedMarker(out.properties.part.state.input)).toBe(true);
      expect(isOmittedMarker(out.properties.part.state.output)).toBe(true);
    }
  });

  it("does not mark fields that are not in the omittable key set", () => {
    const out = projectOpencodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          type: "tool",
          tool: "read",
          callID: "c_" + "a".repeat(2000), // huge non-omittable field stays whole
          state: { status: "completed" },
        },
      },
    });
    if (out?.type === "message.part.updated" && out.properties.part.type === "tool") {
      expect(out.properties.part.callID?.length).toBeGreaterThan(2000);
    }
  });
});
