import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "./approval-store.js";

let store: ApprovalStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "approval-test-"));
  store = new ApprovalStore(tempDir, "github");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ApprovalStore", () => {
  it("creates and retrieves an approval action", () => {
    const created = store.create("merge_pull_request", { pr: 42 });

    expect(created.upstream).toBe("github");
    expect(store.get(created.id)).toEqual(created);
  });

  it("resolves a pending action once", () => {
    const action = store.create("merge_pull_request", { pr: 42 });

    const resolved = store.resolve(action.id, "approved", "U12345");

    expect(resolved?.status).toBe("approved");
    expect(resolved?.reviewer).toBe("U12345");
    expect(store.resolve(action.id, "rejected", "U999")).toBeUndefined();
  });

  it("lists pending actions for the current upstream only", () => {
    const pending = store.create("new_tool", {});
    store.resolve(pending.id, "approved", "U1");
    store.create("legacy_tool", {});

    const unresolved = store.listPending();

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.tool).toBe("legacy_tool");
    expect(unresolved[0]?.upstream).toBe("github");
  });
});
