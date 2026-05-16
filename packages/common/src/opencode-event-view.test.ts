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

  it("projects unrecognized top-level event.type through the strategic fallback", () => {
    const out = projectOpencodeEvent({
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
          state: {
            status: "completed",
            input: { path: "/tmp/x" },
            output: "z".repeat(5000),
          },
          vendorPayload: "should be dropped",
        },
        metadata: { trace: "m".repeat(5000) },
        vendorPayload: "should be dropped",
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
          state: {
            status: "completed",
            input: { path: "/tmp/x" },
          },
        },
      },
    });
    if (out && "properties" in out) {
      const props = out.properties as Record<string, unknown>;
      const part = props.part as { state?: { output?: unknown } };
      expect(isOmittedMarker(part.state?.output)).toBe(true);
      expect(isOmittedMarker(props.metadata)).toBe(true);
      expect(props.vendorPayload).toBeUndefined();
      expect((props.part as Record<string, unknown>).vendorPayload).toBeUndefined();
    }
    expect(projectOpencodeEvent({ foo: "bar" })).toBeNull();
  });

  it("parses a compaction part as a known variant", () => {
    const out = projectOpencodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_compact",
          messageID: "msg_x",
          sessionID: "ses_x",
          type: "compaction",
          auto: true,
          overflow: false,
        },
      },
    });
    expect(out).not.toBeNull();
    if (out?.type === "message.part.updated" && out.properties.part.type === "compaction") {
      expect(out.properties.part.auto).toBe(true);
      expect(out.properties.part.overflow).toBe(false);
    } else {
      throw new Error("expected compaction part");
    }
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

  it("parses SDK-canonical part variants beyond compaction (subtask, file, patch, agent, retry, snapshot)", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["subtask", { description: "do thing", agent: "thinker", prompt: "go" }],
      ["file", { mime: "text/plain", filename: "x.md", url: "file:///x.md" }],
      ["patch", { hash: "abc", files: ["a.ts", "b.ts"] }],
      ["agent", { name: "thinker" }],
      ["retry", { attempt: 2, error: { message: "rate limited" }, time: { created: 1 } }],
      ["snapshot", { snapshot: "snap_xyz" }],
    ];
    for (const [type, extra] of cases) {
      const out = projectOpencodeEvent({
        type: "message.part.updated",
        properties: { part: { id: `p_${type}`, type, ...extra } },
      });
      expect(out, `${type} should parse`).not.toBeNull();
      if (out?.type === "message.part.updated") {
        expect(out.properties.part.type).toBe(type);
      }
    }
  });

  it("accepts forward-compat tool status values beyond the four canonical ones", () => {
    const out = projectOpencodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          type: "tool",
          tool: "x",
          state: { status: "cancelled" },
        },
      },
    });
    expect(out).not.toBeNull();
    if (out?.type === "message.part.updated" && out.properties.part.type === "tool") {
      expect(out.properties.part.state.status).toBe("cancelled");
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
