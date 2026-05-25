import type { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSlackChannelGateCacheForTests, isSlackEventGated } from "./slack-api.js";

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

  it("admits regular public channels without an allowlist check", async () => {
    const deps = depsWithInfo();
    await expect(
      isSlackEventGated({ channel: "C123", channel_type: "channel" }, deps),
    ).resolves.toBe(false);
    expect(deps.info).not.toHaveBeenCalled();
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

  it("falls back to conversations.info when channel_type is missing", async () => {
    const privateDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_private: true } }));
    await expect(isSlackEventGated({ channel: "G123" }, privateDeps)).resolves.toBe(true);
    expect(privateDeps.info).toHaveBeenCalledWith({ channel: "G123" });

    const imDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_im: true } }));
    await expect(isSlackEventGated({ channel: "D123" }, imDeps)).resolves.toBe(true);

    const mpimDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_mpim: true } }));
    await expect(isSlackEventGated({ channel: "GMPIM" }, mpimDeps)).resolves.toBe(true);

    const publicDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_private: false } }));
    await expect(isSlackEventGated({ channel: "C123" }, publicDeps)).resolves.toBe(false);
  });

  it("gates unknown channel_type values (e.g. future Slack surfaces) without a lookup", async () => {
    const deps = depsWithInfo();
    await expect(
      isSlackEventGated({ channel: "CSHARED", channel_type: "shared_channel" }, deps),
    ).resolves.toBe(true);
    expect(deps.info).not.toHaveBeenCalled();
  });

  it("fails closed on lookup errors", async () => {
    const deps = depsWithInfo(vi.fn().mockRejectedValue(new Error("unavailable")));
    await expect(isSlackEventGated({ channel: "G_fail_only" }, deps)).resolves.toBe(true);
  });

  it("caches successful lookups and skips Slack on repeat hits for the same channel", async () => {
    const info = vi.fn().mockResolvedValue({ channel: { is_private: false } });
    const deps = depsWithInfo(info);
    await expect(isSlackEventGated({ channel: "C_cached_public" }, deps)).resolves.toBe(false);
    await expect(isSlackEventGated({ channel: "C_cached_public" }, deps)).resolves.toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
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
