import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { appendAlias } from "./event-log.js";
import {
  appendCorrelationAlias,
  appendCorrelationAliasForAnchor,
  computeGitCorrelationKey,
  computeSlackCorrelationKey,
  ensureAnchorForCorrelationKey,
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

function readAliases(): Array<{ aliasType: string; aliasValue: string; anchorId: string }> {
  try {
    return readFileSync(`${worklogRoot}/aliases.jsonl`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
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

  it("normalizes github issue correlation keys to github issue alias values", () => {
    bindSession("session-issue", anchor2);
    const rawKey = "github:issue:thor:acme/thor#42";

    expect(appendCorrelationAlias("session-issue", rawKey)).toEqual({ ok: true });
    expect(resolveAnchorForCorrelationKey(rawKey)).toBe(anchor2);
    expect(resolveSessionForCorrelationKey(rawKey)).toBe("session-issue");
    expect(readAliases()).toContainEqual({
      ts: expect.any(String),
      aliasType: "github.issue",
      aliasValue: Buffer.from(rawKey).toString("base64url"),
      anchorId: anchor2,
    });
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

  it("appendCorrelationAlias resolves child sessions via opencode.subsession to the parent's anchor", () => {
    bindSession("parent-session", anchor1);
    expect(
      appendAlias({
        aliasType: "opencode.subsession",
        aliasValue: "child-session",
        anchorId: anchor1,
      }),
    ).toEqual({ ok: true });

    // Delegated subagent's git push: x-thor-session-id is the child's id.
    expect(appendCorrelationAlias("child-session", "git:branch:thor:feat-x")).toEqual({ ok: true });

    // Future GitHub events for the branch route to the parent's anchor.
    expect(resolveAnchorForCorrelationKey("git:branch:thor:feat-x")).toBe(anchor1);
    expect(resolveSessionForCorrelationKey("git:branch:thor:feat-x")).toBe("parent-session");
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

  it("ensures one anchor for concurrent slack correlation key callers", async () => {
    const key = "slack:thread:1710000000.030";

    const results = await Promise.all([
      ensureAnchorForCorrelationKey(key),
      ensureAnchorForCorrelationKey(key),
    ]);

    expect(results[0].anchorId).toBeDefined();
    expect(results[1].anchorId).toBe(results[0].anchorId);
    expect(results.map((result) => result.minted).sort()).toEqual([false, true]);
    expect(resolveAnchorForCorrelationKey(key)).toBe(results[0].anchorId);

    const slackAliases = readAliases().filter(
      (alias) => alias.aliasType === "slack.thread_id" && alias.aliasValue === "1710000000.030",
    );
    expect(slackAliases).toHaveLength(1);
    expect(slackAliases[0].anchorId).toBe(results[0].anchorId);
  });

  it("ensures one anchor for concurrent git branch correlation key callers", async () => {
    const key = "git:branch:thor:feature/ensure-anchor";

    const results = await Promise.all([
      ensureAnchorForCorrelationKey(key),
      ensureAnchorForCorrelationKey(key),
    ]);

    expect(results[0].anchorId).toBeDefined();
    expect(results[1].anchorId).toBe(results[0].anchorId);
    expect(results.map((result) => result.minted).sort()).toEqual([false, true]);
    expect(resolveAnchorForCorrelationKey(key)).toBe(results[0].anchorId);

    const gitAliases = readAliases().filter((alias) => alias.aliasType === "git.branch");
    expect(gitAliases).toHaveLength(1);
    expect(gitAliases[0].anchorId).toBe(results[0].anchorId);
  });

  it("ensures one anchor for concurrent github issue correlation key callers", async () => {
    const key = "github:issue:thor:acme/thor#42";

    const results = await Promise.all([
      ensureAnchorForCorrelationKey(key),
      ensureAnchorForCorrelationKey(key),
    ]);

    expect(results[0].anchorId).toBeDefined();
    expect(results[1].anchorId).toBe(results[0].anchorId);
    expect(results.map((result) => result.minted).sort()).toEqual([false, true]);
    expect(resolveAnchorForCorrelationKey(key)).toBe(results[0].anchorId);

    const issueAliases = readAliases().filter((alias) => alias.aliasType === "github.issue");
    expect(issueAliases).toHaveLength(1);
    expect(issueAliases[0].aliasValue).toBe(Buffer.from(key).toString("base64url"));
    expect(issueAliases[0].anchorId).toBe(results[0].anchorId);
  });

  it("does not mint anchors for unsupported correlation key prefixes", async () => {
    const result = await ensureAnchorForCorrelationKey("cron:daily:123");

    expect(result).toEqual({
      anchorId: undefined,
      minted: false,
      reason: "unsupported_prefix",
    });
    expect(readAliases()).toEqual([]);
  });

  it("returns an existing correlation anchor without minting", async () => {
    const key = "slack:thread:1710000000.040";
    expect(appendCorrelationAliasForAnchor(anchor2, key)).toEqual({ ok: true });

    const result = await ensureAnchorForCorrelationKey(key);

    expect(result).toEqual({ anchorId: anchor2, minted: false });
    expect(readAliases()).toHaveLength(1);
  });
});
