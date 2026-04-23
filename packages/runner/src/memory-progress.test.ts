import { describe, expect, it } from "vitest";
import { getMemoryProgressEvents } from "./memory-progress.js";

describe("getMemoryProgressEvents", () => {
  it("emits memory events for completed read/write tools", () => {
    expect(
      getMemoryProgressEvents({
        tool: "read",
        status: "completed",
        input: { filePath: "/workspace/memory/README.md" },
      }),
    ).toEqual([
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/README.md",
        source: "tool",
      },
    ]);

    expect(
      getMemoryProgressEvents({
        tool: "write",
        status: "completed",
        input: { targetPath: "/workspace/memory/my-repo/README.md" },
      }),
    ).toEqual([
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/my-repo/README.md",
        source: "tool",
      },
    ]);
  });

  it("does not emit memory events for errored tool calls", () => {
    expect(
      getMemoryProgressEvents({
        tool: "read",
        status: "error",
        input: { filePath: "/workspace/memory/README.md" },
      }),
    ).toEqual([]);
  });

  it("only includes /workspace/memory paths", () => {
    expect(
      getMemoryProgressEvents({
        tool: "edit",
        status: "completed",
        input: {
          filePath: "/workspace/repos/thor/README.md",
          nested: [{ targetPath: "/workspace/memory/README.md" }],
        },
      }),
    ).toEqual([
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/README.md",
        source: "tool",
      },
    ]);
  });
});
