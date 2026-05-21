import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { isSlackEventChannelPrivate } from "./slack-channel-allowlist.js";

function depsWithInfo(info = vi.fn()) {
  return {
    client: { conversations: { info } } as unknown as WebClient,
    info,
  };
}

describe("Slack private-channel detection", () => {
  it("uses channel_type direct signals when available", async () => {
    const deps = depsWithInfo();

    await expect(
      isSlackEventChannelPrivate({ channel: "G123", channel_type: "group" }, deps),
    ).resolves.toBe(true);
    await expect(
      isSlackEventChannelPrivate({ channel: "C123", channel_type: "channel" }, deps),
    ).resolves.toBe(false);
    await expect(
      isSlackEventChannelPrivate({ channel: "D123", channel_type: "im" }, deps),
    ).resolves.toBe(false);
    await expect(
      isSlackEventChannelPrivate({ channel: "GMPIM", channel_type: "mpim" }, deps),
    ).resolves.toBe(false);
    expect(deps.info).not.toHaveBeenCalled();
  });

  it("falls back to conversations.info for missing channel_type", async () => {
    const privateDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_private: true } }));
    await expect(isSlackEventChannelPrivate({ channel: "G123" }, privateDeps)).resolves.toBe(true);
    expect(privateDeps.info).toHaveBeenCalledWith({ channel: "G123" });

    const publicDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_private: false } }));
    await expect(isSlackEventChannelPrivate({ channel: "C123" }, publicDeps)).resolves.toBe(false);
  });

  it("treats lookup failures as private", async () => {
    const deps = depsWithInfo(vi.fn().mockRejectedValue(new Error("unavailable")));

    await expect(isSlackEventChannelPrivate({ channel: "G123" }, deps)).resolves.toBe(true);
  });

  it("treats incomplete lookup responses as private", async () => {
    const missingChannelDeps = depsWithInfo(vi.fn().mockResolvedValue({ ok: true }));
    await expect(isSlackEventChannelPrivate({ channel: "G123" }, missingChannelDeps)).resolves.toBe(
      true,
    );

    const missingPrivacyDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: {} }));
    await expect(isSlackEventChannelPrivate({ channel: "G123" }, missingPrivacyDeps)).resolves.toBe(
      true,
    );
  });
});
