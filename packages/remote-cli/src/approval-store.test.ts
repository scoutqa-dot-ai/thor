import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "./approval-store.ts";

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
  it("builds a pending action with optional notification metadata before persisting", () => {
    const pending = store.buildPending(
      "merge_pull_request",
      { pr: 42 },
      { sessionId: "s1" },
      { provider: "slack", channel: "C123", threadTs: "1710000000.001" },
    );

    expect(store.get(pending.id)).toBeUndefined();
    store.update({
      ...pending,
      notification: {
        provider: "slack",
        channel: "C123",
        threadTs: "1710000000.001",
        messageTs: "1710000000.100",
        postedAt: new Date().toISOString(),
      },
    });

    expect(store.get(pending.id)).toMatchObject({
      id: pending.id,
      notification: {
        provider: "slack",
        channel: "C123",
        threadTs: "1710000000.001",
        messageTs: "1710000000.100",
      },
    });
  });

  it("rejects a pending action once", () => {
    const action = store.buildPending("merge_pull_request", { pr: 42 });
    store.update(action);

    const rejected = store.reject(action.id, "U12345");

    expect(rejected?.status).toBe("rejected");
    expect(rejected?.reviewer).toBe("U12345");
    expect(store.reject(action.id, "U999")).toBeUndefined();
  });

  it("stores approved actions with an explicit exec result", () => {
    const action = store.buildPending("merge_pull_request", { pr: 42 });
    store.update(action);
    action.error = "temporary failure";

    const resolved = store.approveLoaded(
      action,
      { stdout: "merged", stderr: "", exitCode: 0 },
      "U1",
    );

    expect(resolved.status).toBe("approved");
    expect(store.get(action.id)).toMatchObject({
      status: "approved",
      result: { stdout: "merged", stderr: "", exitCode: 0 },
    });
    expect(store.get(action.id)?.error).toBeUndefined();
  });

  it("fails fast on approved actions with invalid stored result shapes", () => {
    const action = store.buildPending("merge_pull_request", { pr: 42 });
    store.update(action);
    const dir = join(tempDir, action.dateSegment);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${action.id}.json`),
      JSON.stringify({ ...action, status: "approved", resolvedAt: new Date().toISOString() }),
    );

    expect(() => store.get(action.id)).toThrow(/approved approval actions must include/);
  });

  it("returns undefined for ids that are not v7 UUIDs, including path-traversal attempts", () => {
    const action = store.buildPending("merge_pull_request", { pr: 42 });
    store.update(action);

    // A real action is still retrievable after the validator is in place.
    expect(store.get(action.id)?.id).toBe(action.id);

    // Plant a file that the traversal would resolve to and confirm get()
    // refuses to touch it.
    const escaped = join(tempDir, "..", "escaped.json");
    writeFileSync(
      escaped,
      JSON.stringify({ ...action, id: "../escaped", dateSegment: "" }, null, 2),
    );
    try {
      expect(store.get("../escaped")).toBeUndefined();
      expect(store.get("..%2Fescaped")).toBeUndefined();
      expect(store.get("not-a-uuid")).toBeUndefined();
      expect(store.get("")).toBeUndefined();
    } finally {
      rmSync(escaped, { force: true });
    }
  });

  it("lists pending actions for the current upstream only", () => {
    const pending = store.buildPending("new_tool", {});
    store.update(pending);
    store.approveLoaded(pending, { stdout: "ok", stderr: "", exitCode: 0 }, "U1");
    const legacy = store.buildPending("legacy_tool", {});
    store.update(legacy);

    const unresolved = store.listPending();

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.tool).toBe("legacy_tool");
    expect(unresolved[0]?.upstream).toBe("github");
  });
});
