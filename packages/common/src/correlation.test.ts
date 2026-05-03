import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { appendAlias } from "./event-log.js";
import {
  appendCorrelationAlias,
  computeGitCorrelationKey,
  computeSlackCorrelationKey,
  hasSessionForCorrelationKey,
  resolveCorrelationKeys,
  resolveSessionForCorrelationKey,
} from "./correlation.js";

const worklogRoot = "/tmp/thor-common-correlation-test/worklog";

describe("correlation key resolution", () => {
  beforeEach(() => {
    vi.stubEnv("WORKLOG_DIR", worklogRoot);
    rmSync("/tmp/thor-common-correlation-test", { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync("/tmp/thor-common-correlation-test", { recursive: true, force: true });
  });

  it("keeps correlation keys separate from resolved session ids", () => {
    expect(
      appendAlias({
        aliasType: "slack.thread_id",
        aliasValue: "1710000000.001",
        sessionId: "session-1",
      }),
    ).toEqual({ ok: true });

    const rawKey = "slack:thread:1710000000.001";

    expect(resolveCorrelationKeys([rawKey])).toBe(rawKey);
    expect(hasSessionForCorrelationKey(rawKey)).toBe(true);
    expect(resolveSessionForCorrelationKey(rawKey)).toBe("session-1");
  });

  it("normalizes git branch correlation keys to git alias values", () => {
    const rawKey = "git:branch:thor:feature/refactor";

    expect(appendCorrelationAlias("session-git", rawKey)).toEqual({ ok: true });
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

  it("registers correlation aliases through the alias log", () => {
    expect(appendCorrelationAlias("session-2", "slack:thread:1710000000.004")).toEqual({
      ok: true,
    });
    expect(resolveSessionForCorrelationKey("slack:thread:1710000000.004")).toBe("session-2");
  });

  it("does not treat untyped keys as alias values", () => {
    expect(
      appendAlias({ aliasType: "slack.thread_id", aliasValue: "same-key", sessionId: "session-1" }),
    ).toEqual({ ok: true });

    expect(resolveCorrelationKeys(["same-key"])).toBe("same-key");
    expect(hasSessionForCorrelationKey("same-key")).toBe(false);
    expect(resolveSessionForCorrelationKey("same-key")).toBeUndefined();
  });
});
