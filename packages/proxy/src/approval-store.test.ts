import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalStore } from "./approval-store.js";

let store: ApprovalStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "approval-test-"));
  store = new ApprovalStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ApprovalStore", () => {
  it("creates a pending action", () => {
    const action = store.create("merge_pull_request", { pr: 42 });
    expect(action.id).toBeTruthy();
    expect(action.status).toBe("pending");
    expect(action.tool).toBe("merge_pull_request");
    expect(action.args).toEqual({ pr: 42 });
    expect(action.createdAt).toBeTruthy();
    expect(action.dateSegment).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("retrieves a created action by ID", () => {
    const created = store.create("merge_pull_request", { pr: 42 });
    const fetched = store.get(created.id);
    expect(fetched).toEqual(created);
  });

  it("returns undefined for unknown ID", () => {
    expect(store.get("nonexistent-id")).toBeUndefined();
  });

  it("resolves an action as approved", () => {
    const action = store.create("merge_pull_request", { pr: 42 });
    const resolved = store.resolve(action.id, "approved", "U12345");
    expect(resolved).toBeDefined();
    expect(resolved!.status).toBe("approved");
    expect(resolved!.reviewer).toBe("U12345");
    expect(resolved!.resolvedAt).toBeTruthy();

    // Verify persisted
    const fetched = store.get(action.id);
    expect(fetched!.status).toBe("approved");
  });

  it("resolves an action as rejected with reason", () => {
    const action = store.create("create_gist", { public: true });
    const resolved = store.resolve(action.id, "rejected", "U99", "Not appropriate");
    expect(resolved).toBeDefined();
    expect(resolved!.status).toBe("rejected");
    expect(resolved!.reason).toBe("Not appropriate");
    expect(resolved!.reviewer).toBe("U99");
  });

  it("returns undefined when resolving already-resolved action", () => {
    const action = store.create("merge_pull_request", { pr: 1 });
    store.resolve(action.id, "approved", "U1");
    const secondResolve = store.resolve(action.id, "rejected", "U2");
    expect(secondResolve).toBeUndefined();

    // Original resolution preserved
    const fetched = store.get(action.id);
    expect(fetched!.status).toBe("approved");
  });

  it("returns undefined when resolving unknown ID", () => {
    expect(store.resolve("nonexistent", "approved")).toBeUndefined();
  });

  it("updates an action in-place", () => {
    const action = store.create("merge_pull_request", { pr: 42 });
    action.result = { merged: true };
    store.update(action);

    const fetched = store.get(action.id);
    expect(fetched!.result).toEqual({ merged: true });
  });

  it("creates multiple actions and retrieves each", () => {
    const a1 = store.create("tool_a", {});
    const a2 = store.create("tool_b", {});
    const a3 = store.create("tool_c", {});

    expect(store.get(a1.id)!.tool).toBe("tool_a");
    expect(store.get(a2.id)!.tool).toBe("tool_b");
    expect(store.get(a3.id)!.tool).toBe("tool_c");
  });

  describe("listPending", () => {
    it("returns only pending actions", () => {
      const a1 = store.create("tool_a", {});
      const a2 = store.create("tool_b", {});
      store.create("tool_c", {});

      store.resolve(a1.id, "approved", "U1");
      store.resolve(a2.id, "rejected", "U2");

      const pending = store.listPending();
      expect(pending.length).toBe(1);
      expect(pending[0].tool).toBe("tool_c");
    });

    it("returns empty array when no actions exist", () => {
      expect(store.listPending()).toEqual([]);
    });

    it("returns empty array when all actions are resolved", () => {
      const a = store.create("tool_a", {});
      store.resolve(a.id, "approved");
      expect(store.listPending()).toEqual([]);
    });

    it("skips corrupt JSON files", () => {
      const action = store.create("tool_a", {});
      // Write a corrupt file in the same date directory
      const { writeFileSync } = require("node:fs");
      writeFileSync(join(tempDir, action.dateSegment, "corrupt.json"), "not-json{{{");

      const pending = store.listPending();
      expect(pending.length).toBe(1);
      expect(pending[0].tool).toBe("tool_a");
    });

    it("includes pending actions from fallback directories", () => {
      const fallbackDir = mkdtempSync(join(tmpdir(), "approval-fallback-"));
      const storeWithFallback = new ApprovalStore(tempDir, [fallbackDir]);

      // Create action in fallback dir directly
      const fallbackStore = new ApprovalStore(fallbackDir);
      const fallbackAction = fallbackStore.create("legacy_tool", { legacy: true });

      // Create action in primary dir
      storeWithFallback.create("new_tool", {});

      const pending = storeWithFallback.listPending();
      expect(pending.length).toBe(2);
      expect(pending.map((a) => a.tool).sort()).toEqual(["legacy_tool", "new_tool"]);

      rmSync(fallbackDir, { recursive: true, force: true });
    });

    it("handles missing directories gracefully", () => {
      const storeWithMissing = new ApprovalStore("/nonexistent/path/approval-store");
      expect(storeWithMissing.listPending()).toEqual([]);
    });
  });
});
