import { describe, expect, it } from "vitest";
import { getMemoryProgressEvents } from "./memory-progress.ts";

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

  it("suppresses bare directory reads under /workspace/memory", () => {
    const directories = new Set(["/workspace/memory", "/workspace/memory/thor"]);
    const fakeStat = (target: string) => ({ isDirectory: () => directories.has(target) });

    expect(
      getMemoryProgressEvents({
        tool: "read",
        status: "completed",
        statSync: fakeStat,
        input: {
          filePath: "/workspace/memory",
          nested: [
            { targetPath: "/workspace/memory/." },
            { targetPath: "/workspace/memory/thor" },
            { targetPath: "/workspace/memory/thor/." },
            { targetPath: "/workspace/memory/thor/../thor" },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("emits a memory write for apply_patch touching /workspace/memory", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: /workspace/memory/runbooks/trial-dropoff-cohort-analysis.md",
      "@@",
      "-old line",
      "+new line",
      "*** End Patch",
    ].join("\n");

    expect(
      getMemoryProgressEvents({
        tool: "apply_patch",
        status: "completed",
        input: { patchText },
      }),
    ).toEqual([
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/runbooks/trial-dropoff-cohort-analysis.md",
        source: "tool",
      },
    ]);
  });

  it("captures adds, deletes, and renames from an apply_patch diff, ignoring non-memory files", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: /workspace/memory/runbooks/new.md",
      "+created",
      "*** Delete File: /workspace/memory/runbooks/old.md",
      "*** Update File: /workspace/memory/runbooks/moved.md",
      "*** Move to: /workspace/memory/runbooks/renamed.md",
      "@@",
      "-x",
      "+y",
      "*** Update File: /workspace/repos/thor/README.md",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n");

    expect(
      getMemoryProgressEvents({
        tool: "apply_patch",
        status: "completed",
        input: { patchText },
      }),
    ).toEqual([
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/runbooks/new.md",
        source: "tool",
      },
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/runbooks/old.md",
        source: "tool",
      },
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/runbooks/moved.md",
        source: "tool",
      },
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/runbooks/renamed.md",
        source: "tool",
      },
    ]);
  });

  it("emits nothing for an apply_patch that never touches /workspace/memory", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "-const oldValue = 1;",
      "+const newValue = 2;",
      "*** End Patch",
    ].join("\n");

    expect(
      getMemoryProgressEvents({
        tool: "apply_patch",
        status: "completed",
        input: { patchText },
      }),
    ).toEqual([]);
  });

  it("keeps file reads under /workspace/memory", () => {
    const fakeStat = () => ({ isDirectory: () => false });

    expect(
      getMemoryProgressEvents({
        tool: "read",
        status: "completed",
        statSync: fakeStat,
        input: {
          filePath: "/workspace/memory/thor/README.md",
          nested: [{ targetPath: "/workspace/memory/runbooks/investigation-workflow.md" }],
        },
      }),
    ).toEqual([
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/thor/README.md",
        source: "tool",
      },
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/runbooks/investigation-workflow.md",
        source: "tool",
      },
    ]);
  });
});
