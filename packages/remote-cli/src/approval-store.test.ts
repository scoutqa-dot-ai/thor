import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("creates and retrieves an approval action", () => {
    const created = store.create("merge_pull_request", { pr: 42 });

    expect(store.get(created.id)).toEqual(created);
  });

  it("resolves a pending action once", () => {
    const action = store.create("merge_pull_request", { pr: 42 });

    const resolved = store.resolve(action.id, "approved", "U12345");

    expect(resolved?.status).toBe("approved");
    expect(resolved?.reviewer).toBe("U12345");
    expect(store.resolve(action.id, "rejected", "U999")).toBeUndefined();
  });

  it("lists pending actions across primary and fallback directories", () => {
    const fallbackDir = mkdtempSync(join(tmpdir(), "approval-fallback-"));
    const storeWithFallback = new ApprovalStore(tempDir, [fallbackDir]);
    const fallbackStore = new ApprovalStore(fallbackDir);

    const primary = storeWithFallback.create("new_tool", {});
    fallbackStore.create("legacy_tool", {});
    store.resolve(primary.id, "approved", "U1");

    const pending = storeWithFallback.listPending();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool).toBe("legacy_tool");

    rmSync(fallbackDir, { recursive: true, force: true });
  });
});
