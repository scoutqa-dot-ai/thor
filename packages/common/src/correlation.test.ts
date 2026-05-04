import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { appendAlias } from "./event-log.js";
import {
  appendCorrelationAlias,
  appendCorrelationAliasForAnchor,
  computeGitCorrelationKey,
  computeSlackCorrelationKey,
  hasSessionForCorrelationKey,
  resolveAnchorForCorrelationKey,
  resolveCorrelationLockKey,
  resolveCorrelationKeys,
  resolveSessionForCorrelationKey,
} from "./correlation.js";

const worklogRoot = "/tmp/thor-common-correlation-test/worklog";
const anchor1 = "00000000-0000-7000-8000-000000000c01";
const anchor2 = "00000000-0000-7000-8000-000000000c02";
const anchor3 = "00000000-0000-7000-8000-000000000c03";

function bindSession(sessionId: string, anchorId: string): void {
  const result = appendAlias({
    aliasType: "opencode.session",
    aliasValue: sessionId,
    anchorId,
  });
  if (!result.ok) throw result.error;
}

describe("correlation key resolution", () => {
  beforeEach(() => {
    vi.stubEnv("WORKLOG_DIR", worklogRoot);
    rmSync("/tmp/thor-common-correlation-test", { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync("/tmp/thor-common-correlation-test", { recursive: true, force: true });
  });

  it("resolves correlation keys to anchors and routes lock keys at the anchor level", () => {
    bindSession("session-1", anchor1);
    expect(
      appendAlias({
        aliasType: "slack.thread_id",
        aliasValue: "1710000000.001",
        anchorId: anchor1,
      }),
    ).toEqual({ ok: true });

    const rawKey = "slack:thread:1710000000.001";

    expect(resolveCorrelationKeys([rawKey])).toBe(rawKey);
    expect(hasSessionForCorrelationKey(rawKey)).toBe(true);
    expect(resolveAnchorForCorrelationKey(rawKey)).toBe(anchor1);
    expect(resolveSessionForCorrelationKey(rawKey)).toBe("session-1");
    expect(resolveCorrelationLockKey(rawKey)).toBe(`anchor:${anchor1}`);
  });

  it("normalizes git branch correlation keys to git alias values", () => {
    bindSession("session-git", anchor2);
    const rawKey = "git:branch:thor:feature/refactor";

    expect(appendCorrelationAlias("session-git", rawKey)).toEqual({ ok: true });
    expect(resolveAnchorForCorrelationKey(rawKey)).toBe(anchor2);
    expect(resolveSessionForCorrelationKey(rawKey)).toBe("session-git");
  });

  it("computes correlation keys without embedding tool output metadata", () => {
    expect(
      computeGitCorrelationKey(["push", "origin", "feature/refactor"], "/workspace/repos/thor"),
    ).toBe("git:branch:thor:feature/refactor");
    expect(
      computeSlackCorrelationKey({ channel: "C123" }, JSON.stringify({ ts: "1710000000.002" })),
    ).toBe("slack:thread:1710000000.002");
    expect(computeSlackCorrelationKey({ thread_ts: "1710000000.003" }, "{}")).toBe(
      "slack:thread:1710000000.003",
    );
  });

  it("registers correlation aliases against the executing session's anchor", () => {
    bindSession("session-2", anchor2);
    expect(appendCorrelationAlias("session-2", "slack:thread:1710000000.004")).toEqual({
      ok: true,
    });
    expect(resolveAnchorForCorrelationKey("slack:thread:1710000000.004")).toBe(anchor2);
    expect(resolveSessionForCorrelationKey("slack:thread:1710000000.004")).toBe("session-2");
  });

  it("appendCorrelationAlias fails closed when the session has no anchor binding yet", () => {
    const result = appendCorrelationAlias("session-no-anchor", "slack:thread:1710000000.020");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no anchor binding yet");
    }
  });

  it("does not treat untyped keys as alias values", () => {
    bindSession("session-1", anchor1);

    expect(resolveCorrelationKeys(["same-key"])).toBe("same-key");
    expect(hasSessionForCorrelationKey("same-key")).toBe(false);
    expect(resolveSessionForCorrelationKey("same-key")).toBeUndefined();
    expect(resolveCorrelationLockKey("same-key")).toBe("same-key");
  });

  it("resolves different correlation keys on the same anchor to a single anchor lock", () => {
    bindSession("session-3", anchor3);
    expect(appendCorrelationAliasForAnchor(anchor3, "slack:thread:1710000000.005")).toEqual({
      ok: true,
    });
    expect(appendCorrelationAliasForAnchor(anchor3, "git:branch:thor:feature/shared")).toEqual({
      ok: true,
    });

    expect(resolveCorrelationLockKey("slack:thread:1710000000.005")).toBe(`anchor:${anchor3}`);
    expect(resolveCorrelationLockKey("git:branch:thor:feature/shared")).toBe(`anchor:${anchor3}`);
    expect(resolveSessionForCorrelationKey("slack:thread:1710000000.005")).toBe("session-3");
    expect(resolveSessionForCorrelationKey("git:branch:thor:feature/shared")).toBe("session-3");
  });
});
