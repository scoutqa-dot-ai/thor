import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSlackChannelGateCacheForTests,
  getCachedSlackChannelGate,
  isSlackEventGated,
} from "./slack-api.js";

function depsWithInfo(info = vi.fn()) {
  return {
    client: { conversations: { info } } as unknown as WebClient,
    info,
  };
}

describe("Slack channel gating", () => {
  beforeEach(() => {
    __resetSlackChannelGateCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gates every other known surface (group, im, mpim) without a lookup", async () => {
    const deps = depsWithInfo();
    await expect(isSlackEventGated({ channel: "G123", channel_type: "group" }, deps)).resolves.toBe(
      true,
    );
    await expect(isSlackEventGated({ channel: "D123", channel_type: "im" }, deps)).resolves.toBe(
      true,
    );
    await expect(isSlackEventGated({ channel: "GMPIM", channel_type: "mpim" }, deps)).resolves.toBe(
      true,
    );
    expect(deps.info).not.toHaveBeenCalled();
  });

  it("gates unknown channel_type values (e.g. future Slack surfaces) without a lookup", async () => {
    const deps = depsWithInfo();
    await expect(
      isSlackEventGated({ channel: "CSHARED", channel_type: "shared_channel" }, deps),
    ).resolves.toBe(true);
    expect(deps.info).not.toHaveBeenCalled();
  });

  it("refreshes successful lookups after the 60 minute TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00Z"));
    const info = vi
      .fn()
      .mockResolvedValueOnce({ channel: { is_private: false } })
      .mockResolvedValueOnce({ channel: { is_private: true } });
    const deps = depsWithInfo(info);

    await expect(isSlackEventGated({ channel: "C_ttl" }, deps)).resolves.toBe(false);
    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(getCachedSlackChannelGate("C_ttl")).toBe(false);
    await expect(isSlackEventGated({ channel: "C_ttl" }, deps)).resolves.toBe(false);
    vi.advanceTimersByTime(1);
    expect(getCachedSlackChannelGate("C_ttl")).toBeUndefined();
    await expect(isSlackEventGated({ channel: "C_ttl" }, deps)).resolves.toBe(true);

    expect(info).toHaveBeenCalledTimes(2);
  });

  it("does not cache lookup failures so transient outages can recover", async () => {
    const info = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ channel: { is_private: false } });
    const deps = depsWithInfo(info);
    await expect(isSlackEventGated({ channel: "C_recover" }, deps)).resolves.toBe(true);
    await expect(isSlackEventGated({ channel: "C_recover" }, deps)).resolves.toBe(false);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("fails closed on incomplete lookup responses", async () => {
    const missingChannelDeps = depsWithInfo(vi.fn().mockResolvedValue({ ok: true }));
    await expect(isSlackEventGated({ channel: "G123" }, missingChannelDeps)).resolves.toBe(true);

    const missingPrivacyDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: {} }));
    await expect(isSlackEventGated({ channel: "G123" }, missingPrivacyDeps)).resolves.toBe(true);
  });
});
