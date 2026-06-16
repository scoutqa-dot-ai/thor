import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@opencode-ai/sdk";

// Mock only handleProgressEvent so these tests assert the listener's own
// decisions (thread resolution, parent/child gating, timerless error
// semantics) without coupling to the Slack sink's thresholds/throttle. The
// real alias-cache functions (resolveSessionAnchorId, reverseLookupAnchor,
// anchorHasExternalKeyType) are kept so resolution runs against real state.
vi.mock("@thor/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thor/common")>();
  return { ...actual, handleProgressEvent: vi.fn().mockResolvedValue(undefined) };
});

import {
  appendAlias,
  handleProgressEvent,
  type ProgressEvent,
  type ProgressTransport,
} from "@thor/common";
import { ProgressListener } from "./progress-listener.ts";
import type { SlackProgressTransportTarget } from "./slack-progress.ts";
import type { FirehoseObserver } from "./event-bus.ts";

const handleSpy = vi.mocked(handleProgressEvent);

// A valid UUIDv7 anchor (AnchorIdSchema requires the v7 shape).
const ANCHOR = "00000000-0000-7000-8000-0000000000f1";
const PARENT = "ses_parent";
const CHILD = "ses_child";
const SLACK = "C123/1700000000.0001"; // channel/threadTs → resolves to key "C123:1700000000.0001"
const THREAD_KEY = "C123:1700000000.0001";

const transport = {} as ProgressTransport<SlackProgressTransportTarget>;
const drain = () => new Promise<void>((r) => setTimeout(r, 0));

let observer: FirehoseObserver;

/** Register parent (newest opencode.session) + slack.thread, optionally a child subsession. */
function setupThread(opts: { slack?: boolean; child?: boolean } = {}): void {
  appendAlias({
    anchorId: ANCHOR,
    aliasType: "opencode.session",
    aliasValue: PARENT,
    ts: "2026-01-01T00:00:00.000Z",
  });
  if (opts.slack !== false) {
    appendAlias({ anchorId: ANCHOR, aliasType: "slack.thread", aliasValue: SLACK });
  }
  if (opts.child) {
    appendAlias({ anchorId: ANCHOR, aliasType: "opencode.subsession", aliasValue: CHILD });
  }
}

function toolEvent(
  sessionID: string,
  status: "running" | "completed" | "error",
  opts: { tool?: string; callID?: string; messageID?: string; input?: unknown } = {},
): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: opts.tool ?? "read",
        sessionID,
        messageID: opts.messageID ?? "m1",
        callID: opts.callID ?? "c1",
        state: { status, ...(opts.input !== undefined ? { input: opts.input } : {}) },
      },
    },
  } as unknown as Event;
}

const idleEvent = (): Event => ({ type: "session.idle", properties: {} }) as unknown as Event;
const errorEvent = (): Event =>
  ({
    type: "session.error",
    properties: { error: { data: { message: "boom" } } },
  }) as unknown as Event;

/** Progress events the listener forwarded, paired with the resolved thread key. */
function emitted(): Array<{ key: string; event: ProgressEvent }> {
  return handleSpy.mock.calls.map(([target, event]) => ({ key: target.key, event }));
}

describe("ProgressListener", () => {
  const originalWorklogDir = process.env.WORKLOG_DIR;
  let testDir = "";

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "thor-progress-listener-"));
    process.env.WORKLOG_DIR = testDir;
    handleSpy.mockClear();
    new ProgressListener(
      (obs) => {
        observer = obs;
      },
      transport,
      () => new Map(),
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (originalWorklogDir === undefined) delete process.env.WORKLOG_DIR;
    else process.env.WORKLOG_DIR = originalWorklogDir;
  });

  it("resolves parent and child sessions to the same Slack thread", async () => {
    setupThread({ child: true });

    observer(toolEvent(PARENT, "running", { callID: "c1" }), PARENT);
    observer(toolEvent(CHILD, "running", { callID: "c2" }), CHILD);
    await drain();

    const tools = emitted().filter((e) => e.event.type === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.every((e) => e.key === THREAD_KEY)).toBe(true);
  });

  it("ignores sessions without a slack.thread alias", async () => {
    setupThread({ slack: false });

    observer(toolEvent(PARENT, "running"), PARENT);
    await drain();

    expect(handleSpy).not.toHaveBeenCalled();
  });

  it("produces progress for an operator-UI session with no active /trigger", async () => {
    // No trigger drives this; the listener projects purely from the firehose.
    setupThread();

    observer(toolEvent(PARENT, "running", { tool: "grep" }), PARENT);
    await drain();

    expect(emitted()).toContainEqual({
      key: THREAD_KEY,
      event: { type: "tool", tool: "grep", status: "running" },
    });
  });

  it("does not finalize the parent bubble on a child session.idle", async () => {
    setupThread({ child: true });

    observer(idleEvent(), CHILD);
    await drain();

    expect(emitted().some((e) => e.event.type === "done")).toBe(false);
  });

  it("finalizes the thread bubble on a parent session.idle", async () => {
    setupThread();

    observer(idleEvent(), PARENT);
    await drain();

    const dones = emitted().filter((e) => e.event.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]?.key).toBe(THREAD_KEY);
    expect((dones[0]?.event as { status: string }).status).toBe("completed");
  });

  it("recreates progress after a stale idle dismisses the bubble", async () => {
    setupThread();

    // Same callID reused across the idle boundary: it re-emits only because the
    // listener pruned its per-thread dedup state on the parent idle.
    observer(toolEvent(PARENT, "running", { callID: "c1" }), PARENT);
    observer(idleEvent(), PARENT);
    observer(toolEvent(PARENT, "running", { callID: "c1" }), PARENT);
    await drain();

    const types = emitted().map((e) => e.event.type);
    expect(types).toEqual(["tool", "done", "tool"]);
  });

  it("does not report a false error when activity recovers before idle", async () => {
    setupThread();

    observer(errorEvent(), PARENT);
    observer(toolEvent(PARENT, "running", { callID: "c9" }), PARENT); // recovery activity
    observer(idleEvent(), PARENT);
    await drain();

    const done = emitted().find((e) => e.event.type === "done");
    expect((done?.event as { status: string }).status).toBe("completed");
    expect((done?.event as { error?: string }).error).toBeUndefined();
  });

  it("keeps the failure visible when session.error is followed only by idle", async () => {
    setupThread();

    observer(errorEvent(), PARENT);
    observer(idleEvent(), PARENT);
    await drain();

    // Inline error activity is rendered immediately on session.error.
    expect(emitted()).toContainEqual({
      key: THREAD_KEY,
      event: { type: "tool", tool: "error", status: "error" },
    });

    const done = emitted().find((e) => e.event.type === "done");
    expect((done?.event as { status: string }).status).toBe("error");
    expect((done?.event as { error?: string }).error).toBe("boom");
  });
});
